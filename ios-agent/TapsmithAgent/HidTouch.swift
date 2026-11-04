import Foundation

/// How the daemon's HID helper presses a touch the agent planned. Pure, so the
/// rule is host-testable.
enum HidTouch {
    /// The hold to press a tap with over HID, for a tap the agent would hold
    /// `tapHold` (`TapTiming`). A one-frame hold exists so that no scroll
    /// event arrives between the touch's start and its end. The agent's own
    /// touch is one synthesized event record, so 10 ms does that. HID events
    /// reach the app as they happen, and a scroll event can arrive inside even
    /// a 10 ms gap: the helper sleeps between the press and the lift, and on a
    /// starved CI simulator that sleep runs long. Beside a carousel that turns
    /// 50 ms after a touch lands, a double tap held 10 ms lost a press in
    /// every attempt on CI. Pressed back to back, the lift reached React
    /// Native with the press in 20 of 20 double taps locally. The press and
    /// the lift are still two messages, so a scroll event between them is
    /// rarer, not impossible. So a one-frame tap is pressed and lifted back to
    /// back. A control's frame-spanning hold is kept, because the control
    /// needs it.
    static func hold(forTapHold tapHold: TimeInterval) -> TimeInterval {
        tapHold <= TapTiming.oneFrameHold ? 0 : tapHold
    }
}
