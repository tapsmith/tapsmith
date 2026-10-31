//! Deciding whether the Android agent APKs need installing (PILOT-975).
//!
//! Every agent start used to run `adb install -r` on both APKs, so that a
//! locally rebuilt agent was always deployed. That costs seconds per
//! session per device. Instead, compare the bytes: hash each configured
//! host APK and the APK the device actually has installed for its package
//! (`pm path` → `md5sum`, one `adb shell` call for both), and install only
//! the ones that differ. The installed APK is the device's own copy of the
//! bytes `adb install` sent, so a rebuilt agent still differs and still gets
//! installed, and there is no marker file to go stale after a manual
//! install or uninstall. It is the comparison the CLI already makes for the
//! app under test (`installedApkMatches` in `emulator.ts`).
//!
//! Any doubt installs, exactly as before: a package that is missing or has
//! split APKs, a device without `md5sum`, a failed shell call, an unreadable
//! host file. `TAPSMITH_FORCE_AGENT_INSTALL` forces the install regardless.

use std::collections::HashMap;

use md5::{Digest, Md5};

/// Package of the agent APK (`agentApk`).
pub const AGENT_PACKAGE: &str = "dev.tapsmith.agent";
/// Package of the agent test APK (`agentTestApk`).
pub const AGENT_TEST_PACKAGE: &str = "dev.tapsmith.agent.test";

/// Set to a truthy value to reinstall the agent APKs on every agent start,
/// even when the device already has identical ones.
pub const FORCE_INSTALL_ENV: &str = "TAPSMITH_FORCE_AGENT_INSTALL";

