//! Lifetime of the `xcodebuild test-without-building` agent processes this
//! daemon spawns (PILOT-299).
//!
//! An iOS agent is an `xcodebuild` child of the daemon. Nothing used to stop
//! it when the daemon went away, so every session left one behind, reparented
//! to launchd, squatting its simulator for days. Two mechanisms fix that:
//!
//! 1. **In-process registry.** Every agent is registered the moment it is
//!    spawned (not when it becomes ready, so a shutdown during the startup
//!    wait catches it too) and deregistered once it has been reaped. On a
//!    graceful shutdown — SIGTERM, SIGINT, SIGHUP, or the daemon's parent
//!    dying — [`shutdown_all`] stops every registered agent and refuses new
//!    spawns, so a startup loop that sees its xcodebuild exit cannot relaunch
//!    it behind our back.
//! 2. **Owner records + startup reaper.** A daemon that is SIGKILLed runs no
//!    code, so each agent also gets an owner record in
//!    `~/.tapsmith/ios-agents/<pid>.json` naming the agent and the daemon
//!    that started it, each by pid *and* process start time. The next daemon
//!    to start on the machine ([`reap_orphans`]) stops an agent only when its
//!    record says so: the recorded daemon is gone and the recorded process is
//!    still the one we started. An xcodebuild without a record is never
//!    touched — Tapsmith cannot prove it launched it (the PILOT-401 rule).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use tracing::{info, warn};

use crate::process_identity::{own_start_time, process_started};

/// How long an agent gets to exit after SIGTERM before it is SIGKILLed.
/// xcodebuild exits in ~250 ms on SIGTERM (and its in-simulator runner with
/// it); the UI server gives a daemon 5 s between SIGTERM and SIGKILL, so the
/// whole teardown has to fit well inside that.
const TERM_GRACE: Duration = Duration::from_millis(1500);

/// Bound on the `simctl terminate` belt-and-braces step (all simulators run
/// in parallel), so grace + this stays well inside the UI server's 5 s.
const RUNNER_TERMINATE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Bundle id of the XCUITest runner app inside the simulator.
const RUNNER_BUNDLE_ID: &str = "dev.tapsmith.agent.xctrunner";

// ─── Registry ───

#[derive(Debug, Clone)]
struct Entry {
    udid: String,
    is_physical: bool,
}

/// The set of agents a daemon has spawned and not yet reaped.
pub(crate) struct Registry {
    entries: Mutex<HashMap<u32, Entry>>,
    shutting_down: AtomicBool,
    /// Where owner records go; `None` when there is no home directory, which
    /// only costs the SIGKILL-recovery half of the feature.
    records_dir: Option<PathBuf>,
}

impl Registry {
    pub(crate) fn new(records_dir: Option<PathBuf>) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            shutting_down: AtomicBool::new(false),
            records_dir,
        }
    }

    /// True once [`shutdown_all`] has begun: no agent may be (re)started.
    pub(crate) fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    fn insert(&self, pid: u32, entry: Entry) {
        self.entries.lock().unwrap().insert(pid, entry);
    }

    fn remove(&self, pid: u32) {
        self.entries.lock().unwrap().remove(&pid);
    }

    fn snapshot(&self) -> Vec<(u32, Entry)> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .map(|(pid, e)| (*pid, e.clone()))
            .collect()
    }

    fn contains(&self, pid: u32) -> bool {
        self.entries.lock().unwrap().contains_key(&pid)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }

    fn record_path(&self, pid: u32) -> Option<PathBuf> {
        self.records_dir
            .as_ref()
            .map(|d| d.join(format!("{pid}.json")))
    }
}

fn records_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".tapsmith").join("ios-agents"))
}

/// The daemon-wide registry.
pub(crate) fn global() -> &'static Registry {
    static GLOBAL: OnceLock<Registry> = OnceLock::new();
    GLOBAL.get_or_init(|| Registry::new(records_dir()))
}

/// A spawned agent process, registered for as long as it is alive.
///
/// Reaping it (`try_wait`/`wait`/`kill`) deregisters it and deletes its owner
/// record. Dropping it while the process still runs — an RPC cancelled
/// mid-boot drops the startup future — does not kill it: the boot carries on,
/// as it always has, and a background waiter keeps it registered until it
/// exits, so shutdown still stops it. Only once shutdown has begun (or the
/// runtime is gone) does a drop let the spawning `Command`'s `kill_on_drop`
/// stop the process.
pub(crate) struct TrackedAgent {
    /// Always `Some` until `Drop` hands it to the background waiter.
    child: Option<Child>,
    pid: Option<u32>,
    registry: &'static Registry,
    /// False for the background waiter itself, so a drop there (the runtime
    /// tearing its tasks down) can never spawn another waiter.
    rehome_on_drop: bool,
    /// (udid, is_physical) while the owner record has not been written yet,
    /// so a waiter that inherits a cancelled `track` can still write it.
    pending_record: Option<(String, bool)>,
}

