//! Telling a host process apart from one that later reused its pid.
//!
//! Owner records (the iOS agent registry, the Android animation-scale records)
//! name a daemon by pid *and* process start time, so the next daemon can tell
//! "the owner is still running" from "the owner died and something else got
//! its pid".

use std::time::Duration;

use tokio::process::Command;

/// A process's start time from `ps -o lstart=`, in a fixed zone and locale
/// so daemons launched from different environments compare equal. `None`
/// when there is no such process or `ps` failed.
pub(crate) async fn process_started(pid: u32) -> Option<String> {
    let out = crate::ios::device::bounded_output(
        "ps lstart",
        Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "lstart="])
            .env("TZ", "UTC")
            .env("LC_ALL", "C"),
        Duration::from_secs(5),
    )
    .await
    .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// This daemon's start time. Only a successful read is cached, so one slow
/// `ps` under load does not leave every later record unprovable.
pub(crate) async fn own_start_time() -> Option<String> {
    static STARTED: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    STARTED
        .get_or_try_init(|| async { process_started(std::process::id()).await.ok_or(()) })
        .await
        .ok()
        .cloned()
}

/// Whether a process with `pid` exists (signal 0; a process we may not signal
/// still exists).
pub(crate) fn pid_exists(pid: u32) -> bool {
    let Ok(pid_i) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks for existence/permission.
    let exists = unsafe { libc::kill(pid_i, 0) } == 0;
    exists || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn own_process_has_a_start_time_and_exists() {
        assert!(pid_exists(std::process::id()));
        let started = own_start_time().await;
        assert!(started.is_some());
        assert_eq!(started, process_started(std::process::id()).await);
    }

    #[tokio::test]
    async fn a_missing_pid_has_no_start_time() {
        assert!(!pid_exists(u32::MAX - 1));
        assert_eq!(process_started(u32::MAX - 1).await, None);
    }
}
