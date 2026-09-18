use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tokio::process::Command;
use tracing::{debug, info, instrument, warn};

/// Ceiling for a simctl/xcrun invocation on an RPC hot path.
/// CoreSimulatorService can wedge for many minutes on loaded CI hosts
/// (observed 6–12 min after network-capture system-proxy churn); an
/// unbounded call then silently eats the caller's entire gRPC deadline and
/// cascades DEADLINE_EXCEEDED across unrelated RPCs. Bounding turns the
/// wedge into a fast, labelled, retryable error.
pub(crate) const SIMCTL_TIMEOUT: Duration = Duration::from_secs(30);

/// Log any subprocess slower than this — a single self-explanatory warning
/// beats reconstructing a CoreSimulator stall from client-side deadline
/// errors after the fact.
const SLOW_SUBPROCESS_WARN: Duration = Duration::from_secs(10);

/// Run a subprocess with a hard timeout, `kill_on_drop` (so cancelled RPC
/// handlers never leak hung children), and a slow-invocation warning.
pub(crate) async fn bounded_output(
    label: &str,
    cmd: &mut Command,
    timeout: Duration,
) -> Result<std::process::Output> {
    cmd.kill_on_drop(true);
    let started = std::time::Instant::now();
    let result = tokio::time::timeout(timeout, cmd.output()).await;
    let elapsed = started.elapsed();
    if elapsed >= SLOW_SUBPROCESS_WARN {
        warn!(
            label,
            elapsed_ms = elapsed.as_millis() as u64,
            "slow subprocess invocation (CoreSimulator under pressure?)"
        );
    }
    result
        .map_err(|_| {
            anyhow!(
                "{label} timed out after {}s (CoreSimulatorService may be wedged)",
                timeout.as_secs()
            )
        })?
        .with_context(|| format!("Failed to execute {label}"))
}

/// Locate the `xcrun` binary on PATH.
pub async fn find_xcrun() -> Result<PathBuf> {
    let output = Command::new("which")
        .arg("xcrun")
        .output()
        .await
        .context("Failed to execute `which xcrun`")?;

    if !output.status.success() {
        bail!("xcrun not found on PATH. Xcode Command Line Tools are required for iOS support.");
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(PathBuf::from(path))
}

/// Parsed iOS device/simulator entry.
#[derive(Debug, Clone)]
pub struct IosDevice {
    pub udid: String,
    pub name: String,
    pub state: String,
    pub is_simulator: bool,
    /// Physical-only: whether devicectl reports this device as paired. Always
    /// true for simulators (they have no pairing concept).
    #[allow(dead_code)]
    pub is_paired: bool,
    /// Physical-only: whether devicectl reports Developer Disk Image services
    /// as available. Required for XCUITest runs. Always true for simulators.
    #[allow(dead_code)]
    pub ddi_services_available: bool,
    /// Physical-only: iOS version string (e.g. "18.2"). Empty for simulators
    /// (runtime is stored separately for those).
    #[allow(dead_code)]
    pub os_version: String,
}

impl IosDevice {
    pub fn is_booted(&self) -> bool {
        self.state == "Booted"
    }
}

/// List available iOS simulators.
#[instrument]
pub async fn list_simulators() -> Result<Vec<IosDevice>> {
    let output = bounded_output(
        "simctl list devices",
        Command::new("xcrun").args(["simctl", "list", "devices", "--json"]),
        SIMCTL_TIMEOUT,
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("xcrun simctl list devices failed: {stderr}");
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value =
        serde_json::from_str(&json_str).context("Failed to parse simctl JSON output")?;

    let mut devices = Vec::new();

    if let Some(device_map) = value.get("devices").and_then(|d| d.as_object()) {
        for (runtime, device_list) in device_map {
            // Runtime key looks like `com.apple.CoreSimulator.SimRuntime.iOS-18-1`;
            // produce a user-facing "18.1". Non-iOS runtimes (watchOS, tvOS)
            // just fall through with an empty version — we don't surface them
            // in list-devices today.
            let runtime_version = parse_simctl_runtime_version(runtime);
            if let Some(list) = device_list.as_array() {
                for device in list {
                    let udid = device
                        .get("udid")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = device
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let state = device
                        .get("state")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Shutdown")
                        .to_string();
                    let is_available = device
                        .get("isAvailable")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);

                    if !udid.is_empty() && is_available {
                        devices.push(IosDevice {
                            udid,
                            name,
                            state,
                            is_simulator: true,
                            is_paired: true,
                            ddi_services_available: true,
                            os_version: runtime_version.clone(),
                        });
                    }
                }
            }
        }
    }

    debug!(count = devices.len(), "Listed iOS simulators");
    Ok(devices)
}

/// Parse a simctl runtime identifier (e.g.
/// `com.apple.CoreSimulator.SimRuntime.iOS-18-1`) into a human-friendly
/// version string (`18.1`). Returns an empty string for non-iOS runtimes
/// or when the identifier doesn't match the expected shape.
fn parse_simctl_runtime_version(runtime: &str) -> String {
    let Some(tail) = runtime.strip_prefix("com.apple.CoreSimulator.SimRuntime.iOS-") else {
        return String::new();
    };
    tail.replace('-', ".")
}

/// List connected physical iOS devices via devicectl.
///
/// Writes devicectl JSON output to a scratch file rather than `/dev/stdout`
/// because devicectl intermixes provisioning warnings on stdout when the
/// device is unpaired or DDI services are unavailable, which breaks naive
/// stdout parsing.
pub async fn list_physical_devices() -> Result<Vec<IosDevice>> {
    let json_path = std::env::temp_dir().join(format!(
        "tapsmith-devicectl-list-{}.json",
        std::process::id()
    ));
    let json_path_str = json_path.to_string_lossy().to_string();

    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "list",
            "devices",
            "--json-output",
            &json_path_str,
        ])
        .output()
        .await;

    // Read the JSON file regardless of whether stdout parsing succeeded —
    // devicectl sometimes writes warnings to stderr but still produces valid
    // JSON in the output file.
    let result = match output {
        Ok(_) => match tokio::fs::read_to_string(&json_path).await {
            Ok(json_str) => parse_devicectl_devices(&json_str),
            Err(e) => {
                debug!("devicectl JSON file not readable: {e}");
                Ok(Vec::new())
            }
        },
        Err(e) => {
            debug!("devicectl not available, skipping physical device listing: {e}");
            Ok(Vec::new())
        }
    };

    // Best-effort cleanup of the scratch file
    let _ = tokio::fs::remove_file(&json_path).await;

    result
}

