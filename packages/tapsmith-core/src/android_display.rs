//! Which physical display an Android screenshot should capture.
//!
//! A device with more than one display — a foldable's inner and cover
//! screens — makes `screencap` guess. From Android 14 it also prints a
//! warning on stdout ahead of the PNG, which broke every screenshot on those
//! devices. The display apps run on is logical display 0, and which physical
//! display backs it changes with the fold posture, so a multi-display device
//! has it looked up for every capture and passed to `screencap -d`.
//!
//! This module holds the parsing; `adb::screencap` runs the commands.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// The 8-byte PNG file signature.
pub const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Physical display ids per serial, from `dumpsys SurfaceFlinger
/// --display-id`. Probed once per serial: the set of physical displays does
/// not change with posture, only which one is on.
static PHYSICAL_DISPLAYS: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The cached physical display ids for `serial`, if probed.
pub fn cached_physical_displays(serial: &str) -> Option<Vec<String>> {
    PHYSICAL_DISPLAYS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(serial)
        .cloned()
}

/// Remember `serial`'s physical display ids.
pub fn cache_physical_displays(serial: &str, ids: Vec<String>) {
    PHYSICAL_DISPLAYS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(serial.to_string(), ids);
}

/// The physical display ids `dumpsys SurfaceFlinger --display-id` lists, in
/// order. Each line reads `Display <id> (HWC display <n>): …`; anything else
/// (an older build that ignores the flag and dumps everything) is skipped.
pub fn parse_surfaceflinger_display_ids(output: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for line in output.lines() {
        let Some(rest) = line.trim_start().strip_prefix("Display ") else {
            continue;
        };
        let Some((id, after)) = rest.split_once(' ') else {
            continue;
        };
        if !after.starts_with("(HWC display") || id.is_empty() {
            continue;
        }
        if id.bytes().all(|b| b.is_ascii_digit()) && !ids.iter().any(|i| i == id) {
            ids.push(id.to_string());
        }
    }
    ids
}

/// The physical display id behind logical display 0 — the display apps run
/// on — from `dumpsys display`, or `None` when the output does not say.
///
/// Reads the input viewport (`displayId=0, uniqueId='local:<id>'`) and falls
/// back to the logical display's `DisplayInfo{… displayId 0, … uniqueId
/// "local:<id>" …}`.
pub fn parse_default_display_physical_id(dumpsys_display: &str) -> Option<String> {
    for line in dumpsys_display.lines() {
        let mut rest = line;
        while let Some(pos) = rest.find("displayId=0, uniqueId='local:") {
            let tail = &rest[pos + "displayId=0, uniqueId='local:".len()..];
            // `displayId=0` must not be the tail of `displayId=10`.
            let preceded_ok = rest[..pos]
                .chars()
                .last()
                .is_none_or(|c| !c.is_ascii_digit());
            if preceded_ok {
                if let Some(id) = leading_digits(tail) {
                    return Some(id);
                }
            }
            rest = tail;
        }
    }
    for line in dumpsys_display.lines() {
        if !line.contains("DisplayInfo{") || !line.contains(", displayId 0,") {
            continue;
        }
        if let Some(pos) = line.find("uniqueId \"local:") {
            if let Some(id) = leading_digits(&line[pos + "uniqueId \"local:".len()..]) {
                return Some(id);
            }
        }
    }
    None
}

fn leading_digits(s: &str) -> Option<String> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    (!digits.is_empty()).then_some(digits)
}

/// Which display to pass to `screencap -d`: logical display 0's physical id,
/// when the device has more than one display and that id is one
/// SurfaceFlinger lists. `None` means a plain `screencap`.
pub fn capture_display_id(physical_ids: &[String], dumpsys_display: &str) -> Option<String> {
    if physical_ids.len() < 2 {
        return None;
    }
    parse_default_display_physical_id(dumpsys_display).filter(|id| physical_ids.contains(id))
}

/// `screencap -p` output split into the text the device printed before the
/// PNG (empty normally; the multi-display warning on a foldable) and the PNG
/// itself. `Err` carries the device's text when there is no PNG at all.
pub fn split_screencap_output(output: &[u8]) -> Result<(String, &[u8]), String> {
    let Some(start) = output
        .windows(PNG_SIGNATURE.len())
        .position(|w| w == PNG_SIGNATURE)
    else {
        return Err(device_text(output));
    };
    Ok((device_text(&output[..start]), &output[start..]))
}

/// The device's text from screencap output, trimmed and cut to a readable
/// length for an error message.
fn device_text(bytes: &[u8]) -> String {
    const MAX: usize = 300;
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    if text.chars().count() <= MAX {
        return text.to_string();
    }
    let cut: String = text.chars().take(MAX).collect();
    format!("{cut}…")
}

