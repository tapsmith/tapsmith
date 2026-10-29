//! Manages per-simulator `tapsmith-ios-hid` helper processes for live HID touch
//! injection into the iOS simulator. See
//! docs/superpowers/specs/2026-06-02-ios-live-touch-hid-design.md.
//!
//! `ensure` spawns a helper lazily on the first touch-down for a UDID and
//! reuses it for subsequent events (persistent client = low streaming latency).
//! `send` writes one protocol line. Any failure drops the child so the next
//! gesture re-spawns it; the caller falls back to the agent path on `ensure`
//! failure. macOS-only (CoreSimulator).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

struct Helper {
    child: Child,
    stdin: ChildStdin,
}

pub struct HidInjector {
    helper_path: PathBuf,
    helpers: Mutex<HashMap<String, Helper>>,
    /// Devices whose helper failed to start and has been reported since it
    /// last started: the failure is logged once, not on every touch.
    unavailable_reported: std::sync::Mutex<HashSet<String>>,
}

/// Resolve the helper binary as a sibling of the daemon executable (npm package
/// layout and local cargo builds both place it there), falling back to the bare
/// name on `PATH`.
fn resolve_helper_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join("tapsmith-ios-hid");
            if sibling.exists() {
                return sibling;
            }
        }
    }
    PathBuf::from("tapsmith-ios-hid")
}

impl Default for HidInjector {
    fn default() -> Self {
        Self::new()
    }
}

impl HidInjector {
    pub fn new() -> Self {
        Self {
            helper_path: resolve_helper_path(),
            helpers: Mutex::new(HashMap::new()),
            unavailable_reported: std::sync::Mutex::new(HashSet::new()),
        }
    }

    #[cfg(test)]
    fn with_helper_path(helper_path: PathBuf) -> Self {
        Self {
            helper_path,
            helpers: Mutex::new(HashMap::new()),
            unavailable_reported: std::sync::Mutex::new(HashSet::new()),
        }
    }

    /// Ensure a helper is running for `udid`. Idempotent: reuses a live child.
    /// Returns Err if the helper can't start or never reports `ready` — the
    /// caller then falls back to the agent path. The first such failure for a
    /// device is logged as a warning: the agent path's synthesized touches
    /// are not always taken for real ones (a native double-tap recognizer
    /// ignores them on iOS 26 — PILOT-795), so this is worth seeing.
    pub async fn ensure(&self, udid: &str) -> anyhow::Result<()> {
        let result = self.start_or_reuse(udid).await;
        match &result {
            Ok(()) => self.note_available(udid),
            Err(e) => {
                if self.note_unavailable(udid) {
                    warn!(
                        udid, helper = ?self.helper_path, error = %e,
                        "iOS simulator HID helper could not start; double taps and long presses \
                         use the agent's synthesized touches instead, which some native gesture \
                         recognizers ignore"
                    );
                }
            }
        }
        result
    }

    /// Record that `udid`'s helper is unavailable. True the first time since
    /// it last started (the caller reports it then).
    fn note_unavailable(&self, udid: &str) -> bool {
        self.unavailable_reported
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(udid.to_string())
    }

    /// Record that `udid`'s helper is running, so a later failure is reported again.
    fn note_available(&self, udid: &str) {
        self.unavailable_reported
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(udid);
    }