fn parse_devicectl_devices(json_str: &str) -> Result<Vec<IosDevice>> {
    let value: serde_json::Value =
        serde_json::from_str(json_str).context("Failed to parse devicectl JSON output")?;

    let mut devices = Vec::new();
    let Some(device_list) = value
        .get("result")
        .and_then(|r| r.get("devices"))
        .and_then(|d| d.as_array())
    else {
        return Ok(devices);
    };

    for device in device_list {
        // Only include iOS devices. devicectl also lists paired Apple Watches,
        // Apple TVs, etc. — filter to iOS-family devices so downstream code
        // can assume iOS semantics.
        let platform = device
            .pointer("/hardwareProperties/platform")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if platform != "iOS" {
            continue;
        }
        // Only real hardware. From Xcode 27 devicectl lists every simulator
        // too, flagged `reality: "simulated"`. Without this, list_all_devices
        // returned each simulator twice — once from simctl as a simulator and
        // once from here as a physical iPhone. DeviceManager de-duplicates
        // booted ones by serial but skips non-booted simulators from the
        // simctl half, so every shutdown simulator surfaced as a physical
        // device. Read from the same dictionary as every other field (the
        // replacement `properties` tree is a whole-parser migration).
        let reality = device
            .pointer("/hardwareProperties/reality")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if reality == "simulated" {
            continue;
        }

        let udid = device
            .pointer("/hardwareProperties/udid")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let name = device
            .pointer("/deviceProperties/name")
            .and_then(|v| v.as_str())
            .or_else(|| device.get("name").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        let pairing_state = device
            .pointer("/connectionProperties/pairingState")
            .and_then(|v| v.as_str())
            .unwrap_or("unpaired");
        let ddi_services_available = device
            .pointer("/deviceProperties/ddiServicesAvailable")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let os_version = device
            .pointer("/deviceProperties/osVersionNumber")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let boot_state = device
            .pointer("/deviceProperties/bootState")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        if udid.is_empty() {
            continue;
        }

        devices.push(IosDevice {
            udid,
            name,
            // Use the same "Booted"/"Shutdown" capitalization as simulators
            // so `is_booted()` works uniformly.
            state: if boot_state == "booted" {
                "Booted".to_string()
            } else {
                "Shutdown".to_string()
            },
            is_simulator: false,
            is_paired: pairing_state == "paired",
            ddi_services_available,
            os_version,
        });
    }
    Ok(devices)
}

/// List all iOS devices (simulators + physical).
/// Physical device listing failures are non-fatal (devicectl may not be available).
pub async fn list_all_devices() -> Result<Vec<IosDevice>> {
    let (sims, physical) = tokio::join!(list_simulators(), list_physical_devices());
    let mut all = sims?;
    // Physical device listing is best-effort — devicectl may fail
    if let Ok(phys) = physical {
        all.extend(phys);
    }
    Ok(all)
}

/// Install an app bundle on a simulator.
#[allow(dead_code)]
#[instrument(skip(app_path))]
pub async fn install_app(udid: &str, app_path: &str) -> Result<()> {
    let output = bounded_output(
        "simctl install",
        Command::new("xcrun").args(["simctl", "install", udid, app_path]),
        Duration::from_secs(120),
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to install app on simulator {udid}: {stderr}");
    }

    info!(udid, app_path, "App installed on simulator");
    Ok(())
}

/// Install an app bundle on a physical iOS device via `xcrun devicectl`.
///
/// The `.app` path may point at an unsigned simulator build or a signed
/// device build — devicectl will accept the latter and reject the former
/// with a signing error. Callers are responsible for passing the correct
/// bundle for the target device.
#[instrument(skip(app_path))]
pub async fn install_app_on_device(udid: &str, app_path: &str) -> Result<()> {
    let json_path = scratch_json_path("install-app");
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "device",
            "install",
            "app",
            "--device",
            udid,
            "--json-output",
            &json_path.to_string_lossy(),
            app_path,
        ])
        .output()
        .await
        .context("Failed to run xcrun devicectl device install app")?;

    // Best-effort cleanup — we only read JSON if we want to surface details.
    let json_body = tokio::fs::read_to_string(&json_path).await.ok();
    let _ = tokio::fs::remove_file(&json_path).await;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let hint = extract_devicectl_error_hint(json_body.as_deref());
        bail!(
            "Failed to install app on physical device {udid}: {stderr}{}",
            hint.map(|h| format!("\n  hint: {h}")).unwrap_or_default()
        );
    }

    info!(udid, app_path, "App installed on physical device");
    Ok(())
}

/// Launch an app on a physical iOS device via devicectl and return the PID.
///
/// devicectl's launch is asynchronous-ish — it returns once the remote
/// process has spawned, but the returned PID can be used to later terminate
/// the app via `terminate_process_on_device`.
#[allow(dead_code)]
#[instrument]
pub async fn launch_app_on_device(udid: &str, bundle_id: &str) -> Result<u32> {
    let json_path = scratch_json_path("launch-app");
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "device",
            "process",
            "launch",
            "--device",
            udid,
            "--json-output",
            &json_path.to_string_lossy(),
            bundle_id,
        ])
        .output()
        .await
        .context("Failed to run xcrun devicectl device process launch")?;

    let json_body = tokio::fs::read_to_string(&json_path).await.ok();
    let _ = tokio::fs::remove_file(&json_path).await;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let hint = extract_devicectl_error_hint(json_body.as_deref());
        bail!(
            "Failed to launch {bundle_id} on physical device {udid}: {stderr}{}",
            hint.map(|h| format!("\n  hint: {h}")).unwrap_or_default()
        );
    }

    let pid = json_body
        .as_deref()
        .and_then(|body| {
            serde_json::from_str::<serde_json::Value>(body)
                .ok()?
                .pointer("/result/process/processIdentifier")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
        })
        .ok_or_else(|| {
            anyhow::anyhow!(
                "devicectl launch succeeded but no PID returned for {bundle_id} on {udid}"
            )
        })?;

    info!(udid, bundle_id, pid, "App launched on physical device");
    Ok(pid)
}

/// Launch a URL on a physical device by delivering it to the target bundle.
///
/// Uses `xcrun devicectl device process launch --payload-url <url> <bundle>`.
/// In practice this launches the target bundle but does NOT actually
/// deliver the URL to the app's UIApplicationDelegate — the payload is
/// attached to the launch record but RN/expo-router's deep-link handling
/// never sees it. Tapsmith routes openDeepLink through the agent's
/// `XCUIApplication.open(url:)` path instead, so this helper is kept only
/// for diagnostics and is currently unused.
#[allow(dead_code)]
#[instrument]
pub async fn launch_url_on_device(udid: &str, bundle_id: &str, url: &str) -> Result<()> {
    let json_path = scratch_json_path("launch-url");
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "device",
            "process",
            "launch",
            "--device",
            udid,
            "--json-output",
            &json_path.to_string_lossy(),
            "--terminate-existing",
            "--payload-url",
            url,
            bundle_id,
        ])
        .output()
        .await
        .context("Failed to run xcrun devicectl device process launch --payload-url")?;

    let json_body = tokio::fs::read_to_string(&json_path).await.ok();
    let _ = tokio::fs::remove_file(&json_path).await;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let hint = extract_devicectl_error_hint(json_body.as_deref());
        bail!(
            "Failed to open URL on physical device {udid}: {stderr}{}",
            hint.map(|h| format!("\n  hint: {h}")).unwrap_or_default()
        );
    }

    info!(
        udid,
        bundle_id, url, "URL delivered to app on physical device"
    );
    Ok(())
}

