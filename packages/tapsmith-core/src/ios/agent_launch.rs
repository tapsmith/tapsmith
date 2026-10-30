use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::net::TcpStream;
use tokio::process::Command;
use tracing::{debug, info, instrument, warn};

use super::agent_registry::TrackedAgent;
use super::iproxy::{kill_stray_iproxy, IproxyHandle};

/// Stable per-udid DerivedData location for `xcodebuild test-without-building`.
///
/// Without `-derivedDataPath`, every invocation allocates a fresh random
/// DerivedData hash and dumps a multi-GB `.xcresult` bundle there that
/// nothing ever cleans up. Pinning to a stable per-udid location lets
/// subsequent runs reuse (and overwrite) the same directory. Per-udid keying
/// preserves isolation for parallel execution against multiple simulators.
fn derived_data_path_for(udid: &str) -> PathBuf {
    std::env::temp_dir().join("tapsmith-ios-derived").join(udid)
}

/// Wipe any prior xcresult bundles before launching xcodebuild.
///
/// xcodebuild always writes a *new* timestamped `Test-*.xcresult` into
/// `Logs/Test/` on each run, so without this we'd accumulate ~1.8GB per
/// invocation inside the pinned DerivedData dir. Removing the dir caps
/// total disk usage to one bundle per simulator.
///
/// A missing path is a no-op (not an error) — first run won't have one.
async fn clear_prior_xcresults(derived_data_path: &Path) -> Result<()> {
    let test_logs = derived_data_path.join("Logs").join("Test");
    match tokio::fs::remove_dir_all(&test_logs).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("Failed to clear {test_logs:?}")),
    }
}

/// Launch the TapsmithAgent XCUITest runner on an iOS simulator or physical device.
///
/// This is the iOS equivalent of Android's `am instrument -w dev.tapsmith.agent/.TapsmithAgent`.
/// It runs `xcodebuild test-without-building` with the prebuilt .xctestrun file.
///
/// Environment variables and the target app bundle ID must be injected into the
/// `.xctestrun` plist (not the xcodebuild process env) because XCUITest reads its
/// configuration exclusively from that file.
///
/// Returns `Some(IproxyHandle)` for physical devices — the caller must store
/// the handle for the lifetime of the agent so the USB tunnel stays alive.
/// For simulators (and for the fast-path case where an existing agent is
/// already responding) returns `None` and the caller keeps any existing
/// tracking state unchanged.
#[instrument(skip(xctestrun_path, target_bundle_id))]
pub async fn start_agent(
    udid: &str,
    xctestrun_path: &str,
    target_bundle_id: &str,
    agent_port: u16,
    is_physical: bool,
) -> Result<Option<IproxyHandle>> {
    start_agent_impl(
        udid,
        xctestrun_path,
        target_bundle_id,
        false,
        false,
        agent_port,
        is_physical,
    )
    .await
}

/// Start the agent, optionally forcing a fresh launch even if an agent
/// appears to be running on the port. Used after kill_existing_agents
/// where the stale runner may still briefly respond to pings.
pub async fn start_agent_fresh(
    udid: &str,
    xctestrun_path: &str,
    target_bundle_id: &str,
    agent_port: u16,
    is_physical: bool,
) -> Result<Option<IproxyHandle>> {
    start_agent_impl(
        udid,
        xctestrun_path,
        target_bundle_id,
        true,
        true,
        agent_port,
        is_physical,
    )
    .await
}

