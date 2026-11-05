//! Reads whether the Android soft keyboard is shown.
//!
//! `mInputShown` comes from the input method service's dump. A plain `dumpsys
//! input_method` also asks the focused app and the keyboard's own process to
//! dump themselves, and waits about 5 s for each. Gboard's dump alone can be
//! a megabyte with internal waits, and either process may be busy, so the read
//! could stall on work unrelated to the flag. The critical section is
//! answered by system_server alone, before those calls.

use std::future::Future;
use std::time::Duration;

use anyhow::{anyhow, Result};
use tracing::warn;

use crate::adb::AdbTimeout;

/// Android 10+ stops before dumping other processes. Older versions ignore the
/// arguments and print the full dump, which also carries the flag.
const IME_STATE_COMMAND: &str = "dumpsys input_method --dump-priority CRITICAL";
const FULL_DUMP_COMMAND: &str = "dumpsys input_method";

/// One read per entry, on timeout only. The read changes nothing on the device,
/// so repeating it is safe, and a loaded device gets more time on the second.
const ATTEMPT_TIMEOUTS: [Duration; 2] = [Duration::from_secs(5), Duration::from_secs(10)];

/// Whether the keyboard is shown, reading through `shell` (a strict adb shell
/// with a timeout, so a transport or dumpsys failure is an error). A dump that
/// completes but never mentions the flag reads as "hidden".
pub async fn keyboard_shown<S, Fut>(serial: &str, shell: S) -> Result<bool>
where
    S: Fn(&'static str, Duration) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    let output = read_with_retry(serial, IME_STATE_COMMAND, &shell).await?;
    if let Some(shown) = input_shown(&output) {
        return Ok(shown);
    }
    // We can only run this on the Android versions we have, so a build that
    // leaves the flag out of the critical section must not read as "hidden".
    let output = read_with_retry(serial, FULL_DUMP_COMMAND, &shell).await?;
    Ok(input_shown(&output).unwrap_or_else(|| {
        warn!(%serial, "dumpsys input_method has no mInputShown; reporting the keyboard as hidden");
        false
    }))
}

async fn read_with_retry<S, Fut>(serial: &str, command: &'static str, shell: &S) -> Result<String>
where
    S: Fn(&'static str, Duration) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    for timeout in ATTEMPT_TIMEOUTS {
        match shell(command, timeout).await {
            Err(e) if e.downcast_ref::<AdbTimeout>().is_some() => {}
            // dumpsys gives up on a stuck service after 10 s of its own and
            // still exits 0, which is no answer at all.
            Ok(output) if input_shown(&output).is_none() && output.contains("DUMP TIMEOUT") => {}
            result => return result,
        }
        warn!(%serial, command, ?timeout, "Reading the keyboard state timed out");
    }
    let total: Duration = ATTEMPT_TIMEOUTS.iter().sum();
    Err(anyhow!(
        "Could not read the Android keyboard state on {serial}: `adb shell {command}` did not \
         answer within {total:?} ({} attempts). The device is overloaded or unresponsive. Check \
         that it responds with `adb -s {serial} shell echo ok`. On a slow machine or CI runner, \
         give the emulator more CPU or run fewer workers.",
        ATTEMPT_TIMEOUTS.len()
    ))
}

