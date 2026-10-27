//! macOS device work: the host Mac, driven through the XCUITest agent built
//! as a macOS UI-test bundle.
//!
//! The agent runs as `xcodebuild test-without-building` on this Mac and owns
//! the app's lifecycle (it launches the app by path at start-up, then by
//! bundle ID). Its start-up config lives in `ios_agent_config`, as on iOS.
//!
//! Everything not implemented yet fails loudly with "not supported on macOS
//! yet" (never a success for something that did not happen). Methods that
//! only clean up do nothing, since there is nothing to undo.

use super::device_backend::{
    ActionResult, CaptureRoute, CaptureStop, DeviceBackend, PermissionChange,
};
use super::*;
use crate::macos;
use std::path::Path;

pub(super) struct MacOsBackend<'a> {
    pub(super) svc: &'a TapsmithServiceImpl,
}

impl MacOsBackend<'_> {
    /// Stop the app, then clear its data: a running app can write its state
    /// back afterwards. The agent's terminate verifies the process is gone.
    async fn clear_data(&self, package: &str) -> Result<(), String> {
        let stopped = self
            .svc
            .send_agent_command_with_timeout(
                &AgentCommand::TerminateApp {
                    package: package.to_string(),
                },
                4_000,
            )
            .await;
        match stopped {
            Ok(resp) if resp.success => {}
            Ok(resp) => {
                return Err(format!(
                    "Could not stop {package} before clearing its data: {}",
                    resp.error
                        .unwrap_or_else(|| "the agent reported a failure".to_string())
                ))
            }
            Err(status) => {
                return Err(format!(
                    "Could not stop {package} before clearing its data: {}",
                    status.message()
                ))
            }
        }
        macos::app_data::clear_backed_up(package)
            .await
            .map_err(|e| format!("{e:#}"))
    }

    async fn relaunch(
        &self,
        request_id: String,
        serial: &str,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> ActionResult {
        let idle_timeout_ms = if idle_timeout_ms > 0 {
            idle_timeout_ms
        } else {
            10_000
        };
        match self
            .relaunch_app(serial, package_name, wait_for_idle, idle_timeout_ms)
            .await
        {
            Ok(()) => Ok(TapsmithServiceImpl::success_action_response(request_id)),
            Err(error_message) => Ok(self
                .svc
                .action_error(request_id, "LAUNCH_FAILED", error_message)
                .await),
        }
    }
}

fn unsupported_message(operation: &str) -> String {
    format!("{operation} is not supported on macOS yet")
}

fn unsupported(operation: &str) -> Status {
    Status::unimplemented(unsupported_message(operation))
}

