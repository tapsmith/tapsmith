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
//!
//! A helper that stops answering (no reply by a waited line's deadline, or
//! its output ends before the reply) or whose stdin breaks is evicted: killed
//! and dropped, so the next touch starts a new one instead of queueing behind
//! the stuck one (PILOT-1036). So is one whose sends the simulator rejects,
//! a lone lift included: its connection to the simulator is gone, as after a
//! simulator reboot (PILOT-1072). The new helper's first line lifts at the last
//! point the old one was sent, in case it left a finger down. A line that
//! never reached the helper (a broken pipe) is retried once on its
//! replacement; one that did reach it is not, since part of it may have
//! landed. After [`MAX_HELPER_RESTARTS`] evictions a device's helper is given
//! up on for [`GIVE_UP_COOLDOWN`]: `ensure` fails, and touches use the agent's
//! synthesized ones. After the cool-down the next touch starts a helper again,
//! and one more failure gives it up again. A run of answered touches clears
//! the evictions (PILOT-1293): a simulator that was only busy for a while
//! does not lose the helper for the rest of the session.
//!
//! The helper's stderr is logged (its startup `fatal` line, and when the
//! simulator was slow to confirm touches), and an eviction's message says how
//! far the helper had got, whether it was still running, and what it last
//! said, so a log shows why it went quiet.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};
use tracing::{debug, info, warn};

struct Helper {
    child: Child,
    stdin: ChildStdin,
    /// Which start this is (unique per injector), so a failure seen on one
    /// helper never evicts the one that replaced it.
    generation: u64,
    /// The last point a line put a finger at or lifted it from, as written:
    /// where the replacement lifts if this helper is evicted.
    last_point: Option<(String, String)>,
    /// Lines written so far. The helper answers every line with one reply
    /// line (`ok` or `err …`), in order, so the nth reply answers the nth line.
    sent: u64,
    replies: Arc<std::sync::Mutex<Replies>>,
    /// The last line the helper wrote to stderr, if any.
    last_stderr: Arc<std::sync::Mutex<Option<String>>>,
    /// The task reading the helper's stderr: finished once it has ended.
    stderr_done: tokio::task::JoinHandle<()>,
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
    /// When the last reply arrived.
    last_at: Option<Instant>,
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

/// How many times a device's helper may be evicted and replaced without
/// recovering in between. The next failure gives the helper up for
/// [`GIVE_UP_COOLDOWN`].
const MAX_HELPER_RESTARTS: u32 = 3;
/// How long a given-up helper is left alone before a touch tries it again.
const GIVE_UP_COOLDOWN: Duration = Duration::from_secs(30);
/// Answered touches since the last eviction that show the helper works
/// again: its evictions are cleared. A line it answered with an error does
/// not break the run: the helper was answering.
const RECOVERY_SUCCESSES: u32 = 5;
/// How long writing a line may block. The daemon reads every reply, so a
/// write only blocks once the helper has stopped reading its input and the
/// pipe has filled: it is stuck, and holding the map lock on it would hold
/// up every device's touches.
const WRITE_BOUND: Duration = Duration::from_secs(2);

/// The helper's reply when the simulator refused a send (not merely confirmed
/// it late): `err send rejected`.
const REJECTED_REPLY: &str = "err send rejected";
/// How long the lone lift that checks a helper after a rejected send may take:
/// the helper waits up to 2 s to confirm a lift.
const LIFT_CHECK_DEADLINE: Duration = Duration::from_secs(3);

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
    /// Per device: helpers evicted for failing, and whether it is given up.
    health: std::sync::Mutex<HashMap<String, Health>>,
    /// Source of [`Helper::generation`].
    next_generation: std::sync::atomic::AtomicU64,
    max_restarts: u32,
    give_up_cooldown: Duration,
}

/// A device's record of helpers that failed this session.
#[derive(Default)]
struct Health {
    /// Helpers evicted for not answering or for a broken pipe, since the
    /// helper last recovered.
    evictions: u32,
    /// Set once evictions pass the cap: why the helper is not used, and
    /// since when (it is tried again after the cool-down).
    given_up: Option<(String, Instant)>,
    /// Waited lines answered `ok` since the last eviction.
    ok_streak: u32,
    /// A lift for the next helper to send first: the evicted one may have
    /// left a finger down.
    pending_lift: Option<String>,
}

/// Why `write_line` did not write.
enum WriteError {
    /// No helper is running for the device: nothing to retry on.
    NoHelper(anyhow::Error),
    /// The helper's stdin broke or stopped taking input. The helper has been
    /// evicted, and the line did not reach a helper that will act on it.
    Broken(anyhow::Error),
}

impl WriteError {
    fn into_inner(self) -> anyhow::Error {
        match self {
            WriteError::NoHelper(e) | WriteError::Broken(e) => e,
        }
    }
}

/// The state of `udid`'s helper `generation`, for the message of a line it
/// did not answer: the replies it gave, how long ago the last came, whether
/// it is still running, and the last thing it wrote to stderr. None when it
/// has been replaced. The caller holds the map lock.
fn describe_locked(
    map: &mut HashMap<String, Helper>,
    udid: &str,
    generation: u64,
) -> Option<String> {
    let helper = map.get_mut(udid).filter(|h| h.generation == generation)?;
    let mut parts = Vec::new();
    {
        let r = helper.replies.lock().unwrap_or_else(|e| e.into_inner());
        let mut answered = format!("it had answered {} of {} lines", r.received, helper.sent);
        if let Some(at) = r.last_at {
            answered.push_str(&format!(", the last {} ms ago", at.elapsed().as_millis()));
        }
        parts.push(answered);
    }
    parts.push(match helper.child.try_wait() {
        Ok(None) => "it was still running".to_string(),
        Ok(Some(status)) => format!("it had exited ({status})"),
        Err(e) => format!("its state could not be read: {e}"),
    });
    let said = helper
        .last_stderr
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(said) = said {
        parts.push(format!("it last said: {said}"));
    }
    Some(parts.join("; "))
}

