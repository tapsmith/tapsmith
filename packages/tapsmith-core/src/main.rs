mod adb;
mod agent_comms;
mod android_keystore;
mod android_permissions;
mod app_reset;
mod daemon_log_bus;
mod device;
mod device_logs;
mod grpc_server;
#[cfg(target_os = "macos")]
mod hid_injector;
mod ios;
#[cfg(target_os = "macos")]
mod ios_redirect;
mod mitm_ca;
mod network_proxy;
mod pac;
mod platform;
mod route_handler;
mod screenshot;
mod signal;
mod timing;
mod video;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::sync::RwLock;
use tonic::transport::Server;
use tracing::{info, warn};

use crate::agent_comms::AgentConnection;
use crate::device::DeviceManager;
use crate::grpc_server::TapsmithServiceImpl;
use crate::platform::Platform;

pub mod proto {
    tonic::include_proto!("tapsmith");
}

/// Vendored mitmproxy_rs IPC schema used by the iOS redirector bridge.
/// See `packages/tapsmith-core/vendor/mitmproxy_ipc.proto` for the source.
#[cfg(target_os = "macos")]
pub mod ipc {
    tonic::include_proto!("mitmproxy_ipc");
}

#[derive(Debug)]
struct CliArgs {
    port: u16,
    agent_port: Option<u16>,
    verbose: bool,
    platform: Option<Platform>,
}

fn parse_args() -> CliArgs {
    let mut args = std::env::args().skip(1);
    let mut port: u16 = 50051;
    let mut platform: Option<Platform> = None;
    let mut agent_port: Option<u16> = None;
    let mut verbose = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                if let Some(val) = args.next() {
                    port = val.parse().unwrap_or_else(|_| {
                        eprintln!("Invalid port number: {val}");
                        std::process::exit(1);
                    });
                }
            }
            "--agent-port" => {
                if let Some(val) = args.next() {
                    agent_port = Some(val.parse().unwrap_or_else(|_| {
                        eprintln!("Invalid agent port number: {val}");
                        std::process::exit(1);
                    }));
                }
            }
            "--platform" => {
                if let Some(val) = args.next() {
                    platform = Some(match val.as_str() {
                        "ios" => Platform::Ios,
                        "android" => Platform::Android,
                        _ => {
                            eprintln!("Invalid platform: {val} (expected 'ios' or 'android')");
                            std::process::exit(1);
                        }
                    });
                }
            }
            "--verbose" | "-v" => {
                verbose = true;
            }
            "--help" | "-h" => {
                eprintln!("Usage: tapsmith-core [--port PORT] [--agent-port PORT] [--platform PLATFORM] [--verbose]");
                eprintln!();
                eprintln!("Options:");
                eprintln!("  --port PORT         gRPC listen port (default: 50051)");
                eprintln!("  --agent-port PORT   Local port for ADB forwarding to on-device agent (default: 18700)");
                eprintln!(
                    "  --platform PLATFORM Only discover devices of this platform (ios or android)"
                );
                eprintln!("  --verbose           Enable debug logging");
                std::process::exit(0);
            }
            other => {
                eprintln!("Unknown argument: {other}");
                eprintln!("Run with --help for usage information.");
                std::process::exit(1);
            }
        }
    }

    CliArgs {
        port,
        agent_port,
        verbose,
        platform,
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Install the ring crypto provider for rustls (required for MITM proxy TLS).
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    let args = parse_args();

    use tracing_subscriber::prelude::*;

    let filter = if args.verbose {
        "tapsmith_core=debug,tonic=info"
    } else {
        "tapsmith_core=info,tonic=warn"
    };
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(filter));

    // Bus that fans daemon log lines to the StreamDaemonLogs RPC. Capacity bounds
    // the in-memory backlog when a subscriber lags; oldest entries are dropped.
    let daemon_log_bus = daemon_log_bus::DaemonLogBus::new(2048);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer())
        .with(daemon_log_bus::DaemonLogLayer::new(daemon_log_bus.clone()))
        .init();

    let device_manager = Arc::new(RwLock::new(DeviceManager::with_platform_filter(
        args.platform,
    )));
    let agent_connection = Arc::new(RwLock::new(match args.agent_port {
        Some(port) => AgentConnection::with_port(port),
        None => AgentConnection::new(),
    }));

    // Tool discovery runs in the background so the gRPC listener binds as
    // early as possible. On a loaded CI runner these probes (plus macOS's
    // first-exec scan of a freshly-downloaded binary) added tens of seconds
    // before the listener existed, and the SDK's connect window expired while
    // the daemon was still warming up.
    //
    // NOTE: a "stale proxy cleanup" block used to live here. It read
    // `active_serial()`, which is always None at startup — so it either
    // no-oped, or (once backgrounded) raced a fast client's SetDevice +
    // StartNetworkCapture and reset the proxy the client had just configured.
    // Stale Android proxies from a crashed session are instead cleared when
    // capture starts for that device.
    tokio::spawn(async move {
        // Verify ADB is available (Android)
        match adb::find_adb().await {
            Ok(path) => info!(path = %path.display(), "Found ADB"),
            Err(e) => {
                warn!(
                    "ADB not found on PATH: {e}. Android device operations will not be available."
                )
            }
        }

        // Verify xcrun is available (iOS)
        match ios::device::find_xcrun().await {
            Ok(path) => info!(path = %path.display(), "Found xcrun"),
            Err(e) => {
                warn!("xcrun not found on PATH: {e}. iOS device operations will not be available.")
            }
        }

        // Undo a macOS system proxy left behind by a daemon that died without
        // cleaning up (PILOT-319). A no-op unless an owner record exists.
        #[cfg(target_os = "macos")]
        ios::system_proxy::recover_stale().await;
    });

    let service = TapsmithServiceImpl::new(device_manager, agent_connection, daemon_log_bus);
    let service_handle = Arc::new(service);

    let addr: SocketAddr = format!("127.0.0.1:{}", args.port)
        .parse()
        .context("Invalid listen address")?;

    info!(%addr, "Starting Tapsmith gRPC server");

    Server::builder()
        .http2_keepalive_interval(Some(Duration::from_secs(30)))
        // Generous ack window: during agent startup the daemon fans out
        // simctl/xcodebuild/PlistBuddy subprocess work that can briefly starve
        // the runtime; a 10s window got connections dropped mid-StartAgent on
        // loaded CI runners ("14 UNAVAILABLE: Connection dropped").
        .http2_keepalive_timeout(Some(Duration::from_secs(30)))
        .add_service(
            proto::tapsmith_service_server::TapsmithServiceServer::from_arc(service_handle.clone())
                .max_decoding_message_size(64 * 1024 * 1024)
                .max_encoding_message_size(64 * 1024 * 1024),
        )
        .serve_with_shutdown(addr, shutdown_signal())
        .await
        .context("gRPC server failed")?;

    // Clean up any active network proxy and WebView state before exiting
    service_handle.cleanup_network_proxy().await;
    service_handle.cleanup_webview_state().await;

    info!("Tapsmith daemon shut down cleanly");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("Failed to install SIGTERM handler");

    tokio::select! {
        _ = ctrl_c => { info!("Received Ctrl+C, shutting down"); }
        _ = sigterm.recv() => { info!("Received SIGTERM, shutting down"); }
    }
}
