use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use tokio::process::Command;
use tracing::{debug, info, instrument, warn};

/// Locate the `adb` binary on PATH.
pub async fn find_adb() -> Result<PathBuf> {
    let cmd = if cfg!(windows) { "where" } else { "which" };
    let output = Command::new(cmd)
        .arg("adb")
        .output()
        .await
        .context(format!("Failed to execute `{cmd} adb`"))?;

    if !output.status.success() {
        bail!("adb not found on PATH");
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(PathBuf::from(path))
}

/// Parsed device entry from `adb devices`.
#[derive(Debug, Clone)]
pub struct AdbDevice {
    pub serial: String,
    pub state: String,
}

impl AdbDevice {
    pub fn is_online(&self) -> bool {
        self.state == "device"
    }

    pub fn is_emulator(&self) -> bool {
        self.serial.starts_with("emulator-") || self.serial.starts_with("localhost:")
    }
}

/// Run an adb command targeting a specific device, returning stdout bytes.
async fn run_adb(serial: Option<&str>, args: &[&str], timeout: Duration) -> Result<Vec<u8>> {
    let mut cmd = Command::new("adb");

    if let Some(s) = serial {
        cmd.arg("-s").arg(s);
    }

    cmd.args(args);

    debug!(serial = serial, args = ?args, "Running adb command");

    let output = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| anyhow!("adb command timed out after {timeout:?}"))?
        .context("Failed to execute adb")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("adb command failed (exit {}): {stderr}", output.status);
    }

    Ok(output.stdout)
}

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const ADB_TRANSPORT_RETRY_ATTEMPTS: usize = 3;
const ADB_TRANSPORT_RECOVERY_TIMEOUT: Duration = Duration::from_secs(45);
const ADB_READY_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const ADB_READY_PACKAGE_TIMEOUT: Duration = Duration::from_secs(10);
const ADB_READY_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// System CA certificate directory. Certs here are trusted by all apps
/// without needing a per-app `network_security_config.xml`. Writable only
/// on rooted emulators after `adb remount`.
const SYSTEM_CA_CERT_DIR: &str = "/system/etc/security/cacerts";

/// User-installed CA certificate directory. Apps must include
/// `<certificates src="user"/>` in their network security config to
/// trust these on Android API 24+.
const USER_CA_CERT_DIR: &str = "/data/misc/user/0/cacerts-added";

/// Conscrypt APEX CA certificate directory — the *runtime* trust store on
/// Android 14+ (API 34+). It is independent of [`SYSTEM_CA_CERT_DIR`] and is
/// not made writable by `adb remount`, so the cert is injected via a tmpfs
/// overlay inside the zygote mount namespace (see [`try_install_apex_ca`]).
const APEX_CA_CERT_DIR: &str = "/apex/com.android.conscrypt/cacerts";

/// List connected ADB devices.
#[instrument]
pub async fn list_devices() -> Result<Vec<AdbDevice>> {
    let stdout = run_adb(None, &["devices", "-l"], DEFAULT_TIMEOUT).await?;
    let output = String::from_utf8_lossy(&stdout);

    let mut devices = Vec::new();

    for line in output.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let mut parts = line.split_whitespace();
        let serial = match parts.next() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let state = parts.next().unwrap_or("unknown").to_string();

        devices.push(AdbDevice { serial, state });
    }

    debug!(count = devices.len(), "Found ADB devices");
    Ok(devices)
}

