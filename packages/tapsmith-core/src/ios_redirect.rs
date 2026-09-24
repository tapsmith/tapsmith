//! PILOT-182 — iOS Network Extension redirector lifecycle.
//!
//! Spawns the `Mitmproxy Redirector.app` launcher, accepts the control
//! channel from the System Extension, sends a per-simulator PID
//! `InterceptConf`, and bridges every intercepted TCP flow into
//! [`crate::network_proxy::handle_transparent_tcp`]. Intercepted UDP flows are
//! relayed only when they are DNS (so in-process gRPC/c-ares resolvers keep
//! working under capture); all other UDP is dropped. A background refresh
//! task polls `ps` every [`PID_REFRESH_INTERVAL`] and pushes an updated
//! `InterceptConf` if the simulator's process tree has changed.
//!
//! The lifecycle is anchored by the [`IosRedirect`] handle; dropping it
//! aborts the refresh, accept, and launcher-drain tasks and unlinks the
//! Unix socket file. The System Extension itself is a macOS system-wide
//! singleton and is NOT torn down — other Tapsmith daemons (concurrent workers
//! against other simulators) continue to use it independently.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use bytes::{Bytes, BytesMut};
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use tokio::io::AsyncReadExt;
use tokio::net::{UdpSocket, UnixListener, UnixStream};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{timeout, Instant};
use tokio_util::codec::{Framed, LengthDelimitedCodec};
use tracing::{debug, error, info, warn};

/// Shared list of in-flight per-flow handler tasks. The accept loop pushes
/// every newly-spawned handler here so [`IosRedirect::drop`] can abort them
/// during teardown — without this, a slow upstream could leave a flow task
/// running long after the daemon thinks capture has stopped, and the
/// listener path would be unlinked from under it. Wrapped in a `std::sync`
/// `Mutex` (not `tokio::sync::Mutex`) because `Drop` runs synchronously and
/// can't `.await`.
type FlowTaskList = Arc<StdMutex<Vec<JoinHandle<()>>>>;

use crate::ios::simulator_processes;
use crate::ipc;
use crate::mitm_ca::MitmAuthority;
use crate::network_proxy::{handle_transparent_tcp, join_host_port, ProxyState};

/// How often the PID refresh task re-queries `ps` and pushes a new
/// `InterceptConf` if the simulator's process tree has changed. Short enough
/// to catch newly-spawned test-app child processes before they race through
/// a quick HTTP call; long enough to keep the `ps` cost negligible.
const PID_REFRESH_INTERVAL: Duration = Duration::from_secs(2);

/// Max size of a `NewFlow` proto handshake. The real protocol messages are
/// only a few bytes; this cap rejects anything pathological.
const NEW_FLOW_MAX_LEN: usize = 64 * 1024;

/// How long to wait for the System Extension to send each part of a flow's
/// NewFlow handshake (length prefix and proto body). Bounds slow-loris flow
/// attempts: a connection that the SE accepts but never writes the
/// handshake on would otherwise pin a flow handler task forever.
const NEW_FLOW_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for the first datagram on an intercepted UDP flow before
/// giving up. UDP flows carry a constant remote endpoint, conveyed by the
/// first `UdpPacket`; without a packet we can't tell DNS from anything else,
/// so a silent flow is simply let lapse.
const UDP_FIRST_PACKET_TIMEOUT: Duration = Duration::from_secs(10);

/// Idle ceiling for a relayed DNS flow: if neither side sends a datagram for
/// this long, the relay closes. DNS exchanges are sub-second, so this only
/// reaps the long tail of c-ares keeping a flow open after it has its answer.
const UDP_RELAY_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Backoff after a DNS relay socket receive error. Connected UDP sockets can
/// surface asynchronous ICMP errors; these should not tear down the flow, but a
/// bad resolver must also not spin the relay loop.
const UDP_RELAY_RECV_ERROR_BACKOFF: Duration = Duration::from_millis(25);

/// Consecutive DNS relay socket receive errors tolerated before closing the
/// flow. A transient ICMP error is ignored; a persistently failing resolver is
/// bounded.
const UDP_RELAY_MAX_RECV_ERRORS: u32 = 8;

/// Max DNS datagram size we buffer from the resolver. EDNS0 responses are
/// capped well below this; anything larger falls back to TCP DNS (a separate
/// intercepted TCP flow), so truncating here is safe.
const UDP_DGRAM_MAX: usize = 4096;

/// Backoff before retrying after a transient `accept()` failure on the
/// flow listener (e.g. `ConnectionAborted`, `EMFILE`). Short enough that
/// the loop doesn't add user-visible latency, long enough to give the
/// kernel a chance to recover under fd pressure.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(50);

/// How many consecutive `accept()` failures the flow listener tolerates
/// before giving up. Below this threshold we back off and retry; above
/// it, the listener is presumed wedged and we tear down the task. With
/// `ACCEPT_BACKOFF = 50ms` this is roughly 1.5 seconds of solid failures.
const MAX_CONSECUTIVE_ACCEPT_FAILURES: u32 = 32;

/// How long to wait for the System Extension to connect back to our
/// listener after spawning the launcher binary.
const CONTROL_CHANNEL_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for another daemon's redirector launch to finish before
/// launching anyway. A healthy launch holds the lock for well under a second
/// (dial-back, then the launcher's exit, then `LAUNCH_LOCK_GRACE`). A failing
/// one holds it until its error return: up to `CONTROL_CHANNEL_TIMEOUT` when
/// the accept times out, or about 15 s when the extension connects but the
/// initial InterceptConf write then times out; the slowest possible success holds it for
/// about 20.5 s (a 10 s accept, the 5 s InterceptConf write bound, then
/// `LAUNCHER_EXIT_WAIT` 5 s, then the 0.5 s grace). So 25 s waits out any
/// single holder, and running unserialised after it only happens behind a
/// queue of failing or pathologically slow launches.
const LAUNCH_LOCK_TIMEOUT: Duration = Duration::from_secs(25);

/// How long the launch lock is kept after the extension has connected, the
/// initial InterceptConf is accepted and the launcher has exited (see
/// `IosRedirect::start`). Off the capture's critical path.
const LAUNCH_LOCK_GRACE: Duration = Duration::from_millis(500);

/// Cap on waiting for the launcher process to exit before releasing the lock
/// (it normally exits right after handing the extension its socket path).
const LAUNCHER_EXIT_WAIT: Duration = Duration::from_secs(5);

