//! macOS system HTTP proxy fallback for iOS simulator network capture.
//!
//! When the mitmproxy Network Extension is unavailable (e.g. on CI runners
//! where System Extensions can't be approved), this module configures the
//! macOS system HTTP/HTTPS proxy via `networksetup` so the simulator
//! inherits the proxy setting and routes traffic through the MITM proxy.
//!
//! **Trade-off vs Network Extension**: The system proxy is global — it
//! affects all traffic on the host, not just the simulator's PID, so the
//! capture also records browsers, `trustd` OCSP fetches and every other
//! process on the Mac. That is acceptable on an isolated CI runner and not
//! on a developer machine, so the fallback is only used on CI unless the
//! user opts in (PILOT-319, see [`fallback_allowed`]).
//!
//! **One owner per Mac**: there is a single system proxy setting, so only one
//! daemon can use the fallback at a time. Ownership is recorded in
//! `~/.tapsmith/ios-system-proxy.json` under an exclusive `flock`:
//! - a second daemon is refused instead of silently re-pointing the proxy at
//!   its own port (which drained every request into one daemon);
//! - teardown only touches the setting while this daemon still owns it, so the
//!   first daemon to exit can't switch the proxy off under a survivor;
//! - a proxy the user configured themselves (Charles, a corporate proxy, …) is
//!   never overwritten;
//! - a record left by a daemon that died without cleaning up is recovered by
//!   the next daemon (at startup and on acquire), and the user's original
//!   proxy bypass list is put back.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

/// Candidate network service names, checked in order. GHA macOS runners
/// typically use "Ethernet"; developer machines typically use "Wi-Fi".
const CANDIDATE_SERVICES: &[&str] = &["Ethernet", "Wi-Fi"];

/// The loopback address the fallback points the system proxy at.
const PROXY_HOST: &str = "127.0.0.1";

/// Environment override for [`fallback_allowed`].
pub const FALLBACK_ENV: &str = "TAPSMITH_IOS_SYSTEM_PROXY_FALLBACK";

/// Proxy bypass domains set while the fallback is active, so the GHA runner's
/// own traffic to GitHub Actions infrastructure isn't routed through our MITM
/// proxy. Without this, the runner loses its heartbeat and GHA cancels the job
/// with "hosted runner lost communication with the server".
const BYPASS_DOMAINS: &[&str] = &[
    "*.github.com",
    "*.githubusercontent.com",
    "*.actions.githubusercontent.com",
    "*.blob.core.windows.net",
    "*.azure.com",
    "*.microsoft.com",
    "*.apple.com",
    "localhost",
    "127.0.0.1",
];

// ─── Policy ───

/// Whether the host-wide system-proxy fallback may be used at all.
///
/// `TAPSMITH_IOS_SYSTEM_PROXY_FALLBACK=1|true|on` forces it on,
/// `0|false|off` forces it off; otherwise it is allowed only on CI (`CI` set
/// to anything but `false`/`0`). On a developer Mac the Network Extension is
/// available, so falling back would hide a real setup failure behind a
/// capture of the developer's own browsing.
pub fn fallback_allowed(env: impl Fn(&str) -> Option<String>) -> bool {
    if let Some(v) = env(FALLBACK_ENV) {
        match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "on" | "yes" => return true,
            "0" | "false" | "off" | "no" => return false,
            _ => {}
        }
    }
    matches!(env("CI"), Some(v) if !v.is_empty() && v != "false" && v != "0")
}

/// [`fallback_allowed`] against the process environment.
pub fn fallback_allowed_from_env() -> bool {
    fallback_allowed(|k| std::env::var(k).ok())
}

// ─── networksetup parsing ───

/// One `networksetup -getwebproxy` / `-getsecurewebproxy` reading.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProxySetting {
    pub enabled: bool,
    pub server: String,
    pub port: u16,
}

impl ProxySetting {
    fn points_at(&self, port: u16) -> bool {
        self.server == PROXY_HOST && self.port == port
    }
}

