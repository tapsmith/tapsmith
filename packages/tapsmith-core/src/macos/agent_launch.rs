//! Starting the XCUITest agent on the host Mac: the macOS counterpart of
//! `ios::agent_launch`, without simulators, devices or USB tunnels.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::process::Command;
use tracing::{debug, info, instrument};

use super::device::HOST_SERIAL;
use crate::ios::agent_launch::{patch_xctestrun, ping_agent, spawn_tracked_xcodebuild};
use crate::ios::agent_registry;
use crate::ios::device::bounded_output;

/// The runner can take a while on a cold machine (Automation Mode, first
/// launch of the app); the same budget as iOS.
const READY_TIMEOUT: Duration = Duration::from_secs(150);
const KILL_TIMEOUT: Duration = Duration::from_secs(10);

/// Pinned so each run overwrites the last instead of leaving a fresh
/// DerivedData (and multi-GB `.xcresult`) behind. One Mac, one directory.
fn derived_data_path() -> PathBuf {
    std::env::temp_dir().join("tapsmith-macos-derived")
}

/// Start the agent on this Mac, which launches the app at `app_path`.
///
/// Always starts fresh: a runner or app left by an earlier run is stopped
/// first, because the runner cannot bring forward an instance of the app that
/// is already running (it fails with "Failed to activate application").
/// Reusing a live agent within a session is decided by the caller.
#[instrument(skip(xctestrun, app_path))]
pub async fn start_agent(
    xctestrun: &Path,
    bundle_id: &str,
    app_path: &Path,
    port: u16,
) -> Result<()> {
    let started = std::time::Instant::now();
    // Runners orphaned by a SIGKILLed daemon are stopped first.
    #[cfg(target_os = "macos")]
    agent_registry::reap_orphans().await;

    if !app_path.join("Contents").join("Info.plist").is_file() {
        bail!(
            "No macOS app at {}: expected an .app bundle (Contents/Info.plist).",
            app_path.display()
        );
    }

    stop_agent_and_app(app_path).await;
    if ping_agent(port).await.is_ok() {
        bail!(
            "Port {port} is still answered by a Tapsmith agent after stopping the macOS one, \
             so something else holds it (perhaps an iOS runner from another session). Stop \
             that session, then run again."
        );
    }

    let app_path_env = app_path.to_string_lossy();
    let patched = patch_xctestrun(
        &xctestrun.to_string_lossy(),
        bundle_id,
        false,
        port,
        &[("TAPSMITH_TARGET_APP_PATH", &app_path_env)],
    )
    .await
    .context("Failed to patch the macOS agent's xctestrun file")?;

    let derived = derived_data_path();
    // Only the newest .xcresult is ever useful; the rest is disk.
    match tokio::fs::remove_dir_all(derived.join("Logs").join("Test")).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => debug!("Failed to clear old xcresults: {e}"),
    }

    info!(bundle_id, port, "Starting the macOS agent via xcodebuild");
    let args = xcodebuild_args(Path::new(&patched), &derived);
    // `is_physical = true`: there is no simulator for the registry to clean up.
    let (mut child, stdout_tail, stderr_tail) =
        spawn_tracked_xcodebuild(&args, HOST_SERIAL, true).await?;

    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    let output = || {
        let out = stdout_tail.lock().unwrap().join("\n");
        let err = stderr_tail.lock().unwrap().join("\n");
        let hints: String = [
            automation_mode_hint(&format!("{out}\n{err}")),
            activation_hint(&format!("{out}\n{err}")),
        ]
        .into_iter()
        .flatten()
        .map(|h| format!("\n{h}"))
        .collect();
        format!(
            "{hints}\nxcodebuild output (last lines):\n{out}\n\
             xcodebuild stderr (last lines):\n{err}"
        )
    };
    loop {
        if agent_registry::global().is_shutting_down() {
            let _ = child.wait().await;
            bail!("The daemon is shutting down; stopped starting the macOS agent");
        }
        if tokio::time::Instant::now() > deadline {
            let _ = child.kill().await;
            bail!(
                "Timed out waiting for the macOS agent to start after {}s. Killed xcodebuild.{}",
                READY_TIMEOUT.as_secs(),
                output()
            );
        }
        match child.try_wait() {
            Ok(Some(status)) => bail!(
                "xcodebuild exited with {status} before the macOS agent became ready.{}",
                output()
            ),
            Ok(None) => {}
            Err(e) => bail!("Failed to check xcodebuild status: {e}"),
        }
        if ping_agent(port).await.is_ok() {
            info!("macOS agent is ready");
            crate::timing::timing_log!(
                "kind=boot name=agent dur_ms={} reused=false udid={HOST_SERIAL}",
                started.elapsed().as_millis()
            );
            // Reap xcodebuild when it exits; the registry keeps tracking it
            // until then, so a daemon shutdown stops it.
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Stop any macOS agent runner and any running instance of the app at
/// `app_path`. Nothing running is not an error.
pub async fn stop_agent_and_app(app_path: &Path) {
    pkill("pkill macOS agent", kill_pattern()).await;
    stop_app(app_path).await;
    // Give the processes a moment to exit and release the port.
    tokio::time::sleep(Duration::from_millis(1000)).await;
}

/// Stop any running instance of the app at `app_path`, and nothing else: the
/// pattern names that bundle's executable by its full path. Not running is
/// not an error.
pub async fn stop_app(app_path: &Path) {
    pkill("pkill macOS app", &app_kill_pattern(app_path)).await;
}

async fn pkill(label: &str, pattern: &str) {
    if let Err(e) = bounded_output(
        label,
        Command::new("pkill").args(["-f", pattern]),
        KILL_TIMEOUT,
    )
    .await
    {
        debug!("{e:#}");
    }
}

/// Arguments for `xcodebuild` to run the patched agent on this Mac.
pub fn xcodebuild_args(patched_xctestrun: &Path, derived_data: &Path) -> Vec<String> {
    vec![
        "test-without-building".to_string(),
        "-xctestrun".to_string(),
        patched_xctestrun.to_string_lossy().into_owned(),
        "-destination".to_string(),
        "platform=macOS".to_string(),
        "-derivedDataPath".to_string(),
        derived_data.to_string_lossy().into_owned(),
    ]
}

/// `pkill -f` pattern for a leftover macOS agent runner. The xctestrun file
/// is named after the `TapsmithMacAgentUITests` scheme, which the iOS
/// runner's (`TapsmithAgentUITests…`, `-destination id=…`) never matches.
pub fn kill_pattern() -> &'static str {
    "xcodebuild test-without-building.*TapsmithMacAgent"
}

/// What to do when XCUITest could not put this Mac into Automation Mode, which
/// it needs to drive another app. Outside an interactive session (CI, SSH)
/// enabling it asks for a password nobody can type, so it has to be allowed
/// up front.
pub fn automation_mode_hint(output: &str) -> Option<&'static str> {
    let output = output.to_lowercase();
    (output.contains("automation mode") || output.contains("not authorized")).then_some(
        "XCUITest could not enable Automation Mode on this Mac. Allow it without a password \
         prompt once with `sudo automationmodetool enable-automationmode-without-authentication` \
         (CI machines need this), then run again.",
    )
}

