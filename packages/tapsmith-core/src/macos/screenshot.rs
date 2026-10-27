use anyhow::{bail, Context, Result};
use tokio::process::Command;
use tracing::instrument;

/// Capture a PNG of the whole screen with `screencapture` (`-x`: no sound).
#[instrument]
pub async fn capture() -> Result<Vec<u8>> {
    let tmp_path = std::env::temp_dir().join(format!(
        "tapsmith_macos_screenshot_{}.png",
        uuid::Uuid::new_v4()
    ));

    let output = Command::new("screencapture")
        .arg("-x")
        .args(["-t", "png"])
        .arg(&tmp_path)
        .output()
        .await
        .context("Failed to run screencapture")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to capture the macOS screen: {stderr}");
    }

    let data = tokio::fs::read(&tmp_path)
        .await
        .context("Failed to read screenshot file")?;
    let _ = tokio::fs::remove_file(&tmp_path).await;

    if data.len() < 8 || &data[..4] != b"\x89PNG" {
        bail!(
            "Screenshot data is not a valid PNG (got {} bytes)",
            data.len()
        );
    }

    Ok(data)
}
