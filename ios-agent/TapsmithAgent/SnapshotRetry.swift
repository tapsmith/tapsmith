import Foundation

/// When `SnapshotElementFinder.takeSnapshot()` tries a failed or empty
/// snapshot again (PILOT-978).
///
/// It makes up to `attempts` tries, `pause` apart — a cold start's tree can
/// be empty for a moment, and with the short accessibility timeout
/// (`AccessibilityTimeout`) a request stuck in a transition gives way and
/// the next one is answered. But no try starts once it could not finish
/// before the daemon stops waiting for the command (`deadline`, from its
/// `readTimeoutMs`): its answer would reach nobody, and the agent would still
/// be busy with it when the next command arrives. The first try always runs.
struct SnapshotRetry {
    /// Tries at most, the first included.
    static let attempts = 5
    /// Pause between tries.
    static let pause: TimeInterval = 0.2

    /// When the daemon stops waiting for the command, if it said.
    let deadline: Date?
    /// How long one try can be expected to take: the accessibility timeout,
    /// plus slack for the tree's transfer.
    let attemptCost: TimeInterval

    /// Whether to try again after `failedAttempts` failed tries, at `now`.
    func shouldRetry(failedAttempts: Int, now: Date) -> Bool {
        guard failedAttempts < Self.attempts else { return false }
        guard let deadline else { return true }
        return now.addingTimeInterval(Self.pause + attemptCost) <= deadline
    }
}