/// Host-wide lock serialising redirector launches across daemons (PILOT-197,
/// PILOT-319). The stock launcher reuses any `mitmproxy` Network Extension
/// configuration that is not yet `connected`: two daemons launching within the
/// same ~150 ms overwrite each other's socket path, the second start is
/// skipped, and that daemon's control channel never connects. Holding this
/// `flock` from spawning the launcher until the extension has dialled back
/// keeps every launch out of every other's window. Released on drop.
pub(crate) struct LaunchLock {
    _file: std::fs::File,
}

impl LaunchLock {
    /// Take the lock at `path`, polling (without blocking the runtime) up to
    /// `wait`. `None` when it could not be taken in time or the file could not
    /// be opened — the caller then launches unserialised, as before, rather
    /// than failing capture outright.
    pub(crate) async fn acquire(path: &Path, wait: Duration) -> Option<Self> {
        use std::os::unix::io::AsRawFd;
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let file = match std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
        {
            Ok(f) => f,
            Err(e) => {
                warn!(path = %path.display(), "Cannot open redirector launch lock ({e}); launching unserialised");
                return None;
            }
        };
        let deadline = Instant::now() + wait;
        loop {
            // SAFETY: flock on a descriptor owned by `file` for its lifetime.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Some(Self { _file: file });
            }
            // Only "another daemon holds it" is worth waiting for. Anything
            // else (a home directory on a filesystem without flock, …) will
            // not change by polling, so launch unserialised at once.
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::EWOULDBLOCK) {
                warn!(path = %path.display(), "Cannot lock redirector launch lock ({err}); launching unserialised");
                return None;
            }
            if Instant::now() >= deadline {
                warn!(
                    path = %path.display(),
                    "Another daemon's redirector launch is still holding the lock after {}s; launching unserialised",
                    wait.as_secs()
                );
                return None;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

fn launch_lock_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".tapsmith").join("ios-redirector-launch.lock"))
}

/// How long to wait for a write to the SE control channel before giving up.
/// Guards against hangs if the SE stops draining its side (crash, suspension,
/// kernel quirk) — without this, the refresh task and the initial conf send
/// on the startup fast path could block indefinitely.
const CONTROL_CHANNEL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// Bundle ID of the mitmproxy System Extension we depend on. Used to grep
/// `systemextensionsctl list` output for the current registration state.
const REDIRECTOR_SE_BUNDLE_ID: &str = "org.mitmproxy.macos-redirector.network-extension";

/// State of the Mitmproxy Redirector macOS System Extension on the current
/// machine, as reported by `systemextensionsctl list`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeStatus {
    /// `[activated enabled]` — the SE is installed, approved, and ready.
    Enabled,
    /// The SE is installed but not yet approved by the user
    /// (`[activated waiting for user]`).
    WaitingForUser,
    /// The SE has never been registered on this machine (no matching row
    /// in `systemextensionsctl list`).
    NotRegistered,
    /// `systemextensionsctl` isn't available, failed, or returned output we
    /// don't recognise. Callers should proceed without fast-failing.
    Unknown,
}