/// Parse `networksetup -getwebproxy <service>` output:
/// `Enabled: Yes\nServer: 127.0.0.1\nPort: 52429\nAuthenticated Proxy Enabled: 0`.
pub fn parse_proxy_setting(stdout: &str) -> ProxySetting {
    let mut setting = ProxySetting::default();
    for line in stdout.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Enabled" => setting.enabled = value.eq_ignore_ascii_case("yes"),
            "Server" => setting.server = value.to_string(),
            "Port" => setting.port = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    setting
}

/// Parse `networksetup -getproxybypassdomains <service>` output: one domain per
/// line, or "There aren't any bypass domains set on <service>." when empty.
pub fn parse_bypass_domains(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("There aren't any"))
        .map(str::to_string)
        .collect()
}

// ─── Ownership ───

/// Contents of `~/.tapsmith/ios-system-proxy.json`: which daemon currently
/// owns the macOS system proxy, and what to restore when it lets go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerRecord {
    pub pid: u32,
    pub port: u16,
    pub service: String,
    /// The service's proxy bypass list before the fallback replaced it.
    #[serde(default)]
    pub original_bypass: Vec<String>,
}

/// Why the fallback was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Conflict {
    /// Another live Tapsmith daemon already routes the system proxy to itself.
    OtherDaemon { pid: u32, port: u16 },
    /// The service already has an HTTP(S) proxy that Tapsmith did not set.
    ForeignProxy {
        service: String,
        server: String,
        port: u16,
    },
}

impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Conflict::OtherDaemon { pid, port } => write!(
                f,
                "another Tapsmith daemon (pid {pid}) already routes the macOS system proxy to \
                 127.0.0.1:{port}. The system proxy is host-wide, so only one daemon can use \
                 this fallback at a time"
            ),
            Conflict::ForeignProxy {
                service,
                server,
                port,
            } => write!(
                f,
                "the \"{service}\" network service already has an HTTP proxy ({server}:{port}) \
                 that Tapsmith did not set, and Tapsmith will not overwrite it. If it was left \
                 behind by an earlier run, turn it off with: \
                 networksetup -setwebproxystate \"{service}\" off && \
                 networksetup -setsecurewebproxystate \"{service}\" off"
            ),
        }
    }
}

/// What [`plan_acquire`] decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcquirePlan {
    /// A record whose owner is gone (or is us from an earlier start): its
    /// setting is ours to replace, and its `original_bypass` is the list to
    /// eventually restore — the service's current list is our own.
    pub stale: Option<OwnerRecord>,
}

/// Decide whether `self_pid` may take the system proxy on `service`.
///
/// `owner_alive` reports whether the record's pid is a live Tapsmith daemon.
/// `http`/`https` are the service's current settings.
pub fn plan_acquire(
    record: Option<&OwnerRecord>,
    owner_alive: bool,
    self_pid: u32,
    service: &str,
    http: &ProxySetting,
    https: &ProxySetting,
) -> std::result::Result<AcquirePlan, Conflict> {
    if let Some(r) = record {
        if r.pid != self_pid && owner_alive {
            return Err(Conflict::OtherDaemon {
                pid: r.pid,
                port: r.port,
            });
        }
    }
    let stale = record.cloned();
    // A live setting is ours to replace only if the stale record wrote it.
    let ours = |s: &ProxySetting| {
        stale
            .as_ref()
            .is_some_and(|r| r.service == service && s.points_at(r.port))
    };
    for s in [http, https] {
        if s.enabled && !ours(s) {
            return Err(Conflict::ForeignProxy {
                service: service.to_string(),
                server: s.server.clone(),
                port: s.port,
            });
        }
    }
    Ok(AcquirePlan { stale })
}

/// The system proxy held by this daemon. Released with [`release`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemProxyLease {
    pub service: String,
    pub port: u16,
}

// ─── Host I/O ───

fn owner_dir() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .context("no home directory for ~/.tapsmith")?
        .join(".tapsmith"))
}

/// Exclusive `flock` on `<dir>/ios-system-proxy.lock`, released on drop. Every
/// read-modify-write of the owner record and of the proxy setting happens
/// under it, so two daemons can never interleave their `networksetup` calls.
struct OwnerLock {
    _file: std::fs::File,
    record_path: PathBuf,
}

