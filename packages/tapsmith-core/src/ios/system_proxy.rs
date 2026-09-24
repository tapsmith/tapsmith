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
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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
    env("CI").is_some_and(|v| {
        let v = v.trim().to_ascii_lowercase();
        !v.is_empty() && v != "false" && v != "0"
    })
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
    /// The owner's process start time (`ps -o lstart=`), so a pid reused by
    /// another process after the owner died is not mistaken for it. `None` in
    /// records written before it existed; liveness then falls back to the
    /// process name.
    #[serde(default)]
    pub started: Option<String>,
    /// The service's proxy bypass list before the fallback replaced it.
    ///
    /// The HTTP/HTTPS server and port are deliberately NOT saved and put back:
    /// an enabled proxy is refused as the user's, so any value there was
    /// disabled, and `networksetup` can only write a server by also enabling
    /// it — a restore would briefly switch on a proxy the user had turned off,
    /// and leave it on if the follow-up "off" failed or the daemon died in
    /// between. Losing a disabled server/port is the lesser harm.
    #[serde(default)]
    pub original_bypass: Vec<String>,
    /// The bypass list as macOS reported it right after the fallback set it
    /// (networksetup may normalise entries), so "still ours" is judged against
    /// what the system actually holds. `None` in older records.
    #[serde(default)]
    pub applied_bypass: Option<Vec<String>>,
    /// Identifies the acquire that wrote this record (see
    /// [`SystemProxyLease::id`]). `None` in older records.
    #[serde(default)]
    pub lease_id: Option<String>,
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
    /// Matches [`OwnerRecord::lease_id`]: a release only undoes the lease it
    /// was issued for, never a newer one of this daemon that reused the port.
    pub id: String,
}

/// A lease not yet handed to its long-term owner. If it is dropped instead —
/// the capture-start future was cancelled (RPC deadline, client gone) after
/// the proxy was set but before the capture was published — the proxy is
/// released rather than left pointing the Mac at a listener nobody holds.
pub struct PendingLease {
    lease: Option<SystemProxyLease>,
    on_abandon: fn(SystemProxyLease),
}

impl PendingLease {
    pub fn new(lease: SystemProxyLease) -> Self {
        Self {
            lease: Some(lease),
            on_abandon: release_abandoned,
        }
    }

    /// Hand the lease over; the guard no longer releases it.
    pub fn disarm(mut self) -> SystemProxyLease {
        self.lease.take().expect("PendingLease disarmed twice")
    }
}

impl Drop for PendingLease {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            warn!(
                port = lease.port,
                "Capture start was abandoned after setting the system proxy; releasing it"
            );
            (self.on_abandon)(lease);
        }
    }
}

fn release_abandoned(lease: SystemProxyLease) {
    let Ok(dir) = owner_dir() else {
        return;
    };
    // Blocking work, and Drop may run on an async worker thread.
    std::thread::spawn(move || release_blocking(&RealHost, &dir, &lease));
}

// ─── Host I/O ───

/// How long one `networksetup` / `ps` call may take. configd has been seen
/// wedging for minutes on loaded CI runners; every call here runs under the
/// owner lock (and the daemon's capture lock), so an unbounded call would hang
/// every daemon's capture start and shutdown behind it.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

/// How long to wait for another daemon's owner lock. A healthy holder's
/// acquire (about ten `networksetup` calls, well under a second each) is
/// always waited out; a holder wedged in configd is not, and the waiter gives
/// up with a clear error inside the SDK's 60 s capture-start RPC deadline
/// rather than letting that deadline expire first.
const LOCK_TIMEOUT: Duration = Duration::from_secs(30);

/// The host operations the ownership logic needs, injectable for tests.
trait Host {
    /// Run `/usr/sbin/networksetup` with `args`; stdout on success.
    fn networksetup(&self, args: &[&str]) -> Result<String>;
    /// Whether the daemon that wrote `record` is still running — the same
    /// process, not one that reused its pid.
    fn is_live_owner(&self, record: &OwnerRecord) -> bool;
    fn self_pid(&self) -> u32;
    /// This process's start time, as recorded in [`OwnerRecord::started`].
    fn self_started(&self) -> Option<String>;
}

