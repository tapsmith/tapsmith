//! Faster UIKit animations on an iOS simulator for `reducedMotion: 'reduce'`.
//!
//! UIKit scales every UIKit and Core Animation duration by its private
//! `UIAnimationDragCoefficient` preference, but reads it only when the
//! `UIKit/UIPreferences` feature flag is on. The flag comes from the
//! `FEATUREFLAGS_ENABLED` environment variable of the app's process, and the
//! preference from the argument domain (`-UIAnimationDragCoefficient 0.1`) or
//! the global domain. An app's own domain is not read.
//!
//! A launch argument only reaches the launches Tapsmith makes itself, and the
//! cold deep-link reset launches the app through `simctl openurl`, which
//! cannot carry one. So the setting is simulator-wide instead, like Android's
//! animation scales: the daemon sets the flag in the simulator's launchd
//! environment (`launchctl setenv`) and the coefficient in its global defaults
//! domain. Every app launched afterwards, by any path, inherits both. An app
//! already running keeps its speed until it is next launched.
//!
//! **Restoring and crash safety** follow the Android animation scales: an
//! owner record, `~/.tapsmith/ios-animation-speed/<udid>.json`, holds the
//! originals and the daemon's pid and start time before anything changes;
//! the values are put back at daemon shutdown, when the daemon moves to
//! another device, or when a later SetDevice turns the option off; the next
//! daemon that selects the simulator recovers a record whose owner died.
//! Only what still reads as Tapsmith's value is put back.
//!
//! A `FEATUREFLAGS_ENABLED` that already holds another value is someone
//! else's, so the setting is not applied at all rather than overwrite it.
//! launchd forgets its environment when the simulator shuts down, so a
//! reboot the daemon makes mid-session is followed by [`reapply`], and every
//! later fresh agent start checks for one it did not make
//! ([`reapply_if_lost`]).
//!
//! Every failure here is logged and otherwise ignored: faster animations are
//! a convenience, and must never fail a session.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

/// The environment variable that turns UIKit feature flags on.
pub const FLAG_ENV: &str = "FEATUREFLAGS_ENABLED";
/// The flag that makes UIKit read `UIAnimationDragCoefficient`.
pub const FLAG_VALUE: &str = "UIKit/UIPreferences";
/// UIKit's animation duration multiplier.
pub const COEFFICIENT_KEY: &str = "UIAnimationDragCoefficient";
/// Ten times faster. Speedrun measured 0.01 as no faster than 0.1.
pub const COEFFICIENT: &str = "0.1";

/// Bound for each `simctl spawn` while a device is being selected: generous,
/// because a just-booted simulator under load can take seconds per call.
pub const SELECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Bound for each `simctl spawn` of the restore at daemon shutdown (a read,
/// then the writes). Every daemon of a `--workers` run shuts down at once,
/// alongside its agent teardown, and CoreSimulator then takes more than 3 s
/// per spawn; an idle spawn already takes about 1 s. Nothing in Tapsmith
/// SIGKILLs a daemon after SIGTERM, so the bound only has to stop a wedged
/// CoreSimulator from holding the daemon forever. A restore cut short keeps
/// its record, for the next session to finish.
pub const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

// ─── Reading the simulator ───

/// The two values, as the simulator reports them; `None` = unset.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Reading {
    pub flag: Option<String>,
    pub coefficient: Option<String>,
}

/// One `simctl spawn` that ran to completion.
#[derive(Debug, Clone, Default)]
pub struct SpawnOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

