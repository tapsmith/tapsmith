//! App reset ladder — the daemon side of Tapsmith's declared isolation policy.
//!
//! The SDK asks for a reset *mode* (`warm` / `restart` / `clear`) and whether
//! escalation is allowed; this module owns the pure decisions around it:
//!
//! * **Hooks marker** — how an app advertises an in-app reset hook
//!   (`@tapsmith/react-native`) through its accessibility tree, and how the
//!   daemon acknowledges a warm reset by watching the marker's epoch advance.
//! * **Cold policy** — when a warm reset on an iOS simulator must instead be
//!   delivered cold (terminate + relaunch): retries, a streak of failed warm
//!   verifications, or the bounded warm window (PILOT-249).
//! * **The ladder** — `warm → restart → clear`, run through a [`ResetOps`]
//!   trait so the sequencing is unit-tested against a mock while the real
//!   device work lives in `grpc_server.rs` (`ServiceResetOps`) and the
//!   platform backends under `grpc_server/`.
//!
//! Wire format the in-app module implements (framework-agnostic):
//!
//! ```text
//! marker (always-present a11y text): tapsmith-hooks:<version>;epoch=<n>;url=<prefix>[;err=<urlencoded>]
//! request (deep link):               <prefix><target>?__tapsmith_reset=1&nonce=<opaque>
//! ack:                               marker epoch strictly greater than the pre-request value
//! ```

use std::time::Instant;

use async_trait::async_trait;

pub const HOOKS_MARKER_PREFIX: &str = "tapsmith-hooks:";
/// The one marker protocol version this daemon understands.
pub const HOOKS_MARKER_VERSION: u32 = 1;
pub const RESET_QUERY_FLAG: &str = "__tapsmith_reset=1";

/// Parsed `@tapsmith/react-native` marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HooksMarker {
    pub version: u32,
    pub epoch: u64,
    /// URL prefix the module built its reset link from (e.g. `myapp://`,
    /// `exp://192.168.1.2:8081/--/`). Empty when the module could not
    /// determine a scheme — the daemon then falls back to other steps.
    pub url_prefix: String,
    /// Error reported by the last in-app reset, if it failed.
    pub err: Option<String>,
    /// Random per-process token. The epoch counter restarts at 0 when the app
    /// is relaunched, so a changed `boot` is how a cold-delivered reset is
    /// recognised as acknowledged (see [`hooks_acknowledged`]). `None` for
    /// modules that predate the field.
    pub boot: Option<String>,
    /// Counts every URL the process received — the navigation ack (see
    /// `nav_acknowledged`). Absent on markers from older app builds.
    pub nav: Option<u64>,
}

impl HooksMarker {
    /// Whether the marker advertises an in-app reset hook the daemon can
    /// drive. A module that could not determine its URL scheme renders an
    /// empty `url=`: the marker still carries `epoch`/`nav`/`boot` (so it is
    /// useful for navigation acks), but there is no link to deliver a reset
    /// through, and every "hooks detected" decision must treat it as absent.
    pub fn has_reset_hook(&self) -> bool {
        !self.url_prefix.is_empty()
    }
}

/// Find and parse the hooks marker in a UI hierarchy dump (Android
/// `text="…"`, iOS `label="…"` / `name="…"` / `value="…"`). The marker may be
/// XML-escaped; `&amp;` etc. are decoded before parsing.
pub fn parse_hooks_marker(hierarchy_xml: &str) -> Option<HooksMarker> {
    let start = hierarchy_xml.find(HOOKS_MARKER_PREFIX)?;
    let rest = &hierarchy_xml[start + HOOKS_MARKER_PREFIX.len()..];
    // The marker ends at the closing quote of the attribute it lives in.
    let end = rest.find(['"', '\'', '<', '\n']).unwrap_or(rest.len());
    let raw = xml_unescape(&rest[..end]);

    let mut fields = raw.split(';');
    let version: u32 = fields.next()?.trim().parse().ok()?;
    // Only protocol version 1 is understood. A future version may change
    // field semantics, so treat it as "no marker" — the ladder then degrades
    // to restart/clear instead of misreading the ack.
    if version != HOOKS_MARKER_VERSION {
        return None;
    }
    let mut epoch: Option<u64> = None;
    let mut nav: Option<u64> = None;
    let mut url_prefix = String::new();
    let mut err: Option<String> = None;
    let mut boot: Option<String> = None;
    for field in fields {
        let Some((k, v)) = field.split_once('=') else {
            continue;
        };
        match k.trim() {
            "epoch" => epoch = v.trim().parse().ok(),
            "nav" => nav = v.trim().parse().ok(),
            "url" => url_prefix = v.trim().to_string(),
            "boot" => {
                let b = v.trim();
                if !b.is_empty() {
                    boot = Some(b.to_string());
                }
            }
            "err" => {
                let decoded = percent_decode(v.trim());
                if !decoded.is_empty() {
                    err = Some(decoded);
                }
            }
            _ => {}
        }
    }
    Some(HooksMarker {
        version,
        epoch: epoch?,
        url_prefix,
        err,
        boot,
        nav,
    })
}

/// Whether the marker read *after* delivering a plain navigation deep link
/// acknowledges it. Mirrors `hooks_acknowledged`, over the `nav` counter:
/// the app bumps `nav` for every URL it receives, so even a link to the
/// screen already showing (which changes nothing else observable) advances
/// it. A changed `boot` means a fresh process handled the link as its launch
/// URL — any nav ≥ 1 is the ack there.
pub fn nav_acknowledged(nav_before: u64, boot_before: Option<&str>, after: &HooksMarker) -> bool {
    let Some(nav) = after.nav else { return false };
    match (boot_before, after.boot.as_deref()) {
        (Some(b), Some(a)) if a != b => nav >= 1,
        _ => nav > nav_before,
    }
}

/// Whether the marker read *after* a reset request acknowledges it.
///
/// Normally the ack is the epoch advancing past the value read before the
/// request. A cold delivery relaunches the app, which restarts the in-memory
/// counter at 0 — so when the marker's per-process `boot` token differs from
/// the one read before, any epoch ≥ 1 (the fresh process handled its launch
/// URL) is the acknowledgement. Without boot tokens on both sides, fall back
/// to the strict comparison.
pub fn hooks_acknowledged(
    epoch_before: u64,
    boot_before: Option<&str>,
    after: &HooksMarker,
) -> bool {
    match (boot_before, after.boot.as_deref()) {
        (Some(b), Some(a)) if a != b => after.epoch >= 1,
        _ => after.epoch > epoch_before,
    }
}

