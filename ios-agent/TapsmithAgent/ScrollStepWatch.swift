import CoreGraphics
import Foundation

/// The find half of an iOS scroll step (PILOT-998): after the daemon's HID
/// drag, when to wait for the list to stop changing before reporting where
/// the element is, how to tell it has, and whether the list moved at all.
///
/// A virtualized list goes on re-laying out for ~300–500 ms after a drag (rows
/// mounting re-measure the ones around them; a hold before the lift does not
/// change it). A step that reported the element mid-re-layout once saw a row
/// at 431 pt that then drifted off the top, and the scroll-back that followed
/// lost the next tap. So a step whose element is near waits for the list's
/// pixels to hold still before it finds again. While the element is still more
/// than a list's height outside the list, where it drifts to doesn't matter:
/// the step answers at once and the next drag follows.
///
/// Kept free of XCUITest so the host unit tests can drive it with a fake clock
/// (`ios-agent/Tests/run-unit-tests.sh`).
enum ScrollStepWatch {
    /// The list counts as still once its pixels have not changed for this long.
    static let holdSeconds: TimeInterval = 0.1
    /// Pause between two pixel samples (a region screenshot takes ~15–25 ms).
    static let sampleGapSeconds: TimeInterval = 0.025
    /// The longest a step waits for the list to stop.
    static let maxWaitSeconds: TimeInterval = 0.9
    /// The scroll indicator fades at the list's trailing edge for ~300 ms
    /// after a drag; the pixels watched stop this far short of it.
    static let indicatorInset: CGFloat = 24

    /// Whether every match lies more than a list's height outside `region`
    /// (none on screen). No match at all is not far: a row the list has not
    /// created yet may be about to show.
    static func isFar(_ matches: [(frame: CGRect, visible: Bool)], region: CGRect) -> Bool {
        guard !matches.isEmpty else { return false }
        let h = region.height
        let w = region.width
        return !matches.contains { m in
            m.visible || (
                m.frame.minY < region.maxY + h && m.frame.maxY > region.minY - h &&
                    m.frame.minX < region.maxX + w && m.frame.maxX > region.minX - w
            )
        }
    }

    /// The share of the list's length the element must have moved for a step
    /// that did not wait (`isFar`) to count as the list moving. A step drags
    /// 0.8 of the list, so a real step moves the element about that far; a
    /// list bouncing back from an overscroll at its end is caught part-way
    /// and has moved it much less.
    static let farMoveShare: CGFloat = 0.25

    /// Whether the element moved far enough between the snapshot before the
    /// drag (`before`) and the step's find (`after`) to say the list scrolled,
    /// for a step that answered without waiting for the list to stop. The
    /// first match of each is compared. False when either has none.
    static func movedFar(before: [CGRect], after: [CGRect], region: CGRect) -> Bool {
        guard let b = before.first, let a = after.first else { return false }
        return abs(a.minY - b.minY) >= region.height * farMoveShare
            || abs(a.minX - b.minX) >= region.width * farMoveShare
    }

    /// The part of the list watched for stillness: a band across its middle
    /// third, short of its trailing edge. Rows moving cross it.
    static func band(of region: CGRect) -> CGRect {
        CGRect(
            x: region.minX,
            y: region.midY - region.height / 6,
            width: max(1, region.width - indicatorInset),
            height: max(1, region.height / 3)
        )
    }

    enum Outcome: Equatable {
        /// The samples held still for `holdSeconds`.
        case still(samples: Int)
        /// Still changing at the deadline.
        case changing(samples: Int)
        /// A sample could not be taken.
        case unreadable
    }

    /// Sample until the samples have not changed for `holdSeconds`, a sample
    /// fails, or `deadline` passes.
    static func waitUntilStill<Sample: Equatable>(
        deadline: Date,
        now: () -> Date,
        sleep: (TimeInterval) -> Void,
        sample: () -> Sample?
    ) -> Outcome {
        guard var last = sample() else { return .unreadable }
        var samples = 1
        var stillSince = now()
        while true {
            let left = deadline.timeIntervalSince(now())
            if left <= 0 { return .changing(samples: samples) }
            sleep(min(sampleGapSeconds, left))
            guard let current = sample() else { return .unreadable }
            samples += 1
            if current != last {
                last = current
                stillSince = now()
            } else if now().timeIntervalSince(stillSince) >= holdSeconds {
                return .still(samples: samples)
            }
        }
    }

    /// A fingerprint of the nodes inside `region`: their frames, to whole
    /// points, and labels. Rows moving or new rows mounting change it; a drag
    /// at the end of the content does not, once the list is back at rest
    /// (frames are read to fractions of a point, which a list settling from a
    /// bounce changes long after anyone can see it move).
    static func fingerprint(_ nodes: [(frame: CGRect, label: String)], in region: CGRect) -> Int {
        var h = Hasher()
        for n in nodes where n.frame.intersects(region) {
            h.combine(Int(n.frame.minX.rounded()))
            h.combine(Int(n.frame.minY.rounded()))
            h.combine(Int(n.frame.width.rounded()))
            h.combine(Int(n.frame.height.rounded()))
            h.combine(n.label)
        }
        return h.finalize()
    }
}