/// Uninstall an app from a physical iOS device by bundle ID.
#[instrument]
pub async fn uninstall_app_on_device(udid: &str, bundle_id: &str) -> Result<()> {
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "device",
            "uninstall",
            "app",
            "--device",
            udid,
            bundle_id,
        ])
        .output()
        .await
        .context("Failed to run xcrun devicectl device uninstall app")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Uninstalling a not-installed app is fine — target state is reached.
        if stderr.contains("not installed") || stderr.contains("could not be found") {
            debug!(udid, bundle_id, "App already not installed");
            return Ok(());
        }
        bail!("Failed to uninstall {bundle_id} from {udid}: {stderr}");
    }
    info!(udid, bundle_id, "App uninstalled from physical device");
    Ok(())
}

/// Pull an app's data container from a physical device to a local directory.
///
/// Uses `xcrun devicectl device copy from --domain-type appDataContainer`.
/// The destination directory will contain the container's children
/// (typically `Documents/`, `Library/`, `tmp/`).
#[instrument(skip(local_dest))]
pub async fn copy_app_container_from_device(
    udid: &str,
    bundle_id: &str,
    local_dest: &str,
) -> Result<()> {
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "device",
            "copy",
            "from",
            "--device",
            udid,
            "--domain-type",
            "appDataContainer",
            "--domain-identifier",
            bundle_id,
            "--source",
            "/",
            "--destination",
            local_dest,
        ])
        .output()
        .await
        .context("Failed to run xcrun devicectl device copy from")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to copy app container from {udid}: {stderr}");
    }
    Ok(())
}

/// Push local files back into an app's data container on a physical device.
///
/// Uses `xcrun devicectl device copy to --domain-type appDataContainer` with
/// one source entry per top-level child (`Documents/`, `Library/`, `tmp/`).
/// Passing `--remove-existing-content true` replaces the destination, so
/// stale files left by the previous state are cleared.
#[instrument(skip(local_sources))]
pub async fn copy_app_container_to_device(
    udid: &str,
    bundle_id: &str,
    local_sources: &[String],
) -> Result<()> {
    if local_sources.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec![
        "devicectl",
        "device",
        "copy",
        "to",
        "--device",
        udid,
        "--domain-type",
        "appDataContainer",
        "--domain-identifier",
        bundle_id,
        "--destination",
        "/",
        "--remove-existing-content",
        "true",
    ];
    for source in local_sources {
        args.push("--source");
        args.push(source.as_str());
    }
    let output = Command::new("xcrun")
        .args(&args)
        .output()
        .await
        .context("Failed to run xcrun devicectl device copy to")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to copy app container to {udid}: {stderr}");
    }
    Ok(())
}

/// Terminate a running process on a physical iOS device by PID.
#[allow(dead_code)]
#[instrument]
pub async fn terminate_process_on_device(udid: &str, pid: u32) -> Result<()> {
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "device",
            "process",
            "terminate",
            "--device",
            udid,
            "--pid",
            &pid.to_string(),
        ])
        .output()
        .await
        .context("Failed to run xcrun devicectl device process terminate")?;

    if !output.status.success() {
        // Terminating an already-gone process is not an error for Tapsmith's
        // purposes — it means the target state is already achieved.
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug!(udid, pid, stderr = %stderr, "devicectl terminate returned non-zero (process may already be gone)");
    }
    Ok(())
}

/// Scratch JSON output path for devicectl commands — per-invocation with the
/// caller's purpose in the filename so multiple concurrent calls don't collide.
#[allow(dead_code)]
fn scratch_json_path(purpose: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "tapsmith-devicectl-{}-{}-{}.json",
        purpose,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ))
}

/// Extract a human-readable hint from devicectl's JSON error output.
///
/// devicectl errors include nested `error.userInfo.NSLocalizedDescription`
/// fields that are almost always more useful than the bare stderr line.
#[allow(dead_code)]
fn extract_devicectl_error_hint(json_body: Option<&str>) -> Option<String> {
    let body = json_body?;
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value
        .pointer("/error/userInfo/NSLocalizedDescription/string")
        .and_then(|v| v.as_str())
        .or_else(|| {
            value
                .pointer("/error/userInfo/NSLocalizedDescription")
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            value
                .pointer("/error/userInfo/NSLocalizedRecoverySuggestion/string")
                .and_then(|v| v.as_str())
        })
        .map(|s| s.to_string())
}

/// Launch an app on a simulator by bundle ID.
#[instrument]
pub async fn launch_app(udid: &str, bundle_id: &str) -> Result<()> {
    let output = bounded_output(
        "simctl launch",
        Command::new("xcrun").args(["simctl", "launch", udid, bundle_id]),
        SIMCTL_TIMEOUT,
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to launch {bundle_id} on {udid}: {stderr}");
    }

    info!(udid, bundle_id, "App launched on simulator");
    Ok(())
}

/// Prepare simulator launchd environment for gRPC-Core clients (Firestore et
/// al.) under network capture (PILOT-245).
///
/// Firestore's gRPC-C++ stack embeds its root certificates and passes them
/// directly to SSL credentials, so `GRPC_DEFAULT_SSL_ROOTS_FILE_PATH` is not a
/// reliable way to make it trust the MITM CA. The proxy instead falls back to
/// end-to-end passthrough when an h2-capable client rejects the generated cert.
/// Keep the DNS resolver override, though: it prevents gRPC's in-process
/// c-ares resolver from sending UDP DNS through the TCP-only capture redirector.
#[cfg(target_os = "macos")]
pub async fn prepare_grpc_trust(udid: &str, _bundle_id: &str) {
    // Force gRPC-Core onto the platform `getaddrinfo` resolver instead of its
    // in-process c-ares resolver. c-ares sends DNS straight from the app
    // process, so the PID-based capture redirector claims those UDP packets and
    // drops them (TCP-only) → DNS times out (`-65568`) and Firestore never
    // connects. `getaddrinfo` resolves via mDNSResponder (a separate process,
    // not intercepted), the same path NSURLSession uses successfully.
    sim_setenv(udid, "GRPC_DNS_RESOLVER", "native").await;
}

/// Set an environment variable in the simulator's launchd (inherited by apps
/// launched afterward, including the XCUITest-agent-launched target app).
#[cfg(target_os = "macos")]
async fn sim_setenv(udid: &str, key: &str, value: &str) {
    match bounded_output(
        "simctl spawn launchctl setenv",
        Command::new("xcrun").args(["simctl", "spawn", udid, "launchctl", "setenv", key, value]),
        SIMCTL_TIMEOUT,
    )
    .await
    {
        Ok(o) if o.status.success() => debug!(key, value, "published env to simulator launchd"),
        Ok(o) => debug!(
            key,
            stderr = %String::from_utf8_lossy(&o.stderr),
            "launchctl setenv returned non-zero"
        ),
        Err(e) => debug!(key, error = %e, "failed to run launchctl setenv"),
    }
}

/// Terminate an app on a simulator.
#[instrument]
pub async fn terminate_app(udid: &str, bundle_id: &str) -> Result<()> {
    let output = bounded_output(
        "simctl terminate",
        Command::new("xcrun").args(["simctl", "terminate", udid, bundle_id]),
        SIMCTL_TIMEOUT,
    )
    .await?;

    if !output.status.success() {
        // Terminating an already-stopped app is not an error
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug!(udid, bundle_id, stderr = %stderr, "simctl terminate returned non-zero (app may not be running)");
    }

    Ok(())
}