impl OwnerLock {
    fn acquire(dir: &Path) -> Result<Self> {
        use std::os::unix::io::AsRawFd;
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        let lock_path = dir.join("ios-system-proxy.lock");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .with_context(|| format!("opening {}", lock_path.display()))?;
        // SAFETY: flock on a file descriptor we own for the life of `file`.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            bail!(
                "locking {}: {}",
                lock_path.display(),
                std::io::Error::last_os_error()
            );
        }
        Ok(Self {
            _file: file,
            record_path: dir.join("ios-system-proxy.json"),
        })
    }

    fn read(&self) -> Option<OwnerRecord> {
        let mut text = String::new();
        std::fs::File::open(&self.record_path)
            .ok()?
            .read_to_string(&mut text)
            .ok()?;
        match serde_json::from_str(&text) {
            Ok(r) => Some(r),
            Err(e) => {
                warn!(path = %self.record_path.display(), "Ignoring unreadable system-proxy owner record: {e}");
                None
            }
        }
    }

    fn write(&self, record: &OwnerRecord) -> Result<()> {
        let mut file = std::fs::File::create(&self.record_path)
            .with_context(|| format!("writing {}", self.record_path.display()))?;
        file.write_all(serde_json::to_string_pretty(record)?.as_bytes())?;
        Ok(())
    }

    fn clear(&self) {
        let _ = std::fs::remove_file(&self.record_path);
    }
}

/// Whether `pid` is a live Tapsmith daemon (not just any process that reused
/// the pid after the owner died).
fn is_live_daemon(pid: u32) -> bool {
    let Ok(pid_i) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks for existence/permission.
    let alive = unsafe { libc::kill(pid_i, 0) } == 0
        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    if !alive {
        return false;
    }
    Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("tapsmith"))
        .unwrap_or(false)
}

