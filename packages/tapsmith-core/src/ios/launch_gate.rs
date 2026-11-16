//! The launch gate: how a cold simulator agent start launches the app under
//! test once, from wiped data, instead of launching it and then having the
//! session's startup reset clear and relaunch it.
//!
//! The daemon passes the runner a host file path (a simulator process reads
//! host paths). While xcodebuild starts — seconds before the runner's test
//! method runs — a task terminates the app and, when asked, wipes its data,
//! then creates the file. The runner waits for the file, deletes it as its
//! acknowledgement, and only then launches the app.
//!
//! The daemon vouches for that launch ([`app_launched_fresh`]) only when every
//! step is known to have happened in that order. Anything else — an agent
//! built before the gate (it never deletes the file), a runner that gave up
//! waiting, a wipe that failed, an in-place xcodebuild relaunch — answers
//! "not fresh", and the caller clears and relaunches the app as before.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// The runner reads the gate path from this xctestrun environment variable.
pub const LAUNCH_GATE_ENV: &str = "TAPSMITH_LAUNCH_GATE";

/// How long the daemon's terminate + wipe may take before the gate opens
/// anyway (the launch is then not vouched for). Must stay below the runner's
/// own wait (`LaunchGate.defaultTimeout`, 30 s in the agent), which starts
/// later, so the runner never launches into a wipe still in progress.
pub const PREPARE_DEADLINE: Duration = Duration::from_secs(20);

/// What the daemon's pre-launch task did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Prepared {
    /// The caller asked for the app's data to be wiped before the launch.
    pub wipe_requested: bool,
    /// The wipe ran to completion (container, and the keychain unless
    /// keychain state is turned off). Meaningless without `wipe_requested`.
    pub wiped: bool,
}

/// Whether the agent start may report that its runner launched the app
/// afresh — after the requested wipe, if any.
///
/// - `prepared`: the pre-launch task's outcome, `None` when it never finished
///   (it timed out or panicked).
/// - `gate_consumed`: the runner deleted the gate file, so it waited for the
///   task before launching. An agent that predates the gate never does.
/// - `relaunched`: xcodebuild was relaunched in place; the app may have run
///   (and written data) in between, and the second runner did not wait.
pub fn app_launched_fresh(
    prepared: Option<Prepared>,
    gate_consumed: bool,
    relaunched: bool,
) -> bool {
    let Some(prepared) = prepared else {
        return false;
    };
    gate_consumed && !relaunched && (!prepared.wipe_requested || prepared.wiped)
}

/// A per-start gate file. Removed again when dropped.
pub struct LaunchGate {
    path: PathBuf,
}

impl LaunchGate {
    /// A new, closed gate under `dir`, unique to this start so a file left by
    /// an earlier start can never open it.
    pub fn new_in(dir: &Path, agent_port: u16) -> Self {
        let path = dir.join(format!(
            "tapsmith-launch-gate-{agent_port}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_file(&path);
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Let the runner launch the app.
    pub fn open(&self) {
        open_at(&self.path);
    }

    /// Whether the runner acknowledged the gate (deleted the file it opened).
    pub fn consumed(&self) -> bool {
        !self.path.exists()
    }
}

/// Open the gate at `path` (for a task that does not own the [`LaunchGate`]).
pub fn open_at(path: &Path) {
    if let Err(e) = std::fs::write(path, b"open") {
        // The runner waits out its bound, then launches unvouched for.
        tracing::warn!(path = %path.display(), error = %e, "could not open the iOS launch gate");
    }
}

impl Drop for LaunchGate {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASKED_AND_WIPED: Prepared = Prepared {
        wipe_requested: true,
        wiped: true,
    };

    #[test]
    fn a_consumed_gate_after_a_complete_wipe_is_fresh() {
        assert!(app_launched_fresh(Some(ASKED_AND_WIPED), true, false));
    }

    #[test]
    fn no_wipe_asked_is_fresh_when_the_runner_waited() {
        let p = Prepared {
            wipe_requested: false,
            wiped: false,
        };
        assert!(app_launched_fresh(Some(p), true, false));
    }

    #[test]
    fn a_failed_wipe_is_not_fresh() {
        let p = Prepared {
            wipe_requested: true,
            wiped: false,
        };
        assert!(!app_launched_fresh(Some(p), true, false));
    }

    #[test]
    fn an_unconsumed_gate_is_not_fresh() {
        // An agent built before the gate launches without waiting, possibly
        // while the wipe runs; so does a runner that gave up waiting.
        assert!(!app_launched_fresh(Some(ASKED_AND_WIPED), false, false));
    }

    #[test]
    fn a_relaunched_xcodebuild_is_not_fresh() {
        assert!(!app_launched_fresh(Some(ASKED_AND_WIPED), true, true));
    }

    #[test]
    fn a_task_that_never_finished_is_not_fresh() {
        assert!(!app_launched_fresh(None, true, false));
    }

    #[test]
    fn the_gate_opens_is_consumed_by_deleting_it_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let gate = LaunchGate::new_in(dir.path(), 18700);
        assert!(!gate.path().exists(), "a new gate is closed");
        gate.open();
        assert!(gate.path().exists());
        assert!(!gate.consumed());
        std::fs::remove_file(gate.path()).unwrap();
        assert!(gate.consumed());
        gate.open();
        let path = gate.path().to_path_buf();
        drop(gate);
        assert!(!path.exists(), "dropping the gate removes its file");
    }

    #[test]
    fn every_start_gets_its_own_gate() {
        let dir = tempfile::tempdir().unwrap();
        let a = LaunchGate::new_in(dir.path(), 18700);
        let b = LaunchGate::new_in(dir.path(), 18700);
        assert_ne!(a.path(), b.path());
    }
}
