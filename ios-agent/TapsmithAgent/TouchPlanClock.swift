import Foundation

/// Deadline bookkeeping for one occlusion-aware touch plan (PILOT-223):
/// how long to keep re-checking a covered element, when a slow check has run
/// too late to act on, and how long an unhittable element that keeps moving
/// gets to settle. Kept free of XCUITest so the host unit tests can drive it
/// with a fake clock (`ios-agent/Tests/run-unit-tests.sh`).
struct TouchPlanClock {
    /// Re-check interval while something covers the element.
    static let pollSeconds: TimeInterval = 0.25
    /// Room left before the daemon's read deadline for the touch itself and
    /// the answer to reach the daemon.
    static let readDeadlineMarginSeconds: TimeInterval = 1
    /// Fallback when the daemon did not say how long it waits (an older
    /// daemon): past the budget by more than this, assume its usual timeout +
    /// 5 s read deadline is close.
    static let lateSeconds: TimeInterval = 4
    /// How long an unhittable element that cannot be matched in the tree
    /// (moving between the two reads) is re-read before the coordinate
    /// fallback — independent of the budget, so a zero budget still settles
    /// and a long one does not stall.
    static let unlocatedSettleSeconds: TimeInterval = 1

    let deadline: Date
    let timeoutMs: Int64
    /// When the daemon gives up on this command: its `readTimeoutMs`, counted
    /// from when the command arrived. nil from an older daemon.
    let readDeadline: Date?
    /// Time the caller still needs after acting starts (a long press's hold).
    let reserveSeconds: TimeInterval
    private var firstUnlocated: Date?

    init(start: Date, timeoutMs: Int64, readDeadline: Date? = nil, reserveSeconds: TimeInterval = 0) {
        self.timeoutMs = timeoutMs
        self.deadline = start.addingTimeInterval(Double(max(0, timeoutMs)) / 1000)
        self.readDeadline = readDeadline
        self.reserveSeconds = reserveSeconds
    }

    /// How long to sleep before the next check of a covered element, or nil
    /// when the deadline has passed and the plan should give up.
    func sleepBeforeNextPass(at now: Date) -> TimeInterval? {
        let remaining = deadline.timeIntervalSince(now)
        guard remaining > 0 else { return nil }
        return min(Self.pollSeconds, remaining)
    }

    /// Whether a check that ended at `now` finished too late to act on: the
    /// touch (plus any reserved hold) could not answer before the daemon gives
    /// up, and would land in the middle of whatever the test does next.
    func isTooLateToAct(at now: Date) -> Bool {
        if let readDeadline {
            return now.addingTimeInterval(reserveSeconds + Self.readDeadlineMarginSeconds) > readDeadline
        }
        // Older daemon: a zero budget is a single check on its default deadline.
        return timeoutMs > 0 && now.timeIntervalSince(deadline) > Self.lateSeconds
    }

    /// Called on each unlocated check: whether the element has had its settle
    /// window and should get the coordinate fallback now.
    mutating func shouldFallBackWhenUnlocated(at now: Date) -> Bool {
        let since = firstUnlocated ?? now
        firstUnlocated = since
        return now.timeIntervalSince(since) >= Self.unlocatedSettleSeconds
    }
}