fn networksetup(args: &[&str]) -> Result<String> {
    let output = Command::new("/usr/sbin/networksetup")
        .args(args)
        .output()
        .with_context(|| format!("running networksetup {}", args.join(" ")))?;
    if !output.status.success() {
        bail!(
            "networksetup {} failed with {}: {}",
            args.join(" "),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn read_setting(flag: &str, service: &str) -> Result<ProxySetting> {
    Ok(parse_proxy_setting(&networksetup(&[flag, service])?))
}

/// Detect the active macOS network service (the first one with an IP address).
fn resolve_active_service() -> Result<String> {
    for &service in CANDIDATE_SERVICES {
        if service_has_ip(service) {
            return Ok(service.to_string());
        }
    }

    // Fallback: enumerate all services and pick the first with an IP.
    let stdout = networksetup(&["-listallnetworkservices"])?;
    for line in stdout.lines() {
        let name = line.trim().trim_start_matches('*').trim();
        if name.is_empty() || name.contains("denotes") {
            continue;
        }
        if CANDIDATE_SERVICES.contains(&name) {
            continue; // already tried
        }
        if service_has_ip(name) {
            return Ok(name.to_string());
        }
    }

    bail!(
        "No active macOS network service found. Checked: {CANDIDATE_SERVICES:?} \
         and all services from `networksetup -listallnetworkservices`. \
         The iOS system proxy fallback requires an active network connection."
    )
}

/// Whether a network service has a non-empty IP address.
fn service_has_ip(service: &str) -> bool {
    let Ok(stdout) = networksetup(&["-getinfo", service]) else {
        return false;
    };
    stdout.lines().any(|line| {
        line.strip_prefix("IP address:")
            .map(str::trim)
            .is_some_and(|ip| !ip.is_empty() && ip != "none")
    })
}

fn restore_bypass(service: &str, original: &[String]) {
    let mut args = vec!["-setproxybypassdomains", service];
    if original.is_empty() {
        // networksetup's spelling for "clear the list".
        args.push("Empty");
    } else {
        args.extend(original.iter().map(String::as_str));
    }
    if let Err(e) = networksetup(&args) {
        warn!(service, "Failed to restore proxy bypass domains: {e}");
    }
}

/// Turn off whatever `record` wrote, but only the parts that still point at
/// its port (the user may have configured their own proxy since), and put the
/// original bypass list back.
fn undo(record: &OwnerRecord) {
    let service = record.service.as_str();
    for (get, set) in [
        ("-getwebproxy", "-setwebproxystate"),
        ("-getsecurewebproxy", "-setsecurewebproxystate"),
    ] {
        match read_setting(get, service) {
            Ok(s) if s.points_at(record.port) => {
                if let Err(e) = networksetup(&[set, service, "off"]) {
                    warn!(service, "Failed to disable system proxy ({set}): {e}");
                }
            }
            Ok(s) => debug!(
                service,
                server = %s.server,
                port = s.port,
                "System proxy no longer points at 127.0.0.1:{}; leaving it", record.port
            ),
            Err(e) => warn!(service, "Failed to read system proxy ({get}): {e}"),
        }
    }
    restore_bypass(service, &record.original_bypass);
}

fn acquire_blocking(dir: &Path, port: u16) -> Result<SystemProxyLease> {
    let lock = OwnerLock::acquire(dir)?;
    let self_pid = std::process::id();
    let record = lock.read();
    let owner_alive = record
        .as_ref()
        .is_some_and(|r| r.pid != self_pid && is_live_daemon(r.pid));

    let service = resolve_active_service()?;
    // A stale record on a service that is no longer the active one: undo it
    // there first, so the check below only sees this service's own setting.
    if let Some(r) = record
        .as_ref()
        .filter(|r| !owner_alive && r.service != service)
    {
        info!(pid = r.pid, service = %r.service, "Recovering system proxy left by an exited daemon");
        undo(r);
    }
    let record = record.filter(|r| owner_alive || r.service == service);

    let http = read_setting("-getwebproxy", &service)?;
    let https = read_setting("-getsecurewebproxy", &service)?;
    let plan = plan_acquire(
        record.as_ref(),
        owner_alive,
        self_pid,
        &service,
        &http,
        &https,
    )
    .map_err(|c| anyhow::anyhow!("{c}"))?;

    let original_bypass = match &plan.stale {
        Some(r) => r.original_bypass.clone(),
        None => parse_bypass_domains(&networksetup(&["-getproxybypassdomains", &service])?),
    };
    // Record ownership BEFORE touching the setting: if we die between the two,
    // the next daemon finds the record and undoes a half-applied setting,
    // instead of mistaking it for a proxy the user configured.
    let new_record = OwnerRecord {
        pid: self_pid,
        port,
        service: service.clone(),
        original_bypass,
    };
    lock.write(&new_record)?;

    let port_str = port.to_string();
    let applied = networksetup(&["-setwebproxy", &service, PROXY_HOST, &port_str])
        .and_then(|_| networksetup(&["-setsecurewebproxy", &service, PROXY_HOST, &port_str]));
    if let Err(e) = applied {
        undo(&new_record);
        lock.clear();
        return Err(e);
    }
    let mut bypass = vec!["-setproxybypassdomains", service.as_str()];
    bypass.extend_from_slice(BYPASS_DOMAINS);
    if let Err(e) = networksetup(&bypass) {
        warn!("{e} — CI runner traffic may be proxied");
    }

    info!(
        service = %service,
        port,
        "macOS system proxy set to 127.0.0.1:{port} (iOS simulator fallback)"
    );
    Ok(SystemProxyLease { service, port })
}

fn release_blocking(dir: &Path, lease: &SystemProxyLease) {
    let lock = match OwnerLock::acquire(dir) {
        Ok(l) => l,
        Err(e) => {
            warn!("Not resetting macOS system proxy: {e}");
            return;
        }
    };
    match lock.read() {
        Some(r) if r.pid == std::process::id() && r.port == lease.port => {
            undo(&r);
            lock.clear();
            info!(service = %r.service, "macOS system proxy disabled");
        }
        Some(r) => warn!(
            owner = r.pid,
            "macOS system proxy is now owned by another daemon; leaving it"
        ),
        None => warn!("macOS system-proxy owner record is missing; leaving the setting alone"),
    }
}

fn recover_blocking(dir: &Path) {
    if !dir.join("ios-system-proxy.json").exists() {
        return;
    }
    let Ok(lock) = OwnerLock::acquire(dir) else {
        return;
    };
    if let Some(r) = lock.read() {
        if r.pid != std::process::id() && !is_live_daemon(r.pid) {
            info!(pid = r.pid, service = %r.service, port = r.port, "Recovering macOS system proxy left by an exited daemon");
            undo(&r);
            lock.clear();
        }
    }
}

// ─── Public API ───

/// Point the macOS system HTTP and HTTPS proxy at `127.0.0.1:<port>` on the
/// active network service, or refuse (see the module docs for when).
pub async fn acquire(port: u16) -> Result<SystemProxyLease> {
    let dir = owner_dir()?;
    tokio::task::spawn_blocking(move || acquire_blocking(&dir, port))
        .await
        .context("system proxy task panicked")?
}

/// Undo [`acquire`] if this daemon still owns the system proxy.
pub async fn release(lease: SystemProxyLease) {
    let Ok(dir) = owner_dir() else {
        return;
    };
    let _ = tokio::task::spawn_blocking(move || release_blocking(&dir, &lease)).await;
}

/// Whether the system proxy still points at this lease's port. A cheap check
/// for the per-test reuse path: something (the user, another tool) may have
/// changed it since, in which case capture quietly records nothing.
pub async fn still_applied(lease: &SystemProxyLease) -> bool {
    let lease = lease.clone();
    tokio::task::spawn_blocking(move || {
        read_setting("-getwebproxy", &lease.service)
            .is_ok_and(|s| s.enabled && s.points_at(lease.port))
    })
    .await
    .unwrap_or(false)
}

/// Undo a system proxy left behind by a daemon that exited without cleaning
/// up (SIGKILL, crash). Called at daemon startup; a no-op when there is no
/// owner record.
pub async fn recover_stale() {
    let Ok(dir) = owner_dir() else {
        return;
    };
    let _ = tokio::task::spawn_blocking(move || recover_blocking(&dir)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setting(enabled: bool, server: &str, port: u16) -> ProxySetting {
        ProxySetting {
            enabled,
            server: server.into(),
            port,
        }
    }

    fn record(pid: u32, port: u16, service: &str) -> OwnerRecord {
        OwnerRecord {
            pid,
            port,
            service: service.into(),
            original_bypass: vec!["*.local".into()],
        }
    }

    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| {
            vars.iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn parses_enabled_proxy() {
        let s = parse_proxy_setting(
            "Enabled: Yes\nServer: 127.0.0.1\nPort: 52429\nAuthenticated Proxy Enabled: 0\n",
        );
        assert_eq!(s, setting(true, "127.0.0.1", 52429));
    }

    #[test]
    fn parses_disabled_empty_proxy() {
        let s =
            parse_proxy_setting("Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n");
        assert_eq!(s, setting(false, "", 0));
    }

    #[test]
    fn parses_bypass_domains() {
        assert_eq!(
            parse_bypass_domains("*.local\n169.254/16\n"),
            vec!["*.local", "169.254/16"]
        );
        assert!(parse_bypass_domains("There aren't any bypass domains set on Wi-Fi.\n").is_empty());
    }

    #[test]
    fn fallback_is_ci_only_by_default() {
        assert!(!fallback_allowed(env(&[])));
        assert!(fallback_allowed(env(&[("CI", "true")])));
        assert!(fallback_allowed(env(&[("CI", "1")])));
        assert!(!fallback_allowed(env(&[("CI", "false")])));
        assert!(!fallback_allowed(env(&[("CI", "")])));
    }

    #[test]
    fn fallback_env_overrides_ci() {
        assert!(fallback_allowed(env(&[(FALLBACK_ENV, "1")])));
        assert!(fallback_allowed(env(&[(FALLBACK_ENV, "on")])));
        assert!(!fallback_allowed(env(&[
            ("CI", "true"),
            (FALLBACK_ENV, "0")
        ])));
        assert!(!fallback_allowed(env(&[
            ("CI", "true"),
            (FALLBACK_ENV, "off")
        ])));
        // An unrecognised value doesn't override.
        assert!(fallback_allowed(env(&[
            ("CI", "true"),
            (FALLBACK_ENV, "maybe")
        ])));
    }

    #[test]
    fn fresh_acquire_with_proxy_off() {
        let off = setting(false, "127.0.0.1", 52429);
        assert_eq!(
            plan_acquire(None, false, 10, "Wi-Fi", &off, &off),
            Ok(AcquirePlan { stale: None })
        );
    }

    #[test]
    fn refuses_when_another_live_daemon_owns_it() {
        let on = setting(true, "127.0.0.1", 5000);
        assert_eq!(
            plan_acquire(
                Some(&record(20, 5000, "Wi-Fi")),
                true,
                10,
                "Wi-Fi",
                &on,
                &on
            ),
            Err(Conflict::OtherDaemon {
                pid: 20,
                port: 5000
            })
        );
    }

    #[test]
    fn takes_over_from_a_dead_owner_and_keeps_its_original_bypass() {
        let on = setting(true, "127.0.0.1", 5000);
        let stale = record(20, 5000, "Wi-Fi");
        let plan = plan_acquire(Some(&stale), false, 10, "Wi-Fi", &on, &on).unwrap();
        assert_eq!(plan.stale, Some(stale));
    }

    #[test]
    fn refuses_to_overwrite_a_user_proxy() {
        let charles = setting(true, "127.0.0.1", 8888);
        let off = setting(false, "", 0);
        assert_eq!(
            plan_acquire(None, false, 10, "Wi-Fi", &charles, &off),
            Err(Conflict::ForeignProxy {
                service: "Wi-Fi".into(),
                server: "127.0.0.1".into(),
                port: 8888
            })
        );
        let corp = setting(true, "proxy.corp", 3128);
        assert!(matches!(
            plan_acquire(None, false, 10, "Wi-Fi", &off, &corp),
            Err(Conflict::ForeignProxy { .. })
        ));
    }

    #[test]
    fn stale_record_does_not_license_a_different_proxy() {
        // The dead daemon used 5000; the user has since set their own proxy.
        let user = setting(true, "127.0.0.1", 8888);
        let off = setting(false, "", 0);
        assert!(matches!(
            plan_acquire(
                Some(&record(20, 5000, "Wi-Fi")),
                false,
                10,
                "Wi-Fi",
                &user,
                &off
            ),
            Err(Conflict::ForeignProxy { port: 8888, .. })
        ));
    }

    #[test]
    fn own_record_is_reclaimable() {
        let on = setting(true, "127.0.0.1", 5000);
        let mine = record(10, 5000, "Wi-Fi");
        assert_eq!(
            plan_acquire(Some(&mine), false, 10, "Wi-Fi", &on, &on)
                .unwrap()
                .stale,
            Some(mine)
        );
    }

    #[test]
    fn owner_lock_round_trips_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let lock = OwnerLock::acquire(dir.path()).unwrap();
        assert_eq!(lock.read(), None);
        let r = record(10, 5000, "Wi-Fi");
        lock.write(&r).unwrap();
        assert_eq!(lock.read(), Some(r));
        lock.clear();
        assert_eq!(lock.read(), None);
    }

    #[test]
    fn owner_lock_serialises_holders() {
        let dir = tempfile::tempdir().unwrap();
        let first = OwnerLock::acquire(dir.path()).unwrap();
        let path = dir.path().to_path_buf();
        let (tx, rx) = std::sync::mpsc::channel();
        let t = std::thread::spawn(move || {
            let _second = OwnerLock::acquire(&path).unwrap();
            tx.send(()).unwrap();
        });
        // flock is per open file description, so the second open blocks even
        // within one process.
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(200))
            .is_err());
        drop(first);
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        t.join().unwrap();
    }

    #[test]
    fn dead_pid_is_not_a_live_daemon() {
        // pid_max on macOS is 99999; this one can't exist.
        assert!(!is_live_daemon(999_999));
    }
}