fn input_shown(dump: &str) -> Option<bool> {
    if dump.contains("mInputShown=true") {
        Some(true)
    } else if dump.contains("mInputShown=false") {
        Some(false)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// Answers shell calls from a script and records what was asked.
    struct FakeShell {
        answers: Mutex<VecDeque<Result<String>>>,
        calls: Mutex<Vec<(&'static str, Duration)>>,
    }

    impl FakeShell {
        fn new(answers: Vec<Result<String>>) -> Self {
            Self {
                answers: Mutex::new(answers.into()),
                calls: Mutex::new(Vec::new()),
            }
        }

        async fn read(&self) -> Result<bool> {
            keyboard_shown("emulator-5554", |command, timeout| {
                self.calls.lock().unwrap().push((command, timeout));
                let answer = self.answers.lock().unwrap().pop_front();
                async move { answer.expect("no scripted answer left") }
            })
            .await
        }

        fn calls(&self) -> Vec<(&'static str, Duration)> {
            self.calls.lock().unwrap().clone()
        }
    }

    fn dump(flag: &str) -> Result<String> {
        Ok(format!(
            "Input Method Manager Service state:\n  mShowForced=false {flag}\n"
        ))
    }

    fn timed_out() -> Result<String> {
        Err(anyhow::Error::new(AdbTimeout(Duration::from_secs(5))))
    }

    #[tokio::test]
    async fn reads_the_flag_without_asking_other_processes_to_dump() {
        let shell = FakeShell::new(vec![dump("mInputShown=true")]);
        assert!(shell.read().await.unwrap());
        assert_eq!(
            shell.calls(),
            vec![(
                "dumpsys input_method --dump-priority CRITICAL",
                Duration::from_secs(5)
            )]
        );

        let shell = FakeShell::new(vec![dump("mInputShown=false")]);
        assert!(!shell.read().await.unwrap());
        assert_eq!(shell.calls().len(), 1);
    }

    #[tokio::test]
    async fn a_timed_out_read_is_retried_with_more_time() {
        let shell = FakeShell::new(vec![timed_out(), dump("mInputShown=true")]);
        assert!(shell.read().await.unwrap());
        let timeouts: Vec<_> = shell.calls().iter().map(|c| c.1).collect();
        assert_eq!(
            timeouts,
            vec![Duration::from_secs(5), Duration::from_secs(10)]
        );
    }

    #[tokio::test]
    async fn a_read_that_keeps_timing_out_says_what_to_do() {
        let shell = FakeShell::new(vec![timed_out(), timed_out()]);
        let message = shell.read().await.unwrap_err().to_string();
        assert_eq!(shell.calls().len(), 2);
        for part in [
            "keyboard state on emulator-5554",
            "dumpsys input_method --dump-priority CRITICAL",
            "15s (2 attempts)",
            "adb -s emulator-5554 shell echo ok",
            "more CPU",
        ] {
            assert!(message.contains(part), "missing {part:?} in: {message}");
        }
    }

    #[tokio::test]
    async fn a_dump_that_dumpsys_gave_up_on_is_a_timeout_and_not_hidden() {
        let expired = || dump("*** SERVICE 'input_method' DUMP TIMEOUT (10000ms) EXPIRED ***");

        let shell = FakeShell::new(vec![expired(), dump("mInputShown=true")]);
        assert!(shell.read().await.unwrap());
        assert_eq!(shell.calls().len(), 2);

        let shell = FakeShell::new(vec![expired(), expired()]);
        let message = shell.read().await.unwrap_err().to_string();
        assert!(message.contains("did not answer"), "{message}");
    }

    #[tokio::test]
    async fn the_flag_wins_over_a_later_dump_timeout() {
        let shell = FakeShell::new(vec![dump(
            "mInputShown=true\n*** SERVICE 'input_method' DUMP TIMEOUT (10000ms) EXPIRED ***",
        )]);
        assert!(shell.read().await.unwrap());
        assert_eq!(shell.calls().len(), 1);
    }

    #[tokio::test]
    async fn a_failed_read_is_an_error_and_is_not_retried() {
        let shell = FakeShell::new(vec![Err(anyhow!(
            "adb command failed (exit 1): device offline"
        ))]);
        let error = shell.read().await.unwrap_err().to_string();
        assert_eq!(error, "adb command failed (exit 1): device offline");
        assert_eq!(shell.calls().len(), 1);
    }

    #[tokio::test]
    async fn a_critical_dump_without_the_flag_falls_back_to_the_full_dump() {
        let shell = FakeShell::new(vec![dump(""), dump("mInputShown=true")]);
        assert!(shell.read().await.unwrap());
        let commands: Vec<_> = shell.calls().iter().map(|c| c.0).collect();
        assert_eq!(
            commands,
            vec![
                "dumpsys input_method --dump-priority CRITICAL",
                "dumpsys input_method"
            ]
        );
    }

    #[tokio::test]
    async fn no_flag_in_either_dump_reads_as_hidden() {
        let shell = FakeShell::new(vec![dump(""), dump("")]);
        assert!(!shell.read().await.unwrap());
    }
}