async fn start_agent_impl(
    udid: &str,
    xctestrun_path: &str,
    target_bundle_id: &str,
    force: bool,
    attach_to_running_app: bool,
    agent_port: u16,
    is_physical: bool,
) -> Result<Option<IproxyHandle>> {
    let boot_start = std::time::Instant::now();
    // Agents orphaned by a SIGKILLed daemon are stopped before we look for a
    // running one, so we never adopt an agent the reaper is about to kill.
    #[cfg(target_os = "macos")]
    super::agent_registry::reap_orphans().await;
    // An `adb forward` on the agent port (an Android session's) shadows the
    // runner: the ping reaches the Android agent instead, and a fresh runner
    // cannot take the port. One left behind by a finished Android run is
    // removed; one a live daemon is using is refused (PILOT-550).
    if agent_port_listeners(agent_port).await.has_adb() {
        clear_stale_adb_forwards(agent_port).await?;
    }
    // Check if agent is already running by trying to connect
    if !force && ping_agent(agent_port).await.is_ok() {
        // A runner answering on this port is only ours to adopt if it serves
        // this device. Another session's runner for another simulator on the
        // same port would otherwise be driven as this one (PILOT-381).
        match agent_port_listeners(agent_port).await.judge(udid) {
            AgentPortOwner::Other(other) => bail!(
                "The iOS agent port {agent_port} is held by a Tapsmith runner for another \
                 device ({other}), not {udid}. Another Tapsmith session is probably driving \
                 {other}, so its agent was not adopted. Stop that session, then run again."
            ),
            AgentPortOwner::AdbForward => bail!(
                "The iOS agent port {agent_port} is taken by an adb port forward to an Android \
                 device, not a runner for {udid}. If no Tapsmith session is using it, remove \
                 it with `adb forward --remove tcp:{agent_port}`, then run again."
            ),
            AgentPortOwner::Serves | AgentPortOwner::Unknown => {}
        }
        info!("iOS agent is already running");
        crate::timing::timing_log!(
            "kind=boot name=agent dur_ms={} reused=true udid={udid}",
            boot_start.elapsed().as_millis()
        );
        // For physical devices, pingable-on-localhost means the caller's
        // iproxy tunnel is still up; no new handle is returned and the
        // caller's existing stored state remains authoritative.
        return Ok(None);
    }

    // Kill any stale xcodebuild processes targeting this device/simulator before
    // starting a new one. Without this, leftover processes from a previous
    // run can hold the port or interfere with the new agent launch.
    kill_existing_agents_on(udid).await;
    if is_physical {
        // Sweep stale iproxy tunnels keyed to this UDID/port so the host
        // port is free before we spawn a fresh one.
        kill_stray_iproxy(udid, agent_port, agent_port).await;
    }

    // In launch mode the runner's `XCUIApplication.launch()` must first kill
    // any already-running instance of the target app — the classic trigger
    // for "Timed out attempting to launch app" on a busy SpringBoard. Clear
    // it from the host side instead so the runner always cold-launches into
    // a clean slate. Attach mode intentionally preserves the running app.
    if !is_physical && !attach_to_running_app && !target_bundle_id.is_empty() {
        if let Err(e) = super::device::terminate_app(udid, target_bundle_id).await {
            debug!(udid, error = %e, "pre-launch terminate of target app failed (may not be running)");
        }
    }

    info!(
        udid,
        xctestrun_path, agent_port, is_physical, "Starting iOS agent via xcodebuild"
    );

    // Patch the xctestrun file to inject target bundle ID and env vars.
    // xcodebuild process env vars don't reach the XCUITest runner — they must
    // be in the plist's EnvironmentVariables / TestingEnvironmentVariables dicts.
    let patched_xctestrun = patch_xctestrun(
        xctestrun_path,
        target_bundle_id,
        attach_to_running_app,
        agent_port,
    )
    .await
    .context("Failed to patch xctestrun file")?;

    // Pin xcodebuild's output directory and wipe any prior xcresults so
    // disk usage stays bounded across runs. See helper docs for details.
    let derived_data_path = derived_data_path_for(udid);
    if let Err(e) = tokio::fs::create_dir_all(&derived_data_path).await {
        debug!("Failed to create derivedDataPath {derived_data_path:?}: {e}");
    }
    if let Err(e) = clear_prior_xcresults(&derived_data_path).await {
        debug!("{e:#}");
    }

    // For physical devices, start the USB tunnel BEFORE xcodebuild so a
    // missing libimobiledevice / wrong UDID / stale port fails fast in ~250ms
    // instead of after the ~60s xcodebuild warmup. The tunnel forwards the
    // host's `agent_port` to the same port on the device, where the XCUITest
    // runner will bind its socket once it finishes launching.
    let iproxy_handle = if is_physical {
        Some(
            IproxyHandle::start(udid.to_string(), agent_port, agent_port)
                .await
                .context("Failed to start iproxy USB tunnel for physical iOS device")?,
        )
    } else {
        None
    };

    // Launch xcodebuild test-without-building in background.
    let (mut child, mut stdout_tail, mut stderr_tail, mut launch_failure) = spawn_agent_xcodebuild(
        &patched_xctestrun,
        udid,
        &derived_data_path,
        is_physical,
        target_bundle_id,
    )
    .await?;

    // Wait for the agent to start accepting connections.
    // Freshly booted/cloned simulators can take 90+ seconds for xcodebuild to
    // install and launch the XCUITest runner, especially when multiple
    // xcodebuild processes compete for resources in parallel mode. Physical
    // devices on first run may also trigger a Developer Disk Image mount which
    // adds ~30s to the first-ever invocation — 150s still covers it.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(150);
    // xcodebuild occasionally crashes or exits early on contended CI runners.
    // One in-place relaunch (budget permitting) recovers that case without a
    // full RPC round trip; the first attempt has usually warmed the simulator.
    let mut relaunches_left: u32 = 1;
    loop {
        // The daemon is shutting down (and is stopping this agent): stop here
        // rather than reading its exit as a crash and running the relaunch
        // sequence, which would kill the app and burn the shutdown budget on a
        // spawn that is then refused. Wait for the exit rather than SIGKILLing:
        // the teardown's SIGTERM lets xcodebuild take its runner down with it,
        // and the teardown escalates on its own if it has to.
        if super::agent_registry::global().is_shutting_down() {
            let _ = child.wait().await;
            drop(iproxy_handle);
            bail!("The daemon is shutting down; stopped starting the iOS agent on {udid}");
        }
        if tokio::time::Instant::now() > deadline {
            // Kill xcodebuild explicitly so it doesn't outlive this function.
            let _ = child.kill().await;
            // Drop the iproxy handle (if any) so the host port is freed before
            // returning. `drop(iproxy_handle)` is explicit rather than letting
            // scope-drop do it so reviewers can see the cleanup point.
            drop(iproxy_handle);
            let out_lines = stdout_tail.lock().unwrap().join("\n");
            let err_lines = stderr_tail.lock().unwrap().join("\n");
            let target_kind = if is_physical { "device" } else { "simulator" };
            bail!(
                "Timed out waiting for iOS agent to start on {target_kind} {udid} after 150s. \
                 Killed xcodebuild. Check that the XCUITest bundle is built correctly.\n\
                 xcodebuild output (last lines):\n{out_lines}\n\
                 xcodebuild stderr (last lines):\n{err_lines}"
            );
        }

        // The runner could not launch the app under test at all — most often
        // because it is not installed. XCTest says so within a second, but
        // xcodebuild then lingers for minutes finalizing the .xcresult, and
        // waiting for it used to burn the whole 150 s deadline before the
        // caller saw a bare timeout. Stop xcodebuild now. An app that is
        // installed may have hit a transient launch refusal, so it gets the
        // one in-place relaunch; a missing one never will launch.
        let runner_error = launch_failure.lock().unwrap().take();
        if let Some(runner_error) = runner_error {
            let _ = child.kill().await;
            let installed = if is_physical {
                None
            } else {
                Some(
                    super::device::get_app_container(udid, target_bundle_id)
                        .await
                        .is_ok(),
                )
            };
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if installed == Some(true) && relaunches_left > 0 && remaining > Duration::from_secs(30)
            {
                relaunches_left -= 1;
                warn!(
                    udid,
                    error = %runner_error,
                    "XCUITest runner failed to launch the target app; relaunching once"
                );
                kill_existing_agents_on(udid).await;
                let _ = super::device::terminate_app(udid, target_bundle_id).await;
                (child, stdout_tail, stderr_tail, launch_failure) = spawn_agent_xcodebuild(
                    &patched_xctestrun,
                    udid,
                    &derived_data_path,
                    is_physical,
                    target_bundle_id,
                )
                .await?;
                continue;
            }
            drop(iproxy_handle);
            let target_kind = if is_physical { "device" } else { "simulator" };
            bail!(
                "{}",
                app_launch_failure_message(
                    target_kind,
                    udid,
                    target_bundle_id,
                    &runner_error,
                    installed
                )
            );
        }

        // A runner-side "Timed out attempting to launch app" is terminal for
        // this xcodebuild run, but xcodebuild can spend minutes finalizing
        // the .xcresult before exiting — waiting for the exit burns the rest
        // of the deadline for nothing. Detect the signature in the output
        // tail, kill xcodebuild immediately, clear the stuck app, and use the
        // in-place relaunch while there's still budget.
        let launch_timed_out = stdout_tail
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.contains("Timed out attempting to launch app"));
        if launch_timed_out && !is_physical {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if relaunches_left > 0 && remaining > Duration::from_secs(30) {
                relaunches_left -= 1;
                warn!(
                    udid,
                    remaining_secs = remaining.as_secs(),
                    "XCUITest runner timed out launching the target app; killing xcodebuild and relaunching"
                );
                let _ = child.kill().await;
                kill_existing_agents_on(udid).await;
                if !target_bundle_id.is_empty() {
                    let _ = super::device::terminate_app(udid, target_bundle_id).await;
                }
                (child, stdout_tail, stderr_tail, launch_failure) = spawn_agent_xcodebuild(
                    &patched_xctestrun,
                    udid,
                    &derived_data_path,
                    is_physical,
                    target_bundle_id,
                )
                .await?;
                continue;
            }
        }

        // If xcodebuild exited, the agent won't come up on this launch.
        // try_wait is non-blocking and reaps the process if it has exited.
        match child.try_wait() {
            Ok(Some(status)) => {
                let out_lines = stdout_tail.lock().unwrap().join("\n");
                let err_lines = stderr_tail.lock().unwrap().join("\n");
                let target_kind = if is_physical { "device" } else { "simulator" };
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                // Simulators only: kill_existing_agents_on can terminate the
                // sim-side runner (`simctl terminate`) but has no equivalent
                // for a physical device — an orphaned attempt-1 runner there
                // could keep the agent port bound and burn the whole deadline.
                let arch_hint = architecture_mismatch_hint(&out_lines, &err_lines);
                // An agent built for the wrong architecture fails the same way
                // every time: relaunching it only delays the error.
                if arch_hint.is_none()
                    && !is_physical
                    && relaunches_left > 0
                    && remaining > Duration::from_secs(30)
                {
                    relaunches_left -= 1;
                    warn!(
                        udid,
                        %status,
                        "xcodebuild exited before the iOS agent became ready; relaunching once.\n\
                         xcodebuild output (last lines):\n{out_lines}\n\
                         xcodebuild stderr (last lines):\n{err_lines}"
                    );
                    kill_existing_agents_on(udid).await;
                    // Clear a possibly-stuck target app instance so the fresh
                    // runner's launch() doesn't replay the same terminate race.
                    if !attach_to_running_app && !target_bundle_id.is_empty() {
                        let _ = super::device::terminate_app(udid, target_bundle_id).await;
                    }
                    (child, stdout_tail, stderr_tail, launch_failure) = spawn_agent_xcodebuild(
                        &patched_xctestrun,
                        udid,
                        &derived_data_path,
                        is_physical,
                        target_bundle_id,
                    )
                    .await?;
                    continue;
                }
                drop(iproxy_handle);
                bail!(
                    "xcodebuild exited with {status} before the iOS agent became \
                     ready on {target_kind} {udid}.{hint}\n\
                     xcodebuild output (last lines):\n{out_lines}\n\
                     xcodebuild stderr (last lines):\n{err_lines}",
                    hint = arch_hint.map(|h| format!("\n{h}")).unwrap_or_default()
                );
            }
            Ok(None) => {} // still running, continue probing
            Err(e) => {
                drop(iproxy_handle);
                bail!("Failed to check xcodebuild status: {e}");
            }
        }

        match ping_agent(agent_port).await {
            Ok(_) => {
                info!(udid, "iOS agent is ready");
                crate::timing::timing_log!(
                    "kind=boot name=agent dur_ms={} reused=false udid={udid}",
                    boot_start.elapsed().as_millis()
                );
                // Hand the child off to a reaper task so the kernel can collect
                // it once xcodebuild eventually exits — without this, dropping
                // the Child without awaiting leaves a zombie until process exit.
                // The tracked handle stays registered until then, so a daemon
                // shutdown stops this agent (PILOT-299).
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                return Ok(iproxy_handle);
            }
            Err(_) => {
                debug!("Agent not ready yet, retrying...");
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

/// The runner's own error when `XCUIApplication.launch()` could not start the
/// app under test, from one line of xcodebuild's output: everything from
/// "Failed to launch <bundle>:" on. Only for `target_bundle_id` — a launch
/// failure of anything else (the runner itself) is not this one.
fn runner_launch_failure<'a>(line: &'a str, target_bundle_id: &str) -> Option<&'a str> {
    if target_bundle_id.is_empty() {
        return None;
    }
    let needle = format!("Failed to launch {target_bundle_id}:");
    line.find(&needle).map(|at| line[at..].trim_end())
}

/// The agent-start error for an app the runner could not launch. `installed`
/// is whether the app is on the simulator (`None` where that was not checked,
/// a physical device): a missing app is by far the commonest cause, and the
/// one the runner's own wording ("returned nil for …") never names.
fn app_launch_failure_message(
    target_kind: &str,
    udid: &str,
    target_bundle_id: &str,
    runner_error: &str,
    installed: Option<bool>,
) -> String {
    let mut message = format!(
        "The iOS agent could not launch {target_bundle_id} on {target_kind} {udid}: {runner_error}"
    );
    if installed == Some(false) {
        message.push_str(&format!(
            "\n{target_bundle_id} is not installed on this simulator. Set `app` in your Tapsmith \
             config to the built .app so Tapsmith installs it, or install it yourself \
             (xcrun simctl install {udid} <path/to/App.app>), and check that `package` is \
             the app's bundle identifier."
        ));
    }
    message
}

/// What to do when xcodebuild refused the agent because it was built for an
/// architecture the destination cannot run — on Apple Silicon, an x86_64
/// agent, which is what an x64 Node under Rosetta used to install or build
/// (PILOT-559). Xcode says so as "No architectures intersection" (log line)
/// and "architectures (…) include none that <device> can execute" (error).
fn architecture_mismatch_hint(stdout_tail: &str, stderr_tail: &str) -> Option<&'static str> {
    let mismatch = [stdout_tail, stderr_tail].iter().any(|tail| {
        tail.contains("No architectures intersection") || tail.contains("include none that")
    });
    mismatch.then_some(
        "The iOS agent was built for a CPU architecture this simulator or device cannot \
         run (an x86_64 agent on an Apple Silicon Mac). That happens when Node runs under \
         Rosetta (x64): install an arm64 Node, then reinstall your dependencies \
         (rm -rf node_modules && npm install) — `npx tapsmith doctor` checks it. If \
         `iosXctestrun` is set in your config, point it at an arm64 build.",
    )
}

