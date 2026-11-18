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
    /// points, and labels, in no particular order. Rows moving or new rows
    /// mounting change it; a drag at the end of the content does not, once the
    /// list is back at rest (frames are read to fractions of a point, which a
    /// list settling from a bounce changes long after anyone can see it move),
    /// and neither does a UIKit table handing back its reused cells' children
    /// in another order at the same frames.
    static func fingerprint(_ nodes: [(frame: CGRect, label: String)], in region: CGRect) -> Int {
        // A scroll indicator (a 3 pt sliver at the list's edge) resizes and
        // fades after every drag, even at the end of the content.
        let each = nodes.filter {
            $0.frame.intersects(region) && min($0.frame.width, $0.frame.height) >= minNodeThickness
        }.map { n -> Int in
            var h = Hasher()
            h.combine(Int(n.frame.minX.rounded()))
            h.combine(Int(n.frame.minY.rounded()))
            h.combine(Int(n.frame.width.rounded()))
            h.combine(Int(n.frame.height.rounded()))
            h.combine(n.label)
            return h.finalize()
        }
        var h = Hasher()
        for value in each.sorted() { h.combine(value) }
        return h.finalize()
    }

    /// What identifies a node in the fingerprint besides its frame: its type,
    /// identifier, label and value, as the screen read compares every
    /// attribute. Pages of a pager that differ only by an identifier (a
    /// gallery of unlabelled images with test ids) then still read as moved.
    static func nodeKey(type: UInt, identifier: String, label: String, value: String) -> String {
        "\(type)|\(identifier)|\(label)|\(value)"
    }

    /// Nodes thinner than this either way are not content (scroll indicators).
    static let minNodeThickness: CGFloat = 6

    /// The nodes whose movement says the list moved: the subtree of the scroll
    /// view that best covers `region` (the scroll container the step dragged
    /// in), so a bar drawn over the list's edge that shifts by a point does
    /// not count; every node when no scroll view covers at least half of it.
    /// Best, not exact: a table under a large-title navigation bar grows and
    /// shrinks as the title collapses, so its frame drifts from the region
    /// the SDK read before the scroll. Only a scroll view: a full-screen list
    /// shares its frame with the window and with views that do not scroll. A cell outside
    /// the region is left out with everything in it: a UITableView row with no
    /// loaded cell reports its contents at one placeholder frame at the
    /// table's origin (`CellFrames`), and which rows those are changes with
    /// every drag, even at the end of the content.
    static func regionNodes<Node>(
        root: Node,
        children: (Node) -> [Node],
        frame: (Node) -> CGRect,
        label: (Node) -> String,
        isScrollView: (Node) -> Bool,
        isCell: (Node) -> Bool,
        region: CGRect
    ) -> [(frame: CGRect, label: String)] {
        // How well a frame covers the region: intersection over union.
        func cover(_ f: CGRect) -> CGFloat {
            let i = f.intersection(region)
            guard !i.isNull, i.width > 0, i.height > 0 else { return 0 }
            let inter = i.width * i.height
            return inter / (f.width * f.height + region.width * region.height - inter)
        }
        func collect(_ start: Node) -> [(frame: CGRect, label: String)] {
            var out: [(frame: CGRect, label: String)] = []
            var stack = [start]
            while let node = stack.popLast() {
                if isCell(node) && !frame(node).intersects(region) { continue }
                out.append((frame: frame(node), label: label(node)))
                stack.append(contentsOf: children(node))
            }
            return out
        }
        // The best cover wins; between equal covers, the deeper scroll view
        // (a container wrapped in a scroll view of the same size).
        var container: (node: Node, cover: CGFloat, depth: Int)?
        var stack = [(node: root, depth: 0)]
        while let (node, depth) = stack.popLast() {
            if isScrollView(node) {
                let c = cover(frame(node))
                if c >= 0.5, c > (container?.cover ?? 0) + 0.001 || (abs(c - (container?.cover ?? 0)) <= 0.001 && depth > (container?.depth ?? -1)) {
                    container = (node, c, depth)
                }
            }
            stack.append(contentsOf: children(node).map { (node: $0, depth: depth + 1) })
        }
        return collect(container?.node ?? root)
    }
}