#[async_trait::async_trait]
impl DeviceBackend for MacOsBackend<'_> {
    // ─── App ───

    async fn terminate_app(&self, request_id: String, package: &str) -> ActionResult {
        let result = self
            .svc
            .send_agent_command_with_timeout(
                &AgentCommand::TerminateApp {
                    package: package.to_string(),
                },
                4_000,
            )
            .await;
        self.svc.make_action_response(request_id, result).await
    }

    async fn app_state(&self, package: &str) -> Result<String, Status> {
        let command = AgentCommand::GetAppState {
            package: package.to_string(),
        };
        let result = self.svc.send_agent_command(&command).await?;
        result
            .data
            .get("state")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| Status::internal("The macOS agent returned no app state"))
    }

    // The app under test, as on iOS (the agent's `currentPackage` answers
    // the same configured bundle ID).
    async fn current_package(&self) -> Result<String, Status> {
        self.svc
            .ios_agent_config
            .read()
            .await
            .as_ref()
            .map(|c| c.target_package.clone())
            .ok_or_else(|| Status::failed_precondition("The macOS agent has not been started"))
    }

    async fn current_activity(&self) -> Result<String, Status> {
        Err(unsupported("Reading the foreground activity"))
    }

    async fn change_permission(
        &self,
        _request_id: String,
        _package: &str,
        _permission: &str,
        _change: PermissionChange,
    ) -> ActionResult {
        Err(unsupported("Changing permissions"))
    }

    // ─── Device state ───

    // The Mac's own pasteboard: a test that sets it replaces whatever the
    // user had copied.
    async fn set_clipboard(&self, request_id: String, text: String) -> ActionResult {
        let result = self
            .svc
            .send_agent_command(&AgentCommand::SetClipboard { text })
            .await;
        self.svc.make_action_response(request_id, result).await
    }

    async fn get_clipboard(&self) -> Result<String, Status> {
        let result = self
            .svc
            .send_agent_command(&AgentCommand::GetClipboard {})
            .await?;
        result
            .data
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| Status::internal("The macOS agent returned no clipboard text"))
    }

    async fn set_orientation(&self, _request_id: String, _orientation: &str) -> ActionResult {
        Err(unsupported("Setting the orientation"))
    }

    async fn get_orientation(&self) -> Result<String, Status> {
        Err(unsupported("Reading the orientation"))
    }

    async fn set_color_scheme(&self, _request_id: String, _scheme: &str) -> ActionResult {
        Err(unsupported("Setting the color scheme"))
    }

    async fn get_color_scheme(&self) -> Result<String, Status> {
        Err(unsupported("Reading the color scheme"))
    }

    async fn is_keyboard_shown(&self) -> Result<bool, Status> {
        Err(unsupported("Reading the keyboard state"))
    }

    async fn hide_keyboard(&self, _request_id: String) -> ActionResult {
        Err(unsupported("Hiding the keyboard"))
    }

    // ─── System UI ───

    async fn open_notifications(&self, _request_id: String) -> ActionResult {
        Err(unsupported("Opening notifications"))
    }

    async fn open_quick_settings(&self, _request_id: String) -> ActionResult {
        Err(unsupported("Opening quick settings"))
    }

    async fn wake(&self, _request_id: String) -> ActionResult {
        Err(unsupported("Waking the device"))
    }

    async fn unlock(&self, _request_id: String) -> ActionResult {
        Err(unsupported("Unlocking the device"))
    }

    // ─── App lifecycle ───

    async fn app_is_running(&self, package: &str) -> Option<bool> {
        let state = self.app_state(package).await.ok()?;
        Some(state != "stopped")
    }

    async fn relaunch_app(
        &self,
        _serial: &str,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        // Agent terminateApp, then launchApp, then a readiness probe: no
        // simctl involved, so the iOS path serves the Mac unchanged.
        self.svc
            .relaunch_ios_app_via_agent(package_name, wait_for_idle, idle_timeout_ms)
            .await
    }

    async fn wipe_app_data(&self, _serial: &str, package_name: &str) -> Result<(), String> {
        self.clear_data(package_name).await
    }

    async fn deliver_deep_link(
        &self,
        _request_id: String,
        _uri: &str,
        _delivery: DeepLinkDelivery,
        _ack_epoch_gt: Option<u64>,
        _ack_boot_before: Option<String>,
        _ack_nav_gt: Option<u64>,
    ) -> ActionResult {
        Err(unsupported("Opening deep links"))
    }

    async fn launch_app(
        &self,
        request_id: String,
        serial: String,
        req: &proto::LaunchAppRequest,
    ) -> ActionResult {
        if req.clear_data {
            if let Err(message) = self.clear_data(&req.package_name).await {
                return Ok(self
                    .svc
                    .action_error(request_id, "LAUNCH_FAILED", message)
                    .await);
            }
        }
        self.relaunch(
            request_id,
            &serial,
            &req.package_name,
            req.wait_for_idle,
            req.idle_timeout_ms,
        )
        .await
    }

    async fn restart_app(
        &self,
        request_id: String,
        serial: String,
        req: &proto::RestartAppRequest,
    ) -> ActionResult {
        self.relaunch(
            request_id,
            &serial,
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
        match self.clear_data(&req.package_name).await {
            Ok(()) => Ok(TapsmithServiceImpl::success_action_response(request_id)),
            Err(message) => Ok(self
                .svc
                .action_error(request_id, "ACTION_FAILED", message)
                .await),
        }
    }

    async fn supports_cold_deep_link(&self) -> bool {
        false
    }

    // ─── App state and web views ───

    async fn save_app_state(
        &self,
        _request_id: String,
        _serial: String,
        _req: &proto::SaveAppStateRequest,
    ) -> ActionResult {
        Err(unsupported("Saving app state"))
    }

    async fn restore_app_state(
        &self,
        _request_id: String,
        _serial: String,
        _req: &proto::RestoreAppStateRequest,
    ) -> ActionResult {
        Err(unsupported("Restoring app state"))
    }

    async fn list_web_views(
        &self,
        _request_id: String,
        _serial: String,
    ) -> Result<Response<proto::ListWebViewsResponse>, Status> {
        Err(unsupported("Web view testing"))
    }

    async fn forward_web_view_port(
        &self,
        _request_id: String,
        _serial: String,
        _req: proto::ForwardWebViewPortRequest,
    ) -> Result<Response<proto::ForwardWebViewPortResponse>, Status> {
        Err(unsupported("Web view testing"))
    }

    // ─── Device setup and capture ───

    async fn take_screenshot(
        &self,
        request_id: String,
    ) -> Result<Response<proto::ScreenshotResponse>, Status> {
        // Short timeout, as on iOS: screenshots are best-effort for tracing.
        let failure = |error_message: String| proto::ScreenshotResponse {
            request_id: request_id.clone(),
            success: false,
            data: Vec::new(),
            error_message,
        };
        let resp = match self
            .svc
            .send_agent_command_with_timeout(&AgentCommand::Screenshot {}, 5000)
            .await
        {
            Ok(resp) if resp.success => resp,
            Ok(resp) => {
                return Ok(Response::new(failure(
                    resp.error
                        .unwrap_or_else(|| "Screenshot failed".to_string()),
                )))
            }
            Err(status) => return Ok(Response::new(failure(status.message().to_string()))),
        };
        let b64 = resp.data.get("data").and_then(|v| v.as_str()).unwrap_or("");
        use base64::Engine;
        Ok(Response::new(
            match base64::engine::general_purpose::STANDARD.decode(b64) {
                Ok(data) if !data.is_empty() => proto::ScreenshotResponse {
                    request_id,
                    success: true,
                    data,
                    error_message: String::new(),
                },
                Ok(_) => failure("The macOS agent returned an empty screenshot".to_string()),
                Err(e) => failure(format!("Failed to decode screenshot data: {e}")),
            },
        ))
    }

    // Tracing is refused at agent start (check_start_agent); nothing to arm.
    async fn prearm_network_tracing(&self, _req: &proto::SetDeviceRequest) {}

    // ─── Agent ───

    fn check_start_agent(
        &self,
        request_id: &str,
        req: &proto::StartAgentRequest,
    ) -> Result<(), proto::ActionResponse> {
        let refuse = |error_type: &str, error_message: String| proto::ActionResponse {
            request_id: request_id.to_string(),
            success: false,
            error_type: error_type.to_string(),
            error_message,
            screenshot: Vec::new(),
        };
        if req.ios_xctestrun_path.is_empty() {
            return Err(refuse(
                "AGENT_NOT_CONFIGURED",
                "macOS agent not configured: no .xctestrun for the macOS agent was given."
                    .to_string(),
            ));
        }
        if req.ios_app_path.is_empty() {
            return Err(refuse(
                "AGENT_NOT_CONFIGURED",
                "macOS needs the app path: set the path to your .app in your Tapsmith config."
                    .to_string(),
            ));
        }
        if req.network_tracing_enabled {
            return Err(refuse(
                "AGENT_START_FAILED",
                unsupported_message("Network tracing"),
            ));
        }
        Ok(())
    }

    async fn reuse_agent(&self, _serial: &str, _req: &proto::StartAgentRequest) {}

    async fn launch_agent(
        &self,
        request_id: String,
        _serial: String,
        req: &proto::StartAgentRequest,
    ) -> Result<(), proto::ActionResponse> {
        agent_comms::clear_stream_cache(&self.svc.agent_stream).await;
        // Back the app's data up before the agent launches it (the launch
        // writes data), with no instance running: a clear is only ever made
        // on data that will be restored when the run ends.
        macos::agent_launch::stop_app(Path::new(&req.ios_app_path)).await;
        match macos::app_data::prepare_run(&req.target_package).await {
            Ok(restored) => {
                for id in restored {
                    warn!("Restored {id}'s data, left cleared by a run that did not finish");
                }
            }
            Err(e) => {
                return Err(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "AGENT_START_FAILED".to_string(),
                    error_message: format!(
                        "Could not back up {}'s data, so the run did not start (it would be cleared \
                         between tests): {e:#}",
                        req.target_package
                    ),
                    screenshot: Vec::new(),
                });
            }
        }
        let agent_port = self.svc.agent.read().await.port();
        if let Err(e) = macos::agent_launch::start_agent(
            Path::new(&req.ios_xctestrun_path),
            &req.target_package,
            Path::new(&req.ios_app_path),
            agent_port,
        )
        .await
        {
            error!(error = %e, "Failed to start the macOS agent");
            return Err(proto::ActionResponse {
                request_id,
                success: false,
                error_type: "AGENT_START_FAILED".to_string(),
                error_message: format!("{e:#}"),
                screenshot: Vec::new(),
            });
        }
        *self.svc.ios_agent_config.write().await = Some(IosAgentConfig {
            xctestrun_path: req.ios_xctestrun_path.clone(),
            target_package: req.target_package.clone(),
            app_path: Some(req.ios_app_path.clone()),
        });
        Ok(())
    }

    // Localhost with no adb forward, as on iOS.
    async fn connect_agent(&self, agent: &mut AgentConnection, serial: &str) -> anyhow::Result<()> {
        agent.connect_ios(serial).await
    }

    async fn after_agent_connected(&self, _serial: &str, _target_package: &str) {}

    // start_agent already puts the Automation Mode and activation hints in
    // its error, next to the xcodebuild output they were read from.
    async fn agent_start_diagnostics(&self, _serial: &str) -> String {
        String::new()
    }

    // ─── Network capture ───

    async fn trust_capture_ca(
        &self,
        _request_id: String,
        _serial: String,
        _mitm_ca: &Arc<MitmAuthority>,
        _ca_pem_path: &str,
        _warnings: &mut Vec<String>,
        _tunnel_all_tls: &mut Option<String>,
    ) -> Result<(), CaptureStop> {
        Err(unsupported("Network capture").into())
    }

    async fn start_capture_proxy(
        &self,
        _request_id: String,
        _serial: String,
        _mitm_ca: &Arc<MitmAuthority>,
    ) -> Result<NetworkProxy, CaptureStop> {
        Err(unsupported("Network capture").into())
    }

    async fn check_capture_reachable(
        &self,
        _request_id: String,
        _host_port: u16,
    ) -> Result<(), CaptureStop> {
        Err(unsupported("Network capture").into())
    }

    async fn route_capture_traffic(
        &self,
        _request_id: String,
        _serial: String,
        _req: &proto::StartNetworkCaptureRequest,
        _proxy: &NetworkProxy,
        _mitm_ca: &Arc<MitmAuthority>,
        _host_port: u16,
        _http_ports: &[u16],
        _warnings: &mut Vec<String>,
    ) -> Result<CaptureRoute, CaptureStop> {
        Err(unsupported("Network capture").into())
    }

    // Capture never starts on macOS, so there is no route to release.
    async fn release_capture_route(
        &self,
        _serial: &str,
        _reverse_port: Option<u16>,
        _ca_cert_path: Option<String>,
        _used_iptables: bool,
    ) {
    }

    async fn release_capture_route_on_shutdown(
        &self,
        _serial: &str,
        _reverse_port: Option<u16>,
        _ca_cert_path: Option<String>,
        _used_iptables: bool,
    ) {
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_is_unimplemented_and_names_the_operation() {
        let status = unsupported("Clearing app data");
        assert_eq!(status.code(), tonic::Code::Unimplemented);
        assert_eq!(
            status.message(),
            "Clearing app data is not supported on macOS yet"
        );
    }
}
