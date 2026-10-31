// Unit tests for TapTiming (PILOT-974): how long a synthesized point tap
// holds its touch.

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

// A point tap's target is unknown, so it must be long enough for a UISwitch,
// which needs the touch to span a display frame.
expect("a point tap holds long enough to toggle a UISwitch",
       TapTiming.pointTapHold >= TapTiming.minimumControlHold)

// A long hold lets a scroll view that scrolls under the touch (a self-paging
// carousel) take it and cancel the press: 100 ms lost 3 taps in 40.
expect("a point tap holds well under the old 100 ms",
       TapTiming.pointTapHold <= 0.025)

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("tap-timing tests passed")
