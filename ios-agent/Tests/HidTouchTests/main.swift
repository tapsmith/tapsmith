// Unit tests for HidTouch: how the daemon's HID helper presses a planned tap.

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
// to back. Measured beside a self-paging carousel: a 10 ms HID hold lost 14
// of 120 taps, back to back 1 of 120.
expect("a one-frame tap has no hold over HID", HidTouch.hold(forTapHold: 0.010) == 0)
expect("a shorter hold has none either", HidTouch.hold(forTapHold: 0.005) == 0)
// A control that reads a touch on a display frame keeps its hold.
expect("a frame-spanning hold is kept", HidTouch.hold(forTapHold: 0.020) == 0.020)
expect("a longer hold is kept", HidTouch.hold(forTapHold: 0.050) == 0.050)

// The helper places points in the device's native portrait space.
expect("a tall window, device upright: upright",
       HidTouch.interfaceIsUpright(screen: CGSize(width: 402, height: 874), deviceUpsideDown: false))
expect("a square window counts as upright",
       HidTouch.interfaceIsUpright(screen: CGSize(width: 500, height: 500), deviceUpsideDown: false))
expect("a wide window: rotated",
       !HidTouch.interfaceIsUpright(screen: CGSize(width: 874, height: 402), deviceUpsideDown: false))
expect("a tall window, device upside down: not upright",
       !HidTouch.interfaceIsUpright(screen: CGSize(width: 402, height: 874), deviceUpsideDown: true))

if failures > 0 {
    print("\(failures) HidTouch test(s) failed")
    exit(1)
}
print("All HidTouch tests passed")