/// Get the model name for a device.
#[instrument]
pub async fn get_device_model(serial: &str) -> Result<String> {
    let stdout = run_adb(
        Some(serial),
        &["shell", "getprop", "ro.product.model"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(String::from_utf8_lossy(&stdout).trim().to_string())
}

/// Get the human-friendly Android OS version (e.g. "14") for a device.
#[instrument]
pub async fn get_device_os_version(serial: &str) -> Result<String> {
    let stdout = run_adb(
        Some(serial),
        &["shell", "getprop", "ro.build.version.release"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(String::from_utf8_lossy(&stdout).trim().to_string())
}

/// Extract the package name from an `INSTALL_FAILED_UPDATE_INCOMPATIBLE`
/// error message. Modern adb embeds the failure mid-line
/// (`adb: failed to install x.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE:
/// Existing package com.foo signatures do not match ...]`), legacy pm output
/// puts `Failure [...]` at the start of a line — so we locate the marker
/// anywhere and parse only within the bracketed failure detail. Text before
/// the marker (e.g. the APK file path) is never consulted, so a crafted
/// filename can't inject a package name.
fn parse_incompatible_package(msg: &str) -> Option<&str> {
    let idx = msg.find("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE")?;
    let tail = &msg[idx..];
    // Stop at the closing bracket or end of line, whichever comes first —
    // a failure line missing its `]` must not let the slice span into
    // subsequent lines (which can contain the user-supplied APK path).
    let end = [tail.find(']'), tail.find('\n')]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(tail.len());
    let tail = &tail[..end];
    tail.split("Existing package ")
        .nth(1)
        .or_else(|| tail.split("Package ").nth(1))
        .and_then(|s| s.split_whitespace().next())
        .map(|s| s.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '.' && c != '_'))
        // Require a plausible Android package name (multi-segment, valid
        // charset). Some Android versions omit the package name entirely
        // ("Package signatures do not match...") — without this check we'd
        // parse the word "signatures" and try to uninstall it.
        .filter(|s| {
            s.contains('.')
                && s.starts_with(|c: char| c.is_ascii_alphabetic())
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
        })
}

/// Install an APK on the device. Uses `-r` to allow reinstall.
///
/// With `recover_signature_mismatch`, an `INSTALL_FAILED_UPDATE_INCOMPATIBLE`
/// failure (APK signed with a different key than the installed version)
/// triggers an automatic uninstall + retry. Uninstalling wipes the package's
/// app data, so this is only safe for packages we own (the Tapsmith agent) —
/// user apps installed via the InstallApk RPC must not opt in.
#[instrument(skip(apk_path))]
pub async fn install_apk(
    serial: &str,
    apk_path: &str,
    recover_signature_mismatch: bool,
) -> Result<()> {
    let timeout = Duration::from_secs(120);
    let result = run_adb_with_transport_recovery(
        serial,
        &["install", "-r", apk_path],
        timeout,
        "install APK",
    )
    .await;
    if recover_signature_mismatch {
        if let Err(e) = &result {
            let msg = e.to_string();
            if let Some(pkg) = parse_incompatible_package(&msg) {
                info!("Signature mismatch for {pkg} — uninstalling and retrying");
                let _ = run_adb(Some(serial), &["uninstall", pkg], DEFAULT_TIMEOUT).await;
                run_adb_with_transport_recovery(
                    serial,
                    &["install", "-r", apk_path],
                    timeout,
                    "install APK (retry after uninstall)",
                )
                .await?;
                return Ok(());
            }
        }
    }
    result?;
    Ok(())
}

/// Set up TCP port forwarding: `adb forward tcp:<host_port> tcp:<device_port>`.
#[instrument]
pub async fn forward_port(serial: &str, host_port: u16, device_port: u16) -> Result<()> {
    let host_arg = format!("tcp:{host_port}");
    let device_arg = format!("tcp:{device_port}");
    run_adb(
        Some(serial),
        &["forward", &host_arg, &device_arg],
        DEFAULT_TIMEOUT,
    )
    .await?;
    debug!(host_port, device_port, "Port forwarding established");
    Ok(())
}

/// Remove a specific port forward.
#[instrument]
pub async fn remove_forward(serial: &str, host_port: u16) -> Result<()> {
    remove_forward_with_timeout(serial, host_port, DEFAULT_TIMEOUT).await
}

/// Remove a specific port forward with a caller-provided timeout.
#[instrument]
pub async fn remove_forward_with_timeout(
    serial: &str,
    host_port: u16,
    timeout: Duration,
) -> Result<()> {
    let host_arg = format!("tcp:{host_port}");
    run_adb(Some(serial), &["forward", "--remove", &host_arg], timeout).await?;
    Ok(())
}

/// Set up reverse port forwarding: `adb reverse tcp:<device_port> tcp:<host_port>`.
///
/// Makes `127.0.0.1:<device_port>` on the device forward to `127.0.0.1:<host_port>`
/// on the host. More reliable than `settings put global http_proxy` with `10.0.2.2`
/// because it works at the ADB transport level.
#[instrument]
pub async fn reverse_port(serial: &str, device_port: u16, host_port: u16) -> Result<()> {
    let device_arg = format!("tcp:{device_port}");
    let host_arg = format!("tcp:{host_port}");
    run_adb(
        Some(serial),
        &["reverse", &device_arg, &host_arg],
        DEFAULT_TIMEOUT,
    )
    .await?;
    debug!(
        device_port,
        host_port, "Reverse port forwarding established"
    );
    Ok(())
}

/// Remove a specific reverse port forward with a caller-provided timeout.
#[instrument]
pub async fn remove_reverse_with_timeout(
    serial: &str,
    device_port: u16,
    timeout: Duration,
) -> Result<()> {
    let device_arg = format!("tcp:{device_port}");
    run_adb(Some(serial), &["reverse", "--remove", &device_arg], timeout).await?;
    Ok(())
}

/// Execute a shell command on the device, returning stdout as a String.
#[instrument]
pub async fn shell(serial: &str, command: &str) -> Result<String> {
    let stdout =
        run_adb_with_transport_recovery(serial, &["shell", command], DEFAULT_TIMEOUT, "adb shell")
            .await?;
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

/// Capture a screenshot from the device, returning raw PNG bytes.
#[instrument]
pub async fn screencap(serial: &str) -> Result<Vec<u8>> {
    let timeout = Duration::from_secs(15);
    let png = run_adb(Some(serial), &["exec-out", "screencap", "-p"], timeout).await?;

    if png.len() < 8 {
        bail!(
            "screencap returned too few bytes ({}), device may be locked",
            png.len()
        );
    }

    // Validate PNG magic bytes
    if &png[..4] != b"\x89PNG" {
        bail!("screencap output does not appear to be valid PNG data");
    }

    debug!(bytes = png.len(), "Screenshot captured");
    Ok(png)
}

/// Spawn `adb shell screenrecord` to record the device screen to a file
/// at `remote_path` on the device. Returns the running child process so the
/// caller can stop it later by sending SIGINT (`Child::kill_on_drop` is set,
/// so an unsent stop will still clean up on drop).
///
/// `size` is `(width, height)`; when supplied, passed as `--size WxH`. When
/// `None`, screenrecord uses the device's native resolution.
///
/// Note: Android's `screenrecord` truncates at 3 minutes per invocation. The
/// caller is responsible for surfacing that to the user when the recording
/// duration approaches the cap.
#[instrument]
pub async fn screenrecord_spawn(
    serial: &str,
    remote_path: &str,
    size: Option<(u32, u32)>,
) -> Result<tokio::process::Child> {
    let mut cmd = Command::new("adb");
    cmd.arg("-s").arg(serial);
    cmd.arg("shell");
    let mut shell_cmd = String::from("screenrecord");
    if let Some((w, h)) = size {
        shell_cmd.push_str(&format!(" --size {w}x{h}"));
    }
    shell_cmd.push(' ');
    // Shell-escape the remote path: replace ' with '\'' then wrap in
    // single quotes so spaces and special chars are handled safely.
    let escaped = remote_path.replace('\'', "'\\''");
    shell_cmd.push_str(&format!("'{escaped}'"));
    cmd.arg(&shell_cmd);
    cmd.kill_on_drop(true);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    debug!(serial, remote_path, "Spawning adb shell screenrecord");
    let child = cmd.spawn().context("Failed to spawn adb screenrecord")?;
    Ok(child)
}

/// Check if a package is installed on the device.
#[instrument]
pub async fn is_package_installed(serial: &str, package: &str) -> Result<bool> {
    let stdout = shell_lenient(serial, &format!("pm list packages {package}")).await?;
    Ok(stdout.contains(&format!("package:{package}")))
}

/// Push a local file to the device via `adb push`.
#[instrument(skip(local_path, remote_path))]
pub async fn push_file(serial: &str, local_path: &str, remote_path: &str) -> Result<()> {
    run_adb(
        Some(serial),
        &["push", local_path, remote_path],
        DEFAULT_TIMEOUT,
    )
    .await?;
    debug!(local_path, remote_path, "File pushed to device");
    Ok(())
}

/// Push in-memory text to `remote_path` on the device via a host temp file.
/// Avoids shell-quoting pitfalls when delivering SQL scripts or other payloads
/// that contain metacharacters.
pub async fn push_text(serial: &str, contents: &str, remote_path: &str) -> Result<()> {
    let dir = tempfile::tempdir().context("create temp dir")?;
    let host_path = dir.path().join("payload");
    tokio::fs::write(&host_path, contents)
        .await
        .context("write host temp file")?;
    push_file(serial, &host_path.to_string_lossy(), remote_path)
        .await
        .context("adb push")?;
    Ok(())
}

/// Best-effort RAII cleanup for temporary files written onto a device.
///
/// Tracks device paths and `rm -f`s them when dropped — including when the
/// owning future is cancelled (client disconnect, RPC deadline) or panics, paths
/// that a plain post-`await` cleanup line would miss. Removal is spawned as a
/// detached task (the device call is async and `Drop` is not); if no Tokio
/// runtime is available at drop time (daemon already shutting down) cleanup is
/// skipped rather than panicking.
pub struct DeviceFileGuard {
    serial: String,
    paths: Vec<String>,
}

impl DeviceFileGuard {
    pub fn new(serial: impl Into<String>) -> Self {
        Self {
            serial: serial.into(),
            paths: Vec::new(),
        }
    }

    /// Register a device path to be removed when this guard drops.
    pub fn track(&mut self, path: impl Into<String>) {
        self.paths.push(path.into());
    }
}

impl Drop for DeviceFileGuard {
    fn drop(&mut self) {
        if self.paths.is_empty() {
            return;
        }
        let serial = self.serial.clone();
        let paths = std::mem::take(&mut self.paths);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                for path in paths {
                    // Single-quote the path (escaping embedded quotes) so spaces
                    // or shell metacharacters can't split the argument or inject.
                    let escaped = path.replace('\'', "'\\''");
                    let _ = shell_lenient(&serial, &format!("rm -f '{escaped}'")).await;
                }
            });
        }
    }
}

/// Pull a file from the device to a local path via `adb pull`.
#[instrument(skip(local_path, remote_path))]
pub async fn pull_file(serial: &str, remote_path: &str, local_path: &str) -> Result<()> {
    let timeout = Duration::from_secs(300); // large app data can take a while
    run_adb(Some(serial), &["pull", remote_path, local_path], timeout).await?;
    debug!(remote_path, local_path, "File pulled from device");
    Ok(())
}

/// Execute a shell command on the device with a custom timeout, returning stdout as a String.
#[instrument]
pub async fn shell_with_timeout(serial: &str, command: &str, timeout: Duration) -> Result<String> {
    let stdout = run_adb(Some(serial), &["shell", command], timeout).await?;
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

/// Wait until ADB reports the device online, Android has completed boot, and
/// package manager calls are working. `sys.boot_completed=1` alone can be too
/// early on hosted CI: the next `adb install` may still hit a transient
/// `device offline` or unavailable package-manager transport.
#[instrument]
pub async fn wait_for_device_ready(serial: &str, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    let mut last_error = "device was not ready".to_string();

    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }

        let wait_timeout = remaining.min(Duration::from_secs(10));
        if let Err(e) = run_adb(Some(serial), &["wait-for-device"], wait_timeout).await {
            last_error = e.to_string();
            tokio::time::sleep(ADB_READY_POLL_INTERVAL.min(remaining)).await;
            continue;
        }

        match run_adb(Some(serial), &["get-state"], ADB_READY_COMMAND_TIMEOUT).await {
            Ok(stdout) => {
                let state = String::from_utf8_lossy(&stdout).trim().to_string();
                if state != "device" {
                    last_error = format!("adb get-state returned {state:?}");
                    tokio::time::sleep(ADB_READY_POLL_INTERVAL.min(remaining)).await;
                    continue;
                }
            }
            Err(e) => {
                last_error = e.to_string();
                tokio::time::sleep(ADB_READY_POLL_INTERVAL.min(remaining)).await;
                continue;
            }
        }

        match run_adb(
            Some(serial),
            &["shell", "getprop sys.boot_completed"],
            ADB_READY_COMMAND_TIMEOUT,
        )
        .await
        {
            Ok(stdout) => {
                let boot_completed = String::from_utf8_lossy(&stdout).trim().to_string();
                if boot_completed != "1" {
                    last_error = format!("sys.boot_completed={boot_completed:?}");
                    tokio::time::sleep(ADB_READY_POLL_INTERVAL.min(remaining)).await;
                    continue;
                }
            }
            Err(e) => {
                last_error = e.to_string();
                tokio::time::sleep(ADB_READY_POLL_INTERVAL.min(remaining)).await;
                continue;
            }
        }

        match run_adb(
            Some(serial),
            &["shell", "cmd package list packages >/dev/null"],
            ADB_READY_PACKAGE_TIMEOUT,
        )
        .await
        {
            Ok(_) => return Ok(()),
            Err(e) => {
                last_error = e.to_string();
                tokio::time::sleep(ADB_READY_POLL_INTERVAL.min(remaining)).await;
            }
        }
    }

    bail!(
        "Android device {serial} was not ready after {:?}: {last_error}",
        timeout
    )
}