/// Shell out to `systemextensionsctl list` and parse the current state of
/// the Mitmproxy Redirector Network Extension. Runs synchronously via
/// `tokio::process::Command` — the subprocess is cheap (<10ms).
async fn check_se_status() -> SeStatus {
    let output = match Command::new("systemextensionsctl")
        .arg("list")
        .output()
        .await
    {
        Ok(o) => o,
        Err(_) => return SeStatus::Unknown,
    };
    if !output.status.success() {
        return SeStatus::Unknown;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(line) = stdout.lines().find(|l| l.contains(REDIRECTOR_SE_BUNDLE_ID)) else {
        return SeStatus::NotRegistered;
    };
    if line.contains("[activated enabled]") {
        SeStatus::Enabled
    } else if line.contains("waiting for user") || line.contains("user approval pending") {
        SeStatus::WaitingForUser
    } else {
        // Terminated-for-installation, activated-pending-user-approval,
        // and other transient states — treat as Unknown and let the
        // control-channel accept timeout decide.
        SeStatus::Unknown
    }
}

/// Best-effort pre-flight cleanup: find `Mitmproxy Redirector` processes
/// launched by tapsmith-core instances that no longer exist, and `kill -9` them.
///
/// Each redirector is spawned by a specific tapsmith-core daemon and takes the
/// Unix socket path `/tmp/tapsmith-redirector-<daemon-pid>.sock` as its first
/// (and only) argument. When a tapsmith-core dies ungracefully (SIGKILL, crash,
/// IDE restart), the redirector it spawned can end up orphaned — sometimes
/// stuck in `UE` / `Z` state, where it's still registered with the macOS
/// System Extension and apparently delays or blocks the next session's
/// control-channel connect.
///
/// We identify orphans by parsing the redirector's command-line arguments to
/// extract the owning tapsmith-core PID, then checking whether that PID is
/// still alive. Only orphans are killed; redirectors owned by concurrent
/// sibling daemons are left alone.
///
/// Everything is best-effort — any step failing (pgrep missing, ps missing,
/// kill fails) is logged at debug and swallowed. The call-site immediately
/// proceeds to the real connect attempt.
async fn kill_orphaned_redirectors() {
    // macOS `pgrep` does not support the GNU `-a` flag — it silently ignores
    // it and prints bare PIDs, so we use `pgrep -f` to get PIDs and then
    // `ps -p <pid> -o command=` per PID to recover the command line and
    // verify the match.
    let output = match Command::new("pgrep")
        .args(["-f", "Mitmproxy Redirector"])
        .output()
        .await
    {
        Ok(o) if o.status.success() => o,
        Ok(_) => return, // No matches (pgrep exits 1 when nothing matches)
        Err(e) => {
            debug!("pgrep unavailable for redirector cleanup: {e}");
            return;
        }
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let self_pid = std::process::id();

    for line in text.lines() {
        let Ok(pid) = line.trim().parse::<u32>() else {
            continue;
        };
        // Defensive: never kill a process under our own PID (launcher might
        // briefly show up here between spawn and self-exit).
        if pid == self_pid {
            continue;
        }
        // Recover the command-line arguments via `ps`. Skip silently if
        // the process exited between the pgrep listing and this call.
        let ps_out = match Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .await
        {
            Ok(o) if o.status.success() => o,
            _ => continue,
        };
        let args = String::from_utf8_lossy(&ps_out.stdout);
        // Extract "/tmp/tapsmith-redirector-<daemon-pid>.sock" from the args.
        // If the arg shape doesn't match what we know, skip — don't guess.
        let Some(daemon_pid) = extract_owner_pid_from_args(args.trim()) else {
            continue;
        };
        // If the owning daemon is still alive, this redirector belongs to
        // a sibling tapsmith-core and we must not touch it.
        if process_is_alive(daemon_pid).await {
            continue;
        }
        warn!(
            redirector_pid = pid,
            dead_daemon_pid = daemon_pid,
            "cleaning up orphaned Mitmproxy Redirector from prior tapsmith-core session"
        );
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .await;
    }
}

/// Parse `/tmp/tapsmith-redirector-<daemon-pid>.sock` out of a redirector's
/// command-line args. Returns `None` if the args don't contain a
/// recognisable tapsmith-core socket reference — we refuse to kill anything
/// we can't positively identify.
fn extract_owner_pid_from_args(args: &str) -> Option<u32> {
    // Look for the literal prefix; tolerate the rest of the path so we
    // don't depend on exact formatting.
    let start = args.find("/tmp/tapsmith-redirector-")?;
    let tail = &args[start + "/tmp/tapsmith-redirector-".len()..];
    let dot = tail.find('.')?;
    tail[..dot].parse::<u32>().ok()
}

/// Probe whether a PID is still alive. Uses `kill -0` which exits 0 if the
/// process exists (regardless of permission), so it's a reliable liveness
/// check for processes we own. Defaults to "alive" on any failure so we
/// err on the side of NOT killing a redirector whose owner we can't probe.
async fn process_is_alive(pid: u32) -> bool {
    match Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .await
    {
        Ok(status) => status.success(),
        Err(_) => true,
    }
}

/// Handle to a running redirector session. Dropping it aborts the
/// background tasks (including any in-flight per-flow handlers) and unlinks
/// the Unix socket file.
pub struct IosRedirect {
    accept_handle: JoinHandle<()>,
    refresh_handle: JoinHandle<()>,
    launcher_handle: JoinHandle<()>,
    flow_tasks: FlowTaskList,
    listener_path: PathBuf,
}

impl IosRedirect {
    /// Bring up a redirector session for a specific simulator UDID.
    ///
    /// 1. Resolves the simulator's initial PID set via
    ///    [`simulator_processes::resolve_simulator_pids`].
    /// 2. Binds a per-daemon Unix listener at
    ///    `/tmp/tapsmith-redirector-<daemon-pid>.sock` (unlinking any stale
    ///    file left over from a SIGKILL'd previous daemon).
    /// 3. Spawns the `Mitmproxy Redirector.app` launcher binary, telling it
    ///    where to connect. The launcher is a short-lived helper that
    ///    hands our listener path to the System Extension and then exits
    ///    cleanly with status 0.
    /// 4. Accepts the control-channel connection from the SE (10 s timeout).
    /// 5. Sends the initial `InterceptConf` over the control channel,
    ///    wrapped in the length-delimited framing that the SE expects.
    /// 6. Spawns the background refresh task (owns the control channel and
    ///    periodically updates the PID filter).
    /// 7. Spawns the background accept task (owns the listener and routes
    ///    every new flow connection into
    ///    [`handle_transparent_tcp`]).
    ///
    /// Returns only after the SE has connected back and accepted the
    /// initial `InterceptConf` — so the caller can rely on the filter
    /// being active before the first test action runs.
    pub async fn start(
        udid: String,
        proxy_state: Arc<Mutex<ProxyState>>,
        mitm_ca: Arc<MitmAuthority>,
    ) -> Result<Self> {
        let initial_pids = simulator_processes::resolve_simulator_pids(&udid)
            .await
            .context("resolving initial simulator PID set")?;
        if initial_pids.is_empty() {
            warn!(%udid, "no simulator processes found — InterceptConf will be empty");
        } else {
            debug!(%udid, pids = initial_pids.len(), "resolved initial simulator PID set");
        }

        // The Unix socket MUST live in `/tmp`, not under the per-user
        // `$TMPDIR` (`/var/folders/<xxx>/T/`). The macOS System Extension
        // runs in a different security domain than the calling user's
        // shell and cannot reach per-user TMPDIR paths — trying to bind
        // there silently causes the SE to never connect, and we time out
        // on the control channel accept. `mitmproxy_rs` upstream uses
        // `/tmp/mitmproxy-<pid>` for the same reason.
        //
        // The pid suffix is still unique per worker daemon, so concurrent
        // workers don't collide. The theoretical symlink-planting risk of
        // a world-writable `/tmp` is not relevant to our threat model
        // (developer machine, single user) — and `remove_file` before
        // `bind` below closes the narrow pre-creation window.
        let listener_path = PathBuf::from(format!(
            "/tmp/tapsmith-redirector-{}.sock",
            std::process::id()
        ));
        if let Err(e) = std::fs::remove_file(&listener_path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e).with_context(|| {
                    format!("removing stale Unix socket at {}", listener_path.display())
                });
            }
        }
        let listener = UnixListener::bind(&listener_path)
            .with_context(|| format!("binding listener at {}", listener_path.display()))?;

        // Best-effort cleanup of orphaned redirector processes from a prior
        // tapsmith-core session whose owner is no longer alive. Empirically, a
        // stale `Mitmproxy Redirector` stuck in `UE`/`Z` state can wedge the
        // macOS System Extension in a way that makes the next control-channel
        // accept below time out. Safe because we only kill processes whose
        // socket argument references a PID that isn't running anymore —
        // concurrent sibling tapsmith-core daemons are left untouched.
        kill_orphaned_redirectors().await;

        // `resolve_redirector_path` does synchronous filesystem work
        // (exists checks, directory creation, tar extraction via a blocking
        // `tar` child process) and can take ~1–3s when we have to extract
        // the brew cask on first launch. Offload to a blocking thread so we
        // don't stall the tokio worker this task is scheduled on. One-time
        // cost per daemon lifetime.
        let redirector_bin = tokio::task::spawn_blocking(resolve_redirector_path)
            .await
            .context("resolve_redirector_path task panicked")?
            .context("locating Mitmproxy Redirector.app")?;

        // Fast-fail if the Network Extension is registered but not yet
        // approved by the user. Without this check we'd still spawn the
        // launcher, the SE wouldn't load, and we'd sit in a 10s control-
        // channel accept timeout before reporting a generic "timed out"
        // error. Checking up front turns that into an actionable message
        // and saves the 10s wait every single test run until the user
        // approves the extension.
        match check_se_status().await {
            SeStatus::Enabled => {
                debug!("Mitmproxy Redirector SE is [activated enabled]");
            }
            SeStatus::WaitingForUser => {
                bail!(
                    "Mitmproxy Redirector Network Extension is installed but not approved.\n\
                     \n\
                     Approve it in: System Settings → General → Login Items & Extensions → Network Extensions → Mitmproxy Redirector\n\
                     \n\
                     Or run: npx tapsmith setup-ios"
                );
            }
            SeStatus::NotRegistered => {
                // First-run case: the SE has never been registered. Spawning
                // the launcher will trigger macOS's "System Extension Blocked"
                // approval prompt. If the user dismisses it, our control
                // channel accept will time out with a clear error.
                info!(
                    "Mitmproxy Redirector Network Extension not yet registered — \
                     first launcher run will prompt macOS to register it"
                );
            }
            SeStatus::Unknown => {
                warn!(
                    "Could not determine Mitmproxy Redirector Network Extension \
                     status (systemextensionsctl unavailable or unrecognised \
                     output) — proceeding without fast-fail"
                );
            }
        }

        // Serialise the launch → connect window with every other daemon on
        // this Mac (see `LaunchLock`). On success it is released in the
        // background after the launcher exits plus a grace (below); on an
        // error return it drops with the error.
        let launch_lock = match launch_lock_path() {
            Some(path) => LaunchLock::acquire(&path, LAUNCH_LOCK_TIMEOUT).await,
            None => None,
        };

        info!(
            redirector = %redirector_bin.display(),
            listener = %listener_path.display(),
            serialised = launch_lock.is_some(),
            "spawning redirector launcher"
        );

        // The launcher binary is a short-lived process that tells the SE
        // where to dial, then exits with status 0. Its stdout/stderr are
        // drained in a background task for diagnostics. We do NOT wait for
        // its exit here — we wait for the SE to connect back to our listener,
        // which is the real signal that the session is alive. The handle is
        // tracked so `Drop` can abort it if we're torn down before it exits.
        //
        // `kill_on_drop(true)` ensures the child process dies if the
        // tokio task is aborted (via `IosRedirect::drop`) before the
        // launcher has had a chance to exit on its own — without it,
        // aborting the task would leave the OS-level child process
        // orphaned (visible in `ps` as a stranded "Mitmproxy Redirector").
        let launcher_path = listener_path.clone();
        let (launcher_done_tx, launcher_done_rx) = tokio::sync::oneshot::channel::<()>();
        let launcher_handle = tokio::spawn(async move {
            // Signals (by dropping) when the launcher has exited, for the
            // launch lock's release below.
            let _launcher_done = launcher_done_tx;
            let out = Command::new(&redirector_bin)
                .arg(&launcher_path)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .output()
                .await;
            match out {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    if !stdout.trim().is_empty() {
                        info!("[redirector/stdout] {}", stdout.trim());
                    }
                    if !stderr.trim().is_empty() {
                        info!("[redirector/stderr] {}", stderr.trim());
                    }
                    if !out.status.success() {
                        warn!("redirector launcher exited with {:?}", out.status);
                    } else {
                        debug!("redirector launcher exited cleanly");
                    }
                }
                Err(e) => error!("failed to spawn redirector launcher: {e}"),
            }
        });

        let (control_stream, _) = timeout(CONTROL_CHANNEL_TIMEOUT, listener.accept())
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "Mitmproxy Redirector System Extension did not connect within {}s.\n\
                     \n\
                     Common causes:\n\
                     • A stuck redirector process from a prior Tapsmith session is wedging the SE.\n\
                     • The macOS host is under heavy load (load average > 10).\n\
                     • The SE got into a bad state after a macOS update or long uptime.\n\
                     \n\
                     Quick fixes (in order):\n\
                     \x20\x201. pkill -9 -f 'Mitmproxy Redirector' && rm -f /tmp/tapsmith-redirector-*.sock\n\
                     \x20\x202. Restart tapsmith-core and re-run `tapsmith test`.\n\
                     \x20\x203. If it still times out, reboot macOS.\n\
                     \n\
                     See: docs/ios-network-capture.md#se-control-channel-timeout",
                    CONTROL_CHANNEL_TIMEOUT.as_secs()
                )
            })?
            .context("accepting System Extension control channel")?;
        debug!("System Extension control channel connected");

        let mut control = Framed::new(control_stream, LengthDelimitedCodec::new());
        send_intercept_conf(&mut control, &initial_pids)
            .await
            .context("sending initial InterceptConf")?;
        debug!(pids = initial_pids.len(), "initial InterceptConf accepted");

        // Keep the next daemon's launch out a little longer, without delaying
        // this capture: the extension dials back from inside its provider's
        // start, which may still be finishing, and the stock launcher only
        // leaves a configuration alone once it reports `connected`. A
        // background task holds the lock until this launcher process has
        // exited (bounded) plus a short grace, then releases it. The flow
        // accept loop below starts immediately.
        if let Some(lock) = launch_lock {
            tokio::spawn(async move {
                let _ = timeout(LAUNCHER_EXIT_WAIT, launcher_done_rx).await;
                tokio::time::sleep(LAUNCH_LOCK_GRACE).await;
                drop(lock);
            });
        }

        // Refresh task owns the control channel for the remainder of the
        // session. It polls `ps` every PID_REFRESH_INTERVAL and writes a
        // new InterceptConf iff the PID set has changed.
        let refresh_udid = udid.clone();
        let refresh_handle = tokio::spawn(async move {
            pid_refresh_loop(refresh_udid, control, initial_pids).await;
        });

        // Accept task owns the listener and spawns one per-flow handler
        // task for every intercepted connection from the SE. Each handler's
        // JoinHandle is tracked in `flow_tasks` so Drop can abort them.
        let flow_tasks: FlowTaskList = Arc::new(StdMutex::new(Vec::new()));
        let flow_tasks_for_accept = flow_tasks.clone();
        let accept_handle = tokio::spawn(async move {
            accept_flow_loop(listener, proxy_state, mitm_ca, flow_tasks_for_accept).await;
        });

        Ok(Self {
            accept_handle,
            refresh_handle,
            launcher_handle,
            flow_tasks,
            listener_path,
        })
    }
}

