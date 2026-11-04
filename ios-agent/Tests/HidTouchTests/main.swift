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

// The helper places points in the device's native portrait space; the
// agent plans them in the app's interface space.
let tall = CGSize(width: 402, height: 874)
let wide = CGSize(width: 874, height: 402)
let p = CGPoint(x: 100, y: 200)
expect("a tall window, device upright: the point as planned",
       HidTouch.nativePoint(p, screen: tall, device: .portrait) == p)
expect("a tall window on a turned device (the app did not rotate): as planned",
       HidTouch.nativePoint(p, screen: tall, device: .landscapeLeft) == p)
expect("a square window counts as upright",
       HidTouch.nativePoint(p, screen: CGSize(width: 500, height: 500), device: .portrait) == p)
expect("a tall window, device upside down: no native point (did the app turn?)",
       HidTouch.nativePoint(p, screen: tall, device: .portraitUpsideDown) == nil)
// From iOS E2E (iPhone 16 Pro simulator, setOrientation("landscape") =
// landscapeLeft, home button on the right): the Dark Mode switch planned at
// (809.5, 156) in the 874x402 interface sits at (246, 809.5) in the portrait
// screenshot. Pressed at (809.5, 156) unmapped, the tap missed it.
expect("landscapeLeft maps the interface point into portrait space",
       HidTouch.nativePoint(CGPoint(x: 809.5, y: 156), screen: wide, device: .landscapeLeft)
           == CGPoint(x: 246, y: 809.5))
expect("landscapeLeft: the interface's top-left is the native top-right",
       HidTouch.nativePoint(.zero, screen: wide, device: .landscapeLeft) == CGPoint(x: 402, y: 0))
expect("landscapeRight: the interface's top-left is the native bottom-left",
       HidTouch.nativePoint(.zero, screen: wide, device: .landscapeRight) == CGPoint(x: 0, y: 874))
expect("landscapeRight maps the interface point into portrait space",
       HidTouch.nativePoint(CGPoint(x: 809.5, y: 156), screen: wide, device: .landscapeRight)
           == CGPoint(x: 156, y: 64.5))
expect("a wide window with no landscape device orientation: no native point",
       HidTouch.nativePoint(p, screen: wide, device: .other) == nil)
expect("a wide window on an upright device: no native point",
       HidTouch.nativePoint(p, screen: wide, device: .portrait) == nil)

if failures > 0 {
    print("\(failures) HidTouch test(s) failed")
    exit(1)
}
print("All HidTouch tests passed")
