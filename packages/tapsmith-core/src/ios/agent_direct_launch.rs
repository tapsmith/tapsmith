//! SPIKE (PILOT-1134 item A): start the XCUITest runner on a simulator with
//! `simctl launch` instead of `xcodebuild test-without-building`.
//!
//! The runner app is an XCTRunner host with the UI-test bundle in `PlugIns/`.
//! Launched directly with no `XCTestConfigurationFilePath`, XCTest finds that
//! bundle, synthesizes a test configuration, opens its own testmanagerd
//! session and runs the test: no IDE-side client is needed. What xcodebuild
//! otherwise supplies and this path must supply itself:
//!
//! - the runner installed on the simulator (xcodebuild reinstalls it on every
//!   start; here it is installed once and skipped while the build matches);
//! - `DYLD_FRAMEWORK_PATH` / `DYLD_LIBRARY_PATH` pointing at the simulator
//!   platform's XCTest frameworks (a simulator build does not embed them);
//! - the agent's environment (`TAPSMITH_*`), which goes straight into the
//!   launch environment instead of the xctestrun plist;
//! - the runner's output, read from `simctl launch --console-pty`, which
//!   also exits when the runner does (crash detection) and takes the runner
//!   down when it is killed (teardown).
//!
//! Opt-in for the spike: `TAPSMITH_IOS_AGENT_LAUNCH=direct`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::process::Command;
use tracing::{debug, info};

/// Whether the spike's direct launch is switched on for this daemon.
pub(crate) fn enabled() -> bool {
    std::env::var("TAPSMITH_IOS_AGENT_LAUNCH").as_deref() == Ok("direct")
}

/// What the direct launch needs from an `.xctestrun`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RunnerSpec {
    /// The built `…-Runner.app` on the host.
    pub host_app: PathBuf,
    pub bundle_id: String,
    pub dyld_framework_path: String,
    pub dyld_library_path: String,
    /// The agent's own `TAPSMITH_*` variables, as `patch_xctestrun` wrote
    /// them into the plist's `EnvironmentVariables`.
    pub agent_env: Vec<(String, String)>,
}

/// Read the runner app, its bundle id and the XCTest search paths out of an
/// xctestrun plist, resolving its `__TESTROOT__` / `__PLATFORMS__` (and the
/// prebuilt package's `__TAPSMITH_PKG__`) placeholders.
pub(crate) fn runner_spec(
    xctestrun: &plist::Value,
    test_root: &Path,
    platforms_dir: &Path,
) -> Result<RunnerSpec> {
    let target = xctestrun
        .as_dictionary()
        .and_then(|d| d.get("TestConfigurations"))
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_dictionary())
        .and_then(|d| d.get("TestTargets"))
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_dictionary())
        .context("xctestrun has no TestConfigurations[0].TestTargets[0]")?;
    let resolve = |s: &str| {
        s.replace("__TESTROOT__", &test_root.to_string_lossy())
            .replace("__TAPSMITH_PKG__", &test_root.to_string_lossy())
            .replace("__PLATFORMS__", &platforms_dir.to_string_lossy())
    };
    let string = |key: &str| {
        target
            .get(key)
            .and_then(|v| v.as_string())
            .with_context(|| format!("xctestrun test target has no {key}"))
    };
    let testing_env = target
        .get("TestingEnvironmentVariables")
        .and_then(|v| v.as_dictionary());
    let env = |key: &str, fallback: &str| {
        testing_env
            .and_then(|d| d.get(key))
            .and_then(|v| v.as_string())
            .map(resolve)
            .unwrap_or_else(|| resolve(fallback))
    };
    let mut agent_env: Vec<(String, String)> = target
        .get("EnvironmentVariables")
        .and_then(|v| v.as_dictionary())
        .into_iter()
        .flatten()
        .filter(|(k, _)| k.starts_with("TAPSMITH_"))
        .filter_map(|(k, v)| Some((k.clone(), v.as_string()?.to_string())))
        .collect();
    agent_env.sort();
    Ok(RunnerSpec {
        agent_env,
        host_app: PathBuf::from(resolve(string("TestHostPath")?)),
        bundle_id: string("TestHostBundleIdentifier")?.to_string(),
        dyld_framework_path: env(
            "DYLD_FRAMEWORK_PATH",
            "__PLATFORMS__/iPhoneSimulator.platform/Developer/Library/Frameworks",
        ),
        dyld_library_path: env(
            "DYLD_LIBRARY_PATH",
            "__PLATFORMS__/iPhoneSimulator.platform/Developer/usr/lib",
        ),
    })
}

/// `<developer dir>/Platforms` of the selected Xcode.
async fn platforms_dir() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var("DEVELOPER_DIR") {
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir).join("Platforms"));
        }
    }
    let output = super::device::bounded_output(
        "xcode-select -p",
        Command::new("xcode-select").arg("-p"),
        Duration::from_secs(10),
    )
    .await?;
    if !output.status.success() {
        bail!("xcode-select -p failed; cannot locate the XCTest frameworks");
    }
    Ok(PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()).join("Platforms"))
}

pub(crate) async fn load_runner_spec(xctestrun_path: &str) -> Result<RunnerSpec> {
    let bytes = tokio::fs::read(xctestrun_path)
        .await
        .with_context(|| format!("Failed to read {xctestrun_path}"))?;
    let value: plist::Value = plist::from_bytes(&bytes).context("Failed to parse xctestrun")?;
    let test_root = Path::new(xctestrun_path)
        .parent()
        .context("xctestrun path has no parent")?;
    runner_spec(&value, test_root, &platforms_dir().await?)
}

