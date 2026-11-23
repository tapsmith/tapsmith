//! Android device work: ADB on the host plus the UIAutomator2 agent.

use super::device_backend::{
    ActionResult, AgentLaunched, CaptureRoute, CaptureStop, DeviceBackend, PermissionChange,
};
use super::*;

use crate::android_agent_install::{
    agent_launch_command, force_install_requested, host_md5, installed_md5_command, needs_install,
    parse_installed_md5s, AGENT_PACKAGE, AGENT_TEST_PACKAGE, FORCE_INSTALL_ENV,
};

/// The packages among `apks` (`(package, host path, label)`) whose APK must
/// be installed: those whose host bytes differ from the device's installed
/// APK, or whose identity cannot be established. Every one of them when
/// `TAPSMITH_FORCE_AGENT_INSTALL` is set.
async fn agent_apks_to_install(
    serial: &str,
    apks: &[(&'static str, &str, &str)],
) -> Vec<&'static str> {
    let all = || apks.iter().map(|(pkg, _, _)| *pkg).collect();
    if force_install_requested(std::env::var(FORCE_INSTALL_ENV).ok().as_deref()) {
        info!("{FORCE_INSTALL_ENV} is set; reinstalling the agent APKs");
        return all();
    }
    let packages: Vec<&str> = apks.iter().map(|(pkg, _, _)| *pkg).collect();
    let installed = match adb::shell_lenient(serial, &installed_md5_command(&packages)).await {
        Ok(output) => parse_installed_md5s(&output),
        Err(e) => {
            debug!(error = %e, "Could not read the installed agent APK hashes; installing");
            return all();
        }
    };
    let mut to_install = Vec::new();
    for (pkg, path, _) in apks {
        if needs_install(pkg, host_md5(path).await.as_deref(), &installed) {
            to_install.push(*pkg);
        }
    }
    to_install
}

/// On a device whose adbd is not root, the error `op` fails with when
/// `run-as <pkg>` cannot enter the app (a release build, a package that is not
/// installed), or `None` when it can. Run before anything touches the app's
/// data, so a refused restore leaves the data as it was.
async fn run_as_refusal(serial: &str, pkg: &str, op: &str) -> Option<String> {
    let e = adb::shell(serial, &android_app_state::run_as_probe(pkg))
        .await
        .err()?;
    let refusal = android_app_state::classify_run_as_refusal(&e.to_string());
    let kind = android_app_state::device_kind(serial).await;
    Some(android_app_state::run_as_refusal_message(
        op, pkg, serial, &refusal, kind,
    ))
}

pub(super) struct AndroidBackend<'a> {
    pub(super) svc: &'a TapsmithServiceImpl,
}

