//! Manages per-simulator `tapsmith-ios-hid` helper processes for live HID touch
//! injection into the iOS simulator. See
//! docs/superpowers/specs/2026-06-02-ios-live-touch-hid-design.md.
//!
//! `warm` starts a UDID's helper when the device is selected, so the first
//! touch does not pay for the start (CoreSimulator can take seconds to hand it
//! the device on a loaded host); `ensure` starts one lazily if none is running,
//! waiting for a warm-up already under way, and reuses it for subsequent events
//! (persistent client = low streaming latency).
//! `send` writes one protocol line. Any failure drops the child so the next
//! gesture re-spawns it; the caller falls back to the agent path on `ensure`
//! failure. macOS-only (CoreSimulator).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};
use tracing::{debug, info, warn};

struct Helper {
    child: Child,
    stdin: ChildStdin,
    /// Lines written so far. The helper answers every line with one reply
    /// line (`ok` or `err …`), in order, so the nth reply answers the nth line.
    sent: u64,
    replies: Arc<std::sync::Mutex<Replies>>,
}

/// The helper's replies as they arrive, for the senders waiting on one.
#[derive(Default)]
struct Replies {
    /// Replies read so far.
    received: u64,
    /// Senders waiting for the reply to their line, by line number.
    waiters: HashMap<u64, oneshot::Sender<String>>,
    /// The helper's output ended: no more replies will come.
    closed: bool,
}

/// Why `send_and_wait` did not get an `ok`.
#[derive(Debug)]
pub enum HidSendError {
    /// The line never reached the helper (none running, or the write
    /// failed): nothing was touched.
    NotSent(anyhow::Error),
    /// The helper took the line but reported a failure, or gave no answer by
    /// the deadline or before it exited: part of the gesture may have landed.
    Failed(String),
}

impl std::fmt::Display for HidSendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HidSendError::NotSent(e) => write!(f, "not sent: {e}"),
            HidSendError::Failed(msg) => f.write_str(msg),
        }
    }
}

/// How long a touch that has to start the helper waits for it.
const TOUCH_START_BOUND: Duration = Duration::from_secs(5);
/// How long a warm-up waits for the helper. CI logs show simctl calls taking
/// 10–15 s while CoreSimulator is loaded; the helper's start goes through it too.
const WARM_START_BOUND: Duration = Duration::from_secs(30);