/// `<prefix><target>?__tapsmith_reset=1&nonce=<nonce>`.
///
/// The module publishes a prefix that already ends in `/` (`myapp:///`,
/// `exp://host:8081/--/`) so the daemon only has to append the route; a
/// prefix without one gets a single `/` added. `target_path`'s own leading
/// slash is dropped so it never doubles.
pub fn build_reset_url(prefix: &str, target_path: &str, nonce: &str) -> String {
    let base = if prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{prefix}/")
    };
    let target = target_path.trim().trim_start_matches('/');
    let (path, existing_query) = match target.split_once('?') {
        Some((p, q)) if !q.is_empty() => (p, Some(q)),
        Some((p, _)) => (p, None),
        None => (target, None),
    };
    let sep_query = match existing_query {
        Some(q) => format!("{q}&"),
        None => String::new(),
    };
    format!("{base}{path}?{sep_query}{RESET_QUERY_FLAG}&nonce={nonce}")
}

fn xml_unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            // `get` (not slicing): i+1..i+3 may fall inside a multibyte char
            // in a hand-rolled marker, and this input is app-controlled.
            if let Some(v) = s
                .get(i + 1..i + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ─── Cold policy ───

/// Per-session counters behind the warm/cold decision. Reset whenever the
/// active device or agent session changes.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ResetPolicyState {
    /// Warm resets delivered since the last cold relaunch / restart / clear.
    pub warm_resets_since_cold: u32,
    /// Warm resets in a row whose verification failed.
    pub consecutive_warm_failures: u32,
    /// Streak-valve relaunches (restart/clear standing in for cold delivery)
    /// since the last warm success. Bounds how often the valve re-arms.
    pub valve_relaunches: u32,
}

/// Why a reset that could have been warm is being delivered cold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColdReason {
    RetryAttempt,
    WarmFailureStreak(u32),
    WarmWindowBound(u32),
}

impl ColdReason {
    pub fn describe(&self) -> String {
        match self {
            ColdReason::RetryAttempt => "cold relaunch: retry attempt".to_string(),
            ColdReason::WarmFailureStreak(n) => {
                format!("cold relaunch: {n} consecutive warm resets failed verification")
            }
            ColdReason::WarmWindowBound(n) => {
                format!("cold relaunch: warm-window bound reached ({n} resets)")
            }
        }
    }
}

pub const WARM_FAILURE_STREAK_LIMIT: u32 = 2;
/// How many streak-valve relaunches may re-arm the hook without a warm
/// success in between. Past this the streak stays latched for the session:
/// a hook that keeps failing after fresh processes is broken, not wedged.
pub const MAX_STREAK_VALVE_RELAUNCHES: u32 = 3;

impl ResetPolicyState {
    /// Decide whether the next warm reset must be delivered cold.
    pub fn cold_reason(&self, force_cold: bool, cold_every_n: u32) -> Option<ColdReason> {
        if force_cold {
            return Some(ColdReason::RetryAttempt);
        }
        if self.consecutive_warm_failures >= WARM_FAILURE_STREAK_LIMIT {
            return Some(ColdReason::WarmFailureStreak(
                self.consecutive_warm_failures,
            ));
        }
        if cold_every_n > 0 && self.warm_resets_since_cold >= cold_every_n {
            return Some(ColdReason::WarmWindowBound(cold_every_n));
        }
        None
    }

    /// Fold a completed reset back into the counters.
    ///
    /// The warm window (`warm_resets_since_cold`) restarts on any relaunch —
    /// restart, clear, or a cold-delivered hook — and grows by one per warm
    /// reset delivered in place. The failure streak is different: only a warm
    /// step that actually *succeeded* proves the hook works again and clears
    /// it. A ladder that recovered from a failed warm step with a restart or
    /// clear did not exercise the hook successfully, so the streak recorded by
    /// [`Self::record_warm_failure`] must survive that recovery — otherwise,
    /// with fallback allowed (the default), the counter is wiped on every reset
    /// and the `WarmFailureStreak` cold valve can never fire.
    pub fn record(&mut self, outcome: &ResetOutcome) {
        let warm_succeeded = outcome.mode_used == ResetMode::Warm && !outcome.fell_back;
        if outcome.cold_launch {
            // Any restart / clear / cold delivery starts a fresh warm window.
            self.warm_resets_since_cold = 0;
        } else if warm_succeeded {
            self.warm_resets_since_cold += 1;
        } else {
            self.warm_resets_since_cold = 0;
        }
        if warm_succeeded {
            self.consecutive_warm_failures = 0;
            self.valve_relaunches = 0;
        }
    }

    /// A warm attempt failed verification. Recorded whether or not the ladder
    /// then recovered with a restart/clear: [`Self::record`] leaves the streak
    /// alone on such recoveries, so two failures in a row reach
    /// [`WARM_FAILURE_STREAK_LIMIT`] even when every reset ends up succeeding
    /// through its fallback rung.
    pub fn record_warm_failure(&mut self) {
        self.consecutive_warm_failures += 1;
    }

    /// The streak valve fired and its stand-in relaunch (restart/clear on a
    /// platform without cold delivery) completed: the app has a fresh
    /// process, so the next reset may try the hook again. Without this the
    /// streak stays at the limit and the valve fires on every reset for the
    /// rest of the session — a permanent downgrade off two transient misses.
    /// Bounded by [`MAX_STREAK_VALVE_RELAUNCHES`]: a hook that fails the
    /// streak again after that many fresh processes stays on the relaunch
    /// rung, so a genuinely broken hook does not cost two failed warm
    /// attempts per relaunch forever.
    pub fn consume_streak_valve(&mut self) {
        self.valve_relaunches += 1;
        if self.valve_relaunches < MAX_STREAK_VALVE_RELAUNCHES {
            self.consecutive_warm_failures = 0;
        }
    }
}