async fn run_adb_with_transport_recovery(
    serial: &str,
    args: &[&str],
    timeout: Duration,
    operation: &str,
) -> Result<Vec<u8>> {
    for attempt in 1..=ADB_TRANSPORT_RETRY_ATTEMPTS {
        match run_adb(Some(serial), args, timeout).await {
            Ok(stdout) => return Ok(stdout),
            Err(e) => {
                let message = e.to_string();
                if attempt == ADB_TRANSPORT_RETRY_ATTEMPTS
                    || !is_retryable_adb_transport_error(&message)
                {
                    return Err(e);
                }

                warn!(
                    %serial,
                    operation,
                    attempt,
                    max_attempts = ADB_TRANSPORT_RETRY_ATTEMPTS,
                    error = %message,
                    "ADB transport failure; waiting for device and retrying"
                );

                if let Err(recovery_err) =
                    wait_for_device_ready(serial, ADB_TRANSPORT_RECOVERY_TIMEOUT).await
                {
                    bail!(
                        "{operation} failed after retryable ADB transport error ({message}); \
                         device did not recover: {recovery_err}"
                    );
                }
            }
        }
    }

    unreachable!("ADB retry loop must return on success or final failure")
}

fn is_retryable_adb_transport_error(message: &str) -> bool {
    let msg = message.to_ascii_lowercase();
    if msg.contains("device '") && msg.contains("' not found") {
        return true;
    }

    [
        "device offline",
        "device still connecting",
        "no devices/emulators found",
        "device not found",
        "transport is down",
        "transport endpoint is not connected",
        "failed to read response from server",
        "protocol fault",
        "connection reset",
        "broken pipe",
        "closed",
    ]
    .iter()
    .any(|needle| msg.contains(needle))
}