impl TrackedAgent {
    /// Register `child` (spawned for `udid`) and write its owner record.
    /// Refuses — killing the child — once the daemon is shutting down, so a
    /// startup loop cannot relaunch an agent the teardown just stopped.
    pub(crate) async fn track(
        child: Child,
        udid: &str,
        is_physical: bool,
        registry: &'static Registry,
    ) -> Result<Self> {
        let pid = child.id();
        if let Some(pid) = pid {
            registry.insert(
                pid,
                Entry {
                    udid: udid.to_string(),
                    is_physical,
                },
            );
        }
        // The guard exists before the first await, so a caller cancelled
        // mid-track (a dropped RPC future) leaves the agent tracked: `Drop`
        // hands it to a background waiter, which also writes the owner record
        // the cancelled track did not get to.
        let mut agent = Self {
            child: Some(child),
            pid,
            registry,
            rehome_on_drop: true,
            pending_record: Some((udid.to_string(), is_physical)),
        };
        // Checked after inserting, so a concurrent `shutdown_all` either sees
        // the entry or we see its flag: an agent can never slip between them.
        if registry.shutting_down.load(Ordering::SeqCst) {
            let _ = agent.kill().await;
            bail!("the daemon is shutting down; not starting an iOS agent");
        }
        if let (Some(pid), Some(path)) = (pid, pid.and_then(|p| registry.record_path(p))) {
            write_record(&path, pid, udid, is_physical).await;
        }
        agent.pending_record = None;
        Ok(agent)
    }

    /// `Child::try_wait`, deregistering the agent as soon as it is reaped:
    /// from then on its pid is free for reuse and must never be signalled.
    pub(crate) fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let status = self.child_mut().try_wait();
        if let Ok(Some(_)) = status {
            self.release();
        }
        status
    }

    /// `Child::kill` (which also reaps), then deregister.
    pub(crate) async fn kill(&mut self) -> std::io::Result<()> {
        let result = self.child_mut().kill().await;
        self.release();
        result
    }

    /// `Child::wait`, then deregister.
    pub(crate) async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let status = self.child_mut().wait().await;
        if status.is_ok() {
            self.release();
        }
        status
    }

    fn child_mut(&mut self) -> &mut Child {
        self.child
            .as_mut()
            .expect("TrackedAgent child is only taken in Drop")
    }

    fn release(&mut self) {
        if let Some(pid) = self.pid.take() {
            self.registry.remove(pid);
            if let Some(path) = self.registry.record_path(pid) {
                // Synchronous on purpose: Drop cannot await, and this is one
                // small unlink.
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

impl Drop for TrackedAgent {
    fn drop(&mut self) {
        // Still running and not yet reaped: keep tracking it rather than
        // killing a boot that a retried RPC may yet adopt.
        if self.rehome_on_drop
            && self.pid.is_some()
            && !self.registry.shutting_down.load(Ordering::SeqCst)
        {
            if let (Some(child), Ok(runtime)) =
                (self.child.take(), tokio::runtime::Handle::try_current())
            {
                let mut waiter = TrackedAgent {
                    child: Some(child),
                    pid: self.pid.take(),
                    registry: self.registry,
                    rehome_on_drop: false,
                    pending_record: None,
                };
                let pending = self.pending_record.take();
                runtime.spawn(async move {
                    if let (Some((udid, is_physical)), Some(pid)) = (pending, waiter.pid) {
                        if let Some(path) = waiter.registry.record_path(pid) {
                            write_record(&path, pid, &udid, is_physical).await;
                        }
                    }
                    let _ = waiter.wait().await;
                });
                return;
            }
        }
        self.release();
    }
}

// ─── Graceful shutdown ───

/// Stop every agent this daemon spawned, and refuse to spawn more.
///
/// SIGTERM first (xcodebuild then tears down its in-simulator runner itself),
/// SIGKILL whatever is still registered after [`TERM_GRACE`], then
/// `simctl terminate` the runner on each simulator whose xcodebuild had to be
/// SIGKILLed, in case the runner outlived it. Agents deregister the moment they are reaped, so a pid that is
/// still registered is still ours; the only gap is the instant between
/// `waitpid` returning and the deregistration that immediately follows it.
pub async fn shutdown_all() {
    shutdown_registry(global(), TERM_GRACE, terminate_runner).await;
}

async fn shutdown_registry<F, Fut>(registry: &Registry, grace: Duration, terminate_runner: F)
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    registry.shutting_down.store(true, Ordering::SeqCst);
    let agents = registry.snapshot();
    if agents.is_empty() {
        return;
    }
    info!(count = agents.len(), "Stopping iOS agents before exit");

    // "Still running" is asked of the process itself, not of the registry:
    // an agent deregisters only when its holder next polls it, which a
    // startup loop stuck in a ping may not do for seconds.
    let running = |pid: u32| registry.contains(pid) && !has_exited(pid);
    for (pid, _) in &agents {
        if running(*pid) {
            signal(*pid, libc::SIGTERM);
        }
    }
    let deadline = tokio::time::Instant::now() + grace;
    while agents.iter().any(|(pid, _)| running(*pid)) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Runners of agents that exited on SIGTERM went with their xcodebuild;
    // only a SIGKILLed one may have left its runner behind. Terminating a
    // runner is udid-wide, so it is kept to the cases that need it — a
    // replacement daemon may already be starting an agent on that simulator.
    let mut sims: Vec<String> = Vec::new();
    for (pid, entry) in &agents {
        if running(*pid) {
            warn!(pid, udid = %entry.udid, "iOS agent ignored SIGTERM; killing it");
            signal(*pid, libc::SIGKILL);
            if !entry.is_physical {
                sims.push(entry.udid.clone());
            }
        }
    }
    sims.sort();
    sims.dedup();
    let mut terminations = tokio::task::JoinSet::new();
    for udid in sims {
        terminations.spawn(terminate_runner(udid));
    }
    while terminations.join_next().await.is_some() {}
}

/// Whether our child `pid` has exited, without reaping it (`WNOWAIT`), so
/// its holder still collects it and the pid cannot be reused in between.
/// A pid that is no longer our child (already reaped) counts as exited:
/// there is nothing left to signal.
fn has_exited(pid: u32) -> bool {
    // id_t is u32 on macOS and Linux.
    let id: libc::id_t = pid;
    // SAFETY: waitid only writes into `info`; WNOWAIT leaves the child
    // waitable by its owner.
    unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        let rc = libc::waitid(
            libc::P_PID,
            id,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        );
        if rc != 0 {
            // ECHILD: already reaped (or not ours) — nothing left to signal.
            // Anything else (EINTR, in theory): assume it is still running.
            return std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD);
        }
        // With WNOHANG, si_pid stays 0 while the child is still running.
        #[cfg(target_os = "linux")]
        let exited_pid = info.si_pid();
        #[cfg(not(target_os = "linux"))]
        let exited_pid = info.si_pid;
        exited_pid != 0
    }
}

