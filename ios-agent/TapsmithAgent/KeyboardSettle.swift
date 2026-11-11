import Foundation

/// The agent's waits around the software keyboard (PILOT-1132).
///
/// After the keyboard left, the app's own layout may still be moving (a
/// KeyboardAvoidingView giving the screen its height back), and a command
/// sent straight away would act on a screen in motion. That used to be a
/// fixed 0.35 s sleep after every dismissal, whether or not anything moved.
/// The wait now watches the screen (the still-screen sample `waitForIdle`
/// takes, ~15–20 ms) and ends once it has not changed for `stillSeconds`,
/// with the old 0.35 s as the ceiling. The window is longer than the two
/// rendered frames a touch's settle asks for (`TouchSettle`): a layout driven
/// from JavaScript (React Native's keyboardDidHide) starts a moment after the
/// keyboard is gone, and two equal samples a frame apart can both come before
/// it starts.
///
/// Kept free of XCUITest so the host unit tests can drive it with a fake
/// clock (`ios-agent/Tests/run-unit-tests.sh`).
enum KeyboardSettle {
    /// The longest the wait lasts: what it used to sleep, every time.
    static let maxWaitSeconds: TimeInterval = 0.35
    /// How long the screen must go unchanged.
    static let stillSeconds: TimeInterval = 0.1

    /// How often a wait for the keyboard to leave (or to leave the UI tree)
    /// looks. Each look is a snapshot of the app, tens of milliseconds by
    /// itself, so a short pause costs little and ends the wait soon after the
    /// keyboard has gone (these were 0.1–0.15 s pauses).
    static let pollSeconds: TimeInterval = 0.05

    /// How often a wait for a focusing tap to take looks. Each look is a
    /// live query for the focused input.
    static let focusPollSeconds: TimeInterval = 0.03

    /// How long a focusing tap of `typeText` gets to show that the field
    /// took the focus before another point is tried.
    static let focusReportWaitSeconds: TimeInterval = 0.65

    /// How long `focus` gives the field to take the focus from its tap, when
    /// it never reports it.
    static let focusTapWaitSeconds: TimeInterval = 0.25

    /// How long after its focusing tap `clearText` sends select-all: what
    /// that came to with the agent's own tap (XCTest's ~150 ms to play it,
    /// then a 0.1 s sleep).
    static let clearTapSettleSeconds: TimeInterval = 0.25

    enum Outcome: Equatable {
        /// The screen went unchanged for `stillSeconds`.
        case still
        /// Still changing at the deadline.
        case stillChanging
        /// The screen could not be sampled: waited until the deadline, as
        /// the fixed sleep did.
        case unreadable
    }

    /// Sample the screen until it has shown the same thing for
    /// `stillSeconds`, or `deadline` passes. Samples are at least two
    /// rendered frames apart (`TouchSettle.minSampleGapSeconds`).
    @discardableResult
    static func waitUntilStill<Sample: Equatable>(
        deadline: Date,
        now: () -> Date,
        sleep: (TimeInterval) -> Void,
        sample: () -> Sample?
    ) -> Outcome {
        guard now() < deadline else { return .stillChanging }
        var sampledAt = now()
        guard var shown = sample() else {
            IdleSettle.sleepUntil(deadline, now: now, sleep: sleep)
            return .unreadable
        }
        var stillSince = sampledAt
        while true {
            let gap = TouchSettle.minSampleGapSeconds - now().timeIntervalSince(sampledAt)
            if gap > 0 { sleep(gap) }
            guard now() < deadline else { return .stillChanging }
            sampledAt = now()
            guard let current = sample() else {
                IdleSettle.sleepUntil(deadline, now: now, sleep: sleep)
                return .unreadable
            }
            if current != shown {
                shown = current
                stillSince = sampledAt
            } else if sampledAt.timeIntervalSince(stillSince) >= stillSeconds {
                return .still
            }
        }
    }
}
