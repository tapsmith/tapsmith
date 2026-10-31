//! Android device work: ADB on the host plus the UIAutomator2 agent.

use super::device_backend::{
    ActionResult, CaptureRoute, CaptureStop, DeviceBackend, PermissionChange,
};
use super::*;

use crate::android_agent_install::{
    force_install_requested, host_md5, installed_md5_command, needs_install, parse_installed_md5s,
    AGENT_PACKAGE, AGENT_TEST_PACKAGE, FORCE_INSTALL_ENV,
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
        let rotation = match orientation {
            "portrait" => "0",
            "landscape" => "1",
            other => {
                return Err(Status::invalid_argument(format!(
                    "orientation must be 'portrait' or 'landscape', got '{other}'"
                )));
            }
        };
        if let Err(e) = adb::shell(&serial, "settings put system accelerometer_rotation 0").await {
            error!(error = %e, "Failed to disable auto-rotate");
        }
        let cmd = format!("settings put system user_rotation {rotation}");
        self.svc.adb_action(request_id, &cmd).await
    }

    async fn get_orientation(&self) -> Result<String, Status> {
        let serial = self.svc.active_serial().await?;
        let output = adb::shell(&serial, "settings get system user_rotation")
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        let orientation = match output.trim() {
            "1" | "3" => "landscape",
            _ => "portrait",
        };
        Ok(orientation.to_string())
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

    async fn hide_keyboard(&self, request_id: String) -> ActionResult {
        // The Android soft keyboard is dismissed by BACK, not ESCAPE —
        // KEYCODE_ESCAPE is a no-op for the IME on most apps (incl.
        // Flutter). Only send BACK when the keyboard is actually shown,
        // otherwise BACK would pop the current screen / background the app.
        let serial = self.svc.active_serial().await?;
        let shown = self.svc.android_is_keyboard_shown(&serial).await?;
        if shown {
            self.svc
                .adb_action(request_id, "input keyevent KEYCODE_BACK")
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
        // Wake the screen first
        let _ = adb::shell_lenient(&serial, "input keyevent KEYCODE_WAKEUP").await;
        tokio::time::sleep(Duration::from_millis(500)).await;
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

        let cmd = format!("am start -a android.intent.action.VIEW -d '{}'", uri);
        if let Err(e) = adb::shell(&serial, &cmd).await {
            let screenshot = self.svc.error_screenshot().await;
            return Ok(Response::new(proto::ActionResponse {
                request_id,
                success: false,
                error_type: "ADB_COMMAND_FAILED".to_string(),
                error_message: e.to_string(),
                screenshot,
            }));
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
                "am start -S --activity-clear-task -n {}/{}",
                req.package_name, req.activity,
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
            let prefix = if is_root {
                String::new()
            } else {
                format!("run-as {pkg} ")
            };
            if excludes.is_empty() {
                format!("{prefix}tar czf {device_tmp} -C {data_dir} .")
            } else {
                format!("{prefix}tar czf {device_tmp} {excludes} -C {data_dir} .")
            }
        };
        let tar_result = adb::shell_with_timeout(
            &serial,
            &tar_cmd("--exclude=./cache --exclude=./code_cache"),
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
        let tar_result = if is_root {
            adb::shell_with_timeout(
                &serial,
                &format!("tar xzf {device_tmp} -C {data_dir}"),
                tar_timeout,
            )
            .await
        } else {
            adb::shell_with_timeout(
                &serial,
                &format!("run-as {pkg} tar xzf {device_tmp} -C {data_dir}"),
                tar_timeout,
            )
            .await
        };

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
            })),
            Err(e) => Ok(Response::new(proto::ScreenshotResponse {
                request_id,
                success: false,
                data: Vec::new(),
                error_message: e.to_string(),
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
    ) -> Result<(), proto::ActionResponse> {
        // ─── Android: install APKs and launch instrumentation ───
        if let Err(e) = adb::wait_for_device_ready(&serial, Duration::from_secs(45)).await {
            return Err(proto::ActionResponse {
                request_id,
                success: false,
                error_type: "DEVICE_NOT_READY".to_string(),
                error_message: format!("Android device was not ready before starting agent: {e}"),
                screenshot: Vec::new(),
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
        let instrument_cmd = if req.target_package.is_empty() {
            "am instrument -w dev.tapsmith.agent/.TapsmithAgent".to_string()
        } else {
            format!(
                "am instrument -w -e targetPackage {} dev.tapsmith.agent/.TapsmithAgent",
                req.target_package
            )
        };

        // Launch in background on device, keeping the runner's output
        // on the device for the failure diagnostics below.
        let bg_cmd = format!("nohup {instrument_cmd} > {ANDROID_AGENT_LOG_PATH} 2>&1 &");
        if let Err(e) = adb::shell(&serial, &bg_cmd).await {
            error!(error = %e, "Failed to start agent instrumentation");
            return Err(proto::ActionResponse {
                request_id,
                success: false,
                error_type: "AGENT_START_FAILED".to_string(),
                error_message: e.to_string(),
                screenshot: Vec::new(),
            });
        }
        Ok(())
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
        if !target_package.is_empty() {
            if let Ok(serial) = self.svc.active_serial().await {
                let activity = self
                    .svc
                    .resolve_launcher_activity(&serial, target_package)
                    .await
                    .ok()
                    .flatten();
                *self.svc.android_launcher_activity.write().await = activity;
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
            Ok(installed_path) => {
                *self.svc.proxy_ca_cert_path.write().await = Some(installed_path);
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