#[async_trait::async_trait]
impl DeviceBackend for AndroidBackend<'_> {
    async fn terminate_app(&self, request_id: String, package: &str) -> ActionResult {
        let cmd = format!("am force-stop {package}");
        self.svc.adb_action(request_id, &cmd).await
    }

    async fn app_state(&self, package: &str) -> Result<String, Status> {
        let serial = self.svc.active_serial().await?;

        // Check if app is installed
        let installed = adb::shell_lenient(&serial, &format!("pm list packages {package}"))
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        if !installed.contains(package) {
            return Ok("not_installed".to_string());
        }

        // Check if app process is running and in foreground
        let resumed = adb::shell_lenient(
            &serial,
            "dumpsys activity activities | grep -E 'mResumedActivity|ResumedActivity|topResumedActivity'",
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        if resumed.contains(package) {
            return Ok("foreground".to_string());
        }

        // Check if process exists at all
        let procs = adb::shell_lenient(&serial, &format!("pidof {package}"))
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        let state = if procs.trim().is_empty() {
            "stopped"
        } else {
            "background"
        };
        Ok(state.to_string())
    }

    async fn current_package(&self) -> Result<String, Status> {
        Ok(self
            .svc
            .get_current_component()
            .await?
            .map(|(pkg, _)| pkg)
            .unwrap_or_default())
    }

    async fn current_activity(&self) -> Result<String, Status> {
        Ok(self
            .svc
            .get_current_component()
            .await?
            .map(|(_, act)| act)
            .unwrap_or_default())
    }

    async fn change_permission(
        &self,
        request_id: String,
        package: &str,
        permission: &str,
        change: PermissionChange,
    ) -> ActionResult {
        TapsmithServiceImpl::validate_permission(permission)?;
        let cmd = format!("pm {} {package} {permission}", change.as_str());
        self.svc.adb_action(request_id, &cmd).await
    }

    async fn set_clipboard(&self, request_id: String, text: String) -> ActionResult {
        // Use the on-device agent for clipboard operations since it has
        // access to Android's ClipboardManager via the instrumentation context.
        let command = AgentCommand::SetClipboard { text };
        let result = self.svc.send_agent_command(&command).await;
        self.svc.make_action_response(request_id, result).await
    }

    async fn get_clipboard(&self) -> Result<String, Status> {
        let command = AgentCommand::GetClipboard {};
        let result = self
            .svc
            .send_agent_command(&command)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(result
            .data
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    }

    async fn set_orientation(&self, request_id: String, orientation: &str) -> ActionResult {
        let serial = self.svc.active_serial().await?;
        let wanted = match orientation {
            "portrait" => Orientation::Portrait,
            "landscape" => Orientation::Landscape,
            other => {
                return Err(Status::invalid_argument(format!(
                    "orientation must be 'portrait' or 'landscape', got '{other}'"
                )));
            }
        };
        // Rotation 0 is the display's natural orientation, which is landscape
        // on most tablets: pick the rotation that gives the wanted shape.
        let rotation = rotation_map(&serial).await?.user_rotation_for(wanted);
        if let Err(e) = adb::shell(&serial, "settings put system accelerometer_rotation 0").await {
            error!(error = %e, "Failed to disable auto-rotate");
        }
        // Write to the device whose rotation map was read, even if the active
        // device changed meanwhile.
        let cmd = format!("settings put system user_rotation {rotation}");
        let response = self.svc.adb_action_on(request_id, &serial, &cmd).await?;
        if !response.get_ref().success {
            return Ok(response);
        }
        // The setting only starts the turn. Return once the screen has
        // turned, so what comes next (a swipe planned on the screen's size,
        // a read of an element's bounds) sees the turned screen.
        match wait_for_turn(&serial, rotation).await {
            Ok(()) => Ok(response),
            Err(reason) => {
                let screenshot = self.svc.error_screenshot().await;
                Ok(Response::new(proto::ActionResponse {
                    request_id: response.into_inner().request_id,
                    success: false,
                    error_type: "ORIENTATION_NOT_SETTLED".to_string(),
                    error_message: format!("Could not turn the screen to {orientation}: {reason}"),
                    screenshot,
                    app_launched_fresh: false,
                }))
            }
        }
    }

    async fn get_orientation(&self) -> Result<String, Status> {
        let serial = self.svc.active_serial().await?;
        let output = adb::shell(&serial, "settings get system user_rotation")
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(rotation_map(&serial)
            .await?
            .orientation_of(&output)
            .as_str()
            .to_string())
    }

    async fn set_color_scheme(&self, request_id: String, scheme: &str) -> ActionResult {
        let mode = match scheme {
            "dark" => "yes",
            "light" => "no",
            other => {
                return Err(Status::invalid_argument(format!(
                    "scheme must be 'dark' or 'light', got '{other}'"
                )));
            }
        };
        let cmd = format!("cmd uimode night {mode}");
        self.svc.adb_action(request_id, &cmd).await
    }

    async fn get_color_scheme(&self) -> Result<String, Status> {
        let serial = self.svc.active_serial().await?;
        let output = adb::shell_lenient(&serial, "cmd uimode night")
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        let scheme = if output.contains("Night mode: yes") {
            "dark"
        } else {
            "light"
        };
        Ok(scheme.to_string())
    }

    async fn is_keyboard_shown(&self) -> Result<bool, Status> {
        let serial = self.svc.active_serial().await?;
        self.svc.android_is_keyboard_shown(&serial).await
    }

    async fn take_system_dialog_events(
        &self,
        _answer_leftover_alerts: bool,
    ) -> Result<Vec<proto::SystemDialogEvent>, Status> {
        // The Android agent answers its dialogs as they come up; there is no
        // leftover to answer at a boundary.
        let result = self
            .svc
            .send_agent_command(&AgentCommand::TakeSystemDialogEvents {
                answer_leftover_alerts: false,
            })
            .await?;
        if !result.success {
            return Err(Status::internal(format!(
                "Could not read the system dialogs the agent answered: {}",
                result.error.unwrap_or_default()
            )));
        }
        Ok(system_dialog_events_from(&result.data))
    }

    async fn hide_keyboard(&self, request_id: String) -> ActionResult {
        // The Android soft keyboard is dismissed by BACK, not ESCAPE —
        // KEYCODE_ESCAPE is a no-op for the IME on most apps (incl.
        // Flutter). Only send BACK when the keyboard is actually shown,
        // otherwise BACK would pop the current screen / background the app.
        let serial = self.svc.active_serial().await?;
        let press_back = crate::android_keyboard::should_press_back(&serial, |command, timeout| {
            adb::shell_with_timeout(&serial, command, timeout)
        })
        .await
        .map_err(|e| Status::internal(e.to_string()))?;
        if press_back {
            // To the device that was checked, even if setDevice switched since.
            self.svc
                .adb_action_on(request_id, &serial, "input keyevent KEYCODE_BACK")
                .await
        } else {
            Ok(TapsmithServiceImpl::success_action_response(request_id))
        }
    }

    async fn open_notifications(&self, request_id: String) -> ActionResult {
        self.svc
            .adb_action(request_id, "cmd statusbar expand-notifications")
            .await
    }

    async fn open_quick_settings(&self, request_id: String) -> ActionResult {
        self.svc
            .adb_action(request_id, "cmd statusbar expand-settings")
            .await
    }

    async fn wake(&self, request_id: String) -> ActionResult {
        self.svc
            .adb_action(request_id, "input keyevent KEYCODE_WAKEUP")
            .await
    }

    async fn unlock(&self, request_id: String) -> ActionResult {
        let serial = self.svc.active_serial().await?;
        let (awake, keyguard) =
            tokio::join!(adb::screen_awake(&serial), adb::keyguard_showing(&serial));
        match unlock_start(awake, keyguard) {
            UnlockStart::AlreadyUnlocked => {
                return Ok(TapsmithServiceImpl::success_action_response(request_id));
            }
            UnlockStart::Dismiss => {}
            UnlockStart::WakeFirst => {
                let _ = adb::shell_lenient(&serial, "input keyevent KEYCODE_WAKEUP").await;
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
        // Only dismiss a keyguard that is actually showing. The
        // legacy sequence below is a MENU key plus a swipe up, and
        // on an already-unlocked device both land on the foreground
        // app — the swipe scrolls its root list to the bottom. UI
        // mode unlocks right before running a file whose reset the
        // background preparation already satisfied, so nothing
        // undoes that scroll and the first assertions fail on a
        // "prepared" device (headless survived only because its
        // inline reset runs after the unlock).
        if adb::keyguard_showing(&serial).await == Some(false) {
            return Ok(TapsmithServiceImpl::success_action_response(request_id));
        }
        // `wm dismiss-keyguard` is the input-free path (API 26+). It
        // does nothing for secure keyguards, so re-check and fall
        // back to the gesture only while the lock screen is still up
        // (or when the dump cannot tell).
        let _ = adb::shell_lenient(&serial, "wm dismiss-keyguard").await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        if adb::keyguard_showing(&serial).await == Some(false) {
            return Ok(TapsmithServiceImpl::success_action_response(request_id));
        }
        // Dismiss non-secure lock screen (KEYCODE_MENU)
        let _ = adb::shell_lenient(&serial, "input keyevent 82").await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        // Swipe up as fallback for swipe-to-unlock screens
        let _ = adb::shell_lenient(&serial, "input swipe 540 1800 540 800 300").await;
        Ok(TapsmithServiceImpl::success_action_response(request_id))
    }

    async fn app_is_running(&self, package: &str) -> Option<bool> {
        // `pidof` exits non-zero when nothing matches, which adb::shell
        // surfaces as an error — `|| true` makes "no process" read as
        // not running rather than unknown.
        let serial = self.svc.active_serial().await.ok()?;
        let out = adb::shell(&serial, &format!("pidof {package} 2>/dev/null || true"))
            .await
            .ok()?;
        Some(!out.trim().is_empty())
    }

    async fn wait_for_app_ready(&self, package: &str, timeout: Duration) -> Option<bool> {
        Some(
            self.svc
                .wait_for_android_rendered_content(package, timeout)
                .await,
        )
    }

    async fn relaunch_app(
        &self,
        serial: &str,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        self.svc
            .android_clean_relaunch(serial, package_name, wait_for_idle, idle_timeout_ms)
            .await
    }

    async fn wipe_app_data(&self, serial: &str, package_name: &str) -> Result<(), String> {
        let output = adb::shell(serial, &format!("pm clear {}", package_name))
            .await
            .map_err(|e| format!("pm clear failed: {e}"))?;
        if output.trim().starts_with("Success") {
            Ok(())
        } else {
            Err(format!(
                "pm clear did not report success: {}",
                output.trim()
            ))
        }
    }

    async fn deliver_deep_link(
        &self,
        request_id: String,
        uri: &str,
        _delivery: DeepLinkDelivery,
        ack_epoch_gt: Option<u64>,
        ack_boot_before: Option<String>,
        ack_nav_gt: Option<u64>,
    ) -> ActionResult {
        if uri.contains('\'') {
            return Err(Status::invalid_argument(
                "uri contains an invalid character: single quote (') is not allowed",
            ));
        }
        let serial = self.svc.active_serial().await?;
        let target_package = self
            .svc
            .started_agent_config
            .read()
            .await
            .as_ref()
            .map(|c| c.target_package.clone())
            .filter(|p| !p.is_empty());

        // Deliver to the app under test, not to whichever app Android's
        // resolver prefers: an `https` link whose intent filter is not
        // domain-verified (usually a debug build's) otherwise opens in the
        // browser, and the run reports success on a page it never reached.
        let cmd = deep_link_view_command(uri, target_package.as_deref());
        let output = match adb::shell(&serial, &cmd).await {
            Ok(out) => out,
            Err(e) => {
                let screenshot = self.svc.error_screenshot().await;
                return Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "ADB_COMMAND_FAILED".to_string(),
                    error_message: e.to_string(),
                    screenshot,
                    app_launched_fresh: false,
                }));
            }
        };
        match (am_start_outcome(&output), target_package.as_deref()) {
            (AmStartOutcome::Started, _) => {}
            (AmStartOutcome::Unresolved, Some(target)) => {
                // The app has no activity for this link. Opening it anyway
                // would hand it to another app and leave that app in front;
                // say which one instead, without launching it.
                let handler = adb::shell(&serial, &deep_link_resolve_command(uri))
                    .await
                    .map(|out| parse_resolved_handler(&out))
                    .unwrap_or(LinkHandler::Unknown);
                return Ok(self
                    .svc
                    .action_error(
                        request_id,
                        "ACTION_FAILED",
                        unhandled_link_message(uri, target, &handler),
                    )
                    .await);
            }
            (AmStartOutcome::Unresolved | AmStartOutcome::Failed, _) => {
                return Ok(self
                    .svc
                    .action_error(request_id, "ADB_COMMAND_FAILED", output.trim().to_string())
                    .await);
            }
        }

        // Settle: with an epoch ack, wait for the in-app hook to
        // confirm the reset ran; otherwise wait for the target app to
        // be the resumed activity. Neither compares whole hierarchies —
        // a link that lands on the screen already showing used to stall
        // here for the full 10s window and then re-fire the intent.
        let started = tokio::time::Instant::now();
        let mut refired = false;
        loop {
            tokio::time::sleep(ANDROID_DEEP_LINK_POLL).await;
            let elapsed = started.elapsed();

            let satisfied = match (ack_epoch_gt, ack_nav_gt) {
                (Some(before), _) => match self.svc.current_hooks_marker(5_000).await {
                    Some(marker)
                        if app_reset::hooks_acknowledged(
                            before,
                            ack_boot_before.as_deref(),
                            &marker,
                        ) =>
                    {
                        if let Some(err) = marker.err {
                            return Ok(self
                                .svc
                                .action_error(
                                    request_id,
                                    "ACTION_FAILED",
                                    format!("in-app reset reported an error: {err}"),
                                )
                                .await);
                        }
                        true
                    }
                    _ => false,
                },
                // Navigation link into an app with the nav counter:
                // the app bumping it is positive proof of delivery —
                // "resumed activity" can't tell a delivered same-screen
                // link from a dropped one.
                (None, Some(nav_before)) => match self.svc.current_hooks_marker(5_000).await {
                    Some(marker) => {
                        app_reset::nav_acknowledged(nav_before, ack_boot_before.as_deref(), &marker)
                    }
                    None => false,
                },
                (None, None) => match (&target_package, self.svc.get_current_component().await) {
                    (Some(target), Ok(Some((pkg, _)))) => &pkg == target,
                    // No target to judge against: the intent was
                    // accepted, that is all we can know.
                    (None, _) => true,
                    _ => false,
                },
            };
            if satisfied {
                break;
            }
            let deadline = if ack_epoch_gt.is_some() {
                ANDROID_HOOK_ACK_TIMEOUT
            } else {
                ANDROID_DEEP_LINK_SETTLE_TIMEOUT
            };
            if elapsed >= deadline {
                if ack_epoch_gt.is_some() {
                    return Ok(self
                        .svc
                        .action_error(
                            request_id,
                            "ACTION_FAILED",
                            format!(
                                "in-app reset did not acknowledge within {}ms",
                                deadline.as_millis()
                            ),
                        )
                        .await);
                }
                // Navigation links are best-effort here, as before: the
                // caller's own assertions decide whether it landed.
                break;
            }
            if !refired && elapsed >= ANDROID_DEEP_LINK_REFIRE_AFTER {
                refired = true;
                debug!("Deep link: target not resumed yet, re-firing intent once");
                let _ = adb::shell(&serial, &cmd).await;
            }
        }

        // Final idle wait so animations finish before the caller
        // interacts with the new screen.
        let idle_cmd = AgentCommand::WaitForIdle {
            timeout_ms: Some(ANDROID_DEEP_LINK_IDLE_TIMEOUT_MS),
        };
        let _ = self
            .svc
            .send_agent_command_with_timeout(&idle_cmd, ANDROID_DEEP_LINK_IDLE_TIMEOUT_MS)
            .await;

        Ok(TapsmithServiceImpl::success_action_response(request_id))
    }

    async fn launch_app(
        &self,
        request_id: String,
        serial: String,
        req: &proto::LaunchAppRequest,
    ) -> ActionResult {
        if !req.activity.is_empty() {
            TapsmithServiceImpl::validate_activity(&req.activity)?;
        }

        // Clear data first if requested
        if req.clear_data {
            match adb::shell(&serial, &format!("pm clear {}", req.package_name)).await {
                Ok(output) if !output.trim().starts_with("Success") => {
                    error!(output = %output.trim(), "pm clear did not report success");
                    let screenshot = self.svc.error_screenshot().await;
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "CLEAR_DATA_FAILED".to_string(),
                        error_message: format!("Failed to clear app data: {}", output.trim()),
                        screenshot,
                        app_launched_fresh: false,
                    }));
                }
                Err(e) => {
                    error!(error = %e, "Failed to clear app data before launch");
                    let screenshot = self.svc.error_screenshot().await;
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "CLEAR_DATA_FAILED".to_string(),
                        error_message: format!("Failed to clear app data: {e}"),
                        screenshot,
                        app_launched_fresh: false,
                    }));
                }
                Ok(_) => {} // Success
            }
        }

        if req.activity.is_empty() {
            self.svc
                .launch_package(
                    &serial,
                    request_id,
                    &req.package_name,
                    req.wait_for_idle,
                    req.idle_timeout_ms,
                )
                .await
        } else {
            // -S force-stops the app before launching, ensuring no
            // residual savedInstanceState Bundle survives from a
            // previous Activity. Without it, React Navigation /
            // Expo Router can restore stale navigation state from
            // the Bundle even after pm clear wiped AsyncStorage.
            // --activity-clear-task ensures a fresh task stack.
            let cmd = format!(
                "am start -S --activity-clear-task -n {}",
                android_component_arg(&req.package_name, &req.activity),
            );
            self.svc
                .launch_and_idle(
                    &serial,
                    request_id,
                    &cmd,
                    req.wait_for_idle,
                    req.idle_timeout_ms,
                )
                .await
        }
    }

    async fn restart_app(
        &self,
        request_id: String,
        serial: String,
        req: &proto::RestartAppRequest,
    ) -> ActionResult {
        // Force-stop the app to kill the process and reset all in-memory state.
        if let Err(e) = adb::shell(&serial, &format!("am force-stop {}", req.package_name)).await {
            error!(error = %e, "Failed to force-stop app");
            let screenshot = self.svc.error_screenshot().await;
            return Ok(Response::new(proto::ActionResponse {
                request_id,
                success: false,
                error_type: "FORCE_STOP_FAILED".to_string(),
                error_message: format!("Failed to stop app: {e}"),
                screenshot,
                app_launched_fresh: false,
            }));
        }

        self.svc
            .launch_package(
                &serial,
                request_id,
                &req.package_name,
                req.wait_for_idle,
                req.idle_timeout_ms,
            )
            .await
    }

    async fn clear_app_data(
        &self,
        request_id: String,
        req: &proto::ClearAppDataRequest,
    ) -> ActionResult {
        let cmd = format!("pm clear {}", req.package_name);
        self.svc.adb_action(request_id, &cmd).await
    }

    async fn supports_cold_deep_link(&self) -> bool {
        false
    }

    async fn save_app_state(
        &self,
        request_id: String,
        serial: String,
        req: &proto::SaveAppStateRequest,
    ) -> ActionResult {
        let pkg = &req.package_name;
        let local_path = &req.path;

        let device_tmp = format!(
            "/data/local/tmp/tapsmith-app-state-{}.tar.gz",
            Uuid::new_v4()
        );
        let data_dir = format!("/data/data/{pkg}");
        let tar_timeout = Duration::from_secs(300);

        // 1. Force-stop the app to avoid data corruption
        if let Err(e) = adb::shell(&serial, &format!("am force-stop {pkg}")).await {
            warn!(%pkg, "Failed to force-stop app before save: {e}");
        }

        // 2. Determine access strategy: root or run-as
        let is_root = adb::shell_lenient(&serial, "id")
            .await
            .map(|out| out.contains("uid=0"))
            .unwrap_or(false);
        if !is_root {
            if let Some(message) = run_as_refusal(&serial, pkg, "saveAppState").await {
                return Ok(self
                    .svc
                    .action_error(request_id, "APP_STATE_SAVE_FAILED", message)
                    .await);
            }
        }

        // 2b. Capture device-side state that lives OUTSIDE /data/data and
        // is destroyed by `pm clear` (root only), embedding each as a
        // reserved member written into the data dir so the tar below
        // picks it up and restore can re-establish it:
        //  - AndroidKeyStore keys: Firebase et al. encrypt data-dir
        //    credentials with a keystore key the data tar can't carry.
        //  - Granted runtime permissions (e.g. POST_NOTIFICATIONS): so a
        //    prompt dismissed once stays dismissed across restore.
        // Best-effort: capture never fails the save. The guard removes
        // the members from the live data dir once it drops — after the
        // tar below has captured them, or on cancellation — so they never
        // linger inside the app's files.
        let mut injected_members = adb::DeviceFileGuard::new(serial.clone());
        if is_root {
            match android_keystore::capture_into_data_dir(&serial, pkg, &data_dir).await {
                Ok(true) => injected_members.track(format!(
                    "{data_dir}/{}",
                    android_keystore::KEYSTORE_ARCHIVE_MEMBER
                )),
                Ok(false) => {}
                Err(e) => {
                    warn!(%pkg, error = %e, "Keystore capture failed; archive will not include keystore state");
                }
            }
            match android_permissions::capture_into_data_dir(&serial, pkg, &data_dir).await {
                Ok(true) => injected_members.track(format!(
                    "{data_dir}/{}",
                    android_permissions::PERMISSIONS_ARCHIVE_MEMBER
                )),
                Ok(false) => {}
                Err(e) => {
                    warn!(%pkg, error = %e, "Runtime permission capture failed; archive will not include permission state");
                }
            }
        }

        // 3. Create tar.gz archive on device, excluding cache
        // directories that don't carry meaningful app state.
        // Older Toybox builds (pre-Android 10) lack --exclude, so
        // fall back to archiving everything if the first attempt fails.
        let tar_cmd = |excludes: &str| {
            android_app_state::save_command(pkg, &data_dir, &device_tmp, is_root, excludes)
        };
        let tar_result = adb::shell_with_timeout(
            &serial,
            &tar_cmd(android_app_state::CACHE_EXCLUDES),
            tar_timeout,
        )
        .await;
        let tar_result = match tar_result {
            Ok(_) => Ok(()),
            Err(_) => {
                debug!("tar with --exclude failed, retrying without exclusions");
                let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                adb::shell_with_timeout(&serial, &tar_cmd(""), tar_timeout)
                    .await
                    .map(|_| ())
            }
        };

        // The reserved members are now inside the archive; `injected_members`
        // (a DeviceFileGuard) removes them from the live data dir when it
        // drops at the end of this handler, on every exit path.

        if let Err(e) = tar_result {
            let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
            return Ok(self
                .svc
                .action_error(
                    request_id,
                    "APP_STATE_SAVE_FAILED",
                    format!("Failed to archive app data: {e}"),
                )
                .await);
        }

        // 4. Pull archive to host
        if let Some(parent) = std::path::Path::new(local_path).parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Err(e) = adb::pull_file(&serial, &device_tmp, local_path).await {
            let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
            return Ok(self
                .svc
                .action_error(
                    request_id,
                    "APP_STATE_SAVE_FAILED",
                    format!("Failed to pull app state archive: {e}"),
                )
                .await);
        }

        // 5. Clean up temp file on device
        let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;

        info!(%pkg, %local_path, "App state saved");
        Ok(TapsmithServiceImpl::success_action_response(request_id))
    }

    async fn restore_app_state(
        &self,
        request_id: String,
        serial: String,
        req: &proto::RestoreAppStateRequest,
    ) -> ActionResult {
        let pkg = &req.package_name;
        let local_path = &req.path;

        let device_tmp = format!(
            "/data/local/tmp/tapsmith-app-state-{}.tar.gz",
            Uuid::new_v4()
        );
        let data_dir = format!("/data/data/{pkg}");
        let tar_timeout = Duration::from_secs(300);

        // 1. Force-stop the app
        if let Err(e) = adb::shell(&serial, &format!("am force-stop {pkg}")).await {
            warn!(%pkg, "Failed to force-stop app before restore: {e}");
        }

        // 2. Determine access strategy: root or run-as.
        let is_root = adb::shell_lenient(&serial, "id")
            .await
            .map(|out| out.contains("uid=0"))
            .unwrap_or(false);
        if !is_root {
            if let Some(message) = run_as_refusal(&serial, pkg, "restoreAppState").await {
                return Ok(self
                    .svc
                    .action_error(request_id, "APP_STATE_RESTORE_FAILED", message)
                    .await);
            }
        }

        // 3. Clear the app's data dir IN PLACE, preserving the device
        // keystore. `pm clear` would also wipe the app's AndroidKeyStore
        // keys — and on Android those keys hold the decryption key for
        // credentials persisted *inside* the data dir (e.g. Firebase
        // Auth encrypts its session token with a Tink keyset that is
        // itself wrapped by an AndroidKeyStore master key). Wiping the
        // keystore leaves the restored, still-encrypted credentials
        // undecryptable, so the app comes back signed out. Removing only
        // the data-dir contents keeps the keystore intact. The `lib`
        // entry (symlink to the installed native libraries) is left in
        // place. Restored files get their ownership/SELinux context
        // fixed below (root) or inherit the run-as app identity.
        let clear_cmd = {
            // `-exec ... \;` (one `rm` per entry) rather than `+`: with
            // `+`, a `find` that matches nothing can invoke `rm` with no
            // operands on some implementations, which errors. `\;` only
            // runs `rm` per match, so an empty/lib-only dir is a no-op.
            let find = format!(
                "find {data_dir} -mindepth 1 -maxdepth 1 ! -name lib -exec rm -rf {{}} \\;"
            );
            if is_root {
                find
            } else {
                format!("run-as {pkg} {find}")
            }
        };
        if let Err(e) = adb::shell(&serial, &clear_cmd).await {
            return Ok(self
                .svc
                .action_error(
                    request_id,
                    "APP_STATE_RESTORE_FAILED",
                    format!("Failed to clear app data: {e}"),
                )
                .await);
        }

        // 4. Push archive to device
        if let Err(e) = adb::push_file(&serial, local_path, &device_tmp).await {
            let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
            return Ok(self
                .svc
                .action_error(
                    request_id,
                    "APP_STATE_RESTORE_FAILED",
                    format!("Failed to push app state archive: {e}"),
                )
                .await);
        }

        // 5. Extract archive into app data dir
        let tar_result = adb::shell_with_timeout(
            &serial,
            &android_app_state::restore_command(pkg, &data_dir, &device_tmp, is_root),
            tar_timeout,
        )
        .await;

        if let Err(e) = tar_result {
            let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
            return Ok(self
                .svc
                .action_error(
                    request_id,
                    "APP_STATE_RESTORE_FAILED",
                    format!("Failed to extract app state archive: {e}"),
                )
                .await);
        }

        // 6. Fix ownership and SELinux context (root only)
        if is_root {
            let uid_output =
                match adb::shell_lenient(&serial, &format!("stat -c '%u' {data_dir}")).await {
                    Ok(output) => output,
                    Err(e) => {
                        let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                        return Ok(self
                            .svc
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("Failed to determine app UID via stat: {e}"),
                            )
                            .await);
                    }
                };
            let uid = uid_output.trim().to_string();

            if uid.is_empty() {
                let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                return Ok(self
                    .svc
                    .action_error(
                        request_id,
                        "APP_STATE_RESTORE_FAILED",
                        "Failed to determine app UID: stat returned empty output".to_string(),
                    )
                    .await);
            }

            if let Err(e) = adb::shell_with_timeout(
                &serial,
                &format!("chown -R {uid}:{uid} {data_dir}"),
                Duration::from_secs(60),
            )
            .await
            {
                let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                return Ok(self
                    .svc
                    .action_error(
                        request_id,
                        "APP_STATE_RESTORE_FAILED",
                        format!("Failed to fix ownership on restored app state: {e}"),
                    )
                    .await);
            }

            if let Err(e) = adb::shell_with_timeout(
                &serial,
                &format!("restorecon -R {data_dir}"),
                Duration::from_secs(60),
            )
            .await
            {
                let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                return Ok(self
                    .svc
                    .action_error(
                        request_id,
                        "APP_STATE_RESTORE_FAILED",
                        format!("Failed to fix SELinux context on restored app state: {e}"),
                    )
                    .await);
            }
        }

        // 7. Clean up temp file
        let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;

        // 8. Re-establish device-side state captured outside /data/data
        // (root only), if the archive carried it.
        if is_root {
            // Keystore keys: without these, credentials encrypted by a
            // keystore key destroyed by a `pm clear` between save and
            // restore (e.g. a sibling login project resetting the app)
            // can't be decrypted and the app comes back signed out.
            if let Err(e) = android_keystore::restore_from_data_dir(&serial, pkg, &data_dir).await {
                return Ok(self
                    .svc
                    .action_error(
                        request_id,
                        "APP_STATE_RESTORE_FAILED",
                        format!("Keystore restore failed: {e}"),
                    )
                    .await);
            }
            // Granted runtime permissions: re-grant what was granted at
            // save time so a dismissed prompt (e.g. notifications) stays
            // dismissed. Best-effort — a stale permission must not fail
            // the whole restore.
            if let Err(e) =
                android_permissions::restore_from_data_dir(&serial, pkg, &data_dir).await
            {
                warn!(%pkg, error = %e, "Runtime permission restore failed; app may re-prompt");
            }
        }

        info!(%pkg, %local_path, "App state restored");
        Ok(TapsmithServiceImpl::success_action_response(request_id))
    }

    async fn list_web_views(
        &self,
        request_id: String,
        serial: String,
    ) -> Result<Response<proto::ListWebViewsResponse>, Status> {
        match adb::list_webview_sockets(&serial).await {
            Ok(sockets) => {
                let webviews = sockets
                    .into_iter()
                    .map(|s| proto::WebViewInfo {
                        socket_name: s.socket_name,
                        pid: s.pid,
                        package_name: s.package_name,
                        url: String::new(),
                        title: String::new(),
                    })
                    .collect();
                Ok(Response::new(proto::ListWebViewsResponse {
                    request_id,
                    webviews,
                    error_message: String::new(),
                }))
            }
            Err(e) => Ok(Response::new(proto::ListWebViewsResponse {
                request_id,
                webviews: Vec::new(),
                error_message: format!(
                    "Failed to discover WebViews: {e}. Ensure the app has \
                             WebView.setWebContentsDebuggingEnabled(true) set."
                ),
            })),
        }
    }

    async fn forward_web_view_port(
        &self,
        request_id: String,
        serial: String,
        req: proto::ForwardWebViewPortRequest,
    ) -> Result<Response<proto::ForwardWebViewPortResponse>, Status> {
        // Find a free port by binding to :0
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| Status::internal(format!("Failed to find free port: {e}")))?;
        let host_port = listener
            .local_addr()
            .map_err(|e| Status::internal(format!("Failed to get port: {e}")))?
            .port();
        drop(listener);

        match adb::forward_abstract_socket_with_timeout(
            &serial,
            host_port,
            &req.socket_name,
            WEBVIEW_ADB_TIMEOUT,
        )
        .await
        {
            Ok(()) => {
                self.svc
                    .webview_forwards
                    .write()
                    .await
                    .insert(host_port, req.socket_name);
                Ok(Response::new(proto::ForwardWebViewPortResponse {
                    request_id,
                    success: true,
                    local_port: host_port as u32,
                    error_message: String::new(),
                }))
            }
            Err(e) => Ok(Response::new(proto::ForwardWebViewPortResponse {
                request_id,
                success: false,
                local_port: 0,
                error_message: format!("Failed to forward WebView port: {e}"),
            })),
        }
    }

    async fn take_screenshot(
        &self,
        request_id: String,
    ) -> Result<Response<proto::ScreenshotResponse>, Status> {
        let serial = self.svc.active_serial().await?;
        match screenshot::capture(&serial, Platform::Android).await {
            Ok(data) => Ok(Response::new(proto::ScreenshotResponse {
                request_id,
                success: true,
                data,
                error_message: String::new(),
                orientation: String::new(),
            })),
            Err(e) => Ok(Response::new(proto::ScreenshotResponse {
                request_id,
                success: false,
                data: Vec::new(),
                error_message: e.to_string(),
                orientation: String::new(),
            })),
        }
    }

    async fn prearm_network_tracing(&self, req: &proto::SetDeviceRequest) {
        // Install the MITM CA now — during setup, before the agent starts
        // and before the first app launch — whether or not the trace
        // records network: with tracing off the runner still starts
        // capture on demand, on a test's first route() or network wait
        // (PILOT-775). Two things depend on it happening here:
        // - the install runs `adb root`, which restarts adbd on a rootable
        //   image that is not root yet. Mid-session that ends the agent's
        //   instrumentation and drops its forward (PILOT-831), so it must
        //   come before the agent;
        // - the app under test then forks from a zygote that already trusts
        //   the cert (Android 14+ injects into the zygote mount namespace,
        //   which only future forks inherit), which spares the first HTTPS
        //   request on a freshly-booted device.
        // Best-effort: a device that cannot take the CA (a Google Play
        // image) is reported when capture starts, not here. See
        // `ensure_android_ca_installed`.
        self.svc.ensure_android_ca_installed(&req.serial).await;
    }

    fn check_start_agent(
        &self,
        _request_id: &str,
        _req: &proto::StartAgentRequest,
    ) -> Result<(), proto::ActionResponse> {
        Ok(())
    }

    async fn reuse_agent(&self, _serial: &str, _req: &proto::StartAgentRequest) {}

    async fn launch_agent(
        &self,
        request_id: String,
        serial: String,
        req: &proto::StartAgentRequest,
    ) -> Result<AgentLaunched, proto::ActionResponse> {
        // ─── Android: install APKs and launch instrumentation ───
        if let Err(e) = adb::wait_for_device_ready(&serial, Duration::from_secs(45)).await {
            return Err(proto::ActionResponse {
                request_id,
                success: false,
                error_type: "DEVICE_NOT_READY".to_string(),
                error_message: format!("Android device was not ready before starting agent: {e}"),
                screenshot: Vec::new(),
                app_launched_fresh: false,
            });
        }

        let has_apk_paths = !req.agent_apk_path.is_empty() && !req.agent_test_apk_path.is_empty();

        if !has_apk_paths {
            let agent_installed = adb::is_package_installed(&serial, AGENT_PACKAGE)
                .await
                .unwrap_or(false);
            if !agent_installed {
                return Err(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "AGENT_NOT_INSTALLED".to_string(),
                    error_message: "Tapsmith agent is not installed on the device. \
                            Set agentApk and agentTestApk in your Tapsmith config, \
                            or install manually with: adb install <path-to-agent.apk>"
                        .to_string(),
                    screenshot: Vec::new(),
                    app_launched_fresh: false,
                });
            }
        } else {
            // Install each APK whose bytes differ from the device's copy, so
            // a rebuilt agent is deployed without manual intervention and an
            // unchanged one costs no install (PILOT-975).
            let apks = [
                (AGENT_PACKAGE, req.agent_apk_path.as_str(), "agent APK"),
                (
                    AGENT_TEST_PACKAGE,
                    req.agent_test_apk_path.as_str(),
                    "agent test APK",
                ),
            ];
            let to_install = agent_apks_to_install(&serial, &apks).await;
            for (_, path, label) in apks.iter().filter(|(pkg, _, _)| to_install.contains(pkg)) {
                info!(apk = %path, "Installing {label}");
                if let Err(e) = adb::install_apk(&serial, path, true).await {
                    return Err(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "AGENT_INSTALL_FAILED".to_string(),
                        error_message: format!("Failed to install {label}: {e}"),
                        screenshot: Vec::new(),
                        app_launched_fresh: false,
                    });
                }
            }
            if to_install.is_empty() {
                info!("Agent APKs on the device match the configured ones; skipping install");
            } else {
                info!("Agent APKs installed successfully");
            }
        }

        // Launch the agent instrumentation
        agent_comms::clear_stream_cache(&self.svc.agent_stream).await;
        // The agent refuses every connection that does not open with this
        // token (PILOT-969).
        let token = match crate::agent_auth::agent_token() {
            Ok(token) => token,
            Err(e) => {
                return Err(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "AGENT_START_FAILED".to_string(),
                    error_message: format!("{e:#}"),
                    screenshot: Vec::new(),
                    app_launched_fresh: false,
                });
            }
        };
        // The token reaches the device shell on adb's stdin, never on a
        // command line `ps` would show on the host. Launch in background on
        // device, keeping the runner's output on the device for the failure
        // diagnostics below.
        let bg_cmd = agent_launch_command(
            &req.target_package,
            &format!("\"${TOKEN_SHELL_VAR}\""),
            ANDROID_AGENT_LOG_PATH,
        );
        if let Err(e) = adb::shell_with_secret(&serial, TOKEN_SHELL_VAR, token, &bg_cmd).await {
            error!(error = %e, "Failed to start agent instrumentation");
            return Err(proto::ActionResponse {
                request_id,
                success: false,
                error_type: "AGENT_START_FAILED".to_string(),
                error_message: e.to_string(),
                screenshot: Vec::new(),
                app_launched_fresh: false,
            });
        }
        // The Android agent never launches the app.
        Ok(AgentLaunched::default())
    }

    async fn connect_agent(&self, agent: &mut AgentConnection, serial: &str) -> anyhow::Result<()> {
        // The instrumentation was launched just above. Wait for it to
        // actually answer: through the forwarded port a bare connect
        // succeeds before (or without) the agent ever listening.
        agent
            .connect_android_with_readiness(serial, ANDROID_AGENT_START_READINESS)
            .await
    }

    async fn after_agent_connected(&self, _serial: &str, target_package: &str) {
        // Resolve and cache the Android launcher activity now, while
        // the device is calm, so every later clean-task relaunch (the
        // restart/clear reset rungs) can discard saved instance state
        // without depending on a `resolve-activity` call landing under
        // load. `pm clear` wipes app data but NOT the ActivityManager
        // task record, so a relaunch that can't clear the task brings
        // back the old route and scroll position.
        // A configured activity (StartAgentRequest.launch_activity) needs no
        // resolving: `launcher_activity` answers it first.
        if !target_package.is_empty()
            && self
                .svc
                .configured_launch_activity(target_package)
                .await
                .is_none()
        {
            if let Ok(serial) = self.svc.active_serial().await {
                let activity = self
                    .svc
                    .resolve_launcher_activity(&serial, target_package)
                    .await
                    .ok()
                    .flatten();
                let mut cache = self.svc.android_launcher_activity.write().await;
                match activity {
                    Some(activity) => {
                        cache.insert(target_package.to_string(), activity);
                    }
                    None => {
                        cache.remove(target_package);
                    }
                }
            }
        }
    }

    async fn agent_start_diagnostics(&self, serial: &str) -> String {
        android_agent_start_diagnostics(serial).await
    }

    async fn trust_capture_ca(
        &self,
        _request_id: String,
        serial: String,
        mitm_ca: &Arc<MitmAuthority>,
        ca_pem_path: &str,
        warnings: &mut Vec<String>,
        tunnel_all_tls: &mut Option<String>,
    ) -> Result<(), CaptureStop> {
        let cert_filename = mitm_ca
            .device_cert_filename()
            .map_err(|e| Status::internal(format!("Failed to compute CA cert hash: {e}")))?;
        let daemon_agent = self.svc.android_agent_started_on(&serial).await;
        match adb::install_ca_cert(&serial, ca_pem_path, &cert_filename, daemon_agent).await {
            Ok(installed) => {
                if installed.store == adb::CaTrustStore::User {
                    let msg = android_user_store_ca_warning();
                    warn!("{msg}");
                    warnings.push(msg);
                }
                *self.svc.proxy_ca_cert_path.write().await = Some(installed.cleanup_path);
            }
            Err(e) => {
                let (tunnel, msg) = android_ca_install_failure(&e);
                if tunnel {
                    *tunnel_all_tls = Some(msg.clone());
                }
                error!("{msg}");
                warnings.push(msg);
            }
        }
        Ok(())
    }

    async fn start_capture_proxy(
        &self,
        _request_id: String,
        _serial: String,
        mitm_ca: &Arc<MitmAuthority>,
    ) -> Result<NetworkProxy, CaptureStop> {
        Ok(NetworkProxy::start(Arc::clone(mitm_ca))
            .await
            .map_err(|e| Status::internal(format!("Failed to start proxy: {e}")))?)
    }

    async fn check_capture_reachable(
        &self,
        _request_id: String,
        _host_port: u16,
    ) -> Result<(), CaptureStop> {
        Ok(())
    }

    async fn route_capture_traffic(
        &self,
        request_id: String,
        serial: String,
        _req: &proto::StartNetworkCaptureRequest,
        proxy: &NetworkProxy,
        _mitm_ca: &Arc<MitmAuthority>,
        host_port: u16,
        http_ports: &[u16],
        warnings: &mut Vec<String>,
    ) -> Result<CaptureRoute, CaptureStop> {
        let route: proto::NetworkCaptureRoute;
        {
            // Use `adb reverse` to make the proxy reachable as
            // 127.0.0.1:{device_port} on the device. The host proxy port
            // is OS-assigned and only known to be free on the host; the
            // same number can still be occupied on the device. Try it
            // first for continuity, then fall back to alternate device
            // ports while forwarding all of them to the same host port.
            let device_port = match setup_android_reverse_with_fallback(&serial, host_port).await {
                Ok(port) => port,
                Err(msg) => {
                    error!("{msg}");
                    return Err(CaptureStop::Respond(proto::StartNetworkCaptureResponse {
                        request_id,
                        success: false,
                        proxy_port: 0,
                        error_message: msg,
                        ..Default::default()
                    }));
                }
            };

            info!(%serial, device_port, host_port, "Configuring Android proxy");

            // PILOT-187: Use iptables transparent redirect instead of the
            // system HTTP proxy setting. Some Android HTTP clients (notably
            // React Native's fetch/OkHttp) don't issue CONNECT tunnels for
            // HTTPS through the system proxy, causing HTTPS traffic to be
            // recorded as http://. Transparent redirect intercepts at the
            // TCP level, so TLS is correctly detected from the ClientHello.
            // PILOT-782: OS services' traffic goes to its own listener, so
            // their certificate rejects are not blamed on the app.
            let os_service = os_service_redirect(&serial, proxy).await;
            let iptables_ok =
                adb::setup_iptables_redirect(&serial, device_port, http_ports, os_service.as_ref())
                    .await;
            *self.svc.proxy_uses_iptables.write().await = iptables_ok;
            // Recorded even when the redirect fell back without it, so its
            // reverse rule is removed with the capture.
            *self.svc.proxy_os_service_redirect.write().await = os_service;
            route = if iptables_ok {
                proto::NetworkCaptureRoute::AndroidTransparent
            } else {
                proto::NetworkCaptureRoute::AndroidHttpProxy
            };
            // The redirect is IPv4-only. On a device with IPv6 egress, an
            // app that prefers IPv6 bypasses it entirely and its traffic is
            // *invisible* — no capture entry and no `passthrough` marker,
            // which reads as "the app made no request". Say so rather than
            // letting it look like a capture bug. (Emulators normally have
            // no IPv6 default route, so this stays quiet there.)
            if iptables_ok && adb::has_ipv6_default_route(&serial).await {
                let msg = "Device has IPv6 connectivity but the transparent redirect \
                               is IPv4-only — traffic the app sends over IPv6 bypasses \
                               capture entirely and will not appear in the trace"
                    .to_string();
                warn!(%serial, "{msg}");
                warnings.push(msg);
            }
            if !iptables_ok {
                // Fallback: set the system HTTP proxy for non-rooted devices
                // or emulators where iptables is unavailable.
                warn!(
                    %serial,
                    "iptables redirect unavailable, falling back to system HTTP proxy"
                );
                let proxy_setting = format!("127.0.0.1:{device_port}");
                if let Err(e) = adb::shell(
                    &serial,
                    &format!("settings put global http_proxy {proxy_setting}"),
                )
                .await
                {
                    let msg = format!("Failed to configure Android HTTP proxy: {e}");
                    error!("{msg}");
                    return Err(CaptureStop::Respond(proto::StartNetworkCaptureResponse {
                        request_id,
                        success: false,
                        proxy_port: 0,
                        error_message: msg,
                        ..Default::default()
                    }));
                }
                warnings.push(
                    "iptables redirect unavailable; using Android system HTTP proxy fallback"
                        .to_string(),
                );
            }
            *self.svc.proxy_reverse_port.write().await = Some(device_port);
        }
        Ok(CaptureRoute {
            route,
            #[cfg(target_os = "macos")]
            pending_lease: None,
        })
    }

    async fn release_capture_route(
        &self,
        serial: &str,
        reverse_ports: Vec<u16>,
        ca_cert_path: Option<String>,
        used_iptables: bool,
    ) {
        info!(%serial, "Reverting Android proxy configuration");
        // Run cleanup commands concurrently — they're independent
        // and each has its own timeout. Sequential execution on
        // slow CI emulators can exceed the gRPC deadline.
        let serial_a = serial.to_string();
        let serial_b = serial.to_string();
        let serial_c = serial.to_string();
        let proxy_cleanup = async move {
            if used_iptables {
                adb::cleanup_iptables_redirect(&serial_a).await;
            } else if let Err(e) = adb::shell_with_timeout(
                &serial_a,
                "settings put global http_proxy :0",
                ANDROID_PROXY_CLEANUP_TIMEOUT,
            )
            .await
            {
                warn!(serial = %serial_a, "Failed to reset http_proxy: {e}");
            }
        };
        let reverse_cleanup = async move {
            for port in reverse_ports {
                if let Err(e) =
                    adb::remove_reverse_with_timeout(&serial_b, port, ANDROID_PROXY_CLEANUP_TIMEOUT)
                        .await
                {
                    warn!(serial = %serial_b, port, "Failed to remove reverse port forward: {e}");
                }
            }
        };
        let cert_cleanup = async move {
            if let Some(cert_path) = &ca_cert_path {
                if let Err(e) = adb::shell_with_timeout(
                    &serial_c,
                    &format!("rm -f {cert_path}"),
                    ANDROID_PROXY_CLEANUP_TIMEOUT,
                )
                .await
                {
                    warn!(serial = %serial_c, "Failed to remove CA cert: {e}");
                }
            }
        };
        tokio::join!(proxy_cleanup, reverse_cleanup, cert_cleanup);
    }

    async fn release_capture_route_on_shutdown(
        &self,
        serial: &str,
        reverse_ports: Vec<u16>,
        ca_cert_path: Option<String>,
        used_iptables: bool,
    ) {
        info!(%serial, "Cleaning up Android proxy settings on shutdown");
        if used_iptables {
            adb::cleanup_iptables_redirect(serial).await;
        } else if let Err(e) = adb::shell_with_timeout(
            serial,
            "settings put global http_proxy :0",
            ANDROID_PROXY_CLEANUP_TIMEOUT,
        )
        .await
        {
            warn!(%serial, "Failed to reset http_proxy on shutdown: {e}");
        }
        for port in reverse_ports {
            if let Err(e) =
                adb::remove_reverse_with_timeout(serial, port, ANDROID_PROXY_CLEANUP_TIMEOUT).await
            {
                warn!(%serial, port, "Failed to remove reverse port forward on shutdown: {e}");
            }
        }
        if let Some(cert_path) = &ca_cert_path {
            if let Err(e) = adb::shell_with_timeout(
                serial,
                &format!("rm -f {cert_path}"),
                ANDROID_PROXY_CLEANUP_TIMEOUT,
            )
            .await
            {
                warn!(%serial, "Failed to remove CA cert on shutdown: {e}");
            }
        }
    }
}