/// How long a helper that failed to start is given to finish its stderr.
const STDERR_SETTLE: Duration = Duration::from_millis(500);

/// Log each line the helper writes to stderr, keeping the last in `last`.
/// Once it is `running`, the helper writes only when something is wrong (or
/// slow), so each is a warning. Before that, a line explains a failed start,
/// which goes into the start's error (reported once, by `ensure`): logged
/// quietly, as a helper that cannot start is tried again on later touches.
/// The task ends with the helper's stderr.
fn drain_stderr(
    udid: &str,
    stderr: tokio::process::ChildStderr,
    last: Arc<std::sync::Mutex<Option<String>>>,
    running: Arc<std::sync::atomic::AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    let udid = udid.to_string();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            if running.load(std::sync::atomic::Ordering::Relaxed) {
                warn!(udid, "iOS simulator HID helper: {line}");
            } else {
                debug!(udid, "iOS simulator HID helper: {line}");
            }
            *last.lock().unwrap_or_else(|e| e.into_inner()) = Some(line);
        }
    })
}

/// The point a protocol line puts a finger at (`d`/`m`/`t1`/`t2`) or lifts
/// it from (`u`), as written.
fn line_point(line: &str) -> Option<(String, String)> {
    let mut parts = line.split_whitespace();
    match parts.next()? {
        "d" | "m" | "u" | "t1" | "t2" => {
            Some((parts.next()?.to_string(), parts.next()?.to_string()))
        }
        _ => None,
    }
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
            health: std::sync::Mutex::new(HashMap::new()),
            next_generation: std::sync::atomic::AtomicU64::new(0),
            max_restarts: MAX_HELPER_RESTARTS,
            give_up_cooldown: GIVE_UP_COOLDOWN,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_helper_path(helper_path: PathBuf) -> Self {
        Self {
            helper_path,
            helpers: Mutex::new(HashMap::new()),
            unavailable_reported: std::sync::Mutex::new(HashSet::new()),
            start_gates: std::sync::Mutex::new(HashMap::new()),
            stop_epochs: std::sync::Mutex::new(HashMap::new()),
            touch_start_bound: TOUCH_START_BOUND,
            warm_start_bound: WARM_START_BOUND,
            health: std::sync::Mutex::new(HashMap::new()),
            next_generation: std::sync::atomic::AtomicU64::new(0),
            max_restarts: MAX_HELPER_RESTARTS,
            give_up_cooldown: GIVE_UP_COOLDOWN,
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
        // Reported when it was given up on, not on every touch after.
        if let Some(why) = self.given_up(udid) {
            return Err(anyhow::anyhow!(why));
        }
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

    /// Why `udid`'s helper is given up on, if it is. Once the cool-down has
    /// passed it no longer is: the next start tries again, with its evictions
    /// left at the cap, so one more failure gives it up again.
    fn given_up(&self, udid: &str) -> Option<String> {
        let mut health = self.health.lock().unwrap_or_else(|e| e.into_inner());
        let h = health.get_mut(udid)?;
        let (why, since) = h.given_up.as_ref()?;
        if since.elapsed() < self.give_up_cooldown {
            return Some(why.clone());
        }
        info!(
            udid,
            "trying the iOS simulator HID helper again: {} s have passed since it was given up",
            self.give_up_cooldown.as_secs()
        );
        h.given_up = None;
        None
    }

    /// Record that `udid`'s helper answered a waited line `ok`. Enough in a
    /// row clear its evictions: it works again.
    fn note_answered(&self, udid: &str) {
        let mut health = self.health.lock().unwrap_or_else(|e| e.into_inner());
        let Some(h) = health.get_mut(udid) else {
            return;
        };
        h.ok_streak = h.ok_streak.saturating_add(1);
        if h.evictions > 0 && h.ok_streak >= RECOVERY_SUCCESSES {
            info!(
                udid,
                evictions = h.evictions,
                "the iOS simulator HID helper is answering again; its failures are forgotten"
            );
            h.evictions = 0;
        }
    }

    /// Kill and drop `udid`'s helper if it is still `generation` (a newer
    /// one is left alone), and count it against the device's restarts. The
    /// caller holds the map lock. Returns what the caller's error should add.
    fn evict_locked(
        &self,
        map: &mut HashMap<String, Helper>,
        udid: &str,
        generation: u64,
        why: &str,
    ) -> Option<String> {
        if map.get(udid).map(|h| h.generation) != Some(generation) {
            return None;
        }
        let mut helper = map.remove(udid)?;
        let _ = helper.child.start_kill();
        self.queue_lift(udid, helper.last_point.take());
        let mut health = self.health.lock().unwrap_or_else(|e| e.into_inner());
        let h = health.entry(udid.to_string()).or_default();
        h.evictions += 1;
        h.ok_streak = 0;
        if h.evictions <= self.max_restarts {
            warn!(
                udid,
                error = why,
                restart = h.evictions,
                max = self.max_restarts,
                "iOS simulator HID helper failed; stopped it, and the next touch starts a new one"
            );
            return Some("the helper was stopped, and the next touch starts a new one".to_string());
        }
        // The reason goes into errors too, which under TAPSMITH_REQUIRE_IOS_HID
        // refuse the touch: what happens instead is said only in the warning.
        // It says whose problem it is, so a report reader doesn't blame the test.
        let cooldown = self.give_up_cooldown.as_secs();
        let reason = format!(
            "the iOS simulator HID helper failed {} times without recovering (last: {why}), so \
             it is not used for this device for the next {cooldown} s. This is a problem with \
             the simulator or the machine running it (its touch input stopped answering), not \
             with what the test checks",
            h.evictions
        );
        warn!(
            udid,
            "{reason}: taps, double taps, long presses and scroll drags use the agent's \
             synthesized touches instead, which take a few hundred milliseconds longer a tap and \
             which some native gesture recognizers ignore"
        );
        h.given_up = Some((reason, Instant::now()));
        Some(format!(
            "the helper has failed too often and is not used for the next {cooldown} s"
        ))
    }

    #[cfg(test)]
    fn with_max_restarts(mut self, max: u32) -> Self {
        self.max_restarts = max;
        self
    }

    #[cfg(test)]
    fn with_cooldown(mut self, cooldown: Duration) -> Self {
        self.give_up_cooldown = cooldown;
        self
    }

    #[cfg(test)]
    fn with_bounds(mut self, touch: Duration, warm: Duration) -> Self {
        self.touch_start_bound = touch;
        self.warm_start_bound = warm;
        self
    }

    /// Start `udid`'s helper ahead of the first touch, so that touch does not
    /// pay for the start. `epoch` is [`Self::stop_epoch`] taken when the
    /// warm-up was asked for: a device stopped since then keeps no helper.
    /// Skipped while another start for the device is in flight (a touch, or
    /// an earlier warm-up), so repeated selections don't queue starts. Quiet
    /// on failure: the next touch tries again and reports it.
    pub async fn warm(&self, udid: &str, epoch: u64) {
        let gate = self.start_gate(udid);
        let Ok(_starting) = gate.try_lock() else {
            return;
        };
        if self.given_up(udid).is_some() || self.has_live_helper(udid).await {
            return;
        }
        match self.start_locked(udid, self.warm_start_bound, epoch).await {
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
                // Not counted against its restarts (it ended between touches,
                // costing none), but it may have died with a finger down.
                if let Some(helper) = map.remove(udid) {
                    self.queue_lift(udid, helper.last_point);
                }
                false
            }
        }
    }

    /// Have `udid`'s next helper first lift at `point`, where the one it
    /// replaces last put or lifted a finger.
    fn queue_lift(&self, udid: &str, point: Option<(String, String)>) {
        if let Some((x, y)) = point {
            let mut health = self.health.lock().unwrap_or_else(|e| e.into_inner());
            health.entry(udid.to_string()).or_default().pending_lift = Some(format!("u {x} {y}"));
        }
    }

    fn start_gate(&self, udid: &str) -> Arc<Mutex<()>> {
        let mut gates = self.start_gates.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(gates.entry(udid.to_string()).or_default())
    }

    pub fn stop_epoch(&self, udid: &str) -> u64 {
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
        self.start_locked(udid, bound, epoch).await
    }

    /// Spawn `udid`'s helper and wait up to `bound` for it to report `ready`,
    /// then install it — unless the device was stopped after `epoch` was
    /// taken. The caller holds the device's start gate.
    async fn start_locked(&self, udid: &str, bound: Duration, epoch: u64) -> anyhow::Result<()> {
        let mut child = tokio::process::Command::new(&self.helper_path)
            .arg(udid)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Piped and drained into the log, so the helper's `fatal <msg>`
            // startup diagnostics and its notes about a slow simulator show
            // in the daemon log and the trace, and say why it went quiet.
            .stderr(Stdio::piped())
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
        let last_stderr = Arc::new(std::sync::Mutex::new(None));
        let running = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stderr_done = match child.stderr.take() {
            Some(stderr) => {
                drain_stderr(udid, stderr, Arc::clone(&last_stderr), Arc::clone(&running))
            }
            None => tokio::spawn(async {}),
        };

        // Bound the handshake so a stuck helper fails fast (caller falls back).
        let ready = tokio::time::timeout(bound, reader.next_line()).await;
        let failure = match ready {
            Err(_elapsed) => "helper startup timed out".to_string(),
            Ok(Ok(Some(line))) if line.starts_with("ready") => {
                info!(udid, %line, "iOS HID helper ready");
                running.store(true, std::sync::atomic::Ordering::Relaxed);
                String::new()
            }
            Ok(Ok(Some(line))) => format!("helper did not report ready: {line}"),
            Ok(Ok(None)) => "helper exited before reporting ready".to_string(),
            Ok(Err(e)) => format!("reading helper ready line: {e}"),
        };
        if !failure.is_empty() {
            let _ = child.start_kill();
            // What it said on its way out (a `fatal` line), once its stderr
            // has ended with it.
            let _ = tokio::time::timeout(STDERR_SETTLE, stderr_done).await;
            let said = last_stderr.lock().unwrap_or_else(|e| e.into_inner()).take();
            return Err(match said {
                Some(said) => anyhow::anyhow!("{failure} ({said})"),
                None => anyhow::anyhow!(failure),
            });
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
        let mut stdin = stdin;
        let mut sent = 0;
        // The helper this one replaces may have left a finger down: lift it
        // first. A lift with nothing down presses nothing. Its reply is
        // counted, not waited on.
        let lift = {
            let mut health = self.health.lock().unwrap_or_else(|e| e.into_inner());
            health.get_mut(udid).and_then(|h| h.pending_lift.take())
        };
        if let Some(lift) = lift {
            let written =
                tokio::time::timeout(WRITE_BOUND, stdin.write_all(format!("{lift}\n").as_bytes()))
                    .await;
            if !matches!(written, Ok(Ok(()))) {
                let _ = child.start_kill();
                // Still owed: the next helper sends it.
                let mut health = self.health.lock().unwrap_or_else(|e| e.into_inner());
                health.entry(udid.to_string()).or_default().pending_lift = Some(lift);
                return Err(anyhow::anyhow!(
                    "helper stopped reading before its first line"
                ));
            }
            sent = 1;
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
                r.last_at = Some(Instant::now());
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
                generation: self
                    .next_generation
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                last_point: None,
                sent,
                replies,
                last_stderr,
                stderr_done,
            },
        );
        Ok(())
    }

    /// Write one protocol line to the helper for `udid`, without waiting for
    /// the helper to act on it. On write failure the child is dropped so the
    /// next gesture re-spawns it. For a line in the middle of a gesture: the
    /// rest of a gesture cannot move to a new helper.
    pub async fn send(&self, udid: &str, line: &str) -> anyhow::Result<()> {
        self.write_line(udid, line, None)
            .await
            .map(|_| ())
            .map_err(WriteError::into_inner)
    }

    /// [`Self::send`] for a line that starts a gesture (a down, a double
    /// tap): if the helper's stdin has broken, the line reached nothing, so
    /// it is sent once more on a new helper.
    pub async fn send_gesture_start(&self, udid: &str, line: &str) -> anyhow::Result<()> {
        match self.write_line(udid, line, None).await {
            Ok(_) => Ok(()),
            Err(WriteError::NoHelper(e)) => Err(e),
            Err(WriteError::Broken(e)) => {
                debug!(udid, error = %e, "retrying a gesture's first line on a new HID helper");
                self.ensure(udid).await?;
                self.send(udid, line).await
            }
        }
    }

    /// Write one protocol line and wait, up to `deadline`, for the helper's
    /// reply to it: Ok once the helper has injected it (`ok`). The map lock is
    /// not held while waiting, so other devices' (and this device's
    /// fire-and-forget) touches are not held up.
    ///
    /// A broken pipe means the line reached nothing: it is sent once more on
    /// a new helper. No reply by the deadline, or the helper's output ending
    /// first, evicts the helper, but the line is not sent again: the helper
    /// had it, and part of it may have landed.
    pub async fn send_and_wait(
        &self,
        udid: &str,
        line: &str,
        deadline: Duration,
    ) -> Result<(), HidSendError> {
        let (tx, rx) = oneshot::channel();
        let (generation, rx) = match self.write_line(udid, line, Some(tx)).await {
            Ok(generation) => (generation, rx),
            Err(WriteError::NoHelper(e)) => return Err(HidSendError::NotSent(e)),
            Err(WriteError::Broken(e)) => {
                debug!(udid, error = %e, "retrying a line on a new HID helper");
                self.ensure(udid).await.map_err(HidSendError::NotSent)?;
                let (tx, rx) = oneshot::channel();
                let generation = self
                    .write_line(udid, line, Some(tx))
                    .await
                    .map_err(|e| HidSendError::NotSent(e.into_inner()))?;
                (generation, rx)
            }
        };
        let failure = match tokio::time::timeout(deadline, rx).await {
            Ok(Ok(reply)) if reply == "ok" => {
                self.note_answered(udid);
                return Ok(());
            }
            // Answering, and reported this line failed. A send the
            // simulator rejected may mean the helper cannot touch it at all:
            // check. One not confirmed in time is a loaded host, and a check
            // would queue behind the same backlog: the helper is kept.
            Ok(Ok(reply)) => {
                let failure = format!("the iOS HID helper reported: {reply}");
                let note = if reply.starts_with(REJECTED_REPLY) {
                    self.check_after_rejection(udid, generation, &reply).await
                } else {
                    None
                };
                return Err(HidSendError::Failed(match note {
                    Some(note) => format!("{failure}; {note}"),
                    None => failure,
                }));
            }
            Ok(Err(_)) => {
                // Its output ended: let it finish exiting and saying why, so
                // the message reports how it ended rather than a moment before.
                self.settle_exit(udid, generation).await;
                "the iOS HID helper exited before answering".to_string()
            }
            Err(_) => format!(
                "the iOS HID helper gave no reply within {} ms",
                deadline.as_millis()
            ),
        };
        let mut map = self.helpers.lock().await;
        // How far it had got, and what it last said: why it went quiet.
        let failure = match describe_locked(&mut map, udid, generation) {
            Some(state) => format!("{failure} ({state})"),
            None => failure,
        };
        Err(HidSendError::Failed(
            match self.evict_locked(&mut map, udid, generation, &failure) {
                Some(note) => format!("{failure}; {note}"),
                None => failure,
            },
        ))
    }

    /// Wait, up to [`STDERR_SETTLE`], for helper `generation` of `udid`,
    /// whose output has ended, to have exited and its stderr to have been
    /// read to the end.
    async fn settle_exit(&self, udid: &str, generation: u64) {
        let deadline = Instant::now() + STDERR_SETTLE;
        loop {
            {
                let mut map = self.helpers.lock().await;
                let Some(helper) = map.get_mut(udid).filter(|h| h.generation == generation) else {
                    return;
                };
                let exited = !matches!(helper.child.try_wait(), Ok(None));
                if exited && helper.stderr_done.is_finished() {
                    return;
                }
            }
            if Instant::now() >= deadline {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// After the simulator rejected a send of helper `generation`, ask it for
    /// a lone lift (`c`): it presses nothing, and lifts whatever the failed
    /// line may have left down. A helper whose connection to the simulator is
    /// gone has that rejected too: one started before the simulator rebooted
    /// gets every send rejected, so every later touch of the run would fail
    /// (PILOT-1072). It is evicted, and the next touch starts a new one. A
    /// helper whose lift goes through, or is only slow to be confirmed, is
    /// kept. Returns what the caller's error should add.
    async fn check_after_rejection(
        &self,
        udid: &str,
        generation: u64,
        reply: &str,
    ) -> Option<String> {
        let (tx, rx) = oneshot::channel();
        match self.write_line(udid, "c", Some(tx)).await {
            Ok(g) if g == generation => {}
            // Replaced or gone meanwhile (a broken pipe evicts it): nothing
            // left to check.
            _ => return None,
        }
        let why = match tokio::time::timeout(LIFT_CHECK_DEADLINE, rx).await {
            Ok(Ok(lift)) if lift.starts_with(REJECTED_REPLY) => {
                format!("it answered `{reply}`, then `{lift}` to a lone lift")
            }
            Ok(Ok(_)) => return None,
            Ok(Err(_)) => format!("it answered `{reply}`, then exited"),
            Err(_) => format!("it answered `{reply}`, then did not answer a lone lift"),
        };
        let mut map = self.helpers.lock().await;
        // Say what happened in the user's terms.
        self.evict_locked(&mut map, udid, generation, &why)
            .map(|note| {
                format!("the simulator refused its touches, as after a simulator reboot; {note}")
            })
    }

    /// Write `line` to `udid`'s helper; Ok with the helper's generation.
    async fn write_line(
        &self,
        udid: &str,
        line: &str,
        waiter: Option<oneshot::Sender<String>>,
    ) -> Result<u64, WriteError> {
        let mut map = self.helpers.lock().await;
        let helper = map
            .get_mut(udid)
            .ok_or_else(|| WriteError::NoHelper(anyhow::anyhow!("no helper running for {udid}")))?;
        let generation = helper.generation;
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
        let error =
            match tokio::time::timeout(WRITE_BOUND, helper.stdin.write_all(payload.as_bytes()))
                .await
            {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(format!("write to helper failed: {e}")),
                Err(_) => Some(format!(
                    "the helper took no input for {} ms",
                    WRITE_BOUND.as_millis()
                )),
            };
        if let Some(error) = error {
            self.evict_locked(&mut map, udid, generation, &error);
            return Err(WriteError::Broken(anyhow::anyhow!(error)));
        }
        helper.sent = seq;
        if let Some(point) = line_point(line) {
            helper.last_point = Some(point);
        }
        // ChildStdin is an unbuffered pipe, so flush() is a no-op; called
        // defensively in case the underlying impl ever buffers. write_all above
        // already pushed the bytes into the kernel pipe buffer.
        let _ = helper.stdin.flush().await;
        Ok(generation)
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

    /// A stub that logs its starts and every line, and answers `t1` with
    /// `t1_reply` and anything else with `other_reply` — on its first start
    /// only; later starts answer `ok`.
    fn erring_stub(
        log: &std::path::Path,
        t1_reply: &str,
        other_reply: &str,
    ) -> (tempfile::TempDir, PathBuf) {
        stub_helper(&format!(
            "echo start >> '{s}'\necho 'ready 1 1 1'\n\
             if [ \"$(wc -l < '{s}')\" -eq 1 ]; then \
             while IFS= read -r line; do echo \"$line\" >> '{l}'; \
             case \"$line\" in t1*) echo '{t1}';; *) echo '{o}';; esac; done; fi\n\
             while IFS= read -r line; do echo \"$line\" >> '{l}'; echo ok; done\n",
            s = log.join("starts").display(),
            l = log.join("lines").display(),
            t1 = t1_reply,
            o = other_reply,
        ))
    }

    #[tokio::test]
    async fn a_helper_that_was_only_slow_is_kept_unchecked() {
        // `err send failed`: a send not confirmed in time, as on a loaded
        // host. The helper works; checking it with a lift that would queue
        // behind the same backlog could evict it wrongly, so it is not checked.
        let log = tempfile::tempdir().unwrap();
        let (_dir, path) = erring_stub(log.path(), "err send failed", "err send failed");
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-K").await.unwrap();
        match injector
            .send_and_wait("UDID-K", "t1 10 20 10", Duration::from_secs(5))
            .await
        {
            Err(HidSendError::Failed(msg)) => {
                assert!(msg.contains("send failed"), "{msg}");
                assert!(!msg.contains("stopped"), "{msg}");
            }
            other => panic!("expected the helper's error, got {other:?}"),
        }
        assert!(injector.helpers.lock().await.contains_key("UDID-K"));
        assert_eq!(logged_lines(log.path()), vec!["t1 10 20 10"]);
        assert_eq!(start_count(&log.path().join("starts")), 1);
        injector.shutdown("UDID-K").await;
    }

    #[tokio::test]
    async fn a_helper_with_one_rejected_send_that_still_lifts_is_kept() {
        let log = tempfile::tempdir().unwrap();
        let (_dir, path) = erring_stub(log.path(), "err send rejected", "ok");
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-J").await.unwrap();
        match injector
            .send_and_wait("UDID-J", "t1 10 20 10", Duration::from_secs(5))
            .await
        {
            Err(HidSendError::Failed(msg)) => {
                assert!(msg.contains("send rejected"), "{msg}");
                assert!(!msg.contains("stopped"), "{msg}");
            }
            other => panic!("expected the helper's error, got {other:?}"),
        }
        assert!(injector.helpers.lock().await.contains_key("UDID-J"));
        assert_eq!(logged_lines(log.path()), vec!["t1 10 20 10", "c"]);
        injector.shutdown("UDID-J").await;
    }

    #[tokio::test]
    async fn a_helper_whose_simulator_connection_broke_is_replaced() {
        // PILOT-1072: after a simulator reboot, a helper started before it
        // has every send rejected, lifts included. It is replaced, so the
        // next touch goes through a new connection instead of every later
        // tap of the run failing.
        let log = tempfile::tempdir().unwrap();
        let (_dir, path) = erring_stub(log.path(), "err send rejected", "err send rejected");
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-R").await.unwrap();
        match injector
            .send_and_wait("UDID-R", "t1 10 20 10", Duration::from_secs(5))
            .await
        {
            Err(HidSendError::Failed(msg)) => {
                assert!(msg.contains("send rejected"), "{msg}");
                assert!(msg.contains("next touch starts a new one"), "{msg}");
            }
            other => panic!("expected the helper's error, got {other:?}"),
        }
        assert!(!injector.helpers.lock().await.contains_key("UDID-R"));
        injector.ensure("UDID-R").await.unwrap();
        injector
            .send_and_wait("UDID-R", "t1 10 20 10", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(start_count(&log.path().join("starts")), 2);
        injector.shutdown("UDID-R").await;
    }

    #[tokio::test]
    async fn a_rejected_send_whose_lift_is_only_slow_keeps_the_helper() {
        let log = tempfile::tempdir().unwrap();
        let (_dir, path) = erring_stub(log.path(), "err send rejected", "err send failed");
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-S").await.unwrap();
        let result = injector
            .send_and_wait("UDID-S", "t1 10 20 10", Duration::from_secs(5))
            .await;
        assert!(matches!(result, Err(HidSendError::Failed(_))), "{result:?}");
        assert!(injector.helpers.lock().await.contains_key("UDID-S"));
        injector.shutdown("UDID-S").await;
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
        assert!(!injector.helpers.lock().await.contains_key("UDID-D"));
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
            tokio::spawn(async move { injector.warm("UDID-W1", 0).await })
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
        injector.warm("UDID-W2", 0).await;
        assert_eq!(start_count(&starts), 1);
        injector.shutdown("UDID-W2").await;
    }

    #[tokio::test]
    async fn a_failed_warm_up_is_not_reported_as_unavailable() {
        // The touch that then fails reports it, with its own error.
        let (_dir, path) = stub_helper("exit 1\n");
        let injector = HidInjector::with_helper_path(path);
        injector.warm("UDID-W3", 0).await;
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
            tokio::spawn(async move { injector.warm("UDID-W4", 0).await })
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
    async fn a_warm_up_for_a_device_stopped_before_it_ran_keeps_no_helper() {
        // SetDevice(A) spawns the warm-up; SetDevice(B) stops A before the
        // task first runs.
        let (_dir, path) = slow_stub(&tempfile::tempdir().unwrap().path().join("s"), "0");
        let injector = HidInjector::with_helper_path(path);
        let epoch = injector.stop_epoch("UDID-W5");
        injector.shutdown("UDID-W5").await;
        injector.warm("UDID-W5", epoch).await;
        assert!(!injector.helpers.lock().await.contains_key("UDID-W5"));
    }

    #[tokio::test]
    async fn a_warm_up_while_a_start_is_in_flight_does_not_queue_another() {
        let log = tempfile::tempdir().unwrap();
        let starts = log.path().join("starts");
        let (_dir, path) = slow_stub(&starts, "0.6");
        let injector = Arc::new(HidInjector::with_helper_path(path));
        let first = {
            let injector = Arc::clone(&injector);
            tokio::spawn(async move { injector.warm("UDID-W6", 0).await })
        };
        tokio::time::sleep(Duration::from_millis(150)).await;
        let started = std::time::Instant::now();
        injector.warm("UDID-W6", 0).await;
        assert!(
            started.elapsed() < Duration::from_millis(300),
            "a second warm-up waited for the first: {:?}",
            started.elapsed()
        );
        first.await.unwrap();
        assert_eq!(start_count(&starts), 1);
        injector.shutdown("UDID-W6").await;
    }

    /// A stub that logs each start to `starts`, comes up, then reads lines
    /// without ever answering: alive, but stuck.
    fn silent_stub(starts: &std::path::Path) -> (tempfile::TempDir, PathBuf) {
        stub_helper(&format!(
            "echo start >> '{}'\necho 'ready 1 1 1'\ncat >/dev/null\n",
            starts.display()
        ))
    }

    #[tokio::test]
    async fn a_helper_that_stops_answering_is_replaced_by_the_next_touch() {
        let log = tempfile::tempdir().unwrap();
        let starts = log.path().join("starts");
        let (_dir, path) = silent_stub(&starts);
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-H1").await.unwrap();
        let result = injector
            .send_and_wait("UDID-H1", "t1 1 2 10", Duration::from_millis(200))
            .await;
        assert!(matches!(result, Err(HidSendError::Failed(_))), "{result:?}");
        // The silent helper is gone: the next touch starts a new one rather
        // than queueing behind the stuck one.
        assert!(!injector.helpers.lock().await.contains_key("UDID-H1"));
        injector.ensure("UDID-H1").await.unwrap();
        assert_eq!(start_count(&starts), 2);
        injector.shutdown("UDID-H1").await;
    }

    /// A stub whose first start behaves as `first` and later starts log
    /// every line to `lines` and answer `ok`.
    fn first_start_stub(log: &std::path::Path, first: &str) -> (tempfile::TempDir, PathBuf) {
        let starts = log.join("starts");
        let lines = log.join("lines");
        stub_helper(&format!(
            "echo start >> '{s}'\necho 'ready 1 1 1'\n\
             if [ \"$(wc -l < '{s}')\" -eq 1 ]; then {first}; fi\n\
             while IFS= read -r line; do echo \"$line\" >> '{l}'; echo ok; done\n",
            s = starts.display(),
            l = lines.display(),
        ))
    }

    fn logged_lines(log: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(log.join("lines"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// Wait until `udid`'s installed helper process has exited, leaving it
    /// in the map (a fixed sleep raced the stub's exit on loaded runners).
    async fn wait_for_helper_exit(injector: &HidInjector, udid: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            {
                let mut map = injector.helpers.lock().await;
                let helper = map.get_mut(udid).expect("helper installed");
                if matches!(helper.child.try_wait(), Ok(Some(_))) {
                    return;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the stub helper did not exit"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn a_line_that_hit_a_broken_pipe_is_sent_once_on_a_new_helper() {
        let log = tempfile::tempdir().unwrap();
        let (_dir, path) = first_start_stub(log.path(), "exit 0");
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-P").await.unwrap();
        // Let the first helper exit, so the write finds its stdin closed.
        wait_for_helper_exit(&injector, "UDID-P").await;
        injector
            .send_and_wait("UDID-P", "t1 3 4 10", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(start_count(&log.path().join("starts")), 2);
        assert_eq!(logged_lines(log.path()), vec!["t1 3 4 10"]);
        injector.shutdown("UDID-P").await;
    }

    #[tokio::test]
    async fn a_gesture_start_that_hit_a_broken_pipe_is_sent_once_on_a_new_helper() {
        let log = tempfile::tempdir().unwrap();
        let (_dir, path) = first_start_stub(log.path(), "exit 0");
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-G").await.unwrap();
        wait_for_helper_exit(&injector, "UDID-G").await;
        injector
            .send_gesture_start("UDID-G", "d 3 4")
            .await
            .unwrap();
        injector
            .send_and_wait("UDID-G", "u 3 4", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(logged_lines(log.path()), vec!["d 3 4", "u 3 4"]);
        injector.shutdown("UDID-G").await;
    }

    #[tokio::test]
    async fn the_replacement_of_a_silent_helper_first_lifts_where_it_was_pressing() {
        let log = tempfile::tempdir().unwrap();
        let (_dir, path) = first_start_stub(log.path(), "cat >/dev/null");
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-L").await.unwrap();
        injector.send("UDID-L", "d 5 6").await.unwrap();
        let result = injector
            .send_and_wait("UDID-L", "t1 7 8 10", Duration::from_millis(200))
            .await;
        match result {
            Err(HidSendError::Failed(msg)) => {
                assert!(msg.contains("no reply"), "{msg}");
                assert!(msg.contains("next touch starts a new one"), "{msg}");
            }
            other => panic!("expected a timeout, got {other:?}"),
        }
        // Not retried: the stuck helper had the tap.
        injector.ensure("UDID-L").await.unwrap();
        injector
            .send_and_wait("UDID-L", "t1 1 1 10", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(logged_lines(log.path()), vec!["u 7 8", "t1 1 1 10"]);
        injector.shutdown("UDID-L").await;
    }

    #[tokio::test]
    async fn a_helper_that_keeps_failing_is_given_up_for_a_while() {
        let log = tempfile::tempdir().unwrap();
        let starts = log.path().join("starts");
        let (_dir, path) = silent_stub(&starts);
        let injector = HidInjector::with_helper_path(path).with_max_restarts(1);
        injector.ensure("UDID-X").await.unwrap();
        let first = injector
            .send_and_wait("UDID-X", "t1 1 2 10", Duration::from_millis(100))
            .await;
        assert!(matches!(first, Err(HidSendError::Failed(_))), "{first:?}");
        // One restart is allowed...
        injector.ensure("UDID-X").await.unwrap();
        match injector
            .send_and_wait("UDID-X", "t1 1 2 10", Duration::from_millis(100))
            .await
        {
            Err(HidSendError::Failed(msg)) => {
                assert!(msg.contains("not used for the next 30 s"), "{msg}")
            }
            other => panic!("expected a timeout, got {other:?}"),
        }
        // ...then touches fall back to the agent, with the reason, which
        // says it is the simulator's problem rather than the test's.
        let err = injector.ensure("UDID-X").await.unwrap_err().to_string();
        assert!(err.contains("failed 2 times"), "{err}");
        assert!(err.contains("not with what the test checks"), "{err}");
        injector.warm("UDID-X", 0).await;
        assert_eq!(start_count(&starts), 2, "a given-up helper is not started");
        // Per device.
        injector.ensure("UDID-Y").await.unwrap();
        injector.shutdown("UDID-Y").await;
    }

    /// A stub that logs each start to `starts` and, by its start number:
    /// `silent` starts never answer, and `flaky` starts answer six lines
    /// `ok` (the lift a replacement sends first, then five) and then stop
    /// answering. Other starts answer every line `ok`.
    fn by_start_stub(
        starts: &std::path::Path,
        silent: &str,
        flaky: &str,
    ) -> (tempfile::TempDir, PathBuf) {
        stub_helper(&format!(
            "echo start >> '{s}'\necho 'ready 1 1 1'\n\
             n=$(wc -l < '{s}' | tr -d ' ')\n\
             case \" {silent} \" in *\" $n \"*) cat >/dev/null;; esac\n\
             case \" {flaky} \" in *\" $n \"*) i=0; while [ $i -lt 6 ] && IFS= read -r line; do \
             echo ok; i=$((i+1)); done; cat >/dev/null;; esac\n\
             while IFS= read -r line; do echo ok; done\n",
            s = starts.display(),
        ))
    }

    async fn tap(injector: &HidInjector, udid: &str) -> Result<(), HidSendError> {
        injector.ensure(udid).await.map_err(HidSendError::NotSent)?;
        injector
            .send_and_wait(udid, "t1 1 2 10", Duration::from_millis(300))
            .await
    }

    #[tokio::test]
    async fn a_given_up_helper_is_tried_again_after_its_cool_down() {
        // The CI failure (PILOT-1293): the simulator stopped answering for a
        // while, the helper was given up, and every later touch of the shard
        // was refused under TAPSMITH_REQUIRE_IOS_HID. A helper that works
        // again is used again.
        let log = tempfile::tempdir().unwrap();
        let starts = log.path().join("starts");
        let (_dir, path) = by_start_stub(&starts, "1 3", "");
        let injector = HidInjector::with_helper_path(path)
            .with_max_restarts(0)
            .with_cooldown(Duration::from_millis(400));
        assert!(matches!(
            tap(&injector, "UDID-C1").await,
            Err(HidSendError::Failed(_))
        ));
        // Given up: not even started during the cool-down.
        assert!(tap(&injector, "UDID-C1").await.is_err());
        assert_eq!(start_count(&starts), 1);
        tokio::time::sleep(Duration::from_millis(500)).await;
        tap(&injector, "UDID-C1").await.unwrap();
        assert_eq!(start_count(&starts), 2);
        // Still at the cap: one more failure gives it up again at once.
        injector.shutdown("UDID-C1").await;
        match tap(&injector, "UDID-C1").await {
            Err(HidSendError::Failed(msg)) => {
                assert!(msg.contains("not used for the next"), "{msg}")
            }
            other => panic!("expected the helper to be given up again, got {other:?}"),
        }
        assert!(tap(&injector, "UDID-C1").await.is_err());
        assert_eq!(start_count(&starts), 3);
        injector.shutdown("UDID-C1").await;
    }

    #[tokio::test]
    async fn a_run_of_answered_touches_clears_the_helpers_failures() {
        // One eviction allowed. The second helper answers its first lift and
        // five taps, then stops: without the reset that second eviction would
        // give it up.
        let log = tempfile::tempdir().unwrap();
        let starts = log.path().join("starts");
        let (_dir, path) = by_start_stub(&starts, "1", "2");
        let injector = HidInjector::with_helper_path(path).with_max_restarts(1);
        assert!(tap(&injector, "UDID-C2").await.is_err());
        for _ in 0..5 {
            tap(&injector, "UDID-C2").await.unwrap();
        }
        match tap(&injector, "UDID-C2").await {
            Err(HidSendError::Failed(msg)) => {
                assert!(msg.contains("next touch starts a new one"), "{msg}")
            }
            other => panic!("expected an eviction, got {other:?}"),
        }
        tap(&injector, "UDID-C2").await.unwrap();
        assert_eq!(start_count(&starts), 3);
        injector.shutdown("UDID-C2").await;
    }

    #[tokio::test]
    async fn answered_touches_short_of_a_run_do_not_clear_failures() {
        let log = tempfile::tempdir().unwrap();
        let starts = log.path().join("starts");
        let (_dir, path) = by_start_stub(&starts, "1", "2");
        let injector = HidInjector::with_helper_path(path).with_max_restarts(1);
        assert!(tap(&injector, "UDID-C3").await.is_err());
        for _ in 0..4 {
            tap(&injector, "UDID-C3").await.unwrap();
        }
        // A line not waited on takes the last answer start 2 gives, so only
        // four waited lines were answered before it went quiet.
        injector.send("UDID-C3", "d 1 2").await.unwrap();
        match tap(&injector, "UDID-C3").await {
            Err(HidSendError::Failed(msg)) => {
                assert!(msg.contains("not used for the next"), "{msg}")
            }
            other => panic!("expected the helper to be given up, got {other:?}"),
        }
        injector.shutdown("UDID-C3").await;
    }

    #[tokio::test]
    async fn an_unanswered_line_says_how_far_the_helper_got_and_what_it_said() {
        let (_dir, path) = stub_helper(
            "echo 'ready 1 1 1'\nread -r line; echo ok\n\
             echo 'slow: the simulator took up to 2900 ms to confirm 35 touch events' >&2\n\
             cat >/dev/null\n",
        );
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-D1").await.unwrap();
        injector.send("UDID-D1", "d 1 2").await.unwrap();
        match injector
            .send_and_wait("UDID-D1", "u 1 2", Duration::from_millis(500))
            .await
        {
            Err(HidSendError::Failed(msg)) => {
                assert!(msg.contains("no reply within 500 ms"), "{msg}");
                assert!(
                    msg.contains("it had answered 1 of 2 lines, the last"),
                    "{msg}"
                );
                assert!(msg.contains("it was still running"), "{msg}");
                assert!(
                    msg.contains("it last said: slow: the simulator took up to 2900 ms"),
                    "{msg}"
                );
            }
            other => panic!("expected a timeout, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_helper_that_dies_unanswered_says_how_it_exited() {
        let (_dir, path) = stub_helper(
            "echo 'ready 1 1 1'\nread -r line\necho 'fatal lost the simulator' >&2\nexit 3\n",
        );
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-D2").await.unwrap();
        match injector
            .send_and_wait("UDID-D2", "t1 1 2 10", Duration::from_secs(5))
            .await
        {
            Err(HidSendError::Failed(msg)) => {
                assert!(msg.contains("exited before answering"), "{msg}");
                assert!(msg.contains("it had exited (exit status: 3)"), "{msg}");
                assert!(
                    msg.contains("it last said: fatal lost the simulator"),
                    "{msg}"
                );
            }
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_failed_start_says_what_the_helper_said() {
        let (_dir, path) = stub_helper("echo 'fatal no SimDeviceLegacyHIDClient' >&2\nexit 1\n");
        let injector = HidInjector::with_helper_path(path);
        let err = injector.ensure("UDID-D3").await.unwrap_err().to_string();
        assert!(err.contains("exited before reporting ready"), "{err}");
        assert!(err.contains("fatal no SimDeviceLegacyHIDClient"), "{err}");
    }

    #[tokio::test]
    async fn stopping_a_device_during_a_waited_line_is_not_counted_as_a_failure() {
        let log = tempfile::tempdir().unwrap();
        let (_dir, path) = silent_stub(&log.path().join("starts"));
        let injector = Arc::new(HidInjector::with_helper_path(path).with_max_restarts(0));
        injector.ensure("UDID-Z").await.unwrap();
        let waiting = {
            let injector = Arc::clone(&injector);
            tokio::spawn(async move {
                injector
                    .send_and_wait("UDID-Z", "t1 1 2 10", Duration::from_secs(5))
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        injector.shutdown("UDID-Z").await;
        assert!(waiting.await.unwrap().is_err());
        injector.ensure("UDID-Z").await.unwrap();
        injector.shutdown("UDID-Z").await;
    }

    #[tokio::test]
    async fn the_replacement_of_a_helper_that_died_between_touches_lifts_first() {
        // A helper that dies with a finger down (its process gone, found by
        // the next touch rather than by a failed write) leaves the touch down
        // in the simulator: the next tap would only move it.
        let log = tempfile::tempdir().unwrap();
        let (_dir, path) = first_start_stub(log.path(), "read -r line; exit 0");
        let injector = HidInjector::with_helper_path(path);
        injector.ensure("UDID-K").await.unwrap();
        injector.send("UDID-K", "d 5 6").await.unwrap();
        wait_for_helper_exit(&injector, "UDID-K").await;
        injector.ensure("UDID-K").await.unwrap();
        injector
            .send_and_wait("UDID-K", "t1 1 1 10", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(logged_lines(log.path()), vec!["u 5 6", "t1 1 1 10"]);
        injector.shutdown("UDID-K").await;
    }

    #[test]
    fn line_point_reads_the_lines_that_place_a_finger() {
        let p = |x: &str, y: &str| Some((x.to_string(), y.to_string()));
        assert_eq!(line_point("d 1.5 2"), p("1.5", "2"));
        assert_eq!(line_point("t1 3 4 20"), p("3", "4"));
        assert_eq!(line_point("t2 5 6"), p("5", "6"));
        assert_eq!(line_point("u 7 8"), p("7", "8"));
        assert_eq!(line_point("c"), None);
        assert_eq!(line_point("d 1"), None);
        assert_eq!(line_point(""), None);
    }

    #[tokio::test]
    async fn send_without_ensure_errors() {
        let (_dir, path) = stub_helper("echo 'ready 1 1 1'\ncat >/dev/null\n");
        let injector = HidInjector::with_helper_path(path);
        let result = injector.send("UNKNOWN", "d 1 2").await;
        assert!(result.is_err(), "send to unknown udid should error");
    }
}