/// Whether `TAPSMITH_FORCE_AGENT_INSTALL` asks for a forced install: any
/// non-empty value other than `0`, `false`, `no` or `off`.
pub fn force_install_requested(value: Option<&str>) -> bool {
    match value.map(str::trim) {
        None | Some("") => false,
        Some(v) => !matches!(
            v.to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
    }
}

/// One `adb shell` command that prints `<package> <md5>  <path>` for each
/// package whose single installed APK could be hashed, and `<package> -`
/// for one that is not installed or is installed as split APKs. Uses only
/// `pm`, `md5sum` (toybox, Android 6+) and shell built-ins.
pub fn installed_md5_command(packages: &[&str]) -> String {
    packages
        .iter()
        .map(|pkg| {
            format!(
                "f=; n=0; for l in $(pm path {pkg} 2>/dev/null); do n=$((n+1)); f=${{l#package:}}; done; \
                 if [ \"$n\" = 1 ]; then echo \"{pkg} $(md5sum \"$f\" 2>/dev/null)\"; else echo \"{pkg} -\"; fi"
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Parse `installed_md5_command`'s output into package → lowercase MD5.
/// Packages without a well-formed hash are left out, so they install.
pub fn parse_installed_md5s(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let package = fields.next()?;
            let hash = fields.next()?.to_ascii_lowercase();
            (hash.len() == 32 && hash.chars().all(|c| c.is_ascii_hexdigit()))
                .then(|| (package.to_string(), hash))
        })
        .collect()
}

/// MD5 of a host file as lowercase hex, or `None` when it cannot be read
/// (the install that follows then reports the real error).
pub async fn host_md5(path: &str) -> Option<String> {
    let bytes = tokio::fs::read(path).await.ok()?;
    Some(
        Md5::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

/// Whether the APK for `package`, whose host copy hashes to `host_md5`,
/// needs installing given the device's installed hashes.
pub fn needs_install(
    package: &str,
    host_md5: Option<&str>,
    installed: &HashMap<String, String>,
) -> bool {
    match (host_md5, installed.get(package)) {
        (Some(host), Some(device)) => !host.eq_ignore_ascii_case(device),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "0123456789abcdef0123456789abcdef";
    const HASH_B: &str = "fedcba9876543210fedcba9876543210";

    fn installed(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(p, h)| (p.to_string(), h.to_string()))
            .collect()
    }

    #[test]
    fn force_install_env_is_truthy_unless_empty_or_a_false_word() {
        for off in [
            None,
            Some(""),
            Some("  "),
            Some("0"),
            Some("false"),
            Some("No"),
            Some("OFF"),
        ] {
            assert!(!force_install_requested(off), "{off:?}");
        }
        for on in [Some("1"), Some("true"), Some("yes"), Some("anything")] {
            assert!(force_install_requested(on), "{on:?}");
        }
    }

    #[test]
    fn parses_md5sum_lines_per_package() {
        let output = format!(
            "{AGENT_PACKAGE} {HASH_A}  /data/app/~~x==/dev.tapsmith.agent-y==/base.apk\r\n\
             {AGENT_TEST_PACKAGE} {}  /data/app/dev.tapsmith.agent.test-1/base.apk\n",
            HASH_B.to_ascii_uppercase()
        );
        assert_eq!(
            parse_installed_md5s(&output),
            installed(&[(AGENT_PACKAGE, HASH_A), (AGENT_TEST_PACKAGE, HASH_B)])
        );
    }

    #[test]
    fn leaves_out_packages_without_a_usable_hash() {
        // Not installed / split APKs print "-"; a device without md5sum
        // prints nothing after the package; garbage is not a hash.
        let output = format!(
            "{AGENT_PACKAGE} -\n{AGENT_TEST_PACKAGE} \nother.pkg md5sum: not found\nshort abc123\n"
        );
        assert!(parse_installed_md5s(&output).is_empty());
    }

    #[test]
    fn installs_only_what_differs_or_is_unknown() {
        let device = installed(&[(AGENT_PACKAGE, HASH_A), (AGENT_TEST_PACKAGE, HASH_A)]);
        // Identical bytes: skip.
        assert!(!needs_install(AGENT_PACKAGE, Some(HASH_A), &device));
        assert!(!needs_install(
            AGENT_PACKAGE,
            Some(&HASH_A.to_ascii_uppercase()),
            &device
        ));
        // A rebuilt agent: install.
        assert!(needs_install(AGENT_TEST_PACKAGE, Some(HASH_B), &device));
        // Unreadable host APK, or nothing known on the device: install.
        assert!(needs_install(AGENT_PACKAGE, None, &device));
        assert!(needs_install(AGENT_PACKAGE, Some(HASH_A), &HashMap::new()));
    }

    #[test]
    fn shell_command_covers_each_package_once() {
        let cmd = installed_md5_command(&[AGENT_PACKAGE, AGENT_TEST_PACKAGE]);
        assert_eq!(cmd.matches("pm path dev.tapsmith.agent ").count(), 1);
        assert_eq!(cmd.matches("pm path dev.tapsmith.agent.test ").count(), 1);
        assert!(!cmd.contains('\n'), "one adb shell line: {cmd}");
    }

    /// Runs the real command under the host's POSIX `sh` with stand-ins for
    /// `pm` and `md5sum`: one package installed once, one with split APKs,
    /// one missing.
    #[cfg(unix)]
    #[test]
    fn shell_command_runs_under_posix_sh() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let write_script = |name: &str, body: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        write_script(
            "pm",
            "case \"$2\" in\n\
             dev.tapsmith.agent) echo package:/data/app/a-1/base.apk ;;\n\
             dev.tapsmith.agent.test) echo package:/data/app/t-1/base.apk; echo package:/data/app/t-1/split.apk ;;\n\
             esac",
        );
        write_script("md5sum", &format!("echo \"{HASH_A}  $1\""));
        let path = format!("{}:/usr/bin:/bin", dir.path().display());
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(installed_md5_command(&[
                AGENT_PACKAGE,
                AGENT_TEST_PACKAGE,
                "not.installed",
            ]))
            .env("PATH", path)
            .output()
            .unwrap();
        let stdout = String::from_utf8(out.stdout).unwrap();
        assert_eq!(
            stdout,
            format!(
                "{AGENT_PACKAGE} {HASH_A}  /data/app/a-1/base.apk\n\
                 {AGENT_TEST_PACKAGE} -\n\
                 not.installed -\n"
            )
        );
        assert_eq!(
            parse_installed_md5s(&stdout),
            installed(&[(AGENT_PACKAGE, HASH_A)])
        );
    }

    #[tokio::test]
    async fn host_md5_hashes_the_file_and_tolerates_a_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent.apk");
        std::fs::write(&path, b"hello").unwrap();
        assert_eq!(
            host_md5(path.to_str().unwrap()).await.as_deref(),
            Some("5d41402abc4b2a76b9719d911017c592")
        );
        assert_eq!(
            host_md5(dir.path().join("missing.apk").to_str().unwrap()).await,
            None
        );
    }
}
