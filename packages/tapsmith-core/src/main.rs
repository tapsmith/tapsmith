mod adb;
mod agent_comms;
mod android_agent_install;
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
    /// Keep running when the process that spawned us exits. Only the MCP
    /// server's daemons want this: they are detached so another session can
    /// adopt them from the registry.
    outlive_parent: bool,
}

fn parse_args() -> CliArgs {
    parse_args_from(std::env::args().skip(1))
}

fn parse_args_from(mut args: impl Iterator<Item = String>) -> CliArgs {
    let mut port: u16 = 50051;
    let mut platform: Option<Platform> = None;
    let mut agent_port: Option<u16> = None;
    let mut verbose = false;
    let mut outlive_parent = false;

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
            "--outlive-parent" => {
                outlive_parent = true;
            }
            "--help" | "-h" => {
                eprintln!("Usage: tapsmith-core [--port PORT] [--agent-port PORT] [--platform PLATFORM] [--outlive-parent] [--verbose]");
                eprintln!();
                eprintln!("Options:");
                eprintln!("  --port PORT         gRPC listen port (default: 50051)");
                eprintln!("  --agent-port PORT   Local port for ADB forwarding to on-device agent (default: 18700)");
                eprintln!(
                    "  --platform PLATFORM Only discover devices of this platform (ios or android)"
                );
                eprintln!("  --outlive-parent    Keep running after the process that started the daemon exits");
                eprintln!(
                    "                      (by default the daemon shuts down, stopping its agents)"
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
        outlive_parent,
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Sampled first, so a parent that dies while the daemon is still starting
    // up is noticed as soon as the watch begins.
    let startup_ppid = signal::parent_pid();

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
    let agent_connection = match args.agent_port {
        Some(port) => AgentConnection::with_port(port),
        None => AgentConnection::new(),
    };
    let agent_forward = agent_connection.forward();
    let agent_connection = Arc::new(RwLock::new(agent_connection));

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

        // Stop iOS agents orphaned by a daemon that was SIGKILLed before it
        // could stop them itself (PILOT-299). Only agents with an owner
        // record whose daemon is dead are touched.
        #[cfg(target_os = "macos")]
        ios::agent_registry::reap_orphans().await;
    });

    let service = TapsmithServiceImpl::new(device_manager, agent_connection, daemon_log_bus);
    let service_handle = Arc::new(service);

    let addr: SocketAddr = format!("127.0.0.1:{}", args.port)
        .parse()
        .context("Invalid listen address")?;

    info!(%addr, "Starting Tapsmith gRPC server");

    let parent_to_watch = signal::parent_to_watch(args.outlive_parent, startup_ppid);
    // Checked before tokio installs its own handler, which would replace a
    // SIG_IGN inherited from `nohup`.
    let watch_sighup = !signal::sighup_ignored();

    let (shutdown_began_tx, shutdown_began_rx) = tokio::sync::watch::channel(false);
    let serve = Server::builder()
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
        // Resolving at once stops the accept loop immediately, so the port is
        // released as soon as the drain ends — callers that SIGTERM a daemon
        // and respawn on its port shortly after rely on that.
        .serve_with_shutdown(addr, async move {
            shutdown_signal(parent_to_watch, watch_sighup).await;
            let _ = shutdown_began_tx.send(true);
        });
    // Stop the iOS agents as soon as shutdown begins, alongside the drain
    // rather than after it: a long-lived stream can hold the drain open, and
    // the agents must not outlive the daemon either way (PILOT-299). The
    // Android agent's `adb forward` goes at the same moment — before a caller
    // that SIGTERMed this daemon can respawn one that forwards the same port
    // — so it never outlives the daemon and shadows the next session's agent
    // port (PILOT-550).
    let mut teardown_began = shutdown_began_rx.clone();
    let agent_teardown = tokio::spawn(async move {
        if teardown_began.wait_for(|began| *began).await.is_ok() {
            tokio::join!(ios::agent_registry::shutdown_all(), agent_forward.remove());
        }
    });
    // The drain waits for every open connection. A client that keeps a stream
    // open (or a worker that outlived a killed CLI) would hold it forever, and
    // nobody escalates to SIGKILL after a parent-exit shutdown — so bound it,
    // measured from the signal, and still run the proxy cleanup below.
    let mut limit_began = shutdown_began_rx;
    let drain_limit = async move {
        match limit_began.wait_for(|began| *began).await {
            Ok(_) => tokio::time::sleep(SHUTDOWN_LIMIT).await,
            Err(_) => std::future::pending().await,
        }
    };
    tokio::select! {
        result = serve => result.context("gRPC server failed")?,
        _ = drain_limit => {
            warn!("Shutdown still draining after {SHUTDOWN_LIMIT:?}; exiting without the open gRPC connections");
        }
    }
    // Clean up any active network proxy and WebView state before exiting,
    // alongside the agent teardown rather than after it: the two share no
    // state, and the cleanup must not wait out an agent's SIGTERM grace. Both
    // are awaited (agent teardown bounds itself at ~3 s), so the daemon never
    // exits with either half done.
    let cleanup = async {
        service_handle.cleanup_network_proxy().await;
        service_handle.cleanup_webview_state().await;
    };
    let _ = tokio::join!(agent_teardown, cleanup);

    info!("Tapsmith daemon shut down cleanly");
    Ok(())
}

/// How long the gRPC drain may take once a shutdown signal arrives. Agent
/// teardown runs alongside it and bounds itself at ~3 s (a 1.5 s SIGTERM
/// grace plus 1.5 s for simctl), so this leaves the proxy cleanup about a
/// second of the 5 s the UI server gives a daemon between SIGTERM and SIGKILL.
const SHUTDOWN_LIMIT: Duration = Duration::from_millis(3500);

/// Resolves when the daemon should shut down: SIGINT, SIGTERM, SIGHUP (the
/// terminal it was started from closed), or — unless `--outlive-parent` —
/// the process that spawned it exiting, which is how a client that was
/// SIGKILLed (and so never sent SIGTERM) still gets its daemon and agents
/// stopped.
async fn shutdown_signal(parent: Option<u32>, watch_sighup: bool) {
    use tokio::signal::unix::{signal, SignalKind};
    let ctrl_c = tokio::signal::ctrl_c();
    let mut sigterm = signal(SignalKind::terminate()).expect("Failed to install SIGTERM handler");
    // Not installed under `nohup`: that asked for the hangup to be ignored.
    let mut sighup = watch_sighup
        .then(|| signal(SignalKind::hangup()).expect("Failed to install SIGHUP handler"));
    let hangup = async {
        match sighup.as_mut() {
            Some(s) => {
                s.recv().await;
            }
            None => std::future::pending().await,
        }
    };
    let parent_gone = async {
        match parent {
            Some(ppid) => crate::signal::wait_for_parent_exit(ppid).await,
            None => std::future::pending().await,
        }
    };

    tokio::select! {
        _ = ctrl_c => { info!("Received Ctrl+C, shutting down"); }
        _ = sigterm.recv() => { info!("Received SIGTERM, shutting down"); }
        _ = hangup => { info!("Received SIGHUP, shutting down"); }
        _ = parent_gone => { info!("The process that started this daemon exited, shutting down"); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> CliArgs {
        parse_args_from(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn the_daemon_watches_its_parent_unless_told_to_outlive_it() {
        assert!(!parse(&["--port", "50051"]).outlive_parent);
        let args = parse(&["--port", "50051", "--outlive-parent", "--platform", "ios"]);
        assert!(args.outlive_parent);
        assert_eq!(args.port, 50051);
        assert_eq!(args.platform, Some(Platform::Ios));
    }
}