impl Drop for IosRedirect {
    fn drop(&mut self) {
        self.accept_handle.abort();
        self.refresh_handle.abort();
        self.launcher_handle.abort();
        // Abort every in-flight per-flow handler. The lock is held for a
        // short, bounded critical section (no I/O, no `.await`) — Drop is
        // sync and can't await, which is why we use std::sync::Mutex here.
        // `JoinHandle::abort` is non-blocking: it signals the task to stop
        // at its next yield point, then returns immediately.
        if let Ok(mut tasks) = self.flow_tasks.lock() {
            for handle in tasks.drain(..) {
                handle.abort();
            }
        }
        if let Err(e) = std::fs::remove_file(&self.listener_path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                debug!(
                    path = %self.listener_path.display(),
                    "failed to unlink Unix socket on drop: {e}"
                );
            }
        }
    }
}

/// Encode and write an `InterceptConf` with the given PIDs to the SE's
/// control channel. The PIDs are sent as decimal-string actions, which the
/// SE matches exactly against each flow's originating PID.
///
/// Wrapped in [`CONTROL_CHANNEL_WRITE_TIMEOUT`] — a stuck SE (crash,
/// suspension, kernel quirk) must never block the caller indefinitely. The
/// initial send from [`IosRedirect::start`] is on the startup fast path and
/// the refresh-loop send runs every two seconds, so any hang would propagate
/// directly into the test runner.
async fn send_intercept_conf(
    control: &mut Framed<UnixStream, LengthDelimitedCodec>,
    pids: &[u32],
) -> Result<()> {
    let conf = ipc::InterceptConf {
        actions: pids.iter().map(|p| p.to_string()).collect(),
    };
    let bytes = Bytes::from(conf.encode_to_vec());
    match timeout(CONTROL_CHANNEL_WRITE_TIMEOUT, control.send(bytes)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e).context("writing InterceptConf to control channel"),
        Err(_) => bail!(
            "timed out writing InterceptConf to SE control channel after {}s",
            CONTROL_CHANNEL_WRITE_TIMEOUT.as_secs()
        ),
    }
}

