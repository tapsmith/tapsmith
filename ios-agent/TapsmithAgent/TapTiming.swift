import Foundation

/// How long the agent's synthesized taps hold their touch (PILOT-974). Pure,
/// so the values and their bounds are host-testable; `EventSynthesizer.tap`
/// uses them.
enum TapTiming {
    /// A tap at a point: the touch is lifted 20 ms after it lands.
    ///
    /// Short, because React Native gives a touch to the scroll view around it
    /// when that scroll view scrolls while the touch is down, even a nested
    /// one (a carousel paging itself beside the button), and the press is
    /// cancelled. Speedrun measured 3 taps lost in 40 with a 100 ms hold and
    /// none in 576 with 10 ms. Not shorter than 20 ms, because the target of a
    /// tap at a point is unknown and UIKit's controls need the touch to span
    /// a display frame: a UISwitch never toggled at 12 ms and always did from
    /// 17 ms.
    static let pointTapHold: TimeInterval = 0.02

    /// The shortest hold a UISwitch reliably toggles from: one 60 Hz frame.
    static let minimumControlHold: TimeInterval = 0.017
}
