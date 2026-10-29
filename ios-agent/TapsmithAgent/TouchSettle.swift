import Foundation

/// Waits for a touch target to stop changing on screen before it is touched —
/// Playwright's "stable" actionability check (the same bounding box on two
/// consecutive animation frames), adapted to what XCUITest can see (PILOT-791).
///
/// Accessibility frames are model-layer values: a popover that scales in
/// (an iOS 26 `confirmationDialog` or action sheet) reports its final frame
/// from the first read, so a frame-only check passes while the button is
/// still animating — and a touch that lands mid-presentation highlights the
/// button without firing its action. So each sample is what the screen
/// actually shows: the target's frame together with the pixels of its region
/// (the sampler is the caller's; see `ActionExecutor`). The target is stable
/// once two consecutive samples are equal.
///
/// The wait is bounded. A target whose pixels never settle (a spinner inside
/// a button, a looping animation) is touched at the deadline with the freshest
/// state rather than failed: a pixel check is stricter than Playwright's
/// bounding-box check, so failing would make every such tap an error.
///
/// Kept free of XCUITest so the host unit tests can drive it with a fake
/// clock (`ios-agent/Tests/run-unit-tests.sh`).
enum TouchSettle {
    /// Longest wait for a target to settle. Presentation animations (popover,
    /// sheet, push) run 0.3–0.5 s.
    static let maxWaitSeconds: TimeInterval = 1
    /// Minimum spacing between two samples, so they come from different
    /// rendered frames (two 60 Hz frames). A screenshot usually takes longer
    /// than this by itself, and then the loop does not sleep at all.
    static let minSampleGapSeconds: TimeInterval = 0.034
    /// Room left before the daemon's read deadline for the touch itself and
    /// the answer to reach the daemon (the same margin the touch plan keeps).
    static let readDeadlineMarginSeconds = TouchPlanClock.readDeadlineMarginSeconds

    enum Outcome: Equatable {
        /// Two consecutive samples agreed after `samples` samples.
        case settled(samples: Int)
        /// Still changing at the deadline; touch with the freshest state.
        case stillChanging(samples: Int)
        /// The target could not be read; the touch reports what is wrong.
        case unreadable
        /// No time left before the deadline to take even one sample.
        case noTime

        /// Whether the target was seen to change while it was watched. A
        /// touch point planned before the wait is stale then: the target
        /// may have moved, or something may have come over it.
        var sawChange: Bool {
            switch self {
            case .settled(let samples): return samples > 2
            case .stillChanging(let samples): return samples > 1
            case .unreadable, .noTime: return false
            }
        }
    }

    /// When the settle wait must end: `maxWaitSeconds` from now, or earlier
    /// when the daemon's read deadline (less the touch's margin and any
    /// reserved hold, e.g. a long press's duration) comes first.
    static func deadline(now: Date, readDeadline: Date?, reserveSeconds: TimeInterval) -> Date {
        let cap = now.addingTimeInterval(maxWaitSeconds)
        guard let readDeadline else { return cap }
        return min(cap, readDeadline.addingTimeInterval(-(readDeadlineMarginSeconds + max(0, reserveSeconds))))
    }

    /// Sample until two consecutive samples are equal, the sampler fails, or
    /// `deadline` passes.
    static func wait<Sample: Equatable>(
        deadline: Date,
        now: () -> Date,
        sleep: (TimeInterval) -> Void,
        sample: () -> Sample?
    ) -> Outcome {
        guard now() < deadline else { return .noTime }
        var sampledAt = now()
        guard var previous = sample() else { return .unreadable }
        var count = 1
        while true {
            let gap = minSampleGapSeconds - now().timeIntervalSince(sampledAt)
            if gap > 0 { sleep(gap) }
            guard now() < deadline else { return .stillChanging(samples: count) }
            sampledAt = now()
            guard let current = sample() else { return .unreadable }
            count += 1
            if current == previous { return .settled(samples: count) }
            previous = current
        }
    }
}