/// Whether the text `screencap` printed before its PNG is the warning it
/// gives when it had to guess between several displays.
pub fn is_multi_display_warning(prefix: &str) -> bool {
    let lower = prefix.to_ascii_lowercase();
    lower.contains("multiple displays") || lower.contains("display id should be specified")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SF_FOLD: &str = "Display 4619827259835644672 (HWC display 0): port=0 pnpId=GGL displayName=\"EMU_display_0\"\n\
Display 4619827551948147201 (HWC display 1): port=1 pnpId=GGL displayName=\"EMU_display_1\"\n";

    const DUMPSYS_UNFOLDED: &str = "  mViewports=[DisplayViewport{type=INTERNAL, valid=true, isActive=true, displayId=0, uniqueId='local:4619827259835644672', physicalPort=0, orientation=0}, DisplayViewport{type=INTERNAL, valid=true, isActive=false, displayId=3, uniqueId='local:4619827551948147201', physicalPort=1}]\n";

    const DUMPSYS_FOLDED: &str = "  mViewports=[DisplayViewport{type=INTERNAL, valid=true, isActive=true, displayId=0, uniqueId='local:4619827551948147201', physicalPort=1, orientation=0}, DisplayViewport{type=INTERNAL, valid=true, isActive=false, displayId=1, uniqueId='local:4619827259835644672', physicalPort=0}]\n";

    const WARNING: &str = "[Warning] Multiple displays were found, but no display id was specified! Defaulting to the first display found, however this default is not guaranteed to be consistent across captures. A display id should be specified.\nA display ID can be specified with the [-d display-id] option.\nSee \"dumpsys SurfaceFlinger --display-id\" for valid display IDs.\n";

    fn png() -> Vec<u8> {
        let mut v = PNG_SIGNATURE.to_vec();
        v.extend_from_slice(b"\0\0\0\rIHDRrest");
        v
    }

    #[test]
    fn parses_surfaceflinger_display_ids() {
        assert_eq!(
            parse_surfaceflinger_display_ids(SF_FOLD),
            vec!["4619827259835644672", "4619827551948147201"]
        );
    }

    #[test]
    fn surfaceflinger_parse_skips_unrelated_lines() {
        let out = "Display 0 HWC layers:\nDisplay 4619827259835644672 (HWC display 0): port=0\nDisplay abc (HWC display 1): x\nsomething else\n";
        assert_eq!(
            parse_surfaceflinger_display_ids(out),
            vec!["4619827259835644672"]
        );
    }

    #[test]
    fn default_display_follows_the_fold_posture() {
        assert_eq!(
            parse_default_display_physical_id(DUMPSYS_UNFOLDED).as_deref(),
            Some("4619827259835644672")
        );
        assert_eq!(
            parse_default_display_physical_id(DUMPSYS_FOLDED).as_deref(),
            Some("4619827551948147201")
        );
    }

    #[test]
    fn default_display_does_not_match_display_ten() {
        let out = "DisplayViewport{type=EXTERNAL, displayId=10, uniqueId='local:111'}, DisplayViewport{type=INTERNAL, displayId=0, uniqueId='local:222'}";
        assert_eq!(
            parse_default_display_physical_id(out).as_deref(),
            Some("222")
        );
    }

    #[test]
    fn default_display_falls_back_to_display_info() {
        let out = "    mBaseDisplayInfo=DisplayInfo{\"Built-in Screen\", displayId 0, displayGroupId 0, FLAG_SECURE, real 1080 x 2424, state ON, type INTERNAL, uniqueId \"local:4619827551948147201\", app 1080 x 2424}\n";
        assert_eq!(
            parse_default_display_physical_id(out).as_deref(),
            Some("4619827551948147201")
        );
        assert_eq!(parse_default_display_physical_id("nothing here"), None);
    }

    #[test]
    fn capture_display_id_only_for_multi_display_devices() {
        let ids = parse_surfaceflinger_display_ids(SF_FOLD);
        assert_eq!(
            capture_display_id(&ids, DUMPSYS_FOLDED).as_deref(),
            Some("4619827551948147201")
        );
        let single = vec!["4619827259835644672".to_string()];
        assert_eq!(capture_display_id(&single, DUMPSYS_UNFOLDED), None);
    }

    #[test]
    fn capture_display_id_rejects_an_id_surfaceflinger_does_not_list() {
        let ids = vec!["1".to_string(), "2".to_string()];
        assert_eq!(capture_display_id(&ids, DUMPSYS_FOLDED), None);
    }

    #[test]
    fn splits_the_multi_display_warning_off_the_png() {
        let mut out = WARNING.as_bytes().to_vec();
        out.extend_from_slice(&png());
        let (prefix, data) = split_screencap_output(&out).unwrap();
        assert_eq!(data, png().as_slice());
        assert!(is_multi_display_warning(&prefix));
    }

    #[test]
    fn plain_png_has_no_prefix() {
        let out = png();
        let (prefix, data) = split_screencap_output(&out).unwrap();
        assert!(prefix.is_empty());
        assert_eq!(data, out.as_slice());
        assert!(!is_multi_display_warning(&prefix));
    }

    #[test]
    fn no_png_reports_the_device_text() {
        let out =
            b"Failed to take take screenshot. Display Id '123' is not valid.\nCapturing failed.\n";
        let err = split_screencap_output(out).unwrap_err();
        assert!(err.contains("Display Id '123' is not valid"), "{err}");
    }

    #[test]
    fn device_text_is_truncated() {
        let long = "x".repeat(1000);
        let err = split_screencap_output(long.as_bytes()).unwrap_err();
        assert!(err.chars().count() <= 301, "{}", err.len());
    }

    #[test]
    fn caches_physical_displays_per_serial() {
        cache_physical_displays("test-serial-a", vec!["1".into(), "2".into()]);
        assert_eq!(
            cached_physical_displays("test-serial-a"),
            Some(vec!["1".to_string(), "2".to_string()])
        );
        assert_eq!(cached_physical_displays("test-serial-unknown"), None);
    }
}