type OutputTail = std::sync::Arc<std::sync::Mutex<Vec<String>>>;
/// The runner's first "Failed to launch <app>" error, kept apart from the
/// rolling tail: xcodebuild prints a dozen more lines right after it, which
/// can roll it out of the tail before the wait loop looks.
type LaunchFailure = std::sync::Arc<std::sync::Mutex<Option<String>>>;

/// Spawn `xcodebuild test-without-building` for the agent and drain its
/// stdout/stderr into rolling 20-line tails for error reporting.
///
/// The child is returned (not moved into a wait task) so the caller's timeout
/// path can kill it explicitly. Without this, a timeout would leave xcodebuild
/// orphaned until the next kill_existing_agents_on sweep — which may not
/// happen for a long time, or ever, on a failed run.
///
/// It is returned registered with the daemon's agent registry, which stops it
/// when the daemon shuts down and records its owner so a daemon that is killed
/// outright has it reaped by the next one (PILOT-299). Spawning is refused once
/// shutdown has begun.
async fn spawn_agent_xcodebuild(
    patched_xctestrun: &str,
    udid: &str,
    derived_data_path: &std::path::Path,
    is_physical: bool,
    target_bundle_id: &str,
) -> Result<(TrackedAgent, OutputTail, OutputTail, LaunchFailure)> {
    use std::sync::{Arc, Mutex};

    let mut cmd = Command::new("xcodebuild");
    cmd.args([
        "test-without-building",
        "-xctestrun",
        patched_xctestrun,
        "-destination",
        &format!("id={udid}"),
        "-derivedDataPath",
        &derived_data_path.to_string_lossy(),
    ]);

    // Capture stdout/stderr so we can diagnose failures.
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Backstop: if the handle is ever dropped while xcodebuild runs (the
        // runtime tearing down its tasks at exit), take xcodebuild with it.
        .kill_on_drop(true)
        .spawn()
        .context("Failed to spawn xcodebuild for iOS agent")?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stderr_tail: OutputTail = Arc::new(Mutex::new(Vec::new()));
    let stderr_tail_writer = stderr_tail.clone();
    let stdout_tail: OutputTail = Arc::new(Mutex::new(Vec::new()));
    let stdout_tail_writer = stdout_tail.clone();
    let launch_failure: LaunchFailure = Arc::new(Mutex::new(None));
    let launch_failure_writer = launch_failure.clone();
    let bundle_id = target_bundle_id.to_string();

    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        if let Some(stdout) = stdout {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                info!(target: "xcodebuild", "{}", line);
                if let Some(error) = runner_launch_failure(&line, &bundle_id) {
                    launch_failure_writer
                        .lock()
                        .unwrap()
                        .get_or_insert_with(|| error.to_string());
                }
                let mut tail = stdout_tail_writer.lock().unwrap();
                tail.push(line);
                if tail.len() > 20 {
                    tail.remove(0);
                }
            }
        }
    });
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                info!(target: "xcodebuild::stderr", "{}", line);
                let mut tail = stderr_tail_writer.lock().unwrap();
                tail.push(line);
                if tail.len() > 20 {
                    tail.remove(0);
                }
            }
        }
    });

    let child =
        TrackedAgent::track(child, udid, is_physical, super::agent_registry::global()).await?;
    Ok((child, stdout_tail, stderr_tail, launch_failure))
}

