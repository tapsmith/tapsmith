import CoreGraphics
import Foundation

/// The iOS agent's `waitForIdle`: watch the screen until it holds still,
/// with a quarter of a second as the ceiling.
///
/// iOS has no equivalent of Android's accessibility-event idle, and this used
/// to be a plain quarter-second sleep. Every test paid it before it started
/// (the runner's pre-test wait), whether or not anything on the screen was
/// moving. The wait now samples the whole screen (a JPEG region screenshot,
/// `RegionScreenshot.settleJPEGAPI`, ~15–20 ms) and ends as soon as two
/// consecutive samples, two rendered frames apart, are the same — the touch
/// settle's rule (`TouchSettle`). A screen that never holds still (a spinner,
/// a looping animation) still costs the ceiling, as before; a still one costs
/// two samples. A screen that can't be sampled is waited out as before.
///
/// Kept free of XCUITest so the host unit tests can drive it
/// (`ios-agent/Tests/run-unit-tests.sh`).
enum IdleSettle {
    /// The longest one idle wait lasts, whatever timeout it is given. The
    /// wait blocks the agent's single command thread, and callers give it
    /// budgets meant for Android's idle (up to the config's timeout).
    static let maxWaitSeconds: TimeInterval = 0.25

    /// Room left before the daemon's read deadline: a sample started just
    /// before the wait's deadline runs past it (a whole-screen screenshot,
    /// where the region one is unavailable, takes ~120 ms), and the answer
    /// must still reach the daemon in time.
    static let readDeadlineMarginSeconds: TimeInterval = 0.2

    /// When the wait must end: `timeoutMs` (at most `maxWaitSeconds`) from
    /// `now`, or earlier when the daemon's read deadline, less
    /// `readDeadlineMarginSeconds`, comes first.
    static func deadline(now: Date, timeoutMs: Int64, readDeadline: Date?) -> Date {
        let budget = min(maxWaitSeconds, max(0, TimeInterval(timeoutMs) / 1000))
        let cap = now.addingTimeInterval(budget)
        guard let readDeadline else { return cap }
        return min(cap, readDeadline.addingTimeInterval(-readDeadlineMarginSeconds))
    }

    /// The whole screen in the device's native portrait space, which region
    /// screenshots read (`RegionScreenshot`), from the app's screen size in
    /// either orientation: its short side is the native width. nil for a size
    /// that isn't known.
    static func screenRegion(_ screen: CGSize?) -> CGRect? {
        guard let screen, screen.width > 0, screen.height > 0 else { return nil }
        return CGRect(
            x: 0,
            y: 0,
            width: min(screen.width, screen.height),
            height: max(screen.width, screen.height)
        )
    }

    /// Sample until two consecutive samples are equal or `deadline` passes
    /// (`TouchSettle.wait`). When the screen can't be sampled, sleep until
    /// the deadline instead, as the wait did before it looked at the screen.
    @discardableResult
    static func wait<Sample: Equatable>(
        deadline: Date,
        now: () -> Date,
        sleep: (TimeInterval) -> Void,
        sample: () -> Sample?
    ) -> TouchSettle.Outcome {
        let outcome = TouchSettle.wait(deadline: deadline, now: now, sleep: sleep, sample: sample)
        if outcome == .unreadable { sleepUntil(deadline, now: now, sleep: sleep) }
        return outcome
    }

    /// Sleep until `deadline` (not at all once it has passed).
    static func sleepUntil(_ deadline: Date, now: () -> Date, sleep: (TimeInterval) -> Void) {
        let left = deadline.timeIntervalSince(now())
        if left > 0 { sleep(left) }
    }
}
