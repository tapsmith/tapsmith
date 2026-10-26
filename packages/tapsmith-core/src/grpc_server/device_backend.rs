//! Platform-specific device work behind one interface.
//!
//! RPC handlers resolve the active device's backend with
//! [`TapsmithServiceImpl::backend`] and call it, instead of matching on
//! [`Platform`] themselves. Adding a platform means adding a backend here,
//! not a branch in every handler.
//!
//! Backends borrow the service (like `ServiceResetOps`) so they can reuse its
//! agent connection, device lookup and error-screenshot helpers.

use super::android_backend::AndroidBackend;
use super::ios_backend::IosBackend;
use super::*;

pub(super) type ActionResult = Result<Response<proto::ActionResponse>, Status>;

/// Why a network-capture step ended StartNetworkCapture early.
pub(super) enum CaptureStop {
    /// An RPC error.
    Status(Status),
    /// A response to return as is, usually "capture unavailable" with the reason.
    Respond(proto::StartNetworkCaptureResponse),
}

impl From<Status> for CaptureStop {
    fn from(status: Status) -> Self {
        CaptureStop::Status(status)
    }
}

impl CaptureStop {
    pub(super) fn into_response(
        self,
    ) -> Result<Response<proto::StartNetworkCaptureResponse>, Status> {
        match self {
            CaptureStop::Status(status) => Err(status),
            CaptureStop::Respond(resp) => Ok(Response::new(resp)),
        }
    }
}

/// How `route_capture_traffic` sent the device's traffic to the proxy.
pub(super) struct CaptureRoute {
    pub(super) route: proto::NetworkCaptureRoute,
    /// The macOS system-proxy fallback's lease, published with the proxy.
    #[cfg(target_os = "macos")]
    pub(super) pending_lease: Option<ios::system_proxy::PendingLease>,
}

/// Whether a permission call grants or revokes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PermissionChange {
    Grant,
    Revoke,
}

impl PermissionChange {
    /// The verb used in `pm grant|revoke` and in user-facing messages.
    pub(super) fn as_str(self) -> &'static str {
        match self {
            PermissionChange::Grant => "grant",
            PermissionChange::Revoke => "revoke",
        }
    }
}

/// Device operations whose implementation depends on the platform.
///
/// Methods that act return an `ActionResponse` (failures carry an error
/// screenshot); methods that read return the value, and the handler wraps it.
#[async_trait::async_trait]
pub(super) trait DeviceBackend: Send + Sync {
    // ─── App ───
    async fn terminate_app(&self, request_id: String, package: &str) -> ActionResult;
    /// One of `not_installed`, `foreground`, `background` or `stopped`.
    async fn app_state(&self, package: &str) -> Result<String, Status>;
    /// The foreground app's package, or empty when unknown.
    async fn current_package(&self) -> Result<String, Status>;
    /// The foreground activity, or empty where the platform has none.
    async fn current_activity(&self) -> Result<String, Status>;
    async fn change_permission(
        &self,
        request_id: String,
        package: &str,
        permission: &str,
        change: PermissionChange,
    ) -> ActionResult;

    // ─── Device state ───
    async fn set_clipboard(&self, request_id: String, text: String) -> ActionResult;
    async fn get_clipboard(&self) -> Result<String, Status>;
    async fn set_orientation(&self, request_id: String, orientation: &str) -> ActionResult;
    /// `portrait` or `landscape`.
    async fn get_orientation(&self) -> Result<String, Status>;
    async fn set_color_scheme(&self, request_id: String, scheme: &str) -> ActionResult;
    /// `dark` or `light`.
    async fn get_color_scheme(&self) -> Result<String, Status>;
    async fn is_keyboard_shown(&self) -> Result<bool, Status>;
    async fn hide_keyboard(&self, request_id: String) -> ActionResult;

    // ─── System UI ───
    async fn open_notifications(&self, request_id: String) -> ActionResult;
    async fn open_quick_settings(&self, request_id: String) -> ActionResult;
    async fn wake(&self, request_id: String) -> ActionResult;
    async fn unlock(&self, request_id: String) -> ActionResult;