/// Install a CA certificate on the device for MITM HTTPS interception.
///
/// `cert_filename` is the hash-based filename (e.g. `a1b2c3d4.0`) required by
/// Android's certificate store. See [`crate::mitm_ca::MitmAuthority::device_cert_filename`].
///
/// On emulators (rooted `userdebug` images), attempts to install into the
/// **system** CA store so every app trusts the cert without needing a
/// per-app `network_security_config.xml`. Falls back to the **user** CA
/// store when the system partition cannot be remounted (physical devices,
/// production images).
///
/// Returns the on-device path where the cert was installed, so the caller
/// can clean it up later.
pub async fn install_ca_cert(
    serial: &str,
    ca_pem_path: &str,
    cert_filename: &str,
) -> Result<String> {
    // Check if already running as root (e.g. CLI called `adb root` during setup)
    let already_root = shell_lenient(serial, "id")
        .await
        .map(|out| out.contains("uid=0"))
        .unwrap_or(false);

    if already_root {
        debug!(%serial, "adb already running as root, skipping adb root");
    } else {
        // Attempt to restart adb as root — required for writing to system dirs
        let root_result = run_adb_lenient(serial, &["root"]).await;
        match root_result {
            Ok(output) => {
                let msg = String::from_utf8_lossy(&output);
                if msg.contains("cannot run as root") || msg.contains("adbd cannot run as root") {
                    let hint = adb_root_unavailable_hint(serial).await;
                    tracing::warn!(%serial, "Device does not support adb root — {hint}");
                    return Err(anyhow::anyhow!("Device does not support adb root — {hint}"));
                }
                debug!(%serial, "adb root succeeded, waiting for device");
            }
            Err(e) => {
                tracing::warn!(%serial, "adb root failed: {e} — CA must be installed manually");
                return Err(anyhow::anyhow!(
                    "adb root failed: {e} — HTTPS traffic will not be captured"
                ));
            }
        }

        // Wait for device to come back after root restart
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let _ = run_adb(Some(serial), &["wait-for-device"], DEFAULT_TIMEOUT).await;
    }

    let tmp_cert = format!("/data/local/tmp/tapsmith-ca-{cert_filename}.pem");

    let result = async {
        // Push cert to a temp location
        push_file(serial, ca_pem_path, &tmp_cert).await?;

        // Try the system CA store first (works on rooted emulators where
        // `/system/etc/security/cacerts` is both writable and the effective
        // runtime trust store — pre-Android-14, and CI's cold-booted images).
        let system_path = format!("{SYSTEM_CA_CERT_DIR}/{cert_filename}");
        if try_install_system_ca(serial, cert_filename, &system_path, &tmp_cert).await {
            return Ok(system_path);
        }

        // Android 14+ (API 34+): the runtime trust store moved to the Conscrypt
        // APEX, which `adb remount` can't write, so the system-store path above
        // silently has no effect there. Overlay the APEX cacerts dir inside the
        // zygote mount namespace instead, so apps launched afterwards trust the
        // cert without needing a per-app network_security_config.xml.
        if device_sdk_int(serial).await.map(|v| v >= 34).unwrap_or(false)
            && try_install_apex_ca(serial, cert_filename, &tmp_cert).await
        {
            // The APEX overlays live in the per-zygote mount namespaces and are
            // volatile (cleared on reboot), so there's nothing for the
            // capture-stop `rm -f` to clean. Pointing it at the overlay path
            // would actually be harmful: the init-namespace view is writable, so
            // the `rm` would strip our cert there and make the next capture's
            // idempotency check miss and stack a fresh tmpfs mount. Return the
            // temp path (already deleted at the end of this fn) so cleanup is a
            // true no-op.
            return Ok(tmp_cert.clone());
        }

        // Fall back to the user CA store (requires network_security_config.xml).
        let user_path = format!("{USER_CA_CERT_DIR}/{cert_filename}");
        shell(serial, &format!("mkdir -p {USER_CA_CERT_DIR}")).await?;
        shell(serial, &format!("cp {tmp_cert} {user_path}")).await?;
        if let Err(e) = shell(serial, &format!("chmod 644 {user_path}")).await {
            let _ = shell(serial, &format!("rm -f {user_path}")).await;
            return Err(e);
        }

        info!(
            %serial, cert_filename,
            "CA certificate installed in user store (apps need network_security_config.xml to trust it)"
        );
        Ok(user_path)
    }
    .await;

    let _ = shell(serial, &format!("rm -f {tmp_cert}")).await;

    result
}

/// Compose an actionable hint for when `adb root` is unavailable.
///
/// On emulators this almost always means a production system image — in
/// practice a Google Play (`google_apis_playstore`) AVD, since Google APIs
/// and AOSP emulator images are rootable `userdebug` builds. Recreating the
/// AVD is the real fix there; a manual user-store CA install only helps apps
/// that opt in via `network_security_config.xml`.
async fn adb_root_unavailable_hint(serial: &str) -> String {
    // Serial prefix identifies locally-launched emulators without any adb
    // roundtrips; the getprop probe stays as a fallback for emulators
    // reached over TCP (e.g. CI port-forwards with an opaque serial).
    let mut is_emulator = serial.starts_with("emulator-") || serial.starts_with("localhost:");
    if !is_emulator {
        for prop in ["ro.kernel.qemu", "ro.boot.qemu"] {
            if shell_lenient(serial, &format!("getprop {prop}"))
                .await
                .map(|v| v.trim() == "1")
                .unwrap_or(false)
            {
                is_emulator = true;
                break;
            }
        }
    }
    let product_name = shell_lenient(serial, "getprop ro.product.name")
        .await
        .unwrap_or_default();
    root_unavailable_hint(is_emulator, product_name.trim())
}

fn root_unavailable_hint(is_emulator: bool, product_name: &str) -> String {
    if is_emulator {
        let image = if product_name.contains("playstore") {
            "a Google Play (google_apis_playstore)"
        } else {
            "a production"
        };
        format!(
            "this emulator runs {image} system image, which blocks root. \
             Recreate the AVD with a Google APIs image (`npx tapsmith create-avd`) \
             to enable HTTPS capture"
        )
    } else {
        "install the CA cert manually from ~/.tapsmith/ca.pem \
         (apps must opt in via network_security_config.xml to trust user-installed CAs)"
            .to_string()
    }
}

/// Try to remount /system and install the CA cert into the system trust store.
/// Returns `true` on success, `false` if remount or install failed (caller
/// should fall back to the user store).
async fn try_install_system_ca(
    serial: &str,
    cert_filename: &str,
    system_path: &str,
    tmp_cert_path: &str,
) -> bool {
    // `adb remount` makes /system writable on userdebug/eng emulator images.
    if let Err(e) = run_adb_lenient(serial, &["remount"]).await {
        debug!(%serial, "adb remount failed: {e} — falling back to user CA store");
        return false;
    }

    if wait_for_device_ready(serial, DEFAULT_TIMEOUT)
        .await
        .is_err()
    {
        debug!(%serial, "Device did not become ready after remount");
        return false;
    }

    // Verify /system is actually writable — parsing remount output is fragile
    // across Android versions, so just probe with touch.
    let probe = format!("{SYSTEM_CA_CERT_DIR}/.tapsmith-probe");
    if shell(serial, &format!("touch {probe} && rm -f {probe}"))
        .await
        .is_err()
    {
        debug!(%serial, "System CA dir is not writable after remount — falling back to user CA store");
        return false;
    }

    if let Err(e) = shell(serial, &format!("cp {tmp_cert_path} {system_path}")).await {
        debug!(%serial, "Failed to copy CA to system store: {e} — falling back to user CA store");
        return false;
    }

    if let Err(e) = shell(serial, &format!("chmod 644 {system_path}")).await {
        debug!(%serial, "Failed to chmod system CA cert: {e}");
        let _ = shell(serial, &format!("rm -f {system_path}")).await;
        return false;
    }

    info!(%serial, cert_filename, "CA certificate installed in system store (trusted by all apps)");
    true
}

/// Read the device's API level (`ro.build.version.sdk`), if parseable.
async fn device_sdk_int(serial: &str) -> Option<u32> {
    shell_lenient(serial, "getprop ro.build.version.sdk")
        .await
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
}

