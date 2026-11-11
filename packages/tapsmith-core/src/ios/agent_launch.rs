use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::net::TcpStream;
use tokio::process::Command;
use tracing::{debug, info, instrument, warn};

use super::agent_registry::TrackedAgent;
use super::iproxy::{kill_stray_iproxy, IproxyHandle};
use super::launch_gate::{self, LaunchGate, Prepared};

/// What [`start_agent`] did.
pub struct AgentStart {
    /// For physical devices: the USB tunnel, which the caller must keep for
    /// the lifetime of the agent. `None` for simulators and for a reused agent.
    pub iproxy: Option<IproxyHandle>,
    /// The runner launched the app under test as part of this start, after
    /// wiping its data when that was asked for (see [`launch_gate`]).
    pub app_launched_fresh: bool,
}

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
/// The returned [`AgentStart::iproxy`] is `Some` for physical devices — the
/// caller must store the handle for the lifetime of the agent so the USB
/// tunnel stays alive. For simulators (and for the fast-path case where an
/// existing agent is already responding) it is `None` and the caller keeps any
/// existing tracking state unchanged.
///
/// `clear_app_data_first`: on a simulator, wipe the app's data while
/// xcodebuild starts, before the runner launches it (see [`launch_gate`]).
#[instrument(skip(xctestrun_path, target_bundle_id))]
pub async fn start_agent(
    udid: &str,
    xctestrun_path: &str,
    target_bundle_id: &str,
    agent_port: u16,
    is_physical: bool,
    clear_app_data_first: bool,
) -> Result<AgentStart> {
    start_agent_impl(
        udid,
        xctestrun_path,
        target_bundle_id,
        StartMode {
            force: false,
            attach_to_running_app: false,
            clear_app_data_first,
            apply_simulator_defaults: true,
        },
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
        StartMode {
            force: true,
            attach_to_running_app: true,
            clear_app_data_first: false,
            // A restart within a session: the session's start applied them.
            apply_simulator_defaults: false,
        },
        agent_port,
        is_physical,
    )
    .await
    .map(|started| started.iproxy)
}

#[derive(Clone, Copy)]
struct StartMode {
    /// Start a runner even if one answers on the port.
    force: bool,
    /// The runner attaches to the running app instead of launching it.
    attach_to_running_app: bool,
    clear_app_data_first: bool,
    /// On a simulator, write the test-friendly defaults
    /// ([`super::device::configure_simulator`]) alongside the launch.
    apply_simulator_defaults: bool,
}

/// The simulator's test-friendly defaults (password autofill off), written
/// while the agent starts instead of before it (PILOT-1134): on a just-booted
/// CI simulator the `simctl spawn defaults write` calls took 13–16 s, all of
/// it in front of the xcodebuild spawn. The app under test must still never
/// launch before they are written, so the launch gate waits for them (see
/// [`GatedLaunch`]), and the agent start does not return before them.
struct SimulatorDefaults {
    done: tokio::sync::watch::Receiver<bool>,
}

impl SimulatorDefaults {
    fn start(udid: &str) -> Self {
        let udid = udid.to_string();
        Self::start_with(async move { super::device::configure_simulator(&udid).await })
    }

    /// [`SimulatorDefaults::start`] with the writes passed in.
    fn start_with(write: impl std::future::Future<Output = ()> + Send + 'static) -> Self {
        let (tx, done) = tokio::sync::watch::channel(false);
        tokio::spawn(async move {
            write.await;
            let _ = tx.send(true);
        });
        Self { done }
    }

    /// Wait until the writes are done. They are bounded
    /// ([`super::device::configure_simulator`]); a task that died without
    /// finishing (its sender dropped) does not hold anyone up either.
    async fn applied(&self) {
        let mut done = self.done.clone();
        let _ = done.wait_for(|d| *d).await;
    }

    fn clone_handle(&self) -> Self {
        Self {
            done: self.done.clone(),
        }
    }
}