/// The files that identify a runner build: the host executable and every
/// regular file of the test bundle. (path relative to the .app, size, bytes'
/// FNV-1a hash.) Cheap: the runner is ~2 MB and both copies are host files.
fn fingerprint(app: &Path) -> Option<Vec<(PathBuf, u64, u64)>> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(PathBuf, u64, u64)>) -> Option<()> {
        for entry in std::fs::read_dir(dir).ok()? {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_string_lossy().to_string();
            // Signature data is rewritten by the install.
            if name == "_CodeSignature" {
                continue;
            }
            if path.is_dir() {
                walk(root, &path, out)?;
            } else {
                let bytes = std::fs::read(&path).ok()?;
                let hash = bytes.iter().fold(0xcbf29ce484222325u64, |h, b| {
                    (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
                });
                out.push((
                    path.strip_prefix(root).ok()?.to_path_buf(),
                    bytes.len() as u64,
                    hash,
                ));
            }
        }
        Some(())
    }
    let mut out = Vec::new();
    walk(app, app, &mut out)?;
    out.sort();
    Some(out)
}

/// Install the runner unless the copy on the simulator is this build.
/// Returns whether it installed.
pub(crate) async fn ensure_installed(udid: &str, spec: &RunnerSpec) -> Result<bool> {
    let started = std::time::Instant::now();
    let installed = super::device::bounded_output(
        "simctl get_app_container",
        Command::new("xcrun").args(["simctl", "get_app_container", udid, &spec.bundle_id, "app"]),
        super::device::SIMCTL_TIMEOUT,
    )
    .await
    .ok()
    .filter(|o| o.status.success())
    .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()));
    let host_app = spec.host_app.clone();
    let up_to_date = match installed {
        Some(installed) => tokio::task::spawn_blocking(move || {
            let (a, b) = (fingerprint(&host_app), fingerprint(&installed));
            a.is_some() && a == b
        })
        .await
        .unwrap_or(false),
        None => false,
    };
    if !up_to_date {
        super::device::install_app(udid, &spec.host_app.to_string_lossy())
            .await
            .context("Failed to install the iOS agent runner")?;
    }
    crate::timing::timing_log!(
        "kind=boot name=agent_runner_install dur_ms={} installed={} udid={udid}",
        started.elapsed().as_millis(),
        !up_to_date
    );
    info!(
        udid,
        installed = !up_to_date,
        "iOS agent runner install check"
    );
    Ok(!up_to_date)
}

/// The `simctl launch` command for the runner. `--console-pty` ties the two
/// together: the runner's stdout/stderr come out of simctl, simctl exits when
/// the runner does, and the runner is hung up when simctl dies.
pub(crate) fn launch_command(udid: &str, spec: &RunnerSpec) -> Command {
    let mut cmd = Command::new("xcrun");
    cmd.args([
        "simctl",
        "launch",
        "--console-pty",
        "--terminate-running-process",
        udid,
        &spec.bundle_id,
    ]);
    cmd.env(
        "SIMCTL_CHILD_DYLD_FRAMEWORK_PATH",
        &spec.dyld_framework_path,
    );
    cmd.env("SIMCTL_CHILD_DYLD_LIBRARY_PATH", &spec.dyld_library_path);
    // XCTest prints its activity log ("t = 1.76s Launch …", failures) through
    // stderr only when unbuffered; xcodebuild sets the same.
    cmd.env("SIMCTL_CHILD_NSUnbufferedIO", "YES");
    for (key, value) in &spec.agent_env {
        cmd.env(format!("SIMCTL_CHILD_{key}"), value);
    }
    debug!(udid, bundle = %spec.bundle_id, "simctl launch of the iOS agent runner");
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_spec_resolves_the_xctestrun_placeholders() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>TestConfigurations</key><array><dict><key>TestTargets</key><array><dict>
<key>TestHostPath</key><string>__TESTROOT__/Debug-iphonesimulator/R-Runner.app</string>
<key>TestHostBundleIdentifier</key><string>dev.tapsmith.agent.xctrunner</string>
<key>EnvironmentVariables</key><dict><key>TAPSMITH_AGENT_PORT</key><string>18700</string><key>TERM</key><string>dumb</string></dict>
<key>TestingEnvironmentVariables</key><dict>
<key>DYLD_FRAMEWORK_PATH</key><string>__TESTROOT__/Debug-iphonesimulator:__PLATFORMS__/iPhoneSimulator.platform/Developer/Library/Frameworks</string>
</dict></dict></array></dict></array></dict></plist>"#;
        let value: plist::Value = plist::from_bytes(xml).unwrap();
        let spec = runner_spec(&value, Path::new("/root"), Path::new("/X/Platforms")).unwrap();
        assert_eq!(
            spec.host_app,
            PathBuf::from("/root/Debug-iphonesimulator/R-Runner.app")
        );
        assert_eq!(spec.bundle_id, "dev.tapsmith.agent.xctrunner");
        assert_eq!(
            spec.agent_env,
            vec![("TAPSMITH_AGENT_PORT".to_string(), "18700".to_string())]
        );
        assert_eq!(
            spec.dyld_framework_path,
            "/root/Debug-iphonesimulator:/X/Platforms/iPhoneSimulator.platform/Developer/Library/Frameworks"
        );
        assert_eq!(
            spec.dyld_library_path,
            "/X/Platforms/iPhoneSimulator.platform/Developer/usr/lib"
        );
    }
}