/// Inject the CA into the Conscrypt APEX trust store on Android 14+ (API 34+).
///
/// On Android 14+ the runtime CA store is `/apex/com.android.conscrypt/cacerts`,
/// which is read-only and decoupled from `/system/etc/security/cacerts` (writing
/// the latter — even after `adb remount` — has no effect on what apps trust).
/// The working approach is to overlay a tmpfs containing the existing APEX certs
/// plus ours, *inside the mount namespace of each zygote*, so every app forked
/// afterwards inherits the trusted cert. Because Tapsmith installs the CA at
/// capture-start (before launching the app under test), the test app forks fresh
/// from the patched zygote and trusts the MITM cert. Requires root.
///
/// Returns `true` if at least one zygote namespace was patched. The tmpfs
/// overlays are volatile (cleared on reboot); a per-namespace idempotency check
/// avoids stacking mounts across repeated capture sessions.
async fn try_install_apex_ca(serial: &str, cert_filename: &str, tmp_cert_path: &str) -> bool {
    // Built as one device-side script: assemble the combined cert set once, then
    // nsenter into init + every zygote and tmpfs-overlay the APEX cacerts dir.
    // The SELinux relabel to `system_security_cacerts_file` is mandatory — apps
    // can't read certs left with the default tmpfs label.
    let script = format!(
        r#"SRC={APEX_CA_CERT_DIR}
TMP=/data/local/tmp/tapsmith-cacerts
rm -rf "$TMP" && mkdir -p "$TMP" || exit 1
NCERTS=$(ls "$SRC" 2>/dev/null | wc -l)
cp "$SRC"/* "$TMP"/ 2>/dev/null || exit 1
cp "{tmp_cert_path}" "$TMP"/{cert_filename} || exit 1
chmod 644 "$TMP"/* || exit 1
# Never mount a store smaller than the source: the staged set is the source
# certs plus ours, so its count is >= the source count (equal when ours is
# already present, e.g. an idempotent re-run over an existing overlay). A
# short count means the bulk copy failed; bail out (falling back to the user
# store) rather than mounting a depleted store that would strip trusted CAs
# from every app forked by the zygote.
[ "$(ls "$TMP" | wc -l)" -ge "$NCERTS" ] || exit 1
ok=0
for PID in 1 $(pidof zygote) $(pidof zygote64); do
  [ -z "$PID" ] && continue
  if nsenter -t "$PID" -m -- test -f "$SRC"/{cert_filename} 2>/dev/null; then ok=1; continue; fi
  if nsenter -t "$PID" -m -- sh -c "mount -t tmpfs tmpfs $SRC && (cp $TMP/* $SRC/ && chmod 644 $SRC/* && chown 0:0 $SRC/* && chcon u:object_r:system_security_cacerts_file:s0 $SRC/* || (umount -l $SRC && exit 1))" 2>/dev/null; then ok=1; fi
done
rm -rf "$TMP"
[ "$ok" = 1 ] && echo TAPSMITH_APEX_OK"#
    );

    match shell_lenient(serial, &script).await {
        Ok(out) if out.contains("TAPSMITH_APEX_OK") => {
            info!(
                %serial, cert_filename,
                "CA certificate injected into Conscrypt APEX trust store (Android 14+); \
                 trusted by apps launched after this point"
            );
            true
        }
        Ok(_) => {
            debug!(%serial, "APEX CA injection did not confirm success — falling back to user store");
            false
        }
        Err(e) => {
            debug!(%serial, "APEX CA injection failed: {e} — falling back to user store");
            false
        }
    }
}

/// Run an adb command (with serial targeting) that may fail, returning combined
/// stdout + stderr regardless of exit code. Used for commands like `adb root`
/// and `adb remount` where error messages may appear on either stream.
async fn run_adb_lenient(serial: &str, args: &[&str]) -> Result<Vec<u8>> {
    let mut cmd = Command::new("adb");
    cmd.arg("-s").arg(serial);
    cmd.args(args);

    debug!(serial = serial, args = ?args, "Running adb command (lenient)");

    let output = tokio::time::timeout(DEFAULT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| anyhow!("adb command timed out after {DEFAULT_TIMEOUT:?}"))?
        .context("Failed to execute adb")?;

    let mut combined = output.stdout;
    if !output.stderr.is_empty() {
        if !combined.is_empty() {
            combined.push(b'\n');
        }
        combined.extend_from_slice(&output.stderr);
    }
    Ok(combined)
}

/// Whether the keyguard (lock screen) is currently showing, from the output
/// of `dumpsys window policy`. `None` when the dump carries none of the
/// fields we know (older/newer Android, or a failed command) — callers then
/// fall back to the unconditional unlock sequence.
///
/// `KeyguardStateMonitor.mIsShowing` is the authoritative flag; the
/// `KeyguardServiceDelegate.showing` line and `mDreamingLockscreen` back it
/// up on releases that print only one of them.
pub fn parse_keyguard_showing(dump: &str) -> Option<bool> {
    let mut seen = false;
    for token in dump.split_whitespace() {
        for key in ["mIsShowing=", "showing=", "mDreamingLockscreen="] {
            if let Some(rest) = token.strip_prefix(key) {
                seen = true;
                if rest.starts_with("true") {
                    return Some(true);
                }
            }
        }
    }
    seen.then_some(false)
}

/// Parse an app's Linux uid out of `pm list packages -U <filter>` output.
///
/// Lines look like `package:dev.tapsmith.testapp uid:10151`. The filter is a
/// substring match, so a query for `com.example.app` also returns
/// `com.example.app.debug` — hence the exact-name comparison rather than
/// taking the first line. `None` when the package is absent or the platform
/// prints no uid field.
pub fn parse_package_uid(output: &str, package: &str) -> Option<u32> {
    for line in output.lines() {
        // adb shell line endings are CRLF; `trim` drops the stray \r that
        // would otherwise end up inside the parsed number.
        let Some(rest) = line.trim().strip_prefix("package:") else {
            continue;
        };
        let Some((name, uid)) = rest.split_once(" uid:") else {
            continue;
        };
        if name.trim() != package {
            continue;
        }
        if let Ok(uid) = uid.trim().parse::<u32>() {
            return Some(uid);
        }
    }
    None
}

/// The app's Linux uid, as the package manager reports it.
///
/// Deliberately asks the package manager rather than inspecting the app's
/// data directory: a directory's ownership is only as trustworthy as whatever
/// last wrote to it, and `RestoreAppState` extracts archives that carry the
/// ownership of the device they were captured on.
pub async fn package_uid(serial: &str, package: &str) -> Option<u32> {
    let output = shell_lenient(serial, &format!("pm list packages -U {package}"))
        .await
        .ok()?;
    parse_package_uid(&output, package)
}

/// Ask the device whether its lock screen is showing. See
/// [`parse_keyguard_showing`] for the `None` case.
pub async fn keyguard_showing(serial: &str) -> Option<bool> {
    let dump = shell_lenient(serial, "dumpsys window policy").await.ok()?;
    parse_keyguard_showing(&dump)
}

/// Execute a shell command on the device, returning stdout as a String.
/// Unlike `shell()`, this does not fail on non-zero exit codes —
/// it returns stdout regardless, which is needed for commands like
/// `dumpsys` that may write to stdout before exiting with an error.
#[instrument]
pub async fn shell_lenient(serial: &str, command: &str) -> Result<String> {
    shell_lenient_with_timeout(serial, command, DEFAULT_TIMEOUT).await
}

/// Execute a shell command on the device with a caller-provided timeout,
/// returning stdout even when the command exits non-zero.
#[instrument]
pub async fn shell_lenient_with_timeout(
    serial: &str,
    command: &str,
    timeout: Duration,
) -> Result<String> {
    let mut cmd = Command::new("adb");
    cmd.arg("-s").arg(serial).arg("shell").arg(command);

    debug!(
        serial = serial,
        command = command,
        "Running adb shell (lenient)"
    );

    let output = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| anyhow!("adb command timed out after {timeout:?}"))?
        .context("Failed to execute adb")?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Parsed WebView debug socket entry from /proc/net/unix.
#[derive(Debug, Clone)]
pub struct WebViewSocket {
    pub socket_name: String,
    pub pid: i32,
    pub package_name: String,
}

/// List WebView debug sockets by parsing /proc/net/unix on the device.
///
/// Android exposes devtools_remote sockets for debuggable WebViews at
/// `@webview_devtools_remote_<pid>` or `@chrome_devtools_remote`.
#[instrument]
pub async fn list_webview_sockets(serial: &str) -> Result<Vec<WebViewSocket>> {
    let discovery_timeout = Duration::from_secs(5);
    let pid_lookup_timeout = Duration::from_secs(2);
    let unix_output = shell_lenient_with_timeout(
        serial,
        "cat /proc/net/unix 2>/dev/null | grep devtools_remote",
        discovery_timeout,
    )
    .await?;

    let mut sockets = Vec::new();

    for line in unix_output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // /proc/net/unix format: Num RefCount Protocol Flags Type St Inode Path
        // The socket name is in the last field, prefixed with @
        let Some(path) = line.split_whitespace().last() else {
            continue;
        };
        let socket_name = path.trim_start_matches('@');
        if !socket_name.contains("devtools_remote") {
            continue;
        }

        // Extract PID from socket name: webview_devtools_remote_<pid>
        let pid: i32 = socket_name
            .rsplit('_')
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        sockets.push(WebViewSocket {
            socket_name: socket_name.to_string(),
            pid,
            package_name: String::new(),
        });
    }

    if sockets.is_empty() {
        return Ok(sockets);
    }

    // Resolve PIDs to package names via /proc/<pid>/cmdline (more reliable
    // than parsing `ps` output, which varies across Android versions).
    for socket in &mut sockets {
        if socket.pid > 0 {
            if let Ok(cmdline) = shell_lenient_with_timeout(
                serial,
                &format!("cat /proc/{}/cmdline", socket.pid),
                pid_lookup_timeout,
            )
            .await
            {
                let pkg = cmdline.trim_matches('\0').trim();
                if !pkg.is_empty() {
                    socket.package_name = pkg.to_string();
                }
            }
        }
    }

    debug!(count = sockets.len(), "Found WebView debug sockets");
    Ok(sockets)
}

/// Forward a local TCP port to a device-side abstract Unix socket with a
/// caller-provided timeout.
#[instrument]
pub async fn forward_abstract_socket_with_timeout(
    serial: &str,
    host_port: u16,
    socket_name: &str,
    timeout: Duration,
) -> Result<()> {
    let host_arg = format!("tcp:{host_port}");
    let device_arg = format!("localabstract:{socket_name}");
    run_adb(Some(serial), &["forward", &host_arg, &device_arg], timeout).await?;
    debug!(
        host_port,
        socket_name, "Abstract socket forwarding established"
    );
    Ok(())
}

// ─── iptables transparent redirect (PILOT-187) ───

const IPTABLES_CHAIN: &str = "TAPSMITH_REDIRECT";

/// Whether the device can route IPv6 traffic off-device, i.e. whether it has an
/// IPv6 default route.
///
/// [`setup_iptables_redirect`] only installs **IPv4** rules (`iptables`, not
/// `ip6tables`), so when a device has working IPv6 egress an app that prefers
/// IPv6 connects straight out and never reaches the proxy. That traffic is
/// invisible rather than merely undecrypted: no capture entry, and not even the
/// `CONNECT ... passthrough` marker a tunnelled connection leaves, so it looks
/// to a user exactly like the app made no request at all.
///
/// An IPv6 `nat` table cannot be assumed — Android emulator kernels routinely
/// ship without `ip6table_nat` (`ip6tables -t nat` fails outright there), so a
/// matching `ip6tables ... REDIRECT` rule is not a portable fix. Detecting the
/// exposure and telling the user is, which is what the caller does with this.
///
/// Best-effort: any failure to query reports `false` (assume no IPv6 egress)
/// rather than emitting a warning we cannot substantiate.
pub async fn has_ipv6_default_route(serial: &str) -> bool {
    shell_lenient(serial, "ip -6 route show default")
        .await
        .map(|out| parse_has_default_route(&out))
        .unwrap_or(false)
}

/// Pure half of [`has_ipv6_default_route`]: does `ip -6 route show default`
/// output actually name a default route?
///
/// Matching on the `default` prefix rather than mere non-emptiness matters —
/// `ip` writes errors ("Error: ipv6: Address family not supported") to stdout on
/// some Android builds, and treating that as a route would warn every user on a
/// device that has no IPv6 at all.
fn parse_has_default_route(output: &str) -> bool {
    output
        .lines()
        .any(|line| line.trim_start().starts_with("default"))
}

/// Set up iptables rules to transparently redirect HTTP (80) and HTTPS (443)
/// traffic, plus configured cleartext HTTP ports, through the proxy port.
/// Returns `true` on success.
///
/// Uses a dedicated chain (`TAPSMITH_REDIRECT`) for easy identification and
/// cleanup. Traffic destined for `127.0.0.1` is excluded to prevent redirect
/// loops (the proxy is reached via `adb reverse` on loopback).
pub async fn setup_iptables_redirect(serial: &str, proxy_port: u16, http_ports: &[u16]) -> bool {
    // Clean up any stale chain from a prior crash
    cleanup_iptables_redirect(serial).await;

    let commands = iptables_redirect_commands(proxy_port, http_ports);

    if !apply_iptables_commands(serial, &commands).await {
        return false;
    }

    // Verify the chain is actually in the OUTPUT path. On slow CI emulators
    // the iptables commands above can report success but the rules may not
    // be active yet (kernel module loading race). A quick list-check catches
    // this so the caller can fall back to the HTTP proxy setting.
    if !verify_iptables_chain(serial).await {
        warn!(%serial, "iptables verification failed — chain not in OUTPUT, retrying setup");
        cleanup_iptables_redirect(serial).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        if !apply_iptables_commands(serial, &commands).await {
            return false;
        }
        // Re-verify after retry
        if !verify_iptables_chain(serial).await {
            warn!(%serial, "iptables verification failed after retry — giving up");
            cleanup_iptables_redirect(serial).await;
            return false;
        }
    }

    // Brief settle delay — give the kernel time to fully activate the rules
    // for new TCP connections before the caller starts routing traffic.
    tokio::time::sleep(Duration::from_millis(100)).await;

    info!(%serial, proxy_port, "iptables transparent redirect configured");
    true
}

fn iptables_redirect_commands(proxy_port: u16, http_ports: &[u16]) -> Vec<String> {
    let mut ports = vec![80, 443];
    ports.extend_from_slice(http_ports);
    ports.sort_unstable();
    ports.dedup();
    let mut commands = vec![
        format!("iptables -t nat -N {IPTABLES_CHAIN}"),
        format!("iptables -t nat -A {IPTABLES_CHAIN} -d 127.0.0.0/8 -j RETURN"),
    ];
    for port in ports {
        commands.push(format!("iptables -t nat -A {IPTABLES_CHAIN} -p tcp --dport {port} -j REDIRECT --to-port {proxy_port}"));
    }
    commands.push(format!("iptables -t nat -I OUTPUT -j {IPTABLES_CHAIN}"));
    commands
}

async fn apply_iptables_commands(serial: &str, commands: &[String]) -> bool {
    for cmd in commands {
        if let Err(e) = shell(serial, cmd).await {
            warn!(%serial, cmd, "iptables command failed: {e}");
            cleanup_iptables_redirect(serial).await;
            return false;
        }
    }
    true
}

/// Verify the iptables chain is active in the OUTPUT path. Retries up to 3
/// times with 200ms sleeps to handle kernel module loading races on slow
/// CI emulators.
async fn verify_iptables_chain(serial: &str) -> bool {
    for attempt in 1..=3 {
        match shell(
            serial,
            &format!("iptables -t nat -L OUTPUT -n | grep {IPTABLES_CHAIN}"),
        )
        .await
        {
            Ok(output) if output.contains(IPTABLES_CHAIN) => {
                debug!(%serial, attempt, "iptables chain verified in OUTPUT");
                return true;
            }
            _ => {
                if attempt < 3 {
                    debug!(%serial, attempt, "iptables chain not yet visible, retrying");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    }
    false
}

/// Remove the `TAPSMITH_REDIRECT` iptables chain and its reference from OUTPUT.
/// Safe to call even if the chain doesn't exist.
pub async fn cleanup_iptables_redirect(serial: &str) {
    // Remove the jump rule from OUTPUT (may fail if not present — that's fine)
    let _ = shell_with_timeout(
        serial,
        &format!("iptables -t nat -D OUTPUT -j {IPTABLES_CHAIN}"),
        CLEANUP_TIMEOUT,
    )
    .await;
    // Flush and delete the chain
    let _ = shell_with_timeout(
        serial,
        &format!("iptables -t nat -F {IPTABLES_CHAIN}"),
        CLEANUP_TIMEOUT,
    )
    .await;
    let _ = shell_with_timeout(
        serial,
        &format!("iptables -t nat -X {IPTABLES_CHAIN}"),
        CLEANUP_TIMEOUT,
    )
    .await;
}

#[cfg(test)]
mod tests {
    #[test]
    fn package_uid_takes_the_exact_package_not_a_prefix_match() {
        // `pm list packages -U` filters by substring, so a query for the base
        // package also returns its variants. Taking the first line would hand
        // back the wrong app's uid.
        let out = "package:com.example.app.debug uid:10201\r\n\
                   package:com.example.app uid:10150\r\n\
                   package:com.example.app.test uid:10202\r\n";
        assert_eq!(
            super::parse_package_uid(out, "com.example.app"),
            Some(10150)
        );
        assert_eq!(
            super::parse_package_uid(out, "com.example.app.debug"),
            Some(10201)
        );
    }

    #[test]
    fn package_uid_is_none_when_absent_or_unparseable() {
        assert_eq!(super::parse_package_uid("", "com.example.app"), None);
        // A package that is simply not installed.
        assert_eq!(
            super::parse_package_uid("package:com.other.app uid:10150\n", "com.example.app"),
            None
        );
        // Platform that prints no uid field (e.g. `pm list packages` without -U).
        assert_eq!(
            super::parse_package_uid("package:com.example.app\n", "com.example.app"),
            None
        );
        // Garbage where the number should be.
        assert_eq!(
            super::parse_package_uid("package:com.example.app uid:nope\n", "com.example.app"),
            None
        );
    }

    #[test]
    fn package_uid_tolerates_crlf_and_surrounding_noise() {
        // Real adb output: CRLF endings, and shells that echo a warning first.
        let out = "WARNING: linker: something\r\npackage:com.example.app uid:10150\r\n";
        assert_eq!(
            super::parse_package_uid(out, "com.example.app"),
            Some(10150)
        );
    }

    #[test]
    fn capture_ports_keep_defaults_and_loopback_exclusion() {
        let commands = super::iptables_redirect_commands(45678, &[8080, 9099, 8080, 80]);
        assert!(commands[1].contains("127.0.0.0/8 -j RETURN"));
        for port in [80, 443, 8080, 9099] {
            assert_eq!(
                commands
                    .iter()
                    .filter(|c| c.contains(&format!("--dport {port} ")))
                    .count(),
                1
            );
        }
        assert!(commands.last().unwrap().contains("-I OUTPUT"));
        assert_eq!(commands.len(), 7);
    }

    use super::*;

    // ─── Keyguard state ───

    #[test]
    fn keyguard_not_showing_on_an_unlocked_device() {
        let dump = "    mKeyguardOccluded=false mKeyguardOccludedChanged=false\n    KeyguardServiceDelegate\n      showing=false\n      occluded=false\n      KeyguardStateMonitor\n        mIsShowing=false\n";
        assert_eq!(parse_keyguard_showing(dump), Some(false));
    }

    #[test]
    fn keyguard_showing_when_any_flag_is_true() {
        assert_eq!(
            parse_keyguard_showing("KeyguardServiceDelegate\n  showing=true\n"),
            Some(true)
        );
        assert_eq!(
            parse_keyguard_showing(
                "  showing=false\n  KeyguardStateMonitor\n    mIsShowing=true\n"
            ),
            Some(true)
        );
        assert_eq!(
            parse_keyguard_showing("    mShowingDream=false mDreamingLockscreen=true\n"),
            Some(true),
            "flags sharing a line with others are still read"
        );
    }

    #[test]
    fn keyguard_state_unknown_without_the_fields() {
        assert_eq!(parse_keyguard_showing(""), None);
        assert_eq!(
            parse_keyguard_showing("WINDOW MANAGER POLICY STATE\n  mAwake=true\n"),
            None
        );
    }

    // ─── IPv6 default-route detection ───

    #[test]
    fn ipv6_default_route_detected_from_route_output() {
        // Real `ip -6 route show default` output from a device with IPv6.
        assert!(parse_has_default_route(
            "default via fe80::1 dev wlan0 proto ra metric 1024 expires 1799sec"
        ));
        // Leading whitespace must not hide the route.
        assert!(parse_has_default_route("  default dev wlan0 metric 1024"));
    }

    #[test]
    fn ipv6_default_route_absent_for_empty_or_error_output() {
        // Emulators typically have IPv6 addresses but no default route.
        assert!(!parse_has_default_route(""));
        assert!(!parse_has_default_route("\n  \n"));
        // `ip` reports some failures on stdout; those must not read as a route,
        // or every IPv6-less device would get the bypass warning.
        assert!(!parse_has_default_route(
            "Error: ipv6: Address family not supported by protocol."
        ));
        // A non-default route is not egress.
        assert!(!parse_has_default_route(
            "fec0::/64 dev eth0 proto kernel metric 256"
        ));
    }

    // ─── Retryable ADB transport errors ───

    #[test]
    fn retryable_adb_transport_error_matches_offline_device() {
        assert!(is_retryable_adb_transport_error(
            "adb command failed (exit exit status: 1): adb: device offline"
        ));
    }

    #[test]
    fn retryable_adb_transport_error_matches_missing_device() {
        assert!(is_retryable_adb_transport_error(
            "adb command failed (exit exit status: 1): error: no devices/emulators found"
        ));
        assert!(is_retryable_adb_transport_error(
            "adb command failed (exit exit status: 1): error: device 'emulator-5554' not found"
        ));
    }

    #[test]
    fn retryable_adb_transport_error_rejects_install_semantic_failure() {
        assert!(!is_retryable_adb_transport_error(
            "adb command failed (exit exit status: 1): Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"
        ));
    }

    #[test]
    fn retryable_adb_transport_error_rejects_unauthorized_device() {
        assert!(!is_retryable_adb_transport_error(
            "adb command failed (exit exit status: 1): error: device unauthorized"
        ));
    }

    // ─── parse_incompatible_package ───

    #[test]
    fn parse_incompatible_package_modern_adb_inline_format() {
        // Modern (streamed-install) adb embeds the failure mid-line in stderr.
        let msg = "adb command failed (exit exit status: 1): \
            adb: failed to install /tmp/agent.apk: \
            Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package \
            dev.tapsmith.agent signatures do not match newer version; ignoring!]";
        assert_eq!(parse_incompatible_package(msg), Some("dev.tapsmith.agent"));
    }

    #[test]
    fn parse_incompatible_package_legacy_line_start_format() {
        let msg = "adb command failed (exit exit status: 1): \nPerforming Push Install\n\
            Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: \
            Package dev.tapsmith.agent.test signatures do not match previously installed version]";
        assert_eq!(
            parse_incompatible_package(msg),
            Some("dev.tapsmith.agent.test")
        );
    }

    #[test]
    fn parse_incompatible_package_trims_trailing_bracket() {
        let msg = "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.example]";
        assert_eq!(parse_incompatible_package(msg), Some("com.example"));
    }

    #[test]
    fn parse_incompatible_package_ignores_other_failures() {
        assert_eq!(
            parse_incompatible_package(
                "Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Existing package com.example]"
            ),
            None
        );
        assert_eq!(parse_incompatible_package("adb: device offline"), None);
    }

    #[test]
    fn parse_incompatible_package_ignores_text_before_failure_marker() {
        // A crafted APK path mentioning "Existing package evil.pkg" before the
        // failure marker must not be parsed — only the bracketed detail counts.
        let msg = "adb: failed to install '/tmp/Existing package evil.pkg.apk': \
            Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package real.pkg signatures]";
        assert_eq!(parse_incompatible_package(msg), Some("real.pkg"));
        // And with no failure marker at all, nothing is parsed.
        let msg = "adb: failed to install '/tmp/Existing package evil.pkg.apk': device offline";
        assert_eq!(parse_incompatible_package(msg), None);
    }

    #[test]
    fn parse_incompatible_package_does_not_parse_across_lines() {
        // A failure line missing its closing bracket must not let parsing
        // continue into later lines, which can contain the APK path.
        let msg = "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match\n\
            adb: failed to install '/tmp/Existing package evil.pkg.apk']";
        assert_eq!(parse_incompatible_package(msg), None);
    }

    #[test]
    fn parse_incompatible_package_rejects_non_package_tokens() {
        // Package names must start with a letter.
        let msg =
            "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package 123.abc signatures]";
        assert_eq!(parse_incompatible_package(msg), None);
        // Single-segment tokens (no dot) are not installable package names —
        // this guards the wording "Package signatures do not match..." where
        // the package name is omitted and "signatures" follows the keyword.
        let msg = "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: \
            Package signatures do not match the previously installed version; ignoring!]";
        assert_eq!(parse_incompatible_package(msg), None);
    }

    // ─── AdbDevice::is_online ───

    #[test]
    fn is_online_device_state() {
        let dev = AdbDevice {
            serial: "ABC123".into(),
            state: "device".into(),
        };
        assert!(dev.is_online());
    }

    #[test]
    fn is_online_offline_state() {
        let dev = AdbDevice {
            serial: "ABC123".into(),
            state: "offline".into(),
        };
        assert!(!dev.is_online());
    }

    #[test]
    fn is_online_unauthorized_state() {
        let dev = AdbDevice {
            serial: "ABC123".into(),
            state: "unauthorized".into(),
        };
        assert!(!dev.is_online());
    }

    #[test]
    fn is_online_unknown_state() {
        let dev = AdbDevice {
            serial: "ABC123".into(),
            state: "unknown".into(),
        };
        assert!(!dev.is_online());
    }

    #[test]
    fn is_online_empty_state() {
        let dev = AdbDevice {
            serial: "ABC123".into(),
            state: "".into(),
        };
        assert!(!dev.is_online());
    }

    // ─── root_unavailable_hint ───

    #[test]
    fn root_hint_play_store_emulator_names_the_image() {
        let hint = root_unavailable_hint(true, "sdk_gphone64_arm64_playstore");
        assert!(hint.contains("google_apis_playstore"));
        assert!(hint.contains("tapsmith create-avd"));
    }

    #[test]
    fn root_hint_other_production_emulator_still_recommends_recreate() {
        let hint = root_unavailable_hint(true, "sdk_gphone64_arm64");
        assert!(hint.contains("a production system image"));
        assert!(hint.contains("tapsmith create-avd"));
    }

    #[test]
    fn root_hint_physical_device_recommends_manual_install() {
        let hint = root_unavailable_hint(false, "husky");
        assert!(hint.contains("~/.tapsmith/ca.pem"));
        assert!(hint.contains("network_security_config.xml"));
        assert!(!hint.contains("create-avd"));
    }

    // ─── AdbDevice::is_emulator ───

    #[test]
    fn is_emulator_emulator_serial() {
        let dev = AdbDevice {
            serial: "emulator-5554".into(),
            state: "device".into(),
        };
        assert!(dev.is_emulator());
    }

    #[test]
    fn is_emulator_emulator_other_port() {
        let dev = AdbDevice {
            serial: "emulator-5556".into(),
            state: "device".into(),
        };
        assert!(dev.is_emulator());
    }

    #[test]
    fn is_emulator_localhost() {
        let dev = AdbDevice {
            serial: "localhost:5555".into(),
            state: "device".into(),
        };
        assert!(dev.is_emulator());
    }

    #[test]
    fn is_emulator_ip_address_is_not_emulator() {
        let dev = AdbDevice {
            serial: "192.168.1.1:5555".into(),
            state: "device".into(),
        };
        assert!(!dev.is_emulator());
    }

    #[test]
    fn is_emulator_physical_device() {
        let dev = AdbDevice {
            serial: "HVA123456".into(),
            state: "device".into(),
        };
        assert!(!dev.is_emulator());
    }

    #[test]
    fn is_emulator_another_physical_serial() {
        let dev = AdbDevice {
            serial: "R5CR1234XYZ".into(),
            state: "device".into(),
        };
        assert!(!dev.is_emulator());
    }
}