/// The OS-service side of the Android transparent redirect (PILOT-782): a
/// second proxy listener, reachable on the device through its own
/// `adb reverse`, and the UIDs whose traffic goes there. Best-effort — `None`
/// leaves every connection unattributed, as before.
async fn os_service_redirect(serial: &str, proxy: &NetworkProxy) -> Option<adb::OsServiceRedirect> {
    let host_port = match proxy.start_os_service_listener().await {
        Ok(port) => port,
        Err(e) => {
            warn!(%serial, "OS-service proxy listener unavailable: {e:#}");
            return None;
        }
    };
    let device_port = match setup_android_reverse_with_fallback(serial, host_port).await {
        Ok(port) => port,
        Err(e) => {
            warn!(%serial, "adb reverse for the OS-service proxy listener failed: {e}");
            return None;
        }
    };
    let uid_ranges = adb::os_service_uid_ranges(serial).await;
    debug!(%serial, device_port, host_port, ?uid_ranges, "OS-service redirect");
    Some(adb::OsServiceRedirect {
        device_port,
        uid_ranges,
    })
}

/// The device shell variable the agent token is read into.
const TOKEN_SHELL_VAR: &str = "TAPSMITH_AGENT_TOKEN";

/// Where `unlock` starts, from the screen's wakefulness and the keyguard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UnlockStart {
    /// The screen is on and no lock screen shows: nothing to do. Sending
    /// any key or swipe here would land on the foreground app.
    AlreadyUnlocked,
    /// The screen is on but a lock screen shows (or the dump cannot tell):
    /// dismiss it without the wake key and its settle wait.
    Dismiss,
    /// The screen is off, dozing or dreaming, or its state is unknown: wake
    /// it first, as before.
    WakeFirst,
}