fn is_plain_number(value: &str) -> bool {
    !value.is_empty()
        && value.parse::<f64>().is_ok_and(f64::is_finite)
        && value.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Whether `value` is the coefficient Tapsmith writes (`defaults` may print
/// a float in another form than it was written in).
fn is_our_coefficient(value: Option<&str>) -> bool {
    let ours: f64 = COEFFICIENT.parse().expect("COEFFICIENT is a number");
    value
        .and_then(|v| v.trim().parse::<f64>().ok())
        .is_some_and(|v| (v - ours).abs() < 1e-6)
}

fn is_our_flag(value: Option<&str>) -> bool {
    value == Some(FLAG_VALUE)
}

// ─── Owner records ───

/// The values before the first daemon changed them; `None` = unset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Originals {
    pub flag: Option<String>,
    pub coefficient: Option<String>,
}

/// Contents of an owner record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerRecord {
    pub udid: String,
    /// The daemon that applied the setting.
    pub pid: u32,
    /// That daemon's start time (`ps -o lstart=`), so a reused pid is not
    /// mistaken for it.
    pub started: Option<String>,
    pub originals: Originals,
}

/// Where the record for simulator `udid` lives.
pub fn record_path(dir: &Path, udid: &str) -> PathBuf {
    let safe: String = udid
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    dir.join(format!("{safe}.json"))
}

fn read_record(path: &Path) -> Option<OwnerRecord> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(r) => Some(r),
        Err(e) => {
            warn!(path = %path.display(), "Ignoring an unreadable animation-speed record: {e}");
            None
        }
    }
}

/// Written aside and renamed into place, so a daemon killed mid-write leaves
/// the previous record (or none), never a truncated one.
fn write_record(path: &Path, record: &OwnerRecord) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(record)?)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

fn remove_record(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            warn!(path = %path.display(), "Could not remove the animation-speed record: {e}");
        }
    }
}

/// `~/.tapsmith/ios-animation-speed`.
pub fn records_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".tapsmith").join("ios-animation-speed"))
}

// ─── Host ───

/// What the logic needs from the outside world, injectable for tests.
#[async_trait::async_trait]
pub trait Host: Send + Sync {
    /// `xcrun simctl spawn <udid> <args…>`. `Err` when it could not run or
    /// timed out: the outcome is then unknown.
    async fn spawn(
        &self,
        udid: &str,
        args: &[&str],
        timeout: Duration,
    ) -> anyhow::Result<SpawnOutput>;
    /// Whether the daemon that wrote `record` is still running.
    async fn owner_alive(&self, record: &OwnerRecord) -> bool;
    fn self_pid(&self) -> u32;
    async fn self_started(&self) -> Option<String>;
}

pub struct RealHost;

