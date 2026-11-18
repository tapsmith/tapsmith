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
// from 12 ms and always does from 17 ms, measured as the app receives the
// touch. That can be up to ~8 ms shorter than it was pressed (the first touch
// after a launch is handed to the app late), and a 20 ms hold then lost a
// SwiftUI Toggle's tap 6 times in 8 on iOS 27.2 and twice in 10 on iOS 26.5;
// 50 ms lost none (PILOT-1220). So a known control is held 50 ms, about two
// frames clear of the minimum.
for type in [XCUIElement.ElementType.switch, .toggle, .checkBox, .slider, .stepper,
             .segmentedControl, .picker, .pickerWheel, .datePicker] {
    expect("a tap on a \(type.rawValue)-type control is held the control hold",
           TapTiming.hold(for: type) == TapTiming.controlHold)
}
expect("the control hold is 50 ms", TapTiming.controlHold == 0.050)
expect("the control hold stays 30 ms clear of the minimum a switch needs",
       TapTiming.controlHold - TapTiming.minimumControlHold >= 0.030)
expect("the frame-spanning hold is 20 ms", TapTiming.frameSpanningHold == 0.020)
expect("the frame-spanning hold outlasts a frame", TapTiming.frameSpanningHold > frame60Hz)

// A tap at a coordinate lands on something unknown, which could be a switch
// or a React Native button beside a moving carousel: it spans a frame, and no
// more (a longer press loses more taps beside the carousel).
expect("a tap on an unknown target spans a frame",
       TapTiming.hold(for: nil) == TapTiming.frameSpanningHold)

// An alert's or action sheet's buttons are UIKit controls, and so are the
// buttons a segmented control or a stepper is touched through.
for container in [XCUIElement.ElementType.alert, .sheet, .segmentedControl, .stepper, .picker] {
    expect("a button inside a \(container.rawValue)-type element is held as a control",
           TapTiming.hold(for: .button, within: [.application, .window, .other, container])
               == TapTiming.controlHold)
}
expect("a button inside plain views and lists ends within one frame",
       TapTiming.hold(for: .button, within: [.application, .window, .other, .scrollView, .cell, .table])
           == TapTiming.oneFrameHold)

// An element type nobody listed is treated as a control.
expect("an unlisted type is held as a control",
       TapTiming.hold(for: .menuItem) == TapTiming.controlHold)

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("tap-timing tests passed")
