//! Android system animation scales for `reducedMotion: 'reduce'` (PILOT-971).
//!
//! With the option on, the daemon sets the three global animation scales
//! (window, transition, animator duration) to 0 when the SDK selects an
//! Android device, and puts the device's own values back when the session
//! ends: on daemon shutdown, when the daemon moves to another device, or when
//! a later SetDevice turns the option off.
//!
//! **Crash safety.** A daemon that is SIGKILLed runs no code, so before it
//! changes anything it writes an owner record,
//! `~/.tapsmith/android-animation-scales/<serial>@<avd>.json`, holding the
//! original values and the daemon's pid and start time. The next daemon that
//! selects that device finds the record, sees its owner is gone, and restores
//! the originals (or, with the option on itself, keeps them as the values to
//! restore later instead of reading back the zeros the dead daemon left).
//!
//! Records are keyed by serial *and* AVD name: an emulator's serial is its
//! console port, which a different AVD gets the next time, while two
//! `-read-only` instances of one AVD run side by side under different serials.
//!
//! **Only what is still ours is restored.** A scale that no longer reads 0
//! when the session ends was changed by someone else since (the user, a
//! wiped or read-only emulator that came back with its defaults), so it is
//! left alone.
//!
//! Every failure here is logged and otherwise ignored: faster animations are
//! a convenience, and must never fail a session.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

/// The global settings Android scales animations by, in a fixed order.
pub const SCALE_KEYS: [&str; 3] = [
    "window_animation_scale",
    "transition_animation_scale",
    "animator_duration_scale",
];

/// The value written while the option is on.
const OFF: &str = "0";

/// Bound for each adb call while a device is being selected: generous, like
/// the daemon's other setup `settings` calls, because a just-booted emulator
/// on a starved runner can take seconds per binder call, and a timeout there
/// silently leaves the session's animations on.
pub const SELECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Bound for each adb call of the restore at daemon shutdown (a read, then a
/// put), kept short because a caller may SIGKILL a daemon a few seconds after
/// SIGTERM. A restore cut short keeps its record, for the next session on the
/// device to finish.
pub const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

// ─── Reading the device ───

/// One read of the device: its AVD name (emulators only) and the three scales.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceReading {
    pub avd: Option<String>,
    /// Indexed like [`SCALE_KEYS`]; `None` when the setting is unset (`settings get` prints `null`).
    pub scales: [Option<String>; 3],
}

/// One shell command that prints, a line each: the AVD name as API 30+ and as
/// older images report it (empty on physical devices), then each scale.
pub fn read_command() -> String {
    let mut parts = vec![
        "getprop ro.boot.qemu.avd_name".to_string(),
        "getprop ro.kernel.qemu.avd_name".to_string(),
    ];
    parts.extend(
        SCALE_KEYS
            .iter()
            .map(|k| format!("settings get global {k}")),
    );
    parts.join("; ")
}

/// Parse [`read_command`]'s output. `None` when it does not have the five
/// lines the command prints.
pub fn parse_reading(stdout: &str) -> Option<DeviceReading> {
    let lines: Vec<&str> = stdout.lines().map(str::trim).collect();
    if lines.len() < 5 {
        return None;
    }
    let avd = [lines[0], lines[1]]
        .into_iter()
        .find(|s| !s.is_empty())
        .map(String::from);
    let scale = |s: &str| (!s.is_empty() && s != "null").then(|| s.to_string());
    Some(DeviceReading {
        avd,
        scales: [scale(lines[2]), scale(lines[3]), scale(lines[4])],
    })
}

/// Whether a scale reads as off — the value this module writes.
fn is_off(value: Option<&str>) -> bool {
    value
        .and_then(|v| v.parse::<f32>().ok())
        .is_some_and(|v| v == 0.0)
}

/// A value safe to write back with `settings put`: a plain number. Anything
/// else in a record (hand-edited, corrupt) is not put into a shell command.
fn is_plain_number(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'))
        && value.parse::<f32>().is_ok()
}