/// A launch gate and the task that opens it (see [`launch_gate`]).
struct GatedLaunch {
    gate: LaunchGate,
    task: Option<tokio::task::JoinHandle<Option<Prepared>>>,
    prepared: Option<Prepared>,
    /// xcodebuild was relaunched in place after the gate opened.
    relaunched: bool,
}

impl GatedLaunch {
    /// Terminate the app (a running instance makes the runner's `launch()`
    /// race its own terminate — the classic "Timed out attempting to launch
    /// app" on a busy SpringBoard) and, when asked, wipe its data, then open
    /// the gate. All of it overlaps xcodebuild's start, seconds before the
    /// runner's test even begins.
    fn start(
        udid: &str,
        target_bundle_id: &str,
        agent_port: u16,
        wipe: bool,
        defaults: Option<SimulatorDefaults>,
    ) -> Self {
        let udid = udid.to_string();
        let bundle_id = target_bundle_id.to_string();
        Self::start_with(
            LaunchGate::new_in(&std::env::temp_dir(), agent_port),
            async move { prepare_app_launch(&udid, &bundle_id, wipe).await },
            launch_gate::PREPARE_DEADLINE,
            defaults,
        )
    }

    /// [`GatedLaunch::start`] with the pre-launch work and its deadline
    /// passed in. The gate opens once `prepare` is done, or at `deadline`
    /// (the start is then not vouched for), and in either case not before
    /// `defaults` are written. Those are not under `deadline`: abandoning them
    /// would let the app launch with password autofill on, and they are
    /// bounded on their own. Should they outlast the runner's own wait, the
    /// runner launches without the gate, and that start is not vouched for:
    /// the caller relaunches the app after the agent start, which waits for
    /// the defaults.
    fn start_with(
        gate: LaunchGate,
        prepare: impl std::future::Future<Output = Prepared> + Send + 'static,
        deadline: Duration,
        defaults: Option<SimulatorDefaults>,
    ) -> Self {
        let path = gate.path().to_path_buf();
        let task = tokio::spawn(async move {
            let started = std::time::Instant::now();
            let prepared = tokio::time::timeout(deadline, prepare).await.ok();
            let prepare_ms = started.elapsed().as_millis();
            if let Some(defaults) = &defaults {
                defaults.applied().await;
            }
            launch_gate::open_at(&path);
            crate::timing::timing_log!(
                "kind=boot name=launch_gate dur_ms={} prepare_ms={prepare_ms} prepared={:?}",
                started.elapsed().as_millis(),
                prepared
            );
            prepared
        });
        Self {
            gate,
            task: Some(task),
            prepared: None,
            relaunched: false,
        }
    }

    async fn settle(&mut self) {
        if let Some(task) = self.task.take() {
            self.prepared = task.await.ok().flatten();
        }
    }

    /// Before an in-place xcodebuild relaunch: let the task finish, and open
    /// the gate again (the first runner consumed it) so the new runner does not
    /// wait out its bound. That launch is no longer vouched for.
    async fn before_relaunch(&mut self) {
        self.settle().await;
        self.relaunched = true;
        self.gate.open();
    }

    async fn app_launched_fresh(&mut self) -> bool {
        self.settle().await;
        launch_gate::app_launched_fresh(self.prepared, self.gate.consumed(), self.relaunched)
    }
}

