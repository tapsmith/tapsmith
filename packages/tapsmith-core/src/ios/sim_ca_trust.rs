//! Making an iOS simulator trust Tapsmith's MITM CA for network capture
//! (PILOT-1183).
//!
//! `simctl keychain add-root-cert` talks to the simulator's trustd through
//! CoreSimulator, which wedges on loaded CI hosts. When the install fails,
//! intercepting TLS anyway makes every HTTPS request the app sends fail
//! (the simulator rejects our certificates), and tests fail with unrelated
//! assertion timeouts. So the install is retried, a failure is checked
//! against the simulator's trust store on disk (an earlier session, or the
//! timed-out attempt itself, may have installed the CA), and only a CA known
//! to be trusted keeps TLS interception. Otherwise the proxy tunnels TLS
//! untouched, as on an Android Play image (PILOT-711).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::time::Instant;

use super::device::SIMCTL_TIMEOUT;

/// The wait before each retry of a failed install. Two retries: a wedged
/// CoreSimulator sometimes recovers within seconds.
pub(crate) const INSTALL_RETRY_BACKOFF: [Duration; 2] =
    [Duration::from_secs(2), Duration::from_secs(5)];

/// Everything [`ensure_trusted`] spends on install attempts and the waits
/// between them. Each attempt's timeout is cut to what is left of it. The
/// SDK gives the whole capture start 60 s (its default gRPC deadline), so
/// this leaves room for the trust-store reads, the proxy start and routing:
/// a start that outlived the deadline would fail with DEADLINE_EXCEEDED
/// instead of passing HTTPS through.
pub(crate) const INSTALL_BUDGET: Duration = Duration::from_secs(40);

/// No retry starts with less than this left of [`INSTALL_BUDGET`]: an attempt
/// cut shorter than this could not finish even on a healthy CoreSimulator.
const MIN_RETRY_ATTEMPT: Duration = Duration::from_secs(5);

/// Bound on reading the trust store, which never involves CoreSimulator.
const TRUST_STORE_READ_TIMEOUT: Duration = Duration::from_secs(2);

/// Whether the simulator trusts the CA after [`ensure_trusted`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SimCaTrust {
    /// `simctl` installed it.
    Installed,
    /// Every install attempt failed, but the trust store holds the CA, so
    /// interception still works. `install_error` is the last failure.
    AlreadyTrusted { install_error: String },
    /// The CA is not known to be trusted: TLS must be tunneled, not
    /// intercepted. `warning` is the user-facing capture warning.
    Untrusted { warning: String },
}

/// Install the CA on simulator `udid`, retrying, and decide whether TLS can
/// be intercepted.
///
/// `install(timeout)` runs one `simctl keychain add-root-cert` bounded by
/// `timeout`; `trusted` reads the trust store (`Some(true)` holds the CA,
/// `Some(false)` does not, `None` unreadable). Attempts and the waits
/// between them fit in [`INSTALL_BUDGET`]. The trust store is read after each
/// failed attempt, since an attempt that timed out may still have gone
/// through. An unreadable trust store counts as untrusted: intercepting with
/// a CA the simulator may not trust is what broke every HTTPS request.
pub(crate) async fn ensure_trusted<I, IF, T, TF>(
    udid: &str,
    mut install: I,
    mut trusted: T,
) -> SimCaTrust
where
    I: FnMut(Duration) -> IF,
    IF: Future<Output = anyhow::Result<()>>,
    T: FnMut() -> TF,
    TF: Future<Output = Option<bool>>,
{
    let deadline = Instant::now() + INSTALL_BUDGET;
    let mut attempts = 0usize;
    let last_error = loop {
        attempts += 1;
        let timeout = SIMCTL_TIMEOUT.min(deadline.saturating_duration_since(Instant::now()));
        let err = match install(timeout).await {
            Ok(()) => return SimCaTrust::Installed,
            Err(e) => e,
        };
        let cause = format!("{err:#}");
        tracing::warn!(
            udid,
            attempt = attempts,
            "CA install on simulator failed: {cause}"
        );
        if trusted().await == Some(true) {
            return SimCaTrust::AlreadyTrusted {
                install_error: cause,
            };
        }
        let Some(backoff) = INSTALL_RETRY_BACKOFF.get(attempts - 1) else {
            break cause;
        };
        if Instant::now() + *backoff + MIN_RETRY_ATTEMPT > deadline {
            break cause;
        }
        tokio::time::sleep(*backoff).await;
    };
    SimCaTrust::Untrusted {
        warning: untrusted_warning(udid, attempts, &last_error),
    }
}

