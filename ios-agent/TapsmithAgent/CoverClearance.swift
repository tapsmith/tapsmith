import CoreGraphics
import Foundation

/// The drag that scrolls a target out from under fixed chrome in its own
/// window — a sticky header or footer, a tab bar, a bottom bar's button — as a
/// user would before tapping it (PILOT-980). Playwright does the same when an
/// element "intercepts pointer events": it scrolls the target to another
/// alignment and tries again. The Android agent's `CoverClearance` is the same
/// geometry.
///
/// The drag runs through the part of the list the cover leaves free, so it
/// never starts on the cover, and moves the content just far enough to bring
/// the whole target clear (or, for a target too tall for the free part, its
/// centre to the middle of it). A cover that leaves no room, or a drag too
/// short to scroll reliably, gives nil: there is nothing to scroll to, and the
/// cover is waited out as before.
enum CoverClearance {
    /// Drags at most per touch to move a target clear of a cover.
    static let maxDrags = 2
    /// Clearance kept around a target moved clear of a cover, in points.
    static let margin: CGFloat = 8
    /// How far a finger moves before a scroll view starts scrolling.
    static let touchSlop: CGFloat = 10
    /// Speed of a clearing drag, points per second: slow enough that the
    /// list moves with the finger.
    static let dragSpeed: CGFloat = 300
    /// Shortest move: a quicker one is a flick.
    static let minMoveSeconds: TimeInterval = 0.4
    /// How long the finger holds still before letting go, so the list does
    /// not fling.
    static let releaseHoldSeconds: TimeInterval = 0.25
    /// Longest a clearing drag takes, the hold and settling included.
    static let dragSeconds: TimeInterval = 2.5

    /// How long the finger takes over `drag`'s move: steady at `dragSpeed`,
    /// and never shorter than `minMoveSeconds`.
    static func moveSeconds(of drag: Drag) -> TimeInterval {
        let dx = drag.to.x - drag.from.x
        let dy = drag.to.y - drag.from.y
        return max(minMoveSeconds, TimeInterval((dx * dx + dy * dy).squareRoot() / dragSpeed))
    }

    struct Drag: Equatable {
        let from: CGPoint
        let to: CGPoint
    }

    /// - Parameters:
    ///   - target: where the target is now.
    ///   - cover: what covers it.
    ///   - list: the vertical list holding the target but not the cover.
    ///   - screen: the display.
    ///   - margin: clearance kept between the target and the cover, and
    ///     between the drag and the free part's edges.
    ///   - slop: how far a finger moves before the list starts scrolling,
    ///     added to the drag.
    static func drag(
        target: CGRect, cover: CGRect, list: CGRect, screen: CGRect,
        margin: CGFloat, slop: CGFloat
    ) -> Drag? {
        let area = list.intersection(screen)
        guard !area.isNull, area.width > 0, area.height > 0 else { return nil }
        // A footer sits in the list's lower half, a header in its upper half
        // (the target may be anywhere under either).
        let coverBelow = cover.midY > area.midY
        let freeTop = coverBelow ? area.minY : max(area.minY, cover.maxY)
        let freeBottom = coverBelow ? min(area.maxY, cover.minY) : area.maxY
        let free = freeBottom - freeTop
        guard free >= 4 * margin else { return nil }
        let fits = target.height + 2 * margin <= free
        // How far the content must move: up (negative) when the cover is below.
        let move: CGFloat
        if fits {
            move = coverBelow ? freeBottom - margin - target.maxY : freeTop + margin - target.minY
        } else {
            move = (freeTop + freeBottom) / 2 - target.midY
        }
        // Already clear, or the cover is not over it.
        if coverBelow ? move >= 0 : move <= 0 { return nil }
        let x = area.midX
        let distance = min(abs(move) + slop, free - 2 * margin)
        guard distance > slop + margin else { return nil }
        if coverBelow {
            let from = freeBottom - margin
            return Drag(from: CGPoint(x: x, y: from), to: CGPoint(x: x, y: from - distance))
        }
        let from = freeTop + margin
        return Drag(from: CGPoint(x: x, y: from), to: CGPoint(x: x, y: from + distance))
    }
}