#[async_trait::async_trait]
impl Host for RealHost {
    async fn spawn(
        &self,
        udid: &str,
        args: &[&str],
        timeout: Duration,
    ) -> anyhow::Result<SpawnOutput> {
        let out = super::device::bounded_output(
            "simctl spawn",
            tokio::process::Command::new("xcrun")
                .args(["simctl", "spawn", udid])
                .args(args),
            timeout,
        )
        .await?;
        Ok(SpawnOutput {
            success: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }

    async fn owner_alive(&self, record: &OwnerRecord) -> bool {
        if !crate::process_identity::pid_exists(record.pid) {
            return false;
        }
        match (
            &record.started,
            crate::process_identity::process_started(record.pid).await,
        ) {
            (Some(recorded), Some(now)) => recorded == &now,
            // The process exists but its start time is unknown on one side:
            // assume it is the owner rather than undo a live session's setting.
            _ => true,
        }
    }

    fn self_pid(&self) -> u32 {
        std::process::id()
    }

    async fn self_started(&self) -> Option<String> {
        crate::process_identity::own_start_time().await
    }
}

/// Run one `simctl spawn` that must succeed. False (logged) otherwise.
async fn run(h: &dyn Host, udid: &str, args: &[&str], timeout: Duration, what: &str) -> bool {
    match h.spawn(udid, args, timeout).await {
        Ok(out) if out.success => true,
        Ok(out) => {
            warn!(%udid, stderr = %out.stderr.trim(), "Could not {what}");
            false
        }
        Err(e) => {
            warn!(%udid, "Could not {what}: {e:#}");
            false
        }
    }
}

async fn read_sim(h: &dyn Host, udid: &str, timeout: Duration) -> Option<Reading> {
    let flag_args = ["launchctl", "getenv", FLAG_ENV];
    let coefficient_args = ["defaults", "read", "-g", COEFFICIENT_KEY];
    let (flag, coefficient) = tokio::join!(
        h.spawn(udid, &flag_args, timeout),
        h.spawn(udid, &coefficient_args, timeout),
    );
    let flag = match flag {
        // An unset variable prints nothing and still succeeds.
        Ok(out) if out.success => Some(out.stdout.trim().to_string()).filter(|v| !v.is_empty()),
        Ok(out) => {
            warn!(%udid, stderr = %out.stderr.trim(), "Could not read the simulator's {FLAG_ENV}");
            return None;
        }
        Err(e) => {
            warn!(%udid, "Could not read the simulator's {FLAG_ENV}: {e:#}");
            return None;
        }
    };
    let coefficient = match coefficient {
        Ok(out) if out.success => Some(out.stdout.trim().to_string()),
        Ok(out) if out.stderr.contains("does not exist") => None,
        Ok(out) => {
            warn!(%udid, stderr = %out.stderr.trim(), "Could not read the simulator's {COEFFICIENT_KEY}");
            return None;
        }
        Err(e) => {
            warn!(%udid, "Could not read the simulator's {COEFFICIENT_KEY}: {e:#}");
            return None;
        }
    };
    Some(Reading { flag, coefficient })
}

/// Set both values. False when either did not certainly land.
async fn apply(h: &dyn Host, udid: &str, timeout: Duration) -> bool {
    let set_flag = ["launchctl", "setenv", FLAG_ENV, FLAG_VALUE];
    let set_coefficient = [
        "defaults",
        "write",
        "-g",
        COEFFICIENT_KEY,
        "-float",
        COEFFICIENT,
    ];
    let (flag, coefficient) = tokio::join!(
        run(h, udid, &set_flag, timeout, "set the UIKit feature flag"),
        run(
            h,
            udid,
            &set_coefficient,
            timeout,
            "set the animation coefficient"
        ),
    );
    flag && coefficient
}

/// Put `originals` back where `current` still reads as Tapsmith's. True when
/// nothing is left to restore (so the record can go).
async fn put_back(
    h: &dyn Host,
    udid: &str,
    current: &Reading,
    originals: &Originals,
    timeout: Duration,
) -> bool {
    // A flag that was set before is never Tapsmith's to remove: on_select
    // only applies over an unset flag or one already holding FLAG_VALUE.
    let flag = async {
        if originals.flag.is_none() && is_our_flag(current.flag.as_deref()) {
            run(
                h,
                udid,
                &["launchctl", "unsetenv", FLAG_ENV],
                timeout,
                "unset the UIKit feature flag",
            )
            .await
        } else {
            true
        }
    };
    let coefficient = async {
        if !is_our_coefficient(current.coefficient.as_deref()) {
            return true;
        }
        match originals.coefficient.as_deref() {
            None => {
                run(
                    h,
                    udid,
                    &["defaults", "delete", "-g", COEFFICIENT_KEY],
                    timeout,
                    "remove the animation coefficient",
                )
                .await
            }
            Some(v) if is_plain_number(v) => {
                run(
                    h,
                    udid,
                    &["defaults", "write", "-g", COEFFICIENT_KEY, "-float", v],
                    timeout,
                    "restore the animation coefficient",
                )
                .await
            }
            Some(v) => {
                warn!(%udid, original = %v, "Not restoring an animation coefficient that is not a plain number");
                true
            }
        }
    };
    // Independent values, so the two writes run side by side.
    let (flag, coefficient) = tokio::join!(flag, coefficient);
    let done = flag && coefficient;
    if done {
        info!(%udid, "Restored the simulator's animation speed");
    }
    done
}

// ─── Session logic ───

/// A simulator this daemon has sped up, and the record that says how to undo it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub udid: String,
    pub record_path: PathBuf,
}

async fn is_ours(h: &dyn Host, record: &OwnerRecord) -> bool {
    record.pid == h.self_pid() && record.started == h.self_started().await
}

/// Bring simulator `udid` in line with what the session asked for, when the
/// SDK selects it. `want`: `Some(true)` speed animations up, `Some(false)`
/// undo what this daemon did, `None` (an SDK that does not say) leave this
/// daemon's own setting as it is. Either way a record left by a daemon that
/// died is recovered. `current` is what this daemon has applied so far, if
/// anything; the result is what it has applied afterwards.
pub async fn on_select(
    h: &dyn Host,
    dir: &Path,
    udid: &str,
    want: Option<bool>,
    current: Option<&Applied>,
) -> Option<Applied> {
    let ours_here = current.filter(|a| a.udid == udid).cloned();
    let path = record_path(dir, udid);
    if want != Some(true) && ours_here.is_none() && !path.exists() {
        return None;
    }
    if want.is_none() && ours_here.is_some() {
        return ours_here;
    }

    let Some(reading) = read_sim(h, udid, SELECT_TIMEOUT).await else {
        // Unknown, not "nothing applied": keep what this daemon already holds,
        // so a failed re-read never drops the restore owed at shutdown.
        return ours_here;
    };
    let applied = Applied {
        udid: udid.to_string(),
        record_path: path.clone(),
    };

    let originals = match read_record(&path) {
        Some(record) if is_ours(h, &record).await => {
            if want == Some(true) {
                // Already applied; set it again in case someone undid it.
                apply(h, udid, SELECT_TIMEOUT).await;
                return Some(applied);
            }
            if put_back(h, udid, &reading, &record.originals, SELECT_TIMEOUT).await {
                remove_record(&path);
            }
            return None;
        }
        Some(record) if h.owner_alive(&record).await => {
            warn!(
                %udid,
                owner = record.pid,
                "Another live Tapsmith daemon has sped this simulator's animations up; leaving them to it"
            );
            return None;
        }
        Some(record) => {
            info!(%udid, owner = record.pid, "Recovering the animation speed left by an exited daemon");
            if want != Some(true) {
                if put_back(h, udid, &reading, &record.originals, SELECT_TIMEOUT).await {
                    remove_record(&path);
                }
                return None;
            }
            // Taking it over: the dead daemon's originals are the simulator's
            // own values; what it reads now is what that daemon left.
            record.originals
        }
        None => {
            if want != Some(true) {
                return None;
            }
            if let Some(flag) = reading.flag.as_deref().filter(|f| !is_our_flag(Some(f))) {
                warn!(
                    %udid,
                    %flag,
                    "Not speeding animations up: the simulator's {FLAG_ENV} is already set"
                );
                return None;
            }
            Originals {
                flag: reading.flag.clone(),
                coefficient: reading.coefficient.clone(),
            }
        }
    };

    // Recorded before anything changes, so a crash right after still leaves
    // the next daemon what it needs.
    let record = OwnerRecord {
        udid: udid.to_string(),
        pid: h.self_pid(),
        started: h.self_started().await,
        originals,
    };
    if let Err(e) = write_record(&path, &record) {
        warn!(%udid, path = %path.display(), "Not speeding animations up: could not record the simulator's own values ({e:#})");
        return None;
    }
    if apply(h, udid, SELECT_TIMEOUT).await {
        info!(%udid, "Sped up the simulator's UIKit animations for this session (apps launched from now on)");
    } else {
        // The outcome is unknown, not "nothing changed": a timed-out spawn
        // can still land. Keep the record; the restore only puts back what
        // still reads as Tapsmith's.
        warn!(%udid, "Keeping the animation-speed record to restore at session end");
    }
    Some(applied)
}

/// Set the values again for a session that holds `applied`, after the
/// simulator restarted (launchd forgets its environment on shutdown).
pub async fn reapply(h: &dyn Host, applied: &Applied) {
    if let Some(record) = read_record(&applied.record_path) {
        if is_ours(h, &record).await {
            apply(h, &applied.udid, SELECT_TIMEOUT).await;
        }
    }
}

/// Set the flag again if the simulator lost it since `applied` was set up:
/// a reboot that this daemon did not make (the SDK's session recovery)
/// clears launchd's environment. One read when nothing was lost.
pub async fn reapply_if_lost(h: &dyn Host, applied: &Applied) {
    let lost = match h
        .spawn(
            &applied.udid,
            &["launchctl", "getenv", FLAG_ENV],
            SELECT_TIMEOUT,
        )
        .await
    {
        Ok(out) if out.success => !is_our_flag(Some(out.stdout.trim())),
        _ => false,
    };
    if lost {
        info!(udid = %applied.udid, "The simulator lost the UIKit feature flag (restarted?); setting it again");
        reapply(h, applied).await;
    }
}

/// Undo `applied`: at daemon shutdown, or when the daemon moves to another
/// device. A simulator that cannot be read keeps its record, for the next
/// daemon that selects it.
pub async fn restore(h: &dyn Host, applied: &Applied, timeout: Duration) {
    let Some(record) = read_record(&applied.record_path) else {
        return;
    };
    if !is_ours(h, &record).await {
        return;
    }
    let Some(reading) = read_sim(h, &applied.udid, timeout).await else {
        return;
    };
    if put_back(h, &applied.udid, &reading, &record.originals, timeout).await {
        remove_record(&applied.record_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    /// A simulator's launchd environment and global defaults, plus a fake
    /// process table.
    struct FakeHost {
        env: Mutex<BTreeMap<String, String>>,
        defaults: Mutex<BTreeMap<String, String>>,
        calls: Mutex<Vec<String>>,
        pid: u32,
        started: Option<String>,
        live_owner: bool,
        /// Writes run but report a timeout (the outcome is unknown).
        fail_writes: bool,
        /// Reads fail (simulator not answering).
        fail_reads: bool,
        /// How long each spawn takes on this simulator.
        per_call: Duration,
    }

    impl FakeHost {
        fn new(flag: Option<&str>, coefficient: Option<&str>) -> Self {
            let h = Self {
                env: Mutex::new(BTreeMap::new()),
                defaults: Mutex::new(BTreeMap::new()),
                calls: Mutex::new(Vec::new()),
                pid: 100,
                started: Some("Mon Oct 27 10:00:00 2026".into()),
                live_owner: false,
                fail_writes: false,
                fail_reads: false,
                per_call: Duration::from_millis(400),
            };
            if let Some(f) = flag {
                h.env.lock().unwrap().insert(FLAG_ENV.into(), f.into());
            }
            if let Some(c) = coefficient {
                h.defaults
                    .lock()
                    .unwrap()
                    .insert(COEFFICIENT_KEY.into(), c.into());
            }
            h
        }

        fn state(&self) -> (Option<String>, Option<String>) {
            (
                self.env.lock().unwrap().get(FLAG_ENV).cloned(),
                self.defaults.lock().unwrap().get(COEFFICIENT_KEY).cloned(),
            )
        }

        fn call_count(&self) -> usize {
            self.calls.lock().unwrap().len()
        }
    }

    fn ok(stdout: &str) -> anyhow::Result<SpawnOutput> {
        Ok(SpawnOutput {
            success: true,
            stdout: stdout.into(),
            stderr: String::new(),
        })
    }

    #[async_trait::async_trait]
    impl Host for FakeHost {
        async fn spawn(
            &self,
            _udid: &str,
            args: &[&str],
            timeout: Duration,
        ) -> anyhow::Result<SpawnOutput> {
            self.calls.lock().unwrap().push(args.join(" "));
            if self.per_call > timeout {
                anyhow::bail!("simctl spawn timed out after {timeout:?}");
            }
            let mut env = self.env.lock().unwrap();
            let mut defaults = self.defaults.lock().unwrap();
            let is_read = matches!(args, ["launchctl", "getenv", ..] | ["defaults", "read", ..]);
            if is_read && self.fail_reads {
                anyhow::bail!("simctl spawn timed out after 3s");
            }
            let out = match args {
                ["launchctl", "getenv", k] => {
                    ok(&format!("{}\n", env.get(*k).map(String::as_str).unwrap_or("")))
                }
                ["launchctl", "setenv", k, v] => {
                    env.insert(k.to_string(), v.to_string());
                    ok("")
                }
                ["launchctl", "unsetenv", k] => {
                    env.remove(*k);
                    ok("")
                }
                ["defaults", "read", "-g", k] => match defaults.get(*k) {
                    Some(v) => ok(&format!("{v}\n")),
                    None => Ok(SpawnOutput {
                        success: false,
                        stdout: String::new(),
                        stderr: format!("The domain/default pair of (kCFPreferencesAnyApplication, {k}) does not exist\n"),
                    }),
                },
                ["defaults", "write", "-g", k, "-float", v] => {
                    defaults.insert(k.to_string(), v.to_string());
                    ok("")
                }
                ["defaults", "delete", "-g", k] => {
                    defaults.remove(*k);
                    ok("")
                }
                other => panic!("unexpected spawn {other:?}"),
            };
            if !is_read && self.fail_writes {
                anyhow::bail!("simctl spawn timed out after 3s");
            }
            out
        }

        async fn owner_alive(&self, _record: &OwnerRecord) -> bool {
            self.live_owner
        }

        fn self_pid(&self) -> u32 {
            self.pid
        }

        async fn self_started(&self) -> Option<String> {
            self.started.clone()
        }
    }

    const U: &str = "D502EBA7-E611-4152-B800-4A33139A0173";

    fn some(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    fn stale_record(dir: &Path, originals: Originals) -> PathBuf {
        let path = record_path(dir, U);
        write_record(
            &path,
            &OwnerRecord {
                udid: U.into(),
                pid: 7,
                started: Some("Sun Oct 26 09:00:00 2026".into()),
                originals,
            },
        )
        .unwrap();
        path
    }

    #[test]
    fn coefficient_comparison_tolerates_how_defaults_prints_a_float() {
        assert!(is_our_coefficient(Some("0.1")));
        assert!(is_our_coefficient(Some("0.1000000014901161")));
        assert!(!is_our_coefficient(Some("1")));
        assert!(!is_our_coefficient(None));
    }

    #[tokio::test]
    async fn speeds_up_and_restores_an_untouched_simulator() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, None);
        let applied = on_select(&h, dir.path(), U, Some(true), None)
            .await
            .expect("applied");
        assert_eq!(h.state(), (some(FLAG_VALUE), some(COEFFICIENT)));
        let record = read_record(&applied.record_path).expect("record written");
        assert_eq!(record.pid, 100);
        assert_eq!(
            record.originals,
            Originals {
                flag: None,
                coefficient: None
            }
        );

        restore(&h, &applied, SHUTDOWN_TIMEOUT).await;
        assert_eq!(h.state(), (None, None));
        assert!(!applied.record_path.exists());
    }

    #[tokio::test]
    async fn an_original_coefficient_is_put_back() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, Some("0.5"));
        let applied = on_select(&h, dir.path(), U, Some(true), None)
            .await
            .unwrap();
        assert_eq!(h.state().1, some(COEFFICIENT));
        restore(&h, &applied, SHUTDOWN_TIMEOUT).await;
        assert_eq!(h.state(), (None, some("0.5")));
    }