/// The capture warning for a simulator that does not trust the CA: what
/// failed, what happens to HTTPS, and how to recover.
fn untrusted_warning(udid: &str, attempts: usize, cause: &str) -> String {
    let cause = cause.trim().trim_end_matches('.');
    let tries = if attempts == 1 {
        String::new()
    } else {
        format!(" (tried {attempts} times)")
    };
    format!(
        "Could not install Tapsmith's CA certificate on the simulator{tries}: {cause}. \
         HTTPS is passed through to its servers uncaptured, so the app's HTTPS requests still \
         work, but they appear in the trace only as passthrough entries, and device.route(), \
         waitForRequest() and waitForResponse() cannot see them; plain HTTP is still captured. \
         This usually means CoreSimulator is overloaded or wedged: run the tests again, and if \
         it keeps happening, shut the simulator down (`xcrun simctl shutdown {udid}`) or \
         restart CoreSimulator (`killall -9 com.apple.CoreSimulator.CoreSimulatorService`, \
         which stops every running simulator) before the next run"
    )
}

/// The simulator's trust store: `simctl keychain add-root-cert` adds a row
/// to its `tsettings` table keyed by the certificate's SHA-256.
fn trust_store_path(home: &Path, udid: &str) -> PathBuf {
    home.join("Library/Developer/CoreSimulator/Devices")
        .join(udid)
        .join("data/private/var/protected/trustd/private/TrustStore.sqlite3")
}

/// Whether `sqlite3`'s `SELECT hex(sha256) FROM tsettings` output lists
/// `sha256_hex`.
fn trust_store_lists(listing: &str, sha256_hex: &str) -> bool {
    listing
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case(sha256_hex))
}