/// Kill any existing xcodebuild test-without-building processes and the agent.
/// Called before restarting the agent in launchApp/restartApp.
///
/// Kills both the host-side xcodebuild process AND the simulator-side runner
/// app. Without killing the runner app, it keeps listening on its port and
/// `start_agent` would skip launching a new one.
pub async fn kill_existing_agents_on(udid: &str) {
    // Kill host-side xcodebuild targeting this specific simulator.
    // Match on the destination id= argument to avoid killing agents for other simulators.
    let pattern = format!("xcodebuild test-without-building.*id={udid}");
    let _ = super::device::bounded_output(
        "pkill xcodebuild",
        Command::new("pkill").args(["-f", &pattern]),
        Duration::from_secs(10),
    )
    .await;

    // Kill the runner app on the simulator — xcrun simctl terminate
    // targets the simulator process, not the host. The runner's bundle ID
    // is set in the Xcode project (dev.tapsmith.agent.xctrunner).
    let _ = super::device::bounded_output(
        "simctl terminate xctrunner",
        Command::new("xcrun").args(["simctl", "terminate", udid, "dev.tapsmith.agent.xctrunner"]),
        super::device::SIMCTL_TIMEOUT,
    )
    .await;

    // Brief pause for processes to die and port to be released
    tokio::time::sleep(Duration::from_millis(1000)).await;
}

/// Backward-compatible version that terminates on all booted simulators.
#[allow(dead_code)]
pub async fn kill_existing_agents() {
    kill_existing_agents_on("booted").await;
}

/// Create a patched copy of the `.xctestrun` plist that includes the target
/// application bundle ID and the agent's environment variables.
///
/// Uses PlistBuddy to modify a copy — the original file is left untouched.
async fn patch_xctestrun(
    xctestrun_path: &str,
    target_bundle_id: &str,
    attach_to_running_app: bool,
    agent_port: u16,
) -> Result<String> {
    let mode = if attach_to_running_app {
        "attach"
    } else {
        "launch"
    };
    // Normalize the source path: strip any `.{mode}.port{N}.patched.xctestrun`
    // suffixes left behind by previous runs so we don't keep accreting suffixes
    // until the filename overflows the 255-byte limit.
    let source_root = strip_patched_suffixes(xctestrun_path);
    let patched_path = format!("{source_root}.{mode}.port{agent_port}.patched.xctestrun");

    // Copy original to patched location
    tokio::fs::copy(xctestrun_path, &patched_path)
        .await
        .context("Failed to copy xctestrun file")?;

    // Resolve __TAPSMITH_PKG__ placeholders left by the prebuilt npm packages.
    // These replace the CI machine's absolute DerivedData paths at package time;
    // here we substitute the actual directory containing the xctestrun file so
    // xcodebuild can find the test runner .app bundle at runtime.
    resolve_pkg_placeholders(&patched_path, xctestrun_path).await?;

    let base = "TestConfigurations:0:TestTargets:0";
    let plist_buddy = "/usr/libexec/PlistBuddy";

    // PlistBuddy "Add" fails if the key already exists, which leaves stale
    // values from a previous run. Use "Delete" then "Add" for each key so we
    // always write the current values. Delete failures (key doesn't exist) are
    // expected and harmless.
    let keys: Vec<(String, String)> = {
        let mut k = vec![
            (
                format!(":{base}:UITargetAppBundleIdentifier"),
                format!("string {target_bundle_id}"),
            ),
            (
                format!(":{base}:EnvironmentVariables:TAPSMITH_TARGET_BUNDLE_ID"),
                format!("string {target_bundle_id}"),
            ),
            (
                format!(":{base}:EnvironmentVariables:TAPSMITH_AGENT_PORT"),
                format!("string {agent_port}"),
            ),
            (
                format!(":{base}:TestingEnvironmentVariables:TAPSMITH_TARGET_BUNDLE_ID"),
                format!("string {target_bundle_id}"),
            ),
            (
                format!(":{base}:TestingEnvironmentVariables:TAPSMITH_AGENT_PORT"),
                format!("string {agent_port}"),
            ),
        ];
        if attach_to_running_app {
            k.push((
                format!(":{base}:EnvironmentVariables:TAPSMITH_ATTACH_TO_RUNNING_APP"),
                "string 1".to_string(),
            ));
            k.push((
                format!(":{base}:TestingEnvironmentVariables:TAPSMITH_ATTACH_TO_RUNNING_APP"),
                "string 1".to_string(),
            ));
        }
        k
    };

    // First pass: delete all keys (failures are expected if keys don't exist yet)
    let mut del_cmd = tokio::process::Command::new(plist_buddy);
    for (key, _) in &keys {
        del_cmd.arg("-c").arg(format!("Delete {key}"));
    }
    del_cmd.arg(&patched_path);
    let _ = del_cmd.output().await;

    // Second pass: add all keys (failures here are real errors)
    let mut add_cmd = tokio::process::Command::new(plist_buddy);
    for (key, type_and_value) in &keys {
        add_cmd.arg("-c").arg(format!("Add {key} {type_and_value}"));
    }
    add_cmd.arg(&patched_path);
    let output = add_cmd.output().await.context("Failed to run PlistBuddy")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("PlistBuddy failed to patch xctestrun: {stderr}");
    }

    info!("Patched xctestrun at {patched_path}");
    Ok(patched_path)
}