/// The shell command that turns every scale off.
pub fn apply_command() -> String {
    SCALE_KEYS
        .iter()
        .map(|k| format!("settings put global {k} {OFF}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// The shell command that puts `originals` back, for the scales that still
/// read as off in `current`. `None` when there is nothing to restore.
pub fn restore_command(
    current: &[Option<String>; 3],
    originals: &BTreeMap<String, Option<String>>,
) -> Option<String> {
    let mut parts = Vec::new();
    for (i, key) in SCALE_KEYS.iter().enumerate() {
        if !is_off(current[i].as_deref()) {
            // Changed since this session set it: not ours to undo.
            continue;
        }
        match originals.get(*key) {
            Some(Some(value)) if is_plain_number(value) => {
                parts.push(format!("settings put global {key} {value}"))
            }
            Some(Some(value)) => {
                warn!(
                    key,
                    value, "Not restoring an animation scale whose recorded value is not a number"
                );
            }
            Some(None) => parts.push(format!("settings delete global {key}")),
            // A record without this key: nothing known to restore.
            None => {}
        }
    }
    (!parts.is_empty()).then(|| parts.join("; "))
}

// ─── Owner records ───

/// Contents of an owner record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerRecord {
    pub serial: String,
    pub avd: Option<String>,
    /// The daemon that turned the scales off.
    pub pid: u32,
    /// That daemon's start time (`ps -o lstart=`), so a reused pid is not
    /// mistaken for it.
    pub started: Option<String>,
    /// Each scale's value before the first daemon turned it off; `None` = unset.
    pub originals: BTreeMap<String, Option<String>>,
}

/// File-name-safe form of a serial or AVD name (`192.168.1.5:5555` has a colon).
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn record_prefix(serial: &str) -> String {
    format!("{}@", sanitize(serial))
}

/// Where the record for `serial` running `avd` lives.
pub fn record_path(dir: &Path, serial: &str, avd: Option<&str>) -> PathBuf {
    dir.join(format!(
        "{}{}.json",
        record_prefix(serial),
        sanitize(avd.unwrap_or(""))
    ))
}

/// Whether any record exists for `serial`, whichever AVD it names. Lets a
/// session without the option skip reading the device at all.
fn has_records_for(dir: &Path, serial: &str) -> bool {
    let prefix = record_prefix(serial);
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.filter_map(Result::ok).any(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name.starts_with(&prefix) && name.ends_with(".json")
        })
    })
}

fn read_record(path: &Path) -> Option<OwnerRecord> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(r) => Some(r),
        Err(e) => {
            warn!(path = %path.display(), "Ignoring an unreadable animation-scale record: {e}");
            None
        }
    }
}

/// Written aside and renamed into place, so a daemon killed mid-write leaves
/// the previous record (or none), never a truncated one.
fn write_record(path: &Path, record: &OwnerRecord) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(record)?)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

fn remove_record(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            warn!(path = %path.display(), "Could not remove the animation-scale record: {e}");
        }
    }
}

/// `~/.tapsmith/android-animation-scales`.
pub fn records_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".tapsmith").join("android-animation-scales"))
}

// ─── Host ───

/// What the logic needs from the outside world, injectable for tests.
#[async_trait::async_trait]
pub trait Host: Send + Sync {
    async fn shell(&self, serial: &str, command: &str, timeout: Duration)
        -> anyhow::Result<String>;
    /// Whether the daemon that wrote `record` is still running.
    async fn owner_alive(&self, record: &OwnerRecord) -> bool;
    fn self_pid(&self) -> u32;
    async fn self_started(&self) -> Option<String>;
}

pub struct RealHost;

#[async_trait::async_trait]
impl Host for RealHost {
    async fn shell(
        &self,
        serial: &str,
        command: &str,
        timeout: Duration,
    ) -> anyhow::Result<String> {
        crate::adb::shell_with_timeout(serial, command, timeout).await
    }

    async fn owner_alive(&self, record: &OwnerRecord) -> bool {
        if !crate::process_identity::pid_exists(record.pid) {
            return false;
        }
        match (
            &record.started,
            crate::process_identity::process_started(record.pid).await,
        ) {
            (Some(recorded), Some(now)) => recorded == &now,
            // The process exists but its start time is unknown on one side:
            // assume it is the owner rather than undo a live session's setting.
            _ => true,
        }
    }

    fn self_pid(&self) -> u32 {
        std::process::id()
    }

