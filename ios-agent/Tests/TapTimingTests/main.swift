// Unit tests for TapTiming: how long a tap holds its touch, by what it lands on.

import Foundation
import XCTest

var failures = 0

func expect(_ name: String, _ ok: Bool) {
    if ok {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name)")
    }
}

let frame60Hz: TimeInterval = 1.0 / 60

// React Native cancels a press when a scroll event arrives while the touch is
// down (a carousel paging itself beside the button): a tap on anything that
// is not a frame-reading control must end within one display frame.
for type in [XCUIElement.ElementType.button, .other, .staticText, .cell, .image, .link, .textField, .key] {
    expect("a tap on a \(type.rawValue)-type element ends within one frame",
           TapTiming.hold(for: type) < frame60Hz)
}
expect("the one-frame hold is 10 ms", TapTiming.oneFrameHold == 0.010)

// UIKit controls read the touch on a display frame: a UISwitch never toggles
// from 12 ms and always does from 17 ms.
for type in [XCUIElement.ElementType.switch, .toggle, .checkBox, .slider, .stepper,
             .segmentedControl, .picker, .pickerWheel, .datePicker] {
    expect("a tap on a \(type.rawValue)-type control spans a frame",
           TapTiming.hold(for: type) >= TapTiming.minimumControlHold)
}
expect("the frame-spanning hold is 20 ms", TapTiming.frameSpanningHold == 0.020)
expect("the frame-spanning hold outlasts a frame", TapTiming.frameSpanningHold > frame60Hz)

// A tap at a coordinate lands on something unknown, which could be a switch.
expect("a tap on an unknown target spans a frame",
       TapTiming.hold(for: nil) == TapTiming.frameSpanningHold)

// An alert's or action sheet's buttons are UIKit controls.
expect("a button in an alert or sheet spans a frame",
       TapTiming.hold(for: .button, inAlertOrSheet: true) == TapTiming.frameSpanningHold)

// An element type nobody listed is treated as a control.
expect("an unlisted type spans a frame",
       TapTiming.hold(for: .menuItem) == TapTiming.frameSpanningHold)

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("tap-timing tests passed")
