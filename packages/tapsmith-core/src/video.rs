//! Continuous screen-recording dispatcher (PILOT-114).
//!
//! Mirrors `crate::screenshot`'s platform-dispatch shape: a `start` that
//! returns an owned `RecordingHandle`, and a `stop` that consumes the handle
//! and returns the path to the finalised MP4 on the host filesystem.
//!
//! Platform routing:
//! - Android → `adb shell screenrecord` (3-min hard cap per segment; see
//!   the warning in `stop`).
//! - iOS simulator → `xcrun simctl io recordVideo --codec h264`.
//! - iOS physical → `ffmpeg -f avfoundation`. Requires ffmpeg on PATH.

use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::process::Child;
use tracing::{info, warn};

use crate::adb;
use crate::ios;
use crate::platform::Platform;

/// `screenrecord`'s hard cap. Recordings beyond this are truncated by the
/// device-side encoder; we surface a warning when the recorded duration
/// approaches it.
const SCREENRECORD_MAX_DURATION: Duration = Duration::from_secs(180);

/// How long to wait for a child to exit cleanly after we send the stop
/// signal. Long enough for ffmpeg/simctl to finalise the MP4 (write the
/// MOOV atom); short enough to avoid hanging a test teardown.
const STOP_GRACEFUL_WAIT: Duration = Duration::from_secs(5);

/// Owned handle to a running recording.
pub struct RecordingHandle {
    pub backend: Backend,
    /// Local filesystem path the MP4 is being written to (or, for Android,
    /// where it will land after we `adb pull` it from the device).
    pub local_path: PathBuf,
    pub started_at: Instant,
}

pub enum Backend {
    /// Android: `adb shell screenrecord <device_path>`. We need to `adb pull`
    /// the file to the host on stop.
    Android {
        child: Child,
        serial: String,
        device_path: String,
    },
    /// iOS Simulator: `xcrun simctl io recordVideo` writes the MP4 to the
    /// host directly. Stop with SIGINT.
    IosSim { child: Child },
    /// iOS Physical: `ffmpeg -f avfoundation` writes to the host. Stop by
    /// writing `q\n` to ffmpeg's stdin.
    IosPhysical { child: Child },
}

/// Start a recording for the given device.
///
/// `size` is honoured on Android only (passed through as `screenrecord
/// --size WxH`); iOS ignores it and records at native resolution. A one-time
/// warning is logged on iOS when `size` is set.
pub async fn start(
    serial: &str,
    platform: Platform,
    size: Option<(u32, u32)>,
) -> Result<RecordingHandle> {
    match platform {
        Platform::Android => start_android(serial, size).await,
        Platform::Ios => start_ios(serial, size).await,
        Platform::MacOs => bail!("Video recording is not supported on macOS yet"),
    }
}

async fn start_android(serial: &str, size: Option<(u32, u32)>) -> Result<RecordingHandle> {
    // We use a fresh on-device path under /sdcard so re-entry doesn't
    // collide. The host-side path is supplied by the caller via `local_path`
    // on the returned handle, but we don't have a local_path yet — we'll
    // assign one in `stop` when we pull the file. To keep the handle's
    // `local_path` meaningful for callers who want it ahead of time, we
    // generate the host path here and fill it in.
    let id = uuid::Uuid::new_v4();
    let device_path = format!("/sdcard/tapsmith-recording-{id}.mp4");
    let local_path = std::env::temp_dir().join(format!("tapsmith-recording-{id}.mp4"));

    let child = adb::screenrecord_spawn(serial, &device_path, size).await?;
    info!(serial, %device_path, "Started Android screenrecord");
    Ok(RecordingHandle {
        backend: Backend::Android {
            child,
            serial: serial.to_string(),
            device_path,
        },
        local_path,
        started_at: Instant::now(),
    })
}

async fn start_ios(udid: &str, size: Option<(u32, u32)>) -> Result<RecordingHandle> {
    if size.is_some() {
        warn_size_ignored_on_ios_once();
    }

    // Decide simulator vs physical by listing devices once.
    let device = lookup_ios_device(udid).await?;
    let id = uuid::Uuid::new_v4();
    let local_path = std::env::temp_dir().join(format!("tapsmith-recording-{id}.mp4"));

    if device.is_simulator {
        let child = ios::recording::recordvideo_sim_spawn(udid, &local_path).await?;
        // Wait for the recorder to create the output file, which signals
        // the encoder is initialised and capturing frames.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !local_path.exists() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !local_path.exists() {
            warn!(path = %local_path.display(), "Recorder did not create output file within 5s");
        }
        info!(udid, path = %local_path.display(), "Started iOS sim recordVideo");
        Ok(RecordingHandle {
            backend: Backend::IosSim { child },
            local_path,
            started_at: Instant::now(),
        })
    } else {
        let child = ios::recording::recordvideo_physical_spawn(&device.name, &local_path).await?;
        info!(
            udid,
            device_name = %device.name,
            path = %local_path.display(),
            "Started iOS physical ffmpeg recording"
        );
        Ok(RecordingHandle {
            backend: Backend::IosPhysical { child },
            local_path,
            started_at: Instant::now(),
        })
    }
}

