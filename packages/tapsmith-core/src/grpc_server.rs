use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tokio_stream::Stream;
use tonic::{Request, Response, Status, Streaming};
use tracing::{debug, error, info, instrument, warn};
use uuid::Uuid;

use crate::adb;
use crate::agent_comms;
use crate::agent_comms::{AgentCommand, AgentConnection, AgentResponse, ConnectionParams};
use crate::android_keystore;
use crate::android_permissions;
use crate::app_reset;
use crate::device::DeviceManager;
use crate::device_logs;
use crate::ios;
use crate::mitm_ca::MitmAuthority;
use crate::network_proxy::{EmbeddedRootDefaults, NetworkProxy};
use crate::platform::Platform;
use crate::proto;
use crate::route_handler::RouteInterceptHandler;
use crate::screenshot;

const ANDROID_PROXY_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const ANDROID_REVERSE_PORT_FALLBACK_BASE: u16 = 41_000;
const ANDROID_REVERSE_PORT_FALLBACK_SPAN: u16 = 20_000;
const ANDROID_REVERSE_PORT_FALLBACK_COUNT: usize = 8;
const ANDROID_REVERSE_PORT_FALLBACK_STEP: u32 = 997;
const WEBVIEW_ADB_TIMEOUT: Duration = Duration::from_secs(5);
// The keyboard-state dumpsys check is polled interactively; fail fast rather
// than hang on the 30s adb default if the device/daemon goes unresponsive.
const KEYBOARD_STATE_TIMEOUT: Duration = Duration::from_secs(5);
const WEBVIEW_ADB_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const IOS_OPEN_URL_PROMPT_TIMEOUT: Duration = Duration::from_secs(28);
const IOS_OPEN_DIALOG_ACCEPT_TIMEOUT_MS: u64 = 300;
// Must exceed the agent-side cold path's worst case — `waitForDeepLinkDestination`
// (10s) followed by the hooks epoch/nav acknowledgement wait (8s) — plus gRPC
// round-trip, so each verify returns a verdict rather than tripping this
// command timeout while the agent is still (legitimately) waiting.
const IOS_OPEN_DEEP_LINK_VERIFY_TIMEOUT_MS: u64 = 21_000;
// Budget for the warm in-process delivery attempt on simulators: must exceed
// the agent's own wait — the hierarchy-change window (5s), or the hooks
// epoch/nav acknowledgement wait (8s) — plus the pre-open hierarchy snapshot,
// activate + open, and gRPC round-trip; otherwise a slow-but-successful ack
// times out daemon-side and is recorded as a warm failure. Still tight — when
// warm delivery doesn't land, this whole budget is pure overhead added in
// front of the cold terminate -> openurl path.
const IOS_OPEN_DEEP_LINK_WARM_TIMEOUT_MS: u64 = 11_000;
// How many times to (re-)deliver a real iOS simulator deep link (the whole
// terminate -> openurl -> verify cycle) before giving up. Covers BOTH failure
// modes — a transient `simctl openurl` error (e.g. NSPOSIXErrorDomain code=60)
// and openurl succeeding but the app not reaching its destination. The first
// cold, trust-gated openurl on a fresh sim intermittently fails either way; a
// warm, already-trusted re-delivery reliably lands. Real navigations (e.g. the
// auth deep link) have no fallback but the whole-test retry, so they re-deliver
// persistently.
const IOS_OPEN_DEEP_LINK_MAX_ATTEMPTS: u32 = 3;

/// How far a simulator deep-link delivery may escalate. Physical iOS and
/// Android deliver in-process only, so they treat every variant alike.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeepLinkDelivery {
    /// Warm in-process first; terminate → relaunch when it does not land.
    WarmThenCold,
    /// Skip the warm attempt (between-file resets, retries: `force_cold_launch`).
    Cold,
    /// Warm in-process only: a miss is reported to the caller, never
    /// escalated. For a reset onto a route that may hide the hooks marker —
    /// the caller has a cheaper recovery (re-confirm on the root route) than
    /// three relaunch cycles that cannot read the epoch there either.
    WarmOnly,
}
// Android deep-link delivery: how long to wait for the target app to be the
// resumed activity (or, for declared resets, for the in-app hook to
// acknowledge) before moving on. Same-screen links used to burn a full 10s
// waiting for a hierarchy diff that never came; navigation is now judged by
// the foreground component, like Playwright's `goto` judges commit, not paint.
const ANDROID_DEEP_LINK_SETTLE_TIMEOUT: Duration = Duration::from_secs(3);
// Declared resets wait for the in-app hook's epoch acknowledgement instead.
// Each poll is a full UIAutomator dump, which alone costs 1-3s on a cold
// software-GPU emulator, and the reset pipeline (storage clear + navigation)
// runs before the epoch bumps — 3s guaranteed a miss under load and sent
// every warm reset down the clear rung. Aligned with the iOS agent's 8s.
const ANDROID_HOOK_ACK_TIMEOUT: Duration = Duration::from_secs(8);
// Re-fire the intent once if the target still isn't resumed after this long
// — a busy Activity on a slow emulator can silently drop the first one.
const ANDROID_DEEP_LINK_REFIRE_AFTER: Duration = Duration::from_millis(1500);
const ANDROID_DEEP_LINK_POLL: Duration = Duration::from_millis(250);
const ANDROID_DEEP_LINK_IDLE_TIMEOUT_MS: u64 = 2_000;
/// After a restart/cold relaunch, how long to wait for the app to draw real
/// content before handing it back. A React Native app's window exists (and
/// `WaitForIdle` returns) seconds before the JS bundle renders or registers
/// its deep-link listener; a deep link fired into that gap is silently
/// dropped. Bounded and best-effort — a genuinely text-free first screen just
/// falls through.
const ANDROID_RENDER_READY_TIMEOUT: Duration = Duration::from_secs(10);
const ANDROID_RENDER_READY_POLL: Duration = Duration::from_millis(250);

/// How long StartAgent waits for a freshly launched Android agent to answer
/// its first ping. UIAutomator's accessibility bootstrap on a cold
/// software-GPU CI emulator can take tens of seconds; the wait returns on
/// the first pong, so a healthy agent pays nothing for the headroom.
const ANDROID_AGENT_START_READINESS: Duration = Duration::from_secs(60);

/// Where StartAgent redirects the `am instrument` output on the device, so
/// an agent that crashes before binding its socket leaves a readable trace
/// (`INSTRUMENTATION_RESULT: shortMsg=Process crashed.` and the like).
const ANDROID_AGENT_LOG_PATH: &str = "/data/local/tmp/tapsmith-agent.log";

/// Explain why a just-launched Android agent never answered: whether its
/// process is even alive, and what `am instrument` printed.
async fn android_agent_start_diagnostics(serial: &str) -> String {
    let pid = adb::shell_lenient(serial, "pidof dev.tapsmith.agent 2>/dev/null || true")
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let tail = adb::shell_lenient(
        serial,
        &format!("tail -n 20 {ANDROID_AGENT_LOG_PATH} 2>/dev/null || true"),
    )
    .await
    .map(|s| s.trim().to_string())
    .unwrap_or_default();
    let mut out = String::new();
    if pid.is_empty() {
        out.push_str("\nAgent process dev.tapsmith.agent is not running.");
    } else {
        out.push_str(&format!(
            "\nAgent process dev.tapsmith.agent is running (pid {pid}) but did not answer."
        ));
    }
    if !tail.is_empty() {
        out.push_str(&format!(
            "\n`am instrument` output ({ANDROID_AGENT_LOG_PATH}):\n{tail}"
        ));
    }
    out
}

pub struct TapsmithServiceImpl {
    device_manager: Arc<RwLock<DeviceManager>>,
    agent: Arc<RwLock<AgentConnection>>,
    agent_stream: agent_comms::AgentStreamCache,
    network_proxy: Arc<RwLock<Option<NetworkProxy>>>,
    /// Serial/UDID of the device whose proxy settings were modified (for cleanup).
    proxy_device_serial: Arc<RwLock<Option<String>>>,
    /// Platform the proxy was started on (for platform-specific cleanup).
    proxy_platform: Arc<RwLock<Option<Platform>>>,
    /// Device-side port used for `adb reverse` (for cleanup, Android only).
    proxy_reverse_port: Arc<RwLock<Option<u16>>>,
    proxy_http_ports: Arc<RwLock<Vec<u16>>>,
    /// On-device path of the installed CA cert (for cleanup, Android only).
    proxy_ca_cert_path: Arc<RwLock<Option<String>>>,
    /// Whether iptables transparent redirect is active (Android only). Used
    /// to run targeted cleanup — only remove iptables rules when they were
    /// actually installed, and only reset the system HTTP proxy when it was set.
    proxy_uses_iptables: Arc<RwLock<bool>>,
    /// iOS Network Extension redirector session (for cleanup, iOS simulators only).
    #[cfg(target_os = "macos")]
    ios_redirect: Arc<RwLock<Option<crate::ios_redirect::IosRedirect>>>,
    /// macOS network service name whose system proxy was set as a fallback
    /// when the Network Extension is unavailable (e.g. on CI). `None` when
    /// using the NE redirector or when network capture is off.
    #[cfg(target_os = "macos")]
    ios_system_proxy_service: Arc<RwLock<Option<String>>>,
    /// Sticky flag: once the Network Extension fails, skip the 10s
    /// `IosRedirect::start` timeout on subsequent `start_network_capture`
    /// calls and go straight to the system proxy fallback. Without this,
    /// every per-test start/stop cycle pays the NE timeout (~10s × N tests).
    #[cfg(target_os = "macos")]
    ios_ne_unavailable: Arc<RwLock<bool>>,
    /// Session cache of `simctl get_app_container` results keyed by
    /// `udid\0bundle_id`. The data-container path of an installed app is
    /// stable (it changes only on reinstall) and is plain host filesystem —
    /// so when CoreSimulatorService wedges and the live lookup times out, a
    /// previously resolved path still works for tar/clear operations.
    ios_app_container_cache: Arc<RwLock<std::collections::HashMap<String, String>>>,
    /// Simulator UDID whose trust store already has this session's MITM CA.
    /// `simctl keychain add-root-cert` talks to the sim's securityd/trustd —
    /// re-running it every capture start is wasted work and was observed
    /// hanging for minutes when CoreSimulator is under pressure. The CA is
    /// stable for the daemon session (load_or_create), so once installed on
    /// a UDID it stays trusted.
    ios_ca_cert_installed: Arc<RwLock<std::collections::HashSet<String>>>,
    /// iOS agent launch config (stored for restart on launchApp).
    ios_agent_config: Arc<RwLock<Option<IosAgentConfig>>>,
    /// Startup inputs for the currently connected agent. Used to make
    /// StartAgent idempotent when the daemon is already connected to the same
    /// live agent for the same device/configuration.
    started_agent_config: Arc<RwLock<Option<StartedAgentConfig>>>,
    /// Cached Android launcher activity (`.MainActivity`) for the active
    /// package, resolved once at StartAgent when the device is calm. Reused by
    /// every clean-task relaunch so a restart never depends on a per-reset
    /// `resolve-activity` call succeeding under load. Cleared on device/agent
    /// change.
    android_launcher_activity: Arc<RwLock<Option<String>>>,
    /// Counters behind the warm/cold decision for declared app resets
    /// (`ResetApp`). Reset whenever the active device or agent session changes.
    reset_policy: Arc<RwLock<app_reset::ResetPolicyState>>,
    /// The last in-app hooks marker seen in this session. A single hierarchy
    /// read can miss the marker (mid-transition screen, keyboard, a slow
    /// dump); knowing hooks exist lets `ResetApp` re-read before concluding
    /// the app has none and falling back to a 4 s restart.
    last_hooks_marker: Arc<RwLock<Option<app_reset::HooksMarker>>>,
    /// Whether a plain-navigation deep link's nav-counter probe has already
    /// concluded the app renders no hooks marker. Skips the per-link hierarchy
    /// pre-fetch for hook-less apps (an extra agent round-trip per
    /// `openDeepLink`, seconds on a cold CI emulator). Cleared wherever
    /// `last_hooks_marker` is, and whenever the app process is (re)launched —
    /// a mid-session reinstall can newly expose hooks.
    nav_probe_found_no_marker: Arc<RwLock<bool>>,
    /// iproxy USB tunnel for the physical iOS device, if any. Held for the
    /// lifetime of the XCUITest runner session; dropped when a new agent is
    /// started or the session is torn down.
    ios_iproxy: Arc<RwLock<Option<crate::ios::iproxy::IproxyHandle>>>,
    /// Whether the current session has network tracing enabled. Set from
    /// `SetDeviceRequest.network_tracing_enabled` and re-affirmed by
    /// `StartAgentRequest.network_tracing_enabled`. Gates the
    /// `ensure_ios_physical_proxy` pre-arming on physical iOS devices —
    /// when false, the daemon skips every MITM/OCSP-passthrough code path,
    /// which eliminates the entire failure surface for users who just want
    /// to run tests on a real phone without HTTP capture. The CLI is the
    /// single source of truth for this value; the daemon never reads
    /// tapsmith.config.ts itself.
    network_tracing_enabled: Arc<RwLock<bool>>,
    /// Host globs whose TLS connections the MITM proxy tunnels end-to-end
    /// instead of intercepting (PILOT-231). Set from
    /// `SetDeviceRequest.passthrough_hosts` (the CLI sources it from
    /// `trace.networkPassthroughHosts`). Stored here because the proxy may
    /// not exist yet at set_device time — every proxy start site pushes the
    /// current value into the new proxy.
    passthrough_hosts: Arc<RwLock<Vec<String>>>,
    /// Active route interception handler, if a `NetworkRoute` stream is open.
    /// Stored here so that `start_network_capture` can install it on newly
    /// created proxies (the stream may open before or after capture starts).
    active_route_handler: Arc<RwLock<Option<Arc<RouteInterceptHandler>>>>,
    /// Tracked WebView port forwards (host_port → socket_name) for cleanup.
    webview_forwards: Arc<RwLock<std::collections::HashMap<u16, String>>>,
    /// iOS WebKit debug proxy handle (managed child process).
    #[cfg(target_os = "macos")]
    webkit_debug_proxy: Arc<RwLock<Option<crate::ios::webkit_debug_proxy::WebkitDebugProxyHandle>>>,
    /// Active video recording, if any. Mirrors `ios_iproxy` — owned for the
    /// lifetime of one test, released by `StopVideoRecording`. Dropping the
    /// handle (e.g. on session teardown) hard-kills the underlying recorder.
    video_recording: Arc<RwLock<Option<crate::video::RecordingHandle>>>,
    /// iOS-simulator live HID touch injector (macOS only). Lazily spawns one
    /// `tapsmith-ios-hid` helper per simulator; touch handlers route iOS-sim
    /// streamed touch here, falling back to the agent if it's unavailable.
    #[cfg(target_os = "macos")]
    hid_injector: Arc<crate::hid_injector::HidInjector>,
    /// In-process broadcast of daemon `tracing` events, fanned out by the
    /// `StreamDaemonLogs` RPC so the SDK can fold daemon logs into traces.
    daemon_log_bus: crate::daemon_log_bus::DaemonLogBus,
}

/// Stored iOS agent launch config for restart.
#[derive(Clone)]
struct IosAgentConfig {
    xctestrun_path: String,
    target_package: String,
    /// Host path to the `.app` bundle. Used by `clearAppData` and
    /// `restoreAppState` to uninstall + reinstall the app for a clean
    /// data container.
    app_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StartedAgentConfig {
    serial: String,
    platform: Platform,
    target_package: String,
    agent_apk: Option<StartupArtifactIdentity>,
    agent_test_apk: Option<StartupArtifactIdentity>,
    ios_xctestrun: Option<StartupArtifactIdentity>,
    ios_app: Option<StartupArtifactIdentity>,
    network_tracing_enabled: bool,
}

impl StartedAgentConfig {
    fn from_start_agent_request(
        serial: &str,
        platform: Platform,
        req: &proto::StartAgentRequest,
    ) -> Self {
        Self {
            serial: serial.to_string(),
            platform,
            target_package: req.target_package.clone(),
            agent_apk: StartupArtifactIdentity::from_path(&req.agent_apk_path),
            agent_test_apk: StartupArtifactIdentity::from_path(&req.agent_test_apk_path),
            ios_xctestrun: StartupArtifactIdentity::from_path(&req.ios_xctestrun_path),
            ios_app: StartupArtifactIdentity::from_path(&req.ios_app_path),
            network_tracing_enabled: req.network_tracing_enabled,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StartupArtifactIdentity {
    path: String,
    len: Option<u64>,
    modified_unix_nanos: Option<u128>,
}

impl StartupArtifactIdentity {
    fn from_path(path: &str) -> Option<Self> {
        if path.is_empty() {
            return None;
        }

        let metadata = std::fs::metadata(path).ok();
        let modified_unix_nanos = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos());

        Some(Self {
            path: path.to_string(),
            len: metadata.as_ref().map(|m| m.len()),
            modified_unix_nanos,
        })
    }
}

/// Emit one timing line per on-device agent command (no-op unless
/// `TAPSMITH_TIMING_LOG` is set). Measures the full daemon→agent→response
/// round-trip, which is where iOS per-action latency (XCUITest ops + the
/// agent's fixed settle sleeps) accumulates.
fn log_agent_command_timing(
    command: &AgentCommand,
    started: std::time::Instant,
    result: &Result<AgentResponse>,
) {
    if !crate::timing::enabled() {
        return;
    }
    crate::timing::timing_log!(
        "kind=cmd name={} dur_ms={} ok={}",
        command.method_name(),
        started.elapsed().as_millis(),
        result.is_ok()
    );
}

impl TapsmithServiceImpl {
    pub fn new(
        device_manager: Arc<RwLock<DeviceManager>>,
        agent: Arc<RwLock<AgentConnection>>,
        daemon_log_bus: crate::daemon_log_bus::DaemonLogBus,
    ) -> Self {
        Self {
            device_manager,
            agent,
            daemon_log_bus,
            agent_stream: agent_comms::new_agent_stream_cache(),
            network_proxy: Arc::new(RwLock::new(None)),
            proxy_device_serial: Arc::new(RwLock::new(None)),
            proxy_platform: Arc::new(RwLock::new(None)),
            proxy_reverse_port: Arc::new(RwLock::new(None)),
            proxy_http_ports: Arc::new(RwLock::new(Vec::new())),
            proxy_ca_cert_path: Arc::new(RwLock::new(None)),
            proxy_uses_iptables: Arc::new(RwLock::new(false)),
            #[cfg(target_os = "macos")]
            ios_redirect: Arc::new(RwLock::new(None)),
            #[cfg(target_os = "macos")]
            ios_system_proxy_service: Arc::new(RwLock::new(None)),
            #[cfg(target_os = "macos")]
            ios_ne_unavailable: Arc::new(RwLock::new(false)),
            ios_app_container_cache: Arc::new(RwLock::new(std::collections::HashMap::new())),
            ios_ca_cert_installed: Arc::new(RwLock::new(std::collections::HashSet::new())),
            ios_agent_config: Arc::new(RwLock::new(None)),
            started_agent_config: Arc::new(RwLock::new(None)),
            android_launcher_activity: Arc::new(RwLock::new(None)),
            reset_policy: Arc::new(RwLock::new(app_reset::ResetPolicyState::default())),
            last_hooks_marker: Arc::new(RwLock::new(None)),
            nav_probe_found_no_marker: Arc::new(RwLock::new(false)),
            ios_iproxy: Arc::new(RwLock::new(None)),
            network_tracing_enabled: Arc::new(RwLock::new(false)),
            passthrough_hosts: Arc::new(RwLock::new(Vec::new())),
            active_route_handler: Arc::new(RwLock::new(None)),
            webview_forwards: Arc::new(RwLock::new(std::collections::HashMap::new())),
            #[cfg(target_os = "macos")]
            webkit_debug_proxy: Arc::new(RwLock::new(None)),
            video_recording: Arc::new(RwLock::new(None)),
            #[cfg(target_os = "macos")]
            hid_injector: Arc::new(crate::hid_injector::HidInjector::new()),
        }
    }

    /// Returns `true` when the currently-selected device is a physical iOS
    /// device (i.e. iOS platform + `is_emulator == false`). Falls back to
    /// `false` when no device is selected or when the device manager cannot
    /// be queried — the existing simulator-oriented code paths remain the
    /// safe default.
    async fn is_active_ios_physical(&self) -> bool {
        let dm = self.device_manager.read().await;
        matches!(
            dm.active_device(),
            Some(d) if d.platform == Platform::Ios && !d.is_emulator
        )
    }

    /// Whether the built-in embedded-root passthrough defaults
    /// (`firestore.googleapis.com`) apply to the active device (PILOT-279).
    ///
    /// Android's Firestore runs on gRPC-Java, which validates TLS against the
    /// platform trust store, so once `adb::install_ca_cert` has put our CA
    /// there the host is MITM-able through the normal h2 pipeline — applying
    /// the default would hide capturable traffic. iOS keeps the default: its
    /// gRPC-C++ stack compiles its roots into the app binary and can never
    /// trust our CA.
    ///
    /// Defaults to `Apply` when no device is selected: that's the
    /// conservative direction (tunnel rather than break the app), and every
    /// path that starts a proxy re-derives this once a device is known.
    async fn embedded_root_defaults(&self) -> EmbeddedRootDefaults {
        let dm = self.device_manager.read().await;
        Self::embedded_root_defaults_for(dm.active_device().map(|d| d.platform))
    }

    /// Pure half of [`Self::embedded_root_defaults`], split out so the
    /// platform mapping is unit-testable and callers that already hold a
    /// platform (or a `device_manager` guard) can reuse it without a second
    /// lock acquisition.
    fn embedded_root_defaults_for(platform: Option<Platform>) -> EmbeddedRootDefaults {
        match platform {
            Some(Platform::Android) => EmbeddedRootDefaults::Skip,
            Some(Platform::Ios) | None => EmbeddedRootDefaults::Apply,
        }
    }

    /// Idempotently start the Wi-Fi MITM proxy bound to a physical iOS
    /// device's deterministic port. Needed whenever we're about to
    /// perform any operation on a physical device that might cause iOS
    /// to issue an OCSP trust-verification request to Apple — install,
    /// launch, agent start, agent restart, etc. Without a live listener
    /// at that port, the phone's Wi-Fi proxy settings route the OCSP
    /// request to a dead address and iOS rejects the app with the
    /// "Developer App Certificate is not trusted" umbrella error.
    ///
    /// Skipped if a proxy is already running. `start_network_capture`
    /// reuses the same listener, and `stop_network_capture` tears it
    /// down — we re-prime it from every physical-iOS entry point.
    #[cfg(target_os = "macos")]
    async fn ensure_ios_physical_proxy(&self, serial: &str) {
        if self.network_proxy.read().await.is_some() {
            return;
        }
        let ca = match MitmAuthority::load_or_create() {
            Ok(ca) => Arc::new(ca),
            Err(e) => {
                warn!(error = %e, "Failed to load MITM CA for Wi-Fi proxy pre-start");
                return;
            }
        };
        let port = ios::physical_device_proxy::deterministic_port(serial);
        let bind =
            std::net::SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED), port);
        match NetworkProxy::start_on(ca, bind).await {
            Ok(proxy) => {
                info!(%serial, %bind, "Pre-started Wi-Fi MITM proxy for physical iOS OCSP passthrough");
                // Clone out of the read guard before awaiting — holding a
                // RwLock guard across an await risks starving writers.
                let passthrough_hosts = self.passthrough_hosts.read().await.clone();
                // Physical iOS by construction, so the embedded-root defaults
                // always apply here.
                proxy
                    .set_passthrough_hosts(passthrough_hosts, EmbeddedRootDefaults::Apply)
                    .await;
                *self.network_proxy.write().await = Some(proxy);
            }
            Err(e) => {
                warn!(error = %e, %bind, "Failed to pre-start Wi-Fi MITM proxy; OCSP passthrough unavailable");
            }
        }
    }

    /// Install the MITM CA into the active Android device's trust store as part
    /// of device setup — *before* the app under test is first launched.
    ///
    /// On Android 14+ the CA is injected into the zygote mount namespace, so it
    /// is only trusted by app processes *forked after* the injection (a running
    /// app caches its trust store at client creation and won't pick it up).
    /// `start_network_capture` installs the CA lazily per-test, which runs after
    /// the worker has already launched the app — so on a freshly-booted device
    /// the first HTTPS host is sacrificed until the app happens to re-fork.
    /// Installing here, before the first launch, means the app forks from an
    /// already-patched zygote and trusts the cert on its very first request.
    ///
    /// Idempotent (skips if already installed this session) and best-effort:
    /// failures are non-fatal because the per-test install still runs as a
    /// fallback and the cert-reject → passthrough path keeps traffic flowing.
    async fn ensure_android_ca_installed(&self, serial: &str) {
        if self.proxy_ca_cert_path.read().await.is_some() {
            return;
        }
        let mitm_ca = match MitmAuthority::load_or_create() {
            Ok(ca) => ca,
            Err(e) => {
                warn!(%serial, "Skipping CA pre-install: failed to load MITM CA: {e}");
                return;
            }
        };
        let cert_filename = match mitm_ca.device_cert_filename() {
            Ok(f) => f,
            Err(e) => {
                warn!(%serial, "Skipping CA pre-install: {e}");
                return;
            }
        };
        let ca_pem_path = mitm_ca.ca_pem_path().to_string_lossy().to_string();
        match adb::install_ca_cert(serial, &ca_pem_path, &cert_filename).await {
            Ok(path) => {
                info!(%serial, "MITM CA pre-installed during device setup (before first app launch)");
                *self.proxy_ca_cert_path.write().await = Some(path);
            }
            Err(e) => {
                debug!(%serial, "CA pre-install during setup failed: {e} — will retry at capture start");
            }
        }
    }

    fn request_id(provided: &str) -> String {
        if provided.is_empty() {
            Uuid::new_v4().to_string()
        } else {
            provided.to_string()
        }
    }

    async fn active_serial(&self) -> Result<String, Status> {
        // Fast path: read lock — if an active serial is already set, return it
        // without taking the expensive write lock.
        if let Some(serial) = self.device_manager.read().await.active_serial() {
            return Ok(serial.to_string());
        }
        // Slow path: write lock for auto-discovery/selection
        self.device_manager
            .write()
            .await
            .resolve_serial()
            .await
            .map_err(|e| Status::failed_precondition(e.to_string()))
    }

    /// Whether the Android soft keyboard is currently shown, per the IME's
    /// `mInputShown` flag. Propagates the dumpsys failure rather than defaulting
    /// to a value, so callers can distinguish "not shown" from "check failed".
    async fn android_is_keyboard_shown(&self, serial: &str) -> Result<bool, Status> {
        // Strict `shell_with_timeout` (not lenient) so a transport failure (offline
        // device) or a dumpsys failure surfaces as an error rather than empty output
        // that reads as "keyboard hidden". We fetch the full dumpsys output and match
        // the flag in Rust — no on-device `grep`, whose no-match exit code would
        // otherwise mask a genuine dumpsys failure.
        let output =
            adb::shell_with_timeout(serial, "dumpsys input_method", KEYBOARD_STATE_TIMEOUT)
                .await
                .map_err(|e| Status::internal(e.to_string()))?;
        Ok(output.contains("mInputShown=true"))
    }

    /// Extract connection params under a brief read lock so TCP I/O
    /// happens without holding the lock.
    #[allow(clippy::result_large_err)] // Status is tonic's standard error type
    fn agent_params(agent: &AgentConnection) -> Result<ConnectionParams, Status> {
        agent
            .connection_params()
            .map_err(|e| Status::failed_precondition(e.to_string()))
    }

    async fn can_reuse_started_agent(&self, desired: &StartedAgentConfig) -> bool {
        let has_matching_startup_config = {
            let current = self.started_agent_config.read().await;
            current.as_ref() == Some(desired)
        };
        if !has_matching_startup_config {
            return false;
        }

        let is_ios = desired.platform == Platform::Ios;
        let host_port = {
            let agent = self.agent.read().await;
            agent.connected_host_port_for(&desired.serial, is_ios)
        };
        let Some(host_port) = host_port else {
            debug!(
                serial = %desired.serial,
                platform = %desired.platform,
                "StartAgent reuse skipped: cached startup config matched but agent connection did not"
            );
            return false;
        };

        if let Err(e) = agent_comms::ping_agent_port(host_port).await {
            debug!(
                serial = %desired.serial,
                platform = %desired.platform,
                host_port,
                error = %e,
                "StartAgent reuse skipped: cached agent did not respond to ping"
            );
            return false;
        }

        true
    }

    async fn send_agent_command(&self, command: &AgentCommand) -> Result<AgentResponse, Status> {
        let params = Self::agent_params(&*self.agent.read().await)?;
        let timeout = Duration::from_secs(30);
        let started = std::time::Instant::now();
        let raw =
            agent_comms::send_with_persistent_cache(&self.agent_stream, &params, command, timeout)
                .await;
        log_agent_command_timing(command, started, &raw);
        self.recover_agent_on_timeout(command, raw).await
    }

    /// Raw agent command send — no auto-recovery wrapper. Used by the
    /// recovery path itself (`probe_ios_agent_session` after a restart) to
    /// avoid recursion if the recovery attempt's probe command also times
    /// out.
    async fn send_agent_command_raw(
        &self,
        command: &AgentCommand,
        timeout_ms: u64,
    ) -> Result<AgentResponse, Status> {
        let timeout = if timeout_ms > 0 {
            Duration::from_millis(timeout_ms)
        } else {
            Duration::from_secs(30)
        };
        let params = Self::agent_params(&*self.agent.read().await)?;
        agent_comms::send_with_persistent_cache(&self.agent_stream, &params, command, timeout)
            .await
            .map_err(|e| Status::internal(e.to_string()))
    }

    async fn send_agent_command_with_timeout(
        &self,
        command: &AgentCommand,
        timeout_ms: u64,
    ) -> Result<AgentResponse, Status> {
        let timeout = if timeout_ms > 0 {
            Duration::from_millis(timeout_ms)
        } else {
            Duration::from_secs(30)
        };
        let params = Self::agent_params(&*self.agent.read().await)?;
        let started = std::time::Instant::now();
        let raw =
            agent_comms::send_with_persistent_cache(&self.agent_stream, &params, command, timeout)
                .await;
        log_agent_command_timing(command, started, &raw);
        self.recover_agent_on_timeout(command, raw).await
    }

    async fn accept_ios_open_in_app_dialog(&self) {
        let result = self
            .send_agent_command_with_timeout(
                &AgentCommand::AcceptOpenInAppDialog {
                    timeout_ms: Some(IOS_OPEN_DIALOG_ACCEPT_TIMEOUT_MS),
                },
                IOS_OPEN_DIALOG_ACCEPT_TIMEOUT_MS + 1_000,
            )
            .await;

        match result {
            Ok(resp) if resp.success => {
                if resp
                    .data
                    .get("dismissed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    info!("Accepted iOS Open-in-app confirmation dialog");
                }
            }
            Ok(resp) => {
                debug!(
                    error = ?resp.error,
                    "iOS Open-in-app dialog accept command returned failure"
                );
            }
            Err(e) => {
                debug!(error = %e, "Failed to probe iOS Open-in-app dialog");
            }
        }
    }

    async fn open_ios_simulator_url_with_prompt_handling(
        &self,
        serial: &str,
        uri: &str,
    ) -> anyhow::Result<()> {
        let serial_for_open = serial.to_string();
        let uri_for_open = uri.to_string();
        let open_url = ios::device::open_url(&serial_for_open, &uri_for_open);
        tokio::pin!(open_url);
        let deadline = tokio::time::Instant::now() + IOS_OPEN_URL_PROMPT_TIMEOUT;

        let prompt_poll_interval = Duration::from_millis(500);
        let initial_prompt_poll_interval = Duration::from_millis(50);
        let mut next_poll_interval = initial_prompt_poll_interval;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                tokio::select! {
                    biased;
                    result = &mut open_url => {
                        return result;
                    }
                    _ = tokio::time::sleep(Duration::from_millis(1)) => {}
                }
                return Err(anyhow::anyhow!(
                    "Operation timed out opening URL on {serial}: {uri}"
                ));
            }