    async fn self_started(&self) -> Option<String> {
        crate::process_identity::own_start_time().await
    }
}

// ─── Session logic ───

/// Scales this daemon has turned off, and the record that says how to undo it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub serial: String,
    pub record_path: PathBuf,
}

async fn is_ours(h: &dyn Host, record: &OwnerRecord) -> bool {
    record.pid == h.self_pid() && record.started == h.self_started().await
}

async fn read_device(h: &dyn Host, serial: &str, timeout: Duration) -> Option<DeviceReading> {
    match h.shell(serial, &read_command(), timeout).await {
        Ok(out) => {
            let reading = parse_reading(&out);
            if reading.is_none() {
                warn!(%serial, output = %out.trim(), "Unexpected output reading the animation scales");
            }
            reading
        }
        Err(e) => {
            warn!(%serial, "Could not read the animation scales: {e:#}");
            None
        }
    }
}

async fn turn_off(h: &dyn Host, serial: &str) -> bool {
    match h.shell(serial, &apply_command(), SELECT_TIMEOUT).await {
        Ok(_) => true,
        Err(e) => {
            warn!(%serial, "Could not turn the animation scales off: {e:#}");
            false
        }
    }
}

/// Put `originals` back on `serial` where the scales still read as off. True
/// when nothing is left to restore (so the record can go).
async fn put_back(
    h: &dyn Host,
    serial: &str,
    current: &[Option<String>; 3],
    originals: &BTreeMap<String, Option<String>>,
    timeout: Duration,
) -> bool {
    let Some(command) = restore_command(current, originals) else {
        return true;
    };
    match h.shell(serial, &command, timeout).await {
        Ok(_) => {
            info!(%serial, "Restored the device's animation scales");
            true
        }
        Err(e) => {
            warn!(%serial, "Could not restore the animation scales: {e:#}");
            false
        }
    }
}

/// Bring `serial` in line with what the session asked for, when the SDK
/// selects it. `want`: `Some(true)` turn the scales off, `Some(false)` undo
/// what this daemon did, `None` (an SDK that does not say) leave this daemon's
/// own setting as it is. Either way a record left by a daemon that died is
/// recovered. `current` is what this daemon has applied so far, if anything;
/// the result is what it has applied afterwards.
pub async fn on_select(
    h: &dyn Host,
    dir: &Path,
    serial: &str,
    want: Option<bool>,
    current: Option<&Applied>,
) -> Option<Applied> {
    let ours_here = current.filter(|a| a.serial == serial).cloned();
    if want != Some(true) && ours_here.is_none() && !has_records_for(dir, serial) {
        return None;
    }
    if want.is_none() && ours_here.is_some() {
        return ours_here;
    }

    let Some(reading) = read_device(h, serial, SELECT_TIMEOUT).await else {
        // Unknown, not "nothing applied": keep what this daemon already holds,
        // so a failed re-read never drops the restore owed at shutdown.
        return ours_here;
    };
    let path = record_path(dir, serial, reading.avd.as_deref());
    let existing = read_record(&path);

    let originals = match existing {
        Some(record) if is_ours(h, &record).await => {
            if want == Some(true) {
                // Already off; put it again in case someone turned one back on.
                turn_off(h, serial).await;
                return Some(Applied {
                    serial: serial.to_string(),
                    record_path: path,
                });
            }
            if put_back(
                h,
                serial,
                &reading.scales,
                &record.originals,
                SELECT_TIMEOUT,
            )
            .await
            {
                remove_record(&path);
            }
            return None;
        }
        Some(record) if h.owner_alive(&record).await => {
            warn!(
                %serial,
                owner = record.pid,
                "Another live Tapsmith daemon has this device's animation scales turned off; leaving them to it"
            );
            return None;
        }
        Some(record) => {
            info!(%serial, owner = record.pid, "Recovering animation scales left off by an exited daemon");
            if want != Some(true) {
                if put_back(
                    h,
                    serial,
                    &reading.scales,
                    &record.originals,
                    SELECT_TIMEOUT,
                )
                .await
                {
                    remove_record(&path);
                }
                return None;
            }
            // Taking it over: the dead daemon's originals are the device's
            // own values; what it reads now are the zeros it left.
            record.originals
        }
        None => {
            if want != Some(true) {
                return None;
            }
            SCALE_KEYS
                .iter()
                .zip(reading.scales.iter())
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect()
        }
    };

    // Recorded before anything changes, so a crash right after still leaves
    // the next daemon what it needs.
    let record = OwnerRecord {
        serial: serial.to_string(),
        avd: reading.avd.clone(),
        pid: h.self_pid(),
        started: h.self_started().await,
        originals,
    };
    if let Err(e) = write_record(&path, &record) {
        warn!(%serial, path = %path.display(), "Not turning animations off: could not record the device's own values ({e:#})");
        return None;
    }
    if turn_off(h, serial).await {
        info!(%serial, "Turned the device's animation scales off for this session");
    } else {
        // The outcome is unknown, not "nothing changed": a timed-out adb
        // call's command may already have reached the device. Keep the
        // record and treat the scales as applied; the restore puts back only
        // what reads 0, so a put that never landed is simply left alone.
        warn!(%serial, "Keeping the animation-scale record to restore at session end");
    }
    Some(Applied {
        serial: serial.to_string(),
        record_path: path,
    })
}

