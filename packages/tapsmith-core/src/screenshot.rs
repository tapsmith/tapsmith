use anyhow::Result;
use tracing::debug;

use crate::adb;
use crate::ios;
use crate::macos;
use crate::platform::Platform;

/// Capture a screenshot from the given device, returning PNG bytes.
/// Routes to ADB (Android), simctl (iOS) or screencapture (macOS).
pub async fn capture(serial: &str, platform: Platform) -> Result<Vec<u8>> {
    match platform {
        Platform::Android => {
            debug!(serial, "Capturing screenshot via ADB");
            adb::screencap(serial).await
        }
        Platform::Ios => {
            debug!(serial, "Capturing screenshot via simctl");
            ios::screenshot::capture(serial).await
        }
        Platform::MacOs => {
            debug!("Capturing screenshot via screencapture");
            macos::screenshot::capture().await
        }
    }
}

/// Attempt to capture a screenshot for inclusion in an error response.
/// Returns empty bytes if the capture fails (best-effort).
pub async fn capture_for_error(serial: Option<&str>, platform: Platform) -> Vec<u8> {
    let Some(serial) = serial else {
        return Vec::new();
    };

    match capture(serial, platform).await {
        Ok(png) => png,
        Err(e) => {
            debug!("Failed to capture error screenshot: {e}");
            Vec::new()
        }
    }
}