            let sleep_duration = remaining.min(next_poll_interval);
            tokio::select! {
                biased;
                result = &mut open_url => {
                    return result;
                }
                _ = tokio::time::sleep(sleep_duration) => {
                    self.accept_ios_open_in_app_dialog().await;
                    next_poll_interval = prompt_poll_interval;
                }
            }
        }
    }

    /// If the agent command failed with a "timed out" error AND the active
    /// device is a physical iOS device, the XCUITest runner's accessibility
    /// connection has most likely wedged. Restart the agent in-place and
    /// retry the command once. Transparent to callers — a successful retry
    /// returns Ok, a failed retry surfaces the underlying error.
    ///
    /// Physical-iOS only: simulator runs are fast enough that a full agent
    /// restart per stuck command would be a meaningful regression, and
    /// Android has its own proven recovery path in session-preflight.
    async fn recover_agent_on_timeout(
        &self,
        command: &AgentCommand,
        result: anyhow::Result<AgentResponse>,
    ) -> Result<AgentResponse, Status> {
        let err = match result {
            Ok(resp) => return Ok(resp),
            Err(e) => e,
        };
        let msg = err.to_string();
        let looks_like_timeout = msg.contains("timed out") || msg.contains("Timed out");
        if !looks_like_timeout || !self.is_active_ios_physical().await {
            return Err(Status::internal(msg));
        }
        let config = match self.ios_agent_config.read().await.clone() {
            Some(c) => c,
            None => return Err(Status::internal(msg)),
        };
        let serial = match self.active_serial().await {
            Ok(s) => s,
            Err(_) => return Err(Status::internal(msg)),
        };
        warn!(
            error = %msg,
            "iOS agent command timed out on physical device, restarting agent and retrying"
        );
        agent_comms::clear_stream_cache(&self.agent_stream).await;
        if let Err(e) = self
            .restart_ios_agent_for_app(&serial, &config.target_package, false, 5_000)
            .await
        {
            return Err(Status::internal(format!(
                "Agent timed out ({msg}); recovery also failed: {e}"
            )));
        }
        let params = Self::agent_params(&*self.agent.read().await)?;
        agent_comms::send_with_persistent_cache(
            &self.agent_stream,
            &params,
            command,
            Duration::from_secs(30),
        )
        .await
        .map_err(|e| {
            Status::internal(format!(
                "Agent timed out ({msg}); post-recovery retry also failed: {e}"
            ))
        })
    }

    async fn probe_ios_agent_session(
        &self,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        let timeout_ms = if wait_for_idle {
            if idle_timeout_ms > 0 {
                idle_timeout_ms.min(10_000)
            } else {
                10_000
            }
        } else {
            1_000
        };
        let idle = self
            .send_agent_command_raw(
                &AgentCommand::WaitForIdle {
                    timeout_ms: Some(timeout_ms),
                },
                timeout_ms,
            )
            .await
            .map_err(|status| status.message().to_string())?;
        if !idle.success {
            return Err(idle
                .error
                .unwrap_or_else(|| "iOS agent probe failed after relaunch".to_string()));
        }

        // Verify the accessibility tree has content — WaitForIdle on iOS is
        // just a brief sleep, so the app may still be loading its first screen.
        if wait_for_idle {
            let hierarchy_timeout = idle_timeout_ms.min(5_000);
            let hierarchy = self
                .send_agent_command_raw(&AgentCommand::GetUiHierarchy {}, hierarchy_timeout)
                .await
                .map_err(|status| status.message().to_string())?;
            if !hierarchy.success {
                return Err("iOS agent hierarchy fetch failed after relaunch".to_string());
            }
            let xml = hierarchy
                .data
                .get("hierarchy")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !xml.contains("<XCUIElementType") {
                return Err("iOS app hierarchy contains no elements after relaunch".to_string());
            }
        }

        Ok(())
    }

    async fn relaunch_ios_app_via_simctl(
        &self,
        serial: &str,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        agent_comms::clear_stream_cache(&self.agent_stream).await;
        let _ = ios::device::terminate_app(serial, package_name).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        ios::device::launch_app(serial, package_name)
            .await
            .map_err(|e| e.to_string())?;
        let relaunch = self
            .send_agent_command_with_timeout(
                &AgentCommand::LaunchApp {
                    package: package_name.to_string(),
                },
                8_000,
            )
            .await
            .map_err(|status| status.message().to_string())?;
        if !relaunch.success {
            return Err(relaunch
                .error
                .unwrap_or_else(|| "iOS app activate failed after simctl relaunch".to_string()));
        }

        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return self
                    .probe_ios_agent_session(wait_for_idle, idle_timeout_ms)
                    .await;
            }
            // Cap the probe timeout so it can't exceed the outer deadline.
            let capped_idle_timeout = (idle_timeout_ms).min(remaining.as_millis() as u64);
            let err = match self
                .probe_ios_agent_session(wait_for_idle, capped_idle_timeout)
                .await
            {
                Ok(()) => return Ok(()),
                Err(err) => err,
            };
            if tokio::time::Instant::now() >= deadline {
                return Err(err);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    async fn relaunch_ios_app_via_agent(
        &self,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        let _ = self
            .send_agent_command_with_timeout(
                &AgentCommand::TerminateApp {
                    package: package_name.to_string(),
                },
                4_000,
            )
            .await;
        tokio::time::sleep(Duration::from_millis(300)).await;

        let launch = self
            .send_agent_command_with_timeout(
                &AgentCommand::LaunchApp {
                    package: package_name.to_string(),
                },
                8_000,
            )
            .await
            .map_err(|status| status.message().to_string())?;
        if !launch.success {
            return Err(launch
                .error
                .unwrap_or_else(|| "iOS agent launch failed".to_string()));
        }

        // Poll for session readiness instead of a single probe — the app may
        // need a moment to render its UI after launch, especially under CI load.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return self
                    .probe_ios_agent_session(wait_for_idle, idle_timeout_ms)
                    .await;
            }
            let capped_idle_timeout = idle_timeout_ms.min(remaining.as_millis() as u64);
            match self
                .probe_ios_agent_session(wait_for_idle, capped_idle_timeout)
                .await
            {
                Ok(()) => return Ok(()),
                Err(err) => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(err);
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    }

    async fn restart_ios_agent_for_app(
        &self,
        serial: &str,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        let config = self
            .ios_agent_config
            .read()
            .await
            .clone()
            .ok_or_else(|| "iOS agent is not configured".to_string())?;

        let is_physical = self.is_active_ios_physical().await;

        agent_comms::clear_stream_cache(&self.agent_stream).await;
        ios::agent_launch::kill_existing_agents_on(serial).await;

        // Physical iOS: re-prime the Wi-Fi MITM proxy before xcodebuild so
        // iOS's OCSP query for the relaunched runner reaches our passthrough
        // path. A prior test's stop_network_capture may have torn it down.
        // Gated on `network_tracing_enabled`: when the session has tracing
        // off, iOS never routes through our proxy port anyway, so there's
        // nothing to pre-arm and we save the OCSP-race surface entirely.
        #[cfg(target_os = "macos")]
        if is_physical && *self.network_tracing_enabled.read().await {
            self.ensure_ios_physical_proxy(serial).await;
        }

        // On physical devices we skip the simctl-mediated pre-relaunch because
        // simctl does not work on real hardware. The XCUITest runner's own
        // `app.launch()` (inside the re-started agent) provides an equivalent
        // fresh launch — slower but correct.
        if !is_physical {
            let _ = ios::device::terminate_app(serial, package_name).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            ios::device::launch_app(serial, package_name)
                .await
                .map_err(|e| {
                    format!("Failed to relaunch app via simctl before agent restart: {e}")
                })?;
            tokio::time::sleep(Duration::from_millis(300)).await;
        }

        let agent_port = self.agent.read().await.port();
        let new_iproxy = match ios::agent_launch::start_agent_fresh(
            serial,
            &config.xctestrun_path,
            &config.target_package,
            agent_port,
            is_physical,
        )
        .await
        {
            Ok(handle) => handle,
            Err(e) => {
                let msg = format!("{e}");
                // Exit status 65 = simulator "Busy" (app still installing/
                // uninstalling). Retry once after letting the simulator settle.
                if msg.contains("exit status: 65") {
                    tracing::warn!("xcodebuild exited 65 (Busy), retrying after delay");
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    ios::agent_launch::start_agent_fresh(
                        serial,
                        &config.xctestrun_path,
                        &config.target_package,
                        agent_port,
                        is_physical,
                    )
                    .await
                    .map_err(|e| format!("Failed to restart iOS agent (retry): {e}"))?
                } else {
                    return Err(format!("Failed to restart iOS agent: {e}"));
                }
            }
        };
        if let Some(handle) = new_iproxy {
            // Drop the old handle (closing its tunnel) before storing the new one
            // so the host port is never owned by two iproxy instances at once.
            *self.ios_iproxy.write().await = Some(handle);
        }

        self.agent
            .write()
            .await
            .connect_ios(serial)
            .await
            .map_err(|e| format!("Failed to reconnect to agent: {e}"))?;

        self.probe_ios_agent_session(wait_for_idle, idle_timeout_ms)
            .await
    }

    async fn reset_ios_app(
        &self,
        serial: &str,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        let is_physical = self.is_active_ios_physical().await;

        // PILOT-245/242: when network tracing is enabled on a simulator, force
        // gRPC-Core onto the native resolver before app launch. Its c-ares
        // resolver emits UDP DNS from the app process, which the TCP-only
        // redirector cannot proxy. Gate on the session config flag (set at
        // set_device, before any launch) rather than the live proxy because
        // the app is first launched in preflight, before per-test capture.
        #[cfg(target_os = "macos")]
        if !is_physical && *self.network_tracing_enabled.read().await {
            ios::device::prepare_grpc_trust(serial, package_name).await;
        }

        let reset_start = std::time::Instant::now();
        let t0 = std::time::Instant::now();
        match self
            .relaunch_ios_app_via_agent(package_name, wait_for_idle, idle_timeout_ms)
            .await
        {
            Ok(()) => {
                info!(
                    package_name,
                    elapsed_ms = t0.elapsed().as_millis() as u64,
                    "iOS app reset completed via in-runner relaunch"
                );
                crate::timing::timing_log!(
                    "kind=reset name=in_runner dur_ms={} ok=true",
                    reset_start.elapsed().as_millis()
                );
                return Ok(());
            }
            Err(err) => {
                warn!(
                    package_name,
                    error = %err,
                    elapsed_ms = t0.elapsed().as_millis() as u64,
                    "in-runner iOS relaunch failed; trying next fallback"
                );
            }
        }

        // Physical devices skip the simctl fallback entirely — simctl targets
        // Simulator runtimes, not real hardware. Jump straight to the full
        // agent restart path, which works for both target kinds.
        if is_physical {
            let res = self
                .restart_ios_agent_for_app(serial, package_name, wait_for_idle, idle_timeout_ms)
                .await;
            crate::timing::timing_log!(
                "kind=reset name=agent_restart dur_ms={} ok={}",
                reset_start.elapsed().as_millis(),
                res.is_ok()
            );
            return res;
        }

        let t1 = std::time::Instant::now();
        match self
            .relaunch_ios_app_via_simctl(serial, package_name, wait_for_idle, idle_timeout_ms)
            .await
        {
            Ok(()) => {
                info!(
                    package_name,
                    elapsed_ms = t1.elapsed().as_millis() as u64,
                    "iOS app reset completed via simctl relaunch"
                );
                crate::timing::timing_log!(
                    "kind=reset name=simctl dur_ms={} ok=true",
                    reset_start.elapsed().as_millis()
                );
                Ok(())
            }
            Err(err) => {
                warn!(
                    package_name,
                    error = %err,
                    elapsed_ms = t1.elapsed().as_millis() as u64,
                    "simctl relaunch lost the iOS accessibility session; falling back to agent restart"
                );
                let res = self
                    .restart_ios_agent_for_app(serial, package_name, wait_for_idle, idle_timeout_ms)
                    .await;
                crate::timing::timing_log!(
                    "kind=reset name=agent_restart dur_ms={} ok={}",
                    reset_start.elapsed().as_millis(),
                    res.is_ok()
                );
                res
            }
        }
    }

    /// Get the platform of the active device.
    /// Returns None when no device has been selected yet — callers must
    /// not assume a default platform.
    async fn active_platform(&self) -> Option<Platform> {
        self.device_manager
            .read()
            .await
            .active_device()
            .map(|d| d.platform)
    }

    /// An agent that honours `ackEpochGreaterThan` always reports the epoch it
    /// verified as `epochAfter` in its data (warm and cold paths alike). A
    /// successful response without it means the agent build predates the ack
    /// parameter and delivered without verifying — downgrade it to a failure
    /// so the reset ladder escalates instead of trusting a reset that may
    /// never have run.
    fn require_epoch_ack_echo(
        ack_epoch_gt: Option<u64>,
        result: Result<AgentResponse, Status>,
    ) -> Result<AgentResponse, Status> {
        match (ack_epoch_gt, result) {
            (Some(_), Ok(resp)) if resp.success && resp.data.get("epochAfter").is_none() => {
                Ok(AgentResponse {
                    success: false,
                    error: Some(
                        "agent did not report epochAfter for an epoch-acknowledged deep link \
                         (agent build predates ackEpochGreaterThan?)"
                            .to_string(),
                    ),
                    error_type: Some("ACTION_FAILED".to_string()),
                    data: resp.data,
                })
            }
            (_, result) => result,
        }
    }

    /// Deliver a deep link on the active device. Shared by the `OpenDeepLink`
    /// RPC (plain navigation, `ack_epoch_gt = None`) and the `ResetApp`
    /// ladder (declared in-app reset, acknowledged by the hooks marker's
    /// epoch advancing past `ack_epoch_gt`).
    async fn deliver_deep_link(
        &self,
        request_id: String,
        uri: &str,
        delivery: DeepLinkDelivery,
        ack_epoch_gt: Option<u64>,
        mut ack_boot_before: Option<String>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let platform = self.require_platform().await?;
        // Plain navigation links (no reset-epoch ack) can still be positively
        // acknowledged when the app mounts `@tapsmith/react-native` with a
        // `nav` counter: the app bumps it for every URL it receives, so even a
        // link to the screen already showing — which the hierarchy-change
        // heuristic can never verify, costing the full warm window plus a cold
        // fallback — verifies in one marker read.
        // The pre-fetch is an agent round-trip per link, so it is skipped once
        // a probe has concluded this app renders no marker (the conclusion is
        // dropped on device/agent change and on every app (re)launch); a
        // session that has seen the marker always re-reads — the nav value
        // must be fresh, and hooks compiled into an app cannot vanish.
        let mut ack_nav_gt: Option<u64> = None;
        if ack_epoch_gt.is_none() {
            let hooks_seen = self.last_hooks_marker.read().await.is_some();
            let known_absent = *self.nav_probe_found_no_marker.read().await;
            if hooks_seen || !known_absent {
                match self.current_hooks_marker(5_000).await {
                    Some(marker) => {
                        if let Some(nav) = marker.nav {
                            ack_nav_gt = Some(nav);
                            ack_boot_before = marker.boot.clone();
                        }
                        *self.last_hooks_marker.write().await = Some(marker);
                    }
                    None if !hooks_seen => {
                        *self.nav_probe_found_no_marker.write().await = true;
                    }
                    None => {}
                }
            }
        }
        match platform {
            Platform::Ios => {
                let bundle_id = self
                    .ios_agent_config
                    .read()
                    .await
                    .as_ref()
                    .map(|c| c.target_package.clone())
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| {
                        Status::failed_precondition(
                            "device.openDeepLink requires an active agent session \
                             with a target package. Call startAgent first.",
                        )
                    })?;
                let serial = self.active_serial().await?;

                if self.is_active_ios_physical().await {
                    // Physical: use the agent's XCUIApplication.open(url:).
                    let command = AgentCommand::OpenDeepLink {
                        url: uri.to_string(),
                        package: bundle_id,
                        deliver_in_process: true,
                        require_ui_change: false,
                        ack_epoch_gt,
                        ack_boot_before: ack_boot_before.clone(),
                        ack_nav_gt,
                    };
                    let result = Self::require_epoch_ack_echo(
                        ack_epoch_gt,
                        self.send_agent_command(&command).await,
                    );
                    return self.make_action_response(request_id, result).await;
                }

                // Simulator: warm-first, cold fallback.
                //
                // Warm attempt: if the app is already running with rendered
                // content, deliver in-process (the physical-device path:
                // activate + XCUIApplication.open(url:)) and require the UI
                // hierarchy to change from its pre-open state within a bounded
                // window. The hierarchy-change requirement is what makes warm
                // delivery verifiable — a warm app trivially "has rendered
                // content", so the cold verify's readiness check would mask a
                // dropped Linking event. This skips the terminate -> cold
                // relaunch cycle (~14-22s on CI) for the common case: per-test
                // soft resets and in-test navigation against a running app.
                //
                // The historical reasons for avoiding this path no longer
                // hold as written: the "open(url:) hangs on quiescence" finding
                // predates the QuiescenceDisabler swizzle (which the agent now
                // applies before delivery), and the "warm delivery doesn't
                // trigger RN navigation" finding was observed with warm
                // `simctl openurl`, not XCUIApplication.open(url:) — which
                // physical devices use for every deep link today. The fallback
                // below keeps behavior identical when warm delivery doesn't
                // land; the worst case is the status quo plus one bounded
                // warm window (IOS_OPEN_DEEP_LINK_WARM_TIMEOUT_MS).
                //
                // `force_cold_launch` skips the warm attempt entirely. The SDK
                // sets it for the between-file soft reset: a July 2026 local
                // soak of the full E2E suite showed that sessions running
                // all-warm for ~60+ deliveries accumulate native navigation
                // state that observably diverges from a cold launch (screen
                // a11y trees stop being flattened — strict-mode selectors that
                // matched one element start matching two — and element ids go
                // stale), while every file-sized warm window (~20-30
                // deliveries from a cold start) stayed green. Cold-launching
                // at file boundaries pins each file to the exact starting
                // state it had before warm delivery existed and bounds the
                // warm window to one file.
                if delivery != DeepLinkDelivery::Cold {
                    let warm_command = AgentCommand::OpenDeepLink {
                        url: uri.to_string(),
                        package: bundle_id.clone(),
                        deliver_in_process: true,
                        // With an epoch or nav ack the in-app hook is the
                        // verifier; otherwise fall back to the hierarchy-change
                        // heuristic (older app builds without the nav counter).
                        require_ui_change: ack_epoch_gt.is_none() && ack_nav_gt.is_none(),
                        ack_epoch_gt,
                        ack_boot_before: ack_boot_before.clone(),
                        ack_nav_gt,
                    };
                    let warm_result = Self::require_epoch_ack_echo(
                        ack_epoch_gt,
                        self.send_agent_command_with_timeout(
                            &warm_command,
                            IOS_OPEN_DEEP_LINK_WARM_TIMEOUT_MS,
                        )
                        .await,
                    );
                    let warm_only = delivery == DeepLinkDelivery::WarmOnly;
                    let next = if warm_only {
                        "reporting the miss to the caller"
                    } else {
                        "falling back to cold relaunch"
                    };
                    match &warm_result {
                        Ok(resp) if resp.success => {
                            return self.make_action_response(request_id, warm_result).await;
                        }
                        Ok(resp) => {
                            info!(
                                %serial, uri = %uri,
                                error = %resp.error.as_deref().unwrap_or("unknown"),
                                "warm in-process deep link did not land; {next}"
                            );
                        }
                        Err(status) => {
                            info!(
                                %serial, uri = %uri, error = %status.message(),
                                "warm in-process deep link errored; {next}"
                            );
                        }
                    }
                    if warm_only {
                        return self.make_action_response(request_id, warm_result).await;
                    }
                }

                // Cold fallback: terminate -> simctl openurl -> agent verify,
                // retried as a unit. The first cold, trust-gated openurl on a
                // fresh sim intermittently fails to foreground the app (the
                // "Open in <app>?" prompt races the launch and the app lands
                // back on SpringBoard). Re-delivering self-heals: a second
                // openurl is warm and already trusted, so it lands. We only
                // succeed once the agent confirms the app actually rendered
                // content (the verify returns false on a never-foregrounded app
                // rather than masking it).
                //
                // simctl openurl to a running app doesn't trigger navigation
                // (the React Native scene handler misses it), so we terminate
                // first — making openurl cold-launch the app with the URL.
                // Fresh simulators can show "Open in <app>?" and block simctl
                // itself, so the daemon taps that dialog while openurl is
                // still pending.
                let max_attempts = IOS_OPEN_DEEP_LINK_MAX_ATTEMPTS;
                let mut last_error = "openDeepLink: app did not reach destination".to_string();
                let mut verify_result: Option<Result<AgentResponse, Status>> = None;
                let mut attempt: u32 = 0;
                // One-shot escalation for the compositor outage: when the
                // agent reports the display is not rendering (black screen
                // with a healthy a11y tree), app relaunches provably don't
                // recover it — only recreating the whole render surface does.
                // Reboot the simulator, bring the agent back, and re-deliver.
                let mut rebooted_for_black_display = false;
                loop {
                    attempt += 1;
                    if last_error.contains("display is not rendering")
                        && !rebooted_for_black_display
                        && !self.is_active_ios_physical().await
                    {
                        rebooted_for_black_display = true;
                        warn!(
                            %serial, uri = %uri,
                            "display is not rendering and an app relaunch cannot recover a dead \
                             compositor; rebooting the simulator and restarting the agent"
                        );
                        let _ = ios::device::shutdown_simulator(&serial).await;
                        if let Err(e) = ios::device::boot_simulator(&serial).await {
                            warn!(%serial, error = %e, "simulator reboot failed; continuing with re-delivery");
                        } else {
                            // Give SpringBoard a moment past `Booted` before
                            // asking xcodebuild to install/launch the runner.
                            tokio::time::sleep(Duration::from_secs(5)).await;
                            if let Err(e) = self
                                .restart_ios_agent_for_app(&serial, &bundle_id, false, 5_000)
                                .await
                            {
                                warn!(%serial, error = %e, "agent restart after simulator reboot failed");
                            }
                        }
                        // The reboot is recovery, not a delivery attempt —
                        // don't let it consume one.
                        attempt -= 1;
                    }
                    // The terminate MUST actually land: `simctl openurl` to a
                    // still-running app foregrounds it without delivering any
                    // navigation event to React Native, and the verify below
                    // can't tell that apart from a legitimate delivery whose
                    // destination renders like the current screen — the app
                    // silently stays where it was while the reset "succeeds".
                    // The agent now confirms the process died; when it can't
                    // (observed under CoreSimulator pressure with agent
                    // commands running 10-40s), force it host-side before
                    // delivering.
                    let terminate_confirmed = matches!(
                        self.send_agent_command_with_timeout(
                            &AgentCommand::TerminateApp {
                                package: bundle_id.clone(),
                            },
                            10_000,
                        )
                        .await,
                        Ok(resp) if resp.success
                    );
                    if !terminate_confirmed {
                        warn!(
                            %serial, uri = %uri,
                            "agent could not confirm app termination; forcing simctl \
                             terminate so openurl cold-launches the app"
                        );
                        let _ = ios::device::terminate_app(&serial, &bundle_id).await;
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;

                    if let Err(e) = self
                        .open_ios_simulator_url_with_prompt_handling(&serial, uri)
                        .await
                    {
                        if ios::device::is_retryable_open_url_error(&e.to_string()) {
                            last_error = e.to_string();
                            if attempt >= max_attempts {
                                warn!(
                                    %serial, uri = %uri, attempt, max_attempts,
                                    error = %e,
                                    "simctl openurl kept hitting a transient timeout; giving up"
                                );
                                break;
                            }
                            warn!(
                                %serial, uri = %uri, attempt,
                                error = %e,
                                "simctl openurl hit a transient timeout; re-delivering deep link"
                            );
                            tokio::time::sleep(Duration::from_millis(500)).await;
                            continue;
                        }
                        return Ok(self
                            .action_error(request_id, "ACTION_FAILED", e.to_string())
                            .await);
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;

                    let command = AgentCommand::OpenDeepLink {
                        url: uri.to_string(),
                        package: bundle_id.clone(),
                        deliver_in_process: false,
                        require_ui_change: false,
                        ack_epoch_gt,
                        ack_boot_before: ack_boot_before.clone(),
                        ack_nav_gt,
                    };
                    let result = Self::require_epoch_ack_echo(
                        ack_epoch_gt,
                        self.send_agent_command_with_timeout(
                            &command,
                            IOS_OPEN_DEEP_LINK_VERIFY_TIMEOUT_MS,
                        )
                        .await,
                    );
                    if matches!(&result, Ok(resp) if resp.success) {
                        verify_result = Some(result);
                        break;
                    }
                    last_error = match &result {
                        Ok(resp) => resp.error.clone().unwrap_or_else(|| {
                            "app did not reach deep-link destination".to_string()
                        }),
                        Err(status) => status.message().to_string(),
                    };
                    verify_result = Some(result);
                    // A display-not-rendering failure is exempt from the
                    // attempt cap until the one-shot reboot escalation (top of
                    // loop) has had its chance — re-delivery alone provably
                    // can't fix it, so counting it against the cap just gives up.
                    let reboot_pending = last_error.contains("display is not rendering")
                        && !rebooted_for_black_display;
                    if attempt >= max_attempts && !reboot_pending {
                        warn!(
                            %serial, uri = %uri, attempt, max_attempts,
                            error = %last_error,
                            "deep link did not reach its destination after retries; giving up"
                        );
                        break;
                    }
                    warn!(
                        %serial, uri = %uri, attempt,
                        error = %last_error,
                        "deep link did not reach its destination; re-delivering"
                    );
                }

                match verify_result {
                    Some(result) => self.make_action_response(request_id, result).await,
                    None => Ok(self
                        .action_error(request_id, "ACTION_FAILED", last_error)
                        .await),
                }
            }
            Platform::Android => {
                if uri.contains('\'') {
                    return Err(Status::invalid_argument(
                        "uri contains an invalid character: single quote (') is not allowed",
                    ));
                }
                let serial = self.active_serial().await?;
                let target_package = self
                    .started_agent_config
                    .read()
                    .await
                    .as_ref()
                    .map(|c| c.target_package.clone())
                    .filter(|p| !p.is_empty());

                let cmd = format!("am start -a android.intent.action.VIEW -d '{}'", uri);
                if let Err(e) = adb::shell(&serial, &cmd).await {
                    let screenshot = self.error_screenshot().await;
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
                        (Some(before), _) => match self.current_hooks_marker(5_000).await {
                            Some(marker)
                                if app_reset::hooks_acknowledged(
                                    before,
                                    ack_boot_before.as_deref(),
                                    &marker,
                                ) =>
                            {
                                if let Some(err) = marker.err {
                                    return Ok(self
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
                        (None, Some(nav_before)) => match self.current_hooks_marker(5_000).await {
                            Some(marker) => app_reset::nav_acknowledged(
                                nav_before,
                                ack_boot_before.as_deref(),
                                &marker,
                            ),
                            None => false,
                        },
                        (None, None) => match (&target_package, self.get_current_component().await)
                        {
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
                    .send_agent_command_with_timeout(&idle_cmd, ANDROID_DEEP_LINK_IDLE_TIMEOUT_MS)
                    .await;

                Ok(Self::success_action_response(request_id))
            }
        }
    }

    async fn current_hierarchy_xml(&self, timeout_ms: u64) -> Option<String> {
        let resp = self
            .send_agent_command_with_timeout(&AgentCommand::GetUiHierarchy {}, timeout_ms)
            .await
            .ok()?;
        resp.data
            .get("hierarchy")
            .and_then(|v| v.as_str())
            .map(|x| x.to_string())
    }

    /// Fetch the current UI hierarchy and parse the `@tapsmith/react-native`
    /// hooks marker from it, if present.
    async fn current_hooks_marker(&self, timeout_ms: u64) -> Option<app_reset::HooksMarker> {
        let xml = self.current_hierarchy_xml(timeout_ms).await?;
        app_reset::parse_hooks_marker(&xml)
    }

    /// Whether `package` has a live process. `None` when it cannot be told
    /// (no agent, command failure).
    async fn app_is_running(&self, package: &str) -> Option<bool> {
        match self.require_platform().await.ok()? {
            Platform::Ios => {
                let command = AgentCommand::GetAppState {
                    package: package.to_string(),
                };
                let result = self.send_agent_command(&command).await.ok()?;
                let state = result.data.get("state").and_then(|v| v.as_str())?;
                Some(!matches!(
                    state,
                    "stopped" | "not_running" | "notRunning" | "unknown"
                ))
            }
            Platform::Android => {
                // `pidof` exits non-zero when nothing matches, which adb::shell
                // surfaces as an error — `|| true` makes "no process" read as
                // not running rather than unknown.
                let serial = self.active_serial().await.ok()?;
                let out = adb::shell(&serial, &format!("pidof {package} 2>/dev/null || true"))
                    .await
                    .ok()?;
                Some(!out.trim().is_empty())
            }
        }
    }

    /// Terminate + relaunch keeping data — the `restart` rung of the reset ladder.
    async fn restart_app_inner(
        &self,
        serial: &str,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        // The relaunched process may render a marker an earlier probe missed
        // (see `nav_probe_found_no_marker`).
        *self.nav_probe_found_no_marker.write().await = false;
        match self
            .require_platform()
            .await
            .map_err(|e| e.message().to_string())?
        {
            Platform::Ios => {
                self.reset_ios_app(serial, package_name, wait_for_idle, idle_timeout_ms)
                    .await
            }
            Platform::Android => {
                self.android_clean_relaunch(serial, package_name, wait_for_idle, idle_timeout_ms)
                    .await
            }
        }
    }

    /// Relaunch an Android app from a clean task, then wait for it to render.
    ///
    /// A restart is a reset primitive: callers expect the app back at its
    /// initial route, ready for input. `am force-stop` + a plain `LAUNCHER`
    /// intent resumes the persisted task, so Android restores the previous
    /// Activity's saved instance state — the old navigation route and even
    /// scroll positions come back. `--activity-clear-task` discards that saved
    /// state so the app starts fresh at its launcher route. When the launcher
    /// activity can't be resolved, fall back to the old force-stop + monkey
    /// path (better a stale route than no relaunch).
    async fn android_clean_relaunch(
        &self,
        serial: &str,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        let cached = self.android_launcher_activity.read().await.clone();
        let activity = match cached {
            Some(a) => Some(a),
            None => {
                let resolved = self
                    .resolve_launcher_activity(serial, package_name)
                    .await
                    .ok()
                    .flatten();
                if let Some(ref a) = resolved {
                    *self.android_launcher_activity.write().await = Some(a.clone());
                }
                resolved
            }
        };
        let mut clean_started = false;
        if let Some(activity) = activity {
            let cmd = format!(
                "am start -S -a android.intent.action.MAIN -c android.intent.category.LAUNCHER --activity-clear-task -n {package_name}/{activity}"
            );
            match adb::shell(serial, &cmd).await {
                Ok(out) if !out.contains("Error") => {
                    clean_started = true;
                    if wait_for_idle {
                        let timeout = if idle_timeout_ms > 0 {
                            idle_timeout_ms
                        } else {
                            10_000
                        };
                        let _ = self
                            .send_agent_command_with_timeout(
                                &AgentCommand::WaitForIdle {
                                    timeout_ms: Some(timeout),
                                },
                                timeout,
                            )
                            .await;
                    }
                }
                Ok(out) => {
                    warn!(%activity, output = %out.trim(), "clean-task relaunch rejected; falling back to force-stop + launcher intent");
                }
                Err(e) => {
                    warn!(%activity, error = %e, "clean-task relaunch failed; falling back to force-stop + launcher intent");
                }
            }
        }
        if !clean_started {
            // No resolvable activity, or the explicit start failed: the old
            // force-stop + launcher-intent path resumes the persisted task
            // (stale route possible), but a stale route beats no relaunch.
            adb::shell(serial, &format!("am force-stop {}", package_name))
                .await
                .map_err(|e| format!("force-stop failed: {e}"))?;
            let resp = self
                .launch_package(
                    serial,
                    Uuid::new_v4().to_string(),
                    package_name,
                    wait_for_idle,
                    idle_timeout_ms,
                )
                .await
                .map_err(|e| e.message().to_string())?
                .into_inner();
            if !resp.success {
                return Err(resp.error_message);
            }
        }
        self.wait_for_android_rendered_content(serial, package_name)
            .await;
        Ok(())
    }

    /// Poll the hierarchy until the app has drawn real content (a node of its
    /// own package carrying text or a content description), so a deep link or
    /// interaction issued right after a relaunch isn't lost into a booting RN
    /// app. Bounded and best-effort.
    async fn wait_for_android_rendered_content(&self, _serial: &str, package_name: &str) {
        let started = tokio::time::Instant::now();
        loop {
            if let Some(xml) = self.current_hierarchy_xml(5_000).await {
                if android_hierarchy_has_rendered_content(&xml, package_name) {
                    return;
                }
            }
            if started.elapsed() >= ANDROID_RENDER_READY_TIMEOUT {
                return;
            }
            tokio::time::sleep(ANDROID_RENDER_READY_POLL).await;
        }
    }

    /// Wipe app data — the `clear` rung of the reset ladder, without the
    /// relaunch. Mirrors the `ClearAppData` RPC's platform behaviour.
    async fn clear_app_data_inner(&self, serial: &str, package_name: &str) -> Result<(), String> {
        match self
            .require_platform()
            .await
            .map_err(|e| e.message().to_string())?
        {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    let app_path = self
                        .ios_agent_config
                        .read()
                        .await
                        .as_ref()
                        .and_then(|c| c.app_path.clone())
                        .ok_or_else(|| {
                            "clearing app data on a physical iOS device requires the app \
                             bundle path passed at startAgent time"
                                .to_string()
                        })?;
                    if let Err(e) = ios::device::uninstall_app_on_device(serial, package_name).await
                    {
                        warn!(error = %e, "Uninstall step of physical-iOS clear failed, continuing to reinstall");
                    }
                    ios::device::install_app_on_device(serial, &app_path)
                        .await
                        .map_err(|e| format!("reinstall failed: {e}"))?;
                    tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
                    return Ok(());
                }
                // Terminate first (as launch_app's own clear path does): a
                // running process flushes UserDefaults / caches on exit, which
                // would resurrect state deleted from under it.
                let _ = ios::device::terminate_app(serial, package_name).await;
                match self.get_app_container_cached(serial, package_name).await {
                    Ok(ref container) => {
                        if let Err(e) = ios::device::clear_container(container).await {
                            warn!(error = %e, "Failed to clear app container, continuing anyway");
                        }
                        if !ios::device::keychain_state_disabled() {
                            if let Some(keychain_dir) =
                                ios::device::simulator_keychain_dir(container)
                            {
                                if let Err(e) =
                                    ios::device::clear_keychain(serial, &keychain_dir).await
                                {
                                    warn!(error = %e, "Failed to clear simulator keychain, continuing anyway");
                                }
                            }
                        }
                    }
                    Err(e) => {
                        debug!(error = %e, "Could not get app container (app may not be installed)");
                    }
                }
                Ok(())
            }
            Platform::Android => {
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
        }
    }

    /// Require the active device's platform, returning a gRPC error if
    /// no device has been selected.
    async fn require_platform(&self) -> Result<Platform, Status> {
        self.active_platform()
            .await
            .ok_or_else(|| Status::failed_precondition("No device selected. Call SetDevice first."))
    }

    async fn error_screenshot(&self) -> Vec<u8> {
        let dm = self.device_manager.read().await;
        let serial = dm.active_serial().map(String::from);
        let platform = dm.active_device().map(|d| d.platform);
        drop(dm);
        match (serial.as_deref(), platform) {
            (Some(s), Some(p)) => screenshot::capture_for_error(Some(s), p).await,
            _ => Vec::new(), // No device selected — can't capture
        }
    }

    async fn action_error(
        &self,
        request_id: String,
        error_type: &str,
        error_message: String,
    ) -> Response<proto::ActionResponse> {
        let screenshot = self.error_screenshot().await;
        Response::new(proto::ActionResponse {
            request_id,
            success: false,
            error_type: error_type.to_string(),
            error_message,
            screenshot,
        })
    }

    /// Clean up network proxy state: revert device proxy settings, remove CA
    /// cert, and stop the proxy. Called during graceful shutdown to ensure the
    /// device isn't left with a dangling proxy configuration.
    pub async fn cleanup_network_proxy(&self) {
        // Take the iOS redirect handle out of its slot now so we can
        // deterministically drop it BEFORE `proxy.stop()` runs below.
        // Dropping the handle closes the SE control channel (removing
        // this worker's PID filter), aborts the accept/refresh/launcher
        // tasks, and aborts any in-flight per-flow handlers. Without
        // this ordering, those background tasks would keep dispatching
        // new flows into the proxy state we're about to tear down.
        //
        // Note: `let _ios_redirect = ...` would drop at end-of-scope
        // (after `proxy.stop()`) because Rust drops locals in reverse
        // declaration order. We rely on an explicit `drop()` call below
        // to get the right ordering.
        #[cfg(target_os = "macos")]
        let ios_redirect = self.ios_redirect.write().await.take();
        #[cfg(target_os = "macos")]
        let system_proxy_service = self.ios_system_proxy_service.write().await.take();
        let proxy = self.network_proxy.write().await.take();
        let serial = self.proxy_device_serial.write().await.take();
        let platform = self.proxy_platform.write().await.take();
        let reverse_port = self.proxy_reverse_port.write().await.take();
        let ca_cert_path = self.proxy_ca_cert_path.write().await.take();
        self.proxy_http_ports.write().await.clear();
        let used_iptables = std::mem::replace(&mut *self.proxy_uses_iptables.write().await, false);

        // Reset macOS system proxy if we set it as a fallback.
        #[cfg(target_os = "macos")]
        if let Some(service) = &system_proxy_service {
            ios::system_proxy::reset_system_proxy(service).await;
        }

        if let Some(serial) = &serial {
            match platform {
                Some(Platform::Ios) => {
                    info!(%serial, "iOS proxy stopped on shutdown");
                }
                _ => {
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
                    if let Some(port) = reverse_port {
                        if let Err(e) = adb::remove_reverse_with_timeout(
                            serial,
                            port,
                            ANDROID_PROXY_CLEANUP_TIMEOUT,
                        )
                        .await
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
        }

        // Explicit drop BEFORE `proxy.stop()` — see comment above. On
        // non-macOS this no-ops because `ios_redirect` doesn't exist.
        #[cfg(target_os = "macos")]
        drop(ios_redirect);

        if let Some(proxy) = proxy {
            let _ = proxy.stop().await;
        }
    }

    /// Clean up WebView port forwards and proxy processes on shutdown.
    pub async fn cleanup_webview_state(&self) {
        // Clean up Android ADB port forwards
        let forwards: Vec<u16> = self.webview_forwards.read().await.keys().copied().collect();
        if !forwards.is_empty() {
            if let Some(serial) = self.device_manager.read().await.active_serial() {
                let serial = serial.to_string();
                for port in forwards {
                    if let Err(e) =
                        adb::remove_forward_with_timeout(&serial, port, WEBVIEW_ADB_TIMEOUT).await
                    {
                        warn!(
                            port,
                            "Failed to remove WebView port forward on shutdown: {e}"
                        );
                    }
                }
            }
            self.webview_forwards.write().await.clear();
        }

        // Drop the iOS webkit debug proxy (kills the child process)
        #[cfg(target_os = "macos")]
        {
            let _ = self.webkit_debug_proxy.write().await.take();
        }
    }

    async fn make_action_response(
        &self,
        request_id: String,
        result: Result<AgentResponse, Status>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        match result {
            Ok(resp) if resp.success => Ok(Response::new(proto::ActionResponse {
                request_id,
                success: true,
                error_type: String::new(),
                error_message: String::new(),
                screenshot: Vec::new(),
            })),
            Ok(resp) => {
                let screenshot = self.error_screenshot().await;
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: resp.error_type.unwrap_or_default(),
                    error_message: resp.error.unwrap_or_else(|| "Unknown error".to_string()),
                    screenshot,
                }))
            }
            Err(status) => {
                let screenshot = self.error_screenshot().await;
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "INTERNAL".to_string(),
                    error_message: status.message().to_string(),
                    screenshot,
                }))
            }
        }
    }

    /// Validate that a string looks like a valid Android package name (e.g. `com.example.app`).
    #[allow(clippy::result_large_err)] // Status is tonic's standard error type
    fn validate_package_name(name: &str) -> Result<(), Status> {
        if name.is_empty() {
            return Err(Status::invalid_argument("package_name is required"));
        }
        // Package names: letters, digits, dots, underscores
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
        {
            return Err(Status::invalid_argument(format!(
                "invalid package name: {name:?} — must contain only alphanumeric characters, dots, and underscores"
            )));
        }
        Ok(())
    }

    /// Validate that a string looks like a valid Android permission (e.g. `android.permission.CAMERA`).
    #[allow(clippy::result_large_err)]
    fn validate_permission(perm: &str) -> Result<(), Status> {
        if perm.is_empty() {
            return Err(Status::invalid_argument("permission is required"));
        }
        if !perm
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
        {
            return Err(Status::invalid_argument(format!(
                "invalid permission: {perm:?} — must contain only alphanumeric characters, dots, and underscores"
            )));
        }
        Ok(())
    }

    /// Validate that a string looks like a valid Android activity name (e.g. `.MainActivity`).
    #[allow(clippy::result_large_err)]
    fn validate_activity(activity: &str) -> Result<(), Status> {
        if !activity
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '$')
        {
            return Err(Status::invalid_argument(format!(
                "invalid activity name: {activity:?}"
            )));
        }
        Ok(())
    }

    /// Run an ADB shell command and return a success/failure ActionResponse.
    async fn adb_action(
        &self,
        request_id: String,
        command: &str,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let serial = self.active_serial().await?;
        match adb::shell(&serial, command).await {
            Ok(_) => Ok(Response::new(proto::ActionResponse {
                request_id,
                success: true,
                error_type: String::new(),
                error_message: String::new(),
                screenshot: Vec::new(),
            })),
            Err(e) => {
                let screenshot = self.error_screenshot().await;
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "ADB_COMMAND_FAILED".to_string(),
                    error_message: e.to_string(),
                    screenshot,
                }))
            }
        }
    }

    fn success_action_response(request_id: String) -> Response<proto::ActionResponse> {
        Response::new(proto::ActionResponse {
            request_id,
            success: true,
            error_type: String::new(),
            error_message: String::new(),
            screenshot: Vec::new(),
        })
    }

    /// Helper for methods where iOS is a no-op (returns success) and Android
    /// runs a single ADB shell command.
    async fn ios_noop_or_android_adb(
        &self,
        request_id: String,
        android_cmd: &str,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => Ok(Self::success_action_response(request_id)),
            Platform::Android => self.adb_action(request_id, android_cmd).await,
        }
    }

    /// Helper for grant/revoke permission which share identical structure:
    /// iOS calls `ios::device::{action}_permission`, Android validates the
    /// permission format then runs `pm {action}`.
    async fn platform_permission_action(
        &self,
        request_id: String,
        package_name: &str,
        permission: &str,
        action: &str,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    // `xcrun simctl privacy` only targets simulators. Physical
                    // devices require user interaction (or MDM) to change
                    // permission state. Surface a clear error with a workaround
                    // pointing to the in-app permission dialog + UIInterruptionMonitor.
                    return Ok(self
                        .action_error(
                            request_id,
                            "UNSUPPORTED_ON_PHYSICAL_DEVICE",
                            format!(
                                "device.{action}Permission is not supported on physical iOS devices. \
                                 Workaround: trigger the in-app permission dialog during the test and \
                                 let the XCUITest UIInterruptionMonitor tap through it automatically."
                            ),
                        )
                        .await);
                }
                let serial = self.active_serial().await?;
                let result = match action {
                    "grant" => {
                        ios::device::grant_permission(&serial, package_name, permission).await
                    }
                    "revoke" => {
                        ios::device::revoke_permission(&serial, package_name, permission).await
                    }
                    _ => unreachable!("platform_permission_action called with invalid action"),
                };
                match result {
                    Ok(()) => Ok(Self::success_action_response(request_id)),
                    Err(e) => Ok(self
                        .action_error(request_id, "ACTION_FAILED", e.to_string())
                        .await),
                }
            }
            Platform::Android => {
                Self::validate_permission(permission)?;
                let cmd = format!("pm {action} {package_name} {permission}");
                self.adb_action(request_id, &cmd).await
            }
        }
    }

    async fn finish_launch(
        &self,
        request_id: String,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let idle_timeout = if idle_timeout_ms > 0 {
            idle_timeout_ms
        } else {
            10_000
        };

        if wait_for_idle {
            let idle_cmd = AgentCommand::WaitForIdle {
                timeout_ms: Some(idle_timeout),
            };
            if let Err(e) = self
                .send_agent_command_with_timeout(&idle_cmd, idle_timeout)
                .await
            {
                let screenshot = self.error_screenshot().await;
                return Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "WAIT_FOR_IDLE_FAILED".to_string(),
                    error_message: format!("App launched but UI did not become idle: {e}"),
                    screenshot,
                }));
            }
        }

        Ok(Self::success_action_response(request_id))
    }

    /// Launch an app via ADB shell command, optionally wait for idle, and return
    /// a success/failure ActionResponse. Shared by `launch_app` and `restart_app`.
    async fn launch_and_idle(
        &self,
        serial: &str,
        request_id: String,
        launch_cmd: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        match adb::shell(serial, launch_cmd).await {
            Ok(_) => {
                self.finish_launch(request_id, wait_for_idle, idle_timeout_ms)
                    .await
            }
            Err(e) => {
                let screenshot = self.error_screenshot().await;
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "LAUNCH_FAILED".to_string(),
                    error_message: format!("Failed to launch app: {e}"),
                    screenshot,
                }))
            }
        }
    }

    async fn resolve_launcher_activity(
        &self,
        serial: &str,
        package_name: &str,
    ) -> Result<Option<String>, Status> {
        let commands = [
            format!("cmd package resolve-activity --brief {package_name}"),
            format!("pm resolve-activity --brief {package_name}"),
        ];

        for command in commands {
            let output = adb::shell_lenient(serial, &command)
                .await
                .map_err(|e| Status::internal(e.to_string()))?;

            if let Some(activity) = parse_resolved_activity(&output, package_name) {
                return Ok(Some(activity));
            }
        }

        Ok(None)
    }

    async fn launch_package(
        &self,
        serial: &str,
        request_id: String,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        // The relaunched process may render a marker an earlier probe missed
        // (see `nav_probe_found_no_marker`).
        *self.nav_probe_found_no_marker.write().await = false;
        let monkey_cmd = format!(
            "monkey -p {} -c android.intent.category.LAUNCHER 1",
            package_name
        );

        match adb::shell(serial, &monkey_cmd).await {
            Ok(_) => {
                self.finish_launch(request_id, wait_for_idle, idle_timeout_ms)
                    .await
            }
            Err(monkey_err) => {
                let Some(activity) = self.resolve_launcher_activity(serial, package_name).await?
                else {
                    let screenshot = self.error_screenshot().await;
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "LAUNCH_FAILED".to_string(),
                        error_message: format!("Failed to launch app: {monkey_err}"),
                        screenshot,
                    }));
                };

                let fallback_cmd =
                    format!("am start -S --activity-clear-task -n {package_name}/{activity}");
                match adb::shell(serial, &fallback_cmd).await {
                    Ok(_) => {
                        self.finish_launch(request_id, wait_for_idle, idle_timeout_ms)
                            .await
                    }
                    Err(fallback_err) => {
                        let screenshot = self.error_screenshot().await;
                        Ok(Response::new(proto::ActionResponse {
                            request_id,
                            success: false,
                            error_type: "LAUNCH_FAILED".to_string(),
                            error_message: format!(
                                "Failed to launch app via launcher intent ({monkey_err}) and explicit activity {activity} ({fallback_err})"
                            ),
                            screenshot,
                        }))
                    }
                }
            }
        }
    }

    /// Query dumpsys for the current resumed activity and return `(package, activity)`.
    async fn get_current_component(&self) -> Result<Option<(String, String)>, Status> {
        let serial = self.active_serial().await?;
        let output = adb::shell_lenient(
            &serial,
            "dumpsys activity activities | grep -E 'mResumedActivity|ResumedActivity|topResumedActivity'",
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        Ok(parse_component_name(&output))
    }

    /// Try to handle a streamed-touch event via the iOS-simulator HID path.
    /// Returns true if it was injected via HID; false means the caller should
    /// fall back to the agent command. `is_down` ensures the helper is spawned
    /// before the first event of a gesture.
    ///
    /// Fallback is per-event: if the helper dies mid-gesture, the failing event
    /// (and the rest of the gesture) routes to the agent. A gesture that started
    /// on HID and finishes on the agent could in theory leave a dangling HID
    /// touch, but in practice `ensure` only fails at `down` (before any contact)
    /// and a live helper does not die mid-drag — so a split gesture is a
    /// degenerate case, not the normal path.
    #[cfg(target_os = "macos")]
    async fn try_hid_touch(&self, line: &str, is_down: bool) -> bool {
        let udid = {
            let dm = self.device_manager.read().await;
            match dm.active_device() {
                Some(d) if d.platform == Platform::Ios && d.is_emulator => d.serial.clone(),
                _ => return false,
            }
        };
        if is_down {
            if let Err(e) = self.hid_injector.ensure(&udid).await {
                warn!(%udid, error = %e, "iOS HID helper unavailable; falling back to agent");
                return false;
            }
        }
        match self.hid_injector.send(&udid, line).await {
            Ok(()) => true,
            Err(e) => {
                warn!(%udid, error = %e, "iOS HID send failed; falling back to agent");
                false
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    async fn try_hid_touch(&self, _line: &str, _is_down: bool) -> bool {
        false
    }

    /// `simctl get_app_container` with a session-cache fallback (see
    /// `ios_app_container_cache`). Live lookup first keeps freshness; the
    /// cache serves only when the lookup fails — e.g. a wedged
    /// CoreSimulatorService timing out — so app-state save/clear keep
    /// working through the wedge instead of failing the test.
    async fn get_app_container_cached(
        &self,
        udid: &str,
        bundle_id: &str,
    ) -> anyhow::Result<String> {
        let key = format!("{udid}\u{0}{bundle_id}");
        match ios::device::get_app_container(udid, bundle_id).await {
            Ok(path) => {
                self.ios_app_container_cache
                    .write()
                    .await
                    .insert(key, path.clone());
                Ok(path)
            }
            Err(e) => {
                if let Some(cached) = self.ios_app_container_cache.read().await.get(&key) {
                    warn!(
                        %udid, bundle_id, error = %e,
                        "get_app_container failed; using session-cached container path"
                    );
                    return Ok(cached.clone());
                }
                Err(e)
            }
        }
    }

    /// Double-tap via the iOS-simulator HID helper: resolve the element's
    /// center through the agent (which owns waiting and matching), then
    /// inject two real down/up pairs. Real HID input enters below XCTest,
    /// so the iOS 26.x synthesized-tap coalescing (which swallows the
    /// second tap of every XCTest-level double-tap route) does not apply.
    /// Returns false — caller falls back to the agent route — when the
    /// active device isn't an iOS simulator, the helper is unavailable,
    /// element resolution fails, or an injection fails.
    #[cfg(target_os = "macos")]
    async fn try_hid_double_tap(
        &self,
        selector: &Value,
        timeout_ms: u64,
        interval_ms: u64,
    ) -> bool {
        let udid = {
            let dm = self.device_manager.read().await;
            match dm.active_device() {
                Some(d) if d.platform == Platform::Ios && d.is_emulator => d.serial.clone(),
                _ => return false,
            }
        };
        if let Err(e) = self.hid_injector.ensure(&udid).await {
            debug!(%udid, error = %e, "iOS HID helper unavailable for double-tap; using agent route");
            return false;
        }
        let find = AgentCommand::FindElement {
            selector: selector.clone(),
            timeout_ms: opt_timeout(timeout_ms),
        };
        let resp = match self
            .send_agent_command_with_timeout(&find, timeout_ms)
            .await
        {
            Ok(r) if r.success => r,
            _ => return false,
        };
        let Some(info) = parse_element_info(&resp.data) else {
            return false;
        };
        let Some(bounds) = info.bounds else {
            return false;
        };
        let x = (bounds.left + bounds.right) / 2;
        let y = (bounds.top + bounds.bottom) / 2;
        // One wire command: the helper owns the press/gap timing in-process
        // (~40ms press, ~120ms gap), so the inter-tap gap stays inside the
        // app's double-tap recognizer window regardless of daemon-side load.
        // Host-paced down/up pairs were observed stretching the gap past the
        // window on loaded CI runners (both taps delivered, classified as
        // two single taps). `interval_ms` is intentionally not forwarded —
        // fixed real-input timing is the point.
        let _ = interval_ms;
        if self
            .hid_injector
            .send(&udid, &format!("t2 {x} {y}"))
            .await
            .is_err()
        {
            return false;
        }
        info!(%udid, x, y, "double-tap injected via HID");
        true
    }

    /// Long-press via the iOS-simulator HID helper: resolve the element's
    /// center through the agent, then inject a real touch-down, hold, and
    /// lift. XCTest-synthesized presses share the injection pipeline that
    /// simulator input outages break — the runner acks the press but the app
    /// never receives it (and the synthesis IPC has been observed wedging for
    /// minutes) — while HID events enter below XCTest. Returns false — caller
    /// falls back to the agent route — when the active device isn't an iOS
    /// simulator, the helper is unavailable, element resolution fails, or an
    /// injection fails.
    #[cfg(target_os = "macos")]
    async fn try_hid_long_press(
        &self,
        selector: &Value,
        timeout_ms: u64,
        duration_ms: u64,
    ) -> bool {
        let udid = {
            let dm = self.device_manager.read().await;
            match dm.active_device() {
                Some(d) if d.platform == Platform::Ios && d.is_emulator => d.serial.clone(),
                _ => return false,
            }
        };
        if let Err(e) = self.hid_injector.ensure(&udid).await {
            debug!(%udid, error = %e, "iOS HID helper unavailable for long-press; using agent route");
            return false;
        }
        let find = AgentCommand::FindElement {
            selector: selector.clone(),
            timeout_ms: opt_timeout(timeout_ms),
        };
        let resp = match self
            .send_agent_command_with_timeout(&find, timeout_ms)
            .await
        {
            Ok(r) if r.success => r,
            _ => return false,
        };
        let Some(info) = parse_element_info(&resp.data) else {
            return false;
        };
        let Some(bounds) = info.bounds else {
            return false;
        };
        let x = (bounds.left + bounds.right) / 2;
        let y = (bounds.top + bounds.bottom) / 2;
        self.hid_long_press_at(&udid, x as f32, y as f32, duration_ms)
            .await
    }

    /// Coordinate-addressed variant of [`try_hid_long_press`]: same device
    /// and helper gating, no element resolution.
    #[cfg(target_os = "macos")]
    async fn try_hid_long_press_coords(&self, x: f32, y: f32, duration_ms: u64) -> bool {
        // Client-supplied floats: `strtod` in the helper happily parses a
        // formatted "NaN"/"inf", which would poison the injection math —
        // route non-finite coordinates to the agent, which validates them.
        if !x.is_finite() || !y.is_finite() {
            return false;
        }
        let udid = {
            let dm = self.device_manager.read().await;
            match dm.active_device() {
                Some(d) if d.platform == Platform::Ios && d.is_emulator => d.serial.clone(),
                _ => return false,
            }
        };
        if let Err(e) = self.hid_injector.ensure(&udid).await {
            debug!(%udid, error = %e, "iOS HID helper unavailable for long-press; using agent route");
            return false;
        }
        self.hid_long_press_at(&udid, x, y, duration_ms).await
    }

    /// Inject down / hold / up through the HID helper. The helper consumes
    /// stdin lines sequentially, so the up can never overtake the down and
    /// the daemon-side sleep bounds the hold from BELOW — host scheduling
    /// jank can only stretch it, and a long press has no upper bound (unlike
    /// the double-tap gap, which is why `t2` is paced in-process instead).
    /// No move event between down and up: a move can cancel the press
    /// recognizer state in React Native's Pressability.
    #[cfg(target_os = "macos")]
    async fn hid_long_press_at(&self, udid: &str, x: f32, y: f32, duration_ms: u64) -> bool {
        let hold =
            std::time::Duration::from_millis(if duration_ms == 0 { 1000 } else { duration_ms });
        if self
            .hid_injector
            .send(udid, &format!("d {x} {y}"))
            .await
            .is_err()
        {
            return false;
        }
        tokio::time::sleep(hold).await;
        if self
            .hid_injector
            .send(udid, &format!("u {x} {y}"))
            .await
            .is_err()
        {
            // The down already landed; cancel it best-effort so the app isn't
            // left with a stuck touch before the agent-route fallback presses
            // again cleanly.
            let _ = self.hid_injector.send(udid, "c").await;
            return false;
        }
        info!(%udid, x, y, duration_ms, "long-press injected via HID");
        true
    }

    /// Build a synthetic success ActionResponse (used when a touch event was
    /// handled out-of-band by the HID injector, bypassing the agent).
    #[allow(clippy::result_large_err)] // Status is tonic's standard error type
    fn hid_ok_response(request_id: String) -> Result<Response<proto::ActionResponse>, Status> {
        Ok(Response::new(proto::ActionResponse {
            request_id,
            success: true,
            error_type: String::new(),
            error_message: String::new(),
            screenshot: Vec::new(),
        }))
    }
}

/// Convert a protobuf Selector into a JSON value for the agent protocol.
pub(crate) fn selector_to_json(selector: &proto::Selector) -> Value {
    let mut obj = json!({});

    if let Some(ref sel) = selector.selector {
        match sel {
            proto::selector::Selector::Role(role_sel) => {
                obj["role"] = json!({
                    "role": role_sel.role,
                    "name": role_sel.name,
                });
                if let Some(checked) = role_sel.checked {
                    obj["checked"] = json!(checked);
                }
                if let Some(disabled) = role_sel.disabled {
                    obj["enabled"] = json!(!disabled);
                }
                if let Some(selected) = role_sel.selected {
                    obj["selected"] = json!(selected);
                }
                if let Some(expanded) = role_sel.expanded {
                    obj["expanded"] = json!(expanded);
                }
            }
            proto::selector::Selector::Text(t) => {
                obj["text"] = json!(t);
            }
            proto::selector::Selector::TextContains(t) => {
                obj["textContains"] = json!(t);
            }
            proto::selector::Selector::ContentDesc(t) => {
                obj["contentDesc"] = json!(t);
            }
            proto::selector::Selector::Hint(t) => {
                obj["hint"] = json!(t);
            }
            proto::selector::Selector::ClassName(t) => {
                obj["className"] = json!(t);
            }
            proto::selector::Selector::TestId(t) => {
                obj["testId"] = json!(t);
            }
            proto::selector::Selector::ResourceId(t) => {
                obj["resourceId"] = json!(t);
            }
            proto::selector::Selector::Xpath(t) => {
                obj["xpath"] = json!(t);
            }
            proto::selector::Selector::Label(t) => {
                obj["label"] = json!(t);
            }
        }
    }

    if let Some(ref parent) = selector.parent {
        obj["parent"] = selector_to_json(parent);
    }

    obj
}

pub(crate) fn opt_timeout(ms: u64) -> Option<u64> {
    if ms > 0 {
        Some(ms)
    } else {
        None
    }
}

/// Resolve an element-targeting action's request into the (selector_json,
/// element_id) pair the AgentCommand needs. When `element_id` is non-empty the
/// agent acts on that exact previously-found element (how positional/filtered
/// handles target the element they resolved); otherwise it finds by selector.
/// At least one of the two must be provided.
#[allow(clippy::result_large_err)] // Status is tonic's standard error type
pub(crate) fn action_target(
    selector: Option<&proto::Selector>,
    element_id: &str,
) -> Result<(Value, Option<String>), Status> {
    let element_id = (!element_id.is_empty()).then(|| element_id.to_string());
    match (selector, element_id) {
        (Some(sel), eid) => Ok((selector_to_json(sel), eid)),
        (None, Some(eid)) => Ok((json!({}), Some(eid))),
        (None, None) => Err(Status::invalid_argument(
            "selector or element_id is required",
        )),
    }
}

/// Extract the reserved keychain member from an app-state archive and swap
/// it into the simulator's device-level keychain (restarting securityd so
/// the swapped db is picked up).
async fn restore_simulator_keychain(udid: &str, container: &str, archive_path: &str) -> Result<()> {
    use anyhow::{bail, Context};

    let keychain_dir = ios::device::simulator_keychain_dir(container).ok_or_else(|| {
        anyhow::anyhow!("Could not derive simulator keychain dir from container path {container}")
    })?;
    let scratch = tempfile::tempdir().context("Failed to create keychain scratch dir")?;
    // We write the member as `./.tapsmith-keychain` on save, but tolerate the
    // bare form too so detection, exclusion, and extraction stay consistent
    // regardless of how the archive recorded it. Pass the scratch path as a
    // Path (not a lossy string) so non-UTF-8 temp dirs work.
    let bare = ios::device::KEYCHAIN_ARCHIVE_MEMBER;
    let mut out = tokio::process::Command::new("tar")
        .arg("xzf")
        .arg(archive_path)
        .arg("-C")
        .arg(scratch.path())
        .arg(format!("./{bare}"))
        .output()
        .await
        .context("Failed to run tar")?;
    if !out.status.success() {
        out = tokio::process::Command::new("tar")
            .arg("xzf")
            .arg(archive_path)
            .arg("-C")
            .arg(scratch.path())
            .arg(bare)
            .output()
            .await
            .context("Failed to run tar")?;
    }
    if !out.status.success() {
        bail!(
            "tar extract of keychain member failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let src_dir = scratch.path().join(ios::device::KEYCHAIN_ARCHIVE_MEMBER);
    ios::device::swap_keychain_files(udid, &keychain_dir, &src_dir).await
}

#[tonic::async_trait]
impl proto::tapsmith_service_server::TapsmithService for TapsmithServiceImpl {
    #[instrument(skip_all, fields(request_id))]
    async fn find_element(
        &self,
        request: Request<proto::FindElementRequest>,
    ) -> Result<Response<proto::FindElementResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::FindElement {
            selector: selector_to_json(selector),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;

        match result {
            Ok(resp) if resp.success => {
                let element = parse_element_info(&resp.data);
                Ok(Response::new(proto::FindElementResponse {
                    request_id,
                    found: true,
                    element,
                    error_message: String::new(),
                }))
            }
            Ok(resp) => Ok(Response::new(proto::FindElementResponse {
                request_id,
                found: false,
                element: None,
                error_message: resp
                    .error
                    .unwrap_or_else(|| "Element not found".to_string()),
            })),
            Err(status) => Ok(Response::new(proto::FindElementResponse {
                request_id,
                found: false,
                element: None,
                error_message: status.message().to_string(),
            })),
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn find_elements(
        &self,
        request: Request<proto::FindElementsRequest>,
    ) -> Result<Response<proto::FindElementsResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::FindElements {
            selector: selector_to_json(selector),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;

        match result {
            Ok(resp) if resp.success => {
                let elements = parse_element_list(&resp.data);
                Ok(Response::new(proto::FindElementsResponse {
                    request_id,
                    elements,
                    error_message: String::new(),
                }))
            }
            Ok(resp) => Ok(Response::new(proto::FindElementsResponse {
                request_id,
                elements: Vec::new(),
                error_message: resp.error.unwrap_or_default(),
            })),
            Err(status) => Ok(Response::new(proto::FindElementsResponse {
                request_id,
                elements: Vec::new(),
                error_message: status.message().to_string(),
            })),
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn tap(
        &self,
        request: Request<proto::TapRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let (selector, element_id) = action_target(req.selector.as_ref(), &req.element_id)?;

        let command = AgentCommand::Tap {
            selector,
            timeout_ms: opt_timeout(req.timeout_ms),
            element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn long_press(
        &self,
        request: Request<proto::LongPressRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let (selector, element_id) = action_target(req.selector.as_ref(), &req.element_id)?;

        // iOS simulators: prefer real HID input for the press when the helper
        // is available. XCTest-synthesized presses are acked by the runner but
        // silently dropped during simulator input-injection outages (observed
        // on loaded CI runners even straight after a simulator reboot), and
        // the synthesis IPC can wedge for minutes. Selector-addressed targets
        // only — cached-element-id bounds are agent-internal; those (and any
        // HID failure) fall through to the agent route.
        #[cfg(target_os = "macos")]
        if element_id.is_none()
            && self
                .try_hid_long_press(&selector, req.timeout_ms, req.duration_ms)
                .await
        {
            return Ok(Self::success_action_response(request_id));
        }

        let command = AgentCommand::LongPress {
            selector,
            duration_ms: opt_timeout(req.duration_ms),
            timeout_ms: opt_timeout(req.timeout_ms),
            element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn type_text(
        &self,
        request: Request<proto::TypeTextRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let (selector, element_id) = action_target(req.selector.as_ref(), &req.element_id)?;

        let command = AgentCommand::TypeText {
            selector,
            text: req.text,
            timeout_ms: opt_timeout(req.timeout_ms),
            typing_delay_ms: if req.typing_delay_ms > 0 {
                Some(req.typing_delay_ms)
            } else {
                None
            },
            element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn clear_text(
        &self,
        request: Request<proto::ClearTextRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let (selector, element_id) = action_target(req.selector.as_ref(), &req.element_id)?;

        let command = AgentCommand::ClearText {
            selector,
            timeout_ms: opt_timeout(req.timeout_ms),
            element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn clear_and_type(
        &self,
        request: Request<proto::ClearAndTypeRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let (sel_json, element_id) = action_target(req.selector.as_ref(), &req.element_id)?;

        // Track elapsed time so the type phase uses only the remaining budget
        // instead of the full user timeout (which would double the wall-clock).
        let start = std::time::Instant::now();

        // Clear first, then type
        let clear_cmd = AgentCommand::ClearText {
            selector: sel_json.clone(),
            timeout_ms: opt_timeout(req.timeout_ms),
            element_id: element_id.clone(),
        };

        let clear_result = self
            .send_agent_command_with_timeout(&clear_cmd, req.timeout_ms)
            .await;

        if let Err(e) = &clear_result {
            return self.make_action_response(request_id, Err(e.clone())).await;
        }

        if let Ok(ref resp) = clear_result {
            if !resp.success {
                return self.make_action_response(request_id, clear_result).await;
            }
        }

        let elapsed_ms = start.elapsed().as_millis() as u64;
        let remaining_ms = req.timeout_ms.saturating_sub(elapsed_ms).max(1000);

        let type_cmd = AgentCommand::TypeText {
            selector: sel_json,
            text: req.text,
            timeout_ms: opt_timeout(remaining_ms),
            typing_delay_ms: if req.typing_delay_ms > 0 {
                Some(req.typing_delay_ms)
            } else {
                None
            },
            element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&type_cmd, remaining_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn swipe(
        &self,
        request: Request<proto::SwipeRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let start_element = req.start_element.as_ref().map(selector_to_json);

        let command = AgentCommand::Swipe {
            direction: req.direction,
            start_element,
            speed: if req.speed > 0.0 {
                Some(req.speed)
            } else {
                None
            },
            distance: if req.distance > 0.0 {
                Some(req.distance)
            } else {
                None
            },
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn scroll(
        &self,
        request: Request<proto::ScrollRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let container = req.container.as_ref().map(selector_to_json);
        let scroll_until_visible = req.scroll_until_visible.as_ref().map(selector_to_json);

        let command = AgentCommand::Scroll {
            container,
            direction: req.direction,
            scroll_until_visible,
            distance: if req.distance > 0.0 {
                Some(req.distance)
            } else {
                None
            },
            timeout_ms: opt_timeout(req.timeout_ms),
            element_id: (!req.element_id.is_empty()).then_some(req.element_id),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn press_key(
        &self,
        request: Request<proto::PressKeyRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let command = AgentCommand::PressKey { key: req.key };

        let result = self.send_agent_command(&command).await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn take_screenshot(
        &self,
        request: Request<proto::ScreenshotRequest>,
    ) -> Result<Response<proto::ScreenshotResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;

        // On iOS, route through the agent (XCUIScreen.main.screenshot()) which
        // is much faster than spawning `xcrun simctl io screenshot` per call.
        if platform == Platform::Ios {
            let command = AgentCommand::Screenshot {};
            // Use a short timeout — screenshots are best-effort for tracing
            // and should not block for 30s if the agent is busy.
            match self.send_agent_command_with_timeout(&command, 5000).await {
                Ok(resp) if resp.success => {
                    let b64_str = resp.data.get("data").and_then(|v| v.as_str()).unwrap_or("");
                    use base64::Engine;
                    match base64::engine::general_purpose::STANDARD.decode(b64_str) {
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
                            error_message: format!("Failed to decode screenshot data: {e}"),
                        })),
                    }
                }
                Ok(resp) => Ok(Response::new(proto::ScreenshotResponse {
                    request_id,
                    success: false,
                    data: Vec::new(),
                    error_message: resp
                        .error
                        .unwrap_or_else(|| "Screenshot failed".to_string()),
                })),
                Err(status) => Ok(Response::new(proto::ScreenshotResponse {
                    request_id,
                    success: false,
                    data: Vec::new(),
                    error_message: status.message().to_string(),
                })),
            }
        } else {
            let serial = self.active_serial().await?;
            match screenshot::capture(&serial, platform).await {
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
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_ui_hierarchy(
        &self,
        request: Request<proto::UiHierarchyRequest>,
    ) -> Result<Response<proto::UiHierarchyResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let command = AgentCommand::GetUiHierarchy {};

        match self.send_agent_command(&command).await {
            Ok(resp) if resp.success => {
                let xml = resp
                    .data
                    .get("hierarchy")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                Ok(Response::new(proto::UiHierarchyResponse {
                    request_id,
                    hierarchy_xml: xml,
                    error_message: String::new(),
                }))
            }
            Ok(resp) => Ok(Response::new(proto::UiHierarchyResponse {
                request_id,
                hierarchy_xml: String::new(),
                error_message: resp.error.unwrap_or_default(),
            })),
            Err(status) => Ok(Response::new(proto::UiHierarchyResponse {
                request_id,
                hierarchy_xml: String::new(),
                error_message: status.message().to_string(),
            })),
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn capture_trace_state(
        &self,
        request: Request<proto::CaptureTraceStateRequest>,
    ) -> Result<Response<proto::CaptureTraceStateResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector_json = req.element_selector.as_ref().map(selector_to_json);

        let command = AgentCommand::CaptureTraceState {
            screenshot: req.screenshot,
            hierarchy: req.hierarchy,
            selector: selector_json,
        };

        match self.send_agent_command_with_timeout(&command, 5000).await {
            Ok(resp) if resp.success => {
                let screenshot_data = resp
                    .data
                    .get("screenshotData")
                    .and_then(|v| v.as_str())
                    .map(|b64| {
                        use base64::Engine;
                        base64::engine::general_purpose::STANDARD
                            .decode(b64)
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();

                let hierarchy_xml = resp
                    .data
                    .get("hierarchyXml")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let element_found = resp
                    .data
                    .get("elementFound")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let element = if element_found {
                    resp.data.get("element").and_then(parse_element_info)
                } else {
                    None
                };

                Ok(Response::new(proto::CaptureTraceStateResponse {
                    request_id,
                    success: true,
                    error_message: String::new(),
                    screenshot_data,
                    hierarchy_xml,
                    element_found,
                    element,
                }))
            }
            Ok(resp) => Ok(Response::new(proto::CaptureTraceStateResponse {
                request_id,
                success: false,
                error_message: resp.error.unwrap_or_default(),
                screenshot_data: Vec::new(),
                hierarchy_xml: String::new(),
                element_found: false,
                element: None,
            })),
            Err(status) => Ok(Response::new(proto::CaptureTraceStateResponse {
                request_id,
                success: false,
                error_message: status.message().to_string(),
                screenshot_data: Vec::new(),
                hierarchy_xml: String::new(),
                element_found: false,
                element: None,
            })),
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn wait_for_idle(
        &self,
        request: Request<proto::WaitForIdleRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let command = AgentCommand::WaitForIdle {
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn install_apk(
        &self,
        request: Request<proto::InstallApkRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let serial = self.active_serial().await?;

        info!(apk_path = %req.apk_path, "Installing APK");

        // No signature-mismatch auto-recovery here: this RPC installs user
        // apps, and the recovery path uninstalls the existing package (wiping
        // its app data) — too destructive to do silently on someone's app.
        match adb::install_apk(&serial, &req.apk_path, false).await {
            Ok(()) => Ok(Response::new(proto::ActionResponse {
                request_id,
                success: true,
                error_type: String::new(),
                error_message: String::new(),
                screenshot: Vec::new(),
            })),
            Err(e) => {
                error!(error = %e, "APK installation failed");
                let screenshot = self.error_screenshot().await;
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "INSTALL_FAILED".to_string(),
                    error_message: e.to_string(),
                    screenshot,
                }))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn list_devices(
        &self,
        request: Request<proto::ListDevicesRequest>,
    ) -> Result<Response<proto::ListDevicesResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let mut dm = self.device_manager.write().await;
        dm.refresh()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        let devices = dm
            .devices()
            .iter()
            .map(|d| proto::DeviceInfo {
                serial: d.serial.clone(),
                model: d.model.clone(),
                state: format!("{:?}", d.state),
                is_emulator: d.is_emulator,
                platform: d.platform.as_str().to_string(),
                os_version: d.os_version.clone(),
            })
            .collect();

        Ok(Response::new(proto::ListDevicesResponse {
            request_id,
            devices,
        }))
    }

    #[instrument(skip_all, fields(request_id))]
    async fn set_device(
        &self,
        request: Request<proto::SetDeviceRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let mut dm = self.device_manager.write().await;

        // Refresh to make sure the device is known
        dm.refresh()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        // Capture the previously-active serial so we can release stale
        // per-device session state once the active device switches.
        let previous_serial = dm.active_serial().map(String::from);
        let device_changed = previous_serial.as_deref() != Some(req.serial.as_str());

        match dm.set_active(&req.serial) {
            Ok(()) => {
                // Drop the device_manager lock before the async pre-start so
                // ensure_ios_physical_proxy can acquire its own locks without
                // deadlocking against our write guard.
                drop(dm);
                // Best-effort: shut down the HID helper for the device we just
                // switched away from (no-op if there wasn't one). The helper
                // also dies via kill_on_drop on daemon exit.
                #[cfg(target_os = "macos")]
                if device_changed {
                    if let Some(prev) = previous_serial.as_deref() {
                        self.hid_injector.shutdown(prev).await;
                    }
                }
                if device_changed {
                    self.cleanup_network_proxy().await;
                    *self.started_agent_config.write().await = None;
                    *self.ios_agent_config.write().await = None;
                    *self.android_launcher_activity.write().await = None;
                    *self.reset_policy.write().await = app_reset::ResetPolicyState::default();
                    *self.last_hooks_marker.write().await = None;
                    *self.nav_probe_found_no_marker.write().await = false;
                    // Drop the previous device's pre-installed CA marker so the
                    // Android CA pre-install below runs for the newly-selected
                    // device rather than short-circuiting on stale state. The
                    // active device can change within a daemon's lifetime (e.g.
                    // UI mode switching between devices).
                    *self.proxy_ca_cert_path.write().await = None;
                }
                agent_comms::clear_stream_cache(&self.agent_stream).await;
                // Persist the CLI's tracing flag on the server so subsequent
                // call sites (start_agent, recovery restarts) can check it
                // without re-plumbing the bool through every request. The
                // CLI is authoritative — it derives this from tapsmith.config.ts.
                *self.network_tracing_enabled.write().await = req.network_tracing_enabled;
                // Persist the passthrough-host globs (PILOT-231) and push
                // them into the live proxy if one is already running —
                // otherwise the next proxy start picks them up. Platform-
                // independent: simulators, Android, and physical iOS all
                // honor SNI-based passthrough.
                *self.passthrough_hosts.write().await = req.passthrough_hosts.clone();
                // Re-derive the embedded-root defaults here too: this is the
                // point where the active device (and so the platform) can
                // change under a proxy that is already running — UI mode
                // switching between an iOS simulator and an emulator.
                let embedded_root_defaults = self.embedded_root_defaults().await;
                if let Some(proxy) = self.network_proxy.read().await.as_ref() {
                    proxy
                        .set_passthrough_hosts(
                            req.passthrough_hosts.clone(),
                            embedded_root_defaults,
                        )
                        .await;
                }
                // For physical iOS with tracing enabled, pre-start the Wi-Fi
                // MITM proxy immediately so any subsequent devicectl install
                // / launch / xcodebuild invocation can't race the phone's
                // OCSP check (which routes through the Wi-Fi proxy port on
                // the Mac). When tracing is off, iOS has no reason to route
                // through our proxy at all, so we skip the pre-start entirely
                // — this is the single biggest basic-track failure reduction.
                #[cfg(target_os = "macos")]
                if req.network_tracing_enabled && self.is_active_ios_physical().await {
                    self.ensure_ios_physical_proxy(&req.serial).await;
                    // Push the current trace.networkHosts allowlist into
                    // the live proxy so the next `/tapsmith.pac` fetch from
                    // iOS reflects the user's tapsmith.config.ts exactly.
                    // Safe to call while the proxy is serving traffic.
                    if let Some(proxy) = self.network_proxy.read().await.as_ref() {
                        proxy.set_network_hosts(req.network_hosts.clone()).await;
                    }
                }
                // Symmetric to the iOS pre-arm above: for Android with tracing
                // enabled, install the MITM CA now — during setup, before the
                // first app launch — so the app under test forks from a zygote
                // that already trusts the cert (Android 14+ injects into the
                // zygote mount namespace, which only future forks inherit). This
                // is what spares the first HTTPS request on a freshly-booted
                // device. See `ensure_android_ca_installed`.
                if req.network_tracing_enabled
                    && self.active_platform().await == Some(Platform::Android)
                {
                    self.ensure_android_ca_installed(&req.serial).await;
                }
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: true,
                    error_type: String::new(),
                    error_message: String::new(),
                    screenshot: Vec::new(),
                }))
            }
            Err(e) => Ok(Response::new(proto::ActionResponse {
                request_id,
                success: false,
                error_type: "DEVICE_NOT_FOUND".to_string(),
                error_message: e.to_string(),
                screenshot: Vec::new(),
            })),
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn start_agent(
        &self,
        request: Request<proto::StartAgentRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let serial = self.active_serial().await?;
        let platform = self.require_platform().await?;

        info!(serial = %serial, %platform, "Starting agent connection");

        info!(ios_xctestrun_path = %req.ios_xctestrun_path, "StartAgent fields");

        if platform == Platform::Ios && req.ios_xctestrun_path.is_empty() {
            return Ok(Response::new(proto::ActionResponse {
                request_id,
                success: false,
                error_type: "AGENT_NOT_CONFIGURED".to_string(),
                error_message: "iOS agent not configured. \
                    Set iosXctestrun in your tapsmith config."
                    .to_string(),
                screenshot: Vec::new(),
            }));
        }

        let desired_agent_config =
            StartedAgentConfig::from_start_agent_request(&serial, platform, &req);

        // Re-affirm the server-wide tracing flag before any reuse decision.
        // SetDevice is the primary setter, but StartAgent is called in the
        // same RPC sequence and may be invoked by future clients directly.
        *self.network_tracing_enabled.write().await = req.network_tracing_enabled;

        if self.can_reuse_started_agent(&desired_agent_config).await {
            #[cfg(target_os = "macos")]
            if platform == Platform::Ios
                && req.network_tracing_enabled
                && self.is_active_ios_physical().await
            {
                self.ensure_ios_physical_proxy(&serial).await;
            }

            info!(serial = %serial, %platform, "Reusing existing agent connection");
            return Ok(Self::success_action_response(request_id));
        }

        *self.started_agent_config.write().await = None;
        *self.android_launcher_activity.write().await = None;
        // A fresh agent session starts a fresh warm window.
        *self.reset_policy.write().await = app_reset::ResetPolicyState::default();
        *self.last_hooks_marker.write().await = None;
        *self.nav_probe_found_no_marker.write().await = false;

        match platform {
            Platform::Ios => {
                // ─── iOS: launch XCUITest agent ───
                let is_physical = self.is_active_ios_physical().await;

                // Apply test-friendly defaults every time the agent starts,
                // not just on first boot — reused simulators may have stale config.
                // Skipped entirely on physical devices: the simctl spawns
                // would fail, and the device's defaults are user-owned anyway.
                if !is_physical {
                    ios::device::configure_simulator(&serial).await;
                }

                // Drop any prior iproxy tunnel BEFORE start_agent so the
                // existing host port is free when start_agent tries to bind
                // a fresh tunnel. Without this, a re-started agent on the
                // same physical device would fight its own leftover tunnel.
                agent_comms::clear_stream_cache(&self.agent_stream).await;
                *self.ios_iproxy.write().await = None;

                // Re-affirm the server-wide tracing flag. SetDevice is the
                // primary setter, but StartAgent is called in the same RPC
                // sequence — keeping both in sync is defensive against
                // future clients that skip set_device.
                *self.network_tracing_enabled.write().await = req.network_tracing_enabled;

                // Pre-start the Wi-Fi MITM proxy for physical iOS devices
                // with tracing enabled. Idempotent — skipped if already
                // bound (typically from set_device). Re-primes when prior
                // test's stop_network_capture tore the listener down. When
                // tracing is off, skipped entirely (see SetDevice for why).
                #[cfg(target_os = "macos")]
                if is_physical && req.network_tracing_enabled {
                    self.ensure_ios_physical_proxy(&serial).await;
                }

                // PILOT-245: before the agent launches the target app, force
                // gRPC-Core onto the native resolver. Its c-ares resolver emits
                // UDP DNS from the app process, which the TCP-only redirector
                // cannot proxy.
                #[cfg(target_os = "macos")]
                if !is_physical && req.network_tracing_enabled {
                    ios::device::prepare_grpc_trust(&serial, &req.target_package).await;
                }

                let agent_port = self.agent.read().await.port();
                let iproxy_handle = match ios::agent_launch::start_agent(
                    &serial,
                    &req.ios_xctestrun_path,
                    &req.target_package,
                    agent_port,
                    is_physical,
                )
                .await
                {
                    Ok(handle) => handle,
                    Err(e) => {
                        error!(error = %e, "Failed to start iOS agent");
                        return Ok(Response::new(proto::ActionResponse {
                            request_id,
                            success: false,
                            error_type: "AGENT_START_FAILED".to_string(),
                            error_message: e.to_string(),
                            screenshot: Vec::new(),
                        }));
                    }
                };
                if let Some(handle) = iproxy_handle {
                    *self.ios_iproxy.write().await = Some(handle);
                }

                // Store config for potential agent restart in launchApp
                *self.ios_agent_config.write().await = Some(IosAgentConfig {
                    xctestrun_path: req.ios_xctestrun_path.clone(),
                    target_package: req.target_package.clone(),
                    app_path: (!req.ios_app_path.is_empty()).then(|| req.ios_app_path.clone()),
                });
            }
            Platform::Android => {
                // ─── Android: install APKs and launch instrumentation ───
                if let Err(e) = adb::wait_for_device_ready(&serial, Duration::from_secs(45)).await {
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "DEVICE_NOT_READY".to_string(),
                        error_message: format!(
                            "Android device was not ready before starting agent: {e}"
                        ),
                        screenshot: Vec::new(),
                    }));
                }

                let has_apk_paths =
                    !req.agent_apk_path.is_empty() && !req.agent_test_apk_path.is_empty();
                let agent_installed = adb::is_package_installed(&serial, "dev.tapsmith.agent")
                    .await
                    .unwrap_or(false);

                if !agent_installed && !has_apk_paths {
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "AGENT_NOT_INSTALLED".to_string(),
                        error_message: "Tapsmith agent is not installed on the device. \
                            Set agentApk and agentTestApk in your tapsmith config, \
                            or install manually with: adb install <path-to-agent.apk>"
                            .to_string(),
                        screenshot: Vec::new(),
                    }));
                }

                // Always reinstall when APK paths are provided so that code
                // changes to the agent are deployed without manual intervention.
                if has_apk_paths {
                    info!("Installing agent APKs...");
                    if let Err(e) = adb::install_apk(&serial, &req.agent_apk_path, true).await {
                        return Ok(Response::new(proto::ActionResponse {
                            request_id,
                            success: false,
                            error_type: "AGENT_INSTALL_FAILED".to_string(),
                            error_message: format!("Failed to install agent APK: {e}"),
                            screenshot: Vec::new(),
                        }));
                    }
                    if let Err(e) = adb::install_apk(&serial, &req.agent_test_apk_path, true).await
                    {
                        return Ok(Response::new(proto::ActionResponse {
                            request_id,
                            success: false,
                            error_type: "AGENT_INSTALL_FAILED".to_string(),
                            error_message: format!("Failed to install agent test APK: {e}"),
                            screenshot: Vec::new(),
                        }));
                    }
                    info!("Agent APKs installed successfully");
                }

                // Launch the agent instrumentation
                agent_comms::clear_stream_cache(&self.agent_stream).await;
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
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "AGENT_START_FAILED".to_string(),
                        error_message: e.to_string(),
                        screenshot: Vec::new(),
                    }));
                }
            }
        }

        // Connect to the agent (iOS: direct TCP, Android: via ADB port forward)
        let mut agent = self.agent.write().await;
        let connect_result = match platform {
            Platform::Ios => agent.connect_ios(&serial).await,
            // The instrumentation was launched just above. Wait for it to
            // actually answer: through the forwarded port a bare connect
            // succeeds before (or without) the agent ever listening.
            Platform::Android => {
                agent
                    .connect_android_with_readiness(&serial, ANDROID_AGENT_START_READINESS)
                    .await
            }
        };
        match connect_result {
            Ok(()) => {
                // Best-effort pre-warm of the app-container cache while
                // CoreSimulator is (presumably) healthy: if it wedges later
                // in the session, app-state save/clear fall back to this
                // resolved path instead of failing on a timed-out lookup.
                if platform == Platform::Ios
                    && !self.is_active_ios_physical().await
                    && !desired_agent_config.target_package.is_empty()
                {
                    let cache = self.ios_app_container_cache.clone();
                    let serial_c = serial.clone();
                    let pkg = desired_agent_config.target_package.clone();
                    tokio::spawn(async move {
                        if let Ok(path) = ios::device::get_app_container(&serial_c, &pkg).await {
                            cache
                                .write()
                                .await
                                .insert(format!("{serial_c}\u{0}{pkg}"), path);
                        }
                    });
                }
                // Resolve and cache the Android launcher activity now, while
                // the device is calm, so every later clean-task relaunch (the
                // restart/clear reset rungs) can discard saved instance state
                // without depending on a `resolve-activity` call landing under
                // load. `pm clear` wipes app data but NOT the ActivityManager
                // task record, so a relaunch that can't clear the task brings
                // back the old route and scroll position.
                if matches!(self.require_platform().await, Ok(Platform::Android))
                    && !desired_agent_config.target_package.is_empty()
                {
                    if let Ok(serial) = self.active_serial().await {
                        let activity = self
                            .resolve_launcher_activity(
                                &serial,
                                &desired_agent_config.target_package,
                            )
                            .await
                            .ok()
                            .flatten();
                        *self.android_launcher_activity.write().await = activity;
                    }
                }
                *self.started_agent_config.write().await = Some(desired_agent_config);
                Ok(Self::success_action_response(request_id))
            }
            Err(e) => {
                error!(error = %e, "Failed to connect to agent");
                let platform = self.require_platform().await?;
                let mut error_message = e.to_string();
                if platform == Platform::Android {
                    error_message.push_str(&android_agent_start_diagnostics(&serial).await);
                }
                let screenshot = screenshot::capture_for_error(Some(&serial), platform).await;
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "AGENT_CONNECTION_FAILED".to_string(),
                    error_message,
                    screenshot,
                }))
            }
        }
    }

    async fn ping(
        &self,
        _request: Request<proto::PingRequest>,
    ) -> Result<Response<proto::PingResponse>, Status> {
        let agent_connected = self.agent.read().await.is_connected();

        Ok(Response::new(proto::PingResponse {
            version: env!("CARGO_PKG_VERSION").to_string(),
            agent_connected,
        }))
    }

    // ── Element Actions (PILOT-2) ──

    #[instrument(skip_all, fields(request_id))]
    async fn double_tap(
        &self,
        request: Request<proto::DoubleTapRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let (selector, element_id) = action_target(req.selector.as_ref(), &req.element_id)?;

        // iOS simulators: prefer real HID input for the double-tap when the
        // helper is available. Newer iOS 26.x runtime builds coalesce rapid
        // synthesized taps from EVERY XCTest-level route — private
        // XCSynthesizedEventRecord synthesis, sequential records at 250ms+
        // gaps, offset second taps, and the public XCUICoordinate.doubleTap()
        // alike (verified empirically on iOS 26.5: the app receives exactly
        // one tap). HID events enter below XCTest and are indistinguishable
        // from real touches, so the pair always arrives. Selector-addressed
        // targets only — cached-element-id bounds are agent-internal; those
        // (and any HID failure) fall through to the agent route.
        #[cfg(target_os = "macos")]
        if element_id.is_none()
            && self
                .try_hid_double_tap(&selector, req.timeout_ms, req.interval_ms)
                .await
        {
            return Ok(Self::success_action_response(request_id));
        }

        let command = AgentCommand::DoubleTap {
            selector,
            timeout_ms: opt_timeout(req.timeout_ms),
            interval_ms: opt_timeout(req.interval_ms),
            element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn drag_and_drop(
        &self,
        request: Request<proto::DragAndDropRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        // Each end is addressed by its cached id (positional/filtered handle) or
        // by selector; require one per end.
        let (source_selector, source_element_id) =
            action_target(req.source_selector.as_ref(), &req.source_element_id).map_err(|_| {
                Status::invalid_argument("source_selector or source_element_id is required")
            })?;
        let (target_selector, target_element_id) =
            action_target(req.target_selector.as_ref(), &req.target_element_id).map_err(|_| {
                Status::invalid_argument("target_selector or target_element_id is required")
            })?;

        let command = AgentCommand::DragAndDrop {
            source_selector,
            target_selector,
            timeout_ms: opt_timeout(req.timeout_ms),
            source_element_id,
            target_element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn select_option(
        &self,
        request: Request<proto::SelectOptionRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let (selector, element_id) = action_target(req.selector.as_ref(), &req.element_id)?;

        let (option, index) = match req.selection {
            Some(proto::select_option_request::Selection::Option(ref opt)) => {
                (Some(opt.clone()), None)
            }
            Some(proto::select_option_request::Selection::Index(idx)) => (None, Some(idx)),
            None => {
                return Err(Status::invalid_argument(
                    "either option or index is required",
                ));
            }
        };

        let command = AgentCommand::SelectOption {
            selector,
            option,
            index,
            timeout_ms: opt_timeout(req.timeout_ms),
            element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn pinch_zoom(
        &self,
        request: Request<proto::PinchZoomRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let (selector, element_id) = action_target(req.selector.as_ref(), &req.element_id)?;

        let command = AgentCommand::PinchZoom {
            selector,
            scale: req.scale,
            timeout_ms: opt_timeout(req.timeout_ms),
            element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn focus(
        &self,
        request: Request<proto::FocusRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let (selector, element_id) = action_target(req.selector.as_ref(), &req.element_id)?;

        let command = AgentCommand::Focus {
            selector,
            timeout_ms: opt_timeout(req.timeout_ms),
            element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn blur(
        &self,
        request: Request<proto::BlurRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let (selector, element_id) = action_target(req.selector.as_ref(), &req.element_id)?;

        let command = AgentCommand::Blur {
            selector,
            timeout_ms: opt_timeout(req.timeout_ms),
            element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn highlight(
        &self,
        request: Request<proto::HighlightRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let (selector, element_id) = action_target(req.selector.as_ref(), &req.element_id)?;

        let command = AgentCommand::Highlight {
            selector,
            duration_ms: opt_timeout(req.duration_ms),
            timeout_ms: opt_timeout(req.timeout_ms),
            element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn take_element_screenshot(
        &self,
        request: Request<proto::TakeElementScreenshotRequest>,
    ) -> Result<Response<proto::ScreenshotResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let (selector, element_id) = action_target(req.selector.as_ref(), &req.element_id)?;

        let command = AgentCommand::TakeElementScreenshot {
            selector,
            timeout_ms: opt_timeout(req.timeout_ms),
            element_id,
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;

        match result {
            Ok(resp) if resp.success => {
                let b64_str = resp.data.get("data").and_then(|v| v.as_str()).unwrap_or("");

                use base64::Engine;
                match base64::engine::general_purpose::STANDARD.decode(b64_str) {
                    Ok(data) => Ok(Response::new(proto::ScreenshotResponse {
                        request_id,
                        success: true,
                        data,
                        error_message: String::new(),
                    })),
                    Err(e) => {
                        error!("Failed to decode element screenshot base64: {e}");
                        Ok(Response::new(proto::ScreenshotResponse {
                            request_id,
                            success: false,
                            data: Vec::new(),
                            error_message: format!("Failed to decode screenshot data: {e}"),
                        }))
                    }
                }
            }
            Ok(resp) => Ok(Response::new(proto::ScreenshotResponse {
                request_id,
                success: false,
                data: Vec::new(),
                error_message: resp
                    .error
                    .unwrap_or_else(|| "Screenshot failed".to_string()),
            })),
            Err(status) => Ok(Response::new(proto::ScreenshotResponse {
                request_id,
                success: false,
                data: Vec::new(),
                error_message: status.message().to_string(),
            })),
        }
    }

    // ── Device Management (PILOT-10) ──

    #[instrument(skip_all, fields(request_id))]
    async fn launch_app(
        &self,
        request: Request<proto::LaunchAppRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let serial = self.active_serial().await?;
        let platform = self.require_platform().await?;

        Self::validate_package_name(&req.package_name)?;

        // A (re)launched process can newly expose the hooks marker (e.g. a
        // reinstalled build) — let the next navigation link re-probe.
        *self.nav_probe_found_no_marker.write().await = false;

        match platform {
            Platform::Ios => {
                let idle_timeout_ms = if req.idle_timeout_ms > 0 {
                    req.idle_timeout_ms
                } else {
                    10000
                };
                let is_physical = self.is_active_ios_physical().await;

                if req.clear_data {
                    if is_physical {
                        // Physical devices have no host-accessible app container
                        // filesystem — `get_app_container` / `clear_container`
                        // are simulator-only hacks. Instead, we rely on the
                        // agent-mediated relaunch below to provide a fresh
                        // launch; to actually wipe persistent state on a
                        // physical device the user must reinstall the app
                        // (future work: wire reinstall via devicectl into
                        // clear_data).
                        warn!(
                            package = %req.package_name,
                            "clear_data on physical iOS device is best-effort: \
                             persistent AsyncStorage/caches are not wiped. \
                             Reinstall the app via `tapsmith test --force-install` \
                             for a clean slate."
                        );
                    } else {
                        // Terminate the app first to avoid file access conflicts
                        // when clearing the data container.
                        let _ = ios::device::terminate_app(&serial, &req.package_name).await;
                        // Clear the data container (AsyncStorage, caches, etc.)
                        // without uninstalling the app.
                        match self
                            .get_app_container_cached(&serial, &req.package_name)
                            .await
                        {
                            Ok(ref container) => {
                                if let Err(e) = ios::device::clear_container(container).await {
                                    warn!(error = %e, "Failed to clear app container");
                                }
                            }
                            Err(e) => {
                                debug!(error = %e, "Could not get app container");
                            }
                        }
                    }
                }

                if let Err(error_message) = self
                    .reset_ios_app(
                        &serial,
                        &req.package_name,
                        req.wait_for_idle,
                        idle_timeout_ms,
                    )
                    .await
                {
                    return Ok(self
                        .action_error(request_id, "LAUNCH_FAILED", error_message)
                        .await);
                }

                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: true,
                    error_type: String::new(),
                    error_message: String::new(),
                    screenshot: Vec::new(),
                }))
            }
            Platform::Android => {
                if !req.activity.is_empty() {
                    Self::validate_activity(&req.activity)?;
                }

                // Clear data first if requested
                if req.clear_data {
                    match adb::shell(&serial, &format!("pm clear {}", req.package_name)).await {
                        Ok(output) if !output.trim().starts_with("Success") => {
                            error!(output = %output.trim(), "pm clear did not report success");
                            let screenshot = self.error_screenshot().await;
                            return Ok(Response::new(proto::ActionResponse {
                                request_id,
                                success: false,
                                error_type: "CLEAR_DATA_FAILED".to_string(),
                                error_message: format!(
                                    "Failed to clear app data: {}",
                                    output.trim()
                                ),
                                screenshot,
                            }));
                        }
                        Err(e) => {
                            error!(error = %e, "Failed to clear app data before launch");
                            let screenshot = self.error_screenshot().await;
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
                    self.launch_package(
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
                    self.launch_and_idle(
                        &serial,
                        request_id,
                        &cmd,
                        req.wait_for_idle,
                        req.idle_timeout_ms,
                    )
                    .await
                }
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn open_deep_link(
        &self,
        request: Request<proto::OpenDeepLinkRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        if req.uri.is_empty() {
            return Err(Status::invalid_argument("uri is required"));
        }

        let delivery = if req.force_cold_launch {
            DeepLinkDelivery::Cold
        } else {
            DeepLinkDelivery::WarmThenCold
        };
        self.deliver_deep_link(request_id, &req.uri, delivery, None, None)
            .await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_current_package(
        &self,
        request: Request<proto::GetCurrentPackageRequest>,
    ) -> Result<Response<proto::GetCurrentPackageResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        let package_name = match platform {
            Platform::Ios => {
                // On iOS, return the target package from agent config
                self.ios_agent_config
                    .read()
                    .await
                    .as_ref()
                    .map(|c| c.target_package.clone())
                    .unwrap_or_default()
            }
            Platform::Android => self
                .get_current_component()
                .await?
                .map(|(pkg, _)| pkg)
                .unwrap_or_default(),
        };

        Ok(Response::new(proto::GetCurrentPackageResponse {
            request_id,
            package_name,
        }))
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_current_activity(
        &self,
        request: Request<proto::GetCurrentActivityRequest>,
    ) -> Result<Response<proto::GetCurrentActivityResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        let activity = match platform {
            Platform::Ios => {
                // Android-only concept — iOS doesn't have activities
                String::new()
            }
            Platform::Android => self
                .get_current_component()
                .await?
                .map(|(_, act)| act)
                .unwrap_or_default(),
        };

        Ok(Response::new(proto::GetCurrentActivityResponse {
            request_id,
            activity,
        }))
    }

    #[instrument(skip_all, fields(request_id))]
    async fn reset_app(
        &self,
        request: Request<proto::ResetAppRequest>,
    ) -> Result<Response<proto::ResetAppResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        Self::validate_package_name(&req.package_name)?;
        let serial = self.active_serial().await?;
        let platform = self.require_platform().await?;
        let is_physical = platform == Platform::Ios && self.is_active_ios_physical().await;
        let idle_timeout_ms = if req.idle_timeout_ms > 0 {
            req.idle_timeout_ms
        } else {
            10_000
        };
        let mode = match proto::AppResetMode::try_from(req.mode) {
            Ok(proto::AppResetMode::Warm) => app_reset::ResetMode::Warm,
            Ok(proto::AppResetMode::Restart) => app_reset::ResetMode::Restart,
            Ok(proto::AppResetMode::Clear) => app_reset::ResetMode::Clear,
            _ => return Err(Status::invalid_argument("mode is required")),
        };
        let started = std::time::Instant::now();

        // The pre-reset hierarchy tells us whether the app advertises in-app
        // reset hooks and what epoch to acknowledge against.
        let mut marker = if mode == app_reset::ResetMode::Warm {
            self.current_hooks_marker(5_000).await
        } else {
            None
        };
        // Why a warm request could not start warm, when the plan's own reason
        // ("exposes no reset hook") would be misleading.
        let mut no_hook_reason: Option<String> = None;
        // Only a marker with a URL prefix is a reset hook. A module that could
        // not determine its scheme still renders a marker (empty `url=`), and
        // remembering that one would make every later reset claim hooks the
        // ladder never uses (the nav-ack path keeps its own copy for `nav`).
        let has_hook = |m: &app_reset::HooksMarker| m.has_reset_hook();
        if mode == app_reset::ResetMode::Warm {
            if marker.as_ref().is_some_and(has_hook) {
                *self.last_hooks_marker.write().await = marker.clone();
            } else {
                let seen_before = self
                    .last_hooks_marker
                    .read()
                    .await
                    .as_ref()
                    .is_some_and(has_hook);
                if seen_before {
                    // Hooks were seen earlier in this session: one missed read
                    // is far more likely a transient hierarchy gap than a
                    // vanished hook. Re-read briefly before giving up on warm.
                    for _ in 0..2 {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        marker = self.current_hooks_marker(5_000).await;
                        if marker.as_ref().is_some_and(has_hook) {
                            *self.last_hooks_marker.write().await = marker.clone();
                            break;
                        }
                    }
                }
                if marker.is_none() && self.app_is_running(&req.package_name).await == Some(false) {
                    no_hook_reason =
                        Some(format!(
                        "warm reset requested but the app is not running (nothing to acknowledge \
                         the hook); {} instead",
                        if req.fallback_to_clear { "cleared" } else { "restarted" }
                    ));
                }
            }
        }
        // The remembered marker only stands in when the live read missed AND
        // the app is (as far as we can tell) still running — a dead app has
        // nothing to acknowledge the hook, and the plan says so instead.
        let remembered =
            if mode == app_reset::ResetMode::Warm && marker.is_none() && no_hook_reason.is_none() {
                self.last_hooks_marker.read().await.clone()
            } else {
                None
            };

        let mut plan = {
            let state = self.reset_policy.read().await;
            app_reset::decide(
                &state,
                &app_reset::PlanInput {
                    mode,
                    marker: marker.as_ref(),
                    remembered_marker: remembered.as_ref(),
                    reset_deep_link: &req.reset_deep_link,
                    force_cold: req.force_cold,
                    cold_every_n: req.cold_every_n_resets,
                    supports_cold_delivery: platform == Platform::Ios && !is_physical,
                    fallback_to_clear: req.fallback_to_clear,
                    allow_fallback: req.allow_fallback,
                },
            )
        };
        // The rungs acknowledge against whichever baseline the plan used: the
        // live marker, or the remembered epoch/boot when the read missed. A
        // marker without a reset hook is dropped here so that the response's
        // `hooks_detected` / `epoch_before` describe what `decide` actually
        // planned — with an empty `url=` the plan is the legacy deep-link rung
        // (or restart/clear), and the SDK must not skip its settle wait or pin
        // the hooks capability on the strength of a marker the ladder ignored.
        let marker = marker.or(remembered).filter(has_hook);
        let epoch_before = marker.as_ref().map(|m| m.epoch).unwrap_or(0);
        if let (Some(reason), app_reset::FirstStep::Restart | app_reset::FirstStep::Clear) =
            (no_hook_reason, &plan.first)
        {
            plan.reason = Some(reason);
        }
        info!(
            %serial, package = %req.package_name, ?mode, first = ?plan.first,
            hooks = marker.is_some(), "app reset planned"
        );

        let ops = ServiceResetOps {
            svc: self,
            serial: serial.clone(),
            package: req.package_name.clone(),
            marker: marker.clone(),
            target_path: if req.target_path.is_empty() {
                "/".to_string()
            } else {
                req.target_path.clone()
            },
            wait_for_idle: req.wait_for_idle,
            idle_timeout_ms,
        };
        let consumes_streak = plan.consumes_warm_failure_streak;
        let outcome = app_reset::run_ladder(&ops, plan, req.allow_fallback).await;

        {
            let mut state = self.reset_policy.write().await;
            if outcome
                .steps
                .iter()
                .any(|s| s.name.starts_with("warm") && !s.ok)
            {
                state.record_warm_failure();
            }
            if outcome.error.is_none() {
                state.record(&outcome);
                if consumes_streak {
                    state.consume_streak_valve();
                }
            }
        }

        let duration_ms = started.elapsed().as_millis() as u64;
        let mode_used = match outcome.mode_used {
            app_reset::ResetMode::Warm => proto::AppResetMode::Warm,
            app_reset::ResetMode::Restart => proto::AppResetMode::Restart,
            app_reset::ResetMode::Clear => proto::AppResetMode::Clear,
        };
        crate::timing::timing_log!(
            "kind=reset name=app_reset mode={:?} used={:?} dur_ms={} ok={} fell_back={} cold={}",
            mode,
            outcome.mode_used,
            duration_ms,
            outcome.error.is_none(),
            outcome.fell_back,
            outcome.cold_launch
        );

        let screenshot = if outcome.error.is_some() {
            self.error_screenshot().await
        } else {
            Vec::new()
        };
        Ok(Response::new(proto::ResetAppResponse {
            request_id,
            success: outcome.error.is_none(),
            error_type: if outcome.error.is_some() {
                "RESET_FAILED".to_string()
            } else {
                String::new()
            },
            error_message: outcome.error.clone().unwrap_or_default(),
            screenshot,
            mode_requested: req.mode,
            mode_used: mode_used as i32,
            fell_back: outcome.fell_back,
            cold_launch: outcome.cold_launch,
            reason: outcome.reason.clone().unwrap_or_default(),
            duration_ms,
            // Session-sticky: a marker seen earlier in this session still
            // proves the app has hooks even when this reset's own read missed
            // it (the SDK demoting `auto` policies off one missed read was
            // silently downgrading whole files to clear resets under load).
            // Only markers with a reset hook count — the deep-link nav probe
            // may have remembered an empty-`url=` marker.
            hooks_detected: marker.is_some()
                || self
                    .last_hooks_marker
                    .read()
                    .await
                    .as_ref()
                    .is_some_and(has_hook),
            epoch_before,
            epoch_after: outcome.epoch_after.unwrap_or(0),
            steps: outcome
                .steps
                .iter()
                .map(|s| proto::ResetStep {
                    name: s.name.clone(),
                    duration_ms: s.duration_ms,
                    ok: s.ok,
                    detail: s.detail.clone(),
                })
                .collect(),
        }))
    }

    #[instrument(skip_all, fields(request_id))]
    async fn restart_app(
        &self,
        request: Request<proto::RestartAppRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let serial = self.active_serial().await?;

        Self::validate_package_name(&req.package_name)?;

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                let idle_timeout_ms = if req.idle_timeout_ms > 0 {
                    req.idle_timeout_ms
                } else {
                    10000
                };

                if let Err(error_message) = self
                    .reset_ios_app(
                        &serial,
                        &req.package_name,
                        req.wait_for_idle,
                        idle_timeout_ms,
                    )
                    .await
                {
                    return Ok(self
                        .action_error(request_id, "LAUNCH_FAILED", error_message)
                        .await);
                }

                Ok(Self::success_action_response(request_id))
            }
            Platform::Android => {
                // Force-stop the app to kill the process and reset all in-memory state.
                if let Err(e) =
                    adb::shell(&serial, &format!("am force-stop {}", req.package_name)).await
                {
                    error!(error = %e, "Failed to force-stop app");
                    let screenshot = self.error_screenshot().await;
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "FORCE_STOP_FAILED".to_string(),
                        error_message: format!("Failed to stop app: {e}"),
                        screenshot,
                    }));
                }

                self.launch_package(
                    &serial,
                    request_id,
                    &req.package_name,
                    req.wait_for_idle,
                    req.idle_timeout_ms,
                )
                .await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn terminate_app(
        &self,
        request: Request<proto::TerminateAppRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        Self::validate_package_name(&req.package_name)?;

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                // Terminate through the XCUITest agent so the runner stays in
                // sync with app state. This prevents the cascading fallback
                // chain in reset_ios_app when the next test calls restartApp.
                // Fall back to simctl terminate if the agent is unreachable.
                let agent_result = self
                    .send_agent_command_with_timeout(
                        &AgentCommand::TerminateApp {
                            package: req.package_name.clone(),
                        },
                        4_000,
                    )
                    .await;

                // Fall back to simctl on transport error AND on agent-reported
                // failure (Ok(resp) where !resp.success). The agent can return
                // a structured failure (e.g. app already gone, XCUI error) that
                // would otherwise be silently swallowed. Physical devices have
                // no simctl fallback — if the agent fails, the app state is
                // indeterminate and we surface the error rather than pretending
                // it worked.
                let needs_fallback = match &agent_result {
                    Err(_) => true,
                    Ok(resp) => !resp.success,
                };
                if needs_fallback {
                    if self.is_active_ios_physical().await {
                        let msg = match &agent_result {
                            Err(status) => status.message().to_string(),
                            Ok(resp) => resp
                                .error
                                .clone()
                                .unwrap_or_else(|| "terminate_app agent path failed".to_string()),
                        };
                        return Ok(self.action_error(request_id, "TERMINATE_FAILED", msg).await);
                    }
                    let serial = self.active_serial().await?;
                    let _ = ios::device::terminate_app(&serial, &req.package_name).await;
                }

                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: true,
                    error_type: String::new(),
                    error_message: String::new(),
                    screenshot: Vec::new(),
                }))
            }
            Platform::Android => {
                let cmd = format!("am force-stop {}", req.package_name);
                self.adb_action(request_id, &cmd).await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_app_state(
        &self,
        request: Request<proto::GetAppStateRequest>,
    ) -> Result<Response<proto::GetAppStateResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        Self::validate_package_name(&req.package_name)?;

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                // Route through the XCUITest agent which can query app state
                let command = AgentCommand::GetAppState {
                    package: req.package_name.clone(),
                };
                let result = self.send_agent_command(&command).await?;
                let state = result
                    .data
                    .get("state")
                    .and_then(|v| v.as_str())
                    .unwrap_or("stopped")
                    .to_string();
                Ok(Response::new(proto::GetAppStateResponse {
                    request_id,
                    state,
                }))
            }
            Platform::Android => {
                let serial = self.active_serial().await?;

                // Check if app is installed
                let installed =
                    adb::shell_lenient(&serial, &format!("pm list packages {}", req.package_name))
                        .await
                        .map_err(|e| Status::internal(e.to_string()))?;

                if !installed.contains(&req.package_name) {
                    return Ok(Response::new(proto::GetAppStateResponse {
                        request_id,
                        state: "not_installed".to_string(),
                    }));
                }

                // Check if app process is running and in foreground
                let resumed = adb::shell_lenient(
                    &serial,
                    "dumpsys activity activities | grep -E 'mResumedActivity|ResumedActivity|topResumedActivity'",
                )
                .await
                .map_err(|e| Status::internal(e.to_string()))?;

                if resumed.contains(&req.package_name) {
                    return Ok(Response::new(proto::GetAppStateResponse {
                        request_id,
                        state: "foreground".to_string(),
                    }));
                }

                // Check if process exists at all
                let procs = adb::shell_lenient(&serial, &format!("pidof {}", req.package_name))
                    .await
                    .map_err(|e| Status::internal(e.to_string()))?;

                let state = if procs.trim().is_empty() {
                    "stopped"
                } else {
                    "background"
                };

                Ok(Response::new(proto::GetAppStateResponse {
                    request_id,
                    state: state.to_string(),
                }))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn clear_app_data(
        &self,
        request: Request<proto::ClearAppDataRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        Self::validate_package_name(&req.package_name)?;

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    // Physical devices have no host-accessible app container
                    // filesystem, so `get_app_container` / `clear_container`
                    // are meaningless. Reinstall the app bundle as the only
                    // reliable way to wipe persistent state on a real device.
                    // Requires the app path to have been cached during
                    // StartAgent (via the StartAgentRequest.ios_app_path
                    // field). Without it we can't reinstall and must surface
                    // an actionable error.
                    let serial = self.active_serial().await?;
                    let app_path = self
                        .ios_agent_config
                        .read()
                        .await
                        .as_ref()
                        .and_then(|c| c.app_path.clone());
                    let Some(app_path) = app_path else {
                        return Ok(self
                            .action_error(
                                request_id,
                                "UNSUPPORTED_ON_PHYSICAL_DEVICE",
                                "device.clearAppData on a physical iOS device requires the \
                                 app bundle path to have been passed at startAgent time. \
                                 Tapsmith's CLI does this automatically when `app` is set in \
                                 your config. If you're calling startAgent manually, pass \
                                 the device-signed .app path via StartAgentRequest.ios_app_path."
                                    .to_string(),
                            )
                            .await);
                    };
                    // Uninstall + install is the only devicectl sequence
                    // that actually wipes the app's data container on
                    // physical iOS (plain `install` preserves the container
                    // when replacing an existing bundle). Uninstall also
                    // drops the bundle's LaunchServices URL-scheme entry,
                    // so we wait briefly after install for LaunchServices
                    // to re-index — without this, the first subsequent
                    // `openDeepLink` call drops silently.
                    if let Err(e) =
                        ios::device::uninstall_app_on_device(&serial, &req.package_name).await
                    {
                        warn!(error = %e, "Uninstall step of physical-iOS clearAppData failed, continuing to reinstall");
                    }
                    if let Err(e) = ios::device::install_app_on_device(&serial, &app_path).await {
                        return Ok(self
                            .action_error(
                                request_id,
                                "ACTION_FAILED",
                                format!("clearAppData reinstall failed: {e}"),
                            )
                            .await);
                    }
                    // Give LaunchServices time to re-index the bundle's URL
                    // schemes. Without this, the next `openDeepLink` often
                    // fires before iOS knows what app handles the scheme.
                    tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: true,
                        error_type: String::new(),
                        error_message: String::new(),
                        screenshot: Vec::new(),
                    }));
                }
                let serial = self.active_serial().await?;
                // Clear the data container (AsyncStorage, UserDefaults, caches)
                // but do NOT terminate the app — launchApp handles that and
                // properly re-establishes the XCUITest accessibility bridge.
                // Clearing data while the app is running is fine because the
                // app will be relaunched anyway.
                match self
                    .get_app_container_cached(&serial, &req.package_name)
                    .await
                {
                    Ok(ref container) => {
                        if let Err(e) = ios::device::clear_container(container).await {
                            warn!(error = %e, "Failed to clear app container, continuing anyway");
                        }
                        // Also clear the simulator's device-level keychain so
                        // keychain-backed auth state (e.g. Firebase Auth)
                        // doesn't survive a "full" data clear, leaving a
                        // half-signed-in app. The keychain is device-global,
                        // so this clears it for every app on the simulator —
                        // acceptable for test-owned simulators.
                        if !ios::device::keychain_state_disabled() {
                            match ios::device::simulator_keychain_dir(container) {
                                Some(keychain_dir) => {
                                    if let Err(e) =
                                        ios::device::clear_keychain(&serial, &keychain_dir).await
                                    {
                                        warn!(error = %e, "Failed to clear simulator keychain, continuing anyway");
                                    }
                                }
                                None => {
                                    warn!(container = %container, "Could not derive simulator keychain dir; keychain not cleared");
                                }
                            }
                        }
                    }
                    Err(e) => {
                        debug!(error = %e, "Could not get app container (app may not be installed)");
                    }
                }
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: true,
                    error_type: String::new(),
                    error_message: String::new(),
                    screenshot: Vec::new(),
                }))
            }
            Platform::Android => {
                let cmd = format!("pm clear {}", req.package_name);
                self.adb_action(request_id, &cmd).await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn grant_permission(
        &self,
        request: Request<proto::GrantPermissionRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        Self::validate_package_name(&req.package_name)?;

        // iOS uses service names: camera, photos, location, microphone, etc.
        self.platform_permission_action(request_id, &req.package_name, &req.permission, "grant")
            .await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn revoke_permission(
        &self,
        request: Request<proto::RevokePermissionRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        Self::validate_package_name(&req.package_name)?;

        self.platform_permission_action(request_id, &req.package_name, &req.permission, "revoke")
            .await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn set_clipboard(
        &self,
        request: Request<proto::SetClipboardRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let platform = self.require_platform().await?;

        match platform {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    // simctl pbcopy is simulator-only. Physical devices go
                    // through the XCUITest agent, which calls
                    // `UIPasteboard.general.string = ...`. Writes don't
                    // trigger the iOS 16+ paste prompt — only reads do, and
                    // even then the runner bundle bypasses the dialog since
                    // it isn't a foreground app.
                    let command = AgentCommand::SetClipboard { text: req.text };
                    let result = self.send_agent_command(&command).await;
                    return self.make_action_response(request_id, result).await;
                }
                // Use simctl pbcopy to avoid the iOS 16+ paste permission dialog
                // that would crash the XCUITest agent if it accessed UIPasteboard.
                //
                // pbcopy rides the sim's pasteboard-sync service, which wedges
                // intermittently on CI — retry briefly, then fall back to the
                // agent's `UIPasteboard.general.string = ...` (the physical-
                // device path above): clipboard WRITES don't trigger the iOS
                // 16+ paste prompt, so the fallback is prompt-safe on
                // simulators too.
                let serial = self.active_serial().await?;
                let mut last_err: Option<anyhow::Error> = None;
                for attempt in 0..3 {
                    if attempt > 0 {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    match ios::device::set_clipboard(&serial, &req.text).await {
                        Ok(()) => return Ok(Self::success_action_response(request_id)),
                        Err(e) => {
                            warn!(%serial, attempt, error = %e, "simctl pbcopy failed");
                            last_err = Some(e);
                        }
                    }
                }
                let pbcopy_err = last_err.expect("loop ran at least once");
                info!(%serial, "Falling back to agent UIPasteboard write after pbcopy failures");
                let command = AgentCommand::SetClipboard { text: req.text };
                let result = self.send_agent_command(&command).await.map_err(|agent_err| {
                    Status::internal(format!(
                        "Failed to set clipboard on {serial}: {pbcopy_err} (agent fallback also failed: {agent_err})"
                    ))
                })?;
                self.make_action_response(request_id, Ok(result)).await
            }
            Platform::Android => {
                // Use the on-device agent for clipboard operations since it has
                // access to Android's ClipboardManager via the instrumentation context.
                let command = AgentCommand::SetClipboard { text: req.text };
                let result = self.send_agent_command(&command).await;
                self.make_action_response(request_id, result).await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_clipboard(
        &self,
        request: Request<proto::GetClipboardRequest>,
    ) -> Result<Response<proto::GetClipboardResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let platform = self.require_platform().await?;

        let text = match platform {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    // Route through the XCUITest agent — the runner bundle
                    // can call `UIPasteboard.general.string` without hitting
                    // the iOS 16+ paste prompt since it isn't a foreground
                    // app. On simulators we keep the simctl pbpaste path to
                    // match the existing behaviour (and avoid touching the
                    // agent at all when we don't need to).
                    let command = AgentCommand::GetClipboard {};
                    let result = self
                        .send_agent_command(&command)
                        .await
                        .map_err(|e| Status::internal(e.to_string()))?;
                    result
                        .data
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                } else {
                    // Use simctl pbpaste to avoid the iOS 16+ paste permission dialog
                    // that would crash the XCUITest agent if it accessed UIPasteboard.
                    // Same bounded retry as set_clipboard — the sim's
                    // pasteboard-sync service wedges intermittently on CI.
                    let serial = self.active_serial().await?;
                    let mut text = None;
                    let mut last_err = None;
                    for attempt in 0..3 {
                        if attempt > 0 {
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                        match ios::device::get_clipboard(&serial).await {
                            Ok(t) => {
                                text = Some(t);
                                break;
                            }
                            Err(e) => {
                                warn!(%serial, attempt, error = %e, "simctl pbpaste failed");
                                last_err = Some(e);
                            }
                        }
                    }
                    match text {
                        Some(t) => t,
                        None => {
                            return Err(Status::internal(
                                last_err.expect("loop ran at least once").to_string(),
                            ))
                        }
                    }
                }
            }
            Platform::Android => {
                let command = AgentCommand::GetClipboard {};
                let result = self
                    .send_agent_command(&command)
                    .await
                    .map_err(|e| Status::internal(e.to_string()))?;
                result
                    .data
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            }
        };

        Ok(Response::new(proto::GetClipboardResponse {
            request_id,
            text,
        }))
    }

    #[instrument(skip_all, fields(request_id))]
    async fn set_orientation(
        &self,
        request: Request<proto::SetOrientationRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                let command = AgentCommand::SetOrientation {
                    orientation: req.orientation.clone(),
                };
                let result = self.send_agent_command(&command).await;
                self.make_action_response(request_id, result).await
            }
            Platform::Android => {
                let serial = self.active_serial().await?;
                let rotation = match req.orientation.as_str() {
                    "portrait" => "0",
                    "landscape" => "1",
                    other => {
                        return Err(Status::invalid_argument(format!(
                            "orientation must be 'portrait' or 'landscape', got '{other}'"
                        )));
                    }
                };
                if let Err(e) =
                    adb::shell(&serial, "settings put system accelerometer_rotation 0").await
                {
                    error!(error = %e, "Failed to disable auto-rotate");
                }
                let cmd = format!("settings put system user_rotation {rotation}");
                self.adb_action(request_id, &cmd).await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_orientation(
        &self,
        request: Request<proto::GetOrientationRequest>,
    ) -> Result<Response<proto::GetOrientationResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                let command = AgentCommand::GetOrientation {};
                let result = self.send_agent_command(&command).await?;
                let orientation = result
                    .data
                    .get("orientation")
                    .and_then(|v| v.as_str())
                    .unwrap_or("portrait")
                    .to_string();
                Ok(Response::new(proto::GetOrientationResponse {
                    request_id,
                    orientation,
                }))
            }
            Platform::Android => {
                let serial = self.active_serial().await?;
                let output = adb::shell(&serial, "settings get system user_rotation")
                    .await
                    .map_err(|e| Status::internal(e.to_string()))?;
                let orientation = match output.trim() {
                    "1" | "3" => "landscape",
                    _ => "portrait",
                };
                Ok(Response::new(proto::GetOrientationResponse {
                    request_id,
                    orientation: orientation.to_string(),
                }))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn is_keyboard_shown(
        &self,
        request: Request<proto::IsKeyboardShownRequest>,
    ) -> Result<Response<proto::IsKeyboardShownResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                let command = AgentCommand::IsKeyboardShown {};
                let result = self.send_agent_command(&command).await?;
                let shown = result
                    .data
                    .get("shown")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                Ok(Response::new(proto::IsKeyboardShownResponse {
                    request_id,
                    shown,
                }))
            }
            Platform::Android => {
                let serial = self.active_serial().await?;
                let shown = self.android_is_keyboard_shown(&serial).await?;
                Ok(Response::new(proto::IsKeyboardShownResponse {
                    request_id,
                    shown,
                }))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn hide_keyboard(
        &self,
        request: Request<proto::HideKeyboardRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                let result = self
                    .send_agent_command(&AgentCommand::HideKeyboard {})
                    .await;
                self.make_action_response(request_id, result).await
            }
            Platform::Android => {
                // The Android soft keyboard is dismissed by BACK, not ESCAPE —
                // KEYCODE_ESCAPE is a no-op for the IME on most apps (incl.
                // Flutter). Only send BACK when the keyboard is actually shown,
                // otherwise BACK would pop the current screen / background the app.
                let serial = self.active_serial().await?;
                let shown = self.android_is_keyboard_shown(&serial).await?;
                if shown {
                    self.adb_action(request_id, "input keyevent KEYCODE_BACK")
                        .await
                } else {
                    Ok(Self::success_action_response(request_id))
                }
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn open_notifications(
        &self,
        request: Request<proto::OpenNotificationsRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        // iOS has no notification shade — success no-op
        self.ios_noop_or_android_adb(request_id, "cmd statusbar expand-notifications")
            .await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn open_quick_settings(
        &self,
        request: Request<proto::OpenQuickSettingsRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        // iOS has no quick settings — success no-op
        self.ios_noop_or_android_adb(request_id, "cmd statusbar expand-settings")
            .await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn set_color_scheme(
        &self,
        request: Request<proto::SetColorSchemeRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                match req.scheme.as_str() {
                    "dark" | "light" => {}
                    other => {
                        return Err(Status::invalid_argument(format!(
                            "scheme must be 'dark' or 'light', got '{other}'"
                        )));
                    }
                }
                if self.is_active_ios_physical().await {
                    // `xcrun simctl ui appearance` is simulator-only. Physical
                    // devices require the user to toggle light/dark mode in
                    // Settings; there is no programmatic path.
                    return Ok(self
                        .action_error(
                            request_id,
                            "UNSUPPORTED_ON_PHYSICAL_DEVICE",
                            "device.setColorScheme is not supported on physical iOS devices. \
                             Workaround: set the system appearance on the device manually \
                             (Settings → Display & Brightness) before running the test."
                                .to_string(),
                        )
                        .await);
                }
                let serial = self.active_serial().await?;
                match ios::device::set_appearance(&serial, &req.scheme).await {
                    Ok(()) => Ok(Self::success_action_response(request_id)),
                    Err(e) => Ok(self
                        .action_error(request_id, "ACTION_FAILED", e.to_string())
                        .await),
                }
            }
            Platform::Android => {
                let mode = match req.scheme.as_str() {
                    "dark" => "yes",
                    "light" => "no",
                    other => {
                        return Err(Status::invalid_argument(format!(
                            "scheme must be 'dark' or 'light', got '{other}'"
                        )));
                    }
                };
                let cmd = format!("cmd uimode night {mode}");
                self.adb_action(request_id, &cmd).await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_color_scheme(
        &self,
        request: Request<proto::GetColorSchemeRequest>,
    ) -> Result<Response<proto::GetColorSchemeResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                // Route through agent — it can read UITraitCollection.current
                let command = AgentCommand::GetColorScheme {};
                let result = self.send_agent_command(&command).await?;
                let scheme = result
                    .data
                    .get("scheme")
                    .and_then(|v| v.as_str())
                    .unwrap_or("light")
                    .to_string();
                Ok(Response::new(proto::GetColorSchemeResponse {
                    request_id,
                    scheme,
                }))
            }
            Platform::Android => {
                let serial = self.active_serial().await?;
                let output = adb::shell_lenient(&serial, "cmd uimode night")
                    .await
                    .map_err(|e| Status::internal(e.to_string()))?;
                let scheme = if output.contains("Night mode: yes") {
                    "dark"
                } else {
                    "light"
                };
                Ok(Response::new(proto::GetColorSchemeResponse {
                    request_id,
                    scheme: scheme.to_string(),
                }))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn wake_device(
        &self,
        request: Request<proto::WakeDeviceRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        // iOS simulator is always awake
        self.ios_noop_or_android_adb(request_id, "input keyevent KEYCODE_WAKEUP")
            .await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn unlock_device(
        &self,
        request: Request<proto::UnlockDeviceRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            // iOS simulator has no lock screen
            Platform::Ios => Ok(Self::success_action_response(request_id)),
            Platform::Android => {
                let serial = self.active_serial().await?;
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
                    return Ok(Self::success_action_response(request_id));
                }
                // `wm dismiss-keyguard` is the input-free path (API 26+). It
                // does nothing for secure keyguards, so re-check and fall
                // back to the gesture only while the lock screen is still up
                // (or when the dump cannot tell).
                let _ = adb::shell_lenient(&serial, "wm dismiss-keyguard").await;
                tokio::time::sleep(Duration::from_millis(500)).await;
                if adb::keyguard_showing(&serial).await == Some(false) {
                    return Ok(Self::success_action_response(request_id));
                }
                // Dismiss non-secure lock screen (KEYCODE_MENU)
                let _ = adb::shell_lenient(&serial, "input keyevent 82").await;
                tokio::time::sleep(Duration::from_millis(500)).await;
                // Swipe up as fallback for swipe-to-unlock screens
                let _ = adb::shell_lenient(&serial, "input swipe 540 1800 540 800 300").await;
                Ok(Self::success_action_response(request_id))
            }
        }
    }

    // ─── Network Capture (PILOT-164) ───

    async fn start_network_capture(
        &self,
        request: Request<proto::StartNetworkCaptureRequest>,
    ) -> Result<Response<proto::StartNetworkCaptureResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let mut http_ports = Vec::new();
        for port in &req.http_ports {
            if *port == 0 || *port > u16::MAX as u32 {
                return Err(Status::invalid_argument(
                    "HTTP capture ports must be between 1 and 65535",
                ));
            }
            http_ports.push(*port as u16);
        }
        http_ports.sort_unstable();
        http_ports.dedup();

        let mut proxy_guard = self.network_proxy.write().await;
        // If a proxy is already running (pre-started for physical iOS OCSP
        // passthrough during start_agent), reuse it instead of erroring.
        // Capture state is reset so this session starts clean.
        if let Some(existing) = proxy_guard.as_ref() {
            let existing_port = existing.port();
            let old_ports = self.proxy_http_ports.read().await.clone();
            let uses_iptables = *self.proxy_uses_iptables.read().await;
            let mut warnings = Vec::new();
            let reverse_port = *self.proxy_reverse_port.read().await;
            match capture_port_update(&old_ports, &http_ports, uses_iptables, reverse_port) {
                Ok(Some(port)) => {
                    let serial = self.active_serial().await?;
                    if !adb::setup_iptables_redirect(&serial, port, &http_ports).await {
                        if !adb::setup_iptables_redirect(&serial, port, &old_ports).await {
                            // The rules are now unknown. Tear down so retries
                            // cannot mistake stale bookkeeping for applied ports.
                            drop(proxy_guard);
                            self.cleanup_network_proxy().await;
                        }
                        return Err(Status::internal(
                            "Failed to update Android HTTP capture ports",
                        ));
                    }
                    *self.proxy_http_ports.write().await = http_ports;
                }
                Ok(None) => {}
                Err(message) if !uses_iptables => warnings.push(message),
                Err(message) => return Err(Status::failed_precondition(message)),
            }
            let android_emulator = {
                let dm = self.device_manager.read().await;
                matches!(dm.active_device(), Some(d) if d.platform == Platform::Android && d.is_emulator)
            };
            existing.set_android_emulator(android_emulator).await;
            existing.reset_capture_state().await;
            // Clone out of the read guard before awaiting — holding a
            // RwLock guard across an await risks starving writers.
            let passthrough_hosts = self.passthrough_hosts.read().await.clone();
            let embedded_root_defaults = self.embedded_root_defaults().await;
            existing
                .set_passthrough_hosts(passthrough_hosts, embedded_root_defaults)
                .await;
            let serial = self.active_serial().await.unwrap_or_default();
            info!(
                serial = %serial,
                port = existing_port,
                "Reusing pre-started proxy for network capture"
            );
            return Ok(Response::new(proto::StartNetworkCaptureResponse {
                request_id,
                success: true,
                proxy_port: u32::from(existing_port),
                error_message: warnings.join("; "),
            }));
        }

        // Load or create the MITM CA for HTTPS interception
        let mitm_ca = Arc::new(
            MitmAuthority::load_or_create()
                .map_err(|e| Status::internal(format!("Failed to create MITM CA: {e}")))?,
        );

        let serial = self.active_serial().await?;
        let platform = self.require_platform().await?;
        let ca_pem_path = mitm_ca.ca_pem_path().to_string_lossy().to_string();
        let mut warnings: Vec<String> = Vec::new();

        let is_ios_physical = self.is_active_ios_physical().await;

        match platform {
            Platform::Ios if !is_ios_physical => {
                // Simulator path — install CA into the simulator's trust store
                // once per session; it stays trusted for subsequent captures.
                // Per-UDID set, not a single slot: workers switching between
                // simulators on a shared daemon would otherwise evict each
                // other's entry and re-run the slow install on every switch.
                let already_installed = self
                    .ios_ca_cert_installed
                    .read()
                    .await
                    .contains(serial.as_str());
                if already_installed {
                    debug!(%serial, "MITM CA already installed on simulator this session");
                } else {
                    match ios::device::install_ca_cert(&serial, &ca_pem_path).await {
                        Ok(()) => {
                            self.ios_ca_cert_installed
                                .write()
                                .await
                                .insert(serial.clone());
                        }
                        Err(e) => {
                            let msg = format!(
                                "Failed to install CA cert on simulator: {e} — HTTPS traffic will not be captured"
                            );
                            error!("{msg}");
                            warnings.push(msg);
                        }
                    }
                }
            }
            Platform::Ios => {
                // Physical device path (PILOT-185) — the CA is trusted via the
                // mobileconfig the user installed on the device, so there's
                // nothing to install from the host. We just verify the
                // mobileconfig exists and warn loudly if it's missing, since
                // without it the device has no route into our proxy and no
                // trust for our CA.
                #[cfg(target_os = "macos")]
                {
                    if !ios::physical_device_proxy::mobileconfig_exists(&serial).await {
                        return Ok(Response::new(proto::StartNetworkCaptureResponse {
                            request_id,
                            success: false,
                            proxy_port: 0,
                            error_message: format!(
                                "No Tapsmith network profile found for device {serial}. \
                                 Run `tapsmith configure-ios-network {serial}` first, then \
                                 install the generated .mobileconfig on the device."
                            ),
                        }));
                    }
                    // Warn if the host's Wi-Fi IP has drifted from what the
                    // mobileconfig was generated against.
                    if let Ok(Some(meta)) =
                        ios::physical_device_proxy::read_mobileconfig_meta(&serial).await
                    {
                        if let Ok(current_ip) =
                            ios::physical_device_proxy::resolve_host_wifi_ip().await
                        {
                            if ios::physical_device_proxy::is_mobileconfig_stale(&meta, current_ip)
                                .await
                            {
                                let msg = format!(
                                    "Host Wi-Fi IP changed since mobileconfig was generated ({} → {}). \
                                     Run `tapsmith refresh-ios-network {serial}` and reinstall the profile.",
                                    meta.host_ip, current_ip
                                );
                                warn!("{msg}");
                                warnings.push(msg);
                            }
                        }
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    return Ok(Response::new(proto::StartNetworkCaptureResponse {
                        request_id,
                        success: false,
                        proxy_port: 0,
                        error_message: "Physical iOS network capture requires macOS".to_string(),
                    }));
                }
            }
            Platform::Android => {
                let cert_filename = mitm_ca.device_cert_filename().map_err(|e| {
                    Status::internal(format!("Failed to compute CA cert hash: {e}"))
                })?;
                match adb::install_ca_cert(&serial, &ca_pem_path, &cert_filename).await {
                    Ok(installed_path) => {
                        *self.proxy_ca_cert_path.write().await = Some(installed_path);
                    }
                    Err(e) => {
                        let msg = format!(
                            "Failed to install CA cert on device: {e} — HTTPS traffic will not be captured"
                        );
                        error!("{msg}");
                        warnings.push(msg);
                    }
                }
            }
        }

        // Pick the proxy bind address based on device type. Simulators and
        // Android both want loopback (they reach the proxy via transparent
        // redirection or adb reverse). Physical iOS devices need a LAN-
        // reachable listener on a deterministic per-UDID port so their
        // installed mobileconfig can route traffic here.
        let proxy = if is_ios_physical {
            #[cfg(target_os = "macos")]
            {
                let port = ios::physical_device_proxy::deterministic_port(&serial);
                let bind = std::net::SocketAddr::new(
                    std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
                    port,
                );
                NetworkProxy::start_on(Arc::clone(&mitm_ca), bind)
                    .await
                    .map_err(|e| {
                        Status::internal(format!("Failed to start proxy on {bind}: {e}"))
                    })?
            }
            #[cfg(not(target_os = "macos"))]
            {
                return Ok(Response::new(proto::StartNetworkCaptureResponse {
                    request_id,
                    success: false,
                    proxy_port: 0,
                    error_message: "Physical iOS network capture requires macOS".to_string(),
                }));
            }
        } else {
            NetworkProxy::start(Arc::clone(&mitm_ca))
                .await
                .map_err(|e| Status::internal(format!("Failed to start proxy: {e}")))?
        };
        // Clone out of the read guard before awaiting — holding a RwLock
        // guard across an await risks starving writers.
        let passthrough_hosts = self.passthrough_hosts.read().await.clone();
        // `platform` is already resolved above, so use it directly rather than
        // re-reading the device manager.
        proxy
            .set_passthrough_hosts(
                passthrough_hosts,
                Self::embedded_root_defaults_for(Some(platform)),
            )
            .await;
        let android_emulator = {
            let dm = self.device_manager.read().await;
            matches!(dm.active_device(), Some(d) if d.platform == Platform::Android && d.is_emulator)
        };
        proxy.set_android_emulator(android_emulator).await;
        let host_port = proxy.port();

        // Physical iOS: verify the proxy is reachable from the LAN. On
        // modern macOS the Application Firewall's stealth mode silently
        // drops inbound TCP SYNs to user processes, even when the binary
        // is explicitly allowed in the firewall list. The symptom is the
        // device never reaches the proxy — traffic capture silently
        // returns 0 entries and users spend an hour debugging SSID /
        // profile install / Wi-Fi before finding the real cause.
        //
        // Check by connecting to our own LAN IP on the proxy port. If
        // that times out, the firewall (or similar) is blocking and we
        // return a clear error with the exact socketfilterfw fix.
        #[cfg(target_os = "macos")]
        if is_ios_physical {
            if let Ok(lan_ip) = ios::physical_device_proxy::resolve_host_wifi_ip().await {
                let reachable = self_probe_lan_listener(lan_ip, host_port).await;
                if !reachable {
                    // Drop the proxy — otherwise the next start_network_capture
                    // call will fail with "already running".
                    drop(proxy);
                    return Ok(Response::new(proto::StartNetworkCaptureResponse {
                        request_id,
                        success: false,
                        proxy_port: 0,
                        error_message: format!(
                            "Tapsmith proxy is bound to {lan_ip}:{host_port} but inbound LAN \
                             connections are being blocked — the iPhone will never reach it.\n\n\
                             Most likely cause: macOS Application Firewall stealth mode is \
                             silently dropping unsolicited inbound TCP SYNs, even for \
                             allow-listed binaries. Disable it with:\n  \
                             sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode off\n\n\
                             Or disable the firewall entirely for this session:\n  \
                             sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off"
                        ),
                    }));
                }
            }
        }

        match platform {
            Platform::Ios if !is_ios_physical => {
                // PILOT-182: route the simulator's traffic into the MITM
                // proxy via the macOS Network Extension redirector instead
                // of a global system proxy. Per-PID filtering gives each
                // worker daemon full isolation from other concurrent
                // workers (and from the user's host traffic).
                //
                // If the redirector fails to start (SE not approved, brew
                // missing, launcher binary unreachable, …), there is NO
                // path for traffic to reach the proxy — capture is
                // effectively dead. Early-return `success: false` so the
                // runner prints "Network capture disabled" instead of the
                // misleading "warning". The local `proxy` is dropped at
                // end of scope, releasing the TCP listener.
                #[cfg(target_os = "macos")]
                {
                    // The "NE previously failed" cache exists to skip a doomed
                    // launch when the system-proxy fallback is going to be used
                    // anyway. Under `require_isolation` that fallback is refused,
                    // so consulting the cache would turn one transient failure
                    // (typically two daemons launching the redirector at once)
                    // into "capture disabled" for every later test on this
                    // device: always retry the redirector instead, and leave the
                    // cache untouched for callers that can fall back.
                    let ne_known_bad =
                        !req.require_isolation && *self.ios_ne_unavailable.read().await;
                    let ne_result = if ne_known_bad {
                        debug!("Skipping NE attempt (previously failed) — using system proxy");
                        Err(anyhow::anyhow!("cached: NE previously unavailable"))
                    } else {
                        crate::ios_redirect::IosRedirect::start(
                            serial.clone(),
                            proxy.state_handle(),
                            Arc::clone(&mitm_ca),
                        )
                        .await
                    };
                    match ne_result {
                        Ok(redirect) => {
                            *self.ios_redirect.write().await = Some(redirect);
                            info!(
                                %serial, host_port,
                                "iOS redirector session established"
                            );
                        }
                        Err(e) => {
                            if !ne_known_bad && !req.require_isolation {
                                *self.ios_ne_unavailable.write().await = true;
                                warn!(
                                    "Network Extension redirector unavailable: {e} — \
                                     falling back to macOS system proxy"
                                );
                            }
                            // The system-proxy fallback is host-wide: it records
                            // every process on the Mac (browsers, trustd, other
                            // simulators) and nothing in the captured entries
                            // says which. A caller that needs per-device
                            // attribution — the runner, for a multi-device group
                            // — asks for isolation and gets a clear refusal
                            // rather than someone else's traffic under this
                            // device's name. Note the most common local cause:
                            // two daemons launching the redirector at once share
                            // one NETransparentProxyManager, and the loser's
                            // control channel never connects.
                            if req.require_isolation {
                                let msg = format!(
                                    "iOS network capture unavailable for this device: the \
                                     Network Extension redirector failed ({e}) and the \
                                     macOS system-proxy fallback is not device-isolated, so \
                                     it is refused for multi-device runs. If another \
                                     Tapsmith daemon is capturing on this Mac, the \
                                     redirector session may already be owned by it; see \
                                     docs/ios-network-capture.md#multi-device-groups"
                                );
                                warn!("{msg}");
                                return Ok(Response::new(proto::StartNetworkCaptureResponse {
                                    request_id,
                                    success: false,
                                    proxy_port: 0,
                                    error_message: msg,
                                }));
                            }
                            match ios::system_proxy::set_system_proxy(host_port).await {
                                Ok(service) => {
                                    *self.ios_system_proxy_service.write().await = Some(service);
                                    warnings.push(
                                        "Using macOS system proxy fallback — \
                                         not PID-isolated (affects all host traffic)"
                                            .to_string(),
                                    );
                                }
                                Err(proxy_err) => {
                                    let msg = format!(
                                        "iOS network capture unavailable: Network Extension \
                                         failed ({e}), system proxy fallback also failed ({proxy_err})"
                                    );
                                    error!("{msg}");
                                    return Ok(Response::new(proto::StartNetworkCaptureResponse {
                                        request_id,
                                        success: false,
                                        proxy_port: 0,
                                        error_message: msg,
                                    }));
                                }
                            }
                        }
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    return Ok(Response::new(proto::StartNetworkCaptureResponse {
                        request_id,
                        success: false,
                        proxy_port: 0,
                        error_message: "iOS network capture requires macOS".to_string(),
                    }));
                }
            }
            Platform::Ios => {
                // PILOT-185 physical-device path — the device already has the
                // mobileconfig installed, so its outbound HTTP traffic is
                // directed at us via the standard HTTP proxy protocol. The
                // existing `handle_connection` path inside NetworkProxy
                // transparently handles CONNECT / GET-with-absolute-URL
                // requests from the device, so no redirector is needed.
                info!(
                    %serial,
                    host_port,
                    "Physical iOS proxy listening for device HTTP_PROXY traffic"
                );
            }
            Platform::Android => {
                // Use `adb reverse` to make the proxy reachable as
                // 127.0.0.1:{device_port} on the device. The host proxy port
                // is OS-assigned and only known to be free on the host; the
                // same number can still be occupied on the device. Try it
                // first for continuity, then fall back to alternate device
                // ports while forwarding all of them to the same host port.
                let device_port =
                    match setup_android_reverse_with_fallback(&serial, host_port).await {
                        Ok(port) => port,
                        Err(msg) => {
                            error!("{msg}");
                            return Ok(Response::new(proto::StartNetworkCaptureResponse {
                                request_id,
                                success: false,
                                proxy_port: 0,
                                error_message: msg,
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
                let iptables_ok =
                    adb::setup_iptables_redirect(&serial, device_port, &http_ports).await;
                *self.proxy_uses_iptables.write().await = iptables_ok;
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
                        return Ok(Response::new(proto::StartNetworkCaptureResponse {
                            request_id,
                            success: false,
                            proxy_port: 0,
                            error_message: msg,
                        }));
                    }
                    warnings.push(
                        "iptables redirect unavailable; using Android system HTTP proxy fallback"
                            .to_string(),
                    );
                }
                *self.proxy_reverse_port.write().await = Some(device_port);
            }
        }

        if *self.proxy_uses_iptables.read().await {
            *self.proxy_http_ports.write().await = http_ports;
        } else {
            self.proxy_http_ports.write().await.clear();
            if !http_ports.is_empty() {
                warnings.push("networkHttpPorts was not applied: Android transparent iptables capture is unavailable".to_string());
            }
        }
        *proxy_guard = Some(proxy);

        // If a NetworkRoute stream is active, install its handler on the
        // newly created proxy so route interception works regardless of
        // whether the stream opened before or after capture started.
        if let Some(handler) = self.active_route_handler.read().await.as_ref() {
            if let Some(p) = proxy_guard.as_ref() {
                p.set_handler(Arc::clone(handler) as Arc<dyn crate::network_proxy::NetworkHandler>)
                    .await;
            }
        }

        *self.proxy_device_serial.write().await = Some(serial);
        *self.proxy_platform.write().await = Some(platform);

        Ok(Response::new(proto::StartNetworkCaptureResponse {
            request_id,
            success: true,
            proxy_port: host_port as u32,
            error_message: warnings.join("\n"),
        }))
    }

    async fn snapshot_network_capture(
        &self,
        request: Request<proto::SnapshotNetworkCaptureRequest>,
    ) -> Result<Response<proto::SnapshotNetworkCaptureResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let guard = self.network_proxy.read().await;
        let Some(proxy) = guard.as_ref() else {
            return Ok(Response::new(proto::SnapshotNetworkCaptureResponse {
                request_id,
                success: false,
                entries: Vec::new(),
                error_message: "Network capture is not running".to_string(),
            }));
        };
        let entries = if req.incremental_bodies {
            let known = req
                .known_bodies
                .into_iter()
                .map(|v| {
                    (
                        v.capture_id,
                        (v.request_body_size as usize, v.response_body_size as usize),
                    )
                })
                .collect();
            proxy
                .snapshot_updates(&known)
                .await
                .into_iter()
                .map(|update| {
                    let mut entry = captured_entry_to_proto(update.entry, proxy.capture_session());
                    entry.request_body_omitted = update.request_body_omitted;
                    entry.response_body_omitted = update.response_body_omitted;
                    entry
                })
                .collect()
        } else {
            captured_entries_to_proto(proxy.snapshot_entries().await, proxy.capture_session())
        };
        Ok(Response::new(proto::SnapshotNetworkCaptureResponse {
            request_id,
            success: true,
            entries,
            error_message: String::new(),
        }))
    }

    async fn stop_network_capture(
        &self,
        request: Request<proto::StopNetworkCaptureRequest>,
    ) -> Result<Response<proto::StopNetworkCaptureResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        // `mut` is only exercised on macOS (the system-proxy fallback below).
        #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
        let mut keep_running = req.keep_running;

        // In macOS system-proxy fallback mode (NE redirector unavailable —
        // typical on CI runner images), a full per-test teardown toggles
        // `networksetup` off, kills the listener, and the next start re-toggles
        // the proxy to a NEW port and re-touches the sim's trust store. That
        // configd/network churn was observed wedging CoreSimulatorService for
        // 6–12 minutes, starving every simctl-backed RPC behind it. Keep the
        // proxy and system-proxy setting alive for the whole session instead:
        // drain entries here, reuse the listener on the next start, and leave
        // the real teardown to cleanup_network_proxy() at daemon shutdown.
        #[cfg(target_os = "macos")]
        if !keep_running && self.ios_system_proxy_service.read().await.is_some() {
            debug!("stop_network_capture: keeping system-proxy fallback capture alive for session");
            keep_running = true;
        }

        if keep_running {
            // Give in-flight requests a moment to complete before draining,
            // without holding the network_proxy lock during the wait.
            tokio::time::sleep(Duration::from_millis(100)).await;

            let proxy_guard = self.network_proxy.read().await;
            let Some(proxy) = proxy_guard.as_ref() else {
                return Ok(Response::new(proto::StopNetworkCaptureResponse {
                    request_id,
                    success: false,
                    entries: Vec::new(),
                    error_message: "Network capture is not running".to_string(),
                }));
            };

            let captured = proxy.drain_entries().await;
            let entries = captured_entries_to_proto(captured, proxy.capture_session());
            return Ok(Response::new(proto::StopNetworkCaptureResponse {
                request_id,
                success: true,
                entries,
                error_message: String::new(),
            }));
        }

        let proxy = self.network_proxy.write().await.take();
        let Some(proxy) = proxy else {
            return Ok(Response::new(proto::StopNetworkCaptureResponse {
                request_id,
                success: false,
                entries: Vec::new(),
                error_message: "Network capture is not running".to_string(),
            }));
        };

        // Revert proxy settings based on platform
        let serial = self.proxy_device_serial.write().await.take();
        let platform = self.proxy_platform.write().await.take();
        let reverse_port = self.proxy_reverse_port.write().await.take();
        let ca_cert_path = self.proxy_ca_cert_path.write().await.take();
        let used_iptables = std::mem::replace(&mut *self.proxy_uses_iptables.write().await, false);
        if let Some(serial) = &serial {
            match platform {
                Some(Platform::Ios) => {
                    // PILOT-182 simulators: drop the redirector session handle
                    // BEFORE `proxy.stop()`. Drop closes the control channel,
                    // which tells the SE to remove this worker's per-PID
                    // filter; the accept + refresh tasks abort and the Unix
                    // socket file is unlinked. No host state lingers.
                    //
                    // PILOT-185 physical devices: the ios_redirect slot is
                    // always None on that path, so the take() below is a
                    // no-op — the device's own HTTP proxy setting (installed
                    // via mobileconfig) is the routing mechanism and it
                    // persists across runs by design.
                    #[cfg(target_os = "macos")]
                    {
                        if let Some(redirect) = self.ios_redirect.write().await.take() {
                            drop(redirect);
                            debug!(%serial, "iOS redirector session torn down");
                        }
                        if let Some(service) = self.ios_system_proxy_service.write().await.take() {
                            ios::system_proxy::reset_system_proxy(&service).await;
                        }
                    }
                    info!(%serial, "iOS proxy stopped");
                }
                _ => {
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
                        if let Some(port) = reverse_port {
                            if let Err(e) = adb::remove_reverse_with_timeout(
                                &serial_b,
                                port,
                                ANDROID_PROXY_CLEANUP_TIMEOUT,
                            )
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
            }
        }

        let capture_session = proxy.capture_session().to_string();
        let captured = proxy.stop().await;
        let entries = captured_entries_to_proto(captured, &capture_session);

        Ok(Response::new(proto::StopNetworkCaptureResponse {
            request_id,
            success: true,
            entries,
            error_message: String::new(),
        }))
    }

    // ─── Physical iOS network profile (PILOT-185) ───

    async fn generate_ios_network_profile(
        &self,
        request: Request<proto::GenerateIosNetworkProfileRequest>,
    ) -> Result<Response<proto::GenerateIosNetworkProfileResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        #[cfg(not(target_os = "macos"))]
        {
            return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                request_id,
                success: false,
                error_message: "Physical iOS network profile generation is macOS-only".to_string(),
                profile_path: String::new(),
                host_ip: String::new(),
                port: 0,
                ssid: String::new(),
            }));
        }

        #[cfg(target_os = "macos")]
        {
            if req.udid.is_empty() {
                return Err(Status::invalid_argument("udid is required"));
            }

            // Look up the device to confirm it's a physical iOS device we know
            // about AND grab its human-readable name for the payload label.
            let physical_devices = match ios::device::list_physical_devices().await {
                Ok(list) => list,
                Err(e) => {
                    return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                        request_id,
                        success: false,
                        error_message: format!("Failed to list physical iOS devices: {e}"),
                        profile_path: String::new(),
                        host_ip: String::new(),
                        port: 0,
                        ssid: String::new(),
                    }));
                }
            };
            let Some(device) = physical_devices.iter().find(|d| d.udid == req.udid) else {
                return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                    request_id,
                    success: false,
                    error_message: format!(
                        "No physical iOS device with UDID '{}' is connected. \
                         Plug the device in and re-run.",
                        req.udid
                    ),
                    profile_path: String::new(),
                    host_ip: String::new(),
                    port: 0,
                    ssid: String::new(),
                }));
            };

            let host_ip = match ios::physical_device_proxy::resolve_host_wifi_ip().await {
                Ok(ip) => ip,
                Err(e) => {
                    return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                        request_id,
                        success: false,
                        error_message: format!("Failed to resolve host Wi-Fi IP: {e}"),
                        profile_path: String::new(),
                        host_ip: String::new(),
                        port: 0,
                        ssid: String::new(),
                    }));
                }
            };

            let ssid = if req.ssid.is_empty() {
                match ios::physical_device_proxy::current_wifi_ssid().await {
                    Some(s) => s,
                    None => {
                        return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                            request_id,
                            success: false,
                            error_message:
                                "Could not auto-detect the host's current Wi-Fi SSID.\n\n\
                                 macOS 14+ redacts SSIDs from `ipconfig getsummary` output \
                                 unless the calling process has Location Services permission, \
                                 and `networksetup -getairportnetwork` has been broken since \
                                 Apple removed the `airport` private framework.\n\n\
                                 Fix: pass the SSID explicitly. Example:\n  \
                                 tapsmith configure-ios-network <udid> --ssid \"MyWiFiNetwork\""
                                    .to_string(),
                            profile_path: String::new(),
                            host_ip: String::new(),
                            port: 0,
                            ssid: String::new(),
                        }));
                    }
                }
            } else {
                req.ssid.clone()
            };

            let port = ios::physical_device_proxy::deterministic_port(&req.udid);
            let device_name = if req.device_name.is_empty() {
                device.name.clone()
            } else {
                req.device_name.clone()
            };

            let mitm_ca = match MitmAuthority::load_or_create() {
                Ok(ca) => ca,
                Err(e) => {
                    return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                        request_id,
                        success: false,
                        error_message: format!("Failed to load Tapsmith MITM CA: {e}"),
                        profile_path: String::new(),
                        host_ip: String::new(),
                        port: 0,
                        ssid: String::new(),
                    }));
                }
            };
            let ca_pem = match tokio::fs::read_to_string(mitm_ca.ca_pem_path()).await {
                Ok(s) => s,
                Err(e) => {
                    return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                        request_id,
                        success: false,
                        error_message: format!(
                            "Failed to read Tapsmith CA from {:?}: {e}",
                            mitm_ca.ca_pem_path()
                        ),
                        profile_path: String::new(),
                        host_ip: String::new(),
                        port: 0,
                        ssid: String::new(),
                    }));
                }
            };

            let inputs = ios::physical_device_proxy::MobileconfigInputs {
                udid: req.udid.clone(),
                device_name,
                ssid: ssid.clone(),
                host_ip,
                port,
                ca_pem,
            };

            let bytes = match ios::physical_device_proxy::generate_mobileconfig(&inputs) {
                Ok(b) => b,
                Err(e) => {
                    return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                        request_id,
                        success: false,
                        error_message: format!("Failed to generate mobileconfig: {e}"),
                        profile_path: String::new(),
                        host_ip: String::new(),
                        port: 0,
                        ssid: String::new(),
                    }));
                }
            };

            let profile_path =
                match ios::physical_device_proxy::write_mobileconfig(&inputs, &bytes).await {
                    Ok(path) => path,
                    Err(e) => {
                        return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                            request_id,
                            success: false,
                            error_message: format!("Failed to write mobileconfig: {e}"),
                            profile_path: String::new(),
                            host_ip: String::new(),
                            port: 0,
                            ssid: String::new(),
                        }));
                    }
                };

            Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                request_id,
                success: true,
                error_message: String::new(),
                profile_path: profile_path.to_string_lossy().to_string(),
                host_ip: host_ip.to_string(),
                port: u32::from(port),
                ssid,
            }))
        }
    }

    async fn get_logcat(
        &self,
        request: Request<proto::GetLogcatRequest>,
    ) -> Result<Response<proto::GetLogcatResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let serial = self.active_serial().await?;

        // Fetch logcat with epoch timestamps for reliable filtering
        let output = match adb::shell_lenient(&serial, "logcat -d -v epoch").await {
            Ok(output) => output,
            Err(e) => {
                return Ok(Response::new(proto::GetLogcatResponse {
                    request_id,
                    logcat: String::new(),
                    error_message: format!("Failed to get logcat: {e}"),
                }));
            }
        };

        // Filter by timestamp and package in Rust for cross-device consistency.
        // Logcat `-v epoch` format: "<epoch_secs>.<fractional>  <pid> ..."
        let since_ms = req.since_ms;
        let until_ms = if req.until_ms > 0 {
            req.until_ms
        } else {
            u64::MAX
        };
        let package_name = req.package_name;

        // If package_name is set, resolve its PID(s) for filtering
        let pids: Vec<String> = if !package_name.is_empty() {
            let pid_output = adb::shell_lenient(&serial, &format!("pidof {package_name}"))
                .await
                .unwrap_or_default();
            pid_output.split_whitespace().map(String::from).collect()
        } else {
            Vec::new()
        };

        let need_filter = since_ms > 0 || until_ms < u64::MAX || !pids.is_empty();

        let logcat = if need_filter {
            let since_secs = since_ms as f64 / 1000.0;
            let until_secs = until_ms as f64 / 1000.0;

            output
                .lines()
                .filter(|line| {
                    // Parse epoch timestamp from the beginning of the line
                    let ts_ok = if since_ms > 0 || until_ms < u64::MAX {
                        // Epoch format: "1234567890.123  <pid> ..."
                        line.split_whitespace()
                            .next()
                            .and_then(|ts| ts.parse::<f64>().ok())
                            .map(|ts| ts >= since_secs && ts <= until_secs)
                            .unwrap_or(true) // keep non-parseable lines (e.g. headers)
                    } else {
                        true
                    };

                    let pid_ok = if !pids.is_empty() {
                        // PID is the second whitespace-delimited field in epoch format
                        line.split_whitespace()
                            .nth(1)
                            .map(|pid_field| pids.iter().any(|p| p == pid_field))
                            .unwrap_or(false)
                    } else {
                        true
                    };

                    ts_ok && pid_ok
                })
                .collect::<Vec<&str>>()
                .join("\n")
        } else {
            output
        };

        Ok(Response::new(proto::GetLogcatResponse {
            request_id,
            logcat,
            error_message: String::new(),
        }))
    }

    // ─── Device Log Streaming (PILOT-193) ───

    type StreamDeviceLogsStream =
        Pin<Box<dyn Stream<Item = Result<proto::DeviceLogEntry, Status>> + Send>>;

    type StreamDaemonLogsStream =
        Pin<Box<dyn Stream<Item = Result<proto::DaemonLogEntry, Status>> + Send>>;

    async fn stream_device_logs(
        &self,
        request: Request<proto::StreamDeviceLogsRequest>,
    ) -> Result<Response<Self::StreamDeviceLogsStream>, Status> {
        let req = request.into_inner();
        let serial = self.active_serial().await?;
        let platform = self.require_platform().await?;

        info!(
            serial = %serial,
            platform = %platform,
            package = %req.package_name,
            "Starting device log stream"
        );

        let handle = device_logs::start(serial, platform, req.package_name)
            .await
            .map_err(|e| Status::internal(format!("Failed to start device log stream: {e}")))?;

        let (out_tx, out_rx) =
            tokio::sync::mpsc::channel::<Result<proto::DeviceLogEntry, Status>>(256);

        tokio::spawn(async move {
            // Keep `handle` alive as a whole — dropping `_cancel_tx` kills
            // the log subprocess, so it must outlive the recv loop.
            let mut handle = handle;
            loop {
                tokio::select! {
                    entry = handle.rx.recv() => {
                        let Some(entry) = entry else { break };
                        let proto_entry = proto::DeviceLogEntry {
                            level: entry.level.to_string(),
                            message: entry.message,
                            tag: entry.tag,
                            timestamp_ms: entry.timestamp_ms,
                            pid: entry.pid,
                        };
                        if out_tx.send(Ok(proto_entry)).await.is_err() {
                            break;
                        }
                    }
                    // Client disconnected: terminate immediately instead of
                    // blocking on `handle.rx.recv()` until the next (maybe
                    // never) log line. The reader filters to the app's PIDs,
                    // so a cancelled stream against an app that has since been
                    // reset or terminated produced no wakeup at all and this
                    // task parked forever, holding its log subprocess open.
                    // Mirrors `stream_daemon_logs` below.
                    _ = out_tx.closed() => break,
                }
            }
            drop(handle);
        });

        let output_stream = tokio_stream::wrappers::ReceiverStream::new(out_rx);
        Ok(Response::new(Box::pin(output_stream)))
    }

    // ─── Daemon Log Streaming ───

    async fn stream_daemon_logs(
        &self,
        _request: Request<proto::StreamDaemonLogsRequest>,
    ) -> Result<Response<Self::StreamDaemonLogsStream>, Status> {
        let mut sub = self.daemon_log_bus.subscribe();
        let (out_tx, out_rx) =
            tokio::sync::mpsc::channel::<Result<proto::DaemonLogEntry, Status>>(256);

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    res = sub.recv() => {
                        match res {
                            Ok(entry) => {
                                let proto_entry = proto::DaemonLogEntry {
                                    level: entry.level,
                                    message: entry.message,
                                    target: entry.target,
                                    request_id: entry.request_id,
                                    timestamp_ms: entry.timestamp_ms,
                                };
                                if out_tx.send(Ok(proto_entry)).await.is_err() {
                                    break;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                                // Surface dropped entries instead of silently
                                // losing them when a slow client falls behind.
                                let now_ms = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_millis() as u64)
                                    .unwrap_or(0);
                                let warn_entry = proto::DaemonLogEntry {
                                    level: "warn".to_string(),
                                    message: format!(
                                        "Daemon log stream lagged; skipped {skipped} log entries"
                                    ),
                                    target: "tapsmith_core::grpc_server".to_string(),
                                    request_id: String::new(),
                                    timestamp_ms: now_ms,
                                };
                                if out_tx.send(Ok(warn_entry)).await.is_err() {
                                    break;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }
                    // Client disconnected: terminate immediately instead of
                    // blocking on `sub.recv()` until the next (maybe never) log.
                    _ = out_tx.closed() => break,
                }
            }
        });

        let output_stream = tokio_stream::wrappers::ReceiverStream::new(out_rx);
        Ok(Response::new(Box::pin(output_stream)))
    }

    // ─── App State Snapshot (PILOT-115) ───

    #[instrument(skip_all, fields(request_id))]
    async fn save_app_state(
        &self,
        request: Request<proto::SaveAppStateRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let serial = self.active_serial().await?;

        Self::validate_package_name(&req.package_name)?;
        if req.path.is_empty() {
            return Err(Status::invalid_argument("path is required"));
        }

        let pkg = &req.package_name;
        let local_path = &req.path;

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    // Physical devices: use `xcrun devicectl device copy from
                    // --domain-type appDataContainer` to pull the app's data
                    // container to a scratch directory, then tar it for
                    // parity with the simulator output shape.
                    warn!(
                        %pkg,
                        "Keychain state is not captured on physical iOS devices — keychain-backed data (e.g. native auth SDK credentials) will not be saved"
                    );
                    let scratch = tempfile::tempdir()
                        .map_err(|e| Status::internal(format!("tempdir: {e}")))?;
                    let scratch_path = scratch.path().to_string_lossy().to_string();
                    if let Err(e) =
                        ios::device::copy_app_container_from_device(&serial, pkg, &scratch_path)
                            .await
                    {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_SAVE_FAILED",
                                format!("devicectl copy from failed: {e}"),
                            )
                            .await);
                    }
                    if let Some(parent) = std::path::Path::new(local_path).parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }
                    let output = tokio::process::Command::new("tar")
                        .args([
                            "czf",
                            local_path,
                            "--exclude=./Library/Caches",
                            "--exclude=./Library/WebKit",
                            "--exclude=./Library/SplashBoard",
                            "--exclude=./Library/Saved Application State",
                            "--exclude=./tmp",
                            "-C",
                            &scratch_path,
                            ".",
                        ])
                        .output()
                        .await;
                    return match output {
                        Ok(out) if out.status.success() => {
                            info!(%pkg, %local_path, "iOS physical app state saved");
                            Ok(Self::success_action_response(request_id))
                        }
                        Ok(out) => {
                            let stderr = String::from_utf8_lossy(&out.stderr);
                            Ok(self
                                .action_error(
                                    request_id,
                                    "APP_STATE_SAVE_FAILED",
                                    format!("tar failed: {stderr}"),
                                )
                                .await)
                        }
                        Err(e) => Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_SAVE_FAILED",
                                format!("Failed to run tar: {e}"),
                            )
                            .await),
                    };
                }
                // iOS simulator: app container is on the host filesystem.
                // Use simctl to find it, then tar it directly.
                let container = match self.get_app_container_cached(&serial, pkg).await {
                    Ok(path) => path,
                    Err(e) => {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_SAVE_FAILED",
                                format!("Failed to locate app container: {e}"),
                            )
                            .await);
                    }
                };

                // Terminate the app to flush data
                let _ = ios::device::terminate_app(&serial, pkg).await;

                // Stage the simulator's device-level keychain db so the
                // archive captures keychain-backed state (Firebase Auth and
                // other SDKs persist credentials there, outside the app
                // container). Staging failures are non-fatal: the archive is
                // still valid, just without keychain state.
                let keychain_staging =
                    tempfile::tempdir().map_err(|e| Status::internal(format!("tempdir: {e}")))?;
                let mut keychain_staged = 0;
                if !ios::device::keychain_state_disabled() {
                    match ios::device::simulator_keychain_dir(&container) {
                        Some(keychain_dir) => {
                            let dest = keychain_staging
                                .path()
                                .join(ios::device::KEYCHAIN_ARCHIVE_MEMBER);
                            match ios::device::stage_keychain_files(&keychain_dir, &dest).await {
                                Ok(count) => keychain_staged = count,
                                Err(e) => {
                                    warn!(%pkg, error = %e, "Failed to stage simulator keychain; archive will not include keychain state");
                                }
                            }
                        }
                        None => {
                            warn!(%pkg, container, "Could not derive simulator keychain dir; archive will not include keychain state");
                        }
                    }
                }

                // Create tar.gz archive of the data container, excluding
                // caches and ephemeral data that inflates the archive
                // without contributing to app state (auth tokens, prefs,
                // databases). A React Native app container can have tens
                // of MB in Library/Caches and Library/WebKit alone.
                if let Some(parent) = std::path::Path::new(local_path).parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let mut tar_args: Vec<String> = vec![
                    "czf".into(),
                    local_path.clone(),
                    "--exclude=./Library/Caches".into(),
                    "--exclude=./Library/WebKit".into(),
                    "--exclude=./Library/SplashBoard".into(),
                    "--exclude=./Library/Saved Application State".into(),
                    "--exclude=./tmp".into(),
                    "-C".into(),
                    container.clone(),
                    ".".into(),
                ];
                if keychain_staged > 0 {
                    // Second -C pair appends the staged keychain as a
                    // reserved member alongside the container contents.
                    tar_args.extend([
                        "-C".into(),
                        keychain_staging.path().to_string_lossy().to_string(),
                        format!("./{}", ios::device::KEYCHAIN_ARCHIVE_MEMBER),
                    ]);
                }
                let output = tokio::process::Command::new("tar")
                    .args(&tar_args)
                    .output()
                    .await;

                match output {
                    Ok(out) if out.status.success() => {
                        info!(%pkg, %local_path, "iOS app state saved");
                        Ok(Self::success_action_response(request_id))
                    }
                    Ok(out) => {
                        let stderr = String::from_utf8_lossy(&out.stderr);
                        Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_SAVE_FAILED",
                                format!("tar failed: {stderr}"),
                            )
                            .await)
                    }
                    Err(e) => Ok(self
                        .action_error(
                            request_id,
                            "APP_STATE_SAVE_FAILED",
                            format!("Failed to run tar: {e}"),
                        )
                        .await),
                }
            }
            Platform::Android => {
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
                    match android_permissions::capture_into_data_dir(&serial, pkg, &data_dir).await
                    {
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
                Ok(Self::success_action_response(request_id))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn restore_app_state(
        &self,
        request: Request<proto::RestoreAppStateRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let serial = self.active_serial().await?;

        Self::validate_package_name(&req.package_name)?;
        if req.path.is_empty() {
            return Err(Status::invalid_argument("path is required"));
        }

        let pkg = &req.package_name;
        let local_path = &req.path;

        // Verify local archive exists
        if !std::path::Path::new(local_path).exists() {
            return Err(Status::invalid_argument(format!(
                "App state archive not found: {local_path}"
            )));
        }

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    // Physical: extract the archive locally, then push each
                    // top-level child (`Documents`, `Library`, `tmp`) back
                    // into the app container via `devicectl device copy to
                    // --remove-existing-content true`. We terminate the app
                    // first so iOS isn't actively writing to the directories
                    // we're overwriting.
                    let scratch = tempfile::tempdir()
                        .map_err(|e| Status::internal(format!("tempdir: {e}")))?;
                    let scratch_path = scratch.path().to_string_lossy().to_string();
                    let extract = tokio::process::Command::new("tar")
                        .args(["xzf", local_path, "-C", &scratch_path])
                        .output()
                        .await;
                    match extract {
                        Ok(out) if !out.status.success() => {
                            let stderr = String::from_utf8_lossy(&out.stderr);
                            return Ok(self
                                .action_error(
                                    request_id,
                                    "APP_STATE_RESTORE_FAILED",
                                    format!("tar extract failed: {stderr}"),
                                )
                                .await);
                        }
                        Err(e) => {
                            return Ok(self
                                .action_error(
                                    request_id,
                                    "APP_STATE_RESTORE_FAILED",
                                    format!("Failed to run tar: {e}"),
                                )
                                .await);
                        }
                        _ => {}
                    }
                    // Collect top-level children that actually exist in the
                    // archive — we only want to push directories the user
                    // actually saved, so empty runs don't wipe the live data.
                    let mut sources: Vec<String> = Vec::new();
                    for name in ["Documents", "Library", "tmp"] {
                        let candidate = std::path::Path::new(&scratch_path).join(name);
                        if candidate.exists() {
                            sources.push(candidate.to_string_lossy().to_string());
                        }
                    }
                    if sources.is_empty() {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                "Archive contained no Documents/Library/tmp directories"
                                    .to_string(),
                            )
                            .await);
                    }
                    // Wipe the container by uninstalling + reinstalling the
                    // app. `devicectl copy to --remove-existing-content`
                    // alone would leave the app running and racing with
                    // our writes; wiping via reinstall is the same pattern
                    // we use for `clearAppData` and avoids every possible
                    // "process is holding files" edge case. After the
                    // reinstall the container is empty, so the subsequent
                    // copy just lays the saved state on top.
                    let app_path = self
                        .ios_agent_config
                        .read()
                        .await
                        .as_ref()
                        .and_then(|c| c.app_path.clone());
                    let Some(app_path) = app_path else {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                "device.restoreAppState on a physical iOS device requires \
                                 the app bundle path cached at startAgent time. Tapsmith's \
                                 CLI passes this automatically when `app` is set."
                                    .to_string(),
                            )
                            .await);
                    };
                    if let Err(e) = ios::device::uninstall_app_on_device(&serial, pkg).await {
                        warn!(error = %e, "Pre-restore uninstall failed, continuing");
                    }
                    if let Err(e) = ios::device::install_app_on_device(&serial, &app_path).await {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("Pre-restore reinstall failed: {e}"),
                            )
                            .await);
                    }
                    // Give LaunchServices a moment to re-register the
                    // freshly installed bundle before devicectl re-enters
                    // its sandbox to push the container contents.
                    tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
                    if let Err(e) =
                        ios::device::copy_app_container_to_device(&serial, pkg, &sources).await
                    {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("devicectl copy to failed: {e}"),
                            )
                            .await);
                    }
                    info!(%pkg, %local_path, "iOS physical app state restored");
                    // Reinstalling + pushing the container replaces the app
                    // bundle under the running XCUITest runner. The agent's
                    // cached XCUIApplication references become stale in a
                    // way that causes snapshots to return partial trees
                    // after the next launch — elements present in the
                    // hierarchy dump are missing from findElement. Restart
                    // the agent entirely so the new test session starts
                    // against fresh XCUITest bindings.
                    if let Err(e) = self
                        .restart_ios_agent_for_app(&serial, pkg, false, 10_000)
                        .await
                    {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("Agent restart after restore failed: {e}"),
                            )
                            .await);
                    }
                    return Ok(Self::success_action_response(request_id));
                }
                // iOS simulator: terminate the app, clear the data container,
                // then extract the saved archive.
                let _ = ios::device::terminate_app(&serial, pkg).await;

                let container = match self.get_app_container_cached(&serial, pkg).await {
                    Ok(path) => path,
                    Err(e) => {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("Failed to locate app container: {e}"),
                            )
                            .await);
                    }
                };

                // Clear the container in-place rather than rm -rf. Deleting
                // the container directory entirely can cause iOS to lose
                // its internal bundle-id → container UUID mapping, making
                // the app launch into a fresh container instead of the one
                // we extracted into.
                if let Err(e) = ios::device::clear_container(&container).await {
                    warn!(%pkg, error = %e, "clear_container failed, continuing");
                }

                // Archives saved by newer daemons carry the simulator
                // keychain under a reserved member; older archives don't,
                // and restore exactly as before.
                let has_keychain = match tokio::process::Command::new("tar")
                    .args(["tzf", local_path])
                    .output()
                    .await
                {
                    Ok(out) if out.status.success() => ios::device::archive_has_keychain_member(
                        &String::from_utf8_lossy(&out.stdout),
                    ),
                    _ => false,
                };

                // Exclude both the `./`-prefixed form (how bsdtar stores it
                // when we add it on save) and the bare form, so the keychain
                // member can never be extracted into the app container
                // regardless of how the archive recorded it.
                let member = ios::device::KEYCHAIN_ARCHIVE_MEMBER;
                let member_pattern = format!("./{member}");
                let output = tokio::process::Command::new("tar")
                    .args([
                        "xzf",
                        local_path,
                        "-C",
                        &container,
                        "--exclude",
                        &member_pattern,
                        "--exclude",
                        &format!("{member_pattern}/*"),
                        "--exclude",
                        member,
                        "--exclude",
                        &format!("{member}/*"),
                    ])
                    .output()
                    .await;

                match output {
                    Ok(out) if out.status.success() => {
                        if has_keychain && !ios::device::keychain_state_disabled() {
                            if let Err(e) =
                                restore_simulator_keychain(&serial, &container, local_path).await
                            {
                                // Failing silently here would reproduce the
                                // half-restored auth state this feature
                                // exists to fix — surface it instead.
                                return Ok(self
                                    .action_error(
                                        request_id,
                                        "APP_STATE_RESTORE_FAILED",
                                        format!("Keychain restore failed: {e}"),
                                    )
                                    .await);
                            }
                        } else if has_keychain {
                            debug!(%pkg, "Archive contains keychain state but TAPSMITH_NO_KEYCHAIN_STATE is set; skipping keychain restore");
                        } else {
                            debug!(%pkg, "Archive has no keychain member (saved by an older version); skipping keychain restore");
                        }
                        info!(%pkg, %local_path, container, "iOS simulator app state restored");
                        Ok(Self::success_action_response(request_id))
                    }
                    Ok(out) => {
                        let stderr = String::from_utf8_lossy(&out.stderr);
                        Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("tar extract failed: {stderr}"),
                            )
                            .await)
                    }
                    Err(e) => Ok(self
                        .action_error(
                            request_id,
                            "APP_STATE_RESTORE_FAILED",
                            format!("Failed to run tar: {e}"),
                        )
                        .await),
                }
            }
            Platform::Android => {
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
                        .action_error(
                            request_id,
                            "APP_STATE_RESTORE_FAILED",
                            format!("Failed to extract app state archive: {e}"),
                        )
                        .await);
                }

                // 6. Fix ownership and SELinux context (root only)
                if is_root {
                    let uid_output = match adb::shell_lenient(
                        &serial,
                        &format!("stat -c '%u' {data_dir}"),
                    )
                    .await
                    {
                        Ok(output) => output,
                        Err(e) => {
                            let _ =
                                adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                            return Ok(self
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
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                "Failed to determine app UID: stat returned empty output"
                                    .to_string(),
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
                    if let Err(e) =
                        android_keystore::restore_from_data_dir(&serial, pkg, &data_dir).await
                    {
                        return Ok(self
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
                Ok(Self::success_action_response(request_id))
            }
        }
    }

    // ─── Network Route Interception ───

    type NetworkRouteStream =
        Pin<Box<dyn Stream<Item = Result<proto::NetworkRouteServerMessage, Status>> + Send>>;

    async fn network_route(
        &self,
        request: Request<Streaming<proto::NetworkRouteClientMessage>>,
    ) -> Result<Response<Self::NetworkRouteStream>, Status> {
        info!("NetworkRoute stream opened");

        let mut inbound = request.into_inner();
        let network_proxy = self.network_proxy.clone();

        // Channel for server → client messages. Buffered to avoid blocking
        // the proxy on slow SDK consumers.
        let (to_sdk_tx, mut to_sdk_rx) =
            tokio::sync::mpsc::channel::<proto::NetworkRouteServerMessage>(256);

        let handler = Arc::new(RouteInterceptHandler::new(to_sdk_tx));
        let handler_for_proxy = handler.clone();

        // Store the handler so start_network_capture can install it on
        // newly created proxies (the stream may open before capture starts).
        *self.active_route_handler.write().await = Some(handler.clone());

        // Install the handler on the proxy if one is already running.
        {
            let proxy_guard = network_proxy.read().await;
            if let Some(proxy) = proxy_guard.as_ref() {
                proxy.set_handler(handler_for_proxy.clone()).await;
            }
        }

        // The output stream sends server messages to the client.
        let (out_tx, out_rx) =
            tokio::sync::mpsc::channel::<Result<proto::NetworkRouteServerMessage, Status>>(256);

        // Task: forward to_sdk_rx → out_tx
        let out_tx_fwd = out_tx.clone();
        tokio::spawn(async move {
            while let Some(msg) = to_sdk_rx.recv().await {
                if out_tx_fwd.send(Ok(msg)).await.is_err() {
                    break;
                }
            }
        });

        // Task: read inbound client messages and dispatch
        let handler_for_read = handler.clone();
        let out_tx_read = out_tx;
        let network_proxy_cleanup = network_proxy.clone();
        let active_route_handler_cleanup = self.active_route_handler.clone();
        tokio::spawn(async move {
            while let Some(result) = inbound.message().await.transpose() {
                let msg = match result {
                    Ok(m) => m,
                    Err(e) => {
                        debug!("NetworkRoute inbound error: {e}");
                        break;
                    }
                };

                let Some(inner) = msg.msg else { continue };
                match inner {
                    proto::network_route_client_message::Msg::RegisterRoute(req) => {
                        let route_id = req.route_id.clone();
                        let result = handler_for_read
                            .register_route(route_id.clone(), &req.url_pattern)
                            .await;
                        let resp = proto::NetworkRouteServerMessage {
                            msg: Some(
                                proto::network_route_server_message::Msg::RegisterRouteResponse(
                                    proto::RegisterRouteResponse {
                                        route_id,
                                        success: result.is_ok(),
                                        error_message: result.err().unwrap_or_default(),
                                    },
                                ),
                            ),
                        };
                        if out_tx_read.send(Ok(resp)).await.is_err() {
                            break;
                        }
                    }
                    proto::network_route_client_message::Msg::UnregisterRoute(req) => {
                        let success = handler_for_read.unregister_route(&req.route_id).await;
                        let resp = proto::NetworkRouteServerMessage {
                            msg: Some(
                                proto::network_route_server_message::Msg::UnregisterRouteResponse(
                                    proto::UnregisterRouteResponse {
                                        route_id: req.route_id,
                                        success,
                                    },
                                ),
                            ),
                        };
                        if out_tx_read.send(Ok(resp)).await.is_err() {
                            break;
                        }
                    }
                    proto::network_route_client_message::Msg::RouteDecision(decision) => {
                        handler_for_read.resolve_decision(decision).await;
                    }
                    proto::network_route_client_message::Msg::SubscribeEvents(_) => {
                        handler_for_read.subscribe_events().await;
                    }
                    proto::network_route_client_message::Msg::UnsubscribeEvents(_) => {
                        handler_for_read.unsubscribe_events().await;
                    }
                }
            }

            // Stream closed — clean up
            info!("NetworkRoute stream closed, releasing pending intercepts");
            handler_for_read.release_all_pending().await;

            // Guard cleanup on Arc-pointer identity: if a newer NetworkRoute
            // stream has already installed its handler in between, we must
            // not null out its state when our (now-stale) stream closes.
            // `Arc::ptr_eq` keeps comparison Send-safe (raw `*const T` is
            // not Send, which would break the surrounding `tokio::spawn`).
            let mut stored = active_route_handler_cleanup.write().await;
            let still_ours = stored
                .as_ref()
                .map(|h| Arc::ptr_eq(h, &handler_for_read))
                .unwrap_or(false);
            if still_ours {
                *stored = None;
                drop(stored);
                let proxy_guard = network_proxy_cleanup.read().await;
                if let Some(proxy) = proxy_guard.as_ref() {
                    proxy.clear_handler().await;
                }
            } else {
                debug!("NetworkRoute cleanup: newer handler already installed, skipping clear");
            }
        });

        let output_stream = tokio_stream::wrappers::ReceiverStream::new(out_rx);
        Ok(Response::new(Box::pin(output_stream)))
    }

    // ─── WebView Testing (PILOT-116) ───

    #[instrument(skip_all, fields(request_id))]
    async fn list_web_views(
        &self,
        request: Request<proto::ListWebViewsRequest>,
    ) -> Result<Response<proto::ListWebViewsResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let dm = self.device_manager.read().await;
        let device = dm.active_device().ok_or_else(|| {
            Status::failed_precondition("No active device — call SetDevice first")
        })?;
        let serial = device.serial.clone();
        let platform = device.platform;
        drop(dm);

        match platform {
            Platform::Android => match adb::list_webview_sockets(&serial).await {
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
            },
            // Note: the iOS TypeScript SDK connects directly to the simulator's
            // webinspectord socket (webkit-inspector.ts) and does not use this
            // RPC. This path exists as a server-side fallback via
            // ios-webkit-debug-proxy for potential future use.
            Platform::Ios => {
                #[cfg(target_os = "macos")]
                {
                    use crate::ios::webkit_debug_proxy::WebkitDebugProxyHandle;

                    let mut proxy_guard = self.webkit_debug_proxy.write().await;
                    if proxy_guard.is_none() {
                        match WebkitDebugProxyHandle::start(serial.clone(), 9221).await {
                            Ok(handle) => {
                                *proxy_guard = Some(handle);
                            }
                            Err(e) => {
                                return Ok(Response::new(proto::ListWebViewsResponse {
                                    request_id,
                                    webviews: Vec::new(),
                                    error_message: format!(
                                        "Failed to start ios_webkit_debug_proxy: {e}"
                                    ),
                                }));
                            }
                        }
                    }
                    let port = proxy_guard.as_ref().unwrap().port();
                    drop(proxy_guard);

                    // Query the proxy's HTTP endpoint for available targets
                    match query_cdp_json(port).await {
                        Ok(targets) => {
                            let webviews = targets
                                .into_iter()
                                .filter_map(|t| {
                                    let ws_url = t.get("webSocketDebuggerUrl")?.as_str()?;
                                    Some(proto::WebViewInfo {
                                        socket_name: ws_url.to_string(),
                                        pid: 0,
                                        package_name: String::new(),
                                        url: t
                                            .get("url")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                        title: t
                                            .get("title")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                    })
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
                                "Failed to query ios_webkit_debug_proxy: {e}. \
                                 Ensure Safari Web Inspector is enabled on the device \
                                 and the WebView has isInspectable = true (iOS 16.4+)."
                            ),
                        })),
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    Ok(Response::new(proto::ListWebViewsResponse {
                        request_id,
                        webviews: Vec::new(),
                        error_message: "iOS WebView testing requires macOS".to_string(),
                    }))
                }
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn forward_web_view_port(
        &self,
        request: Request<proto::ForwardWebViewPortRequest>,
    ) -> Result<Response<proto::ForwardWebViewPortResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let dm = self.device_manager.read().await;
        let device = dm.active_device().ok_or_else(|| {
            Status::failed_precondition("No active device — call SetDevice first")
        })?;
        let serial = device.serial.clone();
        let platform = device.platform;
        drop(dm);

        match platform {
            Platform::Android => {
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
                        self.webview_forwards
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
            Platform::Ios => {
                // For iOS, the socket_name IS the webSocketDebuggerUrl —
                // extract the port from it and return it directly since
                // ios_webkit_debug_proxy already exposes targets on localhost.
                let port = extract_port_from_ws_url(&req.socket_name).unwrap_or(0);
                if port == 0 {
                    return Ok(Response::new(proto::ForwardWebViewPortResponse {
                        request_id,
                        success: false,
                        local_port: 0,
                        error_message: format!(
                            "Failed to extract port from WebSocket URL: {}",
                            req.socket_name
                        ),
                    }));
                }
                Ok(Response::new(proto::ForwardWebViewPortResponse {
                    request_id,
                    success: true,
                    local_port: port as u32,
                    error_message: String::new(),
                }))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn close_web_view_port(
        &self,
        request: Request<proto::CloseWebViewPortRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let port = req.local_port as u16;

        // Only clean up ADB forwards (Android); iOS proxied ports are managed
        // by ios_webkit_debug_proxy and don't need individual cleanup.
        let removed = self.webview_forwards.write().await.remove(&port);
        if removed.is_some() {
            if let Some(serial) = self.device_manager.read().await.active_serial() {
                let serial = serial.to_string();
                if let Err(e) =
                    adb::remove_forward_with_timeout(&serial, port, WEBVIEW_ADB_CLEANUP_TIMEOUT)
                        .await
                {
                    warn!(port, "Failed to remove WebView port forward: {e}");
                }
            }
        }

        Ok(Response::new(proto::ActionResponse {
            request_id,
            success: true,
            error_type: String::new(),
            error_message: String::new(),
            screenshot: Vec::new(),
        }))
    }

    #[instrument(skip_all, fields(request_id))]
    async fn start_video_recording(
        &self,
        request: Request<proto::StartVideoRecordingRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        // The write lock is intentionally held across the discard and start
        // awaits below: the recording slot must stay claimed until the old
        // recorder has fully exited, because CoreSimulator allows only one
        // host capture at a time — a racing StartVideoRecording that saw an
        // empty slot mid-discard would spawn a recorder that fails with
        // "Resource busy" and silently records nothing.
        let mut video_recording = self.video_recording.write().await;
        if let Some(stale) = video_recording.take() {
            // Self-heal instead of refusing (PILOT-235): a recording still
            // active here was orphaned by a run that died before it could
            // call StopVideoRecording (stopped run, SIGKILLed worker,
            // crashed client). Refusing would break video for every later
            // run until the daemon restarts, while the orphaned recorder
            // churns CPU/disk indefinitely.
            warn!(
                "A video recording was still active at StartVideoRecording — \
                 discarding the orphan (its owning run likely stopped before \
                 calling StopVideoRecording) and starting fresh"
            );
            crate::video::discard(stale).await;
        }

        let serial = self.active_serial().await?;
        let platform = self.require_platform().await?;
        let size = if req.size_width > 0 && req.size_height > 0 {
            Some((req.size_width, req.size_height))
        } else {
            None
        };

        match crate::video::start(&serial, platform, size).await {
            Ok(handle) => {
                *video_recording = Some(handle);
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: true,
                    error_type: String::new(),
                    error_message: String::new(),
                    screenshot: Vec::new(),
                }))
            }
            Err(e) => {
                error!(error = %e, "StartVideoRecording failed");
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "start_failed".into(),
                    error_message: e.to_string(),
                    screenshot: Vec::new(),
                }))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn stop_video_recording(
        &self,
        request: Request<proto::StopVideoRecordingRequest>,
    ) -> Result<Response<proto::StopVideoRecordingResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let handle = self.video_recording.write().await.take();
        let Some(handle) = handle else {
            return Ok(Response::new(proto::StopVideoRecordingResponse {
                request_id,
                success: false,
                video_path: String::new(),
                error_message: "No active recording — did you call StartVideoRecording?".into(),
                duration_ms: 0,
            }));
        };

        match crate::video::stop(handle).await {
            Ok((video_path, elapsed)) => Ok(Response::new(proto::StopVideoRecordingResponse {
                request_id,
                success: true,
                video_path: video_path.to_string_lossy().into_owned(),
                error_message: String::new(),
                duration_ms: elapsed.as_millis() as u64,
            })),
            Err(e) => {
                error!(error = %e, "StopVideoRecording failed");
                Ok(Response::new(proto::StopVideoRecordingResponse {
                    request_id,
                    success: false,
                    video_path: String::new(),
                    error_message: e.to_string(),
                    duration_ms: 0,
                }))
            }
        }
    }

    // ─── Coordinate gesture handlers ───

    #[instrument(skip_all, fields(request_id))]
    async fn tap_coordinates(
        &self,
        request: Request<proto::TapCoordinatesRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let command = AgentCommand::TapCoordinates { x: req.x, y: req.y };
        let result = self.send_agent_command_with_timeout(&command, 0).await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn long_press_coordinates(
        &self,
        request: Request<proto::LongPressCoordinatesRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        // Same HID-first routing as `long_press` (see the rationale there).
        #[cfg(target_os = "macos")]
        if self
            .try_hid_long_press_coords(req.x, req.y, req.duration_ms)
            .await
        {
            return Ok(Self::success_action_response(request_id));
        }

        let command = AgentCommand::LongPressCoordinates {
            x: req.x,
            y: req.y,
            duration_ms: if req.duration_ms > 0 {
                req.duration_ms
            } else {
                1000
            },
        };
        let result = self.send_agent_command_with_timeout(&command, 0).await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn drag_coordinates(
        &self,
        request: Request<proto::DragCoordinatesRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let command = AgentCommand::DragCoordinates {
            from_x: req.from_x,
            from_y: req.from_y,
            to_x: req.to_x,
            to_y: req.to_y,
            duration_ms: if req.duration_ms > 0 {
                req.duration_ms
            } else {
                300
            },
        };
        let result = self.send_agent_command_with_timeout(&command, 0).await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn input_text(
        &self,
        request: Request<proto::InputTextRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let command = AgentCommand::InputText {
            text: req.text,
            typing_delay_ms: if req.typing_delay_ms > 0 {
                Some(req.typing_delay_ms)
            } else {
                None
            },
        };
        let result = self.send_agent_command_with_timeout(&command, 0).await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn touch_down(
        &self,
        request: Request<proto::TouchPointRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        if self
            .try_hid_touch(&format!("d {} {}", req.x, req.y), true)
            .await
        {
            return Self::hid_ok_response(request_id);
        }
        let command = AgentCommand::TouchDown {
            x: req.x,
            y: req.y,
            t_ms: req.t_ms,
        };
        let result = self.send_agent_command_with_timeout(&command, 0).await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn touch_move(
        &self,
        request: Request<proto::TouchPointRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        if self
            .try_hid_touch(&format!("m {} {}", req.x, req.y), false)
            .await
        {
            return Self::hid_ok_response(request_id);
        }
        let command = AgentCommand::TouchMove {
            x: req.x,
            y: req.y,
            t_ms: req.t_ms,
        };
        let result = self.send_agent_command_with_timeout(&command, 0).await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn touch_up(
        &self,
        request: Request<proto::TouchPointRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        if self
            .try_hid_touch(&format!("u {} {}", req.x, req.y), false)
            .await
        {
            return Self::hid_ok_response(request_id);
        }
        let command = AgentCommand::TouchUp {
            x: req.x,
            y: req.y,
            t_ms: req.t_ms,
        };
        let result = self.send_agent_command_with_timeout(&command, 0).await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn touch_cancel(
        &self,
        request: Request<proto::TouchCancelRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        if self.try_hid_touch("c", false).await {
            return Self::hid_ok_response(request_id);
        }
        let command = AgentCommand::TouchCancel {};
        let result = self.send_agent_command_with_timeout(&command, 0).await;
        self.make_action_response(request_id, result).await
    }
}

/// Extract port number from a WebSocket URL like `ws://localhost:9222/devtools/page/1`
fn extract_port_from_ws_url(url: &str) -> Option<u16> {
    let url = url
        .strip_prefix("ws://")
        .or_else(|| url.strip_prefix("wss://"))?;
    let host_port = url.split('/').next()?;
    let port_str = host_port.rsplit(':').next()?;
    port_str.parse().ok()
}

/// Query a CDP-compatible endpoint's /json page to list available targets.
/// Uses a raw TCP connection + HTTP/1.1 GET to avoid adding an HTTP client dependency.
#[cfg(target_os = "macos")]
async fn query_cdp_json(port: u16) -> anyhow::Result<Vec<serde_json::Value>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).await?;
    stream
        .write_all(
            format!("GET /json HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await?;

    let mut buf = Vec::with_capacity(8192);
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        stream.read_to_end(&mut buf),
    )
    .await
    .map_err(|_| anyhow::anyhow!("CDP /json read timed out after 10s"))??;
    let response = String::from_utf8_lossy(&buf);

    // Skip HTTP headers — find the first blank line separating headers from body
    let body = response
        .find("\r\n\r\n")
        .map(|pos| &response[pos + 4..])
        .unwrap_or(&response);

    let targets: Vec<serde_json::Value> = serde_json::from_str(body)?;
    Ok(targets)
}

// ─── Helper: Parse ElementInfo from agent JSON ───

pub(crate) fn parse_element_info(data: &Value) -> Option<proto::ElementInfo> {
    let el = if data.get("element").is_some() {
        data.get("element")?
    } else {
        data
    };

    Some(proto::ElementInfo {
        element_id: json_str(el, "elementId"),
        class_name: json_str(el, "className"),
        text: json_str(el, "text"),
        content_description: json_str(el, "contentDescription"),
        resource_id: json_str(el, "resourceId"),
        enabled: json_bool(el, "enabled"),
        visible: json_bool(el, "visible"),
        clickable: json_bool(el, "clickable"),
        focusable: json_bool(el, "focusable"),
        scrollable: json_bool(el, "scrollable"),
        bounds: parse_bounds(el.get("bounds")),
        hint: json_str(el, "hint"),
        checked: json_bool(el, "checked"),
        selected: json_bool(el, "selected"),
        focused: json_bool(el, "focused"),
        role: json_str(el, "role"),
        viewport_ratio: json_float(el, "viewportRatio"),
    })
}

pub(crate) fn parse_element_list(data: &Value) -> Vec<proto::ElementInfo> {
    let arr = data
        .get("elements")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    arr.iter().filter_map(parse_element_info).collect()
}

pub(crate) fn parse_bounds(value: Option<&Value>) -> Option<proto::Bounds> {
    let b = value?;
    Some(proto::Bounds {
        left: b.get("left").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        top: b.get("top").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        right: b.get("right").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        bottom: b.get("bottom").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
    })
}

pub(crate) fn json_str(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

pub(crate) fn json_bool(v: &Value, key: &str) -> bool {
    v.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

pub(crate) fn json_float(v: &Value, key: &str) -> f32 {
    v.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32
}

/// Parse a component name (package/activity) from `dumpsys activity` output.
///
/// The output line looks like:
///   `mResumedActivity: ActivityRecord{abcdef0 u0 com.example.app/.MainActivity t123}`
///
/// Returns `Some((package, activity))` or `None` if parsing fails.
fn parse_component_name(dumpsys_output: &str) -> Option<(String, String)> {
    // Look for a token that matches the pattern: word-chars-and-dots / word-chars-and-dots
    // Component names contain [a-zA-Z0-9._$] separated by a single '/'.
    for token in dumpsys_output.split_whitespace() {
        let token = token.trim_end_matches('}');
        if let Some(slash_pos) = token.find('/') {
            let pkg = &token[..slash_pos];
            let act = &token[slash_pos + 1..];
            // A valid component has a package with at least one dot and a non-empty activity
            if pkg.contains('.')
                && !act.is_empty()
                && pkg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
                && act
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '$')
            {
                return Some((pkg.to_string(), act.to_string()));
            }
        }
    }
    None
}

/// True when the UIAutomator hierarchy has at least one node belonging to
/// `package_name` that carries text or a content description — i.e. the app
/// has drawn real UI, not just its bare Activity/splash window.
fn android_hierarchy_has_rendered_content(xml: &str, package_name: &str) -> bool {
    let needle = format!("package=\"{package_name}\"");
    for node in xml.split("<node").skip(1) {
        let end = node.find('>').map(|i| &node[..i]).unwrap_or(node);
        if !end.contains(&needle) {
            continue;
        }
        let has_text = end
            .split_once("text=\"")
            .map(|(_, rest)| !rest.starts_with('"'))
            .unwrap_or(false);
        let has_desc = end
            .split_once("content-desc=\"")
            .map(|(_, rest)| !rest.starts_with('"'))
            .unwrap_or(false);
        if has_text || has_desc {
            return true;
        }
    }
    false
}

fn parse_resolved_activity(output: &str, package_name: &str) -> Option<String> {
    let (pkg, activity) = parse_component_name(output)?;
    if pkg == package_name {
        Some(activity)
    } else {
        None
    }
}

fn android_reverse_port_candidates(host_port: u16) -> Vec<u16> {
    let mut ports = Vec::with_capacity(ANDROID_REVERSE_PORT_FALLBACK_COUNT + 1);
    ports.push(host_port);

    let span = u32::from(ANDROID_REVERSE_PORT_FALLBACK_SPAN);
    let mut offset = (u32::from(host_port) * 37) % span;
    for _ in 0..ANDROID_REVERSE_PORT_FALLBACK_COUNT {
        let port = ANDROID_REVERSE_PORT_FALLBACK_BASE + offset as u16;
        if !ports.contains(&port) {
            ports.push(port);
        }
        offset = (offset + ANDROID_REVERSE_PORT_FALLBACK_STEP) % span;
    }

    ports
}

fn is_terminal_adb_reverse_error(error: &str) -> bool {
    let msg = error.to_ascii_lowercase();
    msg.contains("device offline")
        || msg.contains("device not found")
        || (msg.contains("device '") && msg.contains("' not found"))
        || msg.contains("no devices/emulators found")
        || msg.contains("more than one device/emulator")
        || msg.contains("multiple devices")
}

fn captured_entries_to_proto(
    entries: Vec<crate::network_proxy::CapturedEntry>,
    capture_session: &str,
) -> Vec<proto::CapturedNetworkEntry> {
    entries
        .into_iter()
        .map(|e| captured_entry_to_proto(e, capture_session))
        .collect()
}

fn captured_entry_to_proto(
    e: crate::network_proxy::CapturedEntry,
    capture_session: &str,
) -> proto::CapturedNetworkEntry {
    proto::CapturedNetworkEntry {
        method: e.method,
        url: e.url,
        status_code: e.status_code,
        content_type: e.content_type,
        request_size: e.request_size,
        response_size: e.response_size,
        start_time_ms: e.start_time_ms,
        duration_ms: e.duration_ms,
        request_headers_json: crate::network_proxy::headers_to_json_object(&e.request_headers)
            .to_string(),
        response_headers_json: crate::network_proxy::headers_to_json_object(&e.response_headers)
            .to_string(),
        request_body: e.request_body,
        response_body: e.response_body,
        is_https: e.is_https,
        route_action: e.route_action,
        in_flight: e.in_flight,
        capture_id: format!("{capture_session}:{}", e.capture_id),
        request_body_omitted: false,
        response_body_omitted: false,
    }
}

async fn setup_android_reverse_with_fallback(
    serial: &str,
    host_port: u16,
) -> std::result::Result<u16, String> {
    let candidates = android_reverse_port_candidates(host_port);
    let mut errors = Vec::new();

    for (idx, device_port) in candidates.iter().copied().enumerate() {
        match adb::reverse_port(serial, device_port, host_port).await {
            Ok(()) => {
                if idx > 0 {
                    info!(
                        %serial,
                        device_port,
                        host_port,
                        "adb reverse configured on fallback device port"
                    );
                }
                return Ok(device_port);
            }
            Err(first_err) => {
                let first_err = first_err.to_string();
                if is_terminal_adb_reverse_error(&first_err) {
                    return Err(first_err);
                }

                warn!(
                    %serial,
                    device_port,
                    host_port,
                    "adb reverse setup failed; removing any stale reverse mapping and retrying: {first_err}"
                );
                errors.push(format!("tcp:{device_port}: {first_err}"));

                if let Err(remove_err) = adb::remove_reverse_with_timeout(
                    serial,
                    device_port,
                    ANDROID_PROXY_CLEANUP_TIMEOUT,
                )
                .await
                {
                    warn!(
                        %serial,
                        device_port,
                        "Failed to remove stale adb reverse mapping before retry: {remove_err}"
                    );
                }

                match adb::reverse_port(serial, device_port, host_port).await {
                    Ok(()) => {
                        if idx > 0 {
                            info!(
                                %serial,
                                device_port,
                                host_port,
                                "adb reverse configured on fallback device port after cleanup"
                            );
                        }
                        return Ok(device_port);
                    }
                    Err(retry_err) => {
                        warn!(
                            %serial,
                            device_port,
                            host_port,
                            "adb reverse retry failed: {retry_err}"
                        );
                        errors.push(format!("tcp:{device_port} after cleanup: {retry_err}"));
                    }
                }
            }
        }
    }

    Err(format!(
        "Failed to set up adb reverse for network capture after trying device ports {}: {}",
        candidates
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(", "),
        errors.join("; ")
    ))
}

/// Best-effort TCP connect from this process out to `host:port`, for testing
/// whether our own LAN listener is reachable from the network interface.
///
/// Used on physical iOS to catch the macOS Application Firewall stealth-mode
/// failure mode: the proxy binds cleanly on `0.0.0.0`, loopback self-tests
/// work, but unsolicited inbound packets from the LAN are silently dropped
/// by the firewall and the device never reaches the proxy.
///
/// Returns `true` if the connection establishes within 1.5 seconds, `false`
/// otherwise. We don't distinguish between "no route", "RST", and "timeout"
/// — any failure means the proxy isn't reachable as the iOS device sees it.
#[cfg(target_os = "macos")]
async fn self_probe_lan_listener(lan_ip: std::net::Ipv4Addr, port: u16) -> bool {
    use tokio::net::TcpStream;
    use tokio::time::timeout;
    let addr = std::net::SocketAddr::new(std::net::IpAddr::V4(lan_ip), port);
    matches!(
        timeout(Duration::from_millis(1_500), TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

/// Real device work behind the reset ladder — one instance per `ResetApp` call.
struct ServiceResetOps<'a> {
    svc: &'a TapsmithServiceImpl,
    serial: String,
    package: String,
    marker: Option<app_reset::HooksMarker>,
    target_path: String,
    wait_for_idle: bool,
    idle_timeout_ms: u64,
}

impl ServiceResetOps<'_> {
    fn response_error(resp: &proto::ActionResponse) -> String {
        if resp.error_message.is_empty() {
            format!("{} failed", resp.error_type)
        } else {
            resp.error_message.clone()
        }
    }
}

#[async_trait::async_trait]
impl app_reset::ResetOps for ServiceResetOps<'_> {
    async fn warm_hooks(&self, cold: bool) -> Result<app_reset::WarmAck, String> {
        let marker = self
            .marker
            .as_ref()
            .ok_or_else(|| "no in-app reset hooks detected".to_string())?;
        let url = app_reset::build_reset_url(
            &marker.url_prefix,
            &self.target_path,
            &Uuid::new_v4().simple().to_string(),
        );
        // A warm reset onto a non-root route may land on a screen that hides
        // the marker (see below), where no amount of relaunching can read the
        // epoch either — so deliver warm-only and keep the cheap root-route
        // re-confirmation as the recovery, instead of three terminate →
        // relaunch cycles (~45s) ahead of it. A cold delivery (retry attempt,
        // warm-window valve) must still relaunch, so it keeps the cold path.
        let non_root_target = self.target_path != "/" && !marker.url_prefix.is_empty();
        let delivery = if cold {
            DeepLinkDelivery::Cold
        } else if non_root_target {
            DeepLinkDelivery::WarmOnly
        } else {
            DeepLinkDelivery::WarmThenCold
        };
        // The marker's per-process `boot` token tells a relaunch apart from an
        // in-process reset — `hooks_acknowledged` already accepts either.
        let process_recreated = |after: &app_reset::HooksMarker| matches!((marker.boot.as_deref(), after.boot.as_deref()), (Some(b), Some(a)) if a != b);
        let resp = self
            .svc
            .deliver_deep_link(
                Uuid::new_v4().to_string(),
                &url,
                delivery,
                Some(marker.epoch),
                marker.boot.clone(),
            )
            .await
            .map_err(|e| e.message().to_string())?
            .into_inner();
        if !resp.success {
            // The reset was delivered but its epoch could not be read back on
            // the target screen. Some routes render an accessibility-modal that
            // hides even the always-present marker from the hierarchy — a
            // navigator's not-found screen (an unknown `target`), or a
            // full-screen modal — so the epoch is invisible although the reset
            // ran. Navigate to the app's root route (which renders a readable
            // screen) and re-read the epoch: if it advanced, the reset
            // succeeded. Only for a non-root target — root is where we would
            // land anyway. After a cold delivery the process is new and the
            // ack compares against the old boot token, so it needs epoch >= 1
            // in that process — a relaunch that dropped the reset URL (epoch
            // 0) is still not mistaken for a reset that ran.
            if non_root_target {
                // Re-deliver the reset to the root route. Its own ack-wait runs
                // on the readable Home screen, so the epoch it produces is
                // observable (the reset is idempotent — clearing state twice is
                // harmless — and landing on root is a sane outcome for a target
                // that would not render anyway).
                let root_url = app_reset::build_reset_url(
                    &marker.url_prefix,
                    "/",
                    &Uuid::new_v4().simple().to_string(),
                );
                if let Ok(retry) = self
                    .svc
                    .deliver_deep_link(
                        Uuid::new_v4().to_string(),
                        &root_url,
                        DeepLinkDelivery::WarmThenCold,
                        Some(marker.epoch),
                        marker.boot.clone(),
                    )
                    .await
                {
                    if retry.into_inner().success {
                        return match self.svc.current_hooks_marker(5_000).await {
                            Some(after)
                                if app_reset::hooks_acknowledged(
                                    marker.epoch,
                                    marker.boot.as_deref(),
                                    &after,
                                ) =>
                            {
                                let recreated = process_recreated(&after);
                                *self.svc.last_hooks_marker.write().await = Some(after.clone());
                                match after.err {
                                    Some(err) => {
                                        Err(format!("in-app reset reported an error: {err}"))
                                    }
                                    None => Ok(app_reset::WarmAck {
                                        epoch: after.epoch,
                                        process_recreated: recreated,
                                    }),
                                }
                            }
                            // Delivery's settle already enforced the epoch on
                            // root; a missed read here is just a mid-transition
                            // hierarchy — trust it and remember the advance.
                            // After a cold delivery the boot token is new and
                            // unknown: forget the baseline rather than remember
                            // the old boot (see the same arm below).
                            _ => {
                                if cold {
                                    *self.svc.last_hooks_marker.write().await = None;
                                } else {
                                    let mut remembered = marker.clone();
                                    remembered.epoch += 1;
                                    *self.svc.last_hooks_marker.write().await = Some(remembered);
                                }
                                Ok(app_reset::WarmAck {
                                    epoch: marker.epoch + 1,
                                    process_recreated: false,
                                })
                            }
                        };
                    }
                }
            }
            return Err(Self::response_error(&resp));
        }
        // Read back the acknowledged epoch (and any error the hook reported).
        // Either way the remembered marker moves to the post-reset epoch: the
        // next reset's live read can miss, and acknowledging against a
        // baseline one reset behind would pass on the epoch this reset
        // already produced — success for a reset that never ran.
        match self.svc.current_hooks_marker(5_000).await {
            Some(after)
                if app_reset::hooks_acknowledged(marker.epoch, marker.boot.as_deref(), &after) =>
            {
                let recreated = process_recreated(&after);
                *self.svc.last_hooks_marker.write().await = Some(after.clone());
                match after.err {
                    Some(err) => Err(format!("in-app reset reported an error: {err}")),
                    None => Ok(app_reset::WarmAck {
                        epoch: after.epoch,
                        process_recreated: recreated,
                    }),
                }
            }
            Some(_) => Err("in-app reset did not advance its epoch".to_string()),
            // The ack was already positively verified — Android's settle loop
            // enforces the epoch daemon-side, and an iOS success without an
            // echoed `epochAfter` is downgraded to a failure
            // (`require_epoch_ack_echo`) — so a missed read here is just a
            // mid-transition hierarchy. Trust the delivery.
            None => {
                if cold {
                    // A cold delivery relaunched the process: its boot token is
                    // new and unknown here. Remembering the old boot with a
                    // bumped epoch would make the next missed live read accept
                    // any epoch >= 1 in the new process ("boot changed") before
                    // that reset ran. Forget the baseline; the next reset's
                    // live read re-establishes it.
                    *self.svc.last_hooks_marker.write().await = None;
                } else {
                    let mut remembered = marker.clone();
                    remembered.epoch += 1;
                    *self.svc.last_hooks_marker.write().await = Some(remembered);
                }
                // The boot token is unknown here; `cold` already says whether
                // the plan relaunched.
                Ok(app_reset::WarmAck {
                    epoch: marker.epoch + 1,
                    process_recreated: false,
                })
            }
        }
    }

    async fn warm_deep_link(&self, link: &str, cold: bool) -> Result<(), String> {
        let delivery = if cold {
            DeepLinkDelivery::Cold
        } else {
            DeepLinkDelivery::WarmThenCold
        };
        let resp = self
            .svc
            .deliver_deep_link(Uuid::new_v4().to_string(), link, delivery, None, None)
            .await
            .map_err(|e| e.message().to_string())?
            .into_inner();
        if resp.success {
            Ok(())
        } else {
            Err(Self::response_error(&resp))
        }
    }

    async fn restart(&self) -> Result<(), String> {
        self.svc
            .restart_app_inner(
                &self.serial,
                &self.package,
                self.wait_for_idle,
                self.idle_timeout_ms,
            )
            .await
    }

    async fn clear(&self) -> Result<(), String> {
        self.svc
            .clear_app_data_inner(&self.serial, &self.package)
            .await?;
        self.svc
            .restart_app_inner(
                &self.serial,
                &self.package,
                self.wait_for_idle,
                self.idle_timeout_ms,
            )
            .await
    }
}

/// An applied port set is meaningful only while its redirect still exists.
fn capture_port_update(
    applied: &[u16],
    requested: &[u16],
    uses_iptables: bool,
    reverse_port: Option<u16>,
) -> Result<Option<u16>, &'static str> {
    if !uses_iptables {
        return if requested.is_empty() {
            Ok(None)
        } else {
            Err("networkHttpPorts was not applied: Android transparent iptables capture is unavailable")
        };
    }
    let port =
        reverse_port.ok_or("Android capture redirect has no reverse port; restart capture")?;
    Ok((applied != requested).then_some(port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn embedded_root_defaults_are_skipped_only_for_android() {
        // Android's Firestore (gRPC-Java) honours the platform trust store, so
        // the built-in passthrough default would hide capturable traffic.
        assert_eq!(
            TapsmithServiceImpl::embedded_root_defaults_for(Some(Platform::Android)),
            EmbeddedRootDefaults::Skip
        );
        // iOS compiles its gRPC roots into the app binary — keep tunneling.
        assert_eq!(
            TapsmithServiceImpl::embedded_root_defaults_for(Some(Platform::Ios)),
            EmbeddedRootDefaults::Apply
        );
        // No device selected: tunnel rather than risk breaking the app.
        assert_eq!(
            TapsmithServiceImpl::embedded_root_defaults_for(None),
            EmbeddedRootDefaults::Apply
        );
    }

    #[test]
    fn android_reverse_port_candidates_start_with_host_port_then_fallbacks() {
        let host_port = 52_341;
        let ports = android_reverse_port_candidates(host_port);

        assert_eq!(ports[0], host_port);
        assert!(ports.len() > 1);
        for port in &ports[1..] {
            assert!(*port >= ANDROID_REVERSE_PORT_FALLBACK_BASE);
            assert!(
                *port < ANDROID_REVERSE_PORT_FALLBACK_BASE + ANDROID_REVERSE_PORT_FALLBACK_SPAN
            );
        }
        for (idx, port) in ports.iter().enumerate() {
            assert!(!ports[..idx].contains(port));
        }
    }

    #[test]
    fn started_agent_config_ignores_request_id_and_normalizes_empty_ios_app_artifact() {
        let mut req = proto::StartAgentRequest {
            request_id: "req-1".to_string(),
            target_package: "com.example.app".to_string(),
            agent_apk_path: "agent.apk".to_string(),
            agent_test_apk_path: "agent-test.apk".to_string(),
            ios_xctestrun_path: "Runner.xctestrun".to_string(),
            ios_app_path: String::new(),
            network_tracing_enabled: true,
        };
        let first = StartedAgentConfig::from_start_agent_request("device-1", Platform::Ios, &req);

        req.request_id = "req-2".to_string();
        let second = StartedAgentConfig::from_start_agent_request("device-1", Platform::Ios, &req);

        assert_eq!(first, second);
        assert_eq!(first.ios_app, None);
    }

    #[test]
    fn started_agent_config_includes_device_platform_and_startup_inputs() {
        let req = proto::StartAgentRequest {
            request_id: String::new(),
            target_package: "com.example.app".to_string(),
            agent_apk_path: "agent.apk".to_string(),
            agent_test_apk_path: "agent-test.apk".to_string(),
            ios_xctestrun_path: "Runner.xctestrun".to_string(),
            ios_app_path: "Example.app".to_string(),
            network_tracing_enabled: false,
        };

        let base =
            StartedAgentConfig::from_start_agent_request("device-1", Platform::Android, &req);
        let different_device =
            StartedAgentConfig::from_start_agent_request("device-2", Platform::Android, &req);
        let different_platform =
            StartedAgentConfig::from_start_agent_request("device-1", Platform::Ios, &req);

        let mut changed_req = req.clone();
        changed_req.agent_apk_path = "other-agent.apk".to_string();
        let different_startup_input = StartedAgentConfig::from_start_agent_request(
            "device-1",
            Platform::Android,
            &changed_req,
        );

        assert_ne!(base, different_device);
        assert_ne!(base, different_platform);
        assert_ne!(base, different_startup_input);
        assert_eq!(
            base.ios_app.as_ref().map(|artifact| artifact.path.as_str()),
            Some("Example.app")
        );
    }

    #[test]
    fn startup_artifact_identity_tracks_file_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent.apk");
        std::fs::write(&path, b"old").unwrap();
        let path = path.to_str().unwrap();

        let first = StartupArtifactIdentity::from_path(path).unwrap();
        std::fs::write(path, b"newer").unwrap();
        let second = StartupArtifactIdentity::from_path(path).unwrap();

        assert_eq!(first.path, path);
        assert_eq!(second.path, path);
        assert_ne!(first, second);
        assert_eq!(first.len, Some(3));
        assert_eq!(second.len, Some(5));
    }

    #[test]
    fn terminal_adb_reverse_error_matches_unavailable_devices() {
        assert!(is_terminal_adb_reverse_error(
            "adb command failed (exit exit status: 1): adb: device offline"
        ));
        assert!(is_terminal_adb_reverse_error(
            "adb command failed (exit exit status: 1): error: device 'emulator-5554' not found"
        ));
        assert!(is_terminal_adb_reverse_error(
            "adb command failed (exit exit status: 1): error: no devices/emulators found"
        ));
        assert!(is_terminal_adb_reverse_error(
            "adb command failed (exit exit status: 1): error: more than one device/emulator"
        ));
    }

    #[test]
    fn terminal_adb_reverse_error_ignores_port_specific_failures() {
        assert!(!is_terminal_adb_reverse_error(
            "adb command failed (exit exit status: 1): cannot bind listener: Address already in use"
        ));
    }

    // ─── selector_to_json ───

    #[test]
    fn selector_to_json_text() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::Text("Login".into())),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["text"], "Login");
    }

    #[test]
    fn selector_to_json_role_with_name() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::Role(proto::RoleSelector {
                role: "button".into(),
                name: "Submit".into(),
                checked: None,
                disabled: None,
                selected: None,
                expanded: None,
            })),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["role"]["role"], "button");
        assert_eq!(j["role"]["name"], "Submit");
    }

    #[test]
    fn selector_to_json_role_with_state_filters() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::Role(proto::RoleSelector {
                role: "switch".into(),
                name: "Dark Mode".into(),
                checked: Some(true),
                disabled: Some(true),
                selected: None,
                expanded: Some(false),
            })),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["role"]["role"], "switch");
        assert_eq!(j["role"]["name"], "Dark Mode");
        assert_eq!(j["checked"], true);
        assert_eq!(j["enabled"], false); // disabled=true → enabled=false
        assert!(j.get("selected").is_none());
        assert_eq!(j["expanded"], false);
    }

    #[test]
    fn selector_to_json_content_desc() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::ContentDesc("Back button".into())),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["contentDesc"], "Back button");
    }

    #[test]
    fn selector_to_json_text_contains() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::TextContains("Welcome".into())),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["textContains"], "Welcome");
    }

    #[test]
    fn selector_to_json_hint() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::Hint("Enter email".into())),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["hint"], "Enter email");
    }

    #[test]
    fn selector_to_json_class_name() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::ClassName(
                "android.widget.Button".into(),
            )),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["className"], "android.widget.Button");
    }

    #[test]
    fn selector_to_json_test_id() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::TestId("login-btn".into())),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["testId"], "login-btn");
    }

    #[test]
    fn selector_to_json_resource_id() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::ResourceId(
                "com.app:id/btn".into(),
            )),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["resourceId"], "com.app:id/btn");
    }

    #[test]
    fn selector_to_json_xpath() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::Xpath(
                "//button[@text='OK']".into(),
            )),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["xpath"], "//button[@text='OK']");
    }

    #[test]
    fn selector_to_json_label() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::Label("Email".into())),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["label"], "Email");
    }

    #[test]
    fn selector_to_json_with_parent() {
        let parent = proto::Selector {
            selector: Some(proto::selector::Selector::ResourceId(
                "com.app:id/toolbar".into(),
            )),
            parent: None,
        };
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::Text("Save".into())),
            parent: Some(Box::new(parent)),
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["text"], "Save");
        assert_eq!(j["parent"]["resourceId"], "com.app:id/toolbar");
    }

    #[test]
    fn selector_to_json_no_selector_set() {
        let sel = proto::Selector {
            selector: None,
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j, json!({}));
    }

    // ─── parse_element_info ───

    #[test]
    fn parse_element_info_valid() {
        let data = json!({
            "elementId": "e1",
            "className": "android.widget.Button",
            "text": "Click me",
            "contentDescription": "A button",
            "resourceId": "com.app:id/btn",
            "enabled": true,
            "visible": true,
            "clickable": true,
            "focusable": false,
            "scrollable": false,
            "hint": "tap here",
            "checked": false,
            "selected": true,
            "focused": true,
            "role": "button",
            "viewportRatio": 0.75,
            "bounds": { "left": 10, "top": 20, "right": 100, "bottom": 60 }
        });
        let el = parse_element_info(&data).unwrap();
        assert_eq!(el.element_id, "e1");
        assert_eq!(el.class_name, "android.widget.Button");
        assert_eq!(el.text, "Click me");
        assert_eq!(el.content_description, "A button");
        assert_eq!(el.resource_id, "com.app:id/btn");
        assert!(el.enabled);
        assert!(el.visible);
        assert!(el.clickable);
        assert!(!el.focusable);
        assert!(!el.scrollable);
        assert_eq!(el.hint, "tap here");
        assert!(!el.checked);
        assert!(el.selected);
        assert!(el.focused);
        assert_eq!(el.role, "button");
        assert!((el.viewport_ratio - 0.75).abs() < 0.01);
        let b = el.bounds.unwrap();
        assert_eq!((b.left, b.top, b.right, b.bottom), (10, 20, 100, 60));
    }

    #[test]
    fn parse_element_info_missing_fields() {
        let data = json!({});
        let el = parse_element_info(&data).unwrap();
        assert_eq!(el.element_id, "");
        assert_eq!(el.text, "");
        assert!(!el.enabled);
        assert!(!el.focused);
        assert_eq!(el.role, "");
        assert_eq!(el.viewport_ratio, 0.0);
        assert!(el.bounds.is_none());
    }

    #[test]
    fn parse_element_info_nested_element_key() {
        let data = json!({
            "element": {
                "elementId": "nested-1",
                "text": "Nested",
                "enabled": true
            }
        });
        let el = parse_element_info(&data).unwrap();
        assert_eq!(el.element_id, "nested-1");
        assert_eq!(el.text, "Nested");
        assert!(el.enabled);
    }

    // ─── parse_element_list ───

    #[test]
    fn parse_element_list_empty() {
        let data = json!({"elements": []});
        let list = parse_element_list(&data);
        assert!(list.is_empty());
    }

    #[test]
    fn parse_element_list_multiple() {
        let data = json!({
            "elements": [
                {"elementId": "a", "text": "First"},
                {"elementId": "b", "text": "Second"}
            ]
        });
        let list = parse_element_list(&data);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].element_id, "a");
        assert_eq!(list[1].element_id, "b");
        assert_eq!(list[0].text, "First");
        assert_eq!(list[1].text, "Second");
    }

    #[test]
    fn parse_element_list_missing_key() {
        let data = json!({});
        let list = parse_element_list(&data);
        assert!(list.is_empty());
    }

    // ─── parse_bounds ───

    #[test]
    fn parse_bounds_valid() {
        let v = json!({"left": 5, "top": 10, "right": 200, "bottom": 150});
        let b = parse_bounds(Some(&v)).unwrap();
        assert_eq!(b.left, 5);
        assert_eq!(b.top, 10);
        assert_eq!(b.right, 200);
        assert_eq!(b.bottom, 150);
    }

    #[test]
    fn parse_bounds_none() {
        assert!(parse_bounds(None).is_none());
    }

    #[test]
    fn parse_bounds_partial_fields() {
        let v = json!({"left": 1});
        let b = parse_bounds(Some(&v)).unwrap();
        assert_eq!(b.left, 1);
        assert_eq!(b.top, 0);
        assert_eq!(b.right, 0);
        assert_eq!(b.bottom, 0);
    }

    // ─── opt_timeout ───

    #[test]
    fn opt_timeout_zero_returns_none() {
        assert!(opt_timeout(0).is_none());
    }

    #[test]
    fn opt_timeout_positive_returns_some() {
        assert_eq!(opt_timeout(5000), Some(5000));
        assert_eq!(opt_timeout(1), Some(1));
    }

    // ─── json_str / json_bool ───

    #[test]
    fn json_str_present() {
        let v = json!({"name": "hello"});
        assert_eq!(json_str(&v, "name"), "hello");
    }

    #[test]
    fn json_str_missing() {
        let v = json!({});
        assert_eq!(json_str(&v, "name"), "");
    }

    #[test]
    fn json_bool_present() {
        let v = json!({"flag": true});
        assert!(json_bool(&v, "flag"));
    }

    #[test]
    fn json_bool_missing() {
        let v = json!({});
        assert!(!json_bool(&v, "flag"));
    }

    // ─── parse_component_name ───

    #[test]
    fn parse_component_name_typical() {
        let output =
            "  mResumedActivity: ActivityRecord{abcdef0 u0 com.example.app/.MainActivity t123}";
        let (pkg, act) = parse_component_name(output).unwrap();
        assert_eq!(pkg, "com.example.app");
        assert_eq!(act, ".MainActivity");
    }

    #[test]
    fn parse_component_name_full_activity() {
        let output = "  mResumedActivity: ActivityRecord{abc u0 com.example.app/com.example.app.settings.ProfileActivity t5}";
        let (pkg, act) = parse_component_name(output).unwrap();
        assert_eq!(pkg, "com.example.app");
        assert_eq!(act, "com.example.app.settings.ProfileActivity");
    }

    #[test]
    fn parse_component_name_empty_output() {
        assert!(parse_component_name("").is_none());
    }

    #[test]
    fn parse_component_name_no_match() {
        assert!(parse_component_name("  mResumedActivity: null").is_none());
    }

    #[test]
    fn parse_component_name_ignores_paths() {
        // Should not match filesystem paths like /data/local/tmp
        let output = "  mResumedActivity: /data/local/tmp ActivityRecord{abc u0 com.foo/.Bar t1}";
        let (pkg, act) = parse_component_name(output).unwrap();
        assert_eq!(pkg, "com.foo");
        assert_eq!(act, ".Bar");
    }

    #[test]
    fn android_rendered_content_needs_app_text_or_desc() {
        let splash = r#"<hierarchy><node package="com.example.app" class="android.widget.FrameLayout" text="" content-desc=""/></hierarchy>"#;
        assert!(!android_hierarchy_has_rendered_content(
            splash,
            "com.example.app"
        ));
        let rendered = r#"<hierarchy><node package="com.example.app" text="Home"/></hierarchy>"#;
        assert!(android_hierarchy_has_rendered_content(
            rendered,
            "com.example.app"
        ));
        let desc =
            r#"<hierarchy><node package="com.example.app" content-desc="Menu"/></hierarchy>"#;
        assert!(android_hierarchy_has_rendered_content(
            desc,
            "com.example.app"
        ));
        // System UI text does not count as the app rendering.
        let system_only = r#"<hierarchy><node package="com.android.systemui" text="10:06"/><node package="com.example.app" text=""/></hierarchy>"#;
        assert!(!android_hierarchy_has_rendered_content(
            system_only,
            "com.example.app"
        ));
    }

    #[test]
    fn parse_resolved_activity_brief_output() {
        let output = "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.example.app/.MainActivity";
        let activity = parse_resolved_activity(output, "com.example.app").unwrap();
        assert_eq!(activity, ".MainActivity");
    }

    #[test]
    fn parse_resolved_activity_full_name() {
        let output = "com.example.app/com.example.app.settings.ProfileActivity";
        let activity = parse_resolved_activity(output, "com.example.app").unwrap();
        assert_eq!(activity, "com.example.app.settings.ProfileActivity");
    }

    #[test]
    fn parse_resolved_activity_rejects_other_package() {
        let output = "com.other.app/.MainActivity";
        assert!(parse_resolved_activity(output, "com.example.app").is_none());
    }
    #[test]
    fn capture_ports_require_an_applied_redirect_even_when_values_match() {
        assert_eq!(
            capture_port_update(&[8080], &[9099], true, Some(1234)),
            Ok(Some(1234))
        );
        assert_eq!(
            capture_port_update(&[8080], &[8080], true, Some(1234)),
            Ok(None)
        );
        assert!(capture_port_update(&[8080], &[8080], true, None).is_err());
        assert!(capture_port_update(&[], &[8080], false, Some(1234)).is_err());
        // An unsupported request must continue reporting unsupported on retry.
        assert!(capture_port_update(&[8080], &[8080], false, Some(1234)).is_err());
        assert_eq!(capture_port_update(&[], &[], false, None), Ok(None));
        assert_eq!(
            capture_port_update(&[8080], &[], true, Some(1234)),
            Ok(Some(1234))
        );
    }
}