    // ─── App lifecycle ───
    async fn app_is_running(&self, package: &str) -> Option<bool>;
    async fn relaunch_app(
        &self,
        serial: &str,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String>;
    async fn wipe_app_data(&self, serial: &str, package_name: &str) -> Result<(), String>;
    async fn deliver_deep_link(
        &self,
        request_id: String,
        uri: &str,
        delivery: DeepLinkDelivery,
        ack_epoch_gt: Option<u64>,
        ack_boot_before: Option<String>,
        ack_nav_gt: Option<u64>,
    ) -> ActionResult;
    async fn launch_app(
        &self,
        request_id: String,
        serial: String,
        req: &proto::LaunchAppRequest,
    ) -> ActionResult;
    async fn restart_app(
        &self,
        request_id: String,
        serial: String,
        req: &proto::RestartAppRequest,
    ) -> ActionResult;
    async fn clear_app_data(
        &self,
        request_id: String,
        req: &proto::ClearAppDataRequest,
    ) -> ActionResult;
    /// Whether a deep link can be delivered by cold-launching the app with it.
    async fn supports_cold_deep_link(&self) -> bool;

    // ─── App state and web views ───
    async fn save_app_state(
        &self,
        request_id: String,
        serial: String,
        req: &proto::SaveAppStateRequest,
    ) -> ActionResult;
    async fn restore_app_state(
        &self,
        request_id: String,
        serial: String,
        req: &proto::RestoreAppStateRequest,
    ) -> ActionResult;
    async fn list_web_views(
        &self,
        request_id: String,
        serial: String,
    ) -> Result<Response<proto::ListWebViewsResponse>, Status>;
    async fn forward_web_view_port(
        &self,
        request_id: String,
        serial: String,
        req: proto::ForwardWebViewPortRequest,
    ) -> Result<Response<proto::ForwardWebViewPortResponse>, Status>;

    // ─── Device setup and capture ───
    async fn take_screenshot(
        &self,
        request_id: String,
    ) -> Result<Response<proto::ScreenshotResponse>, Status>;
    /// Called once a device is selected, before the first app launch.
    async fn prearm_network_tracing(&self, req: &proto::SetDeviceRequest);

    // ─── Agent ───
    /// Rejects a StartAgent request this platform cannot act on.
    fn check_start_agent(
        &self,
        request_id: &str,
        req: &proto::StartAgentRequest,
    ) -> Result<(), proto::ActionResponse>;
    /// Called when StartAgent reuses the live agent instead of launching one.
    async fn reuse_agent(&self, serial: &str, req: &proto::StartAgentRequest);
    /// Installs and launches the on-device agent. A failure is the response to return.
    async fn launch_agent(
        &self,
        request_id: String,
        serial: String,
        req: &proto::StartAgentRequest,
    ) -> Result<(), proto::ActionResponse>;
    async fn connect_agent(&self, agent: &mut AgentConnection, serial: &str) -> anyhow::Result<()>;
    /// Best-effort session warm-up once the agent answers.
    async fn after_agent_connected(&self, serial: &str, target_package: &str);
    /// Extra detail for an agent that failed to connect, appended to the error.
    async fn agent_start_diagnostics(&self, serial: &str) -> String;

    // ─── Network capture ───
    // Network capture runs these in order. A `CaptureStop` ends StartNetworkCapture early.
    /// Makes the device trust the MITM CA, or checks that it already does.
    async fn trust_capture_ca(
        &self,
        request_id: String,
        serial: String,
        mitm_ca: &Arc<MitmAuthority>,
        ca_pem_path: &str,
        warnings: &mut Vec<String>,
        tunnel_all_tls: &mut Option<String>,
    ) -> Result<(), CaptureStop>;
    /// Starts the MITM proxy where this device can reach it.
    async fn start_capture_proxy(
        &self,
        request_id: String,
        serial: String,
        mitm_ca: &Arc<MitmAuthority>,
    ) -> Result<NetworkProxy, CaptureStop>;
    /// Fails when the device could not reach the proxy that just started.
    async fn check_capture_reachable(
        &self,
        request_id: String,
        host_port: u16,
    ) -> Result<(), CaptureStop>;
    /// Points the device's traffic at the proxy.
    #[allow(clippy::too_many_arguments)]
    async fn route_capture_traffic(
        &self,
        request_id: String,
        serial: String,
        req: &proto::StartNetworkCaptureRequest,
        proxy: &NetworkProxy,
        mitm_ca: &Arc<MitmAuthority>,
        host_port: u16,
        http_ports: &[u16],
        warnings: &mut Vec<String>,
    ) -> Result<CaptureRoute, CaptureStop>;
    /// Undoes `route_capture_traffic` on the device when capture stops.
    async fn release_capture_route(
        &self,
        serial: &str,
        reverse_port: Option<u16>,
        ca_cert_path: Option<String>,
        used_iptables: bool,
    );
    /// Same as `release_capture_route`, at daemon shutdown.
    async fn release_capture_route_on_shutdown(
        &self,
        serial: &str,
        reverse_port: Option<u16>,
        ca_cert_path: Option<String>,
        used_iptables: bool,
    );
}

/// The backend for `platform`, borrowing `svc` for the call.
pub(super) fn for_platform(
    svc: &TapsmithServiceImpl,
    platform: Platform,
) -> Box<dyn DeviceBackend + '_> {
    match platform {
        Platform::Android => Box::new(AndroidBackend { svc }),
        Platform::Ios => Box::new(IosBackend { svc }),
    }
}
