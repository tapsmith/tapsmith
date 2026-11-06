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

/// Each stuck process costs the full dump about 5 s, so a bound just above that
/// lets one stuck process report itself, and two count as a timeout, the same result.
const BACK_CHECK_TIMEOUT: Duration = Duration::from_secs(6);
const BACK_CHECK_ATTEMPTS: u32 = 3;

/// Whether the keyboard is shown, reading through `shell` (a strict adb shell
/// with a timeout, so a transport or dumpsys failure is an error). A dump that
/// completes but never mentions the flag reads as "hidden".
pub async fn keyboard_shown<S, Fut>(serial: &str, shell: &S) -> Result<bool>
where
    S: Fn(&'static str, Duration) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    let output = read_with_retry(serial, IME_STATE_COMMAND, shell).await?;
    if let Some(shown) = input_shown(&output) {
        return Ok(shown);
    }
    // We can only run this on the Android versions we have, so a build that
    // leaves the flag out of the critical section must not read as "hidden".
    let output = read_with_retry(serial, FULL_DUMP_COMMAND, shell).await?;
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

/// Whether to press BACK to hide the keyboard: only with the keyboard up, and an
/// error if BACK wouldn't reach it. The check can take a while, and an abandoned
/// test's call keeps running into the next test, so read the flag again at the end:
/// a keyboard that has gone by then must not get a BACK.
pub async fn should_press_back<S, Fut>(serial: &str, shell: S) -> Result<bool>
where
    S: Fn(&'static str, Duration) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    if !keyboard_shown(serial, &shell).await? {
        return Ok(false);
    }
    wait_until_back_reaches_keyboard(serial, &shell).await?;
    keyboard_shown(serial, &shell).await
}

/// Wait until BACK will reach the keyboard, or say why it won't.
///
/// BACK goes through the focused app to the keyboard, and if the keyboard doesn't
/// answer, Android hands it on to the app, which navigates back and pops the
/// screen. The full dump asks both processes for an answer, which makes it the
/// check for this. A process that fails it may only be busy (Gboard's first dump
/// in a session can take over 5 s), so it gets more tries.
async fn wait_until_back_reaches_keyboard<S, Fut>(serial: &str, shell: &S) -> Result<()>
where
    S: Fn(&'static str, Duration) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    for _ in 0..BACK_CHECK_ATTEMPTS {
        match shell(FULL_DUMP_COMMAND, BACK_CHECK_TIMEOUT).await {
            Err(e) if e.downcast_ref::<AdbTimeout>().is_some() => {}
            Err(e) => return Err(e),
            Ok(output) if both_processes_answered(&output) => return Ok(()),
            Ok(_) => {}
        }
        warn!(%serial, "The keyboard or the app did not answer; not pressing BACK yet");
    }
    Err(anyhow!(
        "hideKeyboard() did not press BACK on {serial}: the keyboard or the app is not responding \
         (`adb shell {FULL_DUMP_COMMAND}` got no answer from them in {BACK_CHECK_ATTEMPTS} \
         attempts), and a BACK they don't handle would navigate the app back. The device is probably overloaded: give the emulator more CPU or run fewer \
         workers, and check logcat for an ANR from the app or the keyboard."
    ))
}