fn signal(pid: u32, sig: libc::c_int) {
    let Ok(pid) = i32::try_from(pid) else {
        return;
    };
    // SAFETY: plain kill(2); callers only pass pids they have proven are the
    // process they mean (registered and unreaped, or start-time matched).
    unsafe {
        libc::kill(pid, sig);
    }
}

async fn terminate_runner(udid: String) {
    let _ = super::device::bounded_output(
        "simctl terminate xctrunner",
        Command::new("xcrun").args(["simctl", "terminate", &udid, RUNNER_BUNDLE_ID]),
        RUNNER_TERMINATE_TIMEOUT,
    )
    .await;
}

// ─── Owner records ───

/// Contents of `~/.tapsmith/ios-agents/<pid>.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct OwnerRecord {
    pub pid: u32,
    /// The agent's process start time (`ps -o lstart=`), so a reused pid is
    /// never mistaken for it. `None` if `ps` failed at spawn time; such a
    /// record can never prove anything, so it is only ever discarded.
    pub started: Option<String>,
    pub udid: String,
    pub is_physical: bool,
    pub daemon_pid: u32,
    pub daemon_started: Option<String>,
}

async fn write_record(path: &Path, pid: u32, udid: &str, is_physical: bool) {
    let record = OwnerRecord {
        pid,
        started: process_started(pid).await,
        udid: udid.to_string(),
        is_physical,
        daemon_pid: std::process::id(),
        daemon_started: own_start_time().await,
    };
    let result = async {
        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        // Written aside and renamed into place, so a reaper in another daemon
        // never reads a half-written record (and discards it as corrupt).
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, serde_json::to_vec(&record)?).await?;
        if let Err(e) = tokio::fs::rename(&tmp, path).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e.into());
        }
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        warn!(path = %path.display(), "Could not write the iOS agent owner record ({e:#}); \
               if this daemon is killed, the agent will not be cleaned up automatically");
    }
}

// ─── Startup reaper ───

