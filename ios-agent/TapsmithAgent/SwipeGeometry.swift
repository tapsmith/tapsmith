import CoreGraphics
import Foundation

/// Where a direction swipe starts and ends (PILOT-934). Pure, so the geometry
/// is host-testable. The swipe starts at the centre of `rect` and travels
/// `ratio` of its size along the swipe, at most half (to the rect's edge).
/// `rect` is the screen, an element's frame, or the region the SDK sends: the
/// scroll container `scrollIntoView()` picked, so the swipe cannot land
/// outside a sheet or on a header above the list.
enum SwipeGeometry {
    /// `nil` for an unknown direction or an empty rect.
    static func endpoints(in rect: CGRect, direction: String, ratio: Double) -> (start: CGPoint, end: CGPoint)? {
        guard rect.width > 0, rect.height > 0 else { return nil }
        let r = CGFloat(min(0.5, max(0, ratio)))
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let end: CGPoint
        switch direction.lowercased() {
        case "up": end = CGPoint(x: center.x, y: center.y - rect.height * r)
        case "down": end = CGPoint(x: center.x, y: center.y + rect.height * r)
        case "left": end = CGPoint(x: center.x - rect.width * r, y: center.y)
        case "right": end = CGPoint(x: center.x + rect.width * r, y: center.y)
        default: return nil
        }
        return (center, end)
    }
}