impl Drop for GatedLaunch {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// The launch gate's pre-launch work: terminate the app, then wipe it.
async fn prepare_app_launch(udid: &str, bundle_id: &str, wipe: bool) -> Prepared {
    if let Err(e) = super::device::terminate_app(udid, bundle_id).await {
        debug!(udid, error = %e, "pre-launch terminate of target app failed (may not be running)");
    }
    let wiped = wipe
        && match super::device::get_app_container(udid, bundle_id).await {
            Ok(container) => super::device::wipe_simulator_app_data(udid, &container).await,
            Err(e) => {
                debug!(udid, error = %e, "no app container to wipe before the launch");
                false
            }
        };
    Prepared {
        wipe_requested: wipe,
        wiped,
    }
}

async fn start_agent_impl(
    udid: &str,
    xctestrun_path: &str,
    target_bundle_id: &str,
    mode: StartMode,
    agent_port: u16,
    is_physical: bool,
) -> Result<AgentStart> {
    let StartMode {
        force,
        attach_to_running_app,
        clear_app_data_first,
        apply_simulator_defaults,
    } = mode;
    let boot_start = std::time::Instant::now();
    // First, so the writes overlap everything below; awaited before any
    // successful return, and by the launch gate before the app launches.
    let defaults =
        (apply_simulator_defaults && !is_physical).then(|| SimulatorDefaults::start(udid));
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
        let defaults_wait = std::time::Instant::now();
        if let Some(defaults) = &defaults {
            defaults.applied().await;
        }
        crate::timing::timing_log!(
            "kind=boot name=agent dur_ms={} reused=true defaults_wait_ms={} udid={udid}",
            boot_start.elapsed().as_millis(),
            defaults_wait.elapsed().as_millis()
        );
        // For physical devices, pingable-on-localhost means the caller's
        // iproxy tunnel is still up; no new handle is returned and the
        // caller's existing stored state remains authoritative. This runner
        // launched the app long ago: nothing here is fresh.
        return Ok(AgentStart {
            iproxy: None,
            app_launched_fresh: false,
        });
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

    // In launch mode on a simulator, the app is terminated (and wiped, when
    // asked) from the host while xcodebuild starts, and the runner waits for
    // that before launching it. Attach mode intentionally preserves the
    // running app; physical devices have no host-side terminate or wipe.
    let mut gated = if !is_physical && !attach_to_running_app && !target_bundle_id.is_empty() {
        Some(GatedLaunch::start(
            udid,
            target_bundle_id,
            agent_port,
            clear_app_data_first,
            defaults.as_ref().map(SimulatorDefaults::clone_handle),
        ))
    } else {
        None
    };

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
        gated.as_ref().map(|g| g.gate.path()),
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
    let pre_spawn_ms = boot_start.elapsed().as_millis();
    let (mut child, mut stdout_tail, mut stderr_tail, mut launch_failure, mut progress) =
        spawn_agent_xcodebuild(
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
            // Where the launch got to, for the timing log: on a starved CI
            // runner this is the line that says which step never came.
            crate::timing::timing_log!(
                "kind=boot name=agent dur_ms={} ok=false outcome=timeout pre_spawn_ms={pre_spawn_ms} {} relaunches={} udid={udid}",
                boot_start.elapsed().as_millis(),
                progress
                    .lock()
                    .unwrap()
                    .phase_fields(std::time::Instant::now(), "timeout"),
                1 - relaunches_left
            );
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
            // `None`: not known — a physical device, or a simctl that could
            // not be asked. Only a confirmed absence rules the relaunch out.
            let installed = if is_physical {
                None
            } else {
                super::device::is_app_installed(udid, target_bundle_id)
                    .await
                    .ok()
            };
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if may_relaunch_after_launch_failure(is_physical, installed)
                && relaunches_left > 0
                && remaining > Duration::from_secs(30)
            {
                relaunches_left -= 1;
                warn!(
                    udid,
                    error = %runner_error,
                    "XCUITest runner failed to launch the target app; relaunching once"
                );
                kill_existing_agents_on(udid).await;
                let _ = super::device::terminate_app(udid, target_bundle_id).await;
                if let Some(g) = gated.as_mut() {
                    g.before_relaunch().await;
                }
                (child, stdout_tail, stderr_tail, launch_failure, progress) =
                    spawn_agent_xcodebuild(
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
                if let Some(g) = gated.as_mut() {
                    g.before_relaunch().await;
                }
                (child, stdout_tail, stderr_tail, launch_failure, progress) =
                    spawn_agent_xcodebuild(
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
                    if let Some(g) = gated.as_mut() {
                        g.before_relaunch().await;
                    }
                    (child, stdout_tail, stderr_tail, launch_failure, progress) =
                        spawn_agent_xcodebuild(
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
                // The runner deleted the gate before launching, so by the time
                // it listens the answer is settled.
                let app_launched_fresh = match gated.as_mut() {
                    Some(g) => g.app_launched_fresh().await,
                    None => false,
                };
                let ready_at = std::time::Instant::now();
                // The gate waited for the defaults already; this covers a
                // start without one (no app to launch).
                if let Some(defaults) = &defaults {
                    defaults.applied().await;
                }
                info!(udid, app_launched_fresh, "iOS agent is ready");
                crate::timing::timing_log!(
                    "kind=boot name=agent dur_ms={} reused=false fresh_launch={app_launched_fresh} \
                     pre_spawn_ms={pre_spawn_ms} {} defaults_wait_ms={} relaunches={} udid={udid}",
                    boot_start.elapsed().as_millis(),
                    progress.lock().unwrap().phase_fields(ready_at, "ready"),
                    ready_at.elapsed().as_millis(),
                    1 - relaunches_left
                );
                // Hand the child off to a reaper task so the kernel can collect
                // it once xcodebuild eventually exits — without this, dropping
                // the Child without awaiting leaves a zombie until process exit.
                // The tracked handle stays registered until then, so a daemon
                // shutdown stops this agent (PILOT-299).
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                return Ok(AgentStart {
                    iproxy: iproxy_handle,
                    app_launched_fresh,
                });
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

/// Whether a runner that could not launch the app under test gets the one
/// in-place relaunch. A simulator app that is installed, or whose presence
/// could not be checked, may have hit a transient refusal; one simctl says is
/// missing never launches. Physical devices are not relaunched here: the
/// relaunch clears the stuck app with simctl, which cannot reach them.
fn may_relaunch_after_launch_failure(is_physical: bool, installed: Option<bool>) -> bool {
    !is_physical && installed != Some(false)
}

/// The agent-start error for an app the runner could not launch. `installed`
/// is whether the app is on the simulator (`None` where that is not known: a
/// physical device, or a simctl that could not be asked): a missing app is by far the commonest cause, and the
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
type LaunchProgressHandle = std::sync::Arc<std::sync::Mutex<LaunchProgress>>;

/// How far one xcodebuild agent launch got, and when, read from its output
/// (PILOT-1134), for the `kind=boot name=agent` timing line. Each step is the
/// first line that shows it; a step whose line never came (another Xcode's
/// wording, a runner that died) stays `None` and its phases are left out.
#[derive(Debug)]
struct LaunchProgress {
    spawned: std::time::Instant,
    /// xcodebuild printed anything at all (stdout or stderr).
    first_output: Option<std::time::Instant>,
    /// The runner process is up: its "Running tests..." line.
    runner_started: Option<std::time::Instant>,
    /// XCTest started the runner's test: "Test Case '…' started.".
    test_started: Option<std::time::Instant>,
    /// The agent's socket listens: "[TapsmithSocket] Listening on port".
    listening: Option<std::time::Instant>,
    /// The runner's own report of how long it waited at the launch gate.
    gate_waited_ms: Option<u64>,
}

impl LaunchProgress {
    fn new(spawned: std::time::Instant) -> Self {
        Self {
            spawned,
            first_output: None,
            runner_started: None,
            test_started: None,
            listening: None,
            gate_waited_ms: None,
        }
    }

    fn observe(&mut self, line: &str, at: std::time::Instant) {
        self.first_output.get_or_insert(at);
        if self.runner_started.is_none() && line.contains("Running tests...") {
            self.runner_started = Some(at);
        }
        if self.test_started.is_none() && line.contains("Test Case '") && line.contains("' started")
        {
            self.test_started = Some(at);
        }
        if self.listening.is_none() && line.contains("[TapsmithSocket] Listening on port") {
            self.listening = Some(at);
        }
        if self.gate_waited_ms.is_none() {
            if let Some(rest) = line.split("Launch gate: opened(waitedMs: ").nth(1) {
                self.gate_waited_ms = rest.split(')').next().and_then(|n| n.trim().parse().ok());
            }
        }
    }

    /// `spawn_to_output_ms=… output_to_runner_ms=… runner_to_test_ms=…
    /// test_to_listening_ms=… listening_to_ready_ms=… gate_waited_ms=…`. A
    /// step that was never seen is skipped, and the phase across it named by
    /// the steps on either side (`output_to_timeout_ms`).
    ///
    /// `end` is when the launch ended and `end_name` how (`ready` once the
    /// agent answered, or how it failed).
    fn phase_fields(&self, end: std::time::Instant, end_name: &'static str) -> String {
        let steps = [
            ("spawn", Some(self.spawned)),
            ("output", self.first_output),
            ("runner", self.runner_started),
            ("test", self.test_started),
            ("listening", self.listening),
            (end_name, Some(end)),
        ];
        let mut fields = Vec::new();
        let mut previous: Option<(&str, std::time::Instant)> = None;
        for (name, at) in steps {
            let Some(at) = at else { continue };
            if let Some((from, from_at)) = previous {
                fields.push(format!(
                    "{from}_to_{name}_ms={}",
                    at.saturating_duration_since(from_at).as_millis()
                ));
            }
            previous = Some((name, at));
        }
        if let Some(waited) = self.gate_waited_ms {
            fields.push(format!("gate_waited_ms={waited}"));
        }
        fields.join(" ")
    }
}

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
) -> Result<(
    TrackedAgent,
    OutputTail,
    OutputTail,
    LaunchFailure,
    LaunchProgressHandle,
)> {
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
    let spawned = std::time::Instant::now();
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
    let progress: LaunchProgressHandle = Arc::new(Mutex::new(LaunchProgress::new(spawned)));
    let stdout_progress = progress.clone();
    let stderr_progress = progress.clone();

    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        if let Some(stdout) = stdout {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                info!(target: "xcodebuild", "{}", line);
                stdout_progress
                    .lock()
                    .unwrap()
                    .observe(&line, std::time::Instant::now());
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
                stderr_progress
                    .lock()
                    .unwrap()
                    .observe(&line, std::time::Instant::now());
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
    Ok((child, stdout_tail, stderr_tail, launch_failure, progress))
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
    let pkill = super::device::bounded_output(
        "pkill xcodebuild",
        Command::new("pkill").args(["-f", &pattern]),
        Duration::from_secs(10),
    )
    .await;
    let xcodebuild_killed = pkill_signalled(pkill.as_ref().ok().and_then(|o| o.status.code()));

    // Kill the runner app on the simulator — xcrun simctl terminate
    // targets the simulator process, not the host. The runner's bundle ID
    // is set in the Xcode project (dev.tapsmith.agent.xctrunner). A
    // simulator app is a host process whose path names its simulator, so
    // `pgrep` (~10 ms) says whether there is one before paying for `simctl
    // terminate` (~0.3–0.6 s even with nothing to stop).
    let runner_running = runner_may_be_running(udid).await;
    if runner_running {
        let _ = super::device::bounded_output(
            "simctl terminate xctrunner",
            Command::new("xcrun").args([
                "simctl",
                "terminate",
                udid,
                "dev.tapsmith.agent.xctrunner",
            ]),
            super::device::SIMCTL_TIMEOUT,
        )
        .await;
    }

    // Brief pause for processes to die and port to be released — only when
    // something was running.
    if xcodebuild_killed || runner_running {
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
}

/// Whether `pkill` signalled anything, from its exit code: 0 when it matched
/// a process, 1 when none matched. Anything else (an error, a timeout, no
/// code) is taken as "maybe", so the caller still pauses.
fn pkill_signalled(exit_code: Option<i32>) -> bool {
    exit_code != Some(1)
}

/// Whether the simulator `udid` may be running a Tapsmith runner. Only a
/// clean "no match" from `pgrep` says no; anything else says maybe.
async fn runner_may_be_running(udid: &str) -> bool {
    if udid == "booted" {
        // Not a device path component: pgrep cannot answer for it.
        return true;
    }
    let pattern = runner_process_pattern(udid);
    let pgrep = super::device::bounded_output(
        "pgrep runner",
        Command::new("pgrep").args(["-f", &pattern]),
        Duration::from_secs(5),
    )
    .await;
    pkill_signalled(pgrep.as_ref().ok().and_then(|o| o.status.code()))
}

/// `pgrep -f` pattern for the host process of a Tapsmith runner on simulator
/// `udid` (its path runs through `…/Devices/<udid>/data/Containers/…`).
fn runner_process_pattern(udid: &str) -> String {
    format!("/{udid}/.*TapsmithAgentUITests-Runner")
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
    launch_gate: Option<&Path>,
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
        if let Some(gate) = launch_gate {
            for dict in ["EnvironmentVariables", "TestingEnvironmentVariables"] {
                k.push((
                    format!(":{base}:{dict}:{}", launch_gate::LAUNCH_GATE_ENV),
                    format!("string {}", gate.display()),
                ));
            }
        }
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
    fn a_launch_failure_is_relaunched_unless_the_app_is_known_to_be_missing() {
        assert!(may_relaunch_after_launch_failure(false, Some(true)));
        // simctl could not be asked (timed out): unknown, not missing.
        assert!(may_relaunch_after_launch_failure(false, None));
        assert!(!may_relaunch_after_launch_failure(false, Some(false)));
        assert!(!may_relaunch_after_launch_failure(true, None));
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

        let patched_path = patch_xctestrun(
            path.to_str().unwrap(),
            "com.example.app",
            false,
            18800,
            None,
        )
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
        // Nor a launch gate nobody asked for.
        assert!(!contents.contains(launch_gate::LAUNCH_GATE_ENV));
    }

    #[tokio::test]
    async fn patch_xctestrun_passes_the_launch_gate_to_the_runner() {
        let (dir, path) = write_fixture(FIXTURE_EMPTY).await;
        let gate = dir.path().join("tapsmith-launch-gate-18800-abc");

        let patched_path = patch_xctestrun(
            path.to_str().unwrap(),
            "com.example.app",
            false,
            18800,
            Some(&gate),
        )
        .await
        .expect("patch should succeed");

        let value = plist::Value::from_file(&patched_path).unwrap();
        let target = value
            .as_dictionary()
            .and_then(|d| d.get("TestConfigurations"))
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_dictionary())
            .and_then(|d| d.get("TestTargets"))
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_dictionary())
            .expect("test target");
        for dict in ["EnvironmentVariables", "TestingEnvironmentVariables"] {
            let got = target
                .get(dict)
                .and_then(|v| v.as_dictionary())
                .and_then(|d| d.get(launch_gate::LAUNCH_GATE_ENV))
                .and_then(|v| v.as_string());
            assert_eq!(got, gate.to_str(), "{dict}");
        }
    }

    #[tokio::test]
    async fn patch_xctestrun_attach_mode_sets_attach_flag() {
        let (_dir, path) = write_fixture(FIXTURE_EMPTY).await;

        let patched_path =
            patch_xctestrun(path.to_str().unwrap(), "com.example.app", true, 19000, None)
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

        let patched_path = patch_xctestrun(
            path.to_str().unwrap(),
            "com.fresh.bundle",
            false,
            18800,
            None,
        )
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

        let p1 = patch_xctestrun(src, "com.example.app", false, 18800, None)
            .await
            .unwrap();
        let p2 = patch_xctestrun(src, "com.example.app", false, 18801, None)
            .await
            .unwrap();
        let p3 = patch_xctestrun(src, "com.example.app", true, 18800, None)
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

        let result = patch_xctestrun(
            bogus.to_str().unwrap(),
            "com.example.app",
            false,
            18800,
            None,
        )
        .await;
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

    fn wiped() -> Prepared {
        Prepared {
            wipe_requested: true,
            wiped: true,
        }
    }

    fn flag() -> (
        std::sync::Arc<std::sync::atomic::AtomicBool>,
        std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) {
        let f = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        (f.clone(), f)
    }

    fn is_set(f: &std::sync::atomic::AtomicBool) -> bool {
        f.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[tokio::test]
    async fn the_gate_opens_only_after_the_prepare() {
        let dir = tempfile::tempdir().unwrap();
        let mut gated = GatedLaunch::start_with(
            LaunchGate::new_in(dir.path(), 18700),
            async {
                tokio::time::sleep(Duration::from_millis(80)).await;
                wiped()
            },
            Duration::from_secs(5),
            None,
        );
        let path = gated.gate.path().to_path_buf();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!path.exists(), "the gate waits for the prepare");
        gated.settle().await;
        assert!(path.exists(), "then opens");
        // The runner acknowledges it: the start is fresh.
        std::fs::remove_file(&path).unwrap();
        assert!(gated.app_launched_fresh().await);
    }

    #[tokio::test]
    async fn a_deadline_opens_the_gate_unvouched_for() {
        let dir = tempfile::tempdir().unwrap();
        let mut gated = GatedLaunch::start_with(
            LaunchGate::new_in(dir.path(), 18700),
            std::future::pending::<Prepared>(),
            Duration::from_millis(30),
            None,
        );
        let path = gated.gate.path().to_path_buf();
        // Never finishes, yet settles: the deadline ends the task.
        gated.settle().await;
        assert!(path.exists(), "the deadline opens the gate");
        std::fs::remove_file(&path).unwrap();
        assert!(
            !gated.app_launched_fresh().await,
            "an unfinished prepare is not fresh"
        );
    }

    #[tokio::test]
    async fn a_relaunch_reopens_the_gate_and_is_not_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let mut gated = GatedLaunch::start_with(
            LaunchGate::new_in(dir.path(), 18700),
            async { wiped() },
            Duration::from_secs(5),
            None,
        );
        gated.settle().await;
        let path = gated.gate.path().to_path_buf();
        std::fs::remove_file(&path).unwrap();
        gated.before_relaunch().await;
        assert!(path.exists(), "the second runner finds the gate open");
        std::fs::remove_file(&path).unwrap();
        assert!(!gated.app_launched_fresh().await);
    }

    #[tokio::test]
    async fn the_gate_waits_for_the_defaults_past_the_prepare_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let (written, written_flag) = flag();
        let defaults = SimulatorDefaults::start_with(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            written_flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let mut gated = GatedLaunch::start_with(
            LaunchGate::new_in(dir.path(), 18700),
            async { wiped() },
            Duration::from_millis(20),
            Some(defaults.clone_handle()),
        );
        let path = gated.gate.path().to_path_buf();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(
            !path.exists(),
            "a finished prepare does not open the gate before the defaults"
        );
        gated.settle().await;
        assert!(is_set(&written), "the defaults were written first");
        assert!(path.exists());
        std::fs::remove_file(&path).unwrap();
        assert!(
            gated.app_launched_fresh().await,
            "slow defaults do not make the launch unvouched for"
        );
        // The start's own wait returns at once now.
        tokio::time::timeout(Duration::from_millis(50), defaults.applied())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_defaults_task_that_died_does_not_hold_the_gate() {
        let dir = tempfile::tempdir().unwrap();
        let defaults = SimulatorDefaults::start_with(async { panic!("simctl went away") });
        let mut gated = GatedLaunch::start_with(
            LaunchGate::new_in(dir.path(), 18700),
            async { wiped() },
            Duration::from_secs(5),
            Some(defaults.clone_handle()),
        );
        tokio::time::timeout(Duration::from_secs(2), gated.settle())
            .await
            .unwrap();
        assert!(gated.gate.path().exists());
        tokio::time::timeout(Duration::from_secs(2), defaults.applied())
            .await
            .unwrap();
    }

    #[test]
    fn launch_progress_reads_the_steps_of_an_xcodebuild_launch() {
        let t0 = std::time::Instant::now();
        let at = |ms| t0 + Duration::from_millis(ms);
        let mut p = LaunchProgress::new(t0);
        p.observe("Command line invocation:", at(4_200));
        p.observe(
            "2026-11-10 11:05:17.504909+0000 TapsmithAgentUITests-Runner[48479:127324] [Default] Running tests...",
            at(28_500),
        );
        p.observe(
            "Test Suite 'All tests' started at 2026-11-10 11:05:21.134.",
            at(41_400),
        );
        p.observe(
            "Test Case '-[TapsmithAgentUITests.TapsmithAgentRunner testRunAgent]' started.",
            at(41_500),
        );
        p.observe(
            "2026-11-10 11:05:22.890264+0000 TapsmithAgentUITests-Runner[48479:127324] [TapsmithAgent] Launch gate: opened(waitedMs: 1)",
            at(43_000),
        );
        p.observe(
            "2026-11-10 11:05:26.774591+0000 TapsmithAgentUITests-Runner[48479:129561] [TapsmithSocket] Listening on port 18700",
            at(47_000),
        );
        // Later lines never move a step already seen.
        p.observe("[TapsmithSocket] Listening on port 18700", at(60_000));
        assert_eq!(
            p.phase_fields(at(47_300), "ready"),
            "spawn_to_output_ms=4200 output_to_runner_ms=24300 runner_to_test_ms=13000 \
             test_to_listening_ms=5500 listening_to_ready_ms=300 gate_waited_ms=1"
        );
    }

    #[test]
    fn launch_progress_names_phases_across_steps_whose_lines_never_came() {
        let t0 = std::time::Instant::now();
        let mut p = LaunchProgress::new(t0);
        p.observe(
            "xcodebuild: error: something",
            t0 + Duration::from_millis(900),
        );
        assert_eq!(
            p.phase_fields(t0 + Duration::from_millis(2_000), "timeout"),
            "spawn_to_output_ms=900 output_to_timeout_ms=1100"
        );
        // Another Xcode's wording for the runner's start: the phase spans it.
        p.observe(
            "Test Case '-[A b]' started.",
            t0 + Duration::from_millis(3_000),
        );
        assert_eq!(
            p.phase_fields(t0 + Duration::from_millis(3_500), "ready"),
            "spawn_to_output_ms=900 output_to_test_ms=2100 test_to_ready_ms=500"
        );
    }

    #[tokio::test]
    async fn dropping_the_launch_stops_its_prepare_and_removes_the_gate() {
        let dir = tempfile::tempdir().unwrap();
        let (ran, ran_flag) = flag();
        let gated = GatedLaunch::start_with(
            LaunchGate::new_in(dir.path(), 18700),
            async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                ran_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                wiped()
            },
            Duration::from_secs(5),
            None,
        );
        let path = gated.gate.path().to_path_buf();
        drop(gated);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!is_set(&ran));
        assert!(!path.exists());
    }

    #[test]
    fn pkill_and_pgrep_say_nothing_ran_only_on_a_clean_no_match() {
        assert!(pkill_signalled(Some(0)));
        assert!(!pkill_signalled(Some(1)));
        // A usage error, a timeout or a missing tool: assume something ran.
        assert!(pkill_signalled(Some(2)));
        assert!(pkill_signalled(None));
    }

    #[test]
    fn the_runner_pattern_matches_this_simulators_runner_only() {
        let re = regex::Regex::new(&runner_process_pattern(SIM_A)).unwrap();
        assert!(re.is_match(&runner_command(SIM_A)));
        assert!(!re.is_match(&runner_command(SIM_B)));
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