#[cfg(any(target_os = "macos", test))]
/// What a host process looks like now, for a record's pid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Probe {
    /// No process with that pid.
    Gone,
    /// A process exists; its start time and command name, when `ps` could read them.
    Running {
        started: Option<String>,
        comm: Option<String>,
    },
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// Leave the record: its daemon is alive and owns the agent, or the
    /// agent's identity could not be read this time.
    Keep,
    /// The daemon is gone and the agent is still the process it started.
    Reap,
    /// Nothing to stop (agent gone, pid reused, unprovable record): delete it.
    Discard,
}

#[cfg(any(target_os = "macos", test))]
/// Decide what to do with one owner record. Pure, so every branch is tested.
pub(crate) fn judge(record: &OwnerRecord, daemon: &Probe, agent: &Probe) -> Verdict {
    let daemon_alive = match daemon {
        Probe::Gone => false,
        // A live daemon is proven by its start time. Without one on either
        // side, fall back to the process name, and if that is unreadable too
        // assume the daemon is alive rather than kill a live session's agent.
        Probe::Running { started, comm } => match (&record.daemon_started, started) {
            (Some(want), Some(have)) => want == have,
            _ => comm.as_deref().is_none_or(|c| c.contains("tapsmith")),
        },
    };
    if daemon_alive {
        return Verdict::Keep;
    }
    match agent {
        Probe::Gone => Verdict::Discard,
        Probe::Running { started, comm } => match (&record.started, started, comm) {
            // Written without a start time: can never prove anything.
            (None, _, _) => Verdict::Discard,
            // `ps` failed just now: keep the record so a later start can
            // still prove it, rather than throwing away the only evidence.
            (Some(_), None, _) | (Some(_), Some(_), None) => Verdict::Keep,
            (Some(want), Some(have), Some(comm)) => {
                if want == have && comm.contains("xcodebuild") {
                    Verdict::Reap
                } else {
                    // The pid now belongs to another process.
                    Verdict::Discard
                }
            }
        },
    }
}

#[cfg(any(target_os = "macos", test))]
/// Host operations the reaper needs, injectable for tests.
#[async_trait::async_trait]
pub(crate) trait ReapHost: Send + Sync {
    async fn probe(&self, pid: u32) -> Probe;
    /// Stop an orphaned agent (only that pid): SIGTERM, then SIGKILL if it is
    /// still the same process.
    async fn stop(&self, record: &OwnerRecord);
}

#[cfg(any(target_os = "macos", test))]
struct RealHost;

#[cfg(any(target_os = "macos", test))]
#[async_trait::async_trait]
impl ReapHost for RealHost {
    async fn probe(&self, pid: u32) -> Probe {
        let Ok(pid_i) = i32::try_from(pid) else {
            return Probe::Gone;
        };
        // SAFETY: signal 0 only checks for existence/permission.
        let exists = unsafe { libc::kill(pid_i, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if !exists {
            return Probe::Gone;
        }
        let comm = super::device::bounded_output(
            "ps comm",
            Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "comm="]),
            Duration::from_secs(5),
        )
        .await
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
        Probe::Running {
            started: process_started(pid).await,
            comm,
        }
    }