    #[tokio::test]
    async fn a_value_changed_mid_session_is_left_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, None);
        let applied = on_select(&h, dir.path(), U, Some(true), None)
            .await
            .unwrap();
        h.defaults
            .lock()
            .unwrap()
            .insert(COEFFICIENT_KEY.into(), "2".into());
        restore(&h, &applied, SHUTDOWN_TIMEOUT).await;
        assert_eq!(h.state(), (None, some("2")));
        assert!(!applied.record_path.exists());
    }

    #[tokio::test]
    async fn a_flag_set_by_someone_else_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(Some("Other/Flag"), None);
        assert_eq!(on_select(&h, dir.path(), U, Some(true), None).await, None);
        assert_eq!(h.state(), (some("Other/Flag"), None));
        assert!(!record_path(dir.path(), U).exists());
    }

    #[tokio::test]
    async fn a_flag_already_holding_our_value_is_kept_at_restore() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(Some(FLAG_VALUE), None);
        let applied = on_select(&h, dir.path(), U, Some(true), None)
            .await
            .unwrap();
        restore(&h, &applied, SHUTDOWN_TIMEOUT).await;
        assert_eq!(h.state(), (some(FLAG_VALUE), None));
    }

    #[tokio::test]
    async fn reselecting_with_the_option_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, Some("1"));
        let first = on_select(&h, dir.path(), U, Some(true), None).await;
        let second = on_select(&h, dir.path(), U, Some(true), first.as_ref()).await;
        assert_eq!(first, second);
        let record = read_record(&record_path(dir.path(), U)).unwrap();
        assert_eq!(
            record.originals.coefficient,
            some("1"),
            "originals not overwritten"
        );
    }

    #[tokio::test]
    async fn turning_the_option_off_undoes_this_daemons_setting() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, None);
        let applied = on_select(&h, dir.path(), U, Some(true), None).await;
        assert_eq!(
            on_select(&h, dir.path(), U, Some(false), applied.as_ref()).await,
            None
        );
        assert_eq!(h.state(), (None, None));
        // Unset keeps it.
        let applied = on_select(&h, dir.path(), U, Some(true), None).await;
        assert_eq!(
            on_select(&h, dir.path(), U, None, applied.as_ref()).await,
            applied
        );
        assert_eq!(h.state(), (some(FLAG_VALUE), some(COEFFICIENT)));
    }

    #[tokio::test]
    async fn a_session_without_the_option_and_no_records_never_touches_the_simulator() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, None);
        assert_eq!(on_select(&h, dir.path(), U, None, None).await, None);
        assert_eq!(on_select(&h, dir.path(), U, Some(false), None).await, None);
        assert_eq!(h.call_count(), 0);
    }

    #[tokio::test]
    async fn a_dead_daemons_record_is_restored_by_the_next_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = stale_record(
            dir.path(),
            Originals {
                flag: None,
                coefficient: some("1"),
            },
        );
        let h = FakeHost::new(Some(FLAG_VALUE), Some(COEFFICIENT));
        assert_eq!(on_select(&h, dir.path(), U, None, None).await, None);
        assert_eq!(h.state(), (None, some("1")));
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn a_session_with_the_option_takes_over_a_dead_daemons_originals() {
        let dir = tempfile::tempdir().unwrap();
        stale_record(
            dir.path(),
            Originals {
                flag: None,
                coefficient: None,
            },
        );
        let h = FakeHost::new(Some(FLAG_VALUE), Some(COEFFICIENT));
        let applied = on_select(&h, dir.path(), U, Some(true), None)
            .await
            .unwrap();
        let record = read_record(&applied.record_path).unwrap();
        assert_eq!(record.pid, 100, "now owned by this daemon");
        assert_eq!(
            record.originals.flag, None,
            "not the dead daemon's leftover"
        );
        restore(&h, &applied, SHUTDOWN_TIMEOUT).await;
        assert_eq!(h.state(), (None, None));
    }

    #[tokio::test]
    async fn a_live_daemons_record_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = stale_record(
            dir.path(),
            Originals {
                flag: None,
                coefficient: None,
            },
        );
        let mut h = FakeHost::new(Some(FLAG_VALUE), Some(COEFFICIENT));
        h.live_owner = true;
        assert_eq!(on_select(&h, dir.path(), U, Some(false), None).await, None);
        assert_eq!(h.state(), (some(FLAG_VALUE), some(COEFFICIENT)));
        assert!(path.exists());
    }

    #[tokio::test]
    async fn a_simulator_that_cannot_be_read_on_restore_keeps_its_record() {
        let dir = tempfile::tempdir().unwrap();
        let mut h = FakeHost::new(None, None);
        let applied = on_select(&h, dir.path(), U, Some(true), None)
            .await
            .unwrap();
        h.fail_reads = true;
        restore(&h, &applied, SHUTDOWN_TIMEOUT).await;
        assert!(applied.record_path.exists());
        assert_eq!(h.state(), (some(FLAG_VALUE), some(COEFFICIENT)));
    }

    #[tokio::test]
    async fn an_apply_that_errors_but_lands_is_still_restored() {
        let dir = tempfile::tempdir().unwrap();
        let mut h = FakeHost::new(None, None);
        h.fail_writes = true;
        let applied = on_select(&h, dir.path(), U, Some(true), None)
            .await
            .expect("kept as applied: the outcome is unknown");
        h.fail_writes = false;
        restore(&h, &applied, SHUTDOWN_TIMEOUT).await;
        assert_eq!(h.state(), (None, None));
        assert!(!applied.record_path.exists());
    }

    #[tokio::test]
    async fn a_failed_re_read_keeps_the_restore_this_daemon_owes() {
        let dir = tempfile::tempdir().unwrap();
        let mut h = FakeHost::new(None, None);
        let applied = on_select(&h, dir.path(), U, Some(true), None).await;
        h.fail_reads = true;
        assert_eq!(
            on_select(&h, dir.path(), U, Some(false), applied.as_ref()).await,
            applied
        );
    }

    #[tokio::test]
    async fn the_shutdown_restore_survives_a_busy_core_simulator() {
        // Every daemon of a --workers run shuts down at once, and each spawn
        // then takes several seconds.
        let dir = tempfile::tempdir().unwrap();
        let mut h = FakeHost::new(None, None);
        let applied = on_select(&h, dir.path(), U, Some(true), None)
            .await
            .unwrap();
        h.per_call = Duration::from_secs(4);
        restore(&h, &applied, SHUTDOWN_TIMEOUT).await;
        assert_eq!(h.state(), (None, None));
        assert!(!applied.record_path.exists());
    }

    #[tokio::test]
    async fn reapply_sets_the_flag_again_after_a_reboot() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, None);
        let applied = on_select(&h, dir.path(), U, Some(true), None)
            .await
            .unwrap();
        // A reboot clears launchd's environment; the default survives.
        h.env.lock().unwrap().clear();
        reapply(&h, &applied).await;
        assert_eq!(h.state(), (some(FLAG_VALUE), some(COEFFICIENT)));
    }

    #[tokio::test]
    async fn a_flag_lost_to_a_reboot_is_set_again_and_a_kept_one_is_only_read() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(None, None);
        let applied = on_select(&h, dir.path(), U, Some(true), None)
            .await
            .unwrap();
        let before = h.call_count();
        reapply_if_lost(&h, &applied).await;
        assert_eq!(h.call_count(), before + 1, "one read, no writes");
        h.env.lock().unwrap().clear();
        reapply_if_lost(&h, &applied).await;
        assert_eq!(h.state(), (some(FLAG_VALUE), some(COEFFICIENT)));
    }

    #[tokio::test]
    async fn restore_never_writes_a_non_number() {
        let dir = tempfile::tempdir().unwrap();
        let path = stale_record(
            dir.path(),
            Originals {
                flag: None,
                coefficient: some("1; reboot"),
            },
        );
        let h = FakeHost::new(None, Some(COEFFICIENT));
        on_select(&h, dir.path(), U, Some(false), None).await;
        assert_eq!(h.state().1, some(COEFFICIENT));
        assert!(
            !h.calls.lock().unwrap().iter().any(|c| c.contains("reboot")),
            "never passed on"
        );
        assert!(!path.exists(), "nothing else left to restore");
    }
}
