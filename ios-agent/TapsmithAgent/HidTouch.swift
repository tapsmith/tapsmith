import CoreGraphics
import Foundation

/// How the daemon's HID helper presses a tap the agent planned. Pure, so the
/// rules are host-testable.
enum HidTouch {
    /// The hold to press a tap with over HID, for a tap the agent would hold
    /// `tapHold` (`TapTiming`). A one-frame hold exists so that no scroll
    /// event arrives between the touch's start and its end. The agent's own
    /// touch is one synthesized event record, so 10 ms does that. HID events
    /// reach the app as they happen, and a scroll event can arrive inside even
    /// a 10 ms gap: the helper sleeps between the press and the lift, and on a
    /// starved CI simulator that sleep runs long. Beside a self-paging
    /// carousel, a 10 ms HID tap lost 14 of 120 taps (back to back: 1 of 120),
    /// and a double tap held 10 ms lost a press in every attempt on CI. The
    /// press and the lift are still two messages, so a scroll event between
    /// them is rarer, not impossible. So a one-frame tap, and each tap of a
    /// double tap, is pressed and lifted back to back. A control's
    /// frame-spanning hold is kept, because the control needs it.
    static func hold(forTapHold tapHold: TimeInterval) -> TimeInterval {
        tapHold <= TapTiming.oneFrameHold ? 0 : tapHold
    }

    /// Which way the device is turned, as `XCUIDevice.orientation` says
    /// (`UIDeviceOrientation`, which the host-side tests cannot import).
    enum DeviceTurn {
        case portrait
        case portraitUpsideDown
        /// Home button on the right: the device's top edge points left.
        case landscapeLeft
        /// Home button on the left: the device's top edge points right.
        case landscapeRight
        /// Face up, face down or unknown.
        case other
    }

    /// Where the helper should press a point the agent planned at `point` in
    /// the app's interface space: the helper places points in the device's
    /// native portrait space. `screen` is the app's window as the plan's
    /// snapshot saw it. A tall (or square) window is upright, so the point
    /// stands, even on a turned device whose app did not rotate. A wide one is
    /// mapped by the way the device is turned. nil when that cannot be told
    /// (a wide window on a device that is not in landscape; a tall one on an
    /// upside-down device, where the app may or may not have turned): the
    /// agent's own touch, which XCTest places, is used instead.
    static func nativePoint(_ point: CGPoint, screen: CGSize, device: DeviceTurn) -> CGPoint? {
        if screen.height >= screen.width {
            return device == .portraitUpsideDown ? nil : point
        }
        // Native portrait width and height: the window's short and long sides.
        let nativeWidth = screen.height
        let nativeHeight = screen.width
        switch device {
        case .landscapeLeft:
            // The interface's top edge is the device's right edge, its left
            // edge the device's top.
            return CGPoint(x: nativeWidth - point.y, y: point.x)
        case .landscapeRight:
            // The interface's top edge is the device's left edge, its left
            // edge the device's bottom.
            return CGPoint(x: point.y, y: nativeHeight - point.x)
        case .portrait, .portraitUpsideDown, .other:
            return nil
        }
    }

    /// `nativePoint` for a rect: `rect` in the app's interface space as the
    /// device's native portrait space places it (on a rotated screen its
    /// sides swap). XCTest's region screenshot (`RegionScreenshot`) reads its
    /// rect in that space too. nil when `nativePoint` can't tell.
    static func nativeRect(_ rect: CGRect, screen: CGSize, device: DeviceTurn) -> CGRect? {
        guard let corner = nativePoint(CGPoint(x: rect.minX, y: rect.minY), screen: screen, device: device),
              let opposite = nativePoint(CGPoint(x: rect.maxX, y: rect.maxY), screen: screen, device: device)
        else { return nil }
        return CGRect(
            x: min(corner.x, opposite.x),
            y: min(corner.y, opposite.y),
            width: abs(opposite.x - corner.x),
            height: abs(opposite.y - corner.y)
        )
    }
}
