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

    /// Whether the app's interface is in the device's native portrait
    /// orientation, which the helper places its points in: the app's window
    /// taller than wide (or square), and the device not upside down (an app
    /// that rotates to upside-down portrait keeps a tall window).
    static func interfaceIsUpright(screen: CGSize, deviceUpsideDown: Bool) -> Bool {
        screen.height >= screen.width && !deviceUpsideDown
    }
}