/// `ps -o lstart=` for `pid`: a start time that tells two processes sharing a
/// pid apart.
fn process_started(pid: u32) -> Option<String> {
    let out = run_with_timeout("/bin/ps", &["-p", &pid.to_string(), "-o", "lstart="]).ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

struct RealHost;

impl Host for RealHost {
    fn networksetup(&self, args: &[&str]) -> Result<String> {
        let output = run_with_timeout("/usr/sbin/networksetup", args)?;
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        // networksetup reports errors as "** Error: …" on stdout; it exits
        // non-zero for the ones seen so far, but a set that "succeeds" with
        // that text must not be mistaken for an applied proxy.
        if !output.status.success() || stdout.trim_start().starts_with("** Error") {
            bail!(
                "networksetup {} failed with {}: {} {}",
                args.join(" "),
                output.status,
                stdout.trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(stdout)
    }

    fn is_live_owner(&self, record: &OwnerRecord) -> bool {
        let pid = record.pid;
        let Ok(pid_i) = i32::try_from(pid) else {
            return false;
        };
        // SAFETY: signal 0 only checks for existence/permission.
        let alive = unsafe { libc::kill(pid_i, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if !alive {
            return false;
        }
        match &record.started {
            // Exact start-time match: independent of what the daemon binary is
            // called (TAPSMITH_DAEMON_BIN can point anywhere), and a reused
            // pid always has a later start time.
            Some(started) => match process_started(pid) {
                Some(now) => &now == started,
                // The process exists; if `ps` itself fails, assume it is the
                // owner rather than tearing down a live daemon's proxy.
                None => true,
            },
            // Records from before `started` existed.
            None => match run_with_timeout("/bin/ps", &["-p", &pid.to_string(), "-o", "comm="]) {
                Ok(o) => String::from_utf8_lossy(&o.stdout).contains("tapsmith"),
                Err(_) => true,
            },
        }
    }

    fn self_pid(&self) -> u32 {
        std::process::id()
    }

    fn self_started(&self) -> Option<String> {
        process_started(std::process::id())
    }
}

/// `Command::output()` with a deadline: the child is killed if it overruns.
fn run_with_timeout(program: &str, args: &[&str]) -> Result<std::process::Output> {
    run_with_deadline(program, args, COMMAND_TIMEOUT)
}

fn run_with_deadline(
    program: &str,
    args: &[&str],
    limit: Duration,
) -> Result<std::process::Output> {
    let mut child = Command::new(program)
        .args(args)
        // Fixed locale and zone: `ps -o lstart=` prints local time in the
        // caller's locale, and the owner record's start time is compared
        // across daemons launched from different environments.
        .env("TZ", "UTC")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("running {program} {}", args.join(" ")))?;
    let deadline = Instant::now() + limit;
    loop {
        if child.try_wait()?.is_some() {
            // Output is a few lines, well inside the pipe buffer, so the child
            // never blocks writing before it exits.
            return child.wait_with_output().map_err(Into::into);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "{program} {} did not finish within {}ms",
                args.join(" "),
                limit.as_millis()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

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
        let deadline = Instant::now() + LOCK_TIMEOUT;
        loop {
            // SAFETY: flock on a file descriptor we own for the life of `file`.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                break;
            }
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::EWOULDBLOCK) {
                bail!("locking {}: {err}", lock_path.display());
            }
            if Instant::now() >= deadline {
                bail!(
                    "timed out after {}s waiting for another Tapsmith daemon to release {}",
                    LOCK_TIMEOUT.as_secs(),
                    lock_path.display()
                );
            }
            std::thread::sleep(Duration::from_millis(50));
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

    /// Written to a temp file and renamed into place, so a daemon killed
    /// mid-write leaves the previous record (or none), never a truncated one
    /// that reads as "no owner" while the proxy points at a dead port.
    fn write(&self, record: &OwnerRecord) -> Result<()> {
        let tmp = self.record_path.with_extension("json.tmp");
        let mut file =
            std::fs::File::create(&tmp).with_context(|| format!("writing {}", tmp.display()))?;
        file.write_all(serde_json::to_string_pretty(record)?.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&tmp, &self.record_path)
            .with_context(|| format!("writing {}", self.record_path.display()))?;
        Ok(())
    }

    fn clear(&self) {
        let _ = std::fs::remove_file(&self.record_path);
    }
}

fn read_setting(h: &dyn Host, flag: &str, service: &str) -> Result<ProxySetting> {
    Ok(parse_proxy_setting(&h.networksetup(&[flag, service])?))
}

/// Detect the active macOS network service (the first one with an IP address).
fn resolve_active_service(h: &dyn Host) -> Result<String> {
    for &service in CANDIDATE_SERVICES {
        if service_has_ip(h, service) {
            return Ok(service.to_string());
        }
    }

    // Fallback: enumerate all services and pick the first with an IP.
    let stdout = h.networksetup(&["-listallnetworkservices"])?;
    for line in stdout.lines() {
        let name = line.trim().trim_start_matches('*').trim();
        if name.is_empty() || name.contains("denotes") {
            continue;
        }
        if CANDIDATE_SERVICES.contains(&name) {
            continue; // already tried
        }
        if service_has_ip(h, name) {
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
fn service_has_ip(h: &dyn Host, service: &str) -> bool {
    let Ok(stdout) = h.networksetup(&["-getinfo", service]) else {
        return false;
    };
    stdout.lines().any(|line| {
        line.strip_prefix("IP address:")
            .map(str::trim)
            .is_some_and(|ip| !ip.is_empty() && ip != "none")
    })
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

/// Put `original` back as the bypass list — but only while the list is still
/// the one the fallback set (`applied`: as macOS reported it right after
/// setting, or the literal list for older records). If the user (or another
/// tool) has changed it since, theirs is newer than our snapshot and stays.
/// Whether `current` is still the bypass list a fallback applied: exactly its
/// recorded read-back, or — with no read-back (it failed, or an older record)
/// — a list made only of our entries, since macOS normalising the list can
/// drop entries but not invent the user's. (A user list that happens to be
/// such a subset was also the snapshot, so "restoring" it changes nothing.)
fn bypass_still_ours(current: &[String], applied: Option<&[String]>) -> bool {
    match applied {
        Some(a) => sorted(current.to_vec()) == sorted(a.to_vec()),
        None => current.iter().all(|d| BYPASS_DOMAINS.contains(&d.as_str())),
    }
}

fn restore_bypass(h: &dyn Host, service: &str, original: &[String], applied: Option<&[String]>) {
    match h.networksetup(&["-getproxybypassdomains", service]) {
        Ok(out) => {
            if !bypass_still_ours(&parse_bypass_domains(&out), applied) {
                debug!(
                    service,
                    "Proxy bypass list changed since the fallback set it; leaving it"
                );
                return;
            }
        }
        Err(e) => {
            warn!(service, "Failed to read proxy bypass domains: {e}");
            return;
        }
    }
    let mut args = vec!["-setproxybypassdomains", service];
    if original.is_empty() {
        // networksetup's spelling for "clear the list".
        args.push("Empty");
    } else {
        args.extend(original.iter().map(String::as_str));
    }
    if let Err(e) = h.networksetup(&args) {
        warn!(service, "Failed to restore proxy bypass domains: {e}");
    }
}

/// Turn off the HTTP and HTTPS proxy on `service`, but only the parts that
/// still point at `127.0.0.1:<port>` (the user may have configured their own
/// proxy since). The server/port fields are left as they are (see
/// `OwnerRecord::original_bypass` for why they are not restored).
fn disable_if_ours(h: &dyn Host, service: &str, port: u16) {
    for (get, set) in [
        ("-getwebproxy", "-setwebproxystate"),
        ("-getsecurewebproxy", "-setsecurewebproxystate"),
    ] {
        match read_setting(h, get, service) {
            Ok(s) if s.points_at(port) => {
                if let Err(e) = h.networksetup(&[set, service, "off"]) {
                    warn!(service, "Failed to disable system proxy ({set}): {e}");
                }
            }
            Ok(s) => debug!(
                service,
                server = %s.server,
                port = s.port,
                "System proxy no longer points at 127.0.0.1:{port}; leaving it"
            ),
            Err(e) => warn!(service, "Failed to read system proxy ({get}): {e}"),
        }
    }
}

/// Turn off whatever `record` wrote and put the user's bypass list back.
fn undo(h: &dyn Host, record: &OwnerRecord) {
    disable_if_ours(h, &record.service, record.port);
    restore_bypass(
        h,
        &record.service,
        &record.original_bypass,
        record.applied_bypass.as_deref(),
    );
}

fn acquire_blocking(h: &dyn Host, dir: &Path, port: u16) -> Result<SystemProxyLease> {
    let lock = OwnerLock::acquire(dir)?;
    let self_pid = h.self_pid();
    let mut record = lock.read();
    let owner_alive = record
        .as_ref()
        .is_some_and(|r| r.pid != self_pid && h.is_live_owner(r));

    let service = resolve_active_service(h)?;
    // A stale record on a service that is no longer the active one: undo it
    // there first, so the check below only sees this service's own setting.
    // Cleared at once, so a later failure in this acquire can't leave it on
    // disk to be undone again over whatever the user has set since.
    if let Some(r) = record
        .as_ref()
        .filter(|r| !owner_alive && r.service != service)
    {
        info!(pid = r.pid, service = %r.service, "Recovering system proxy left by an exited daemon");
        undo(h, r);
        lock.clear();
        record = None;
    }

    let http = read_setting(h, "-getwebproxy", &service)?;
    let https = read_setting(h, "-getsecurewebproxy", &service)?;
    let plan = plan_acquire(
        record.as_ref(),
        owner_alive,
        self_pid,
        &service,
        &http,
        &https,
    )
    .map_err(|c| anyhow::anyhow!("{c}"))?;

    // On a takeover, if the service still holds the dead owner's bypass list,
    // its snapshot of the user's list is the one to keep — and its read-back
    // of what it applied is what "still ours" must be judged against until we
    // apply our own (a failed takeover below rolls back against it). If the
    // user has changed the list since that daemon died, theirs is the newer
    // original.
    let current_bypass =
        parse_bypass_domains(&h.networksetup(&["-getproxybypassdomains", &service])?);
    let (original_bypass, applied_bypass) = match &plan.stale {
        Some(r) if bypass_still_ours(&current_bypass, r.applied_bypass.as_deref()) => {
            (r.original_bypass.clone(), r.applied_bypass.clone())
        }
        _ => (current_bypass, None),
    };
    // Record ownership BEFORE touching the setting: if we die between the two,
    // the next daemon finds the record and undoes a half-applied setting,
    // instead of mistaking it for a proxy the user configured.
    let mut new_record = OwnerRecord {
        pid: self_pid,
        port,
        service: service.clone(),
        started: h.self_started(),
        original_bypass,
        applied_bypass,
        lease_id: Some(uuid::Uuid::new_v4().to_string()),
    };
    lock.write(&new_record)?;

    let port_str = port.to_string();
    let applied = h
        .networksetup(&["-setwebproxy", &service, PROXY_HOST, &port_str])
        .and_then(|_| h.networksetup(&["-setsecurewebproxy", &service, PROXY_HOST, &port_str]));
    if let Err(e) = applied {
        // Undo both what we half-applied and, when taking over, whatever the
        // dead owner left: the record naming its port is about to go.
        if let Some(stale) = &plan.stale {
            disable_if_ours(h, &service, stale.port);
        }
        undo(h, &new_record);
        lock.clear();
        return Err(e);
    }
    let mut bypass = vec!["-setproxybypassdomains", service.as_str()];
    bypass.extend_from_slice(BYPASS_DOMAINS);
    if let Err(e) = h.networksetup(&bypass) {
        warn!("{e} — CI runner traffic may be proxied");
    } else if let Ok(out) = h.networksetup(&["-getproxybypassdomains", &service]) {
        // Remember the list as macOS holds it, so release can tell it is
        // still ours even if networksetup normalised any entry.
        new_record.applied_bypass = Some(parse_bypass_domains(&out));
        if let Err(e) = lock.write(&new_record) {
            warn!("Failed to update the system-proxy owner record: {e}");
        }
    }

    info!(
        service = %service,
        port,
        "macOS system proxy set to 127.0.0.1:{port} (iOS simulator fallback)"
    );
    Ok(SystemProxyLease {
        service,
        port,
        id: new_record.lease_id.clone().unwrap_or_default(),
    })
}

fn release_blocking(h: &dyn Host, dir: &Path, lease: &SystemProxyLease) {
    let lock = match OwnerLock::acquire(dir) {
        Ok(l) => Some(l),
        Err(e) => {
            warn!("macOS system-proxy owner lock unavailable ({e}); releasing without it");
            None
        }
    };
    match lock.as_ref().and_then(OwnerLock::read) {
        Some(r)
            if r.pid == h.self_pid()
                && r.port == lease.port
                && r.lease_id.as_deref().is_none_or(|id| id == lease.id) =>
        {
            undo(h, &r);
            if let Some(lock) = &lock {
                lock.clear();
            }
            info!(service = %r.service, "macOS system proxy disabled");
        }
        Some(r) => warn!(
            owner = r.pid,
            "macOS system proxy is now owned by another daemon or a newer capture; leaving it"
        ),
        // The record is gone or unreadable (deleted, truncated), or the lock
        // is: nobody else claims the setting, so still turn off what points at
        // our own port rather than leave the Mac proxied to a dead listener.
        // The user's saved settings are lost with the record.
        None => {
            warn!(
                service = %lease.service,
                "macOS system-proxy owner record is missing; disabling the proxy on our own port"
            );
            disable_if_ours(h, &lease.service, lease.port);
        }
    }
}

fn recover_blocking(h: &dyn Host, dir: &Path) {
    if !dir.join("ios-system-proxy.json").exists() {
        return;
    }
    let Ok(lock) = OwnerLock::acquire(dir) else {
        return;
    };
    if let Some(r) = lock.read() {
        // A record with our own pid but another start time is a dead daemon
        // whose pid we happen to have been given.
        let ours = r.pid == h.self_pid() && (r.started.is_none() || r.started == h.self_started());
        if !ours && !h.is_live_owner(&r) {
            info!(pid = r.pid, service = %r.service, port = r.port, "Recovering macOS system proxy left by an exited daemon");
            undo(h, &r);
            lock.clear();
        }
    }
}

/// `Some(false)` only when a read succeeded and shows the proxy changed;
/// `None` when it could not be read (a slow configd is not a changed proxy).
fn still_applied_blocking(h: &dyn Host, lease: &SystemProxyLease) -> Option<bool> {
    let mut applied = true;
    for flag in ["-getwebproxy", "-getsecurewebproxy"] {
        let s = read_setting(h, flag, &lease.service).ok()?;
        applied &= s.enabled && s.points_at(lease.port);
    }
    Some(applied)
}

// ─── Capture policy (used by start_network_capture) ───

/// How long a Network Extension failure is trusted before the redirector is
/// tried again. Every attempt on a broken extension waits out its 10 s
/// control-channel timeout, so retrying on every test would add 10 s per
/// test; never retrying would keep capture off after a one-off failure (two
/// daemons launching the redirector at once) or after the user fixes the
/// extension mid-session (UI mode). One retry a minute bounds both.
pub const NE_RETRY_AFTER: Duration = Duration::from_secs(60);

/// The daemon's memory of its last Network Extension failure.
#[derive(Debug, Clone)]
pub struct NeFailure {
    pub message: String,
    pub at: Instant,
}

/// The cached failure to act on instead of launching the redirector, if any.
/// Multi-device callers (`require_isolation`) always retry: for them the
/// failure is usually the transient launch race, and there is no fallback to
/// skip ahead to.
pub fn cached_ne_failure(
    cache: Option<&NeFailure>,
    require_isolation: bool,
    now: Instant,
) -> Option<String> {
    if require_isolation {
        return None;
    }
    cache
        .filter(|f| now.saturating_duration_since(f.at) < NE_RETRY_AFTER)
        .map(|f| f.message.clone())
}

/// What to do once the Network Extension redirector is unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackDecision {
    /// A multi-device group: the host-wide fallback can't attribute traffic.
    RefuseIsolation,
    /// Not on CI and not opted in (see [`fallback_allowed`]).
    RefuseLocal,
    UseSystemProxy,
}

pub fn fallback_decision(require_isolation: bool, fallback_allowed: bool) -> FallbackDecision {
    if require_isolation {
        FallbackDecision::RefuseIsolation
    } else if !fallback_allowed {
        FallbackDecision::RefuseLocal
    } else {
        FallbackDecision::UseSystemProxy
    }
}

// ─── Public API ───

/// Point the macOS system HTTP and HTTPS proxy at `127.0.0.1:<port>` on the
/// active network service, or refuse (see the module docs for when).
///
/// Cancellation-safe: the work runs on a blocking thread that outlives this
/// future, so if the caller is dropped mid-acquire (the client's RPC deadline
/// passed, or it disconnected) the thread still finishes — and then releases
/// the proxy it just set instead of leaving the Mac pointed at a listener
/// nobody holds.
pub async fn acquire(port: u16) -> Result<SystemProxyLease> {
    let dir = owner_dir()?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::task::spawn_blocking(move || {
        let result = acquire_blocking(&RealHost, &dir, port);
        if let Err(Ok(orphaned)) = tx.send(result) {
            warn!(
                port = orphaned.port,
                "Capture start was cancelled while the system proxy was being set; releasing it"
            );
            release_blocking(&RealHost, &dir, &orphaned);
        }
    });
    rx.await.context("system proxy task panicked")?
}

/// Undo [`acquire`] if this daemon still owns the system proxy.
pub async fn release(lease: SystemProxyLease) {
    let Ok(dir) = owner_dir() else {
        return;
    };
    let _ = tokio::task::spawn_blocking(move || release_blocking(&RealHost, &dir, &lease)).await;
}

/// Whether the system HTTP and HTTPS proxies still point at this lease's port.
/// A cheap check for the per-test reuse path: something (the user, another
/// tool) may have changed either since, in which case capture quietly records
/// nothing.
/// `None` when the setting could not be read.
pub async fn still_applied(lease: &SystemProxyLease) -> Option<bool> {
    let lease = lease.clone();
    tokio::task::spawn_blocking(move || still_applied_blocking(&RealHost, &lease))
        .await
        .ok()
        .flatten()
}

/// Undo a system proxy left behind by a daemon that exited without cleaning
/// up (SIGKILL, crash). Called at daemon startup; a no-op when there is no
/// owner record.
pub async fn recover_stale() {
    let Ok(dir) = owner_dir() else {
        return;
    };
    let _ = tokio::task::spawn_blocking(move || recover_blocking(&RealHost, &dir)).await;
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
            started: None,
            original_bypass: vec!["*.local".into()],
            applied_bypass: None,
            lease_id: None,
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
        assert!(!fallback_allowed(env(&[("CI", "False")])));
        assert!(!fallback_allowed(env(&[("CI", " FALSE ")])));
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
        assert!(!RealHost.is_live_owner(&record(999_999, 1, "Wi-Fi")));
    }

    #[test]
    fn liveness_is_by_start_time_not_process_name() {
        // This test process is alive but its path need not contain
        // "tapsmith": a renamed daemon binary must still read as live, and a
        // reused pid (different start time) must not.
        let me = std::process::id();
        let started = RealHost.self_started();
        assert!(started.is_some());
        let mut r = record(me, 1, "Wi-Fi");
        r.started = started;
        assert!(RealHost.is_live_owner(&r));
        r.started = Some("Thu Jan  1 00:00:00 1970".into());
        assert!(!RealHost.is_live_owner(&r));
    }

    #[test]
    fn slow_command_is_killed_at_the_deadline() {
        // A wedged child (configd hanging networksetup) must not hang the
        // caller; a quick command still returns its output.
        let started = Instant::now();
        let err = run_with_deadline("/bin/sleep", &["5"], Duration::from_millis(200)).unwrap_err();
        assert!(err.to_string().contains("did not finish"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(3));
        let out = run_with_timeout("/bin/echo", &["hi"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi");
    }

    // ─── Ownership against a fake networksetup ───

    use std::cell::{Cell, RefCell};
    use std::collections::{HashMap, HashSet};

    #[derive(Clone, Default)]
    struct Svc {
        ip: bool,
        http: ProxySetting,
        https: ProxySetting,
        bypass: Vec<String>,
    }

    struct FakeHost {
        pid: u32,
        live: HashSet<u32>,
        services: RefCell<HashMap<String, Svc>>,
        fail_set: Cell<bool>,
        fail_get: Cell<bool>,
        normalise_bypass: Cell<bool>,
        set_calls: RefCell<Vec<String>>,
        fail_readback_after_write: Cell<bool>,
        bypass_written: Cell<bool>,
    }

    impl FakeHost {
        fn new(pid: u32) -> Self {
            let mut services = HashMap::new();
            services.insert(
                "Wi-Fi".to_string(),
                Svc {
                    ip: true,
                    bypass: vec!["*.local".into()],
                    ..Svc::default()
                },
            );
            Self {
                pid,
                live: HashSet::new(),
                services: RefCell::new(services),
                fail_set: Cell::new(false),
                fail_get: Cell::new(false),
                normalise_bypass: Cell::new(false),
                set_calls: RefCell::new(Vec::new()),
                fail_readback_after_write: Cell::new(false),
                bypass_written: Cell::new(false),
            }
        }
        fn svc(&self, name: &str) -> Svc {
            self.services
                .borrow()
                .get(name)
                .cloned()
                .unwrap_or_default()
        }
        fn set_proxy(&self, name: &str, port: u16) {
            let mut s = self.services.borrow_mut();
            let svc = s.entry(name.to_string()).or_default();
            svc.http = setting(true, PROXY_HOST, port);
            svc.https = setting(true, PROXY_HOST, port);
        }
    }

    fn show(s: &ProxySetting) -> String {
        format!(
            "Enabled: {}\nServer: {}\nPort: {}\nAuthenticated Proxy Enabled: 0\n",
            if s.enabled { "Yes" } else { "No" },
            s.server,
            s.port
        )
    }

    impl Host for FakeHost {
        fn networksetup(&self, args: &[&str]) -> Result<String> {
            let mut services = self.services.borrow_mut();
            if self.fail_get.get() && args[0].starts_with("-get") {
                bail!("networksetup timed out");
            }
            match args {
                ["-listallnetworkservices"] => Ok(std::iter::once(
                    "An asterisk (*) denotes that a network service is disabled.".to_string(),
                )
                .chain(services.keys().cloned())
                .collect::<Vec<_>>()
                .join("\n")),
                ["-getinfo", name] => Ok(match services.get(*name) {
                    Some(s) if s.ip => "IP address: 10.0.0.2\n".into(),
                    _ => "IP address: none\n".into(),
                }),
                ["-getwebproxy", name] => {
                    Ok(show(&services.entry(name.to_string()).or_default().http))
                }
                ["-getsecurewebproxy", name] => {
                    Ok(show(&services.entry(name.to_string()).or_default().https))
                }
                ["-setwebproxy" | "-setsecurewebproxy", name, host, port] => {
                    if self.fail_set.get() {
                        bail!("networksetup failed");
                    }
                    self.set_calls.borrow_mut().push(format!("{host}:{port}"));
                    let s = services.entry(name.to_string()).or_default();
                    let target = if args[0] == "-setwebproxy" {
                        &mut s.http
                    } else {
                        &mut s.https
                    };
                    *target = setting(true, host, port.parse().unwrap());
                    Ok(String::new())
                }
                ["-setwebproxystate" | "-setsecurewebproxystate", name, "off"] => {
                    let s = services.entry(name.to_string()).or_default();
                    if args[0] == "-setwebproxystate" {
                        s.http.enabled = false;
                    } else {
                        s.https.enabled = false;
                    }
                    Ok(String::new())
                }
                ["-getproxybypassdomains", name] => {
                    if self.fail_readback_after_write.get() && self.bypass_written.get() {
                        self.fail_readback_after_write.set(false);
                        bail!("networksetup timed out");
                    }
                    let s = services.entry(name.to_string()).or_default();
                    Ok(if s.bypass.is_empty() {
                        format!("There aren't any bypass domains set on {name}.\n")
                    } else {
                        s.bypass.join("\n")
                    })
                }
                ["-setproxybypassdomains", name, rest @ ..] => {
                    self.bypass_written.set(true);
                    let s = services.entry(name.to_string()).or_default();
                    s.bypass = if rest == ["Empty"] {
                        Vec::new()
                    } else {
                        rest.iter()
                            // Model macOS normalising an entry on write.
                            .filter(|d| !(self.normalise_bypass.get() && **d == "127.0.0.1"))
                            .map(|d| d.to_string())
                            .collect()
                    };
                    Ok(String::new())
                }
                other => bail!("unexpected networksetup {other:?}"),
            }
        }
        fn is_live_owner(&self, record: &OwnerRecord) -> bool {
            self.live.contains(&record.pid)
        }
        fn self_started(&self) -> Option<String> {
            Some(format!("started-{}", self.pid))
        }
        fn self_pid(&self) -> u32 {
            self.pid
        }
    }

    fn write_record(dir: &Path, r: &OwnerRecord) {
        OwnerLock::acquire(dir).unwrap().write(r).unwrap();
    }

    fn read_record(dir: &Path) -> Option<OwnerRecord> {
        OwnerLock::acquire(dir).unwrap().read()
    }

    #[test]
    fn acquire_then_release_round_trips_the_users_settings() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        let lease = acquire_blocking(&h, dir.path(), 5000).unwrap();
        let s = h.svc("Wi-Fi");
        assert!(s.http.points_at(5000) && s.http.enabled);
        assert!(s.https.points_at(5000) && s.https.enabled);
        assert!(s.bypass.contains(&"*.github.com".to_string()));
        assert_eq!(
            read_record(dir.path()).unwrap().original_bypass,
            vec!["*.local"]
        );

        release_blocking(&h, dir.path(), &lease);
        let s = h.svc("Wi-Fi");
        assert!(!s.http.enabled && !s.https.enabled);
        assert_eq!(s.bypass, vec!["*.local"]);
        assert_eq!(read_record(dir.path()), None);
    }

    #[test]
    fn release_leaves_a_proxy_another_daemon_now_owns() {
        // The first daemon to exit must not switch the proxy off under a
        // surviving owner.
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        h.set_proxy("Wi-Fi", 6000);
        write_record(dir.path(), &record(20, 6000, "Wi-Fi"));
        release_blocking(
            &h,
            dir.path(),
            &SystemProxyLease {
                service: "Wi-Fi".into(),
                port: 5000,
                id: String::new(),
            },
        );
        assert!(h.svc("Wi-Fi").http.enabled);
        assert_eq!(read_record(dir.path()).unwrap().pid, 20);
    }

    #[test]
    fn release_without_a_record_still_disables_its_own_port() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        let lease = acquire_blocking(&h, dir.path(), 5000).unwrap();
        OwnerLock::acquire(dir.path()).unwrap().clear();
        release_blocking(&h, dir.path(), &lease);
        let s = h.svc("Wi-Fi");
        assert!(!s.http.enabled && !s.https.enabled);
    }

    #[test]
    fn second_live_daemon_is_refused_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let first = FakeHost::new(10);
        acquire_blocking(&first, dir.path(), 5000).unwrap();
        let mut second = FakeHost::new(20);
        second.live.insert(10);
        *second.services.borrow_mut() = first.services.borrow().clone();

        let err = acquire_blocking(&second, dir.path(), 6000).unwrap_err();
        assert!(err.to_string().contains("pid 10"), "{err}");
        assert!(second.svc("Wi-Fi").http.points_at(5000));
        assert_eq!(read_record(dir.path()).unwrap().pid, 10);
    }

    #[test]
    fn a_user_proxy_is_refused_and_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        h.set_proxy("Wi-Fi", 8888);
        assert!(acquire_blocking(&h, dir.path(), 5000).is_err());
        assert!(h.svc("Wi-Fi").http.points_at(8888));
        assert_eq!(read_record(dir.path()), None);
    }

    #[test]
    fn takes_over_a_dead_owners_proxy_and_keeps_the_original_bypass() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        h.set_proxy("Wi-Fi", 4000);
        h.services.borrow_mut().get_mut("Wi-Fi").unwrap().bypass = vec!["*.github.com".into()];
        write_record(dir.path(), &record(20, 4000, "Wi-Fi"));

        let lease = acquire_blocking(&h, dir.path(), 5000).unwrap();
        assert!(h.svc("Wi-Fi").https.points_at(5000));
        release_blocking(&h, dir.path(), &lease);
        // The dead owner's snapshot of the user's list, not our own.
        assert_eq!(h.svc("Wi-Fi").bypass, vec!["*.local"]);
    }

    #[test]
    fn failed_takeover_does_not_strand_the_dead_owners_proxy() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        h.set_proxy("Wi-Fi", 4000);
        write_record(dir.path(), &record(20, 4000, "Wi-Fi"));
        h.fail_set.set(true);

        assert!(acquire_blocking(&h, dir.path(), 5000).is_err());
        let s = h.svc("Wi-Fi");
        assert!(
            !s.http.enabled && !s.https.enabled,
            "dead port left enabled"
        );
        assert_eq!(read_record(dir.path()), None);
    }

    #[test]
    fn stale_record_on_another_service_is_undone_once() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        h.set_proxy("Ethernet", 4000);
        write_record(dir.path(), &record(20, 4000, "Ethernet"));
        // The active service (Wi-Fi) has a user proxy, so this acquire fails
        // after undoing Ethernet.
        h.set_proxy("Wi-Fi", 8888);

        assert!(acquire_blocking(&h, dir.path(), 5000).is_err());
        assert!(!h.svc("Ethernet").http.enabled);
        assert_eq!(
            read_record(dir.path()),
            None,
            "stale record would be undone again"
        );
    }

    #[test]
    fn recovery_undoes_only_a_dead_owner() {
        let dir = tempfile::tempdir().unwrap();
        let mut h = FakeHost::new(10);
        h.set_proxy("Wi-Fi", 4000);
        write_record(dir.path(), &record(20, 4000, "Wi-Fi"));

        h.live.insert(20);
        recover_blocking(&h, dir.path());
        assert!(h.svc("Wi-Fi").http.enabled, "live owner's proxy was reset");

        h.live.clear();
        recover_blocking(&h, dir.path());
        let s = h.svc("Wi-Fi");
        assert!(!s.http.enabled && !s.https.enabled);
        assert_eq!(s.bypass, vec!["*.local"]);
        assert_eq!(read_record(dir.path()), None);
    }

    #[test]
    fn still_applied_notices_a_changed_https_proxy() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        let lease = acquire_blocking(&h, dir.path(), 5000).unwrap();
        assert_eq!(still_applied_blocking(&h, &lease), Some(true));
        h.services
            .borrow_mut()
            .get_mut("Wi-Fi")
            .unwrap()
            .https
            .enabled = false;
        assert_eq!(still_applied_blocking(&h, &lease), Some(false));
    }

    #[test]
    fn an_unreadable_setting_is_not_reported_as_changed() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        let lease = acquire_blocking(&h, dir.path(), 5000).unwrap();
        // The service vanishes from networksetup's view: reads now fail.
        h.fail_get.set(true);
        assert_eq!(still_applied_blocking(&h, &lease), None);
    }

    #[test]
    fn recovery_undoes_a_dead_owner_that_had_our_pid() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        h.set_proxy("Wi-Fi", 4000);
        let mut r = record(10, 4000, "Wi-Fi");
        r.started = Some("an earlier process".into());
        write_record(dir.path(), &r);

        recover_blocking(&h, dir.path());
        assert!(!h.svc("Wi-Fi").http.enabled);
        assert_eq!(read_record(dir.path()), None);
    }

    #[test]
    fn release_never_switches_on_a_proxy_the_user_had_saved_off() {
        // networksetup can only write a server by enabling it, so a saved,
        // disabled proxy is deliberately not written back: the only writes
        // are the acquire's own, and the service ends disabled.
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        {
            let mut s = h.services.borrow_mut();
            let wifi = s.get_mut("Wi-Fi").unwrap();
            wifi.http = setting(false, "proxy.corp", 3128);
            wifi.https = setting(false, "proxy.corp", 3129);
        }
        let lease = acquire_blocking(&h, dir.path(), 5000).unwrap();
        release_blocking(&h, dir.path(), &lease);
        assert_eq!(
            *h.set_calls.borrow(),
            vec!["127.0.0.1:5000", "127.0.0.1:5000"]
        );
        let s = h.svc("Wi-Fi");
        assert!(!s.http.enabled && !s.https.enabled);
    }

    #[test]
    fn failed_takeover_restores_the_users_bypass_against_the_dead_owners_list() {
        // The dead owner applied a list macOS normalised; our set fails, so
        // the rollback must recognise that list as Tapsmith's, not the
        // literal one, or the user's original is lost with the record.
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        h.normalise_bypass.set(true);
        let mut dead = FakeHost::new(20);
        *dead.services.borrow_mut() = h.services.borrow().clone();
        dead.normalise_bypass.set(true);
        acquire_blocking(&dead, dir.path(), 4000).unwrap();
        dead.live.clear();
        *h.services.borrow_mut() = dead.services.borrow().clone();
        h.fail_set.set(true);

        assert!(acquire_blocking(&h, dir.path(), 5000).is_err());
        let s = h.svc("Wi-Fi");
        assert!(!s.http.enabled && !s.https.enabled);
        assert_eq!(s.bypass, vec!["*.local"]);
        assert_eq!(read_record(dir.path()), None);
    }

    #[test]
    fn bypass_is_restored_even_when_macos_normalises_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        h.normalise_bypass.set(true);
        let lease = acquire_blocking(&h, dir.path(), 5000).unwrap();
        assert!(!h.svc("Wi-Fi").bypass.contains(&"127.0.0.1".to_string()));
        release_blocking(&h, dir.path(), &lease);
        assert_eq!(h.svc("Wi-Fi").bypass, vec!["*.local"]);
    }

    #[test]
    fn recovery_keeps_a_bypass_list_the_user_changed_since() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        let mut lease_host = FakeHost::new(20);
        *lease_host.services.borrow_mut() = h.services.borrow().clone();
        acquire_blocking(&lease_host, dir.path(), 4000).unwrap();
        // pid 20 dies; the user clears the proxy and sets their own list.
        let mut state = lease_host.services.borrow().clone();
        let wifi = state.get_mut("Wi-Fi").unwrap();
        wifi.http.enabled = false;
        wifi.https.enabled = false;
        wifi.bypass = vec!["*.vpn.corp".into()];
        *h.services.borrow_mut() = state;
        lease_host.live.clear();

        recover_blocking(&h, dir.path());
        assert_eq!(h.svc("Wi-Fi").bypass, vec!["*.vpn.corp"]);
        assert_eq!(read_record(dir.path()), None);
    }

    #[test]
    fn ne_failure_is_trusted_for_a_minute_then_retried() {
        let t0 = Instant::now();
        let f = NeFailure {
            message: "SE did not connect".into(),
            at: t0,
        };
        assert_eq!(
            cached_ne_failure(Some(&f), false, t0 + Duration::from_secs(5)).as_deref(),
            Some("SE did not connect")
        );
        assert_eq!(
            cached_ne_failure(Some(&f), false, t0 + NE_RETRY_AFTER),
            None
        );
        assert_eq!(cached_ne_failure(None, false, t0), None);
    }

    #[test]
    fn multi_device_callers_never_use_the_ne_cache() {
        let t0 = Instant::now();
        let f = NeFailure {
            message: "x".into(),
            at: t0,
        };
        assert_eq!(cached_ne_failure(Some(&f), true, t0), None);
    }

    #[test]
    fn fallback_decision_follows_isolation_then_policy() {
        use FallbackDecision::*;
        assert_eq!(fallback_decision(true, true), RefuseIsolation);
        assert_eq!(fallback_decision(true, false), RefuseIsolation);
        assert_eq!(fallback_decision(false, false), RefuseLocal);
        assert_eq!(fallback_decision(false, true), UseSystemProxy);
    }

    #[test]
    fn bypass_is_restored_when_the_read_back_failed_and_macos_normalised_it() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        h.normalise_bypass.set(true);
        h.fail_readback_after_write.set(true);
        let lease = acquire_blocking(&h, dir.path(), 5000).unwrap();
        assert_eq!(read_record(dir.path()).unwrap().applied_bypass, None);
        release_blocking(&h, dir.path(), &lease);
        assert_eq!(h.svc("Wi-Fi").bypass, vec!["*.local"]);
    }

    #[test]
    fn takeover_keeps_a_bypass_list_the_user_changed_after_the_owner_died() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        let dead = FakeHost::new(20);
        *dead.services.borrow_mut() = h.services.borrow().clone();
        acquire_blocking(&dead, dir.path(), 4000).unwrap();
        // pid 20 dies; the user turns the proxy off and sets their own list.
        let mut state = dead.services.borrow().clone();
        let wifi = state.get_mut("Wi-Fi").unwrap();
        wifi.http.enabled = false;
        wifi.https.enabled = false;
        wifi.bypass = vec!["*.vpn.corp".into()];
        *h.services.borrow_mut() = state;

        let lease = acquire_blocking(&h, dir.path(), 5000).unwrap();
        release_blocking(&h, dir.path(), &lease);
        assert_eq!(h.svc("Wi-Fi").bypass, vec!["*.vpn.corp"]);
    }

    #[test]
    fn a_stale_release_does_not_undo_a_newer_lease_on_the_same_port() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHost::new(10);
        let old = acquire_blocking(&h, dir.path(), 5000).unwrap();
        // The old capture is abandoned without release; a retry takes the
        // same port. The late release of the old lease must leave it alone.
        let new = acquire_blocking(&h, dir.path(), 5000).unwrap();
        assert_ne!(old.id, new.id);
        release_blocking(&h, dir.path(), &old);
        assert!(h.svc("Wi-Fi").http.enabled);
        assert!(read_record(dir.path()).is_some());
        release_blocking(&h, dir.path(), &new);
        assert!(!h.svc("Wi-Fi").http.enabled);
    }

    static ABANDONED: std::sync::Mutex<Vec<u16>> = std::sync::Mutex::new(Vec::new());

    fn record_abandoned(lease: SystemProxyLease) {
        ABANDONED.lock().unwrap().push(lease.port);
    }

    #[test]
    fn a_pending_lease_is_released_unless_handed_over() {
        let lease = |port| SystemProxyLease {
            service: "Wi-Fi".into(),
            port,
            id: String::new(),
        };
        // Dropped (the capture-start future was cancelled): released.
        drop(PendingLease {
            lease: Some(lease(7001)),
            on_abandon: record_abandoned,
        });
        // Handed over: not released.
        let kept = PendingLease {
            lease: Some(lease(7002)),
            on_abandon: record_abandoned,
        }
        .disarm();
        assert_eq!(kept.port, 7002);
        let abandoned = ABANDONED.lock().unwrap().clone();
        assert!(abandoned.contains(&7001));
        assert!(!abandoned.contains(&7002));
    }

    #[test]
    fn owner_record_write_is_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let lock = OwnerLock::acquire(dir.path()).unwrap();
        lock.write(&record(10, 5000, "Wi-Fi")).unwrap();
        assert!(!dir.path().join("ios-system-proxy.json.tmp").exists());
        assert_eq!(lock.read().unwrap().pid, 10);
    }
}
