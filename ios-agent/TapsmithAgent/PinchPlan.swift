import CoreGraphics
import Foundation

/// Where the two fingers of a pinch start and end (PILOT-825). Pure, so the
/// geometry is host-testable; `EventSynthesizer.pinch` turns it into touches.
///
/// The fingers sit on the area's bottom-left to top-right diagonal, either
/// side of its centre — the layout Android's `UiObject2.pinchOpen` and
/// `pinchClose` use — inset by `marginFraction` of the area on each side so
/// neither finger lands on the element's edge.
///
/// `scale` is the ratio of the fingers' end distance to their start distance:
/// below 1 they close (zoom out), above 1 they open (zoom in). The longer of
/// the two distances spans the inset diagonal. The shorter one is never under
/// `minimumSpan`: two touches closer than that can be read as one, so an
/// extreme scale on a small element pinches less than asked rather than not
/// at all.
struct PinchPlan: Equatable {
    var firstStart: CGPoint
    var firstEnd: CGPoint
    var secondStart: CGPoint
    var secondEnd: CGPoint

    /// The share of the area left clear on each side (Android's gesture margin).
    static let marginFraction: CGFloat = 0.1
    /// The closest the two fingers ever get, in points.
    static let minimumSpan: CGFloat = 40

    enum Refusal: Error, Equatable {
        /// Not a finite number above 0.
        case invalidScale
        /// Exactly 1: the fingers would not move.
        case noChange
        /// The inset area's diagonal is shorter than `minimumSpan`, so the
        /// fingers have no room to move.
        case areaTooSmall(span: CGFloat)
    }

    static func make(in area: CGRect, scale: Double) -> Result<PinchPlan, Refusal> {
        guard scale.isFinite, scale > 0 else { return .failure(.invalidScale) }
        guard scale != 1 else { return .failure(.noChange) }
        let inset = area.insetBy(dx: area.width * marginFraction, dy: area.height * marginFraction)
        guard !inset.isNull, inset.width > 0, inset.height > 0 else {
            return .failure(.areaTooSmall(span: 0))
        }
        let longSpan = (inset.width * inset.width + inset.height * inset.height).squareRoot()
        guard longSpan > minimumSpan else { return .failure(.areaTooSmall(span: longSpan)) }

        let ratio = CGFloat(scale)
        let startSpan: CGFloat
        let endSpan: CGFloat
        if ratio < 1 {
            startSpan = longSpan
            endSpan = max(longSpan * ratio, minimumSpan)
        } else {
            startSpan = max(longSpan / ratio, minimumSpan)
            endSpan = longSpan
        }

        let centre = CGPoint(x: inset.midX, y: inset.midY)
        // Unit vector from the centre toward the top-right corner.
        let ux = inset.width / longSpan
        let uy = -inset.height / longSpan
        func pair(_ span: CGFloat) -> (CGPoint, CGPoint) {
            let half = span / 2
            return (
                CGPoint(x: centre.x - ux * half, y: centre.y - uy * half),
                CGPoint(x: centre.x + ux * half, y: centre.y + uy * half)
            )
        }
        let (firstStart, secondStart) = pair(startSpan)
        let (firstEnd, secondEnd) = pair(endSpan)
        return .success(PinchPlan(
            firstStart: firstStart,
            firstEnd: firstEnd,
            secondStart: secondStart,
            secondEnd: secondEnd
        ))
    }

    /// The fingers' positions `fraction` (0...1) of the way through the move.
    func positions(at fraction: CGFloat) -> (CGPoint, CGPoint) {
        func lerp(_ a: CGPoint, _ b: CGPoint) -> CGPoint {
            CGPoint(x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction)
        }
        return (lerp(firstStart, firstEnd), lerp(secondStart, secondEnd))
    }
}