fn unlock_start(awake: Option<bool>, keyguard_showing: Option<bool>) -> UnlockStart {
    match (awake, keyguard_showing) {
        (Some(true), Some(false)) => UnlockStart::AlreadyUnlocked,
        (Some(true), _) => UnlockStart::Dismiss,
        _ => UnlockStart::WakeFirst,
    }
}

/// The agent's `takeSystemDialogEvents` result as proto events; malformed
/// entries are skipped rather than failing the whole list.
pub(super) fn system_dialog_events_from(data: &Value) -> Vec<proto::SystemDialogEvent> {
    let text = |e: &Value, key: &str| {
        e.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    data.get("events")
        .and_then(Value::as_array)
        .map(|events| {
            events
                .iter()
                .filter(|e| e.is_object())
                .map(|e| proto::SystemDialogEvent {
                    title: text(e, "title"),
                    owner: text(e, "owner"),
                    owned_by_target: e
                        .get("ownedByTarget")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    kind: text(e, "kind"),
                    button: text(e, "button"),
                    timestamp_ms: e.get("timestampMs").and_then(Value::as_i64).unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Orientation {
    Portrait,
    Landscape,
}

impl Orientation {
    fn as_str(self) -> &'static str {
        match self {
            Orientation::Portrait => "portrait",
            Orientation::Landscape => "landscape",
        }
    }
}

/// Which `user_rotation` values show the default display portrait and which
/// landscape. Rotation 0 is the display's natural orientation: portrait on a
/// phone, landscape on most tablets. Rotations of the same parity give the
/// same shape (landscape and seascape, portrait and upside down).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RotationMap {
    portrait: u8,
    landscape: u8,
}

impl RotationMap {
    /// A phone: AOSP's defaults for a taller-than-wide natural display.
    const PORTRAIT_NATIVE: Self = Self {
        portrait: 0,
        landscape: 1,
    };
    /// AOSP's defaults for a wider-than-tall natural display: portrait is
    /// 270 degrees, as 90 is its upside-down portrait.
    const LANDSCAPE_NATIVE: Self = Self {
        portrait: 3,
        landscape: 0,
    };

    fn user_rotation_for(self, orientation: Orientation) -> u8 {
        match orientation {
            Orientation::Portrait => self.portrait,
            Orientation::Landscape => self.landscape,
        }
    }

    /// The screen's shape at `user_rotation` `rotation` (unset reads as 0).
    fn orientation_of(self, rotation: &str) -> Orientation {
        let rotation: u8 = rotation.trim().parse().unwrap_or(0);
        if rotation % 2 == self.landscape % 2 {
            Orientation::Landscape
        } else {
            Orientation::Portrait
        }
    }
}

/// The shell command `rotation_map` reads: the window manager's rotation
/// policy for each display (with its `Display: mDisplayId=` header), then the
/// default display's size as a fallback.
const ROTATION_PROBE: &str = "dumpsys window displays | grep -E 'Display: mDisplayId=|mPortraitRotation=|mLandscapeRotation='; wm size";

/// `0`–`3` from a rotation value as `dumpsys window` prints it: `ROTATION_270`
/// on current releases, or a bare `3`.
fn parse_rotation(value: &str) -> Option<u8> {
    let value = value.trim();
    let n = match value.strip_prefix("ROTATION_") {
        Some(degrees) => degrees.parse::<u16>().ok().filter(|d| d % 90 == 0)? / 90,
        None => value.parse::<u16>().ok()?,
    };
    u8::try_from(n).ok().filter(|n| *n < 4)
}

/// The part of `dumpsys window displays` that describes the default display:
/// from its `Display: mDisplayId=0` header to the next display's. Displays
/// are not listed in id order (a newly added one comes first). Output with
/// no display headers at all is taken as the default display's.
fn default_display_section(output: &str) -> Option<&str> {
    const HEADER: &str = "Display: mDisplayId=";
    let headers: Vec<usize> = output.match_indices(HEADER).map(|(i, _)| i).collect();
    if headers.is_empty() {
        return Some(output);
    }
    headers.iter().enumerate().find_map(|(n, &start)| {
        let id: String = output[start + HEADER.len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        (id == "0").then(|| &output[start..headers.get(n + 1).copied().unwrap_or(output.len())])
    })
}

/// The first value of `key=` in `output`.
fn rotation_field(output: &str, key: &str) -> Option<u8> {
    let start = output.find(key)? + key.len();
    let value: String = output[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    parse_rotation(&value)
}

/// The window manager's own portrait and landscape rotations, which also
/// account for devices configured to turn the other way.
fn rotation_policy(output: &str) -> Option<RotationMap> {
    let output = default_display_section(output)?;
    let portrait = rotation_field(output, "mPortraitRotation=")?;
    let landscape = rotation_field(output, "mLandscapeRotation=")?;
    (portrait % 2 != landscape % 2).then_some(RotationMap {
        portrait,
        landscape,
    })
}

/// The default display's size at rotation 0 (its natural orientation), from
/// `wm size`: the override size when one is set, else the physical size.
/// Both are reported unrotated, whatever the current rotation.
fn natural_display_size(wm_size: &str) -> Option<(u32, u32)> {
    let size_after = |label: &str| {
        wm_size.lines().find_map(|line| {
            let (w, h) = line.trim().strip_prefix(label)?.trim().split_once('x')?;
            Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
        })
    };
    size_after("Override size:").or_else(|| size_after("Physical size:"))
}

/// The rotation map from `ROTATION_PROBE`'s output: the window manager's
/// policy, else AOSP's defaults for the natural display's shape. `None` when
/// neither can be read.
fn rotation_map_from(output: &str) -> Option<RotationMap> {
    rotation_policy(output).or_else(|| {
        natural_display_size(output).map(|(w, h)| {
            if w > h {
                RotationMap::LANDSCAPE_NATIVE
            } else {
                RotationMap::PORTRAIT_NATIVE
            }
        })
    })
}

/// Where the default display stands in a turn to `user_rotation` `wanted`,
/// as [`turn_state`] reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnState {
    /// Still turning: the window manager has not taken the new user rotation
    /// yet, the display does not have its new size yet, or the rotation is
    /// still animating (input sent meanwhile can be dropped or land turned).
    Turning,
    /// At rest. `turned` is false when the app in front holds its own
    /// orientation. `setting_seen` is false when the output does not show
    /// the window manager's user rotation, so it cannot say whether the
    /// setting has been taken yet.
    Settled { turned: bool, setting_seen: bool },
    /// The output does not show the display's size.
    Unknown,
}

/// The shell command [`turn_state`] reads.
const TURN_PROBE: &str = "dumpsys window displays";
/// Before Android 10 the display's section shows no rotation, and the user
/// rotation and the rotation animation are dumped elsewhere: the whole
/// window dump is read instead.
const LEGACY_TURN_PROBE: &str = "dumpsys window";

/// `WxH` after `label` on any line of `output`.
fn size_field(output: &str, label: &str) -> Option<(u32, u32)> {
    output.lines().find_map(|line| {
        let start = line.find(label)? + label.len();
        let value = line[start..].split_whitespace().next()?;
        let (w, h) = value.split_once('x')?;
        Some((w.parse().ok()?, h.parse().ok()?))
    })
}

/// The display's own rotation in its section: the line that starts with
/// `mRotation=`. A configuration's `mRotation=ROTATION_90}` sits mid-line.
fn display_rotation(section: &str) -> Option<u8> {
    section.lines().find_map(|line| {
        let value = line.trim_start().strip_prefix("mRotation=")?;
        parse_rotation(value.split_whitespace().next()?)
    })
}

/// The default display's turn to `user_rotation` `wanted`, from
/// [`TURN_PROBE`]'s output, or [`LEGACY_TURN_PROBE`]'s where the display's
/// section shows no rotation. The display has turned once the window manager
/// has taken the user rotation, its current size (`cur=`) is its natural
/// size (`base=`, else `init=`) turned by its rotation, and no rotation
/// animation (a `ScreenRotationAnimation`, or with shell transitions an
/// `AsyncRotationController`) is running. Without a rotation in the output,
/// the current size alone tells whether it turned.
fn turn_state(output: &str, wanted: u8) -> TurnState {
    let Some(section) = default_display_section(output) else {
        return TurnState::Unknown;
    };
    // `base=` (shown only when a `wm size` override differs from `init=`)
    // is the size at rotation 0 that `cur=` turns from.
    let natural = size_field(section, "base=").or_else(|| size_field(section, "init="));
    let (Some(natural), Some(current)) = (natural, size_field(section, "cur=")) else {
        return TurnState::Unknown;
    };
    let rotation = display_rotation(section);
    let legacy = rotation.is_none();
    let user_rotation = rotation_field(section, "mUserRotation=").or_else(|| {
        legacy
            .then(|| rotation_field(output, "mUserRotation="))
            .flatten()
    });
    if user_rotation.is_some_and(|r| r != wanted) {
        return TurnState::Turning;
    }
    let animating = section.contains("mScreenRotationAnimation:")
        || section.contains("AsyncRotationController")
        || (legacy && output.contains("mScreenRotationAnimation:"));
    // Whether the display is landscape at `rotation`; a square one is both.
    let natural_landscape = natural.0 > natural.1;
    let has_shape_of = |rotation: u8| {
        natural.0 == natural.1
            || (current.0 > current.1) == (natural_landscape != (rotation % 2 == 1))
    };
    let (sized, turned) = match rotation {
        Some(rotation) => (has_shape_of(rotation), rotation == wanted),
        None => (true, has_shape_of(wanted)),
    };
    if !sized || animating {
        return TurnState::Turning;
    }
    TurnState::Settled {
        turned,
        setting_seen: user_rotation.is_some(),
    }
}

/// How long `setOrientation` waits for the display to turn.
const TURN_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a display whose output does not show the window manager's user
/// rotation gets to start turning before an unturned display counts as held
/// by the app.
const TURN_UNSEEN_GRACE: Duration = Duration::from_secs(1);
const TURN_POLL: Duration = Duration::from_millis(50);

/// Wait until `serial`'s default display has finished turning to
/// `user_rotation` `wanted`, or has come to rest unturned because the app in
/// front holds its own orientation. Until then the screen still has its old
/// size, and input sent mid-turn can be dropped or land turned. Returns the
/// reason when the display is still turning at [`TURN_TIMEOUT`]; output it
/// cannot read is not waited on.
async fn wait_for_turn(serial: &str, wanted: u8) -> Result<(), String> {
    let started = tokio::time::Instant::now();
    let mut probe = TURN_PROBE;
    loop {
        let output = adb::shell(serial, probe)
            .await
            .map_err(|e| format!("could not read the display's rotation: {e}"))?;
        match next_turn_step(&output, probe, wanted, started.elapsed()) {
            TurnStep::UseLegacyProbe => {
                probe = LEGACY_TURN_PROBE;
                continue;
            }
            TurnStep::Unreadable => {
                warn!("Could not read the display's rotation; not waiting for it to turn");
                return Ok(());
            }
            TurnStep::Done { turned } => {
                if !turned {
                    info!(
                        wanted,
                        "The display did not turn; the app in front holds its orientation"
                    );
                }
                return Ok(());
            }
            TurnStep::TimedOut => {
                return Err(format!(
                    "the screen was still turning {} s after it was asked to turn",
                    TURN_TIMEOUT.as_secs()
                ));
            }
            TurnStep::Poll => tokio::time::sleep(TURN_POLL).await,
        }
    }
}

/// What [`wait_for_turn`] does after reading `probe`'s `output`, `elapsed`
/// into the wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnStep {
    /// The display's section shows no rotation: read [`LEGACY_TURN_PROBE`]
    /// from now on.
    UseLegacyProbe,
    /// Nothing to wait on: the output cannot be read.
    Unreadable,
    /// At rest; `turned` is false when the app in front holds its orientation.
    Done { turned: bool },
    /// Still turning at [`TURN_TIMEOUT`].
    TimedOut,
    /// Read again after [`TURN_POLL`].
    Poll,
}

fn next_turn_step(output: &str, probe: &str, wanted: u8, elapsed: Duration) -> TurnStep {
    if probe == TURN_PROBE
        && default_display_section(output).is_some_and(|s| display_rotation(s).is_none())
    {
        return TurnStep::UseLegacyProbe;
    }
    match turn_state(output, wanted) {
        TurnState::Unknown => return TurnStep::Unreadable,
        // A display that has not turned is only taken as held once the
        // window manager is known to have the setting, or has had the grace
        // to start turning.
        TurnState::Settled {
            turned,
            setting_seen,
        } if turned || setting_seen || elapsed >= TURN_UNSEEN_GRACE => {
            return TurnStep::Done { turned };
        }
        _ => {}
    }
    if elapsed >= TURN_TIMEOUT {
        TurnStep::TimedOut
    } else {
        TurnStep::Poll
    }
}

/// `serial`'s rotation map. Read on every call: a foldable's default display
/// changes shape as it folds. A device whose output can't be parsed gets the
/// phone mapping, with a warning; an adb failure is an error.
async fn rotation_map(serial: &str) -> Result<RotationMap, Status> {
    let output = adb::shell(serial, ROTATION_PROBE)
        .await
        .map_err(|e| Status::internal(format!("Could not read the display's rotations: {e}")))?;
    Ok(rotation_map_from(&output).unwrap_or_else(|| {
        warn!(output = %output.trim(), "Could not read the display's rotations; assuming a portrait-native display");
        RotationMap::PORTRAIT_NATIVE
    }))
}

/// `am start` for a VIEW intent on `uri`, restricted to `package` when the
/// session has a target app. `uri` is already free of single quotes.
///
/// `am` reports a failure on stderr, and only from API 34 does it also exit
/// non-zero; through API 33 it exits 0. So its stderr is folded into stdout and
/// its exit status ignored: [`am_start_outcome`] judges the text, the same on
/// every API level, and a non-zero exit from `adb` itself (a transport
/// failure) still fails the call.
fn deep_link_view_command(uri: &str, package: Option<&str>) -> String {
    let restrict = package.map(|pkg| format!(" -p {pkg}")).unwrap_or_default();
    format!("am start -a android.intent.action.VIEW -d '{uri}'{restrict} 2>&1 || true")
}

/// Which activity Android would pick for `uri` with no package restriction.
fn deep_link_resolve_command(uri: &str) -> String {
    format!("cmd package resolve-activity --brief -a android.intent.action.VIEW -d '{uri}'")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AmStartOutcome {
    Started,
    /// No activity matches the intent.
    Unresolved,
    /// Any other error `am` printed, or an exception it threw (a
    /// `SecurityException` for an activity that is not exported, say).
    Failed,
}

/// Judge `am start`'s combined stdout and stderr (see [`deep_link_view_command`]).
fn am_start_outcome(output: &str) -> AmStartOutcome {
    let threw = output.lines().map(str::trim_start).any(|line| {
        line.starts_with("Exception occurred while executing")
            || line.starts_with("Security exception")
            || line.starts_with("java.lang.")
    });
    if output.contains("unable to resolve Intent") {
        AmStartOutcome::Unresolved
    } else if threw || am_start_error(output).is_some() {
        AmStartOutcome::Failed
    } else {
        AmStartOutcome::Started
    }
}

/// Who would take a link the app under test cannot handle.
#[derive(Debug, Clone, PartialEq, Eq)]
enum LinkHandler {
    App(String),
    /// Several apps match and none is the default: Android asks the user.
    Chooser,
    Nothing,
    Unknown,
}

/// Parse `cmd package resolve-activity --brief`: its last line is
/// `<package>/<activity>`, or `No activity found`.
fn parse_resolved_handler(output: &str) -> LinkHandler {
    let Some(last) = output.lines().map(str::trim).rfind(|l| !l.is_empty()) else {
        return LinkHandler::Unknown;
    };
    if last.starts_with("No activity found") {
        return LinkHandler::Nothing;
    }
    match last.split_once('/') {
        Some((pkg, activity)) if !pkg.is_empty() && !pkg.contains(char::is_whitespace) => {
            if pkg == "android" && activity.contains("ResolverActivity") {
                LinkHandler::Chooser
            } else {
                LinkHandler::App(pkg.to_string())
            }
        }
        _ => LinkHandler::Unknown,
    }
}

fn unhandled_link_message(uri: &str, target: &str, handler: &LinkHandler) -> String {
    let elsewhere = match handler {
        LinkHandler::App(pkg) => format!(" Android would open it in {pkg} instead."),
        LinkHandler::Chooser => " Android would ask which app to open it with instead.".to_string(),
        LinkHandler::Nothing => " No other app on the device handles it either.".to_string(),
        LinkHandler::Unknown => String::new(),
    };
    format!(
        "openDeepLink: {target} has no activity that handles {uri}, so the link was not \
         opened.{elsewhere} Tapsmith delivers deep links to the app under test only. Check the \
         link's scheme, host and path against the app's intent filters \
         (`adb shell dumpsys package {target}` lists them)."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deep_links_go_to_the_target_package_when_there_is_one() {
        assert_eq!(
            deep_link_view_command("https://en.wikipedia.org/wiki/Moon", Some("org.wikipedia.dev")),
            "am start -a android.intent.action.VIEW -d 'https://en.wikipedia.org/wiki/Moon' -p org.wikipedia.dev 2>&1 || true"
        );
        assert_eq!(
            deep_link_view_command("myapp://x", None),
            "am start -a android.intent.action.VIEW -d 'myapp://x' 2>&1 || true"
        );
    }

    #[test]
    fn am_start_output_is_judged_by_its_text_on_every_api_level() {
        // What `am` prints, stderr folded into stdout (through API 33 it exits
        // 0 on these errors, so the text is all there is).
        assert_eq!(
            am_start_outcome(
                "Starting: Intent { act=android.intent.action.VIEW dat=https://example.com/... pkg=org.x }\n\
                 Error: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW \
                 dat=https://example.com/... flg=0x10000000 pkg=org.x }\n"
            ),
            AmStartOutcome::Unresolved
        );
        assert_eq!(
            am_start_outcome(
                "Starting: Intent { act=android.intent.action.VIEW dat=myapp://x pkg=org.x }\n\
                 Error type 3\nError: Activity class {org.x/org.x.Gone} does not exist.\n"
            ),
            AmStartOutcome::Failed
        );
        // An activity that is not exported: `am` throws rather than printing
        // an `Error` line, and only its exit status (folded away) said so.
        assert_eq!(
            am_start_outcome(
                "Starting: Intent { act=android.intent.action.VIEW dat=myapp://x pkg=org.x }\n\
                 Exception occurred while executing 'start':\n\
                 java.lang.SecurityException: Permission Denial: starting Intent { act=android.intent.action.VIEW \
                 dat=myapp://x/... pkg=org.x cmp=org.x/.Hidden } from null (pid=1, uid=2000) not exported from uid 10190\n\
                 \tat com.android.server.wm.ActivityTaskSupervisor.checkStartAnyActivityPermission(ActivityTaskSupervisor.java:1210)\n"
            ),
            AmStartOutcome::Failed
        );
        assert_eq!(
            am_start_outcome(
                "Starting: Intent { act=android.intent.action.VIEW dat=myapp://x pkg=org.x }\n\
                 Security exception: Permission Denial: starting Intent { cmp=org.x/.Hidden } not exported from uid 10190\n"
            ),
            AmStartOutcome::Failed
        );
        assert_eq!(
            am_start_outcome(
                "Starting: Intent { act=android.intent.action.VIEW dat=myapp://x pkg=org.x }\n"
            ),
            AmStartOutcome::Started
        );
        assert_eq!(
            am_start_outcome(
                "Starting: Intent { act=android.intent.action.VIEW dat=myapp://x pkg=org.x }\n\
                 Warning: Activity not started, intent has been delivered to currently running top-most instance.\n"
            ),
            AmStartOutcome::Started
        );
    }

    #[test]
    fn resolve_activity_output_names_the_handler() {
        assert_eq!(
            parse_resolved_handler(
                "priority=0 preferredOrder=0 match=0x208000 specificIndex=-1 isDefault=true\n\
                 com.android.chrome/com.google.android.apps.chrome.IntentDispatcher\n"
            ),
            LinkHandler::App("com.android.chrome".into())
        );
        assert_eq!(
            parse_resolved_handler(
                "priority=0 preferredOrder=0 match=0x0 specificIndex=-1 isDefault=false\n\
                 android/com.android.internal.app.ResolverActivity\n"
            ),
            LinkHandler::Chooser
        );
        assert_eq!(
            parse_resolved_handler("No activity found\n"),
            LinkHandler::Nothing
        );
        assert_eq!(parse_resolved_handler(""), LinkHandler::Unknown);
        assert_eq!(
            parse_resolved_handler("Error: unknown command 'resolve-activity'"),
            LinkHandler::Unknown
        );
    }

    #[test]
    fn an_unhandled_link_names_the_app_and_who_would_take_it() {
        let msg = unhandled_link_message(
            "https://example.com/x",
            "org.wikipedia.dev",
            &LinkHandler::App("com.android.chrome".into()),
        );
        assert!(
            msg.contains("org.wikipedia.dev has no activity that handles https://example.com/x")
        );
        assert!(msg.contains("Android would open it in com.android.chrome instead."));
        assert!(msg.contains("adb shell dumpsys package org.wikipedia.dev"));
        assert!(
            unhandled_link_message("nosuch://x", "org.x", &LinkHandler::Nothing)
                .contains("No other app on the device handles it either.")
        );
        assert!(
            unhandled_link_message("https://a.b", "org.x", &LinkHandler::Chooser)
                .contains("ask which app to open it with")
        );
        let unknown = unhandled_link_message("https://a.b", "org.x", &LinkHandler::Unknown);
        assert!(unknown.contains("so the link was not opened. Tapsmith delivers"));
    }

    #[test]
    fn unlock_skips_everything_only_when_awake_and_unlocked() {
        assert_eq!(
            unlock_start(Some(true), Some(false)),
            UnlockStart::AlreadyUnlocked
        );
        // Awake with a lock screen up, or a keyguard dump that can't tell:
        // dismiss, but there is nothing to wake.
        assert_eq!(unlock_start(Some(true), Some(true)), UnlockStart::Dismiss);
        assert_eq!(unlock_start(Some(true), None), UnlockStart::Dismiss);
        // Asleep, or a power dump that can't tell, wakes first even when no
        // keyguard shows: the screen must be on before anything else.
        for keyguard in [Some(true), Some(false), None] {
            assert_eq!(unlock_start(Some(false), keyguard), UnlockStart::WakeFirst);
            assert_eq!(unlock_start(None, keyguard), UnlockStart::WakeFirst);
        }
    }

    #[test]
    fn system_dialog_events_map_every_field() {
        let data = json!({"events": [
            {"title": "Pixel Launcher isn't responding", "owner": "com.google.android.apps.nexuslauncher",
             "ownedByTarget": false, "kind": "anr", "button": "Close app", "timestampMs": 1_793_463_831_403_i64},
            {"title": "Test App isn't responding", "owner": "dev.tapsmith.testapp",
             "ownedByTarget": true, "kind": "anr", "button": "Wait", "timestampMs": 5},
        ]});
        let events = system_dialog_events_from(&data);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].title, "Pixel Launcher isn't responding");
        assert_eq!(events[0].owner, "com.google.android.apps.nexuslauncher");
        assert!(!events[0].owned_by_target);
        assert_eq!(events[0].kind, "anr");
        assert_eq!(events[0].button, "Close app");
        assert_eq!(events[0].timestamp_ms, 1_793_463_831_403);
        assert!(events[1].owned_by_target);
        assert_eq!(events[1].button, "Wait");
    }

    #[test]
    fn system_dialog_events_tolerate_missing_and_malformed_entries() {
        assert!(system_dialog_events_from(&json!({})).is_empty());
        assert!(system_dialog_events_from(&json!({"events": "nope"})).is_empty());
        let events =
            system_dialog_events_from(&json!({"events": [42, {"title": "X isn't responding"}]}));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "X isn't responding");
        assert_eq!(events[0].owner, "");
        assert!(!events[0].owned_by_target);
        assert_eq!(events[0].timestamp_ms, 0);
    }

    // `dumpsys window displays` on a Pixel Tablet (API 36), as ROTATION_PROBE
    // greps it, followed by `wm size`.
    const TABLET_PROBE: &str = "  Display: mDisplayId=0 (organized)\n    mLandscapeRotation=ROTATION_0 mSeascapeRotation=ROTATION_180\n    mPortraitRotation=ROTATION_270 mUpsideDownRotation=ROTATION_90\nPhysical size: 2560x1600\n";
    const PHONE_PROBE: &str = "    mLandscapeRotation=ROTATION_90 mSeascapeRotation=ROTATION_270\r\n    mPortraitRotation=ROTATION_0 mUpsideDownRotation=ROTATION_180\r\nPhysical size: 1080x2400\r\n";

    // `dumpsys window displays` on an API 36 phone, cut to the lines
    // `turn_state` reads, while turning to landscape (rotation 1) and after.
    const API36_TURNING: &str = "WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n  Display: mDisplayId=0 (organized)\n    init=1080x2400 420dpi mMinSizeOfResizeableTaskDp=220 cur=1080x2400 app=1080x2400 rng=1080x1080-2400x2400\n  AsyncRotationController\n    mTransitionOp=2\n    mOriginalRotation=0\n  DisplayRotation\n    mRotation=1 mDeferredRotationPauseCount=0\n    mUserRotationMode=USER_ROTATION_LOCKED mUserRotation=ROTATION_90 mCameraRotationMode=0\n";
    const API36_SIZED_STILL_ANIMATING: &str = "  Display: mDisplayId=0 (organized)\n    init=1080x2400 420dpi cur=2400x1080 app=2400x1080\n  AsyncRotationController\n    mTransitionOp=2\n  DisplayRotation\n    mRotation=1 mDeferredRotationPauseCount=0\n    mUserRotationMode=USER_ROTATION_LOCKED mUserRotation=ROTATION_90\n";
    const API36_TURNED: &str = "  Display: mDisplayId=0 (organized)\n    init=1080x2400 420dpi mMinSizeOfResizeableTaskDp=220 cur=2400x1080 app=2400x1080 rng=1080x1080-2400x2400\n  overrideConfig={1.0 winConfig={ mBounds=Rect(0, 0 - 2400, 1080) mDisplayRotation=ROTATION_90 mRotation=ROTATION_90}}\n  DisplayRotation\n    mRotation=1 mDeferredRotationPauseCount=0\n    mUserRotationMode=USER_ROTATION_LOCKED mUserRotation=ROTATION_90 mCameraRotationMode=0\n";
    // API 33 rotates without shell transitions: a ScreenRotationAnimation.
    const API33_ANIMATING: &str = "  Display: mDisplayId=0 (organized)\n    init=1080x2400 420dpi cur=2400x1080 app=2272x1080\n  mScreenRotationAnimation:\n    mSurface=Surface(name=RotationLayer)\n  DisplayRotation\n    mRotation=1 mDeferredRotationPauseCount=0\n    mUserRotationMode=USER_ROTATION_LOCKED mUserRotation=ROTATION_90\n";
    const API33_TURNED: &str = "  Display: mDisplayId=0 (organized)\n    init=1080x2400 420dpi cur=2400x1080 app=2272x1080\n  no ScreenRotationAnimation \n  DisplayRotation\n    mRotation=1 mDeferredRotationPauseCount=0\n    mUserRotationMode=USER_ROTATION_LOCKED mUserRotation=ROTATION_90\n";

    #[test]
    fn a_turn_is_settled_only_once_the_display_has_its_new_size_and_stopped_animating() {
        assert_eq!(turn_state(API36_TURNING, 1), TurnState::Turning);
        assert_eq!(
            turn_state(API36_SIZED_STILL_ANIMATING, 1),
            TurnState::Turning
        );
        assert_eq!(turn_state(API33_ANIMATING, 1), TurnState::Turning);
        let turned = TurnState::Settled {
            turned: true,
            setting_seen: true,
        };
        assert_eq!(turn_state(API36_TURNED, 1), turned);
        assert_eq!(turn_state(API33_TURNED, 1), turned);
    }

    #[test]
    fn a_turn_the_window_manager_has_not_taken_yet_is_still_turning() {
        // Straight after `settings put`: the window manager still has the old
        // user rotation, so the unchanged display says nothing yet.
        let before = "  Display: mDisplayId=0\n    init=1080x2400 420dpi cur=1080x2400\n  DisplayRotation\n    mRotation=0 mDeferredRotationPauseCount=0\n    mUserRotationMode=USER_ROTATION_LOCKED mUserRotation=ROTATION_0\n";
        assert_eq!(turn_state(before, 1), TurnState::Turning);
        // Already where it was asked to be.
        assert_eq!(
            turn_state(before, 0),
            TurnState::Settled {
                turned: true,
                setting_seen: true
            }
        );
    }

    #[test]
    fn an_app_that_holds_its_orientation_settles_unturned() {
        // The setting is taken, but the app in front asks for portrait.
        let held = "  Display: mDisplayId=0\n    init=1080x2400 420dpi cur=1080x2400\n  no ScreenRotationAnimation \n  DisplayRotation\n    mRotation=0 mDeferredRotationPauseCount=0\n    mUserRotationMode=USER_ROTATION_LOCKED mUserRotation=ROTATION_90\n";
        assert_eq!(
            turn_state(held, 1),
            TurnState::Settled {
                turned: false,
                setting_seen: true
            }
        );
    }

    #[test]
    fn a_size_override_of_the_other_shape_is_the_natural_size() {
        // `wm size 2400x1080` on a portrait phone: `base=` (printed only when
        // it differs from `init=`) is the size at rotation 0.
        let overridden = "  Display: mDisplayId=0\n    init=1080x2400 420dpi base=2400x1080 420dpi cur=2400x1080 app=2400x1080\n  DisplayRotation\n    mRotation=0 mDeferredRotationPauseCount=0\n    mUserRotation=ROTATION_0\n";
        assert_eq!(
            turn_state(overridden, 0),
            TurnState::Settled {
                turned: true,
                setting_seen: true
            }
        );
        let turning = overridden
            .replace("mUserRotation=ROTATION_0", "mUserRotation=ROTATION_90")
            .replace("mRotation=0", "mRotation=1");
        assert_eq!(turn_state(&turning, 1), TurnState::Turning);
        let turned = turning.replace("cur=2400x1080", "cur=1080x2400");
        assert_eq!(
            turn_state(&turned, 1),
            TurnState::Settled {
                turned: true,
                setting_seen: true
            }
        );
    }

    #[test]
    fn a_landscape_native_display_turns_to_portrait() {
        let turning = "  Display: mDisplayId=0\n    init=2560x1600 320dpi cur=2560x1600\n  DisplayRotation\n    mRotation=3 mDeferredRotationPauseCount=0\n    mUserRotation=ROTATION_270\n";
        assert_eq!(turn_state(turning, 3), TurnState::Turning);
        let turned = turning.replace("cur=2560x1600", "cur=1600x2560");
        assert_eq!(
            turn_state(&turned, 3),
            TurnState::Settled {
                turned: true,
                setting_seen: true
            }
        );
    }

    #[test]
    fn only_the_default_display_is_read() {
        let output = format!(
            "  Display: mDisplayId=2\n    init=800x600 160dpi cur=800x600\n  AsyncRotationController\n  DisplayRotation\n    mRotation=0\n    mUserRotation=ROTATION_0\n{API36_TURNED}"
        );
        assert_eq!(
            turn_state(&output, 1),
            TurnState::Settled {
                turned: true,
                setting_seen: true
            }
        );
    }

    #[test]
    fn output_without_the_user_rotation_settles_without_having_seen_the_setting() {
        // Older releases dump no `mUserRotation` here.
        let old = "  Display: mDisplayId=0\n    init=1080x1920 420dpi cur=1080x1920 app=1080x1794\n    mRotation=0\n";
        assert_eq!(
            turn_state(old, 1),
            TurnState::Settled {
                turned: false,
                setting_seen: false
            }
        );
    }

    #[test]
    fn unreadable_output_is_unknown() {
        assert_eq!(turn_state("", 1), TurnState::Unknown);
        assert_eq!(turn_state("garbage\n", 1), TurnState::Unknown);
        // No size line.
        assert_eq!(
            turn_state("  Display: mDisplayId=0\n    mRotation=1\n", 1),
            TurnState::Unknown
        );
        // No natural size.
        assert_eq!(
            turn_state(
                "  Display: mDisplayId=0\n    cur=1080x2400\n    mRotation=1\n",
                1
            ),
            TurnState::Unknown
        );
    }

    // The whole `dumpsys window` on an API 28 phone, cut to the lines
    // `turn_state` reads: the policy's user rotation comes before the
    // display's section, the rotation animation after it, and the section
    // shows no rotation.
    const API28_TURNING: &str = "WINDOW MANAGER POLICY STATE (dumpsys window policy)\n    mUserRotationMode=USER_ROTATION_LOCKED mUserRotation=ROTATION_90 mAllowAllRotations=false\nWINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n  Display: mDisplayId=0\n    init=1080x1920 420dpi cur=1920x1080 app=1794x1080 rng=1080x1017-1794x1731\n\nWINDOW MANAGER WINDOWS (dumpsys window windows)\n  mScreenRotationAnimation:\n    mSurface=Surface(name=ScreenshotSurface)\n";

    #[test]
    fn before_android_10_the_size_and_the_whole_dump_tell_the_turn() {
        assert_eq!(turn_state(API28_TURNING, 1), TurnState::Turning);
        let turned = API28_TURNING.replace("  mScreenRotationAnimation:\n", "");
        assert_eq!(
            turn_state(&turned, 1),
            TurnState::Settled {
                turned: true,
                setting_seen: true
            }
        );
        // The setting not taken yet.
        let before = turned
            .replace("ROTATION_90", "ROTATION_0")
            .replace("cur=1920x1080", "cur=1080x1920");
        assert_eq!(turn_state(&before, 1), TurnState::Turning);
        // Taken, but the app in front holds portrait.
        let held = turned.replace("cur=1920x1080", "cur=1080x1920");
        assert_eq!(
            turn_state(&held, 1),
            TurnState::Settled {
                turned: false,
                setting_seen: true
            }
        );
    }

    #[test]
    fn a_config_rotation_is_not_taken_for_the_display_rotation() {
        // winConfig's `mRotation=ROTATION_90}` comes first; the display's
        // own rotation is the line that starts with `mRotation=`.
        let output = "  Display: mDisplayId=0\n    init=1080x2400 420dpi cur=1080x2400\n  overrideConfig={ winConfig={ mDisplayRotation=ROTATION_90 mRotation=ROTATION_90}}\n  DisplayRotation\n    mRotation=0 mDeferredRotationPauseCount=0\n    mUserRotation=ROTATION_0\n";
        assert_eq!(
            turn_state(output, 0),
            TurnState::Settled {
                turned: true,
                setting_seen: true
            }
        );
    }

    #[test]
    fn the_wait_ends_once_the_turn_settles_and_fails_only_at_the_timeout() {
        let ms = Duration::from_millis;
        assert_eq!(
            next_turn_step(API36_TURNING, TURN_PROBE, 1, ms(100)),
            TurnStep::Poll
        );
        assert_eq!(
            next_turn_step(API36_TURNING, TURN_PROBE, 1, TURN_TIMEOUT),
            TurnStep::TimedOut
        );
        assert_eq!(
            next_turn_step(API36_TURNED, TURN_PROBE, 1, ms(100)),
            TurnStep::Done { turned: true }
        );
        // Settled wins over the timeout.
        assert_eq!(
            next_turn_step(API36_TURNED, TURN_PROBE, 1, TURN_TIMEOUT),
            TurnStep::Done { turned: true }
        );
        // Output that cannot be read tries the whole dump, then gives up.
        assert_eq!(
            next_turn_step("garbage", TURN_PROBE, 1, ms(0)),
            TurnStep::UseLegacyProbe
        );
        assert_eq!(
            next_turn_step("garbage", LEGACY_TURN_PROBE, 1, ms(0)),
            TurnStep::Unreadable
        );
    }

    #[test]
    fn a_held_orientation_ends_the_wait_at_once_when_the_setting_is_seen() {
        let held = "  Display: mDisplayId=0\n    init=1080x2400 420dpi cur=1080x2400\n  DisplayRotation\n    mRotation=0 mDeferredRotationPauseCount=0\n    mUserRotation=ROTATION_90\n";
        assert_eq!(
            next_turn_step(held, TURN_PROBE, 1, Duration::ZERO),
            TurnStep::Done { turned: false }
        );
    }

    #[test]
    fn without_the_setting_an_unturned_display_counts_as_held_only_after_the_grace() {
        // Shows a rotation but no user rotation: the setting may not be taken yet.
        let unseen =
            "  Display: mDisplayId=0\n    init=1080x2400 420dpi cur=1080x2400\n    mRotation=0\n";
        assert_eq!(
            next_turn_step(unseen, TURN_PROBE, 1, Duration::from_millis(200)),
            TurnStep::Poll
        );
        assert_eq!(
            next_turn_step(unseen, TURN_PROBE, 1, TURN_UNSEEN_GRACE),
            TurnStep::Done { turned: false }
        );
    }

    #[test]
    fn a_display_section_without_a_rotation_switches_to_the_whole_dump() {
        let api28_displays = "WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n  Display: mDisplayId=0\n    init=1080x1920 420dpi cur=1080x1920 app=1080x1794\n";
        assert_eq!(
            next_turn_step(api28_displays, TURN_PROBE, 1, Duration::ZERO),
            TurnStep::UseLegacyProbe
        );
        // The whole dump is then read as it is, without switching again.
        assert_eq!(
            next_turn_step(API28_TURNING, LEGACY_TURN_PROBE, 1, Duration::ZERO),
            TurnStep::Poll
        );
        let turned = API28_TURNING.replace("  mScreenRotationAnimation:\n", "");
        assert_eq!(
            next_turn_step(&turned, LEGACY_TURN_PROBE, 1, Duration::ZERO),
            TurnStep::Done { turned: true }
        );
    }

    #[test]
    fn the_window_managers_rotations_decide_the_map() {
        assert_eq!(
            rotation_map_from(TABLET_PROBE),
            Some(RotationMap::LANDSCAPE_NATIVE)
        );
        assert_eq!(
            rotation_map_from(PHONE_PROBE),
            Some(RotationMap::PORTRAIT_NATIVE)
        );
        // A device configured to turn the other way (config_reverseDefaultRotation).
        assert_eq!(
            rotation_map_from("mLandscapeRotation=ROTATION_0\nmPortraitRotation=ROTATION_90\nPhysical size: 2560x1600"),
            Some(RotationMap { portrait: 1, landscape: 0 })
        );
        // Older releases print bare numbers.
        assert_eq!(
            rotation_map_from("mLandscapeRotation=1 mSeascapeRotation=3\nmPortraitRotation=0 mUpsideDownRotation=2"),
            Some(RotationMap::PORTRAIT_NATIVE)
        );
    }

    #[test]
    fn only_the_default_displays_rotations_count() {
        // A secondary display (here an overlay display) is listed before
        // display 0, with a phone-shaped policy of its own.
        let probe = "  Display: mDisplayId=2\n    mLandscapeRotation=ROTATION_90 mSeascapeRotation=ROTATION_270\n    mPortraitRotation=ROTATION_0 mUpsideDownRotation=ROTATION_180\n  Display: mDisplayId=0 (organized)\n    mLandscapeRotation=ROTATION_0 mSeascapeRotation=ROTATION_180\n    mPortraitRotation=ROTATION_270 mUpsideDownRotation=ROTATION_90\nPhysical size: 2560x1600\n";
        assert_eq!(
            rotation_map_from(probe),
            Some(RotationMap::LANDSCAPE_NATIVE)
        );
        // Display 10 is not display 0.
        let probe = "  Display: mDisplayId=10\n    mLandscapeRotation=ROTATION_90 mPortraitRotation=ROTATION_0\n  Display: mDisplayId=0\n    mLandscapeRotation=ROTATION_0 mPortraitRotation=ROTATION_270\n";
        assert_eq!(
            rotation_map_from(probe),
            Some(RotationMap::LANDSCAPE_NATIVE)
        );
        // Headers but no display 0 block: the size decides instead.
        let probe = "  Display: mDisplayId=2\n    mLandscapeRotation=ROTATION_90 mPortraitRotation=ROTATION_0\nPhysical size: 2560x1600\n";
        assert_eq!(
            rotation_map_from(probe),
            Some(RotationMap::LANDSCAPE_NATIVE)
        );
    }

    #[test]
    fn without_a_rotation_policy_the_natural_size_decides() {
        assert_eq!(
            rotation_map_from("Physical size: 2560x1600\n"),
            Some(RotationMap::LANDSCAPE_NATIVE)
        );
        assert_eq!(
            rotation_map_from("Physical size: 1080x2400\n"),
            Some(RotationMap::PORTRAIT_NATIVE)
        );
        // The override size wins over the physical one.
        assert_eq!(
            rotation_map_from("Physical size: 1080x2400\nOverride size: 2400x1080\n"),
            Some(RotationMap::LANDSCAPE_NATIVE)
        );
        // A square display keeps the phone mapping.
        assert_eq!(
            rotation_map_from("Physical size: 2000x2000"),
            Some(RotationMap::PORTRAIT_NATIVE)
        );
        // A policy whose two rotations give the same shape is not believed.
        assert_eq!(
            rotation_map_from("mLandscapeRotation=ROTATION_0 mPortraitRotation=ROTATION_180\nPhysical size: 1080x2400"),
            Some(RotationMap::PORTRAIT_NATIVE)
        );
        for unreadable in [
            "",
            "Error: no display",
            "Physical size: widexhigh",
            "mPortraitRotation=ROTATION_45",
        ] {
            assert_eq!(rotation_map_from(unreadable), None, "{unreadable:?}");
        }
    }

    #[test]
    fn phones_keep_rotation_0_for_portrait_and_1_for_landscape() {
        let map = RotationMap::PORTRAIT_NATIVE;
        assert_eq!(map.user_rotation_for(Orientation::Portrait), 0);
        assert_eq!(map.user_rotation_for(Orientation::Landscape), 1);
        for (rotation, expected) in [
            ("0", Orientation::Portrait),
            ("1", Orientation::Landscape),
            ("2", Orientation::Portrait),
            ("3\n", Orientation::Landscape),
            ("null", Orientation::Portrait),
            ("", Orientation::Portrait),
        ] {
            assert_eq!(map.orientation_of(rotation), expected, "{rotation:?}");
        }
    }

    #[test]
    fn landscape_native_devices_turn_the_mapping_round() {
        let map = RotationMap::LANDSCAPE_NATIVE;
        // 270, not 90: 90 is a landscape-native display's upside-down portrait.
        assert_eq!(map.user_rotation_for(Orientation::Portrait), 3);
        assert_eq!(map.user_rotation_for(Orientation::Landscape), 0);
        for (rotation, expected) in [
            ("0", Orientation::Landscape),
            ("1", Orientation::Portrait),
            ("2", Orientation::Landscape),
            ("3", Orientation::Portrait),
            ("null", Orientation::Landscape),
            ("\n", Orientation::Landscape),
        ] {
            assert_eq!(map.orientation_of(rotation), expected, "{rotation:?}");
        }
    }

    #[test]
    fn every_orientation_set_reads_back_the_same() {
        let reversed = RotationMap {
            portrait: 1,
            landscape: 0,
        };
        for map in [
            RotationMap::PORTRAIT_NATIVE,
            RotationMap::LANDSCAPE_NATIVE,
            reversed,
        ] {
            for wanted in [Orientation::Portrait, Orientation::Landscape] {
                let rotation = map.user_rotation_for(wanted).to_string();
                assert_eq!(map.orientation_of(&rotation), wanted, "{map:?}");
            }
        }
    }

    #[test]
    fn launch_command_hands_the_agent_its_token_without_spelling_it_out() {
        // As launch_agent builds it: the token is a shell variable read from
        // adb's stdin, so it is never on a host command line.
        let cmd = agent_launch_command("", &format!("\"${TOKEN_SHELL_VAR}\""), "/l");
        assert!(
            cmd.contains("am instrument -w -e token \"$TAPSMITH_AGENT_TOKEN\" "),
            "{cmd}"
        );
    }
}