/// Undo `applied`: at daemon shutdown, or when the daemon moves to another
/// device. A device that cannot be read keeps its record, for the next
/// daemon that selects it.
pub async fn restore(h: &dyn Host, applied: &Applied, timeout: Duration) {
    let Some(record) = read_record(&applied.record_path) else {
        return;
    };
    if !is_ours(h, &record).await {
        return;
    }
    let Some(reading) = read_device(h, &applied.serial, timeout).await else {
        return;
    };
    if put_back(
        h,
        &applied.serial,
        &reading.scales,
        &record.originals,
        timeout,
    )
    .await
    {
        remove_record(&applied.record_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A device whose global settings live in a map, plus a fake process table.
    struct FakeHost {
        avd: Option<String>,
        settings: Mutex<BTreeMap<String, String>>,
        commands: Mutex<Vec<String>>,
        pid: u32,
        started: Option<String>,
        live_owner: bool,
        fail_writes: bool,
        /// How long each adb call takes on this device.
        per_call: Duration,
    }

    impl FakeHost {
        fn new(avd: Option<&str>, scales: [Option<&str>; 3]) -> Self {
            let mut settings = BTreeMap::new();
            for (k, v) in SCALE_KEYS.iter().zip(scales) {
                if let Some(v) = v {
                    settings.insert(k.to_string(), v.to_string());
                }
            }
            Self {
                avd: avd.map(String::from),
                settings: Mutex::new(settings),
                commands: Mutex::new(Vec::new()),
                pid: 100,
                started: Some("Mon Oct 27 10:00:00 2026".into()),
                live_owner: false,
                fail_writes: false,
                per_call: Duration::from_millis(300),
            }
        }

        fn scales(&self) -> [Option<String>; 3] {
            let s = self.settings.lock().unwrap();
            SCALE_KEYS.map(|k| s.get(k).cloned())
        }

        fn set(&self, key: &str, value: &str) {
            self.settings
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
        }

        fn command_count(&self) -> usize {
            self.commands.lock().unwrap().len()
        }
    }

    #[async_trait::async_trait]
    impl Host for FakeHost {
        async fn shell(
            &self,
            _serial: &str,
            command: &str,
            timeout: Duration,
        ) -> anyhow::Result<String> {
            self.commands.lock().unwrap().push(command.to_string());
            if self.per_call > timeout {
                anyhow::bail!("adb command timed out after {timeout:?}");
            }
            let mut out = String::new();
            let mut settings = self.settings.lock().unwrap();
            for part in command.split("; ") {
                let words: Vec<&str> = part.split_whitespace().collect();
                match words.as_slice() {
                    ["getprop", "ro.boot.qemu.avd_name"] => {
                        out.push_str(self.avd.as_deref().unwrap_or(""));
                        out.push('\n');
                    }
                    ["getprop", _] => out.push('\n'),
                    ["settings", "get", "global", k] => {
                        out.push_str(settings.get(*k).map(String::as_str).unwrap_or("null"));
                        out.push('\n');
                    }
                    ["settings", "put", "global", k, v] => {
                        settings.insert(k.to_string(), v.to_string());
                    }
                    ["settings", "delete", "global", k] => {
                        settings.remove(*k);
                    }
                    other => panic!("unexpected command {other:?}"),
                }
            }
            if self.fail_writes && command.contains("settings put") {
                anyhow::bail!("adb command timed out after 3s");
            }
            Ok(out)
        }

        async fn owner_alive(&self, _record: &OwnerRecord) -> bool {
            self.live_owner
        }

        fn self_pid(&self) -> u32 {
            self.pid
        }

        async fn self_started(&self) -> Option<String> {
            self.started.clone()
        }
    }

    fn some(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    #[test]
    fn parses_an_emulator_and_a_physical_device() {
        let r = parse_reading("Pixel_API_36\n\n1.0\nnull\n0.5\n").unwrap();
        assert_eq!(r.avd.as_deref(), Some("Pixel_API_36"));
        assert_eq!(r.scales, [some("1.0"), None, some("0.5")]);
        // Older images report the name under ro.kernel; adb may add \r.
        let r = parse_reading("\r\nOld_AVD\r\n1\r\n1\r\n1\r\n").unwrap();
        assert_eq!(r.avd.as_deref(), Some("Old_AVD"));
        let r = parse_reading("\n\n1\n1\n1\n").unwrap();
        assert_eq!(r.avd, None);
        assert_eq!(parse_reading("1\n1\n"), None);
    }

    #[test]
    fn restore_skips_scales_changed_since_and_deletes_unset_ones() {
        let originals: BTreeMap<_, _> = [
            ("window_animation_scale".to_string(), some("1.0")),
            ("transition_animation_scale".to_string(), None),
            ("animator_duration_scale".to_string(), some("0.5")),
        ]
        .into();
        // The animator scale was set to 2 by someone else mid-session.
        let cmd = restore_command(&[some("0"), some("0.0"), some("2")], &originals).unwrap();
        assert_eq!(
            cmd,
            "settings put global window_animation_scale 1.0; settings delete global transition_animation_scale"
        );
        assert_eq!(
            restore_command(&[some("1"), some("1"), some("1")], &originals),
            None
        );
    }

    #[test]
    fn restore_never_puts_a_non_number_into_a_shell_command() {
        let originals: BTreeMap<_, _> =
            [("window_animation_scale".to_string(), some("1; reboot"))].into();
        assert_eq!(
            restore_command(&[some("0"), some("0"), some("0")], &originals),
            None
        );
    }

    #[test]
    fn records_are_keyed_by_serial_and_avd() {
        let dir = Path::new("/x");
        assert_eq!(
            record_path(dir, "emulator-5554", Some("Pixel API 36")),
            Path::new("/x/emulator-5554@Pixel_API_36.json")
        );
        assert_eq!(
            record_path(dir, "192.168.1.5:5555", None),
            Path::new("/x/192.168.1.5_5555@.json")
        );
    }

    #[tokio::test]
    async fn turns_scales_off_and_restores_the_originals() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(Some("Pixel"), [Some("1.0"), None, Some("0.5")]);
        let applied = on_select(&h, dir.path(), "emulator-5554", Some(true), None)
            .await
            .expect("applied");
        assert_eq!(h.scales(), [some("0"), some("0"), some("0")]);
        let record = read_record(&applied.record_path).expect("record written");
        assert_eq!(record.pid, 100);
        assert_eq!(record.originals["transition_animation_scale"], None);

        restore(&h, &applied, SHUTDOWN_TIMEOUT).await;
        assert_eq!(h.scales(), [some("1.0"), None, some("0.5")]);
        assert!(!applied.record_path.exists());
    }

    #[tokio::test]
    async fn a_scale_changed_mid_session_is_left_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, [Some("1"), Some("1"), Some("1")]);
        let applied = on_select(&h, dir.path(), "R58M", Some(true), None)
            .await
            .unwrap();
        h.set("window_animation_scale", "0.5");
        restore(&h, &applied, SHUTDOWN_TIMEOUT).await;
        assert_eq!(h.scales(), [some("0.5"), some("1"), some("1")]);
    }

    #[tokio::test]
    async fn reselecting_with_the_option_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, [Some("1"), Some("1"), Some("1")]);
        let first = on_select(&h, dir.path(), "R58M", Some(true), None).await;
        let second = on_select(&h, dir.path(), "R58M", Some(true), first.as_ref()).await;
        assert_eq!(first, second);
        // The record still holds the device's own values, not the zeros.
        let record = read_record(&second.unwrap().record_path).unwrap();
        assert_eq!(record.originals["window_animation_scale"], some("1"));
    }

    #[tokio::test]
    async fn turning_the_option_off_undoes_this_daemons_setting() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, [Some("1"), Some("1"), Some("1")]);
        let applied = on_select(&h, dir.path(), "R58M", Some(true), None).await;
        // An SDK that does not say leaves it alone…
        let kept = on_select(&h, dir.path(), "R58M", None, applied.as_ref()).await;
        assert_eq!(kept, applied);
        assert_eq!(h.scales(), [some("0"), some("0"), some("0")]);
        // …and one that turns it off restores.
        let after = on_select(&h, dir.path(), "R58M", Some(false), applied.as_ref()).await;
        assert_eq!(after, None);
        assert_eq!(h.scales(), [some("1"), some("1"), some("1")]);
        assert!(!applied.unwrap().record_path.exists());
    }

    #[tokio::test]
    async fn a_session_without_the_option_and_no_records_never_touches_the_device() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, [Some("1"), Some("1"), Some("1")]);
        assert_eq!(
            on_select(&h, dir.path(), "R58M", Some(false), None).await,
            None
        );
        assert_eq!(on_select(&h, dir.path(), "R58M", None, None).await, None);
        assert_eq!(h.command_count(), 0);
    }

    fn stale_record(dir: &Path, serial: &str, avd: Option<&str>) -> PathBuf {
        let path = record_path(dir, serial, avd);
        write_record(
            &path,
            &OwnerRecord {
                serial: serial.to_string(),
                avd: avd.map(String::from),
                pid: 42,
                started: Some("Sun Oct 26 09:00:00 2026".into()),
                originals: SCALE_KEYS
                    .iter()
                    .map(|k| (k.to_string(), some("1")))
                    .collect(),
            },
        )
        .unwrap();
        path
    }

    #[tokio::test]
    async fn a_dead_daemons_record_is_restored_by_the_next_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = stale_record(dir.path(), "emulator-5554", Some("Pixel"));
        let h = FakeHost::new(Some("Pixel"), [Some("0"), Some("0"), Some("0")]);
        assert_eq!(
            on_select(&h, dir.path(), "emulator-5554", None, None).await,
            None
        );
        assert_eq!(h.scales(), [some("1"), some("1"), some("1")]);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn a_session_with_the_option_takes_over_a_dead_daemons_originals() {
        let dir = tempfile::tempdir().unwrap();
        stale_record(dir.path(), "emulator-5554", Some("Pixel"));
        let h = FakeHost::new(Some("Pixel"), [Some("0"), Some("0"), Some("0")]);
        let applied = on_select(&h, dir.path(), "emulator-5554", Some(true), None)
            .await
            .unwrap();
        let record = read_record(&applied.record_path).unwrap();
        assert_eq!(record.pid, 100, "now owned by this daemon");
        assert_eq!(record.originals["window_animation_scale"], some("1"));
        restore(&h, &applied, SHUTDOWN_TIMEOUT).await;
        assert_eq!(h.scales(), [some("1"), some("1"), some("1")]);
    }

    #[tokio::test]
    async fn a_record_for_another_avd_on_the_same_serial_is_not_applied() {
        let dir = tempfile::tempdir().unwrap();
        let other = stale_record(dir.path(), "emulator-5554", Some("Other_AVD"));
        // This AVD has animations off on purpose.
        let h = FakeHost::new(Some("Pixel"), [Some("0"), Some("0"), Some("0")]);
        assert_eq!(
            on_select(&h, dir.path(), "emulator-5554", None, None).await,
            None
        );
        assert_eq!(h.scales(), [some("0"), some("0"), some("0")]);
        assert!(other.exists(), "kept for when that AVD comes back");
    }

    #[tokio::test]
    async fn a_live_daemons_record_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = stale_record(dir.path(), "R58M", None);
        let mut h = FakeHost::new(None, [Some("0"), Some("0"), Some("0")]);
        h.live_owner = true;
        assert_eq!(
            on_select(&h, dir.path(), "R58M", Some(true), None).await,
            None
        );
        assert_eq!(on_select(&h, dir.path(), "R58M", None, None).await, None);
        assert_eq!(h.scales(), [some("0"), some("0"), some("0")]);
        assert_eq!(read_record(&path).unwrap().pid, 42);
    }

    #[tokio::test]
    async fn an_emulator_that_came_back_with_its_defaults_just_drops_the_record() {
        // A -read-only emulator killed before the daemon restored: it boots
        // with its own values again, so there is nothing to put back.
        let dir = tempfile::tempdir().unwrap();
        let path = stale_record(dir.path(), "emulator-5554", Some("Pixel"));
        let h = FakeHost::new(Some("Pixel"), [Some("0.5"), None, Some("1")]);
        assert_eq!(
            on_select(&h, dir.path(), "emulator-5554", None, None).await,
            None
        );
        assert_eq!(h.scales(), [some("0.5"), None, some("1")]);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn a_device_that_cannot_be_read_on_restore_keeps_its_record() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, [Some("1"), Some("1"), Some("1")]);
        let applied = on_select(&h, dir.path(), "R58M", Some(true), None)
            .await
            .unwrap();
        struct Offline;
        #[async_trait::async_trait]
        impl Host for Offline {
            async fn shell(&self, _: &str, _: &str, _: Duration) -> anyhow::Result<String> {
                anyhow::bail!("device offline")
            }
            async fn owner_alive(&self, _: &OwnerRecord) -> bool {
                false
            }
            fn self_pid(&self) -> u32 {
                100
            }
            async fn self_started(&self) -> Option<String> {
                Some("Mon Oct 27 10:00:00 2026".into())
            }
        }
        restore(&Offline, &applied, SHUTDOWN_TIMEOUT).await;
        assert!(applied.record_path.exists());
    }

    /// An apply whose adb call errors (a timeout) may still land: the command
    /// may already be on the device. So the session keeps its record and treats the
    /// scales as applied; the restore puts back only what reads 0.
    #[tokio::test]
    async fn an_apply_that_errors_but_lands_later_is_still_restored() {
        let dir = tempfile::tempdir().unwrap();
        let mut h = FakeHost::new(None, [Some("1"), Some("1"), Some("1")]);
        h.fail_writes = true; // the puts land, then adb reports a timeout
        let applied = on_select(&h, dir.path(), "R58M", Some(true), None)
            .await
            .expect("an unknown outcome is kept as applied");
        assert_eq!(h.scales(), [some("0"), some("0"), some("0")]);
        assert!(applied.record_path.exists());
        h.fail_writes = false;
        restore(&h, &applied, SHUTDOWN_TIMEOUT).await;
        assert_eq!(h.scales(), [some("1"), some("1"), some("1")]);
        assert!(!applied.record_path.exists());
    }

    /// A just-booted emulator on a starved runner can take seconds per adb
    /// call; selection must still turn its animations off.
    #[tokio::test]
    async fn a_slow_device_still_gets_its_animations_turned_off() {
        let dir = tempfile::tempdir().unwrap();
        let mut h = FakeHost::new(None, [Some("1"), Some("1"), Some("1")]);
        h.per_call = Duration::from_secs(5);
        let applied = on_select(&h, dir.path(), "R58M", Some(true), None).await;
        assert!(applied.is_some());
        assert_eq!(h.scales(), [some("0"), some("0"), some("0")]);
    }

    #[tokio::test]
    async fn a_failed_re_read_keeps_the_restore_this_daemon_owes() {
        let dir = tempfile::tempdir().unwrap();
        let mut h = FakeHost::new(None, [Some("1"), Some("1"), Some("1")]);
        let first = on_select(&h, dir.path(), "R58M", Some(true), None).await;
        assert!(first.is_some());
        h.per_call = Duration::from_secs(60); // the re-read times out
        let second = on_select(&h, dir.path(), "R58M", Some(true), first.as_ref()).await;
        assert_eq!(second, first);
    }
}