/// Stop a recording, finalise the MP4, and return its host-local path.
///
/// The caller owns the file at `local_path` and is responsible for
/// moving/copying it to the final destination and cleaning up.
pub async fn stop(handle: RecordingHandle) -> Result<(PathBuf, Duration)> {
    let elapsed = handle.started_at.elapsed();
    if elapsed >= SCREENRECORD_MAX_DURATION && matches!(handle.backend, Backend::Android { .. }) {
        warn!(
            elapsed_secs = elapsed.as_secs(),
            "Recording exceeded `adb shell screenrecord` 3-min cap; the \
             resulting video has been truncated by the device-side encoder. \
             Chained-segment recording is not yet supported (PILOT-114 v1)."
        );
    }

    let local_path = handle.local_path.clone();

    match handle.backend {
        Backend::Android {
            mut child,
            serial,
            device_path,
        } => {
            // Send SIGINT to the remote screenrecord process on the device.
            // Signaling the local adb process does NOT forward the interrupt
            // to the device-side process, leaving the MP4 without a MOOV atom.
            let _ = adb::shell(&serial, "kill -INT $(pidof screenrecord)").await;
            match tokio::time::timeout(STOP_GRACEFUL_WAIT, child.wait()).await {
                Ok(_) => {}
                Err(_) => {
                    warn!("screenrecord did not exit after remote SIGINT; escalating to kill");
                    let _ = child.kill().await;
                }
            }
            // Pull the file off the device. screenrecord writes to /sdcard,
            // so a vanilla `adb pull` works regardless of root.
            let local_str = local_path
                .to_str()
                .context("recording path must be valid UTF-8")?;
            let pull_res = adb::pull_file(&serial, &device_path, local_str).await;
            // Clean up the on-device file regardless of pull success.
            let _ = adb::shell(&serial, &format!("rm -f '{device_path}'")).await;
            pull_res
                .with_context(|| format!("Failed to pull screenrecord MP4 from {device_path}"))?;
        }
        Backend::IosSim { child } => {
            ios::recording::stop_simctl_recording(child, STOP_GRACEFUL_WAIT).await?;
        }
        Backend::IosPhysical { child } => {
            ios::recording::stop_ffmpeg_recording(child, STOP_GRACEFUL_WAIT).await?;
        }
    }

    if !local_path.exists() {
        bail!(
            "Recording file {} is missing after stop — the recorder \
             may have been killed before writing any frames",
            local_path.display()
        );
    }

    Ok((local_path, elapsed))
}

/// Stop a recording, discard its output, and remove its artifacts.
///
/// Used to reap an orphaned recording whose owning run died before it could
/// call `StopVideoRecording` — e.g. a stopped run whose worker was SIGKILLed
/// (PILOT-235). The recorders are stopped gracefully even though the output
/// is discarded: SIGKILLing `simctl io recordVideo` leaves CoreSimulator's
/// host-side capture session stuck ("Host recording is already in
/// progress"), which silently breaks every subsequent recording until the
/// simulator reboots.
pub async fn discard(handle: RecordingHandle) {
    let local_path = handle.local_path.clone();
    match handle.backend {
        Backend::Android {
            mut child,
            serial,
            device_path,
        } => {
            // Stop the device-side encoder first — killing the local adb
            // process alone leaves it recording on the device.
            let _ = adb::shell(&serial, "kill -INT $(pidof screenrecord)").await;
            let _ = child.kill().await;
            let _ = adb::shell(&serial, &format!("rm -f '{device_path}'")).await;
        }
        Backend::IosSim { child } => {
            if let Err(e) = ios::recording::stop_simctl_recording(child, STOP_GRACEFUL_WAIT).await {
                warn!(error = %e, "Failed to stop orphaned simctl recording");
            }
        }
        Backend::IosPhysical { child } => {
            if let Err(e) = ios::recording::stop_ffmpeg_recording(child, STOP_GRACEFUL_WAIT).await {
                warn!(error = %e, "Failed to stop orphaned ffmpeg recording");
            }
        }
    }
    if let Err(e) = tokio::fs::remove_file(&local_path).await {
        if e.kind() != std::io::ErrorKind::NotFound {
            warn!(path = %local_path.display(), error = %e, "Failed to remove discarded recording file");
        }
    }
    info!(path = %local_path.display(), "Discarded orphaned video recording");
}

/// Look up an iOS device record by UDID, caching the device list so repeated
/// recordings within the same daemon session don't re-query simctl/devicectl.
/// If the UDID isn't in the cached list, refreshes once in case a device was
/// connected after the first query.
async fn lookup_ios_device(udid: &str) -> Result<ios::device::IosDevice> {
    use tokio::sync::Mutex;
    static CACHED_LIST: Mutex<Option<Vec<ios::device::IosDevice>>> = Mutex::const_new(None);

    let mut cache = CACHED_LIST.lock().await;
    if let Some(ref list) = *cache {
        if let Some(d) = list.iter().find(|d| d.udid == udid) {
            return Ok(d.clone());
        }
    }
    let fresh = ios::device::list_all_devices()
        .await
        .context("Failed to list iOS devices for recording")?;
    let result = fresh.iter().find(|d| d.udid == udid).cloned();
    *cache = Some(fresh);
    result.ok_or_else(|| {
        anyhow::anyhow!("iOS device with UDID '{udid}' not found in simctl/devicectl listing")
    })
}

// ─── Once-per-process warnings ───

use std::sync::atomic::{AtomicBool, Ordering};
static SIZE_IGNORED_LOGGED: AtomicBool = AtomicBool::new(false);

fn warn_size_ignored_on_ios_once() {
    if SIZE_IGNORED_LOGGED
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
    {
        warn!(
            "video.size is honoured on Android only — iOS records at native \
             resolution. Resizing iOS recordings post-process is on the roadmap."
        );
    }
}
