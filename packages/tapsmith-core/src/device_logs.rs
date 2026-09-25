use std::io::BufRead;
use std::time::Duration;

use anyhow::Result;
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

use crate::platform::Platform;

pub struct ParsedLogEntry {
    pub level: &'static str,
    pub message: String,
    pub tag: String,
    pub timestamp_ms: u64,
    pub pid: i32,
}

pub struct LogStreamHandle {
    pub rx: mpsc::Receiver<ParsedLogEntry>,
    /// Dropping the sender cancels the log stream subprocess.
    _cancel_tx: oneshot::Sender<()>,
}

/// Owns a log subprocess and kills it when the streaming task ends *or* is
/// dropped.
///
/// These children are `std::process::Child`, which has no kill-on-drop, so
/// every exit path had to remember to kill them by hand — and one path never
/// ran at all. On daemon shutdown the tokio runtime drops these detached tasks
/// instead of polling them to completion, so the trailing kill was skipped and
/// the `adb logcat` / `log stream` child was reparented to PID 1 and left
/// running forever. They accumulated at roughly one per run, indefinitely.
///
/// A `Drop` impl covers both paths, including runtime teardown, and means new
/// exit paths cannot reintroduce the leak by forgetting to clean up.
struct ChildGuard(Option<std::process::Child>);

impl ChildGuard {
    fn take_stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.0.as_mut().and_then(|child| child.stdout.take())
    }

    /// Kill and reap now, for the paths that must have the child gone before
    /// they continue. Idempotent, so the `Drop` that follows is a no-op.
    fn kill_now(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.kill_now();
    }
}

pub async fn start(
    serial: String,
    platform: Platform,
    package_name: String,
) -> Result<LogStreamHandle> {
    let (tx, rx) = mpsc::channel::<ParsedLogEntry>(512);
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

    match platform {
        Platform::Android => {
            tokio::spawn(stream_android(serial, package_name, tx, cancel_rx));
        }
        Platform::Ios => {
            tokio::spawn(stream_ios(serial, package_name, tx, cancel_rx));
        }
    }

    Ok(LogStreamHandle {
        rx,
        _cancel_tx: cancel_tx,
    })
}

// ─── Android ───