/// Open a URL on a simulator (deep link).
#[allow(dead_code)]
#[instrument]
pub async fn open_url(udid: &str, url: &str) -> Result<()> {
    let output = bounded_output(
        "simctl openurl",
        Command::new("xcrun").args(["simctl", "openurl", udid, url]),
        SIMCTL_TIMEOUT,
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to open URL on {udid}: {stderr}");
    }

    Ok(())
}

pub fn is_retryable_open_url_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("operation timed out")
        || lower.contains("nsposixerrordomain, code=60")
        || lower.contains("nsposixerrordomain code=60")
}

/// Grant a privacy permission on a simulator.
/// Service names: camera, photos, location, microphone, contacts, calendar, etc.
#[instrument]
pub async fn grant_permission(udid: &str, bundle_id: &str, service: &str) -> Result<()> {
    let output = bounded_output(
        "simctl privacy grant",
        Command::new("xcrun").args(["simctl", "privacy", udid, "grant", service, bundle_id]),
        SIMCTL_TIMEOUT,
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to grant {service} permission for {bundle_id} on {udid}: {stderr}");
    }

    Ok(())
}

/// Revoke a privacy permission on a simulator.
#[instrument]
pub async fn revoke_permission(udid: &str, bundle_id: &str, service: &str) -> Result<()> {
    let output = bounded_output(
        "simctl privacy revoke",
        Command::new("xcrun").args(["simctl", "privacy", udid, "revoke", service, bundle_id]),
        SIMCTL_TIMEOUT,
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to revoke {service} permission for {bundle_id} on {udid}: {stderr}");
    }

    Ok(())
}

/// Set the simulator appearance (light/dark mode).
#[instrument]
pub async fn set_appearance(udid: &str, mode: &str) -> Result<()> {
    let output = bounded_output(
        "simctl ui appearance",
        Command::new("xcrun").args(["simctl", "ui", udid, "appearance", mode]),
        SIMCTL_TIMEOUT,
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to set appearance to {mode} on {udid}: {stderr}");
    }

    Ok(())
}