/// What to do when the runner launched the app but could not bring it to the
/// front. Seen when the Mac was in use during the launch (another app kept
/// focus), and plausibly when it was locked or asleep.
pub fn activation_hint(output: &str) -> Option<&'static str> {
    output.contains("Failed to activate application").then_some(
        "The app launched but macOS would not bring it to the front. Keep the Mac unlocked \
         and awake, and leave it alone while the run starts (typing in another app keeps \
         focus there), then run again.",
    )
}

/// `pkill -f` pattern for a running instance of the app at `app_path`: its
/// command line starts with the executable inside the bundle. `pkill` takes a
/// POSIX extended regex, so the path's special characters are escaped.
pub fn app_kill_pattern(app_path: &Path) -> String {
    let executable_dir = format!("{}/Contents/MacOS/", app_path.to_string_lossy());
    let mut pattern = String::from("^");
    for c in executable_dir.chars() {
        if r".[]()*+?{}|^$\".contains(c) {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_target_macos_destination() {
        let args = xcodebuild_args(Path::new("/x/a.xctestrun"), Path::new("/d"));
        assert_eq!(
            args,
            [
                "test-without-building",
                "-xctestrun",
                "/x/a.xctestrun",
                "-destination",
                "platform=macOS",
                "-derivedDataPath",
                "/d",
            ]
        );
    }

    #[test]
    fn kill_pattern_matches_only_the_macos_runner() {
        let pattern = regex::Regex::new(kill_pattern()).unwrap();
        assert!(pattern.is_match(
            "xcodebuild test-without-building -xctestrun /t/TapsmithMacAgentUITests_macosx.xctestrun \
             -destination platform=macOS"
        ));
        assert!(
            !pattern.is_match("xcodebuild test-without-building -xctestrun x -destination id=ABC")
        );
    }

    #[test]
    fn automation_hint_detects_unauthorised() {
        let hint = automation_mode_hint(
            "Testing failed:\n\tTimed out while enabling automation mode.\n\
             Automation Mode could not be enabled",
        )
        .expect("a hint");
        assert!(
            hint.contains("automationmodetool enable-automationmode-without-authentication"),
            "{hint}"
        );
    }

    #[test]
    fn automation_hint_ignores_unrelated() {
        assert_eq!(
            automation_mode_hint(
                "error: -[TapsmithMacAgentUITests.TapsmithAgentRunner testRunAgent] : Failed to \
                 activate application 'dev.tapsmith.mactestapp at /a/App.app' (current state: \
                 Running Background)\n** TEST EXECUTE FAILED **"
            ),
            None
        );
    }

    #[test]
    fn activation_hint_detects_app_that_could_not_come_forward() {
        let hint = activation_hint(
            "Failed to activate application 'dev.tapsmith.mactestapp at /a/App.app' \
             (current state: Running Background)",
        )
        .expect("a hint");
        assert!(hint.contains("front"), "{hint}");
        assert_eq!(activation_hint("** TEST EXECUTE FAILED **"), None);
    }

    #[test]
    fn app_kill_pattern_matches_only_that_apps_executable() {
        let app = Path::new("/Users/q/Build (1)/Debug-x/My.App.app");
        let pattern = app_kill_pattern(app);
        assert_eq!(
            pattern,
            r"^/Users/q/Build \(1\)/Debug-x/My\.App\.app/Contents/MacOS/"
        );
        let re = regex::Regex::new(&pattern).unwrap();
        assert!(re.is_match("/Users/q/Build (1)/Debug-x/My.App.app/Contents/MacOS/My App"));
        assert!(!re.is_match("/Users/q/Build (1)/Debug-x/MyXAppXapp/Contents/MacOS/My App"));
        assert!(
            !re.is_match("xcodebuild -app /Users/q/Build (1)/Debug-x/My.App.app/Contents/MacOS/x")
        );
    }
}
