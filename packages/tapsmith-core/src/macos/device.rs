use anyhow::{bail, Context, Result};
use tokio::process::Command;

use crate::device::{ConnectionState, DeviceInfo};
use crate::platform::Platform;

/// Serial of the one macOS device: the host itself.
pub const HOST_SERIAL: &str = "macos-host";

/// "This Mac" as a device: model from `sysctl -n hw.model`, version from
/// `sw_vers -productVersion`.
pub async fn host_device() -> Result<DeviceInfo> {
    if !cfg!(target_os = "macos") {
        bail!("macOS testing needs the daemon to run on a Mac");
    }
    let model = command_stdout("sysctl", &["-n", "hw.model"]).await?;
    let os_version = command_stdout("sw_vers", &["-productVersion"]).await?;
    Ok(host_device_from(&model, &os_version))
}

fn host_device_from(model: &str, os_version: &str) -> DeviceInfo {
    DeviceInfo {
        serial: HOST_SERIAL.to_string(),
        model: model.trim().to_string(),
        is_emulator: false,
        state: ConnectionState::Discovered,
        platform: Platform::MacOs,
        os_version: os_version.trim().to_string(),
    }
}

async fn command_stdout(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .await
        .with_context(|| format!("Failed to run {program}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("{program} {} failed: {stderr}", args.join(" "));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_device_is_the_mac_itself() {
        let device = host_device_from("Mac15,9\n", "15.1\n");
        assert_eq!(device.serial, "macos-host");
        assert_eq!(device.model, "Mac15,9");
        assert_eq!(device.os_version, "15.1");
        assert_eq!(device.platform, Platform::MacOs);
        assert!(!device.is_emulator);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn host_device_reads_this_mac() {
        let device = host_device().await.expect("host device");
        assert!(!device.model.is_empty());
        assert!(device
            .os_version
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit()));
    }
}
