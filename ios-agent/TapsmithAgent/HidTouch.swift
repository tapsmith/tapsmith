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
    /// a 10 ms gap: beside a self-paging carousel, a 10 ms HID hold lost 14 of
    /// 120 taps, while back to back lost 1 of 120. So a one-frame tap is
    /// pressed and lifted back to back. A control's frame-spanning hold is
    /// kept, because the control needs it.
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
}