/// Replace `__TAPSMITH_PKG__` placeholders in a patched xctestrun plist with the
/// directory that contains the original (unpatched) xctestrun. The prebuilt npm
/// packages use this placeholder to avoid baking in CI-machine absolute paths.
///
/// Uses the `plist` crate to parse and rewrite the plist properly, avoiding XML
/// entity-escaping issues that raw text replacement would hit if the resolved
/// path contained `&`, `<`, or `>`.
async fn resolve_pkg_placeholders(patched_path: &str, original_path: &str) -> Result<()> {
    let bytes = tokio::fs::read(patched_path)
        .await
        .context("Failed to read patched xctestrun")?;
    if !bytes.windows(16).any(|w| w == b"__TAPSMITH_PKG__") {
        return Ok(());
    }

    let pkg_dir = std::path::Path::new(original_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut value: plist::Value =
        plist::from_bytes(&bytes).context("Failed to parse xctestrun plist")?;

    if replace_in_plist_value(&mut value, "__TAPSMITH_PKG__", &pkg_dir) {
        let mut buf = Vec::new();
        plist::to_writer_xml(&mut buf, &value).context("Failed to serialize plist")?;
        tokio::fs::write(patched_path, buf)
            .await
            .context("Failed to write resolved xctestrun")?;
        info!("Resolved __TAPSMITH_PKG__ → {pkg_dir}");
    }

    Ok(())
}

fn replace_in_plist_value(v: &mut plist::Value, from: &str, to: &str) -> bool {
    match v {
        plist::Value::String(s) if s.contains(from) => {
            *s = s.replace(from, to);
            true
        }
        plist::Value::Array(arr) => {
            let mut changed = false;
            for item in arr.iter_mut() {
                changed |= replace_in_plist_value(item, from, to);
            }
            changed
        }
        plist::Value::Dictionary(dict) => {
            let mut changed = false;
            for item in dict.values_mut() {
                changed |= replace_in_plist_value(item, from, to);
            }
            changed
        }
        _ => false,
    }
}

/// Strip any `.{mode}.port{N}.patched.xctestrun` suffixes that previous runs
/// may have appended, returning the original source path (or the input
/// unchanged if it doesn't look patched). Conservative: only matches the exact
/// suffix pattern Tapsmith itself generates.
fn strip_patched_suffixes(path: &str) -> String {
    let mut current = path.to_string();
    loop {
        let Some(stripped) = current.strip_suffix(".patched.xctestrun") else {
            return current;
        };
        // Match `.launch.portNNNN` or `.attach.portNNNN`
        let Some(dot_idx) = stripped.rfind('.') else {
            return current;
        };
        let port_segment = &stripped[dot_idx + 1..];
        if !port_segment.starts_with("port")
            || port_segment.len() <= 4
            || !port_segment[4..].chars().all(|c| c.is_ascii_digit())
        {
            return current;
        }
        let without_port = &stripped[..dot_idx];
        let Some(mode_idx) = without_port.rfind('.') else {
            return current;
        };
        let mode_segment = &without_port[mode_idx + 1..];
        if mode_segment != "launch" && mode_segment != "attach" {
            return current;
        }
        current = without_port[..mode_idx].to_string();
    }
}

/// What is listening on an agent port, as far as the host can tell: the
/// command lines of the listening processes.
struct AgentPortListeners(Vec<String>);

/// Whose runner is on the agent port, judged against the device we want.
#[derive(Debug, PartialEq, Eq)]
enum AgentPortOwner {
    /// A listener serves this device.
    Serves,
    /// The only device a listener names is another one.
    Other(String),
    /// An `adb forward` (an Android device's agent) and no runner.
    AdbForward,
    /// Nothing identifies a device (no `lsof`, an unfamiliar listener):
    /// adopted as before, since refusing would break every such host.
    Unknown,
}

impl AgentPortListeners {
    fn judge(&self, udid: &str) -> AgentPortOwner {
        let mut other = None;
        let mut adb = false;
        for command in &self.0 {
            match device_in_listener_command(command) {
                Some(found) if found.eq_ignore_ascii_case(udid) => return AgentPortOwner::Serves,
                Some(found) => other = other.or_else(|| Some(found.to_string())),
                // An Android session's `adb forward` on this port answers the
                // ping with its own agent's pong. A stale one was removed
                // before the ping; this one could not be.
                None if is_adb_command(command) => adb = true,
                None => {}
            }
        }
        match other {
            Some(other) => AgentPortOwner::Other(other),
            None if adb => AgentPortOwner::AdbForward,
            None => AgentPortOwner::Unknown,
        }
    }
}

impl AgentPortListeners {
    /// Whether the adb server is one of the listeners — an `adb forward`.
    fn has_adb(&self) -> bool {
        self.0.iter().any(|command| is_adb_command(command))
    }
}

/// Remove the `adb forward`s on `port` that no live Tapsmith daemon is using
/// — left behind by an Android run whose daemon was killed before it could
/// remove its own. Refuses, with what to do, when a live daemon uses the port
/// or the forwards cannot be read.
async fn clear_stale_adb_forwards(port: u16) -> Result<()> {
    let manual = format!("adb forward --remove tcp:{port}");
    let list = adb_forward_list().await.with_context(|| {
        format!(
            "The iOS agent port {port} is taken by an adb port forward, and the forwards \
             could not be listed. Remove it with `{manual}`, then run again."
        )
    })?;
    let serials = forwards_on_port(&list, port);
    if serials.is_empty() {
        // adb listens on the port without a forward to show for it (a
        // forward set up by another adb server, or a race with its removal).
        return Ok(());
    }
    let devices = serials.join(", ");
    let daemons = match running_processes().await {
        Ok(ps) => daemons_on_agent_port(&ps, port, std::process::id()),
        Err(e) => bail!(
            "The iOS agent port {port} is taken by an adb port forward to {devices}, and \
             whether a Tapsmith session is using it could not be checked ({e:#}). If none \
             is, remove it with `{manual}`, then run again."
        ),
    };
    if let Some(pid) = daemons.first() {
        bail!(
            "The iOS agent port {port} is taken by an adb port forward to {devices}, which the \
             Tapsmith daemon with pid {pid} uses for its agent. Stop that Tapsmith \
             session, then run again."
        );
    }
    for serial in &serials {
        crate::adb::remove_forward_with_timeout(serial, port, Duration::from_secs(5))
            .await
            .with_context(|| {
                format!(
                    "The iOS agent port {port} is taken by a stale adb port forward to {serial} \
                     that could not be removed. Remove it with `adb -s {serial} forward --remove \
                     tcp:{port}`, then run again."
                )
            })?;
        info!(
            serial,
            port, "Removed a stale adb port forward left on the iOS agent port by an Android run"
        );
    }
    Ok(())
}

async fn adb_forward_list() -> Result<String> {
    crate::adb::list_forwards(Duration::from_secs(5)).await
}

/// Every process's pid and command line (`ps -A -ww -o pid=,args=`).
async fn running_processes() -> Result<String> {
    let out = Command::new("ps")
        .args(["-A", "-ww", "-o", "pid=,args="])
        .output()
        .await
        .context("ps could not be run")?;
    if !out.status.success() {
        bail!("ps exited with {}", out.status);
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The serials whose forward's host side is `tcp:<port>`, from
/// `adb forward --list` output.
fn forwards_on_port(list: &str, port: u16) -> Vec<String> {
    let local = format!("tcp:{port}");
    list.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let serial = fields.next()?;
            (fields.next()? == local).then(|| serial.to_string())
        })
        .collect()
}

/// The pids of the `tapsmith-core` daemons, other than `self_pid`, whose
/// agent port is `port` (`--agent-port`, else the default), from
/// `ps -A -ww -o pid=,args=` output.
fn daemons_on_agent_port(ps: &str, port: u16, self_pid: u32) -> Vec<u32> {
    const PROGRAM: &str = "tapsmith-core";
    const DEFAULT_AGENT_PORT: u16 = 18700;
    ps.lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let (pid, command) = line.split_once(char::is_whitespace)?;
            let pid: u32 = pid.parse().ok()?;
            if pid == self_pid {
                return None;
            }
            let command = command.trim_start();
            // The program, possibly a path (which may hold spaces): its
            // basename is the binary's name, followed by the arguments.
            let at = command.match_indices(PROGRAM).map(|(i, _)| i).find(|&i| {
                let prefix = &command[..i];
                let rest = &command[i + PROGRAM.len()..];
                (prefix.is_empty() || (prefix.starts_with('/') && prefix.ends_with('/')))
                    && (rest.is_empty() || rest.starts_with(' '))
            })?;
            let mut args = command[at + PROGRAM.len()..].split_whitespace();
            let mut agent_port = DEFAULT_AGENT_PORT;
            while let Some(arg) = args.next() {
                if arg == "--agent-port" {
                    agent_port = args.next()?.parse().ok()?;
                } else if let Some(value) = arg.strip_prefix("--agent-port=") {
                    agent_port = value.parse().ok()?;
                }
            }
            (agent_port == port).then_some(pid)
        })
        .collect()
}