/// Loop forever: every [`PID_REFRESH_INTERVAL`], re-resolve the simulator's
/// PID tree and push a new `InterceptConf` if the set has changed.
///
/// Exits when (a) the refresh task is aborted by `IosRedirect::drop`, or
/// (b) the control channel write fails (typically because the SE closed
/// its side, which happens if the whole daemon is tearing down).
async fn pid_refresh_loop(
    udid: String,
    mut control: Framed<UnixStream, LengthDelimitedCodec>,
    initial_pids: Vec<u32>,
) {
    let mut last: HashSet<u32> = initial_pids.into_iter().collect();
    let mut interval = tokio::time::interval(PID_REFRESH_INTERVAL);
    // Delay missed ticks rather than bunching them — a slow `ps` under load
    // shouldn't cause a tight-loop burst of refreshes catching up.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Skip the immediate initial tick — the caller already sent the
    // initial InterceptConf.
    interval.tick().await;

    loop {
        interval.tick().await;
        let pids = match simulator_processes::resolve_simulator_pids(&udid).await {
            Ok(p) => p,
            Err(e) => {
                warn!(%udid, "PID refresh failed: {e}");
                continue;
            }
        };
        let next: HashSet<u32> = pids.iter().copied().collect();
        if next == last {
            continue;
        }
        debug!(
            %udid,
            added = next.difference(&last).count(),
            removed = last.difference(&next).count(),
            total = next.len(),
            "updating InterceptConf"
        );
        // Retry once before giving up. A single transient SE write error
        // (e.g. the SE briefly unscheduled, a dropped IPC byte) used to kill
        // the refresh loop silently — the daemon would still report capture
        // as active, but new test-app PIDs would never enter the filter and
        // their traffic would be invisible. Now we retry, and if both
        // attempts fail we log loud at error! so the user grepping for
        // capture issues finds a clear signal. PILOT-182 review #4 finding S4.
        if let Err(e) = send_intercept_conf(&mut control, &pids).await {
            let first_err = format!("{e:#}");
            warn!(%udid, "InterceptConf update failed (will retry once): {first_err}");
            if let Err(e2) = send_intercept_conf(&mut control, &pids).await {
                error!(
                    %udid,
                    "InterceptConf update failed twice — refresh loop giving up. \
                     iOS network capture will silently miss any test-app PIDs that \
                     spawn after this point. First error: {first_err}. Retry error: {e2:#}"
                );
                return;
            }
            info!(%udid, "InterceptConf update succeeded on retry");
        }
        last = next;
    }
}

/// Loop forever: accept new Unix socket connections from the SE (each is
/// one intercepted flow) and spawn a per-flow handler task. Each spawned
/// handle is tracked in `flow_tasks` so [`IosRedirect::drop`] can abort
/// in-flight handlers during teardown.
///
/// **Transient errors are recoverable.** A single `accept()` failure
/// (typically `ConnectionAborted` if the SE peer closed before accept
/// completed, or `EMFILE`/`ENFILE` under fd pressure) used to bring down
/// the entire capture session — the task exited and no future flow was
/// ever picked up. We now back off briefly and continue, only giving up
/// after [`MAX_CONSECUTIVE_ACCEPT_FAILURES`] failures in a row, which
/// indicates the listener itself is unrecoverable.
///
/// The expected exit path is task-abort by `IosRedirect::drop`; a return
/// from this function only happens for genuinely unrecoverable failures.
async fn accept_flow_loop(
    listener: UnixListener,
    proxy_state: Arc<Mutex<ProxyState>>,
    mitm_ca: Arc<MitmAuthority>,
    flow_tasks: FlowTaskList,
) {
    let mut accepts_since_gc: usize = 0;
    let mut consecutive_failures: u32 = 0;
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                consecutive_failures = 0;
                let state = proxy_state.clone();
                let ca = mitm_ca.clone();
                let handle = tokio::spawn(async move {
                    if let Err(e) = handle_flow(stream, state, ca).await {
                        debug!("flow handler error: {e:#}");
                    }
                });
                if let Ok(mut tasks) = flow_tasks.lock() {
                    tasks.push(handle);
                    // Reap finished handles every 32 accepts so the vec
                    // doesn't grow unbounded under sustained traffic. Cheap:
                    // `is_finished` is a single atomic load per handle, and
                    // the lock is already held on the hot path.
                    accepts_since_gc += 1;
                    if accepts_since_gc >= 32 {
                        tasks.retain(|h| !h.is_finished());
                        accepts_since_gc = 0;
                    }
                }
            }
            Err(e) => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_CONSECUTIVE_ACCEPT_FAILURES {
                    error!(
                        consecutive_failures,
                        "iOS redirect accept loop giving up after repeated failures: {e}"
                    );
                    return;
                }
                warn!("iOS redirect accept failed (will retry): {e}");
                tokio::time::sleep(ACCEPT_BACKOFF).await;
            }
        }
    }
}

