//! Lightweight opt-in timing instrumentation for performance investigation.
//!
//! Enabled only when the `TAPSMITH_TIMING_LOG` env var points at a file;
//! otherwise every call is a cheap no-op. Logs go to a file (not `tracing`)
//! because the SDK spawns the daemon with `stdio: 'ignore'`, so stderr/stdout
//! would be discarded. Used to break down where iOS e2e wall-clock goes
//! (agent boot vs. per-command device latency vs. app reset).
//!
//! Line format (one per event, easy to grep/aggregate):
//!   [TIMING] pid=<n> kind=<boot|cmd|reset> name=<str> dur_ms=<n> ok=<bool> ...

use std::io::Write;
use std::sync::OnceLock;

fn timing_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        let path = std::env::var("TAPSMITH_TIMING_LOG").ok()?;
        // Create the parent directory once, up front, so per-write opens don't
        // fail silently when the caller points at a not-yet-existing dir.
        if let Some(parent) = std::path::Path::new(&path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        Some(path)
    })
    .as_deref()
}

/// Whether timing capture is enabled. Cheap (reads a cached `OnceLock`).
/// Callers should gate any non-trivial work that only exists to build a
/// timing line behind this, since macro arguments are evaluated eagerly.
pub fn enabled() -> bool {
    timing_path().is_some()
}

/// Append one timing line to the configured log file. No-op when
/// `TAPSMITH_TIMING_LOG` is unset. Opens-appends per call: this is low
/// frequency (one line per agent command) so the simplicity is worth it, and
/// O_APPEND writes of short lines are atomic enough for our aggregation.
pub fn log(fields: std::fmt::Arguments<'_>) {
    let Some(path) = timing_path() else {
        return;
    };
    let pid = std::process::id();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        // Format the whole line first, then emit it in a single `write_all`.
        // Under O_APPEND a one-shot write keeps concurrent writers' lines from
        // interleaving, which `writeln!`'s multiple syscalls would allow.
        let line = format!("[TIMING] pid={pid} {fields}\n");
        let _ = f.write_all(line.as_bytes());
    }
}

/// Convenience macro mirroring `format!` arg syntax.
macro_rules! timing_log {
    ($($arg:tt)*) => {
        $crate::timing::log(format_args!($($arg)*))
    };
}
pub(crate) use timing_log;

/// Times the phases of one operation (an app-state save, say) and logs them
/// as a single line when dropped, so every exit — early error returns
/// included — is recorded:
/// `kind=<kind> name=<name> dur_ms=<n> ok=<bool> <phase>_ms=<n>… <key>=<value>…`.
/// `ok` stays false unless [`PhaseTimer::succeed`] was called. Costs a few
/// `Instant` reads when `TAPSMITH_TIMING_LOG` is unset.
pub struct PhaseTimer {
    kind: &'static str,
    name: &'static str,
    started: std::time::Instant,
    last: std::time::Instant,
    phases: Vec<(&'static str, u128)>,
    notes: Vec<(&'static str, String)>,
    ok: bool,
}

impl PhaseTimer {
    pub fn new(kind: &'static str, name: &'static str) -> Self {
        let now = std::time::Instant::now();
        Self {
            kind,
            name,
            started: now,
            last: now,
            phases: Vec::new(),
            notes: Vec::new(),
            ok: false,
        }
    }

    /// Record the time since the previous phase ended (or the timer
    /// started) as `<phase>_ms`.
    pub fn phase(&mut self, phase: &'static str) {
        let now = std::time::Instant::now();
        self.phases
            .push((phase, now.duration_since(self.last).as_millis()));
        self.last = now;
    }

    /// Record `key=value`. The value should hold no spaces, to keep the line
    /// greppable.
    pub fn note(&mut self, key: &'static str, value: impl std::fmt::Display) {
        self.notes.push((key, value.to_string()));
    }

    pub fn succeed(&mut self) {
        self.ok = true;
    }

    fn render(&self, dur_ms: u128) -> String {
        let mut line = format!(
            "kind={} name={} dur_ms={dur_ms} ok={}",
            self.kind, self.name, self.ok
        );
        for (phase, ms) in &self.phases {
            line.push_str(&format!(" {phase}_ms={ms}"));
        }
        for (key, value) in &self.notes {
            line.push_str(&format!(" {key}={value}"));
        }
        line
    }
}

impl Drop for PhaseTimer {
    fn drop(&mut self) {
        if !enabled() {
            return;
        }
        let line = self.render(self.started.elapsed().as_millis());
        log(format_args!("{line}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phase_timer_line_lists_phases_then_notes() {
        let mut timer = PhaseTimer::new("appstate", "restore");
        timer.phase("terminate");
        timer.phase("extract");
        timer.note("keychain", "reset");
        let line = timer.render(42);
        assert!(
            line.starts_with("kind=appstate name=restore dur_ms=42 ok=false terminate_ms="),
            "{line}"
        );
        let extract = line.find(" extract_ms=").expect(&line);
        let keychain = line.find(" keychain=reset").expect(&line);
        assert!(extract < keychain, "{line}");
        timer.succeed();
        assert!(timer.render(42).contains(" ok=true "));
    }
}