/// Whether a listener's command line is the adb server (`adb … fork-server …`).
fn is_adb_command(command: &str) -> bool {
    command
        .split_whitespace()
        .next()
        .is_some_and(|program| program == "adb" || program.ends_with("/adb"))
}

/// The device a process listening on an agent port serves, read from its
/// command line: a simulator runner runs from its simulator's data directory
/// (`…/CoreSimulator/Devices/<UDID>/data/…`), and a physical device's agent
/// port is an `iproxy --udid <UDID> …` tunnel.
fn device_in_listener_command(command: &str) -> Option<&str> {
    const SIM_MARKER: &str = "CoreSimulator/Devices/";
    if let Some(idx) = command.find(SIM_MARKER) {
        let rest = &command[idx + SIM_MARKER.len()..];
        let udid = rest.split('/').next().unwrap_or("");
        if !udid.is_empty() {
            return Some(udid);
        }
    }
    if command.contains("iproxy") {
        let mut words = command.split_whitespace();
        while let Some(word) = words.next() {
            if word == "--udid" || word == "-u" {
                return words.next();
            }
            if let Some(udid) = word.strip_prefix("--udid=") {
                return Some(udid);
            }
        }
    }
    None
}

/// The command lines of the processes listening on `127.0.0.1:port`. Empty
/// when they cannot be read (no `lsof`, nothing listening).
async fn agent_port_listeners(port: u16) -> AgentPortListeners {
    let pids = match Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
        .await
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .collect::<Vec<_>>(),
        Err(e) => {
            debug!(port, error = %e, "lsof unavailable; cannot tell whose agent is on the port");
            Vec::new()
        }
    };
    let mut commands = Vec::new();
    for pid in pids {
        if let Ok(out) = Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
            .await
        {
            let command = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !command.is_empty() {
                commands.push(command);
            }
        }
    }
    AgentPortListeners(commands)
}

/// Ping the iOS agent to check if it's running.
async fn ping_agent(port: u16) -> Result<()> {
    let addr = format!("127.0.0.1:{port}");
    let stream = tokio::time::timeout(Duration::from_secs(2), TcpStream::connect(&addr))
        .await
        .map_err(|_| anyhow::anyhow!("Connection timeout"))?
        .context("Failed to connect")?;

    // Send a ping command
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (reader, mut writer) = stream.into_split();
    let mut buf_reader = BufReader::new(reader);

    let ping_msg = r#"{"id":"ping","method":"ping","params":{}}"#;
    writer.write_all(format!("{ping_msg}\n").as_bytes()).await?;

    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(5), buf_reader.read_line(&mut response))
        .await
        .map_err(|_| anyhow::anyhow!("Ping response timeout"))??;

    if response.contains("pong") {
        Ok(())
    } else {
        bail!("Unexpected ping response: {response}")
    }
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;

    #[test]
    fn architecture_mismatch_hint_reads_xcodes_refusal() {
        // As xcodebuild 27 prints it for an x86_64 agent on an arm64 simulator.
        let stderr = "2026-10-06 17:23:25.190 xcodebuild[94771:85729760] [MT] DVTDevice: \
                      No architectures intersection between iPhone 17 ({(\n\
                      xcodebuild: error: Failed to build workspace TapsmithAgent with scheme \
                      TapsmithAgentUITests.: Cannot test target \u{201c}TapsmithAgentUITests\u{201d} \
                      on \u{201c}iPhone 17\u{201d}: iPhone 17 cannot run TapsmithAgentUITests. \
                      TapsmithAgentUITests's architectures (Intel 64-bit) include none that \
                      iPhone 17 can execute (arm64).";
        let hint = architecture_mismatch_hint("", stderr).expect("a hint");
        assert!(hint.contains("Rosetta"));
        assert!(hint.contains("arm64 Node"));
        assert!(
            architecture_mismatch_hint("include none that iPhone 17 can execute", "").is_some()
        );
    }

    // As the runner prints it (TapsmithAgentRunner's XCUIApplication.launch())
    // when the target app is not installed on the simulator.
    const RUNNER_LAUNCH_FAILURE: &str =
        "/tmp/wt/ios-agent/TapsmithAgent/TapsmithAgentRunner.swift:105: \
        error: -[TapsmithAgentUITests.TapsmithAgentRunner testRunAgent] : Failed to launch \
        com.example.ShopNotes: The request to open \"com.example.ShopNotes\" failed. \
        (Underlying Error: The operation couldn\u{2019}t be completed. Application info provider \
        (FBSApplicationLibrary) returned nil for \"com.example.ShopNotes\")";

    #[test]
    fn runner_launch_failure_reads_the_runners_error_for_the_target_app() {
        let error = runner_launch_failure(RUNNER_LAUNCH_FAILURE, "com.example.ShopNotes")
            .expect("the runner's launch failure");
        assert!(error.starts_with("Failed to launch com.example.ShopNotes: The request to open"));
        assert!(error.contains("FBSApplicationLibrary"));
    }

    #[test]
    fn runner_launch_failure_ignores_other_lines_and_other_apps() {
        assert!(runner_launch_failure(
            "    t =     0.25s     Launch com.example.ShopNotes",
            "com.example.ShopNotes"
        )
        .is_none());
        assert!(runner_launch_failure(RUNNER_LAUNCH_FAILURE, "com.example.Other").is_none());
        // A prefix of another bundle id is not this app.
        assert!(runner_launch_failure(RUNNER_LAUNCH_FAILURE, "com.example.Shop").is_none());
        assert!(runner_launch_failure(RUNNER_LAUNCH_FAILURE, "").is_none());
    }

    #[test]
    fn app_launch_failure_message_says_the_app_is_missing() {
        let error = runner_launch_failure(RUNNER_LAUNCH_FAILURE, "com.example.ShopNotes").unwrap();
        let message = app_launch_failure_message(
            "simulator",
            "SIM-1",
            "com.example.ShopNotes",
            error,
            Some(false),
        );
        assert!(message.contains("could not launch com.example.ShopNotes on simulator SIM-1"));
        assert!(message.contains("Failed to launch com.example.ShopNotes: The request to open"));
        assert!(message.contains("com.example.ShopNotes is not installed on this simulator"));
        assert!(message.contains("`app`"));
        assert!(message.contains("`package`"));
    }

    #[test]
    fn app_launch_failure_message_keeps_only_the_runners_reason_when_installed() {
        let message = app_launch_failure_message(
            "device",
            "PHONE",
            "com.x",
            "Failed to launch com.x: boom",
            None,
        );
        assert!(message
            .contains("could not launch com.x on device PHONE: Failed to launch com.x: boom"));
        assert!(!message.contains("not installed"));
        let installed = app_launch_failure_message(
            "simulator",
            "SIM",
            "com.x",
            "Failed to launch com.x: boom",
            Some(true),
        );
        assert!(!installed.contains("not installed"));
    }

    #[test]
    fn architecture_mismatch_hint_ignores_other_failures() {
        assert!(
            architecture_mismatch_hint("** TEST EXECUTE FAILED **", "Testing failed").is_none()
        );
    }

    /// Minimal xctestrun fixture: only the keys patch_xctestrun touches must
    /// exist in the parent path. Empty EnvironmentVariables/TestingEnvironmentVariables
    /// dicts are required because PlistBuddy `Add` cannot create intermediate keys.
    const FIXTURE_EMPTY: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>TestConfigurations</key>
  <array>
    <dict>
      <key>TestTargets</key>
      <array>
        <dict>
          <key>EnvironmentVariables</key>
          <dict/>
          <key>TestingEnvironmentVariables</key>
          <dict/>
        </dict>
      </array>
    </dict>
  </array>