/// Decode the length-prefixed `NewFlow` proto handshake from an accepted
/// flow connection, then hand the rest of the stream to the transparent-
/// TCP MITM handler. UDP flows are passed to [`relay_udp_dns`], which relays
/// DNS (port 53) and drops everything else.
async fn handle_flow(
    mut stream: UnixStream,
    proxy_state: Arc<Mutex<ProxyState>>,
    mitm_ca: Arc<MitmAuthority>,
) -> Result<()> {
    // Manual u32_be + read_exact (not Framed::into_inner) — avoids the
    // codec-buffer-leftover hazard. After this, `stream` is positioned
    // exactly at the first TCP byte with nothing buffered. Both reads
    // are bounded by NEW_FLOW_READ_TIMEOUT so a misbehaving SE that
    // dials in but never writes the handshake cannot park this task.
    let len = match timeout(NEW_FLOW_READ_TIMEOUT, stream.read_u32()).await {
        Ok(r) => r.context("reading NewFlow length")? as usize,
        Err(_) => bail!("timed out reading NewFlow length"),
    };
    if len > NEW_FLOW_MAX_LEN {
        bail!("NewFlow handshake too large: {len} bytes");
    }
    let mut buf = vec![0u8; len];
    match timeout(NEW_FLOW_READ_TIMEOUT, stream.read_exact(&mut buf)).await {
        Ok(r) => {
            r.context("reading NewFlow body")?;
        }
        Err(_) => bail!("timed out reading NewFlow body"),
    }
    let new_flow = ipc::NewFlow::decode(&*buf).context("decoding NewFlow")?;

    let Some(msg) = new_flow.message else {
        bail!("NewFlow.message missing oneof");
    };

    match msg {
        ipc::new_flow::Message::Tcp(tcp) => {
            let remote = tcp
                .remote_address
                .context("TcpFlow.remote_address missing")?;
            let tunnel = tcp.tunnel_info.unwrap_or_default();
            debug!(
                host = %remote.host,
                port = remote.port,
                pid = ?tunnel.pid,
                process = ?tunnel.process_name,
                "intercepted TCP flow"
            );
            handle_transparent_tcp(
                stream,
                remote.host,
                remote.port as u16,
                proxy_state,
                mitm_ca,
            )
            .await;
            Ok(())
        }
        ipc::new_flow::Message::Udp(udp) => {
            let tunnel = udp.tunnel_info.unwrap_or_default();
            debug!(
                pid = ?tunnel.pid,
                process = ?tunnel.process_name,
                "intercepted UDP flow"
            );
            relay_udp_dns(stream).await
        }
    }
}

/// Relay an intercepted UDP flow back out to its real destination *iff it is
/// DNS* (remote port 53), dropping every other UDP flow.
///
/// gRPC-Core stacks (Firestore and other gRPC clients) resolve hostnames
/// in-process via c-ares, sending DNS queries straight from the app over
/// UDP/53 rather than through the system resolver. Those datagrams are claimed
/// by the PID-based redirector; if we drop them the lookup times out
/// (`-65568 kDNSServiceErr_Timeout`) and the gRPC channel never connects —
/// even though the subsequent TCP connection would have been MITM'd fine. So
/// for DNS we proxy datagrams to the resolver the app chose and pipe the
/// answers back, restoring resolution while still capturing the TCP traffic.
///
/// All other UDP (notably QUIC on :443) is still dropped: that deliberately
/// forces HTTP/3-capable clients to fall back to TCP/h2, which we *can* MITM.
async fn relay_udp_dns(stream: UnixStream) -> Result<()> {
    let mut framed = Framed::new(stream, LengthDelimitedCodec::new());

    // The remote endpoint is conveyed per-datagram and is constant for the
    // flow (the SE validates consistency), so the first packet decides whether
    // this flow is DNS worth relaying.
    let first = match timeout(UDP_FIRST_PACKET_TIMEOUT, framed.next()).await {
        Ok(Some(Ok(buf))) => ipc::UdpPacket::decode(&*buf).context("decoding first UdpPacket")?,
        Ok(Some(Err(e))) => return Err(e).context("reading first UdpPacket"),
        Ok(None) => return Ok(()), // flow closed before any datagram
        Err(_) => return Ok(()),   // no datagram within the window — let it lapse
    };

    let Some(remote) = first.remote_address.clone() else {
        bail!("UdpPacket missing remote_address");
    };
    if remote.port != 53 {
        debug!(
            host = %remote.host,
            port = remote.port,
            "dropping non-DNS UDP flow (forces TCP fallback)"
        );
        return Ok(());
    }

    // `remote.host` is a numeric literal from the SE; bracket IPv6 so the
    // socket address parses (same hazard as the TCP dial path, PILOT-242).
    let target = join_host_port(&remote.host, remote.port as u16);
    let bind_addr = if remote.host.contains(':') {
        "[::]:0"
    } else {
        "0.0.0.0:0"
    };
    let socket = match UdpSocket::bind(bind_addr).await {
        Ok(s) => s,
        Err(e) => {
            warn!(%target, "failed to bind DNS relay socket: {e}");
            return Ok(());
        }
    };
    if let Err(e) = socket.connect(&target).await {
        warn!(%target, "failed to connect DNS relay socket: {e}");
        return Ok(());
    }
    socket.send(&first.data).await.ok();
    debug!(%target, "relaying DNS UDP flow");

    let mut buf = vec![0u8; UDP_DGRAM_MAX];
    let mut consecutive_recv_errors = 0;
    let mut recv_paused_until: Option<Instant> = None;
    loop {
        let recv_pause_until = recv_paused_until.unwrap_or_else(Instant::now);
        tokio::select! {
            // App → resolver: forward each query datagram verbatim.
            frame = framed.next() => match frame {
                Some(Ok(b)) => {
                    if let Ok(pkt) = ipc::UdpPacket::decode(&*b) {
                        consecutive_recv_errors = 0;
                        recv_paused_until = None;
                        socket.send(&pkt.data).await.ok();
                    }
                }
                _ => break, // flow closed or decode error
            },
            // Back off after transient connected-UDP recv errors without
            // blocking app → resolver datagrams from the same flow.
            _ = tokio::time::sleep_until(recv_pause_until), if recv_paused_until.is_some() => {
                recv_paused_until = None;
            },
            // Resolver → app: wrap each answer back into a UdpPacket.
            recv = socket.recv(&mut buf), if recv_paused_until.is_none() => match recv {
                Ok(n) => {
                    consecutive_recv_errors = 0;
                    recv_paused_until = None;
                    let pkt = ipc::UdpPacket {
                        data: buf[..n].to_vec(),
                        remote_address: Some(remote.clone()),
                    };
                    let mut out = BytesMut::new();
                    if pkt.encode(&mut out).is_err() {
                        break;
                    }
                    if framed.send(out.freeze()).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    consecutive_recv_errors += 1;
                    debug!(
                        %target,
                        error = %e,
                        consecutive_errors = consecutive_recv_errors,
                        "DNS relay socket recv error"
                    );
                    if consecutive_recv_errors >= UDP_RELAY_MAX_RECV_ERRORS {
                        break;
                    }
                    recv_paused_until = Some(Instant::now() + UDP_RELAY_RECV_ERROR_BACKOFF);
                }
            },
            // Idle ceiling — neither side spoke for the timeout window.
            _ = tokio::time::sleep(UDP_RELAY_IDLE_TIMEOUT) => break,
        }
    }
    Ok(())
}