/// How a dump reports a process that didn't answer. System_server writes the first
/// when it gives up on a process, the process itself writes the second when its main
/// thread doesn't get to the dump, and dumpsys writes the third when it gives up.
fn both_processes_answered(full_dump: &str) -> bool {
    ![
        "Failed to dump input method",
        "waiting for dump",
        "DUMP TIMEOUT",
    ]
    .iter()
    .any(|stuck| full_dump.contains(stuck))
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
            keyboard_shown("emulator-5554", &|command, timeout| {
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

    const STUCK_KEYBOARD: &str =
        "Failed to dump input method service: java.io.IOException: Timeout";
    const STUCK_APP: &str = "Failed to dump input method client: java.io.IOException: Timeout";

    fn full_dump(line: &str) -> Result<String> {
        Ok(format!("mInputShown=true\n{line}\n"))
    }

    impl FakeShell {
        async fn wait_for_back(&self) -> Result<()> {
            wait_until_back_reaches_keyboard("emulator-5554", &|command, timeout| {
                self.calls.lock().unwrap().push((command, timeout));
                let answer = self.answers.lock().unwrap().pop_front();
                async move { answer.expect("no scripted answer left") }
            })
            .await
        }

        async fn should_press_back(&self) -> Result<bool> {
            should_press_back("emulator-5554", |command, timeout| {
                self.calls.lock().unwrap().push((command, timeout));
                let answer = self.answers.lock().unwrap().pop_front();
                async move { answer.expect("no scripted answer left") }
            })
            .await
        }

        fn commands(&self) -> Vec<&'static str> {
            self.calls().iter().map(|c| c.0).collect()
        }
    }

    #[tokio::test]
    async fn back_is_safe_once_both_processes_answer_the_full_dump() {
        let shell = FakeShell::new(vec![full_dump("Input method service state for x:")]);
        shell.wait_for_back().await.unwrap();
        assert_eq!(shell.calls()[0].0, "dumpsys input_method");
        assert_eq!(shell.calls().len(), 1);
    }

    #[tokio::test]
    async fn a_process_that_stops_stalling_makes_back_safe() {
        for stuck in [
            full_dump(STUCK_KEYBOARD),
            full_dump(STUCK_APP),
            full_dump("Timeout waiting for dump"),
            full_dump("Interrupted waiting for dump"),
            timed_out(),
            dump("*** SERVICE 'input_method' DUMP TIMEOUT (10000ms) EXPIRED ***"),
        ] {
            let shell = FakeShell::new(vec![stuck, full_dump("all answered")]);
            shell.wait_for_back().await.unwrap();
            assert_eq!(shell.calls().len(), 2);
        }
    }

    #[tokio::test]
    async fn a_process_that_stays_stuck_refuses_back_and_says_why() {
        let shell = FakeShell::new(vec![
            full_dump(STUCK_KEYBOARD),
            timed_out(),
            full_dump(STUCK_APP),
        ]);
        let message = shell.wait_for_back().await.unwrap_err().to_string();
        assert_eq!(shell.calls().len(), 3);
        for part in [
            "did not press BACK on emulator-5554",
            "keyboard or the app is not responding",
            "in 3 attempts",
            "navigate the app back",
            "more CPU",
        ] {
            assert!(message.contains(part), "missing {part:?} in: {message}");
        }
    }

    #[tokio::test]
    async fn a_failed_full_dump_is_an_error_and_is_not_retried() {
        let shell = FakeShell::new(vec![Err(anyhow!(
            "adb command failed (exit 1): device offline"
        ))]);
        let error = shell.wait_for_back().await.unwrap_err().to_string();
        assert_eq!(error, "adb command failed (exit 1): device offline");
        assert_eq!(shell.calls().len(), 1);
    }

    const CRITICAL: &str = "dumpsys input_method --dump-priority CRITICAL";
    const FULL: &str = "dumpsys input_method";

    #[tokio::test]
    async fn a_hidden_keyboard_gets_no_back_and_no_full_dump() {
        let shell = FakeShell::new(vec![dump("mInputShown=false")]);
        assert!(!shell.should_press_back().await.unwrap());
        assert_eq!(shell.commands(), vec![CRITICAL]);
    }

    #[tokio::test]
    async fn back_is_pressed_after_the_check_when_the_keyboard_is_still_up() {
        let shell = FakeShell::new(vec![
            dump("mInputShown=true"),
            full_dump("all answered"),
            dump("mInputShown=true"),
        ]);
        assert!(shell.should_press_back().await.unwrap());
        assert_eq!(shell.commands(), vec![CRITICAL, FULL, CRITICAL]);
    }

    #[tokio::test]
    async fn a_keyboard_that_goes_during_the_check_gets_no_back() {
        let shell = FakeShell::new(vec![
            dump("mInputShown=true"),
            full_dump(STUCK_KEYBOARD),
            full_dump("all answered"),
            dump("mInputShown=false"),
        ]);
        assert!(!shell.should_press_back().await.unwrap());
        assert_eq!(shell.commands(), vec![CRITICAL, FULL, FULL, CRITICAL]);
    }

    #[tokio::test]
    async fn a_refused_check_is_an_error() {
        let shell = FakeShell::new(vec![
            dump("mInputShown=true"),
            full_dump(STUCK_APP),
            full_dump(STUCK_APP),
            full_dump(STUCK_APP),
        ]);
        let message = shell.should_press_back().await.unwrap_err().to_string();
        assert!(message.contains("did not press BACK"), "{message}");
        assert_eq!(shell.commands(), vec![CRITICAL, FULL, FULL, FULL]);
    }
}