</dict>
</plist>
"#;

    /// Same as FIXTURE_EMPTY but pre-populated with stale values, to verify
    /// the delete-then-add semantics.
    const FIXTURE_WITH_STALE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>TestConfigurations</key>
  <array>
    <dict>
      <key>TestTargets</key>
      <array>
        <dict>
          <key>UITargetAppBundleIdentifier</key>
          <string>com.stale.bundle</string>
          <key>EnvironmentVariables</key>
          <dict>
            <key>TAPSMITH_AGENT_PORT</key>
            <string>9999</string>
            <key>TAPSMITH_TARGET_BUNDLE_ID</key>
            <string>com.stale.bundle</string>
          </dict>
          <key>TestingEnvironmentVariables</key>
          <dict>
            <key>TAPSMITH_AGENT_PORT</key>
            <string>9999</string>
            <key>TAPSMITH_TARGET_BUNDLE_ID</key>
            <string>com.stale.bundle</string>
          </dict>
        </dict>
      </array>
    </dict>
  </array>
</dict>
</plist>
"#;

    async fn write_fixture(contents: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.xctestrun");
        tokio::fs::write(&path, contents).await.unwrap();
        (dir, path)
    }

    #[tokio::test]
    async fn patch_xctestrun_launch_mode_injects_bundle_id_and_port() {
        let (_dir, path) = write_fixture(FIXTURE_EMPTY).await;

        let patched_path = patch_xctestrun(path.to_str().unwrap(), "com.example.app", false, 18800)
            .await
            .expect("patch should succeed");

        assert!(
            patched_path.ends_with(".launch.port18800.patched.xctestrun"),
            "unexpected patched path: {patched_path}"
        );
        let contents = tokio::fs::read_to_string(&patched_path).await.unwrap();
        assert!(contents.contains("com.example.app"));
        assert!(contents.contains("18800"));
        assert!(contents.contains("TAPSMITH_AGENT_PORT"));
        assert!(contents.contains("TAPSMITH_TARGET_BUNDLE_ID"));
        assert!(contents.contains("UITargetAppBundleIdentifier"));
        // Launch mode must NOT inject the attach flag.
        assert!(!contents.contains("TAPSMITH_ATTACH_TO_RUNNING_APP"));
    }

    #[tokio::test]
    async fn patch_xctestrun_attach_mode_sets_attach_flag() {
        let (_dir, path) = write_fixture(FIXTURE_EMPTY).await;

        let patched_path = patch_xctestrun(path.to_str().unwrap(), "com.example.app", true, 19000)
            .await
            .expect("patch should succeed");

        assert!(
            patched_path.ends_with(".attach.port19000.patched.xctestrun"),
            "unexpected patched path: {patched_path}"
        );
        let contents = tokio::fs::read_to_string(&patched_path).await.unwrap();
        assert!(contents.contains("TAPSMITH_ATTACH_TO_RUNNING_APP"));
        assert!(contents.contains("19000"));
    }

    #[tokio::test]
    async fn patch_xctestrun_replaces_existing_env_values() {
        // Critical: a source plist that already contains stale values from a
        // previous run must be cleanly overwritten by the delete-then-add
        // sequence — otherwise the runner would keep the wrong port/bundle id.
        let (_dir, path) = write_fixture(FIXTURE_WITH_STALE).await;

        let patched_path =
            patch_xctestrun(path.to_str().unwrap(), "com.fresh.bundle", false, 18800)
                .await
                .expect("patch should succeed");

        let contents = tokio::fs::read_to_string(&patched_path).await.unwrap();
        assert!(contents.contains("com.fresh.bundle"));
        assert!(contents.contains("18800"));
        // Stale values must be gone.
        assert!(
            !contents.contains("com.stale.bundle"),
            "stale bundle id leaked into patched plist:\n{contents}"
        );
        assert!(
            !contents.contains("9999"),
            "stale port leaked into patched plist:\n{contents}"
        );
    }

    #[tokio::test]
    async fn patch_xctestrun_per_port_paths_do_not_collide() {
        // Two parallel workers using the same source xctestrun must produce
        // distinct patched files so they can't stomp on each other.
        let (_dir, path) = write_fixture(FIXTURE_EMPTY).await;
        let src = path.to_str().unwrap();

        let p1 = patch_xctestrun(src, "com.example.app", false, 18800)
            .await
            .unwrap();
        let p2 = patch_xctestrun(src, "com.example.app", false, 18801)
            .await
            .unwrap();
        let p3 = patch_xctestrun(src, "com.example.app", true, 18800)
            .await
            .unwrap();
        assert_ne!(p1, p2);
        assert_ne!(p1, p3);
        assert_ne!(p2, p3);
    }

    #[tokio::test]
    async fn patch_xctestrun_missing_source_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let bogus = dir.path().join("does-not-exist.xctestrun");

        let result =
            patch_xctestrun(bogus.to_str().unwrap(), "com.example.app", false, 18800).await;
        assert!(result.is_err(), "expected error for missing source file");
    }

    #[test]
    fn strip_patched_suffixes_handles_clean_path() {
        let p = "/tmp/Foo.xctestrun";
        assert_eq!(strip_patched_suffixes(p), p);
    }

    #[test]
    fn strip_patched_suffixes_strips_single_suffix() {
        assert_eq!(
            strip_patched_suffixes("/tmp/Foo.xctestrun.launch.port18800.patched.xctestrun"),
            "/tmp/Foo.xctestrun"
        );
        assert_eq!(
            strip_patched_suffixes("/tmp/Foo.xctestrun.attach.port19000.patched.xctestrun"),
            "/tmp/Foo.xctestrun"
        );
    }

    #[test]
    fn strip_patched_suffixes_strips_chained_suffixes() {
        let chained =
            "/tmp/Foo.xctestrun.launch.port18800.patched.xctestrun.launch.port18802.patched.xctestrun";
        assert_eq!(strip_patched_suffixes(chained), "/tmp/Foo.xctestrun");
    }

    #[test]
    fn strip_patched_suffixes_leaves_unrecognized_alone() {
        // Wrong mode word — must not strip.
        let p = "/tmp/Foo.xctestrun.weird.port18800.patched.xctestrun";
        assert_eq!(strip_patched_suffixes(p), p);
        // Non-numeric port — must not strip.
        let q = "/tmp/Foo.xctestrun.launch.portABC.patched.xctestrun";
        assert_eq!(strip_patched_suffixes(q), q);
    }

    const SIM_A: &str = "11111111-2222-3333-4444-555555555555";
    const SIM_B: &str = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

    fn runner_command(udid: &str) -> String {
        format!(
            "/Users/me/Library/Developer/CoreSimulator/Devices/{udid}/data/Containers/Bundle/\
             Application/X/TapsmithAgentUITests-Runner.app/TapsmithAgentUITests-Runner"
        )
    }

    #[test]
    fn agent_port_owner_adopts_this_simulators_runner() {
        let listeners = AgentPortListeners(vec![runner_command(SIM_A)]);
        assert_eq!(listeners.judge(SIM_A), AgentPortOwner::Serves);
    }

    #[test]
    fn agent_port_owner_names_another_simulators_runner() {
        let listeners = AgentPortListeners(vec![runner_command(SIM_B)]);
        assert_eq!(
            listeners.judge(SIM_A),
            AgentPortOwner::Other(SIM_B.to_string())
        );
    }

    #[test]
    fn agent_port_owner_reads_an_iproxy_tunnel_udid() {
        let tunnel = AgentPortListeners(vec!["iproxy --udid 00008110-ABC 18700:18700".to_string()]);
        assert_eq!(tunnel.judge("00008110-ABC"), AgentPortOwner::Serves);
        assert_eq!(
            tunnel.judge("00008110-XYZ"),
            AgentPortOwner::Other("00008110-ABC".to_string())
        );
        let short = AgentPortListeners(vec![
            "/opt/homebrew/bin/iproxy -u 0000-DEF 18700:18700".to_string()
        ]);
        assert_eq!(short.judge("0000-DEF"), AgentPortOwner::Serves);
    }

    #[test]
    fn agent_port_owner_refuses_an_adb_forward_on_the_port() {
        let listeners = AgentPortListeners(vec![
            "adb -L tcp:5037 fork-server server --reply-fd 4".to_string()
        ]);
        assert_eq!(listeners.judge(SIM_A), AgentPortOwner::AdbForward);
        // A runner naming another device is the more specific owner.
        let both = AgentPortListeners(vec![
            "adb -L tcp:5037 fork-server server --reply-fd 4".to_string(),
            runner_command(SIM_B),
        ]);
        assert_eq!(both.judge(SIM_A), AgentPortOwner::Other(SIM_B.to_string()));
    }

    #[test]
    fn agent_port_owner_is_unknown_when_nothing_names_a_device() {
        assert_eq!(
            AgentPortListeners(vec![]).judge(SIM_A),
            AgentPortOwner::Unknown
        );
        let unrelated =
            AgentPortListeners(vec!["/usr/local/bin/some-server --port 18700".to_string()]);
        assert_eq!(unrelated.judge(SIM_A), AgentPortOwner::Unknown);
    }

    #[test]
    fn agent_port_owner_prefers_a_listener_serving_this_device() {
        // Two listeners (an IPv4 and an IPv6 socket of different processes):
        // one of them serving this device is enough.
        let listeners = AgentPortListeners(vec![runner_command(SIM_B), runner_command(SIM_A)]);
        assert_eq!(listeners.judge(SIM_A), AgentPortOwner::Serves);
    }

    #[test]
    fn agent_port_listeners_notice_an_adb_forward() {
        let adb = AgentPortListeners(vec![
            "/opt/android/platform-tools/adb -L tcp:5037 fork-server server --reply-fd 4"
                .to_string(),
        ]);
        assert!(adb.has_adb());
        assert!(!AgentPortListeners(vec![runner_command(SIM_A)]).has_adb());
        assert!(!AgentPortListeners(vec![]).has_adb());
    }

    #[test]
    fn forwards_on_port_reads_the_host_side_only() {
        let list = "emulator-5554 tcp:18700 tcp:18700\n\
                    emulator-5556 tcp:18701 tcp:18700\n\
                    R58M123 tcp:18700 tcp:18700\n\
                    emulator-5554 tcp:9222 localabstract:webview_devtools_remote_1\n";
        assert_eq!(
            forwards_on_port(list, 18700),
            vec!["emulator-5554".to_string(), "R58M123".to_string()]
        );
        assert_eq!(
            forwards_on_port(list, 18701),
            vec!["emulator-5556".to_string()]
        );
        assert!(forwards_on_port("", 18700).is_empty());
    }

    #[test]
    fn daemons_on_agent_port_reads_daemon_command_lines() {
        let ps = "  101 /usr/local/lib/node_modules/@tapsmith/core-darwin-arm64/tapsmith-core --port 50051 --platform android\n\
                    102 tapsmith-core --port 50961 --agent-port 18700\n\
                    103 /repo/target/release/tapsmith-core --port 50070 --agent-port 18800\n\
                    104 /bin/zsh -c grep tapsmith-core --agent-port 18700\n\
                    105 /Users/me/My Tools/tapsmith-core --port 50052\n\
                    106 /repo/target/release/tapsmith-core-helper --port 50053\n";
        // 101 and 105 run on the default agent port; 102 names it; 103 is on
        // another; 104 is not a daemon; 106 is another binary.
        assert_eq!(daemons_on_agent_port(ps, 18700, 999), vec![101, 102, 105]);
        assert_eq!(daemons_on_agent_port(ps, 18800, 999), vec![103]);
        // The daemon asking is never its own competitor.
        assert_eq!(daemons_on_agent_port(ps, 18700, 102), vec![101, 105]);
        assert!(daemons_on_agent_port(ps, 18900, 999).is_empty());
    }

    #[test]
    fn derived_data_path_is_stable_per_udid() {
        // Same udid → same path on repeated calls (so xcodebuild reuses
        // the same DerivedData dir instead of leaking a fresh one each run).
        let p1 = derived_data_path_for("ABC-123");
        let p2 = derived_data_path_for("ABC-123");
        assert_eq!(p1, p2);
    }

    #[test]
    fn derived_data_path_is_distinct_per_udid() {
        // Different simulators → different paths so parallel workers don't
        // race on a shared DerivedData directory.
        let p1 = derived_data_path_for("ABC-123");
        let p2 = derived_data_path_for("DEF-456");
        assert_ne!(p1, p2);
    }

    #[test]
    fn derived_data_path_lives_under_temp() {
        // Stays out of the user's $HOME so it's auto-cleaned by the OS and
        // can't pollute Xcode's standard DerivedData dir.
        let p = derived_data_path_for("ABC-123");
        assert!(
            p.starts_with(std::env::temp_dir()),
            "expected path under temp_dir, got {p:?}"
        );
        assert!(p.ends_with("ABC-123"));
    }

    #[tokio::test]
    async fn clear_prior_xcresults_removes_existing_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let test_logs = dir.path().join("Logs").join("Test");
        let bundle = test_logs.join("Test-TapsmithAgentUITests-2026.04.09_12-00-00.xcresult");
        tokio::fs::create_dir_all(&bundle).await.unwrap();
        tokio::fs::write(bundle.join("Info.plist"), "fake")
            .await
            .unwrap();
        assert!(bundle.exists());

        clear_prior_xcresults(dir.path()).await.unwrap();

        assert!(
            !test_logs.exists(),
            "Logs/Test should be removed but still exists"
        );
    }

    #[tokio::test]
    async fn clear_prior_xcresults_is_noop_when_missing() {
        // First-ever run won't have a prior Logs/Test dir; this must not
        // surface as an error or the agent launch path would fail.
        let dir = tempfile::tempdir().unwrap();
        clear_prior_xcresults(dir.path())
            .await
            .expect("missing path should be a no-op");
    }
}