// ─── Plan & ladder ───

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetMode {
    Warm,
    Restart,
    Clear,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FirstStep {
    /// Warm reset through the in-app hooks (`marker` present).
    WarmHooks {
        cold: Option<ColdReason>,
    },
    /// Warm reset through an explicit legacy `resetAppDeepLink`.
    WarmDeepLink {
        link: String,
        cold: Option<ColdReason>,
    },
    Restart,
    Clear,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetPlan {
    pub first: FirstStep,
    /// Explanation attached when the requested mode could not be honoured
    /// as asked (e.g. warm requested, no hook available).
    pub reason: Option<String>,
    /// The rung a failed warm step falls to. Restart for explicit
    /// `device.resetApp()` calls (gentle: data kept); Clear for the runner's
    /// declared isolation policy, whose promise is state-clearing.
    pub warm_fallback: ResetMode,
    /// The `WarmFailureStreak` valve fired on a platform without cold hook
    /// delivery, so `first` is the restart/clear that stands in for it. That
    /// relaunch consumes the streak (see [`ResetPolicyState::consume_streak_valve`]):
    /// nothing warm runs in this reset, so [`ResetPolicyState::record`] alone
    /// would leave the streak at the limit and never try the hook again.
    pub consumes_warm_failure_streak: bool,
}

/// Inputs the daemon has when planning a reset.
pub struct PlanInput<'a> {
    pub mode: ResetMode,
    /// Marker read from the live hierarchy just now (None = read missed).
    pub marker: Option<&'a HooksMarker>,
    /// Marker seen earlier this session, kept because compiled-in hooks
    /// cannot vanish: when the live read misses (mid-transition tree, capture
    /// load), warm is still attempted against this remembered epoch/boot
    /// baseline — the epoch only advances when a reset is delivered, and the
    /// boot token covers an app that restarted unnoticed.
    pub remembered_marker: Option<&'a HooksMarker>,
    pub reset_deep_link: &'a str,
    pub force_cold: bool,
    pub cold_every_n: u32,
    /// Cold delivery is only a distinct concept on iOS simulators. Elsewhere a
    /// "cold" decision maps to a restart step so the bounded warm window
    /// still exists on every platform.
    pub supports_cold_delivery: bool,
    /// See [`ResetPlan::warm_fallback`].
    pub fallback_to_clear: bool,
    /// Whether the caller allows a heavier rung than warm at all. With it
    /// off, cold bounds on a platform without cold delivery are ignored
    /// (warm in place) rather than degraded to a restart the ladder would
    /// then have to refuse.
    pub allow_fallback: bool,
}

pub fn decide(state: &ResetPolicyState, input: &PlanInput<'_>) -> ResetPlan {
    let warm_fallback = if input.fallback_to_clear {
        ResetMode::Clear
    } else {
        ResetMode::Restart
    };
    let fallback_first = if input.fallback_to_clear {
        FirstStep::Clear
    } else {
        FirstStep::Restart
    };
    let fallback_verb = if input.fallback_to_clear {
        "cleared"
    } else {
        "restarted"
    };
    match input.mode {
        ResetMode::Restart => ResetPlan {
            first: FirstStep::Restart,
            reason: None,
            warm_fallback,
            consumes_warm_failure_streak: false,
        },
        ResetMode::Clear => ResetPlan {
            first: FirstStep::Clear,
            reason: None,
            warm_fallback,
            consumes_warm_failure_streak: false,
        },
        ResetMode::Warm => {
            let cold = state.cold_reason(input.force_cold, input.cold_every_n);
            let live_hooks = input.marker.is_some_and(HooksMarker::has_reset_hook);
            let remembered_hooks = input
                .remembered_marker
                .is_some_and(HooksMarker::has_reset_hook);
            let hook_available =
                live_hooks || remembered_hooks || !input.reset_deep_link.is_empty();
            if !hook_available {
                return ResetPlan {
                    first: fallback_first,
                    reason: Some(format!(
                        "warm reset requested but the app exposes no reset hook \
                         (@tapsmith/react-native or resetAppDeepLink); {fallback_verb} instead"
                    )),
                    warm_fallback,
                    consumes_warm_failure_streak: false,
                };
            }
            let cold = match (cold, input.supports_cold_delivery) {
                // A retry asks for cold *delivery* of the hook — the render-surface
                // recovery that matters on iOS simulators. Without cold delivery
                // there is nothing to force: deliver warm in place rather than
                // turning the retry into a restart/clear, which would change the
                // mode an explicit resetApp() reports between attempts.
                (Some(ColdReason::RetryAttempt), false) => None,
                (Some(reason), false) if input.allow_fallback => {
                    // No cold delivery on this platform: honour the bound with a
                    // restart (or a clear, when the caller's fallback promises
                    // state-clearing).
                    return ResetPlan {
                        first: fallback_first,
                        reason: Some(reason.describe()),
                        warm_fallback,
                        consumes_warm_failure_streak: matches!(
                            reason,
                            ColdReason::WarmFailureStreak(_)
                        ),
                    };
                }
                // Fallback disabled: the caller asked for exactly a warm reset.
                // The cold bounds are perf/recovery heuristics, not part of that
                // promise, and this platform's only stand-in for them is the
                // rung the caller ruled out — so deliver warm in place.
                (Some(_), false) => None,
                (cold, _) => cold,
            };
            if live_hooks || remembered_hooks {
                let mut reasons: Vec<String> = Vec::new();
                if !live_hooks {
                    // The live read missed but the hooks were seen earlier this
                    // session: attempt warm against the remembered epoch/boot
                    // baseline instead of giving up (the miss is a transient
                    // hierarchy gap, not a vanished hook).
                    reasons.push(
                        "live marker read missed; acknowledging against the epoch seen \
                         earlier this session"
                            .to_string(),
                    );
                }
                if let Some(c) = &cold {
                    reasons.push(c.describe());
                }
                ResetPlan {
                    first: FirstStep::WarmHooks { cold: cold.clone() },
                    reason: if reasons.is_empty() {
                        None
                    } else {
                        Some(reasons.join("; "))
                    },
                    warm_fallback,
                    consumes_warm_failure_streak: false,
                }
            } else {
                ResetPlan {
                    first: FirstStep::WarmDeepLink {
                        link: input.reset_deep_link.to_string(),
                        cold: cold.clone(),
                    },
                    reason: cold.map(|c| c.describe()),
                    warm_fallback,
                    consumes_warm_failure_streak: false,
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetStep {
    pub name: String,
    pub duration_ms: u64,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetOutcome {
    pub mode_used: ResetMode,
    pub fell_back: bool,
    /// The app process was recreated (cold deep-link delivery, restart, clear).
    pub cold_launch: bool,
    pub reason: Option<String>,
    pub steps: Vec<ResetStep>,
    pub epoch_after: Option<u64>,
    /// Set when every step failed; the ladder is exhausted.
    pub error: Option<String>,
}

/// What an acknowledged hooks reset observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WarmAck {
    /// The epoch the marker showed after the reset ran.
    pub epoch: u64,
    /// The marker's per-process `boot` token changed across the delivery:
    /// the app was relaunched on the way (the iOS simulator path falls back
    /// to a terminate → relaunch when the in-process link does not land), so
    /// the outcome is a cold launch even though the warm rung ran.
    pub process_recreated: bool,
}

/// Device work the ladder sequences. Each method performs one step and
/// returns a short human detail on success or the failure message.
#[async_trait]
pub trait ResetOps {
    /// Deliver the hooks reset link; resolve with what the ack observed.
    async fn warm_hooks(&self, cold: bool) -> Result<WarmAck, String>;
    /// Deliver the legacy reset deep link.
    async fn warm_deep_link(&self, link: &str, cold: bool) -> Result<(), String>;
    async fn restart(&self) -> Result<(), String>;
    async fn clear(&self) -> Result<(), String>;
}

pub async fn run_ladder(
    ops: &(impl ResetOps + Sync),
    plan: ResetPlan,
    allow_fallback: bool,
) -> ResetOutcome {
    let mut steps: Vec<ResetStep> = Vec::new();
    // A plan that could not honour the requested mode (warm asked for, but no
    // hook or link available) is already a fallback before any step runs.
    let mut fell_back =
        plan.reason.is_some() && matches!(plan.first, FirstStep::Restart | FirstStep::Clear);
    let warm_fallback = plan.warm_fallback;
    let mut reasons: Vec<String> = plan.reason.into_iter().collect();

    // The caller asked for exactly a warm reset and the plan already degraded
    // (no hook, or a platform that must honour the cold bound with a
    // restart): fail instead of quietly running the heavier rung. Honouring
    // `allow_fallback` only after a warm step had *run* let
    // `resetApp({ mode: 'warm', fallback: false })` silently restart hook-less
    // apps — caught by the hook-less CI suite on its first run.
    if fell_back && !allow_fallback {
        return ResetOutcome {
            mode_used: ResetMode::Warm,
            fell_back: false,
            cold_launch: false,
            reason: join(&reasons),
            steps,
            epoch_after: None,
            error: Some(match reasons.last() {
                Some(r) => format!("warm reset could not run and fallback is disabled: {r}"),
                None => "warm reset could not run and fallback is disabled".to_string(),
            }),
        };
    }

    async fn timed<T>(
        steps: &mut Vec<ResetStep>,
        name: &str,
        fut: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let t0 = Instant::now();
        let res = fut.await;
        steps.push(ResetStep {
            name: name.to_string(),
            duration_ms: t0.elapsed().as_millis() as u64,
            ok: res.is_ok(),
            detail: res.as_ref().err().cloned().unwrap_or_default(),
        });
        res
    }

    // Step 1 — warm.
    let mut next = match plan.first {
        FirstStep::WarmHooks { cold } => {
            let is_cold = cold.is_some();
            match timed(&mut steps, "warm-hooks", ops.warm_hooks(is_cold)).await {
                Ok(ack) => {
                    // A warm delivery that relaunched the app on its own is a
                    // cold launch: the policy's warm window restarts, and the
                    // caller learns the process is fresh.
                    if ack.process_recreated && !is_cold {
                        reasons.push(
                            "warm delivery relaunched the app (its boot token changed)".to_string(),
                        );
                    }
                    return ResetOutcome {
                        mode_used: ResetMode::Warm,
                        fell_back: false,
                        cold_launch: is_cold || ack.process_recreated,
                        reason: join(&reasons),
                        steps,
                        epoch_after: Some(ack.epoch),
                        error: None,
                    };
                }
                Err(e) => {
                    reasons.push(format!("warm reset via in-app hooks failed ({e})"));
                    Some(warm_fallback)
                }
            }
        }
        FirstStep::WarmDeepLink { link, cold } => {
            let is_cold = cold.is_some();
            match timed(
                &mut steps,
                "warm-deep-link",
                ops.warm_deep_link(&link, is_cold),
            )
            .await
            {
                Ok(()) => {
                    return ResetOutcome {
                        mode_used: ResetMode::Warm,
                        fell_back: false,
                        cold_launch: is_cold,
                        reason: join(&reasons),
                        steps,
                        epoch_after: None,
                        error: None,
                    };
                }
                Err(e) => {
                    reasons.push(format!("warm reset via resetAppDeepLink failed ({e})"));
                    Some(warm_fallback)
                }
            }
        }
        FirstStep::Restart => Some(ResetMode::Restart),
        FirstStep::Clear => Some(ResetMode::Clear),
    };
    // A warm first step that fell through is a fallback only if allowed.
    let warm_failed = matches!(steps.first(), Some(s) if !s.ok);
    if warm_failed {
        if !allow_fallback {
            return ResetOutcome {
                mode_used: ResetMode::Warm,
                fell_back: false,
                cold_launch: false,
                reason: join(&reasons),
                steps,
                epoch_after: None,
                error: Some("warm reset failed and fallback is disabled".to_string()),
            };
        }
        fell_back = true;
    }

    // Steps 2/3 — restart, then clear.
    while let Some(mode) = next {
        match mode {
            ResetMode::Restart => match timed(&mut steps, "restart", ops.restart()).await {
                Ok(()) => {
                    return ResetOutcome {
                        mode_used: ResetMode::Restart,
                        fell_back,
                        cold_launch: true,
                        reason: join(&reasons),
                        steps,
                        epoch_after: None,
                        error: None,
                    };
                }
                Err(e) => {
                    reasons.push(format!("restart failed ({e})"));
                    if !allow_fallback {
                        return ResetOutcome {
                            mode_used: ResetMode::Restart,
                            fell_back,
                            cold_launch: false,
                            reason: join(&reasons),
                            steps,
                            epoch_after: None,
                            error: Some(e),
                        };
                    }
                    fell_back = true;
                    next = Some(ResetMode::Clear);
                }
            },
            ResetMode::Clear => match timed(&mut steps, "clear", ops.clear()).await {
                Ok(()) => {
                    return ResetOutcome {
                        mode_used: ResetMode::Clear,
                        fell_back,
                        cold_launch: true,
                        reason: join(&reasons),
                        steps,
                        epoch_after: None,
                        error: None,
                    };
                }
                Err(e) => {
                    reasons.push(format!("clear failed ({e})"));
                    return ResetOutcome {
                        mode_used: ResetMode::Clear,
                        fell_back,
                        cold_launch: false,
                        reason: join(&reasons),
                        steps,
                        epoch_after: None,
                        error: Some(e),
                    };
                }
            },
            ResetMode::Warm => unreachable!("warm is only ever the first step"),
        }
    }
    unreachable!("ladder always returns from a step")
}

fn join(reasons: &[String]) -> Option<String> {
    if reasons.is_empty() {
        None
    } else {
        Some(reasons.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // ── marker ──

    #[test]
    fn parses_android_text_marker() {
        let xml = r#"<node text="tapsmith-hooks:1;epoch=4;url=myapp://" class="android.widget.TextView"/>"#;
        assert_eq!(
            parse_hooks_marker(xml),
            Some(HooksMarker {
                version: 1,
                epoch: 4,
                url_prefix: "myapp://".into(),
                err: None,
                nav: None,
                boot: None,
            })
        );
    }

    #[test]
    fn parses_ios_label_marker_with_escaped_ampersand_and_err() {
        let xml = r#"<XCUIElementTypeStaticText label="tapsmith-hooks:1;epoch=7;url=exp://192.168.1.2:8081/--/;err=AsyncStorage%20failed%3A%20boom&amp;x" />"#;
        let m = parse_hooks_marker(xml).unwrap();
        assert_eq!(m.epoch, 7);
        assert_eq!(m.url_prefix, "exp://192.168.1.2:8081/--/");
        assert_eq!(m.err.as_deref(), Some("AsyncStorage failed: boom&x"));
    }

    #[test]
    fn marker_absent_or_malformed_is_none() {
        assert_eq!(parse_hooks_marker("<node text=\"hello\"/>"), None);
        assert_eq!(
            parse_hooks_marker("<node text=\"tapsmith-hooks:1;url=x\"/>"),
            None
        );
        assert_eq!(
            parse_hooks_marker("<node text=\"tapsmith-hooks:abc;epoch=1\"/>"),
            None
        );
    }

    #[test]
    fn unknown_marker_version_is_none() {
        // A future v2 may change field semantics — it must degrade to
        // "no hooks", never be misparsed under v1 rules.
        assert_eq!(
            parse_hooks_marker("<node text=\"tapsmith-hooks:2;epoch=4;url=myapp://\"/>"),
            None
        );
        assert_eq!(
            parse_hooks_marker("<node text=\"tapsmith-hooks:0;epoch=4;url=myapp://\"/>"),
            None
        );
    }

    #[test]
    fn err_percent_decode_survives_multibyte_input() {
        // A hand-rolled marker can put a multibyte char right after `%`;
        // decoding must pass the `%` through instead of panicking.
        let xml = "<node text=\"tapsmith-hooks:1;epoch=2;url=myapp://;err=%aé%2‰x\"/>";
        let m = parse_hooks_marker(xml).unwrap();
        assert_eq!(m.err.as_deref(), Some("%aé%2‰x"));
    }

    #[test]
    fn marker_with_empty_url_parses_but_has_no_prefix() {
        let m = parse_hooks_marker("<node text=\"tapsmith-hooks:1;epoch=0;url=\"/>").unwrap();
        assert_eq!(m.url_prefix, "");
        assert_eq!(m.err, None);
    }

    #[test]
    fn builds_reset_urls_for_scheme_and_expo_prefixes() {
        assert_eq!(
            build_reset_url("myapp:///", "/", "n1"),
            "myapp:///?__tapsmith_reset=1&nonce=n1"
        );
        assert_eq!(
            build_reset_url("myapp:///", "/login", "n2"),
            "myapp:///login?__tapsmith_reset=1&nonce=n2"
        );
        assert_eq!(
            build_reset_url("myapp://", "login", "n2b"),
            "myapp://login?__tapsmith_reset=1&nonce=n2b"
        );
        assert_eq!(
            build_reset_url("exp://10.0.0.5:8081/--/", "settings?tab=2", "n3"),
            "exp://10.0.0.5:8081/--/settings?tab=2&__tapsmith_reset=1&nonce=n3"
        );
        assert_eq!(
            build_reset_url("myapp:///", "", "n4"),
            "myapp:///?__tapsmith_reset=1&nonce=n4"
        );
    }

    // ── policy ──

    #[test]
    fn parses_nav_counter_and_acks_navigation() {
        let m = parse_hooks_marker(
            r#"<node text="tapsmith-hooks:1;epoch=2;nav=5;boot=abcd1234;url=app:///" />"#,
        )
        .unwrap();
        assert_eq!(m.nav, Some(5));
        assert!(nav_acknowledged(4, Some("abcd1234"), &m));
        assert!(!nav_acknowledged(5, Some("abcd1234"), &m));
        // Fresh process (boot changed): any nav >= 1 acknowledges.
        assert!(nav_acknowledged(9, Some("00000000"), &m));
        // Marker from an older app build without nav never acknowledges.
        let old =
            parse_hooks_marker(r#"<node text="tapsmith-hooks:1;epoch=2;url=app:///" />"#).unwrap();
        assert!(!nav_acknowledged(0, None, &old));
    }

    #[test]
    fn parses_boot_token() {
        let m = parse_hooks_marker(
            r#"<node text="tapsmith-hooks:1;epoch=3;boot=a1b2c3d4;url=app:///" />"#,
        )
        .unwrap();
        assert_eq!(m.epoch, 3);
        assert_eq!(m.boot.as_deref(), Some("a1b2c3d4"));
        let legacy =
            parse_hooks_marker(r#"<node text="tapsmith-hooks:1;epoch=3;url=app:///" />"#).unwrap();
        assert_eq!(legacy.boot, None);
    }

    #[test]
    fn ack_rule_handles_relaunch() {
        let after = |epoch: u64, boot: Option<&str>| HooksMarker {
            version: 1,
            epoch,
            url_prefix: "app:///".into(),
            err: None,
            nav: None,
            boot: boot.map(str::to_string),
        };
        // Same process: epoch must advance.
        assert!(hooks_acknowledged(
            10,
            Some("aaaa"),
            &after(11, Some("aaaa"))
        ));
        assert!(!hooks_acknowledged(
            10,
            Some("aaaa"),
            &after(10, Some("aaaa"))
        ));
        // Relaunched process: counter restarted, any epoch ≥ 1 acks.
        assert!(hooks_acknowledged(
            10,
            Some("aaaa"),
            &after(1, Some("bbbb"))
        ));
        assert!(!hooks_acknowledged(
            10,
            Some("aaaa"),
            &after(0, Some("bbbb"))
        ));
        // Retry-forced cold after a single warm reset: 1 → 1 is still an ack.
        assert!(hooks_acknowledged(1, Some("aaaa"), &after(1, Some("bbbb"))));
        // Legacy markers without boot fall back to the strict rule.
        assert!(!hooks_acknowledged(10, None, &after(1, None)));
        assert!(hooks_acknowledged(10, None, &after(11, None)));
    }

    fn marker() -> HooksMarker {
        HooksMarker {
            version: 1,
            epoch: 3,
            url_prefix: "app://".into(),
            err: None,
            nav: None,
            boot: None,
        }
    }

    fn input<'a>(mode: ResetMode, marker: Option<&'a HooksMarker>, link: &'a str) -> PlanInput<'a> {
        PlanInput {
            mode,
            marker,
            remembered_marker: None,
            reset_deep_link: link,
            force_cold: false,
            cold_every_n: 10,
            supports_cold_delivery: true,
            fallback_to_clear: false,
            allow_fallback: true,
        }
    }

    #[tokio::test]
    async fn warm_that_cannot_start_fails_when_fallback_is_disabled() {
        // resetApp({ mode: 'warm', fallback: false }) on a hook-less app must
        // throw, not quietly restart — "exactly a warm, or throw".
        let ops = MockOps::new();
        let plan = decide(
            &ResetPolicyState::default(),
            &input(ResetMode::Warm, None, ""),
        );
        let out = run_ladder(&ops, plan, false).await;
        assert!(out
            .error
            .as_deref()
            .unwrap_or("")
            .contains("fallback is disabled"));
        assert!(ops.calls().is_empty(), "no rung may run: {:?}", ops.calls());
    }

    #[test]
    fn missed_live_read_still_plans_warm_against_the_remembered_baseline() {
        // A mid-transition hierarchy misses the marker; hooks seen earlier
        // this session must keep warm alive (epoch only advances when a reset
        // is delivered; a relaunch is covered by the boot token), instead of
        // silently downgrading isolation to a restart.
        let m = marker();
        let plan = decide(
            &ResetPolicyState::default(),
            &PlanInput {
                remembered_marker: Some(&m),
                ..input(ResetMode::Warm, None, "")
            },
        );
        assert_eq!(plan.first, FirstStep::WarmHooks { cold: None });
        assert!(plan
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("live marker read missed"));
    }

    #[test]
    fn policy_resets_fall_back_to_clear_not_restart() {
        // The runner's warm policy promises state-clearing; when warm cannot
        // run, a restart (data kept) does not deliver it — clear does.
        let plan = decide(
            &ResetPolicyState::default(),
            &PlanInput {
                fallback_to_clear: true,
                allow_fallback: true,
                ..input(ResetMode::Warm, None, "")
            },
        );
        assert_eq!(plan.first, FirstStep::Clear);
        assert_eq!(plan.warm_fallback, ResetMode::Clear);
        assert!(plan
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("cleared instead"));
    }

    #[tokio::test]
    async fn a_failed_warm_delivery_falls_to_clear_when_the_policy_asks() {
        let mut ops = MockOps::new();
        ops.warm = Err("epoch did not advance".into());
        let m = marker();
        let plan = decide(
            &ResetPolicyState::default(),
            &PlanInput {
                fallback_to_clear: true,
                allow_fallback: true,
                ..input(ResetMode::Warm, Some(&m), "")
            },
        );
        let out = run_ladder(&ops, plan, true).await;
        assert_eq!(out.mode_used, ResetMode::Clear);
        assert!(out.fell_back);
        assert_eq!(ops.calls(), vec!["warm_hooks(cold=false)", "clear"]);
    }

    #[test]
    fn warm_with_hooks_stays_warm_by_default() {
        let m = marker();
        let plan = decide(
            &ResetPolicyState::default(),
            &input(ResetMode::Warm, Some(&m), ""),
        );
        assert_eq!(plan.first, FirstStep::WarmHooks { cold: None });
        assert_eq!(plan.reason, None);
    }

    #[test]
    fn warm_without_any_hook_restarts_and_explains() {
        let plan = decide(
            &ResetPolicyState::default(),
            &input(ResetMode::Warm, None, ""),
        );
        assert_eq!(plan.first, FirstStep::Restart);
        assert!(plan.reason.unwrap().contains("no reset hook"));
    }

    #[test]
    fn warm_prefers_hooks_over_legacy_link_and_falls_back_to_link() {
        let m = marker();
        let plan = decide(
            &ResetPolicyState::default(),
            &input(ResetMode::Warm, Some(&m), "app:///__reset"),
        );
        assert!(matches!(plan.first, FirstStep::WarmHooks { .. }));
        let plan = decide(
            &ResetPolicyState::default(),
            &input(ResetMode::Warm, None, "app:///__reset"),
        );
        assert_eq!(
            plan.first,
            FirstStep::WarmDeepLink {
                link: "app:///__reset".into(),
                cold: None
            }
        );
    }

    #[test]
    fn cold_triggers_retry_streak_and_window() {
        let m = marker();
        let mut i = input(ResetMode::Warm, Some(&m), "");
        i.force_cold = true;
        let plan = decide(&ResetPolicyState::default(), &i);
        assert_eq!(
            plan.first,
            FirstStep::WarmHooks {
                cold: Some(ColdReason::RetryAttempt)
            }
        );
        assert_eq!(plan.reason.as_deref(), Some("cold relaunch: retry attempt"));

        let streak = ResetPolicyState {
            warm_resets_since_cold: 1,
            consecutive_warm_failures: 2,
            valve_relaunches: 0,
        };
        let plan = decide(&streak, &input(ResetMode::Warm, Some(&m), ""));
        assert_eq!(
            plan.first,
            FirstStep::WarmHooks {
                cold: Some(ColdReason::WarmFailureStreak(2))
            }
        );

        let bound = ResetPolicyState {
            warm_resets_since_cold: 10,
            consecutive_warm_failures: 0,
            valve_relaunches: 0,
        };
        let plan = decide(&bound, &input(ResetMode::Warm, Some(&m), ""));
        assert_eq!(
            plan.reason.as_deref(),
            Some("cold relaunch: warm-window bound reached (10 resets)")
        );
        let mut off = input(ResetMode::Warm, Some(&m), "");
        off.cold_every_n = 0;
        assert_eq!(
            decide(&bound, &off).first,
            FirstStep::WarmHooks { cold: None }
        );
    }

    #[test]
    fn cold_without_cold_delivery_maps_to_restart() {
        // Health-driven bounds (window, streak) stand in a restart for the
        // missing cold delivery ...
        let m = marker();
        let mut i = input(ResetMode::Warm, Some(&m), "");
        i.supports_cold_delivery = false;
        let bound = ResetPolicyState {
            warm_resets_since_cold: 10,
            consecutive_warm_failures: 0,
            valve_relaunches: 0,
        };
        let plan = decide(&bound, &i);
        assert_eq!(plan.first, FirstStep::Restart);
        assert_eq!(
            plan.reason.as_deref(),
            Some("cold relaunch: warm-window bound reached (10 resets)")
        );
        // ... but a retry only asks for cold delivery, so it stays warm in place.
        i.force_cold = true;
        let plan = decide(&ResetPolicyState::default(), &i);
        assert_eq!(plan.first, FirstStep::WarmHooks { cold: None });
        assert_eq!(plan.reason, None);
    }

    #[test]
    fn streak_valve_without_cold_delivery_is_consumed_by_its_relaunch() {
        // Android / physical iOS: the valve's stand-in is a restart (or clear),
        // which runs nothing warm — so `record` alone would leave the streak at
        // the limit and re-fire the valve on every reset for the session.
        let m = marker();
        let no_cold = |force_cold: bool| {
            let mut i = input(ResetMode::Warm, Some(&m), "");
            i.supports_cold_delivery = false;
            i.force_cold = force_cold;
            i
        };
        let mut s = ResetPolicyState::default();
        s.record_warm_failure();
        s.record_warm_failure();
        let plan = decide(&s, &no_cold(false));
        assert_eq!(plan.first, FirstStep::Restart);
        assert!(plan.consumes_warm_failure_streak);
        // Only the streak valve consumes; a retry or warm-window bound does not.
        assert!(!decide(&ResetPolicyState::default(), &no_cold(true)).consumes_warm_failure_streak);
        let bound = ResetPolicyState {
            warm_resets_since_cold: 10,
            consecutive_warm_failures: 0,
            valve_relaunches: 0,
        };
        assert!(!decide(&bound, &no_cold(false)).consumes_warm_failure_streak);
        // With cold delivery the hook itself is exercised (and its success
        // clears the streak), so nothing extra is consumed.
        assert!(!decide(&s, &input(ResetMode::Warm, Some(&m), "")).consumes_warm_failure_streak);

        s.consume_streak_valve();
        assert_eq!(s.cold_reason(false, 10), None);
        assert_eq!(
            decide(&s, &no_cold(false)).first,
            FirstStep::WarmHooks { cold: None }
        );

        // Re-arming is bounded: a hook that fails the streak again after
        // MAX_STREAK_VALVE_RELAUNCHES fresh processes stays latched ...
        for _ in 1..MAX_STREAK_VALVE_RELAUNCHES {
            s.record_warm_failure();
            s.record_warm_failure();
            s.consume_streak_valve();
        }
        assert_eq!(
            s.cold_reason(false, 10),
            Some(ColdReason::WarmFailureStreak(2))
        );
        s.consume_streak_valve();
        assert_eq!(
            s.cold_reason(false, 10),
            Some(ColdReason::WarmFailureStreak(2))
        );
        // ... until a warm success (e.g. after a device change resets the
        // state, or the hook recovers) clears both counters.
        s.record(&ResetOutcome {
            mode_used: ResetMode::Warm,
            fell_back: false,
            cold_launch: false,
            reason: None,
            steps: vec![],
            epoch_after: Some(1),
            error: None,
        });
        assert_eq!(s.consecutive_warm_failures, 0);
        assert_eq!(s.valve_relaunches, 0);
        assert_eq!(s.cold_reason(false, 10), None);
    }

    #[test]
    fn fallback_disabled_ignores_cold_bounds_without_cold_delivery() {
        // `resetApp({ mode: 'warm', fallback: false })` on Android: the warm
        // window bound / retry / streak have no cold delivery to force, and
        // their stand-in restart is exactly what the caller ruled out. Warm in
        // place instead of an error on the tenth call.
        let m = marker();
        let mut i = input(ResetMode::Warm, Some(&m), "");
        i.supports_cold_delivery = false;
        i.allow_fallback = false;
        i.force_cold = true;
        let plan = decide(&ResetPolicyState::default(), &i);
        assert_eq!(plan.first, FirstStep::WarmHooks { cold: None });
        assert_eq!(plan.reason, None);
        i.force_cold = false;
        let bound = ResetPolicyState {
            warm_resets_since_cold: 10,
            consecutive_warm_failures: 2,
            valve_relaunches: 0,
        };
        assert_eq!(
            decide(&bound, &i).first,
            FirstStep::WarmHooks { cold: None }
        );
        // With cold delivery the bound is honoured as a cold-delivered hook,
        // which is still a warm reset.
        i.supports_cold_delivery = true;
        assert_eq!(
            decide(&bound, &i).first,
            FirstStep::WarmHooks {
                cold: Some(ColdReason::WarmFailureStreak(2))
            }
        );
    }

    #[test]
    fn explicit_restart_and_clear_ignore_hooks() {
        let m = marker();
        assert_eq!(
            decide(
                &ResetPolicyState::default(),
                &input(ResetMode::Restart, Some(&m), "")
            )
            .first,
            FirstStep::Restart
        );
        assert_eq!(
            decide(
                &ResetPolicyState::default(),
                &input(ResetMode::Clear, Some(&m), "")
            )
            .first,
            FirstStep::Clear
        );
    }

    #[test]
    fn state_records_outcomes() {
        let mut s = ResetPolicyState::default();
        let warm = ResetOutcome {
            mode_used: ResetMode::Warm,
            fell_back: false,
            cold_launch: false,
            reason: None,
            steps: vec![],
            epoch_after: Some(1),
            error: None,
        };
        s.record(&warm);
        s.record(&warm);
        assert_eq!(s.warm_resets_since_cold, 2);
        s.record_warm_failure();
        assert_eq!(s.consecutive_warm_failures, 1);
        // A restart recovery restarts the warm window but does not clear the
        // failure streak — nothing warm succeeded.
        let restart = ResetOutcome {
            mode_used: ResetMode::Restart,
            fell_back: true,
            cold_launch: true,
            ..warm.clone()
        };
        s.record(&restart);
        assert_eq!(s.warm_resets_since_cold, 0);
        assert_eq!(s.consecutive_warm_failures, 1);
        // A cold-delivered hook that acknowledged is a warm success: it
        // clears the streak and (being a relaunch) restarts the window.
        let cold = ResetOutcome {
            cold_launch: true,
            mode_used: ResetMode::Warm,
            ..warm.clone()
        };
        s.record(&cold);
        assert_eq!(s, ResetPolicyState::default());
    }

    /// The daemon records a warm failure and then the ladder's final outcome
    /// on every reset. Two warm failures each recovered by a restart (the
    /// default `allowFallback: true` path) must still trip the streak valve.
    #[test]
    fn warm_failure_streak_survives_fallback_recovery() {
        let mut s = ResetPolicyState::default();
        let recovered = ResetOutcome {
            mode_used: ResetMode::Restart,
            fell_back: true,
            cold_launch: true,
            reason: Some("warm reset via in-app hooks failed (timeout)".to_string()),
            steps: vec![
                ResetStep {
                    name: "warm-hooks".to_string(),
                    duration_ms: 3000,
                    ok: false,
                    detail: "timeout".to_string(),
                },
                ResetStep {
                    name: "restart".to_string(),
                    duration_ms: 900,
                    ok: true,
                    detail: String::new(),
                },
            ],
            epoch_after: None,
            error: None,
        };
        s.record_warm_failure();
        s.record(&recovered);
        assert_eq!(s.cold_reason(false, 10), None);
        s.record_warm_failure();
        s.record(&recovered);
        assert_eq!(
            s.cold_reason(false, 10),
            Some(ColdReason::WarmFailureStreak(2))
        );
        // The same through a clear recovery.
        let cleared = ResetOutcome {
            mode_used: ResetMode::Clear,
            ..recovered.clone()
        };
        s.record_warm_failure();
        s.record(&cleared);
        assert_eq!(
            s.cold_reason(false, 10),
            Some(ColdReason::WarmFailureStreak(3))
        );
        // One acknowledged warm reset (cold-delivered, as the valve requests)
        // clears the streak so the next reset is warm again.
        let acked = ResetOutcome {
            mode_used: ResetMode::Warm,
            fell_back: false,
            cold_launch: true,
            reason: None,
            steps: vec![],
            epoch_after: Some(1),
            error: None,
        };
        s.record(&acked);
        assert_eq!(s, ResetPolicyState::default());
        assert_eq!(s.cold_reason(false, 10), None);
    }

    #[test]
    fn empty_url_marker_is_not_a_reset_hook() {
        let m = parse_hooks_marker("<node text=\"tapsmith-hooks:1;epoch=3;url=\"/>").unwrap();
        assert!(!m.has_reset_hook());
        // With a legacy link configured the plan falls to the deep-link rung
        // (no epoch acknowledgement); without one it cannot start warm at all.
        assert!(matches!(
            decide(
                &ResetPolicyState::default(),
                &input(ResetMode::Warm, Some(&m), "myapp://reset")
            )
            .first,
            FirstStep::WarmDeepLink { .. }
        ));
        assert_eq!(
            decide(
                &ResetPolicyState::default(),
                &input(ResetMode::Warm, Some(&m), "")
            )
            .first,
            FirstStep::Restart
        );
    }

    // ── ladder ──

    struct MockOps {
        warm: Result<WarmAck, String>,
        link: Result<(), String>,
        restart: Result<(), String>,
        clear: Result<(), String>,
        calls: Mutex<Vec<String>>,
    }

    impl MockOps {
        fn new() -> Self {
            Self {
                warm: Ok(WarmAck {
                    epoch: 5,
                    process_recreated: false,
                }),
                link: Ok(()),
                restart: Ok(()),
                clear: Ok(()),
                calls: Mutex::new(vec![]),
            }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl ResetOps for MockOps {
        async fn warm_hooks(&self, cold: bool) -> Result<WarmAck, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("warm_hooks(cold={cold})"));
            self.warm.clone()
        }
        async fn warm_deep_link(&self, link: &str, cold: bool) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("warm_deep_link({link},cold={cold})"));
            self.link.clone()
        }
        async fn restart(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("restart".into());
            self.restart.clone()
        }
        async fn clear(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("clear".into());
            self.clear.clone()
        }
    }

    fn plan(first: FirstStep) -> ResetPlan {
        ResetPlan {
            first,
            reason: None,
            warm_fallback: ResetMode::Restart,
            consumes_warm_failure_streak: false,
        }
    }

    #[tokio::test]
    async fn warm_requested_without_hooks_is_reported_as_a_fallback() {
        // The app is not running (or exposes no hook): the plan starts at
        // restart, but the caller asked for warm — that is a fallback, and
        // the outcome must say so (the runner records a summary row for it).
        let ops = MockOps::new();
        let plan = decide(
            &ResetPolicyState::default(),
            &input(ResetMode::Warm, None, ""),
        );
        let out = run_ladder(&ops, plan, true).await;
        assert_eq!(out.mode_used, ResetMode::Restart);
        assert!(out.fell_back);
        assert!(out
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("no reset hook"));
        assert_eq!(ops.calls(), vec!["restart"]);
    }

    #[tokio::test]
    async fn warm_hooks_success_is_terminal() {
        let ops = MockOps::new();
        let out = run_ladder(&ops, plan(FirstStep::WarmHooks { cold: None }), true).await;
        assert_eq!(out.mode_used, ResetMode::Warm);
        assert!(!out.fell_back && !out.cold_launch && out.error.is_none());
        assert_eq!(out.epoch_after, Some(5));
        assert_eq!(ops.calls(), vec!["warm_hooks(cold=false)"]);
        assert_eq!(out.steps.len(), 1);
        assert!(out.steps[0].ok);
    }

    #[tokio::test]
    async fn cold_warm_delivery_counts_as_cold_launch() {
        let ops = MockOps::new();
        let out = run_ladder(
            &ops,
            ResetPlan {
                first: FirstStep::WarmHooks {
                    cold: Some(ColdReason::RetryAttempt),
                },
                reason: Some("cold relaunch: retry attempt".into()),
                warm_fallback: ResetMode::Restart,
                consumes_warm_failure_streak: false,
            },
            true,
        )
        .await;
        assert!(out.cold_launch);
        assert_eq!(out.reason.as_deref(), Some("cold relaunch: retry attempt"));
        assert_eq!(ops.calls(), vec!["warm_hooks(cold=true)"]);
    }

    #[tokio::test]
    async fn warm_delivery_that_recreated_the_process_counts_as_cold_launch() {
        // The iOS simulator path can fall back to a terminate → relaunch inside
        // a "warm" delivery; the ack sees a new boot token. The rung is still
        // warm and did not fall back, but the process is fresh — the outcome
        // must say so, or the warm-window valve counts a cold launch as warm.
        let mut ops = MockOps::new();
        ops.warm = Ok(WarmAck {
            epoch: 1,
            process_recreated: true,
        });
        let out = run_ladder(&ops, plan(FirstStep::WarmHooks { cold: None }), true).await;
        assert_eq!(out.mode_used, ResetMode::Warm);
        assert!(!out.fell_back && out.cold_launch && out.error.is_none());
        assert_eq!(out.epoch_after, Some(1));
        assert!(out
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("relaunched the app"));

        // And the policy state treats it like any other cold launch.
        let mut state = ResetPolicyState::default();
        state.warm_resets_since_cold = 4;
        state.record(&out);
        assert_eq!(state.warm_resets_since_cold, 0);
    }

    #[tokio::test]
    async fn warm_failure_falls_back_to_restart_with_reason() {
        let mut ops = MockOps::new();
        ops.warm = Err("epoch did not advance within 3000ms".into());
        let out = run_ladder(&ops, plan(FirstStep::WarmHooks { cold: None }), true).await;
        assert_eq!(out.mode_used, ResetMode::Restart);
        assert!(out.fell_back && out.cold_launch && out.error.is_none());
        assert_eq!(
            out.reason.as_deref(),
            Some("warm reset via in-app hooks failed (epoch did not advance within 3000ms)")
        );
        assert_eq!(ops.calls(), vec!["warm_hooks(cold=false)", "restart"]);
        assert_eq!(
            out.steps
                .iter()
                .map(|s| (s.name.as_str(), s.ok))
                .collect::<Vec<_>>(),
            vec![("warm-hooks", false), ("restart", true)]
        );
    }

    #[tokio::test]
    async fn warm_failure_without_fallback_is_an_error() {
        let mut ops = MockOps::new();
        ops.link = Err("no ui change".into());
        let out = run_ladder(
            &ops,
            plan(FirstStep::WarmDeepLink {
                link: "app:///__reset".into(),
                cold: None,
            }),
            false,
        )
        .await;
        assert!(out.error.is_some());
        assert_eq!(
            ops.calls(),
            vec!["warm_deep_link(app:///__reset,cold=false)"]
        );
    }

    #[tokio::test]
    async fn restart_failure_escalates_to_clear_then_exhausts() {
        let mut ops = MockOps::new();
        ops.restart = Err("launch failed".into());
        let out = run_ladder(&ops, plan(FirstStep::Restart), true).await;
        assert_eq!(out.mode_used, ResetMode::Clear);
        assert!(out.fell_back && out.cold_launch && out.error.is_none());
        assert_eq!(ops.calls(), vec!["restart", "clear"]);

        let mut ops = MockOps::new();
        ops.restart = Err("launch failed".into());
        ops.clear = Err("pm clear failed".into());
        let out = run_ladder(&ops, plan(FirstStep::Restart), true).await;
        assert_eq!(out.error.as_deref(), Some("pm clear failed"));
        assert_eq!(
            out.reason.as_deref(),
            Some("restart failed (launch failed); clear failed (pm clear failed)")
        );
    }

    #[tokio::test]
    async fn explicit_clear_runs_only_clear() {
        let ops = MockOps::new();
        let out = run_ladder(&ops, plan(FirstStep::Clear), false).await;
        assert_eq!(out.mode_used, ResetMode::Clear);
        assert!(!out.fell_back);
        assert_eq!(ops.calls(), vec!["clear"]);
    }
}