/// Get the simulator clipboard text via `simctl pbpaste`.
/// This avoids the iOS 16+ paste permission dialog that would be triggered
/// by reading UIPasteboard on-device.
#[instrument]
pub async fn get_clipboard(udid: &str) -> Result<String> {
    let output = bounded_output(
        "simctl pbpaste",
        Command::new("xcrun").args(["simctl", "pbpaste", udid]),
        SIMCTL_TIMEOUT,
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to get clipboard on {udid}: {stderr}");
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Set the simulator clipboard text via `simctl pbcopy`.
/// This avoids the iOS 16+ paste permission dialog that would be triggered
/// by writing to UIPasteboard on-device.
#[instrument]
pub async fn set_clipboard(udid: &str, text: &str) -> Result<()> {
    let mut child = Command::new("xcrun")
        .args(["simctl", "pbcopy", udid])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("Failed to run xcrun simctl pbcopy")?;

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        // Bound the write too: if pbcopy's pasteboard-sync service is wedged
        // and never reads stdin, text larger than the OS pipe buffer would
        // block here forever — before the bounded wait below is ever reached.
        tokio::time::timeout(SIMCTL_TIMEOUT, stdin.write_all(text.as_bytes()))
            .await
            .map_err(|_| {
                anyhow!(
                    "simctl pbcopy stdin write timed out after {}s (CoreSimulatorService may be wedged)",
                    SIMCTL_TIMEOUT.as_secs()
                )
            })??;
    }

    let output = tokio::time::timeout(SIMCTL_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| {
            anyhow!(
                "simctl pbcopy timed out after {}s (CoreSimulatorService may be wedged)",
                SIMCTL_TIMEOUT.as_secs()
            )
        })??;
    if !output.status.success() {
        // pbcopy talks to the simulator's pasteboard-sync service, which is
        // known to wedge intermittently on CI — surface stderr so the failure
        // is diagnosable instead of a bare "Failed to set clipboard".
        bail!(
            "Failed to set clipboard on {udid}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    Ok(())
}

/// Get device logs from a simulator (equivalent to Android logcat).
#[allow(dead_code)]
#[instrument]
pub async fn get_logs(udid: &str, bundle_id: Option<&str>, since: Option<&str>) -> Result<String> {
    let mut args = vec!["simctl", "spawn", udid, "log", "show", "--style", "compact"];

    let predicate;
    if let Some(bid) = bundle_id {
        predicate = format!("subsystem == \"{}\"", bid);
        args.push("--predicate");
        args.push(&predicate);
    }

    if let Some(since_time) = since {
        args.push("--start");
        args.push(since_time);
    }

    let output = Command::new("xcrun")
        .args(&args)
        .output()
        .await
        .context("Failed to get simulator logs")?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Boot a simulator.
#[allow(dead_code)]
#[instrument]
pub async fn boot_simulator(udid: &str) -> Result<()> {
    // Boot returns once the device transitions to Booted (the OS keeps
    // loading asynchronously) — 120s covers a cold boot on a loaded host
    // without letting a wedged CoreSimulator hold the caller forever.
    let output = bounded_output(
        "simctl boot",
        Command::new("xcrun").args(["simctl", "boot", udid]),
        Duration::from_secs(120),
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "Unable to boot device in current state: Booted" is not a real error
        if stderr.contains("Booted") {
            debug!(udid, "Simulator already booted");
            return Ok(());
        }
        bail!("Failed to boot simulator {udid}: {stderr}");
    }

    info!(udid, "Simulator booted");
    configure_simulator(udid).await;
    Ok(())
}

/// Apply test-friendly defaults to the simulator (disable password autofill,
/// keyboard autocorrect, etc.) so system dialogs don't interfere with tests.
///
/// **Caller's responsibility** to skip this for physical devices — invoking
/// it against a real device's UDID is wasted work (the simctl spawns will
/// fail) but won't cause data loss. The `grpc_server::start_agent` handler
/// already branches on `is_active_ios_physical()` and skips this call on
/// physical-device runs to keep the simulator hot path free of any extra
/// devicectl latency.
pub async fn configure_simulator(udid: &str) {
    // Disable "Save Password?" dialog which blocks the UI during login tests.
    // The setting must be written to multiple domains because Apple has moved
    // the password autofill control across iOS versions and frameworks.
    const AUTOFILL_DOMAINS: [&str; 4] = [
        "-g",                 // Global (pre-iOS 26)
        "com.apple.WebUI",    // WebKit credential UI (iOS 26+)
        "com.apple.Safari",   // Safari password autofill
        "com.apple.Password", // Passwords framework (iOS 26+)
    ];

    // Best-effort, but bounded: this runs inside StartAgent, and an unbounded
    // `simctl spawn` against a wedged CoreSimulator was observed stalling
    // agent start past its whole 240s client deadline. The domains are
    // written concurrently so the worst case is one bound rather than four,
    // and a write that fails or times out gets a second pass: under
    // CoreSimulator pressure these writes hit their bound and were silently
    // dropped, autofill stayed on, and the Keychain "Save Password?" sheet
    // then covered the first sign-in of the run (both failing iOS shard-5
    // runs of Sep 2026 show the timed-out writes in the daemon log).
    let mut pending: Vec<&'static str> = AUTOFILL_DOMAINS.to_vec();
    for pass in 1..=AUTOFILL_WRITE_PASSES {
        let handles: Vec<_> = pending
            .drain(..)
            .map(|domain| {
                let udid = udid.to_string();
                tokio::spawn(async move { (domain, write_autofill_default(&udid, domain).await) })
            })
            .collect();
        for handle in handles {
            match handle.await {
                Ok((_, Ok(()))) => {}
                Ok((domain, Err(e))) => {
                    warn!(udid, domain, pass, error = %e, "disabling password autofill failed");
                    pending.push(domain);
                }
                Err(e) => warn!(udid, pass, error = %e, "autofill defaults task panicked"),
            }
        }
        if pending.is_empty() {
            break;
        }
    }
    if pending.is_empty() {
        debug!(udid, "Configured simulator defaults for testing");
    } else {
        warn!(
            udid,
            domains = ?pending,
            "password autofill could not be disabled; the Keychain \"Save Password?\" sheet may appear after a sign-in"
        );
    }
}

/// Bound for one `simctl spawn defaults write`. Generous enough to survive
/// the 10-12s stalls seen on loaded CI runners, still far inside StartAgent's
/// client deadline even across both passes.
const AUTOFILL_DEFAULTS_TIMEOUT: Duration = Duration::from_secs(20);
const AUTOFILL_WRITE_PASSES: u32 = 2;

async fn write_autofill_default(udid: &str, domain: &str) -> Result<()> {
    let output = bounded_output(
        "simctl spawn defaults write",
        Command::new("xcrun").args([
            "simctl",
            "spawn",
            udid,
            "defaults",
            "write",
            domain,
            "AutoFillPasswords",
            "-bool",
            "NO",
        ]),
        AUTOFILL_DEFAULTS_TIMEOUT,
    )
    .await?;
    if !output.status.success() {
        return Err(anyhow!(
            "defaults write exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// Shutdown a simulator.
#[allow(dead_code)]
#[instrument]
pub async fn shutdown_simulator(udid: &str) -> Result<()> {
    let output = bounded_output(
        "simctl shutdown",
        Command::new("xcrun").args(["simctl", "shutdown", udid]),
        Duration::from_secs(60),
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug!(udid, stderr = %stderr, "simctl shutdown returned non-zero");
    }

    Ok(())
}

/// Get the app container path on a simulator.
#[instrument]
pub async fn get_app_container(udid: &str, bundle_id: &str) -> Result<String> {
    let output = bounded_output(
        "simctl get_app_container",
        Command::new("xcrun").args(["simctl", "get_app_container", udid, bundle_id, "data"]),
        SIMCTL_TIMEOUT,
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to get app container for {bundle_id} on {udid}: {stderr}");
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Clear an app's data container by removing user data.
/// Clears Documents, tmp, and all of Library so that app-managed
/// persisted state is recreated fresh on next use.
/// Preserves the container structure itself.
#[instrument]
pub async fn clear_container(container_path: &str) -> Result<()> {
    use std::path::Path;
    let container = Path::new(container_path);
    if !container.exists() {
        debug!("Container path does not exist: {container_path}");
        return Ok(());
    }

    // Clear all contents outside Library first, then clear all of Library.
    // This includes Documents, tmp, Library/Caches, Library/Application Support,
    // Library/Saved Application State, Library/WebKit, and Library/Preferences.
    let mut entries = tokio::fs::read_dir(container).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // Skip Library — we handle it separately below.
        if name_str == "Library" {
            continue;
        }
        if path.is_dir() {
            let _ = tokio::fs::remove_dir_all(&path).await;
            let _ = tokio::fs::create_dir_all(&path).await;
        } else {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
    // Clear all Library contents, including Preferences.
    let library = container.join("Library");
    if library.exists() {
        let mut lib_entries = tokio::fs::read_dir(&library).await?;
        while let Some(entry) = lib_entries.next_entry().await? {
            let path = entry.path();
            if path.is_dir() {
                let _ = tokio::fs::remove_dir_all(&path).await;
            } else {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
    }
    info!(container_path, "Cleared app data container");
    Ok(())
}

// ─── Simulator Keychain Helpers ───

/// File names making up the simulator's device-level keychain SQLite database.
/// The db is in WAL mode — the three files must be copied together as a set,
/// otherwise a stale `-wal` can replay old transactions over the restored db.
pub const SIM_KEYCHAIN_FILES: [&str; 3] = [
    "keychain-2-debug.db",
    "keychain-2-debug.db-wal",
    "keychain-2-debug.db-shm",
];

/// launchctl service target for the simulator's securityd. The same on the
/// iOS runtimes we've tested; `restart_securityd` falls back to discovery if
/// it ever drifts.
const SECURITYD_LABEL: &str = "system/com.apple.securityd";

/// Reserved archive member that carries keychain state inside app-state
/// archives. Dot-prefixed so an old daemon that extracts it into the app
/// container can't collide with real app data.
pub const KEYCHAIN_ARCHIVE_MEMBER: &str = ".tapsmith-keychain";

/// Escape hatch: set `TAPSMITH_NO_KEYCHAIN_STATE=1` to disable all keychain
/// capture/restore/clear behavior on simulators.
pub fn keychain_state_disabled() -> bool {
    std::env::var("TAPSMITH_NO_KEYCHAIN_STATE").is_ok_and(|v| !v.is_empty() && v != "0")
}

/// Derive the simulator's device-level keychain directory from an app data
/// container path:
/// `…/Devices/<UDID>/data/Containers/Data/Application/<UUID>` →
/// `…/Devices/<UDID>/data/Library/Keychains`.
///
/// Deriving from the container path (rather than hardcoding
/// `~/Library/Developer/CoreSimulator`) keeps this correct for custom
/// device-set locations (`simctl --set`).
pub fn simulator_keychain_dir(container_path: &str) -> Option<PathBuf> {
    // rfind: match the LAST occurrence, so a username or parent directory
    // that happens to contain "/data/Containers/" can't shadow the real
    // container segment closest to the path tail.
    let idx = container_path.rfind("/data/Containers/")?;
    let device_data_root = &container_path[..idx + "/data".len()];
    Some(PathBuf::from(device_data_root).join("Library/Keychains"))
}

/// Returns true when a `tar tzf` listing contains the reserved keychain
/// member. bsdtar prints members as `./.tapsmith-keychain/…`; tolerate the
/// un-prefixed form too.
pub fn archive_has_keychain_member(listing: &str) -> bool {
    listing.lines().any(|line| {
        let line = line.trim();
        let stripped = line.strip_prefix("./").unwrap_or(line);
        stripped == KEYCHAIN_ARCHIVE_MEMBER
            || stripped.starts_with(&format!("{KEYCHAIN_ARCHIVE_MEMBER}/"))
    })
}

/// Copy whichever of the keychain db files exist into `dest_dir` (created if
/// needed). Returns the number of files copied; 0 means there is no keychain
/// state to capture and the caller should skip the archive member entirely.
#[instrument(skip_all)]
pub async fn stage_keychain_files(
    keychain_dir: &std::path::Path,
    dest_dir: &std::path::Path,
) -> Result<usize> {
    tokio::fs::create_dir_all(dest_dir)
        .await
        .context("Failed to create keychain staging dir")?;
    let mut copied = 0;
    for name in SIM_KEYCHAIN_FILES {
        let src = keychain_dir.join(name);
        if tokio::fs::try_exists(&src).await.unwrap_or(false) {
            tokio::fs::copy(&src, dest_dir.join(name))
                .await
                .with_context(|| format!("Failed to copy keychain file {name}"))?;
            copied += 1;
        }
    }
    debug!(copied, "Staged simulator keychain files");
    Ok(copied)
}

/// Overwrite the simulator's keychain from `src_dir`: copy the db (plus
/// `-wal`/`-shm` when present in src, deleting stale ones in the destination
/// when absent), then restart securityd so it re-reads the swapped db.
#[instrument(skip_all, fields(udid))]
pub async fn swap_keychain_files(
    udid: &str,
    keychain_dir: &std::path::Path,
    src_dir: &std::path::Path,
) -> Result<()> {
    let db_src = src_dir.join(SIM_KEYCHAIN_FILES[0]);
    if !tokio::fs::try_exists(&db_src).await.unwrap_or(false) {
        bail!(
            "Keychain archive member is missing {} — archive may be corrupt",
            SIM_KEYCHAIN_FILES[0]
        );
    }
    tokio::fs::create_dir_all(keychain_dir)
        .await
        .context("Failed to create simulator keychain dir")?;

    // Replace each file atomically *while securityd is still running*. On Unix
    // a rename/unlink doesn't disturb an already-open fd, so the live securityd
    // keeps reading the old inode (a consistent old db) throughout — it can
    // never observe a half-written one. We copy into a `.tmp` sibling (securityd
    // ignores unknown filenames) then rename it into place. Only after all the
    // files are swapped does `restart_securityd` (`kickstart -k`) replace the
    // process, so the fresh securityd opens the new, complete set by name.
    // (Killing first would be worse: launchd respawns securityd almost
    // immediately and a respawn mid-swap could open a mismatched db/-wal pair.)
    //
    // Stage every file into a `.tmp` sibling first, and only rename them into
    // place once ALL copies have succeeded. If a copy fails partway, remove the
    // temps and abort with the live keychain untouched, so a failed restore can
    // never install a mismatched db/-wal/-shm set.
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut stale: Vec<PathBuf> = Vec::new();
    for name in SIM_KEYCHAIN_FILES {
        let src = src_dir.join(name);
        let dest = keychain_dir.join(name);
        if tokio::fs::try_exists(&src).await.unwrap_or(false) {
            let tmp = keychain_dir.join(format!("{name}.tapsmith-tmp"));
            if let Err(e) = tokio::fs::copy(&src, &tmp).await {
                for (t, _) in &staged {
                    let _ = tokio::fs::remove_file(t).await;
                }
                return Err(e).with_context(|| format!("Failed to stage keychain file {name}"));
            }
            staged.push((tmp, dest));
        } else if tokio::fs::try_exists(&dest).await.unwrap_or(false) {
            // src lacks this file (e.g. no -wal/-shm) — drop the stale dest so
            // a leftover WAL can't replay old transactions over the restored db.
            stale.push(dest);
        }
    }
    for (tmp, dest) in staged {
        tokio::fs::rename(&tmp, &dest)
            .await
            .with_context(|| format!("Failed to install keychain file {}", dest.display()))?;
    }
    for dest in stale {
        tokio::fs::remove_file(&dest)
            .await
            .with_context(|| format!("Failed to remove stale keychain file {}", dest.display()))?;
    }
    restart_securityd(udid).await?;
    info!(udid, "Simulator keychain restored");
    Ok(())
}

/// Delete the simulator's keychain db files, then restart securityd so it
/// recreates a fresh, empty keychain. Device-global: clears keychain items
/// for every app on the simulator.
#[instrument(skip_all, fields(udid))]
pub async fn clear_keychain(udid: &str, keychain_dir: &std::path::Path) -> Result<()> {
    // Unlink the db files *while securityd is still running*: its open fds keep
    // the old inodes alive (any final flush lands there and is discarded when
    // the process dies), so the delete can't race a respawn. Then restart so a
    // fresh securityd opens the db by name, finds nothing, and recreates an
    // empty keychain.
    let mut removed = 0;
    for name in SIM_KEYCHAIN_FILES {
        let path = keychain_dir.join(name);
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            tokio::fs::remove_file(&path)
                .await
                .with_context(|| format!("Failed to delete keychain file {name}"))?;
            removed += 1;
        }
    }
    if removed == 0 {
        debug!(udid, "No simulator keychain files to clear");
        return Ok(());
    }
    restart_securityd(udid).await?;
    info!(udid, "Simulator keychain cleared");
    Ok(())
}

/// Restart securityd inside the simulator so it re-reads the keychain db
/// from disk. securityd holds the db open; without this, file-level swaps
/// are ignored (or torn) until the daemon next reads it.
#[instrument]
pub async fn restart_securityd(udid: &str) -> Result<()> {
    const KNOWN_LABEL: &str = SECURITYD_LABEL;

    let kickstart = |label: String| async move {
        bounded_output(
            "simctl spawn launchctl kickstart",
            Command::new("xcrun").args([
                "simctl",
                "spawn",
                udid,
                "launchctl",
                "kickstart",
                "-k",
                &label,
            ]),
            SIMCTL_TIMEOUT,
        )
        .await
    };

    // Track the label actually kickstarted so the readiness probe below
    // queries the right one even when the label drifted.
    let mut active_label = KNOWN_LABEL.to_string();
    let output = kickstart(active_label.clone()).await?;
    if !output.status.success() {
        // Label drift across iOS runtimes: discover the actual securityd
        // label from launchctl and retry once.
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let discovered = discover_securityd_label(udid).await;
        let Some(label) = discovered else {
            bail!("launchctl kickstart {KNOWN_LABEL} failed ({stderr}) and no securityd service found via launchctl print system");
        };
        // Use the discovered label as-is when it already carries a domain
        // (`user/501/...`); only bare labels need the default `system/` domain.
        active_label = if label.contains('/') {
            label
        } else {
            format!("system/{label}")
        };
        let retry = kickstart(active_label.clone()).await?;
        if !retry.status.success() {
            let retry_stderr = String::from_utf8_lossy(&retry.stderr);
            bail!("launchctl kickstart failed for both {KNOWN_LABEL} ({stderr}) and {active_label} ({retry_stderr})");
        }
    }

    // Wait for securityd to come back up before the app is relaunched, so
    // keychain reads don't race the restart. launchctl print exits non-zero
    // while the service is still respawning.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let probe = bounded_output(
            "simctl spawn launchctl print",
            Command::new("xcrun").args([
                "simctl",
                "spawn",
                udid,
                "launchctl",
                "print",
                &active_label,
            ]),
            Duration::from_secs(5),
        )
        .await;
        if let Ok(out) = probe {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if out.status.success() && stdout.contains("state = running") {
                break;
            }
        }
        if std::time::Instant::now() >= deadline {
            debug!(
                udid,
                "securityd did not report running within 5s; continuing"
            );
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    debug!(udid, "securityd restarted");
    Ok(())
}

/// Parse `launchctl print system` output for a securityd service label,
/// returning it *with* any domain prefix (e.g. `system/com.apple.securityd`
/// or `user/501/com.apple.securityd`) so the caller can target the right
/// domain. The label appears in different positions depending on the section
/// (`<pid> <status> com.apple.securityd` in the services list, or
/// `<domain>/com.apple.securityd = {` in an endpoints block), so scan every
/// token. Tokens that are absolute paths (e.g. the daemon's `.plist` path,
/// which also contains `com.apple.securityd`) start with `/` and are skipped.
async fn discover_securityd_label(udid: &str) -> Option<String> {
    let output = bounded_output(
        "simctl spawn launchctl print system",
        Command::new("xcrun").args(["simctl", "spawn", udid, "launchctl", "print", "system"]),
        SIMCTL_TIMEOUT,
    )
    .await
    .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_securityd_label(&stdout)
}

fn parse_securityd_label(listing: &str) -> Option<String> {
    listing
        .split_whitespace()
        .find(|token| token.contains("com.apple.securityd") && !token.starts_with('/'))
        .map(|token| {
            token
                .trim_matches(|c: char| {
                    !c.is_alphanumeric() && c != '.' && c != '-' && c != '_' && c != '/'
                })
                .to_string()
        })
}

// ─── Network Proxy Helpers ───

/// Install a CA certificate on the iOS simulator for MITM HTTPS interception.
///
/// Uses `xcrun simctl keychain` (Xcode 15+) to add a root certificate to the
/// simulator's trust store. This allows the MITM proxy to intercept HTTPS traffic.
#[instrument]
pub async fn install_ca_cert(udid: &str, ca_pem_path: &str) -> Result<()> {
    // This call talks to the simulator's securityd/trustd — the exact spot a
    // wedged CoreSimulator hangs (a single invocation was observed taking
    // ~10.5 minutes on CI, starving every StartNetworkCapture behind it).
    let output = bounded_output(
        "simctl keychain add-root-cert",
        Command::new("xcrun").args(["simctl", "keychain", udid, "add-root-cert", ca_pem_path]),
        SIMCTL_TIMEOUT,
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to install CA cert on simulator {udid}: {stderr}");
    }

    info!(udid, "CA certificate installed on simulator");
    Ok(())
}

/// Clear app data by uninstalling and reinstalling.
#[allow(dead_code)]
#[instrument(skip(app_path))]
pub async fn clear_app_data(udid: &str, bundle_id: &str, app_path: Option<&str>) -> Result<()> {
    // Uninstall the app
    let output = bounded_output(
        "simctl uninstall",
        Command::new("xcrun").args(["simctl", "uninstall", udid, bundle_id]),
        Duration::from_secs(60),
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug!(stderr = %stderr, "Uninstall may have failed (app might not be installed)");
    }

    // Reinstall if app path is provided
    if let Some(path) = app_path {
        install_app(udid, path).await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_dir_derived_from_standard_container_path() {
        let container = "/Users/sam/Library/Developer/CoreSimulator/Devices/ABC-123/data/Containers/Data/Application/DEF-456";
        assert_eq!(
            simulator_keychain_dir(container),
            Some(PathBuf::from(
                "/Users/sam/Library/Developer/CoreSimulator/Devices/ABC-123/data/Library/Keychains"
            ))
        );
    }

    #[test]
    fn keychain_dir_derived_from_custom_device_set() {
        let container = "/tmp/custom-set/Devices/ABC-123/data/Containers/Data/Application/DEF-456";
        assert_eq!(
            simulator_keychain_dir(container),
            Some(PathBuf::from(
                "/tmp/custom-set/Devices/ABC-123/data/Library/Keychains"
            ))
        );
    }

    #[test]
    fn keychain_dir_rejects_unrecognized_path() {
        assert_eq!(simulator_keychain_dir("/some/random/path"), None);
        assert_eq!(simulator_keychain_dir(""), None);
    }

    #[test]
    fn keychain_member_detected_in_tar_listing() {
        let listing =
            "./\n./Documents/\n./.tapsmith-keychain/\n./.tapsmith-keychain/keychain-2-debug.db\n";
        assert!(archive_has_keychain_member(listing));
        // bsdtar sometimes omits the ./ prefix
        let listing = ".tapsmith-keychain/keychain-2-debug.db\n";
        assert!(archive_has_keychain_member(listing));
    }

    #[test]
    fn securityd_label_parsed_from_various_formats() {
        // Services-list format: <pid> <status> <label> (no domain prefix)
        assert_eq!(
            parse_securityd_label("\t58242\t0\tcom.apple.securityd\n"),
            Some("com.apple.securityd".to_string())
        );
        // Endpoints-block format: <domain>/<label> = { — prefix preserved
        assert_eq!(
            parse_securityd_label("    system/com.apple.securityd = {\n"),
            Some("system/com.apple.securityd".to_string())
        );
        // user domain prefix preserved (so restart targets the right domain)
        assert_eq!(
            parse_securityd_label("user/501/com.apple.securityd = {"),
            Some("user/501/com.apple.securityd".to_string())
        );
        // Absolute paths that merely contain the label (e.g. the .plist path)
        // must not be mistaken for the service target.
        assert_eq!(
            parse_securityd_label(
                "\tpath = /System/Library/LaunchDaemons/com.apple.securityd.plist\n"
            ),
            None
        );
        assert_eq!(parse_securityd_label("no match here\n"), None);
    }

    #[test]
    fn keychain_dir_uses_last_data_containers_segment() {
        // A parent dir containing the marker must not shadow the real one.
        let container = "/Users/data/Containers/x/Developer/CoreSimulator/Devices/UDID/data/Containers/Data/Application/APP";
        assert_eq!(
            simulator_keychain_dir(container),
            Some(PathBuf::from(
                "/Users/data/Containers/x/Developer/CoreSimulator/Devices/UDID/data/Library/Keychains"
            ))
        );
    }

    #[test]
    fn keychain_member_absent_in_old_archives() {
        let listing = "./\n./Documents/\n./Library/\n./Library/Preferences/app.plist\n";
        assert!(!archive_has_keychain_member(listing));
        // A user file that merely contains the name elsewhere must not match
        assert!(!archive_has_keychain_member(
            "./Documents/notes-about-.tapsmith-keychain.txt\n"
        ));
    }

    #[test]
    fn retryable_open_url_error_matches_simctl_timeout() {
        let message = "Failed to open URL on B54345BC: An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=60):\nSimulator device failed to open tapsmithtest:///profile.\nOperation timed out";
        assert!(is_retryable_open_url_error(message));
    }

    #[test]
    fn retryable_open_url_error_matches_daemon_timeout() {
        assert!(is_retryable_open_url_error(
            "Operation timed out opening URL on B54345BC: tapsmithtest:///profile"
        ));
    }

    #[test]
    fn retryable_open_url_error_rejects_non_timeout_failures() {
        assert!(!is_retryable_open_url_error(
            "Failed to open URL on ABC: No such file or directory"
        ));
    }

    /// Real devicectl JSON captured from `xcrun devicectl list devices` with
    /// one unpaired iPhone connected. Used to verify that parsing is robust to
    /// unpaired devices (`ddiServicesAvailable: false`, `pairingState: "unpaired"`).
    const DEVICECTL_UNPAIRED_IPHONE: &str = r#"{
      "info": {
        "arguments": ["devicectl","list","devices","--json-output","/tmp/x"],
        "commandType": "devicectl.list.devices",
        "environment": {},
        "jsonVersion": 3,
        "outcome": "success",
        "version": "518.27"
      },
      "result": {
        "devices": [
          {
            "connectionProperties": {
              "isMobileDeviceOnly": false,
              "pairingState": "unpaired",
              "transportType": "wired",
              "tunnelState": "disconnected"
            },
            "deviceProperties": {
              "bootState": "booted",
              "ddiServicesAvailable": false,
              "name": "Sam\u2019s iPhone",
              "osBuildUpdate": "23C71",
              "osVersionNumber": "26.2.1"
            },
            "hardwareProperties": {
              "deviceType": "iPhone",
              "platform": "iOS",
              "productType": "iPhone17,1",
              "udid": "00008140-00096C9014F3001C"
            },
            "identifier": "EBAACA98-F83F-5F5A-85A7-23F989DD5585"
          }
        ]
      }
    }"#;

    #[test]
    fn parse_devicectl_devices_extracts_unpaired_iphone() {
        let devices = parse_devicectl_devices(DEVICECTL_UNPAIRED_IPHONE).unwrap();
        assert_eq!(devices.len(), 1);
        let d = &devices[0];
        assert_eq!(d.udid, "00008140-00096C9014F3001C");
        // The unicode curly apostrophe must survive round-tripping so the
        // name displayed to the user matches what they see in Xcode / Settings.
        assert_eq!(d.name, "Sam\u{2019}s iPhone");
        assert!(!d.is_simulator);
        assert!(
            !d.is_paired,
            "unpaired device should surface is_paired=false"
        );
        assert!(!d.ddi_services_available);
        assert_eq!(d.os_version, "26.2.1");
        assert_eq!(d.state, "Booted");
    }

    #[test]
    fn parse_devicectl_devices_filters_non_ios_entries() {
        // devicectl also lists paired Apple Watches, Apple TVs, and Macs
        // under certain Xcode configurations. Tapsmith only drives iOS, so
        // those must be filtered out at parse time.
        let json = r#"{
          "result": {
            "devices": [
              {
                "hardwareProperties": { "platform": "iOS", "udid": "IPHONE-UDID" },
                "deviceProperties": { "name": "iPhone", "bootState": "booted" },
                "connectionProperties": { "pairingState": "paired" }
              },
              {
                "hardwareProperties": { "platform": "watchOS", "udid": "WATCH-UDID" },
                "deviceProperties": { "name": "Apple Watch", "bootState": "booted" },
                "connectionProperties": { "pairingState": "paired" }
              },
              {
                "hardwareProperties": { "platform": "macOS", "udid": "MAC-UDID" },
                "deviceProperties": { "name": "Mac mini", "bootState": "booted" },
                "connectionProperties": { "pairingState": "paired" }
              }
            ]
          }
        }"#;
        let devices = parse_devicectl_devices(json).unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].udid, "IPHONE-UDID");
    }

    #[test]
    fn parse_devicectl_devices_filters_simulators_xcode27() {
        // Xcode 27's devicectl lists simulators alongside real hardware,
        // flagged `reality: "simulated"`. Only real hardware — flagged
        // "physical", or unflagged on older Xcode — must survive.
        let json = r#"{
          "result": {
            "devices": [
              {
                "hardwareProperties": { "platform": "iOS", "udid": "REAL-UDID", "reality": "physical" },
                "deviceProperties": { "name": "iPhone", "bootState": "booted" },
                "connectionProperties": { "pairingState": "paired" }
              },
              {
                "hardwareProperties": { "platform": "iOS", "udid": "SIM-UDID", "reality": "simulated" },
                "deviceProperties": { "name": "iPhone 17", "bootState": "shutdown" },
                "connectionProperties": { "pairingState": "paired" }
              },
              {
                "hardwareProperties": { "platform": "iOS", "udid": "OLD-XCODE-UDID" },
                "deviceProperties": { "name": "iPhone 15", "bootState": "booted" },
                "connectionProperties": {}
              }
            ]
          }
        }"#;
        let devices = parse_devicectl_devices(json).unwrap();
        let udids: Vec<&str> = devices.iter().map(|d| d.udid.as_str()).collect();
        assert_eq!(udids, vec!["REAL-UDID", "OLD-XCODE-UDID"]);
    }

    #[test]
    fn parse_devicectl_devices_accepts_empty_result() {
        let json = r#"{ "result": { "devices": [] } }"#;
        let devices = parse_devicectl_devices(json).unwrap();
        assert!(devices.is_empty());
    }

    #[test]
    fn parse_devicectl_devices_skips_entries_missing_udid() {
        // Defensive against devicectl versions that might emit partial entries.
        let json = r#"{
          "result": {
            "devices": [
              {
                "hardwareProperties": { "platform": "iOS" },
                "deviceProperties": { "name": "weird" }
              }
            ]
          }
        }"#;
        let devices = parse_devicectl_devices(json).unwrap();
        assert!(devices.is_empty());
    }

    #[test]
    fn parse_devicectl_devices_reports_shutdown_when_not_booted() {
        let json = r#"{
          "result": {
            "devices": [
              {
                "hardwareProperties": { "platform": "iOS", "udid": "U" },
                "deviceProperties": { "name": "N", "bootState": "unknown" },
                "connectionProperties": { "pairingState": "paired" }
              }
            ]
          }
        }"#;
        let devices = parse_devicectl_devices(json).unwrap();
        assert_eq!(devices[0].state, "Shutdown");
    }

    #[test]
    fn extract_devicectl_error_hint_returns_none_for_empty_input() {
        assert!(extract_devicectl_error_hint(None).is_none());
        assert!(extract_devicectl_error_hint(Some("not json")).is_none());
        assert!(extract_devicectl_error_hint(Some("{}")).is_none());
    }

    #[test]
    fn extract_devicectl_error_hint_parses_localized_description() {
        // devicectl wraps localized strings in { "string": "..." } objects
        // when the underlying NSError is serialized. Verify we reach through.
        let json = r#"{
          "error": {
            "userInfo": {
              "NSLocalizedDescription": {
                "string": "The operation couldn't be completed. (CoreDeviceError error 6.)"
              }
            }
          }
        }"#;
        let hint = extract_devicectl_error_hint(Some(json)).unwrap();
        assert!(hint.contains("CoreDeviceError error 6"));
    }

    #[test]
    fn scratch_json_paths_do_not_collide() {
        let a = scratch_json_path("foo");
        let b = scratch_json_path("foo");
        assert_ne!(a, b);
        // Both live under the OS temp dir so they get auto-cleaned.
        assert!(a.starts_with(std::env::temp_dir()));
    }
}