/// Locate the `Mitmproxy Redirector.app` launcher binary via a fallback
/// chain: env override → `/Applications` (mitmproxy unpacked it via sudo) →
/// cached extract under `~/.tapsmith/redirector/` → on-demand extract from
/// the brew cask tarball.
///
/// Returns a clear error with install instructions if none of the above
/// paths yields a usable binary.
fn resolve_redirector_path() -> Result<PathBuf> {
    // 1. Environment override (for CI, dev rigs, vendored bundles).
    if let Ok(env_path) = std::env::var("TAPSMITH_REDIRECTOR_APP") {
        let p = PathBuf::from(env_path);
        if p.exists() {
            return Ok(p);
        }
        warn!(
            path = %p.display(),
            "TAPSMITH_REDIRECTOR_APP set but path does not exist — trying fallbacks"
        );
    }

    // 2. /Applications/Mitmproxy Redirector.app — mitmproxy's own runtime
    //    unpack location (requires prior `sudo mitmproxy --mode local:...`).
    const APP_PATH: &str =
        "/Applications/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector";
    if Path::new(APP_PATH).exists() {
        return Ok(PathBuf::from(APP_PATH));
    }

    // 3. Cached extract from a previous brew-tar extraction.
    let cached = cached_extract_bin()?;
    if cached.exists() {
        return Ok(cached);
    }

    // 4. On-demand extract from the brew cask tarball.
    if let Some(tar_path) = find_brew_tarball() {
        extract_brew_tarball(&tar_path)
            .with_context(|| format!("extracting {}", tar_path.display()))?;
        if cached.exists() {
            return Ok(cached);
        }
    }

    // For the error-message hint only, fall back to a `~/...` placeholder
    // when `home_dir()` returns None — otherwise `unwrap_or_default()` would
    // produce a misleading relative path (`.tapsmith/redirector/...`) that
    // depends on whatever the daemon's cwd happens to be.
    let cache_hint = dirs::home_dir()
        .map(|h| {
            h.join(".tapsmith/redirector/Mitmproxy Redirector.app")
                .display()
                .to_string()
        })
        .unwrap_or_else(|| "~/.tapsmith/redirector/Mitmproxy Redirector.app".to_string());
    bail!(
        "Mitmproxy Redirector.app not found. Tapsmith searched (in order):\n\
         \n\
           1. $TAPSMITH_REDIRECTOR_APP (if set)\n\
           2. /Applications/Mitmproxy Redirector.app\n\
           3. {cache_hint}\n\
           4. The mitmproxy brew cask tarball (not installed?)\n\
         \n\
         Install prerequisites:\n\
           brew install mitmproxy\n\
         Then one of:\n\
           a) `sudo mitmproxy --mode local:Safari` (one-time, unpacks redirector to /Applications/)\n\
           b) Re-run `tapsmith test` — Tapsmith will extract the redirector from the brew cask into {cache_hint}\n\
         \n\
         After the redirector is installed, approve its Network Extension in\n\
         System Settings → General → Login Items & Extensions → Network Extensions,\n\
         then re-run your command.\n\
         \n\
         Or set TAPSMITH_REDIRECTOR_APP to the full path of an existing Mitmproxy Redirector binary."
    )
}

/// Path to the cached extract of the redirector bundle under
/// `~/.tapsmith/redirector/Mitmproxy Redirector.app/...`.
fn cached_extract_bin() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home directory")?;
    Ok(home
        .join(".tapsmith/redirector/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector"))
}

/// Find the `Mitmproxy Redirector.app.tar` shipped inside the mitmproxy
/// brew cask, if present. Supports both Apple Silicon (`/opt/homebrew`)
/// and Intel (`/usr/local`) homebrew prefixes.
fn find_brew_tarball() -> Option<PathBuf> {
    for caskroom in [
        "/opt/homebrew/Caskroom/mitmproxy",
        "/usr/local/Caskroom/mitmproxy",
    ] {
        let caskroom_path = Path::new(caskroom);
        if !caskroom_path.exists() {
            continue;
        }
        let entries = match std::fs::read_dir(caskroom_path) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let tar = entry.path().join(
                "mitmproxy.app/Contents/Resources/mitmproxy_macos/Mitmproxy Redirector.app.tar",
            );
            if tar.exists() {
                return Some(tar);
            }
        }
    }
    None
}