/// Whether simulator `udid`'s trust store holds the certificate whose DER
/// hashes to `sha256_hex`: `None` when it cannot be read (no store yet, a
/// changed schema, no `sqlite3`). Reads the file directly, so it works while
/// CoreSimulator is wedged.
pub(crate) async fn trust_store_has(udid: &str, sha256_hex: &str) -> Option<bool> {
    let path = trust_store_path(&dirs::home_dir()?, udid);
    if !path.is_file() {
        return None;
    }
    let mut cmd = tokio::process::Command::new("sqlite3");
    cmd.arg("-readonly")
        .arg(&path)
        .arg("SELECT hex(sha256) FROM tsettings;")
        .kill_on_drop(true);
    let output = tokio::time::timeout(TRUST_STORE_READ_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        tracing::debug!(
            udid,
            stderr = %String::from_utf8_lossy(&output.stderr),
            "could not read the simulator trust store"
        );
        return None;
    }
    Some(trust_store_lists(
        &String::from_utf8_lossy(&output.stdout),
        sha256_hex,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const UDID: &str = "11111111-2222-3333-4444-555555555555";

    /// What `bounded_output` returns when simctl hangs past its timeout.
    async fn simctl_hangs(timeout: Duration) -> anyhow::Result<()> {
        tokio::time::sleep(timeout).await;
        Err(anyhow::anyhow!(
            "simctl keychain add-root-cert timed out after {}s (CoreSimulatorService may be wedged)",
            timeout.as_secs()
        ))
    }

    fn untrusted_warning_of(trust: &SimCaTrust) -> &str {
        match trust {
            SimCaTrust::Untrusted { warning } => warning,
            other => panic!("expected Untrusted, got {other:?}"),
        }
    }

    // The CI failure: simctl hangs every time and the trust store has no CA.
    // TLS must be tunneled, and the whole decision must fit well inside the
    // SDK's 60 s deadline for the capture start, or the start fails with
    // DEADLINE_EXCEEDED instead of passing HTTPS through.
    #[tokio::test(start_paused = true)]
    async fn wedged_simctl_and_untrusted_store_tunnels_within_the_capture_deadline() {
        let timeouts = std::cell::RefCell::new(Vec::new());
        let started = Instant::now();
        let trust = ensure_trusted(
            UDID,
            |timeout| {
                timeouts.borrow_mut().push(timeout);
                simctl_hangs(timeout)
            },
            // A slow read (the bound) after each attempt.
            || async {
                tokio::time::sleep(TRUST_STORE_READ_TIMEOUT).await;
                Some(false)
            },
        )
        .await;
        assert_eq!(
            *timeouts.borrow(),
            vec![Duration::from_secs(30), Duration::from_secs(6)],
            "the retry gets what is left of the budget"
        );
        assert!(
            started.elapsed() <= Duration::from_secs(45),
            "{:?} leaves too little of the SDK's 60 s",
            started.elapsed()
        );
        let warning = untrusted_warning_of(&trust);
        assert!(warning.starts_with(
            "Could not install Tapsmith's CA certificate on the simulator (tried 2 times): \
             simctl keychain add-root-cert timed out after 6s (CoreSimulatorService may be wedged). \
             HTTPS is passed through to its servers uncaptured"
        ), "{warning}");
        assert!(warning.contains("HTTPS requests still work"), "{warning}");
        assert!(
            warning
                .contains("device.route(), waitForRequest() and waitForResponse() cannot see them"),
            "{warning}"
        );
        assert!(
            warning.contains("plain HTTP is still captured"),
            "{warning}"
        );
        assert!(
            warning.contains(&format!("xcrun simctl shutdown {UDID}")),
            "{warning}"
        );
    }

    // No retry is started that could not run for MIN_RETRY_ATTEMPT.
    #[tokio::test(start_paused = true)]
    async fn no_retry_starts_without_time_left_for_it() {
        let installs = Cell::new(0);
        let trust = ensure_trusted(
            UDID,
            |_| {
                installs.set(installs.get() + 1);
                // Fails just under the full budget.
                async {
                    tokio::time::sleep(Duration::from_secs(34)).await;
                    Err(anyhow::anyhow!("slow failure"))
                }
            },
            || async { Some(false) },
        )
        .await;
        assert_eq!(installs.get(), 1);
        untrusted_warning_of(&trust);
    }

    // A fast failure (simctl exits non-zero) gets all three attempts.
    #[tokio::test(start_paused = true)]
    async fn fast_failures_are_retried_twice_with_backoff() {
        let installs = Cell::new(0);
        let started = Instant::now();
        let trust = ensure_trusted(
            UDID,
            |_| {
                installs.set(installs.get() + 1);
                async {
                    Err(anyhow::anyhow!(
                        "Failed to install CA cert on simulator: boom\n"
                    ))
                }
            },
            || async { Some(false) },
        )
        .await;
        assert_eq!(installs.get(), 3);
        assert_eq!(started.elapsed(), Duration::from_secs(7));
        assert!(
            untrusted_warning_of(&trust)
                .contains("(tried 3 times): Failed to install CA cert on simulator: boom. HTTPS"),
            "{trust:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_retry_that_succeeds_installs_the_ca() {
        let installs = Cell::new(0);
        let trust = ensure_trusted(
            UDID,
            |timeout| {
                installs.set(installs.get() + 1);
                let n = installs.get();
                async move {
                    if n == 1 {
                        simctl_hangs(timeout).await
                    } else {
                        Ok(())
                    }
                }
            },
            || async { Some(false) },
        )
        .await;
        assert_eq!(trust, SimCaTrust::Installed);
        assert_eq!(installs.get(), 2);
    }

    // A timed-out attempt may still have gone through, or an earlier session
    // installed the CA: the trust store says interception still works.
    #[tokio::test(start_paused = true)]
    async fn a_failed_install_with_the_ca_in_the_trust_store_keeps_interception() {
        let installs = Cell::new(0);
        let trust = ensure_trusted(
            UDID,
            |timeout| {
                installs.set(installs.get() + 1);
                simctl_hangs(timeout)
            },
            || async { Some(true) },
        )
        .await;
        assert_eq!(
            installs.get(),
            1,
            "no retry once the CA is known to be trusted"
        );
        assert!(
            matches!(&trust, SimCaTrust::AlreadyTrusted { install_error } if install_error.contains("timed out")),
            "{trust:?}"
        );
    }

    // Unreadable trust store: whether the simulator trusts the CA is unknown,
    // and intercepting on a guess is what broke every HTTPS request.
    #[tokio::test(start_paused = true)]
    async fn an_unreadable_trust_store_counts_as_untrusted() {
        let trust = ensure_trusted(UDID, simctl_hangs, || async { None }).await;
        untrusted_warning_of(&trust);
    }

    #[tokio::test(start_paused = true)]
    async fn a_first_install_that_succeeds_never_reads_the_trust_store() {
        let reads = Cell::new(0);
        let trust = ensure_trusted(
            UDID,
            |_| async { Ok(()) },
            || {
                reads.set(reads.get() + 1);
                async { Some(false) }
            },
        )
        .await;
        assert_eq!(trust, SimCaTrust::Installed);
        assert_eq!(reads.get(), 0);
    }

    #[test]
    fn trust_store_listing_matches_the_sha256_in_any_case() {
        let sha = "79ba60db4384e00ade5c39c90dbad73a4ae3b50069b3cf8e48bfe3a6b5790e5d";
        let listing = "6671333913E7F50C674BA07F2374FCBF1A2613ECD4F58F16A22F7EC3FC91295A\n\
                       79BA60DB4384E00ADE5C39C90DBAD73A4AE3B50069B3CF8E48BFE3A6B5790E5D\n";
        assert!(trust_store_lists(listing, sha));
        assert!(!trust_store_lists(
            "6671333913E7F50C674BA07F2374FCBF1A2613ECD4F58F16A22F7EC3FC91295A\n",
            sha
        ));
        assert!(!trust_store_lists("", sha));
    }

    #[test]
    fn trust_store_is_under_the_simulators_data_directory() {
        assert_eq!(
            trust_store_path(Path::new("/Users/me"), UDID),
            PathBuf::from(format!(
                "/Users/me/Library/Developer/CoreSimulator/Devices/{UDID}/data/private/var/protected/trustd/private/TrustStore.sqlite3"
            ))
        );
    }
}