pub struct HidInjector {
    helper_path: PathBuf,
    helpers: Mutex<HashMap<String, Helper>>,
    /// Devices whose helper failed to start and has been reported since it
    /// last started: the failure is logged once, not on every touch.
    unavailable_reported: std::sync::Mutex<HashSet<String>>,
    /// One lock per device, held while its helper starts: a touch that
    /// arrives during a warm-up waits for that start instead of spawning a
    /// second helper against the same loaded CoreSimulator.
    start_gates: std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Bumped by `shutdown`, so a start that was in flight for a device that
    /// has since been stopped drops its helper instead of installing it.
    stop_epochs: std::sync::Mutex<HashMap<String, u64>>,
    /// How long a touch waits for a helper it starts itself to report `ready`.
    touch_start_bound: Duration,
    /// How long a warm-up waits: nothing is held up by it, and a loaded
    /// CoreSimulator can take well over the touch bound to hand the helper
    /// its device.
    warm_start_bound: Duration,
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
            start_gates: std::sync::Mutex::new(HashMap::new()),
            stop_epochs: std::sync::Mutex::new(HashMap::new()),
            touch_start_bound: TOUCH_START_BOUND,
            warm_start_bound: WARM_START_BOUND,
        }
    }

    #[cfg(test)]
    fn with_helper_path(helper_path: PathBuf) -> Self {
        Self {
            helper_path,
            helpers: Mutex::new(HashMap::new()),
            unavailable_reported: std::sync::Mutex::new(HashSet::new()),
            start_gates: std::sync::Mutex::new(HashMap::new()),
            stop_epochs: std::sync::Mutex::new(HashMap::new()),
            touch_start_bound: TOUCH_START_BOUND,
            warm_start_bound: WARM_START_BOUND,
        }
    }

    /// Ensure a helper is running for `udid`. Idempotent: reuses a live child.
    /// Returns Err if the helper can't start or never reports `ready` — the
    /// caller then falls back to the agent path. The first such failure for a
    /// device is logged as a warning: the agent path's synthesized touches
    /// cost a few hundred milliseconds more a tap, and are not always taken
    /// for real ones (a native double-tap recognizer ignores them on iOS 26 —
    /// PILOT-795), so this is worth seeing.
    pub async fn ensure(&self, udid: &str) -> anyhow::Result<()> {
        let result = self.start_or_reuse(udid, self.touch_start_bound).await;
        match &result {
            Ok(()) => self.note_available(udid),
            Err(e) => {
                if self.note_unavailable(udid) {
                    warn!(
                        udid, helper = ?self.helper_path, error = %e,
                        "iOS simulator HID helper could not start; taps, double taps and long \
                         presses use the agent's synthesized touches instead, which take a few \
                         hundred milliseconds longer a tap and which some native gesture \
                         recognizers ignore (the helper ships beside the tapsmith-core binary)"
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

    #[cfg(test)]
    fn with_bounds(mut self, touch: Duration, warm: Duration) -> Self {
        self.touch_start_bound = touch;
        self.warm_start_bound = warm;
        self
    }

    /// Start `udid`'s helper ahead of the first touch, so that touch does not
    /// pay for the start. Quiet on failure: the next touch tries again and
    /// reports it.
    pub async fn warm(&self, udid: &str) {
        match self.start_or_reuse(udid, self.warm_start_bound).await {
            Ok(()) => self.note_available(udid),
            Err(e) => debug!(udid, error = %e, "iOS HID helper warm-up failed"),
        }
    }

    /// Whether `udid` has a running helper. Verified with try_wait() — a dead
    /// helper (simulator reload/crash) would otherwise linger in the map and
    /// make the next gesture's first event fail and fall back to the slow
    /// agent path — and dropped if it has exited.
    async fn has_live_helper(&self, udid: &str) -> bool {
        let mut map = self.helpers.lock().await;
        let Some(helper) = map.get_mut(udid) else {
            return false;
        };
        match helper.child.try_wait() {
            Ok(None) => true,
            _ => {
                map.remove(udid);
                false
            }
        }
    }

    fn start_gate(&self, udid: &str) -> Arc<Mutex<()>> {
        let mut gates = self.start_gates.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(gates.entry(udid.to_string()).or_default())
    }

    fn stop_epoch(&self, udid: &str) -> u64 {
        let epochs = self.stop_epochs.lock().unwrap_or_else(|e| e.into_inner());
        epochs.get(udid).copied().unwrap_or(0)
    }

    async fn start_or_reuse(&self, udid: &str, bound: Duration) -> anyhow::Result<()> {
        if self.has_live_helper(udid).await {
            return Ok(());
        }
        // One start per device at a time; a caller that waited here reuses
        // the helper the start it waited on installed. The map lock is NOT
        // held across the spawn + handshake below: a helper that hangs before
        // printing `ready` (e.g. CoreSimulator blocking) would otherwise freeze
        // every other touch and shutdown — across all devices — for the bound.
        let gate = self.start_gate(udid);
        let _starting = gate.lock().await;
        if self.has_live_helper(udid).await {
            return Ok(());
        }
        let epoch = self.stop_epoch(udid);

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
        let ready = tokio::time::timeout(bound, reader.next_line()).await;
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

        // Re-acquire the lock to install the helper — unless the device was
        // stopped meanwhile (its helper would outlive it), or, defensively, a
        // helper is already installed (kill_on_drop also reaps ours).
        let mut map = self.helpers.lock().await;
        if self.stop_epoch(udid) != epoch {
            let _ = child.start_kill();
            return Err(anyhow::anyhow!(
                "the device was stopped while its helper started"
            ));
        }
        if map.contains_key(udid) {
            let _ = child.start_kill();
            return Ok(());
        }

        // Read every reply, so the pipe never fills and blocks the helper,
        // and hand each to the sender waiting on its line, if any.
        let replies = Arc::new(std::sync::Mutex::new(Replies::default()));
        let drain_replies = Arc::clone(&replies);
        tokio::spawn(async move {
            let mut reader = reader;
            while let Ok(Some(l)) = reader.next_line().await {
                if l.starts_with("err") {
                    debug!(line = %l, "iOS HID helper event error");
                }
                let mut r = drain_replies.lock().unwrap_or_else(|e| e.into_inner());
                r.received += 1;
                let seq = r.received;
                if let Some(waiter) = r.waiters.remove(&seq) {
                    let _ = waiter.send(l);
                }
            }
            // Dropping the waiters tells them no reply is coming.
            let mut r = drain_replies.lock().unwrap_or_else(|e| e.into_inner());
            r.closed = true;
            r.waiters.clear();
        });

        map.insert(
            udid.to_string(),
            Helper {
                child,
                stdin,
                sent: 0,
                replies,
            },
        );
        Ok(())
    }

    /// Write one protocol line to the helper for `udid`, without waiting for
    /// the helper to act on it. On write failure the child is dropped so the
    /// next gesture re-spawns it.
    pub async fn send(&self, udid: &str, line: &str) -> anyhow::Result<()> {
        self.write_line(udid, line, None).await
    }

    /// Write one protocol line and wait, up to `deadline`, for the helper's
    /// reply to it: Ok once the helper has injected it (`ok`). The map lock is
    /// not held while waiting, so other devices' (and this device's
    /// fire-and-forget) touches are not held up.
    pub async fn send_and_wait(
        &self,
        udid: &str,
        line: &str,
        deadline: Duration,
    ) -> Result<(), HidSendError> {
        let (tx, rx) = oneshot::channel();
        self.write_line(udid, line, Some(tx))
            .await
            .map_err(HidSendError::NotSent)?;
        match tokio::time::timeout(deadline, rx).await {
            Ok(Ok(reply)) if reply == "ok" => Ok(()),
            Ok(Ok(reply)) => Err(HidSendError::Failed(format!(
                "the iOS HID helper reported: {reply}"
            ))),
            Ok(Err(_)) => Err(HidSendError::Failed(
                "the iOS HID helper exited before answering".to_string(),
            )),
            Err(_) => Err(HidSendError::Failed(format!(
                "the iOS HID helper gave no reply within {} ms",
                deadline.as_millis()
            ))),
        }
    }

    async fn write_line(
        &self,
        udid: &str,
        line: &str,
        waiter: Option<oneshot::Sender<String>>,
    ) -> anyhow::Result<()> {
        let mut map = self.helpers.lock().await;
        let helper = map
            .get_mut(udid)
            .ok_or_else(|| anyhow::anyhow!("no helper running for {udid}"))?;
        let seq = helper.sent + 1;
        if let Some(waiter) = waiter {
            let mut r = helper.replies.lock().unwrap_or_else(|e| e.into_inner());
            // Registered before the write, so the reply cannot come first.
            // A helper whose output has ended drops it: the caller hears so.
            if !r.closed {
                r.waiters.insert(seq, waiter);
            }
        }
        let payload = format!("{line}\n");
        if let Err(e) = helper.stdin.write_all(payload.as_bytes()).await {
            map.remove(udid);
            return Err(anyhow::anyhow!("write to helper failed: {e}"));
        }
        helper.sent = seq;
        // ChildStdin is an unbuffered pipe, so flush() is a no-op; called
        // defensively in case the underlying impl ever buffers. write_all above
        // already pushed the bytes into the kernel pipe buffer.
        let _ = helper.stdin.flush().await;
        Ok(())
    }

    /// Stop the helper for `udid` (device deselect / sim shutdown).
    pub async fn shutdown(&self, udid: &str) {
        let mut map = self.helpers.lock().await;
        // Under the map lock, so a start in flight sees the bump before it
        // can install (it checks under the same lock).
        *self
            .stop_epochs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(udid.to_string())
            .or_default() += 1;
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
    use std::time::Duration;

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

    /// A stub that replies to each line as the real helper does: `err` for a
    /// tap line (so a misrouted reply shows), `ok` for anything else.
    const REPLYING_STUB: &str = "echo 'ready 1 1 1'\nwhile IFS= read -r line; do \
        case \"$line\" in t1*) echo 'err send failed';; *) echo ok;; esac; done\n";

    #[tokio::test]
    async fn send_and_wait_returns_once_the_helper_answers_ok() {
        let (_dir, path) =
            stub_helper("echo 'ready 1 1 1'\nwhile IFS= read -r line; do echo ok; done\n");
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-A").await.unwrap();
        injector
            .send_and_wait("UDID-A", "t1 10 20 10", Duration::from_secs(5))
            .await
            .unwrap();
        injector.shutdown("UDID-A").await;
    }

    #[tokio::test]
    async fn send_and_wait_reports_the_helpers_error_reply() {
        let (_dir, path) = stub_helper(REPLYING_STUB);
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-B").await.unwrap();
        match injector
            .send_and_wait("UDID-B", "t1 10 20 10", Duration::from_secs(5))
            .await
        {
            Err(HidSendError::Failed(msg)) => assert!(msg.contains("send failed"), "{msg}"),
            other => panic!("expected the helper's error, got {other:?}"),
        }
        injector.shutdown("UDID-B").await;
    }

    #[tokio::test]
    async fn send_and_wait_gets_its_own_reply_after_unanswered_sends() {
        // The mirror's d/m/u lines are sent without waiting; their replies
        // must not be taken for the tap's.
        let (_dir, path) = stub_helper(REPLYING_STUB);
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-C").await.unwrap();
        injector.send("UDID-C", "d 1 2").await.unwrap();
        injector.send("UDID-C", "m 1 3").await.unwrap();
        injector.send("UDID-C", "u 1 3").await.unwrap();
        assert!(matches!(
            injector
                .send_and_wait("UDID-C", "t1 1 2 10", Duration::from_secs(5))
                .await,
            Err(HidSendError::Failed(_))
        ));
        // ...and a later line gets its own reply too.
        injector
            .send_and_wait("UDID-C", "d 1 2", Duration::from_secs(5))
            .await
            .unwrap();
        injector.shutdown("UDID-C").await;
    }

    #[tokio::test]
    async fn send_and_wait_fails_when_the_helper_dies_without_answering() {
        let (_dir, path) = stub_helper("echo 'ready 1 1 1'\nread -r line\nexit 0\n");
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-D").await.unwrap();
        let started = std::time::Instant::now();
        let result = injector
            .send_and_wait("UDID-D", "t1 1 2 10", Duration::from_secs(10))
            .await;
        assert!(matches!(result, Err(HidSendError::Failed(_))), "{result:?}");
        // Known as soon as the helper's output ends, not at the deadline.
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn send_and_wait_gives_up_at_its_deadline() {
        let (_dir, path) = stub_helper("echo 'ready 1 1 1'\ncat >/dev/null\n");
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-E").await.unwrap();
        let result = injector
            .send_and_wait("UDID-E", "t1 1 2 10", Duration::from_millis(200))
            .await;
        match result {
            Err(HidSendError::Failed(msg)) => assert!(msg.contains("no reply"), "{msg}"),
            other => panic!("expected a timeout, got {other:?}"),
        }
        injector.shutdown("UDID-E").await;
    }

    #[tokio::test]
    async fn send_and_wait_without_a_helper_sends_nothing() {
        let (_dir, path) = stub_helper("echo 'ready 1 1 1'\ncat >/dev/null\n");
        let injector = HidInjector::with_helper_path(path);
        assert!(matches!(
            injector
                .send_and_wait("NONE", "t1 1 2 10", Duration::from_secs(1))
                .await,
            Err(HidSendError::NotSent(_))
        ));
    }

    /// A stub that logs each start to `starts`, takes `delay` seconds to come
    /// up (CoreSimulator under load), then answers every line `ok`.
    fn slow_stub(starts: &std::path::Path, delay: &str) -> (tempfile::TempDir, PathBuf) {
        stub_helper(&format!(
            "echo start >> '{}'\nsleep {delay}\necho 'ready 1 1 1'\n\
             while IFS= read -r line; do echo ok; done\n",
            starts.display()
        ))
    }

    fn start_count(starts: &std::path::Path) -> usize {
        std::fs::read_to_string(starts)
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    #[tokio::test]
    async fn a_slow_helper_start_fails_a_touch_that_has_to_start_it() {
        let log = tempfile::tempdir().unwrap();
        let starts = log.path().join("starts");
        let (_dir, path) = slow_stub(&starts, "1.5");
        let injector = HidInjector::with_helper_path(path)
            .with_bounds(Duration::from_millis(500), Duration::from_secs(10));
        let err = injector.ensure("UDID-S").await.unwrap_err();
        assert!(err.to_string().contains("timed out"), "{err}");
    }

    #[tokio::test]
    async fn the_first_touch_waits_for_a_warm_up_already_starting_the_helper() {
        // The CI failure: the shard's first tap started the helper itself,
        // under a loaded CoreSimulator, and missed the touch's bound.
        let log = tempfile::tempdir().unwrap();
        let starts = log.path().join("starts");
        let (_dir, path) = slow_stub(&starts, "1.5");
        let injector = Arc::new(
            HidInjector::with_helper_path(path)
                .with_bounds(Duration::from_millis(500), Duration::from_secs(10)),
        );
        let warming = {
            let injector = Arc::clone(&injector);
            tokio::spawn(async move { injector.warm("UDID-W1").await })
        };
        // Let the warm-up spawn the helper before the touch arrives.
        tokio::time::sleep(Duration::from_millis(200)).await;
        injector.ensure("UDID-W1").await.unwrap();
        injector
            .send_and_wait("UDID-W1", "t1 1 2 10", Duration::from_secs(5))
            .await
            .unwrap();
        warming.await.unwrap();
        assert_eq!(start_count(&starts), 1, "one helper, not one per caller");
        injector.shutdown("UDID-W1").await;
    }

    #[tokio::test]
    async fn a_warm_up_reuses_a_running_helper() {
        let log = tempfile::tempdir().unwrap();
        let starts = log.path().join("starts");
        let (_dir, path) = slow_stub(&starts, "0");
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-W2").await.unwrap();
        injector.warm("UDID-W2").await;
        assert_eq!(start_count(&starts), 1);
        injector.shutdown("UDID-W2").await;
    }

    #[tokio::test]
    async fn a_failed_warm_up_is_not_reported_as_unavailable() {
        // The touch that then fails reports it, with its own error.
        let (_dir, path) = stub_helper("exit 1\n");
        let injector = HidInjector::with_helper_path(path);
        injector.warm("UDID-W3").await;
        assert!(injector.note_unavailable("UDID-W3"));
    }

    #[tokio::test]
    async fn a_device_stopped_during_its_warm_up_keeps_no_helper() {
        let log = tempfile::tempdir().unwrap();
        let starts = log.path().join("starts");
        let (_dir, path) = slow_stub(&starts, "0.5");
        let injector = Arc::new(HidInjector::with_helper_path(path));
        let warming = {
            let injector = Arc::clone(&injector);
            tokio::spawn(async move { injector.warm("UDID-W4").await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        injector.shutdown("UDID-W4").await;
        warming.await.unwrap();
        assert!(
            !injector.helpers.lock().await.contains_key("UDID-W4"),
            "a warm-up that finished after shutdown must not install its helper"
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