    async fn stop(&self, record: &OwnerRecord) {
        signal(record.pid, libc::SIGTERM);
        let deadline = tokio::time::Instant::now() + TERM_GRACE;
        while tokio::time::Instant::now() < deadline {
            if self.probe(record.pid).await == Probe::Gone {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // Re-prove identity before escalating: the pid could have been reused
        // in the grace window.
        if let Probe::Running { started, .. } = self.probe(record.pid).await {
            if started.is_some() && started == record.started {
                signal(record.pid, libc::SIGKILL);
            }
        }
        // Deliberately no `simctl terminate` here: the in-simulator runner
        // exits with its xcodebuild, and a udid-wide terminate is not proven
        // ours — another daemon may already have started an agent there.
    }
}

#[cfg(any(target_os = "macos", test))]
/// Stop agents left behind by a daemon that was killed without running its
/// teardown. A no-op without owner records.
///
/// Runs once per daemon: started in the background at startup, and awaited
/// by every agent start, so the reaper can never kill an orphan that a new
/// session has just adopted through the "agent already answers" fast path.
pub async fn reap_orphans() {
    static REAPED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    REAPED
        .get_or_init(|| async {
            if let Some(dir) = records_dir() {
                reap_in(&dir, &RealHost).await;
            }
        })
        .await;
}

#[cfg(any(target_os = "macos", test))]
pub(crate) async fn reap_in(dir: &Path, host: &dyn ReapHost) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let record: Option<OwnerRecord> = tokio::fs::read(&path)
            .await
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        let Some(record) = record else {
            tracing::debug!(path = %path.display(), "Discarding unreadable iOS agent owner record");
            let _ = tokio::fs::remove_file(&path).await;
            continue;
        };
        let daemon = host.probe(record.daemon_pid).await;
        let agent = host.probe(record.pid).await;
        match judge(&record, &daemon, &agent) {
            Verdict::Keep => {}
            Verdict::Reap => {
                info!(
                    pid = record.pid,
                    udid = %record.udid,
                    daemon_pid = record.daemon_pid,
                    "Stopping an iOS agent orphaned by a daemon that was killed"
                );
                host.stop(&record).await;
                let _ = tokio::fs::remove_file(&path).await;
            }
            Verdict::Discard => {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn leaked(dir: Option<PathBuf>) -> &'static Registry {
        Box::leak(Box::new(Registry::new(dir)))
    }

    fn spawn(script: &str) -> Child {
        Command::new("/bin/sh")
            .args(["-c", script])
            .kill_on_drop(true)
            .spawn()
            .expect("spawn /bin/sh")
    }

    /// Move a tracked agent into a reaper task, as `start_agent_impl` does
    /// on success.
    fn hand_to_reaper(mut agent: TrackedAgent) {
        tokio::spawn(async move {
            let _ = agent.wait().await;
        });
    }

    /// The registry's size once a reaper task has had the chance to
    /// deregister an agent that exited. `shutdown_registry` returns as soon
    /// as the process has exited; the reaper deregisters it when its wait
    /// wakes, which on a loaded runner can be a few scheduler turns later.
    async fn len_after_reapers(registry: &Registry) -> usize {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while registry.len() > 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        registry.len()
    }

    fn alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    type Calls = Arc<Mutex<Vec<String>>>;

    fn recording_terminator(calls: &Calls) -> impl Fn(String) -> std::future::Ready<()> {
        let calls = calls.clone();
        move |udid| {
            calls.lock().unwrap().push(udid);
            std::future::ready(())
        }
    }

    #[tokio::test]
    async fn tracking_registers_and_dropping_after_reap_deregisters() {
        let registry = leaked(None);
        let mut agent = TrackedAgent::track(spawn("exit 0"), "SIM-A", false, registry)
            .await
            .unwrap();
        assert_eq!(registry.len(), 1);
        // Polled the way the startup loop does: deregistered the moment it
        // is reaped, while the guard is still held.
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while agent.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(registry.len(), 0);
        drop(agent);
        assert_eq!(registry.len(), 0);
    }

    #[tokio::test]
    async fn shutdown_stops_a_running_agent_with_sigterm() {
        let registry = leaked(None);
        let agent = TrackedAgent::track(spawn("sleep 60"), "SIM-A", false, registry)
            .await
            .unwrap();
        let pid = agent.pid.unwrap();
        hand_to_reaper(agent);
        let calls: Calls = Arc::default();
        let started = std::time::Instant::now();
        shutdown_registry(
            registry,
            Duration::from_secs(5),
            recording_terminator(&calls),
        )
        .await;
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "SIGTERM should be enough"
        );
        assert_eq!(len_after_reapers(registry).await, 0);
        assert!(!alive(pid));
        // Its runner went with it: no udid-wide terminate needed.
        assert!(calls.lock().unwrap().is_empty());
    }

    /// A child that ignores SIGTERM.
    const STUBBORN: &str = "trap '' TERM; while :; do sleep 1; done";

    #[tokio::test]
    async fn an_agent_nobody_is_polling_is_not_mistaken_for_one_that_ignored_sigterm() {
        // The startup loop may be stuck in a ping and not reap its agent for
        // seconds: the agent exits on SIGTERM all the same, so no SIGKILL
        // and no udid-wide runner terminate.
        let registry = leaked(None);
        let mut agent = TrackedAgent::track(spawn("sleep 60"), "SIM-A", false, registry)
            .await
            .unwrap();
        let calls: Calls = Arc::default();
        let started = std::time::Instant::now();
        shutdown_registry(
            registry,
            Duration::from_secs(3),
            recording_terminator(&calls),
        )
        .await;
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "should not wait out the grace for an agent that already exited"
        );
        assert!(calls.lock().unwrap().is_empty());
        // Its holder still reaps it normally.
        assert!(agent.wait().await.is_ok());
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn has_exited_tells_a_running_child_from_an_exited_one_without_reaping_it() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let pid = child.id();
        assert!(!has_exited(pid));
        child.kill().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !has_exited(pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(has_exited(pid));
        // Not reaped by the probe: the owner can still wait for it.
        assert!(child.try_wait().unwrap().is_some());
        // And once reaped, it is still "exited".
        assert!(has_exited(pid));
    }

    #[tokio::test]
    async fn shutdown_kills_an_agent_that_ignores_sigterm() {
        let registry = leaked(None);
        // The pid we hold is the TERM-ignoring shell itself.
        let agent = TrackedAgent::track(
            spawn("trap '' TERM; while :; do sleep 1; done"),
            "SIM-A",
            false,
            registry,
        )
        .await
        .unwrap();
        let pid = agent.pid.unwrap();
        hand_to_reaper(agent);
        // Let the shell install its trap before we signal it.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let calls: Calls = Arc::default();
        shutdown_registry(
            registry,
            Duration::from_millis(300),
            recording_terminator(&calls),
        )
        .await;
        // SIGKILL is asynchronous with respect to our reaper task.
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while registry.len() > 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(registry.len(), 0, "SIGKILLed agent should be reaped");
        assert!(!alive(pid));
    }

    #[tokio::test]
    async fn shutdown_terminates_each_killed_simulator_runner_once_and_skips_physical() {
        let registry = leaked(None);
        // SIM-C's agent exits on SIGTERM; the rest ignore it and are killed.
        for (udid, physical, script) in [
            ("SIM-A", false, STUBBORN),
            ("SIM-A", false, STUBBORN),
            ("PHONE", true, STUBBORN),
            ("SIM-B", false, STUBBORN),
            ("SIM-C", false, "sleep 60"),
        ] {
            let agent = TrackedAgent::track(spawn(script), udid, physical, registry)
                .await
                .unwrap();
            hand_to_reaper(agent);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let calls: Calls = Arc::default();
        shutdown_registry(
            registry,
            Duration::from_millis(500),
            recording_terminator(&calls),
        )
        .await;
        assert_eq!(
            *calls.lock().unwrap(),
            vec!["SIM-A".to_string(), "SIM-B".to_string()]
        );
    }

    #[tokio::test]
    async fn no_agent_can_be_started_once_shutdown_has_begun() {
        // A startup loop whose xcodebuild exits during teardown must not
        // relaunch it.
        let registry = leaked(None);
        let calls: Calls = Arc::default();
        shutdown_registry(
            registry,
            Duration::from_secs(1),
            recording_terminator(&calls),
        )
        .await;
        let child = spawn("sleep 60");
        let pid = child.id().unwrap();
        assert!(registry.is_shutting_down());
        let err = TrackedAgent::track(child, "SIM-A", false, registry)
            .await
            .err()
            .expect("track must refuse during shutdown");
        assert!(err.to_string().contains("shutting down"), "{err}");
        assert_eq!(registry.len(), 0);
        assert!(!alive(pid), "the refused child must be killed");
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn dropping_a_running_agent_keeps_it_running_and_tracked() {
        // An RPC cancelled mid-boot drops the startup future: the boot must
        // carry on (a retry may adopt it), and shutdown must still stop it.
        let dir = tempfile::tempdir().unwrap();
        let registry = leaked(Some(dir.path().to_path_buf()));
        let agent = TrackedAgent::track(spawn("sleep 60"), "SIM-A", false, registry)
            .await
            .unwrap();
        let pid = agent.pid.unwrap();
        drop(agent);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(alive(pid), "a dropped guard must not kill the boot");
        assert_eq!(registry.len(), 1);
        assert!(dir.path().join(format!("{pid}.json")).exists());
        let calls: Calls = Arc::default();
        shutdown_registry(
            registry,
            Duration::from_secs(5),
            recording_terminator(&calls),
        )
        .await;
        assert_eq!(len_after_reapers(registry).await, 0);
        assert!(!alive(pid));
        assert!(!dir.path().join(format!("{pid}.json")).exists());
    }

    #[tokio::test]
    async fn a_track_cancelled_mid_way_stays_tracked_until_it_exits() {
        // With a records dir, track awaits `ps` for the owner record.
        let dir = tempfile::tempdir().unwrap();
        let registry = leaked(Some(dir.path().to_path_buf()));
        let child = spawn("sleep 60");
        let pid = child.id().unwrap();
        // Drop the track future at that await, as a cancelled RPC would.
        let fut = TrackedAgent::track(child, "SIM-A", false, registry);
        let outcome = tokio::time::timeout(Duration::from_nanos(1), fut).await;
        assert!(outcome.is_err(), "track must still have been pending");
        // Still tracked (so shutdown would stop it)…
        assert_eq!(registry.len(), 1);
        assert!(alive(pid));
        // …with the owner record the cancelled track never wrote…
        let record = dir.path().join(format!("{pid}.json"));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !record.exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            record.exists(),
            "the waiter writes the missing owner record"
        );
        // …and deregistered, not left behind as a dead pid, once it exits.
        signal(pid, libc::SIGKILL);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while registry.len() > 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(registry.len(), 0);
    }

    #[tokio::test]
    async fn owner_record_lives_exactly_as_long_as_the_agent() {
        let dir = tempfile::tempdir().unwrap();
        let registry = leaked(Some(dir.path().to_path_buf()));
        let mut agent = TrackedAgent::track(spawn("sleep 60"), "SIM-A", false, registry)
            .await
            .unwrap();
        let pid = agent.pid.unwrap();
        let path = dir.path().join(format!("{pid}.json"));
        let record: OwnerRecord =
            serde_json::from_slice(&std::fs::read(&path).expect("record written")).unwrap();
        assert_eq!(record.pid, pid);
        assert_eq!(record.udid, "SIM-A");
        assert!(!record.is_physical);
        assert_eq!(record.daemon_pid, std::process::id());
        assert!(record.started.is_some(), "agent start time recorded");
        assert!(
            record.daemon_started.is_some(),
            "daemon start time recorded"
        );
        agent.kill().await.unwrap();
        assert!(!path.exists(), "record removed once the agent is reaped");
        assert_eq!(registry.len(), 0);
        drop(agent);
    }

    #[tokio::test]
    async fn an_unwritable_records_dir_does_not_stop_the_agent_starting() {
        let file = tempfile::NamedTempFile::new().unwrap();
        // A regular file where the directory should be.
        let registry = leaked(Some(file.path().join("ios-agents")));
        let mut agent = TrackedAgent::track(spawn("sleep 60"), "SIM-A", false, registry)
            .await
            .unwrap();
        assert_eq!(registry.len(), 1);
        agent.kill().await.unwrap();
    }

    // ─── judge ───

    fn record() -> OwnerRecord {
        OwnerRecord {
            pid: 100,
            started: Some("Fri Oct  2 09:00:00 2026".into()),
            udid: "SIM-A".into(),
            is_physical: false,
            daemon_pid: 50,
            daemon_started: Some("Fri Oct  2 08:59:00 2026".into()),
        }
    }

    fn running(started: &str, comm: &str) -> Probe {
        Probe::Running {
            started: Some(started.into()),
            comm: Some(comm.into()),
        }
    }

    const AGENT_START: &str = "Fri Oct  2 09:00:00 2026";
    const DAEMON_START: &str = "Fri Oct  2 08:59:00 2026";
    const XCODEBUILD: &str = "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild";

    #[test]
    fn a_live_daemon_keeps_its_agent() {
        let v = judge(
            &record(),
            &running(DAEMON_START, "tapsmith-core"),
            &running(AGENT_START, XCODEBUILD),
        );
        assert_eq!(v, Verdict::Keep);
    }

    #[test]
    fn a_daemon_whose_start_time_ps_cannot_read_is_presumed_alive() {
        let daemon = Probe::Running {
            started: None,
            comm: None,
        };
        let v = judge(&record(), &daemon, &running(AGENT_START, XCODEBUILD));
        assert_eq!(v, Verdict::Keep);
    }

    #[test]
    fn without_a_daemon_start_time_the_process_name_decides() {
        let mut r = record();
        r.daemon_started = None;
        let agent = running(AGENT_START, XCODEBUILD);
        let tapsmith = running(DAEMON_START, "/usr/local/bin/tapsmith-core");
        assert_eq!(judge(&r, &tapsmith, &agent), Verdict::Keep);
        // The daemon pid now belongs to something else: the orphan is reaped.
        let other = running(
            DAEMON_START,
            "/Applications/Safari.app/Contents/MacOS/Safari",
        );
        assert_eq!(judge(&r, &other, &agent), Verdict::Reap);
    }

    #[test]
    fn an_orphan_of_a_dead_daemon_is_reaped() {
        let v = judge(&record(), &Probe::Gone, &running(AGENT_START, XCODEBUILD));
        assert_eq!(v, Verdict::Reap);
    }

    #[test]
    fn a_reused_daemon_pid_does_not_protect_the_orphan() {
        let v = judge(
            &record(),
            &running("Fri Oct  2 11:00:00 2026", "Safari"),
            &running(AGENT_START, XCODEBUILD),
        );
        assert_eq!(v, Verdict::Reap);
    }

    #[test]
    fn a_reused_agent_pid_is_never_killed() {
        let v = judge(
            &record(),
            &Probe::Gone,
            &running("Fri Oct  2 11:00:00 2026", XCODEBUILD),
        );
        assert_eq!(v, Verdict::Discard);
    }

    #[test]
    fn a_process_that_is_not_xcodebuild_is_never_killed() {
        let v = judge(
            &record(),
            &Probe::Gone,
            &running(AGENT_START, "/usr/bin/vim"),
        );
        assert_eq!(v, Verdict::Discard);
    }

    #[test]
    fn an_agent_whose_identity_cannot_be_proven_is_never_killed() {
        let mut r = record();
        r.started = None;
        assert_eq!(
            judge(&r, &Probe::Gone, &running(AGENT_START, XCODEBUILD)),
            Verdict::Discard
        );
    }

    #[test]
    fn an_agent_ps_cannot_read_right_now_keeps_its_record_for_next_time() {
        let unreadable_start = Probe::Running {
            started: None,
            comm: Some(XCODEBUILD.into()),
        };
        assert_eq!(
            judge(&record(), &Probe::Gone, &unreadable_start),
            Verdict::Keep
        );
        let unreadable_comm = Probe::Running {
            started: Some(AGENT_START.into()),
            comm: None,
        };
        assert_eq!(
            judge(&record(), &Probe::Gone, &unreadable_comm),
            Verdict::Keep
        );
    }

    #[test]
    fn a_finished_agent_just_loses_its_record() {
        assert_eq!(
            judge(&record(), &Probe::Gone, &Probe::Gone),
            Verdict::Discard
        );
    }

    // ─── reap_in ───

    #[derive(Default)]
    struct FakeHost {
        procs: HashMap<u32, Probe>,
        stopped: Mutex<Vec<u32>>,
    }

    #[async_trait::async_trait]
    impl ReapHost for FakeHost {
        async fn probe(&self, pid: u32) -> Probe {
            self.procs.get(&pid).cloned().unwrap_or(Probe::Gone)
        }
        async fn stop(&self, record: &OwnerRecord) {
            self.stopped.lock().unwrap().push(record.pid);
        }
    }

    fn write(dir: &Path, name: &str, body: &[u8]) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    #[tokio::test]
    async fn reaper_stops_only_proven_orphans_and_keeps_live_sessions_records() {
        let dir = tempfile::tempdir().unwrap();
        // 100: orphan of dead daemon 50 → reaped.
        let orphan = write(
            dir.path(),
            "100.json",
            &serde_json::to_vec(&record()).unwrap(),
        );
        // 200: agent of live daemon 60 → kept, record untouched.
        let mut live = record();
        live.pid = 200;
        live.daemon_pid = 60;
        let live_path = write(dir.path(), "200.json", &serde_json::to_vec(&live).unwrap());
        // 300: agent already gone → record discarded.
        let mut gone = record();
        gone.pid = 300;
        let gone_path = write(dir.path(), "300.json", &serde_json::to_vec(&gone).unwrap());
        // Corrupt record → discarded, nothing stopped.
        let corrupt = write(dir.path(), "400.json", b"{not json");
        // Not a record → ignored.
        let other = write(dir.path(), "notes.txt", b"hello");

        let mut host = FakeHost::default();
        host.procs.insert(100, running(AGENT_START, XCODEBUILD));
        host.procs.insert(200, running(AGENT_START, XCODEBUILD));
        host.procs
            .insert(60, running(DAEMON_START, "tapsmith-core"));
        reap_in(dir.path(), &host).await;

        assert_eq!(*host.stopped.lock().unwrap(), vec![100]);
        assert!(!orphan.exists());
        assert!(live_path.exists());
        assert!(!gone_path.exists());
        assert!(!corrupt.exists());
        assert!(other.exists());
    }

    #[tokio::test]
    async fn reaper_is_a_no_op_without_a_records_dir() {
        let dir = tempfile::tempdir().unwrap();
        let host = FakeHost::default();
        reap_in(&dir.path().join("missing"), &host).await;
        assert!(host.stopped.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn real_host_stops_a_recorded_orphan() {
        // End to end against a real process: write the record the way a
        // daemon would, pretend that daemon died, and reap.
        let dir = tempfile::tempdir().unwrap();
        let mut child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let pid = child.id().unwrap();
        let mut r = record();
        r.pid = pid;
        r.started = process_started(pid).await;
        r.is_physical = true; // no simctl in unit tests
        r.daemon_pid = u32::MAX - 1; // no such process
                                     // `sleep` is not xcodebuild, so the real judge must refuse it…
        write(dir.path(), "a.json", &serde_json::to_vec(&r).unwrap());
        reap_in(dir.path(), &RealHost).await;
        assert!(
            child.try_wait().unwrap().is_none(),
            "non-xcodebuild must survive"
        );
        // …while RealHost::stop itself does stop a proven process.
        RealHost.stop(&r).await;
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("stopped")
            .unwrap();
        assert!(!status.success());
    }
}