async fn stream_android(
    serial: String,
    package_name: String,
    tx: mpsc::Sender<ParsedLogEntry>,
    cancel_rx: oneshot::Receiver<()>,
) {
    let pids = resolve_all_pids(&serial, &package_name).await;
    info!(serial = %serial, package = %package_name, ?pids, "Starting logcat stream");

    // Use std::process (blocking) + a dedicated thread for reading stdout.
    // Tokio's async process I/O on macOS doesn't reliably poll adb's pipe.
    // Wrap the blocking spawn() call in spawn_blocking to avoid blocking
    // the tokio worker thread.
    let serial_for_spawn = serial.clone();
    let mut child = match tokio::task::spawn_blocking(move || {
        std::process::Command::new("adb")
            .arg("-s")
            .arg(&serial_for_spawn)
            .args(["logcat", "-v", "epoch"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
    })
    .await
    {
        Ok(Ok(child)) => ChildGuard(Some(child)),
        Ok(Err(e)) => {
            warn!("Failed to spawn logcat: {e}");
            return;
        }
        Err(e) => {
            warn!("Failed to spawn logcat (join error): {e}");
            return;
        }
    };

    let stdout = child.take_stdout().expect("log subprocess stdout is piped");
    let pids = std::sync::Arc::new(std::sync::RwLock::new(pids));
    let pids_reader = pids.clone();

    let (line_tx, mut line_rx) = mpsc::channel::<ParsedLogEntry>(512);
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if let Some(entry) = parse_logcat_line(&line) {
                let Ok(pids_guard) = pids_reader.read() else {
                    break;
                };
                if pids_guard.contains(&entry.pid) {
                    drop(pids_guard);
                    if line_tx.blocking_send(entry).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Periodically re-resolve PIDs in a separate task to handle app restarts.
    let pids_for_refresh = pids.clone();
    let serial_for_refresh = serial.clone();
    let package_for_refresh = package_name.clone();
    let refresh_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        interval.tick().await; // consume immediate tick
        loop {
            interval.tick().await;
            let new_pids = resolve_all_pids(&serial_for_refresh, &package_for_refresh).await;
            let Ok(mut guard) = pids_for_refresh.write() else {
                break;
            };
            *guard = new_pids;
        }
    });

    let mut cancel_rx = cancel_rx;

    loop {
        tokio::select! {
            entry = line_rx.recv() => {
                match entry {
                    Some(entry) => {
                        if tx.send(entry).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            _ = &mut cancel_rx => break,
        }
    }

    refresh_handle.abort();

    // `child` is dropped here, which kills and reaps the subprocess.
}

async fn resolve_all_pids(serial: &str, package_name: &str) -> Vec<i32> {
    let output = match Command::new("adb")
        .arg("-s")
        .arg(serial)
        .args(["shell", "pidof", package_name])
        .output()
        .await
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };

    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect()
}

fn parse_logcat_line(line: &str) -> Option<ParsedLogEntry> {
    // Epoch format: "         1234567890.123  <pid>  <tid> <level> <tag>  : <message>"
    // Leading whitespace pads the timestamp field.
    let line = line.trim_start();
    let mut parts = line.splitn(2, |c: char| c.is_whitespace());
    let ts_str = parts.next()?;
    let rest = parts.next()?.trim_start();

    let timestamp_ms = ts_str.parse::<f64>().ok().map(|t| (t * 1000.0) as u64)?;

    // Rest: "<pid>  <tid> <level> <tag>  : <message>"
    let mut fields = rest.split_whitespace();
    let pid: i32 = fields.next()?.parse().ok()?;
    let _tid = fields.next()?; // skip thread ID
    let level_char = fields.next()?;
    // Tag may contain the colon, or colon may be a separate field
    let tag_and_rest: &str = &rest[rest.find(level_char)? + level_char.len()..];
    let tag_and_rest = tag_and_rest.trim_start();

    let (tag, message) = if let Some(colon_pos) = tag_and_rest.find(':') {
        let tag = tag_and_rest[..colon_pos].trim();
        let message = tag_and_rest[colon_pos + 1..].trim_start();
        (tag, message)
    } else {
        ("", tag_and_rest)
    };

    let level = match level_char.chars().next()? {
        'V' | 'D' => "debug",
        'I' => "info",
        'W' => "warn",
        'E' | 'F' => "error",
        _ => "log",
    };

    Some(ParsedLogEntry {
        level,
        message: message.to_string(),
        tag: tag.to_string(),
        timestamp_ms,
        pid,
    })
}

// ─── iOS Simulator ───

async fn resolve_ios_process_name(udid: &str, bundle_id: &str) -> Option<String> {
    let output = Command::new("xcrun")
        .args(["simctl", "get_app_container", udid, bundle_id])
        .output()
        .await
        .ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let app_name = std::path::Path::new(&path)
        .file_stem()?
        .to_str()?
        .to_string();
    Some(app_name)
}

fn ios_predicate(process_name: &str, bundle_id: &str) -> String {
    format!(
        "process == \"{}\" OR subsystem BEGINSWITH \"{}\"",
        process_name, bundle_id,
    )
}

async fn stream_ios(
    udid: String,
    bundle_id: String,
    tx: mpsc::Sender<ParsedLogEntry>,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    let process_name = resolve_ios_process_name(&udid, &bundle_id).await;
    let predicate = match &process_name {
        Some(name) => ios_predicate(name, &bundle_id),
        None => {
            warn!(bundle_id = %bundle_id, "Could not resolve iOS app binary name, using bundle ID as fallback");
            format!(
                "processImagePath CONTAINS \"{}\" OR subsystem BEGINSWITH \"{}\"",
                bundle_id, bundle_id
            )
        }
    };
    info!(udid = %udid, bundle_id = %bundle_id, ?process_name, "Starting iOS log stream");

    let udid_for_spawn = udid.clone();
    let predicate_for_spawn = predicate.clone();
    let mut child = match tokio::task::spawn_blocking(move || {
        std::process::Command::new("xcrun")
            .args([
                "simctl",
                "spawn",
                &udid_for_spawn,
                "log",
                "stream",
                "--style",
                "ndjson",
                "--predicate",
                &predicate_for_spawn,
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
    })
    .await
    {
        Ok(Ok(child)) => ChildGuard(Some(child)),
        Ok(Err(e)) => {
            warn!("Failed to spawn iOS log stream: {e}");
            stream_ios_compact(udid, predicate, tx, cancel_rx).await;
            return;
        }
        Err(e) => {
            warn!("Failed to spawn iOS log stream (join error): {e}");
            stream_ios_compact(udid, predicate, tx, cancel_rx).await;
            return;
        }
    };

    let stdout = child.take_stdout().expect("log subprocess stdout is piped");
    let (line_tx, mut line_rx) = mpsc::channel::<ParsedLogEntry>(512);

    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if !line.starts_with('{') {
                continue;
            }
            if let Some(entry) = parse_ios_ndjson_line(&line) {
                if line_tx.blocking_send(entry).is_err() {
                    break;
                }
            }
        }
    });

    loop {
        tokio::select! {
            entry = line_rx.recv() => {
                match entry {
                    Some(entry) => {
                        if tx.send(entry).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        // Reader thread exited — might be ndjson unsupported.
                        // Retire this child before the retry spawns its own.
                        child.kill_now();
                        stream_ios_compact(udid, predicate, tx, cancel_rx).await;
                        return;
                    }
                }
            }
            _ = &mut cancel_rx => break,
        }
    }

    // `child` is dropped here, which kills and reaps the subprocess.
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn parse_ios_ndjson_line(line: &str) -> Option<ParsedLogEntry> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;

    let message_type = v.get("messageType")?.as_str()?;
    let message = v.get("eventMessage")?.as_str().unwrap_or_default();
    let pid = v.get("processID").and_then(|p| p.as_i64()).unwrap_or(0) as i32;
    let subsystem = v
        .get("subsystem")
        .and_then(|s| s.as_str())
        .unwrap_or_default();
    let timestamp_ms = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(parse_ios_timestamp)
        .unwrap_or_else(now_epoch_ms);

    let level = match message_type {
        "Default" => "log",
        "Info" => "info",
        "Debug" => "debug",
        "Error" | "Fault" => "error",
        _ => "log",
    };

    Some(ParsedLogEntry {
        level,
        message: message.to_string(),
        tag: subsystem.to_string(),
        timestamp_ms,
        pid,
    })
}

async fn stream_ios_compact(
    udid: String,
    predicate: String,
    tx: mpsc::Sender<ParsedLogEntry>,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    let mut child = match tokio::task::spawn_blocking(move || {
        std::process::Command::new("xcrun")
            .args([
                "simctl",
                "spawn",
                &udid,
                "log",
                "stream",
                "--style",
                "compact",
                "--predicate",
                &predicate,
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
    })
    .await
    {
        Ok(Ok(child)) => ChildGuard(Some(child)),
        Ok(Err(e)) => {
            warn!("Failed to spawn iOS log stream (compact fallback): {e}");
            return;
        }
        Err(e) => {
            warn!("Failed to spawn iOS log stream (compact fallback, join error): {e}");
            return;
        }
    };

    let stdout = child.take_stdout().expect("log subprocess stdout is piped");
    let (line_tx, mut line_rx) = mpsc::channel::<ParsedLogEntry>(512);

    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if let Some(entry) = parse_ios_compact_line(&line) {
                if line_tx.blocking_send(entry).is_err() {
                    break;
                }
            }
        }
    });

    loop {
        tokio::select! {
            entry = line_rx.recv() => {
                match entry {
                    Some(entry) => {
                        if tx.send(entry).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            _ = &mut cancel_rx => break,
        }
    }

    // `child` is dropped here, which kills and reaps the subprocess.
}

/// Parse the ISO 8601 timestamp from ndjson log entries (includes timezone offset).
/// Example: "2026-04-30 13:34:27.289636+0100"
fn parse_ios_timestamp(s: &str) -> Option<u64> {
    use time::macros::format_description;
    use time::OffsetDateTime;
    const FMT: &[time::format_description::BorrowedFormatItem<'_>] = format_description!(
        "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond][offset_hour sign:mandatory][offset_minute]"
    );
    OffsetDateTime::parse(s, FMT)
        .ok()
        .map(|dt| (dt.unix_timestamp_nanos() / 1_000_000) as u64)
}

fn parse_ios_compact_line(line: &str) -> Option<ParsedLogEntry> {
    // Compact format: "2026-04-29 12:00:00.000 Df AppName[pid:tid] subsystem: message"
    // The level is a two-char code: Df=Default, If=Info, Db=Debug, Ef=Error, Ft=Fault
    if line.len() < 26 {
        return None;
    }

    // Skip header lines
    if line.starts_with("Filtering") || line.starts_with("Timestamp") {
        return None;
    }

    // Compact timestamps are local time with no timezone offset, so we
    // can't reliably convert to epoch. Use current wall-clock time instead
    // — this is a fallback format and log lines arrive in real-time.
    let timestamp_ms = now_epoch_ms();

    // Find the level code after the timestamp (position ~24)
    let after_ts = line.get(24..)?.trim_start();
    let level_code = after_ts.get(..2)?;

    let level = match level_code {
        "Df" => "log",
        "If" => "info",
        "Db" => "debug",
        "Ef" | "Ft" => "error",
        _ => "log",
    };

    // Extract process name and PID: "AppName[pid:tid]"
    let after_level = after_ts.get(2..)?.trim_start();
    let pid = after_level
        .find('[')
        .and_then(|start| {
            let rest = &after_level[start + 1..];
            rest.find(':')
                .and_then(|end| rest[..end].parse::<i32>().ok())
        })
        .unwrap_or(0);

    // Extract subsystem and message: everything after "] "
    let message = after_level
        .find(']')
        .map(|pos| after_level[pos + 1..].trim_start())
        .unwrap_or(after_level);

    let (tag, message) = if let Some(colon_pos) = message.find(':') {
        let tag = message[..colon_pos].trim();
        let msg = message[colon_pos + 1..].trim_start();
        (tag, msg)
    } else {
        ("", message)
    };

    Some(ParsedLogEntry {
        level,
        message: message.to_string(),
        tag: tag.to_string(),
        timestamp_ms,
        pid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ios_compact_line_default() {
        let line = "2026-04-30 12:00:00.000 Df TapsmithTestApp[67429:18dafbe] com.apple.UIKit: Background task created";
        let entry = parse_ios_compact_line(line).unwrap();
        assert_eq!(entry.level, "log");
        assert_eq!(entry.pid, 67429);
        assert_eq!(entry.tag, "com.apple.UIKit");
        assert_eq!(entry.message, "Background task created");
        assert!(entry.timestamp_ms > 1_700_000_000_000);
    }

    #[test]
    fn test_parse_ios_compact_line_error() {
        let line = "2026-04-30 12:00:01.500 Ef TapsmithTestApp[67429:18dafbf] CoreData: Failed to load model";
        let entry = parse_ios_compact_line(line).unwrap();
        assert_eq!(entry.level, "error");
        assert_eq!(entry.pid, 67429);
        assert_eq!(entry.tag, "CoreData");
        assert_eq!(entry.message, "Failed to load model");
    }

    #[test]
    fn test_parse_ios_compact_line_skips_header() {
        assert!(parse_ios_compact_line("Filtering the log data using ...").is_none());
        assert!(parse_ios_compact_line("Timestamp               Ty Process[PID:TID]").is_none());
    }

    #[test]
    fn test_parse_logcat_line() {
        let line = "         1714400000.123  1234  5678 I ReactNativeJS: App started";
        let entry = parse_logcat_line(line).unwrap();
        assert_eq!(entry.level, "info");
        assert_eq!(entry.pid, 1234);
        assert_eq!(entry.tag, "ReactNativeJS");
        assert_eq!(entry.message, "App started");
        assert_eq!(entry.timestamp_ms, 1714400000123);
    }

    #[test]
    fn test_parse_logcat_line_error() {
        let line = "1714400001.456  9999  1111 E AndroidRuntime: FATAL EXCEPTION: main";
        let entry = parse_logcat_line(line).unwrap();
        assert_eq!(entry.level, "error");
        assert_eq!(entry.pid, 9999);
        assert_eq!(entry.tag, "AndroidRuntime");
        assert_eq!(entry.message, "FATAL EXCEPTION: main");
    }

    #[test]
    fn test_parse_logcat_line_debug() {
        let line = "1714400002.789  4321  8765 D MyApp: Some debug message";
        let entry = parse_logcat_line(line).unwrap();
        assert_eq!(entry.level, "debug");
        assert_eq!(entry.tag, "MyApp");
        assert_eq!(entry.message, "Some debug message");
    }

    #[test]
    fn test_parse_ios_ndjson_line() {
        let line = r#"{"messageType":"Error","eventMessage":"Network request failed","processID":5555,"subsystem":"com.myapp.network","timestamp":"2026-04-30 12:00:00.000000+0000"}"#;
        let entry = parse_ios_ndjson_line(line).unwrap();
        assert_eq!(entry.level, "error");
        assert_eq!(entry.message, "Network request failed");
        assert_eq!(entry.pid, 5555);
        assert_eq!(entry.tag, "com.myapp.network");
        // 2026-04-30 12:00:00 UTC = 1777550400000 ms
        assert_eq!(entry.timestamp_ms, 1777550400000);
    }

    #[test]
    fn test_parse_ios_ndjson_line_with_timezone() {
        let line = r#"{"messageType":"Info","eventMessage":"Hello","processID":1,"subsystem":"","timestamp":"2026-04-30 13:00:00.000000+0100"}"#;
        let entry = parse_ios_ndjson_line(line).unwrap();
        // 13:00 +0100 = 12:00 UTC
        assert_eq!(entry.timestamp_ms, 1777550400000);
    }

    #[test]
    fn test_parse_ios_ndjson_line_default() {
        let line = r#"{"messageType":"Default","eventMessage":"Hello world","processID":1234,"subsystem":"","machTimestamp":0}"#;
        let entry = parse_ios_ndjson_line(line).unwrap();
        assert_eq!(entry.level, "log");
        assert_eq!(entry.message, "Hello world");
    }

    /// True while `pid` names a live *or* unreaped process.
    fn pid_is_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    /// Regression: log subprocesses were killed only on the streaming task's
    /// normal exit path. On daemon shutdown the runtime drops those tasks
    /// instead of polling them, so the kill never ran and the child was
    /// orphaned to PID 1 — one leaked `adb logcat` per live stream, every run.
    #[test]
    fn child_guard_kills_subprocess_on_drop() {
        let child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        let guard = ChildGuard(Some(child));

        assert!(pid_is_alive(pid), "subprocess should run before the drop");
        drop(guard);
        // Also covers reaping: a killed-but-unreaped child stays a zombie,
        // which `kill -0` still reports as alive.
        assert!(
            !pid_is_alive(pid),
            "ChildGuard::drop must kill and reap the subprocess"
        );
    }

    /// The iOS ndjson fallback kills explicitly before retrying in compact
    /// format, and the guard is dropped afterwards — the second cleanup must
    /// not wait on an already-reaped pid.
    #[test]
    fn child_guard_kill_now_is_idempotent() {
        let child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        let mut guard = ChildGuard(Some(child));

        guard.kill_now();
        assert!(!pid_is_alive(pid), "kill_now must kill and reap");
        guard.kill_now();
        drop(guard);
    }
}