    async fn start_or_reuse(&self, udid: &str) -> anyhow::Result<()> {
        // Fast path: reuse a live helper. Verify it's still running with
        // try_wait() — a dead helper (simulator reload/crash) would otherwise
        // linger in the map and make the next gesture's first event fail and
        // fall back to the slow agent path. Crucially, do NOT hold the map lock
        // across the spawn + handshake below: a helper that hangs before
        // printing `ready` (e.g. CoreSimulator blocking) would otherwise freeze
        // every other touch and shutdown — across all devices — for the timeout.
        {
            let mut map = self.helpers.lock().await;
            if let Some(helper) = map.get_mut(udid) {
                match helper.child.try_wait() {
                    Ok(None) => return Ok(()), // still running
                    _ => {
                        // Exited or un-waitable → drop it and respawn below.
                        map.remove(udid);
                    }
                }
            }
        }

        let mut child = tokio::process::Command::new(&self.helper_path)
            .arg(udid)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherit (don't pipe) stderr: we never drain it, and a piped buffer
            // could fill and block the helper. Inheriting also surfaces the
            // helper's `fatal <msg>` startup diagnostics in the daemon log.
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| anyhow::anyhow!("spawn {:?} failed: {e}", self.helper_path))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("helper has no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("helper has no stdout"))?;
        let mut reader = BufReader::new(stdout).lines();

        // Bound the handshake so a stuck helper fails fast (caller falls back).
        let ready =
            tokio::time::timeout(std::time::Duration::from_secs(5), reader.next_line()).await;
        match ready {
            Err(_elapsed) => {
                let _ = child.start_kill();
                return Err(anyhow::anyhow!("helper startup timed out"));
            }
            Ok(Ok(Some(line))) if line.starts_with("ready") => {
                info!(udid, %line, "iOS HID helper ready");
            }
            Ok(Ok(Some(line))) => {
                let _ = child.start_kill();
                return Err(anyhow::anyhow!("helper did not report ready: {line}"));
            }
            Ok(Ok(None)) => {
                let _ = child.start_kill();
                return Err(anyhow::anyhow!("helper exited before reporting ready"));
            }
            Ok(Err(e)) => {
                let _ = child.start_kill();
                return Err(anyhow::anyhow!("reading helper ready line: {e}"));
            }
        }

        // Re-acquire the lock to install the helper. If another `ensure` for the
        // same udid won the race while we were spawning, drop ours and keep
        // theirs (kill_on_drop also reaps the loser's child).
        let mut map = self.helpers.lock().await;
        if map.contains_key(udid) {
            let _ = child.start_kill();
            return Ok(());
        }

        // Drain remaining stdout so its pipe never fills and blocks the helper.
        tokio::spawn(async move {
            let mut reader = reader;
            while let Ok(Some(l)) = reader.next_line().await {
                if l.starts_with("err") {
                    debug!(line = %l, "iOS HID helper event error");
                }
            }
        });

        map.insert(udid.to_string(), Helper { child, stdin });
        Ok(())
    }

    /// Write one protocol line to the helper for `udid`. On write failure the
    /// child is dropped so the next gesture re-spawns it.
    pub async fn send(&self, udid: &str, line: &str) -> anyhow::Result<()> {
        let mut map = self.helpers.lock().await;
        let helper = map
            .get_mut(udid)
            .ok_or_else(|| anyhow::anyhow!("no helper running for {udid}"))?;
        let payload = format!("{line}\n");
        if let Err(e) = helper.stdin.write_all(payload.as_bytes()).await {
            map.remove(udid);
            return Err(anyhow::anyhow!("write to helper failed: {e}"));
        }
        // ChildStdin is an unbuffered pipe, so flush() is a no-op; called
        // defensively in case the underlying impl ever buffers. write_all above
        // already pushed the bytes into the kernel pipe buffer.
        let _ = helper.stdin.flush().await;
        Ok(())
    }

    /// Stop the helper for `udid` (device deselect / sim shutdown).
    pub async fn shutdown(&self, udid: &str) {
        let mut map = self.helpers.lock().await;
        if let Some(mut helper) = map.remove(udid) {
            let _ = helper.child.start_kill();
            debug!(udid, "iOS HID helper stopped");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    /// Write an executable stub helper script and return its path (kept alive by
    /// the returned tempdir).
    fn stub_helper(body: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tapsmith-ios-hid");
        let mut f = std::fs::File::create(&path).unwrap();
        write!(f, "#!/bin/sh\n{body}").unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        (dir, path)
    }

    /// Compile and run the pure-C protocol unit test (`native/hid_protocol_test.c`)
    /// so its coverage of the parser/normalizer runs under `cargo test` in CI,
    /// not just by manual `clang` invocation. Skips cleanly if `clang` is absent.
    #[test]
    fn c_protocol_unit_test_passes() {
        use std::process::Command;
        let manifest = env!("CARGO_MANIFEST_DIR");
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("hid_protocol_test");
        let build = Command::new("clang")
            .arg("-o")
            .arg(&bin)
            .arg(format!("{manifest}/native/hid_protocol_test.c"))
            .arg(format!("{manifest}/native/hid_protocol.c"))
            .status();
        let build = match build {
            Ok(s) => s,
            Err(_) => return, // no clang on PATH — skip rather than fail
        };
        assert!(build.success(), "C protocol test failed to compile");
        let run = Command::new(&bin).status().unwrap();
        assert!(
            run.success(),
            "C protocol unit test (hid_protocol_test.c) failed"
        );
    }

    #[tokio::test]
    async fn ensure_then_send_succeeds_and_is_idempotent() {
        // Stub: print ready, then echo "ok" for every stdin line.
        let (_dir, path) =
            stub_helper("echo 'ready 1170 2532 3'\nwhile IFS= read -r line; do echo ok; done\n");
        let injector = HidInjector::with_helper_path(path);

        injector.ensure("UDID-1").await.unwrap();
        // Second ensure reuses the same child (no error, no new spawn).
        injector.ensure("UDID-1").await.unwrap();
        injector.send("UDID-1", "d 100 200").await.unwrap();
        injector.send("UDID-1", "m 100 150").await.unwrap();

        injector.shutdown("UDID-1").await;
    }

    #[tokio::test]
    async fn an_unavailable_helper_is_reported_once_until_it_starts() {
        let (_dir, path) = stub_helper("exit 1\n");
        let injector = HidInjector::with_helper_path(path);
        assert!(injector.ensure("UDID-W").await.is_err());
        // ensure already reported it; later failures stay quiet...
        assert!(!injector.note_unavailable("UDID-W"));
        assert!(injector.ensure("UDID-W").await.is_err());
        assert!(!injector.note_unavailable("UDID-W"));
        // ...per device...
        assert!(injector.note_unavailable("UDID-OTHER"));
        // ...until the helper has started again.
        injector.note_available("UDID-W");
        assert!(injector.note_unavailable("UDID-W"));
    }

    #[tokio::test]
    async fn ensure_fails_when_helper_never_reports_ready() {
        // Stub exits immediately without printing "ready".
        let (_dir, path) = stub_helper("exit 1\n");
        let injector = HidInjector::with_helper_path(path);
        let result = injector.ensure("UDID-2").await;
        assert!(
            result.is_err(),
            "ensure should fail when helper isn't ready"
        );
    }

    #[tokio::test]
    async fn ensure_fails_when_first_line_is_not_ready() {
        // Stub prints a non-ready line, then reads stdin (so it stays alive).
        let (_dir, path) = stub_helper("echo 'not-ready oh no'\ncat >/dev/null\n");
        let injector = HidInjector::with_helper_path(path);
        let result = injector.ensure("UDID-3").await;
        assert!(
            result.is_err(),
            "ensure should fail on a non-ready first line"
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("did not report ready"),
            "error should name the non-ready handshake"
        );
    }

    #[tokio::test]
    async fn send_without_ensure_errors() {
        let (_dir, path) = stub_helper("echo 'ready 1 1 1'\ncat >/dev/null\n");
        let injector = HidInjector::with_helper_path(path);
        let result = injector.send("UNKNOWN", "d 1 2").await;
        assert!(result.is_err(), "send to unknown udid should error");
    }
}
