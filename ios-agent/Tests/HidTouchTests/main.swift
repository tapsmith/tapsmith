// Unit tests for HidTouch: how the daemon's HID helper presses a planned touch.

import Foundation

var failures = 0

func expect(_ name: String, _ ok: Bool) {
    if ok {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name)")
    }
}

// HID events reach the app as they happen, so any real gap between the down
// and the up lets a scroll event (a carousel paging itself) in between, and
// React Native cancels the press: a one-frame tap is pressed and lifted back
// to back.
expect("a one-frame tap has no hold over HID", HidTouch.hold(forTapHold: TapTiming.oneFrameHold) == 0)
expect("a shorter hold has none either", HidTouch.hold(forTapHold: 0.005) == 0)
// A control that reads a touch on a display frame keeps its hold.
expect("a frame-spanning hold is kept",
       HidTouch.hold(forTapHold: TapTiming.frameSpanningHold) == TapTiming.frameSpanningHold)
expect("a longer hold is kept", HidTouch.hold(forTapHold: 0.050) == 0.050)
// What a double tap's element types come to over HID.
expect("a button's taps are pressed back to back",
       HidTouch.hold(forTapHold: TapTiming.hold(for: .button)) == 0)
expect("a switch's taps keep their frame-spanning hold",
       HidTouch.hold(forTapHold: TapTiming.hold(for: .switch)) == TapTiming.frameSpanningHold)
expect("an unknown target keeps the frame-spanning hold",
       HidTouch.hold(forTapHold: TapTiming.hold(for: nil)) == TapTiming.frameSpanningHold)

if failures > 0 {
    print("\(failures) HidTouch test(s) failed")
    exit(1)
}
print("All HidTouch tests passed")
