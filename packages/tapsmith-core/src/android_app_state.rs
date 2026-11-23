//! Device commands for Android `saveAppState` / `restoreAppState`, and the
//! error a device that can reach neither root nor `run-as` gets.
//!
//! Without root, the app's data dir is reachable only through
//! `run-as <pkg>`, which runs as the app's uid. That uid cannot create or
//! (reliably) read files in `/data/local/tmp`, which belongs to the shell
//! user, so tar never touches the staging file itself: on save it writes the
//! archive to stdout and the shell redirects it into the file, and on restore
//! the shell reads the file and pipes it into tar's stdin.

/// `tar` flags that leave out the cache dirs, which carry no app state.
/// Older Toybox builds (before Android 10) reject `--exclude`, so save
/// retries without them.
pub const CACHE_EXCLUDES: &str = "--exclude=./cache --exclude=./code_cache";

/// The command that archives `data_dir` into `device_tmp`.
pub fn save_command(
    pkg: &str,
    data_dir: &str,
    device_tmp: &str,
    is_root: bool,
    excludes: &str,
) -> String {
    let excludes = if excludes.is_empty() {
        String::new()
    } else {
        format!(" {excludes}")
    };
    if is_root {
        format!("tar czf {device_tmp}{excludes} -C {data_dir} .")
    } else {
        format!("run-as {pkg} tar czf -{excludes} -C {data_dir} . > {device_tmp}")
    }
}

/// The command that extracts `device_tmp` into `data_dir`.
pub fn restore_command(pkg: &str, data_dir: &str, device_tmp: &str, is_root: bool) -> String {
    if is_root {
        format!("tar xzf {device_tmp} -C {data_dir}")
    } else {
        format!("cat {device_tmp} | run-as {pkg} tar xzf - -C {data_dir}")
    }
}

/// The probe that tells whether `run-as` can enter the app at all, run before
/// anything touches the device's copy of the app's data.
pub fn run_as_probe(pkg: &str) -> String {
    format!("run-as {pkg} true")
}

/// Why `run-as <pkg>` refused, from its error output.
#[derive(Debug, PartialEq, Eq)]
pub enum RunAsRefusal {
    /// The installed build is not debuggable (a release build).
    NotDebuggable,
    /// No package of that name is installed.
    UnknownPackage,
    /// Anything else: kept verbatim.
    Other(String),
}

pub fn classify_run_as_refusal(output: &str) -> RunAsRefusal {
    if output.contains("package not debuggable") {
        RunAsRefusal::NotDebuggable
    } else if output.contains("unknown package") {
        RunAsRefusal::UnknownPackage
    } else {
        RunAsRefusal::Other(output.trim().to_string())
    }
}

/// What kind of device refused root, for the way out the error offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKind {
    /// `ro.debuggable=1`: adbd can be restarted as root, it just is not.
    Rootable,
    /// An emulator on a production image (Google Play), which blocks root.
    ProductionEmulator,
    /// A physical device, which blocks root.
    Physical,
}

/// Tell what kind of device this is, for a device whose adbd is not root.
pub async fn device_kind(serial: &str) -> DeviceKind {
    let prop = |name: &'static str| async move {
        crate::adb::shell_lenient(serial, &format!("getprop {name}"))
            .await
            .map(|v| v.trim() == "1")
            .unwrap_or(false)
    };
    if prop("ro.debuggable").await {
        DeviceKind::Rootable
    } else if serial.starts_with("emulator-")
        || prop("ro.kernel.qemu").await
        || prop("ro.boot.qemu").await
    {
        DeviceKind::ProductionEmulator
    } else {
        DeviceKind::Physical
    }
}