/// Extract the brew-shipped redirector tar into the cache directory. Uses
/// the system `tar` binary (always present on macOS) to preserve the code
/// signature's extended attributes, which a pure-Rust tar crate can't
/// promise out of the box.
///
/// **Concurrency**: multiple tapsmith-core workers may race to extract at
/// startup. We extract to a per-process temporary directory first and then
/// atomically `rename` the `.app` bundle into place. If another worker won
/// the race, our rename fails with EEXIST and we clean up — the winner's
/// content is used by everyone. This avoids a half-written cache under a
/// tar process kill or a racing writer.
fn extract_brew_tarball(tar_path: &Path) -> Result<()> {
    let home = dirs::home_dir().context("no home directory")?;
    let cache_dir = home.join(".tapsmith/redirector");
    let target_app = cache_dir.join("Mitmproxy Redirector.app");

    // Fast path: another worker already extracted before us.
    if target_app.exists() {
        return Ok(());
    }

    std::fs::create_dir_all(&cache_dir)
        .with_context(|| format!("creating {}", cache_dir.display()))?;

    // Extract into a per-process sibling directory. Multiple workers can
    // run simultaneously; their tmp dirs don't collide.
    let tmp_dir = cache_dir.join(format!(".redirector.tmp.{}", std::process::id()));
    if tmp_dir.exists() {
        std::fs::remove_dir_all(&tmp_dir)
            .with_context(|| format!("removing stale {}", tmp_dir.display()))?;
    }
    std::fs::create_dir_all(&tmp_dir).with_context(|| format!("creating {}", tmp_dir.display()))?;

    // Cleanup guard — drop() removes the tmp dir on any early return.
    struct TmpDirGuard<'a>(&'a Path);
    impl Drop for TmpDirGuard<'_> {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0);
        }
    }
    let guard = TmpDirGuard(&tmp_dir);

    let status = std::process::Command::new("tar")
        .arg("-xf")
        .arg(tar_path)
        .arg("-C")
        .arg(&tmp_dir)
        .status()
        .context("running tar")?;
    if !status.success() {
        bail!("tar -xf {} failed with {:?}", tar_path.display(), status);
    }

    let tmp_app = tmp_dir.join("Mitmproxy Redirector.app");
    if !tmp_app.exists() {
        bail!(
            "tar extracted {} but {} was not created",
            tar_path.display(),
            tmp_app.display()
        );
    }

    // Atomic rename into place. On macOS, `rename` over a non-empty
    // directory target fails with `ENOTEMPTY` (not `EEXIST` — that's the
    // file-target case). Either way, if another worker won the race the
    // target now exists and contains the winner's content, so we treat
    // any `Err` whose `target_app.exists()` is true as a successful loss.
    match std::fs::rename(&tmp_app, &target_app) {
        Ok(_) => {
            info!(
                cache = %target_app.display(),
                "extracted Mitmproxy Redirector.app from brew cask tarball"
            );
        }
        Err(_) if target_app.exists() => {
            debug!(
                target = %target_app.display(),
                "another worker extracted the redirector first — using theirs"
            );
        }
        Err(e) => {
            return Err(e).with_context(|| {
                format!("renaming {} to {}", tmp_app.display(), target_app.display())
            });
        }
    }
    drop(guard); // explicit cleanup of any leftover tmp files
    Ok(())
}

#[cfg(test)]
mod launch_lock_tests {
    use super::*;

    #[tokio::test]
    async fn a_second_launch_waits_for_the_first_to_release() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("launch.lock");
        let first = LaunchLock::acquire(&path, Duration::from_secs(1)).await;
        assert!(first.is_some());
        // Held: a second daemon's launch does not get in.
        assert!(LaunchLock::acquire(&path, Duration::from_millis(200))
            .await
            .is_none());
        // Released (the first daemon's extension connected): it does.
        let waiter = {
            let path = path.clone();
            tokio::spawn(async move { LaunchLock::acquire(&path, Duration::from_secs(5)).await })
        };
        tokio::time::sleep(Duration::from_millis(150)).await;
        drop(first);
        assert!(waiter.await.unwrap().is_some());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_owner_pid_from_canonical_args() {
        assert_eq!(
            extract_owner_pid_from_args(
                "/Applications/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector /tmp/tapsmith-redirector-12345.sock"
            ),
            Some(12345)
        );
    }

    #[test]
    fn extract_owner_pid_from_bare_socket_path() {
        // Minimal form — just the socket path on its own.
        assert_eq!(
            extract_owner_pid_from_args("/tmp/tapsmith-redirector-67890.sock"),
            Some(67890)
        );
    }

    #[test]
    fn extract_owner_pid_rejects_unrelated_paths() {
        // A redirector invoked without our socket path shape — don't guess.
        assert_eq!(
            extract_owner_pid_from_args(
                "/Applications/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector"
            ),
            None,
        );
        assert_eq!(
            extract_owner_pid_from_args("/tmp/some-other-socket.sock"),
            None,
        );
        assert_eq!(extract_owner_pid_from_args(""), None);
    }

    #[test]
    fn extract_owner_pid_rejects_non_numeric_suffix() {
        // Defensive: if a future naming scheme has letters in the slot,
        // we must not mis-parse and kill a sibling process.
        assert_eq!(
            extract_owner_pid_from_args("/tmp/tapsmith-redirector-abc.sock"),
            None,
        );
        assert_eq!(
            extract_owner_pid_from_args("/tmp/tapsmith-redirector-.sock"),
            None,
        );
    }

    /// A non-DNS UDP flow (e.g. QUIC on :443) must be dropped, not relayed, so
    /// that HTTP/3-capable clients fall back to TCP/h2 where we can MITM them.
    /// `relay_udp_dns` must therefore return promptly once it sees the first
    /// packet's non-53 destination — never blocking or opening a relay socket.
    #[tokio::test]
    async fn relay_udp_dns_drops_non_dns_flows() {
        let (se, daemon) = UnixStream::pair().unwrap();
        let mut se_framed = Framed::new(se, LengthDelimitedCodec::new());

        let pkt = ipc::UdpPacket {
            data: b"quic-initial".to_vec(),
            remote_address: Some(ipc::Address {
                host: "93.184.216.34".to_string(),
                port: 443,
            }),
        };
        let mut buf = BytesMut::new();
        pkt.encode(&mut buf).unwrap();
        se_framed.send(buf.freeze()).await.unwrap();

        // Well under UDP_FIRST_PACKET_TIMEOUT / UDP_RELAY_IDLE_TIMEOUT: if the
        // port gate were missing the relay would block here instead of returning.
        let res = timeout(Duration::from_secs(2), relay_udp_dns(daemon)).await;
        assert!(
            res.is_ok(),
            "relay should return promptly for a non-DNS flow"
        );
        assert!(res.unwrap().is_ok());
    }

    /// An immediately-closed UDP flow (no datagram ever arrives) must not hang
    /// or error — `relay_udp_dns` should observe the closed stream and return.
    #[tokio::test]
    async fn relay_udp_dns_handles_empty_flow() {
        let (se, daemon) = UnixStream::pair().unwrap();
        drop(se); // SE closes without sending anything

        let res = timeout(Duration::from_secs(2), relay_udp_dns(daemon)).await;
        assert!(
            res.is_ok(),
            "relay should return promptly when the flow closes"
        );
        assert!(res.unwrap().is_ok());
    }
}