/// `op` is `saveAppState` or `restoreAppState`.
pub fn run_as_refusal_message(
    op: &str,
    pkg: &str,
    serial: &str,
    refusal: &RunAsRefusal,
    kind: DeviceKind,
) -> String {
    let no_root = match kind {
        DeviceKind::Rootable => format!("adbd on {serial} is not running as root"),
        DeviceKind::ProductionEmulator => format!(
            "{serial} runs a production system image (such as Google Play), which can't run adbd as root"
        ),
        DeviceKind::Physical => format!("{serial} is a physical device, which can't run adbd as root"),
    };
    let why = match refusal {
        RunAsRefusal::NotDebuggable => {
            format!("{pkg} is not debuggable, so run-as can't reach its data")
        }
        RunAsRefusal::UnknownPackage => format!("{pkg} is not installed on {serial}"),
        RunAsRefusal::Other(raw) => format!("run-as can't reach {pkg}'s data ({raw})"),
    };
    let fix = match (refusal, kind) {
        (RunAsRefusal::UnknownPackage, _) => format!("Install the app on {serial} first."),
        (_, DeviceKind::Rootable) => format!(
            "Run `adb -s {serial} root` and try again, or install a debuggable build of {pkg}."
        ),
        (_, DeviceKind::ProductionEmulator) => format!(
            "Use a Google APIs emulator image (`npx tapsmith create-avd`), or install a debuggable \
             build of {pkg} (a debug build, or `debuggable true` on the build type you test)."
        ),
        (_, DeviceKind::Physical) => format!(
            "Install a debuggable build of {pkg} (a debug build, or `debuggable true` on the \
             build type you test)."
        ),
    };
    format!("{op} needs adb root or a debuggable build of the app: {no_root}, and {why}. {fix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PKG: &str = "com.example.app";
    const DIR: &str = "/data/data/com.example.app";
    const TMP: &str = "/data/local/tmp/tapsmith-app-state-1.tar.gz";

    #[test]
    fn root_save_writes_the_archive_itself() {
        assert_eq!(
            save_command(PKG, DIR, TMP, true, CACHE_EXCLUDES),
            "tar czf /data/local/tmp/tapsmith-app-state-1.tar.gz --exclude=./cache \
             --exclude=./code_cache -C /data/data/com.example.app ."
        );
        assert_eq!(
            save_command(PKG, DIR, TMP, true, ""),
            "tar czf /data/local/tmp/tapsmith-app-state-1.tar.gz -C /data/data/com.example.app ."
        );
    }

    #[test]
    fn run_as_save_streams_to_stdout_and_the_shell_writes_the_file() {
        // The app's uid cannot create files in /data/local/tmp; the shell can.
        assert_eq!(
            save_command(PKG, DIR, TMP, false, CACHE_EXCLUDES),
            "run-as com.example.app tar czf - --exclude=./cache --exclude=./code_cache \
             -C /data/data/com.example.app . > /data/local/tmp/tapsmith-app-state-1.tar.gz"
        );
        assert_eq!(
            save_command(PKG, DIR, TMP, false, ""),
            "run-as com.example.app tar czf - -C /data/data/com.example.app . \
             > /data/local/tmp/tapsmith-app-state-1.tar.gz"
        );
    }

    #[test]
    fn restore_reads_the_staged_file_as_root_or_through_the_shell() {
        assert_eq!(
            restore_command(PKG, DIR, TMP, true),
            "tar xzf /data/local/tmp/tapsmith-app-state-1.tar.gz -C /data/data/com.example.app"
        );
        assert_eq!(
            restore_command(PKG, DIR, TMP, false),
            "cat /data/local/tmp/tapsmith-app-state-1.tar.gz | run-as com.example.app tar xzf - \
             -C /data/data/com.example.app"
        );
    }

    #[test]
    fn run_as_refusals_are_classified_from_their_output() {
        assert_eq!(
            classify_run_as_refusal(
                "adb command failed (exit exit status: 1): run-as: package not debuggable: com.example.app"
            ),
            RunAsRefusal::NotDebuggable
        );
        assert_eq!(
            classify_run_as_refusal("run-as: unknown package: com.example.app\n"),
            RunAsRefusal::UnknownPackage
        );
        assert_eq!(
            classify_run_as_refusal("run-as: package not an application: com.android.settings\n"),
            RunAsRefusal::Other(
                "run-as: package not an application: com.android.settings".to_string()
            )
        );
    }

    #[test]
    fn a_release_build_on_a_play_emulator_is_told_both_ways_out() {
        assert_eq!(
            run_as_refusal_message(
                "saveAppState",
                PKG,
                "emulator-5554",
                &RunAsRefusal::NotDebuggable,
                DeviceKind::ProductionEmulator,
            ),
            "saveAppState needs adb root or a debuggable build of the app: emulator-5554 runs a \
             production system image (such as Google Play), which can't run adbd as root, and \
             com.example.app is not debuggable, so run-as can't reach its data. Use a Google APIs \
             emulator image (`npx tapsmith create-avd`), or install a debuggable build of \
             com.example.app (a debug build, or `debuggable true` on the build type you test)."
        );
    }

    #[test]
    fn a_physical_device_is_told_to_use_a_debuggable_build() {
        let msg = run_as_refusal_message(
            "restoreAppState",
            PKG,
            "R58M123",
            &RunAsRefusal::NotDebuggable,
            DeviceKind::Physical,
        );
        assert!(msg.starts_with("restoreAppState needs adb root or a debuggable build"));
        assert!(msg.contains("R58M123 is a physical device"));
        assert!(msg.contains("Install a debuggable build of com.example.app"));
        assert!(!msg.contains("create-avd"));
    }

    #[test]
    fn a_rootable_device_is_told_to_root_adbd() {
        let msg = run_as_refusal_message(
            "saveAppState",
            PKG,
            "emulator-5556",
            &RunAsRefusal::NotDebuggable,
            DeviceKind::Rootable,
        );
        assert!(msg.contains("adbd on emulator-5556 is not running as root"));
        assert!(msg.contains("Run `adb -s emulator-5556 root` and try again"));
    }

    #[test]
    fn a_missing_package_is_named_as_missing() {
        let msg = run_as_refusal_message(
            "saveAppState",
            PKG,
            "emulator-5554",
            &RunAsRefusal::UnknownPackage,
            DeviceKind::ProductionEmulator,
        );
        assert!(msg.contains("com.example.app is not installed on emulator-5554"));
        assert!(msg.ends_with("Install the app on emulator-5554 first."));
    }

    #[test]
    fn other_refusals_keep_run_as_output() {
        let msg = run_as_refusal_message(
            "saveAppState",
            "com.android.settings",
            "emulator-5554",
            &RunAsRefusal::Other("run-as: package not an application: com.android.settings".into()),
            DeviceKind::ProductionEmulator,
        );
        assert!(msg.contains(
            "run-as can't reach com.android.settings's data (run-as: package not an application: com.android.settings)"
        ));
    }
}
