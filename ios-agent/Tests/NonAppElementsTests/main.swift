// Unit tests for NonAppElements (PILOT-756, PILOT-830), run on the host Mac
// without a simulator: `ios-agent/Tests/run-unit-tests.sh`.

import XCTest
import Foundation

var failures = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want \(want)")
    }
}

let marker = "tapsmith-hooks:1;epoch=3;nav=2;boot=c0ffee42;url=myapp:///"

func excludes(_ type: XCUIElement.ElementType, label: String = "", title: String = "", value: String = "") -> Bool {
    NonAppElements.excludesNode(elementType: type, label: label, title: title, value: value)
}

// ─── The node itself ───

check("the application element is excluded", excludes(.application, label: "Tapsmith Test App"), true)
check("a heading with the app's name is not", excludes(.staticText, label: "Tapsmith Test App"), false)
check("the hooks marker text is excluded", excludes(.staticText, label: marker), true)
check("a marker in the title is excluded", excludes(.other, title: marker), true)
check("a marker in the value is excluded", excludes(.other, value: marker), true)
check("text merely containing the prefix later is not",
      excludes(.staticText, label: "see tapsmith-hooks:1"), false)
check("an ordinary button is not", excludes(.button, label: "Done"), false)
check("a window is not (its descendants are the app)", excludes(.window), false)

// ─── Subtrees ───

func subtree(_ type: XCUIElement.ElementType, id: String = "", frame: CGRect = .zero, keyboardTop: CGFloat? = nil) -> Bool {
    NonAppElements.excludesSubtree(elementType: type, identifier: id, frame: frame, keyboardTop: keyboardTop)
}
// The keyboard window measured on an iOS 18 simulator (402 x 874 points).
let bottomRow = CGRect(x: 0, y: 583, width: 402, height: 291)
let accessoryBar = CGRect(x: 0, y: 494, width: 402, height: 44)

check("the keyboard's subtree is excluded", subtree(.keyboard), true)
check("the predictive / assistant bar is excluded", subtree(.other, id: "SystemInputAssistantView"), true)
check("the emoji / dictation row below the keys is excluded",
      subtree(.other, frame: bottomRow, keyboardTop: 583), true)
check("an input accessory toolbar above the keys is not", subtree(.toolbar, frame: accessoryBar, keyboardTop: 583), false)
check("before the keyboard in tree order nothing is excluded by position",
      subtree(.other, frame: bottomRow, keyboardTop: nil), false)
check("a window is never excluded by position", subtree(.window, frame: bottomRow, keyboardTop: 0), false)
check("an empty frame is not", subtree(.other, frame: CGRect(x: 0, y: 600, width: 0, height: 0), keyboardTop: 583), false)
check("a key itself is inside it, not a subtree root", subtree(.key), false)
check("the application is not a subtree exclusion", subtree(.application), false)

// ─── Live queries ───

check("the live-query predicate rejects the marker",
      NonAppElements.notHooksMarker.evaluate(with: ["label": marker]), false)
check("the live-query predicate keeps other labels",
      NonAppElements.notHooksMarker.evaluate(with: ["label": "Done"]), true)

let keyboard = CGRect(x: 0, y: 544, width: 393, height: 308)
check("a key's frame lies in the keyboard",
      NonAppElements.liesInKeyboard(CGRect(x: 300, y: 800, width: 90, height: 40), keyboardFrame: keyboard), true)
check("a toolbar button above it does not",
      NonAppElements.liesInKeyboard(CGRect(x: 320, y: 505, width: 70, height: 35), keyboardFrame: keyboard), false)
check("no keyboard: nothing lies in it",
      NonAppElements.liesInKeyboard(CGRect(x: 300, y: 800, width: 90, height: 40), keyboardFrame: .zero), false)

// ─── A switch's part (PILOT-790) ───
// SwiftUI draws a labelled Toggle as a row-sized switch holding its label text
// and an unlabelled switch, the knob: one control, which only the knob flips.

check("a switch inside a switch is its part",
      NonAppElements.isSwitchPart(elementType: .switch, insideSwitch: true), true)
check("a toggle inside a switch is its part",
      NonAppElements.isSwitchPart(elementType: .toggle, insideSwitch: true), true)
check("the outer switch is not",
      NonAppElements.isSwitchPart(elementType: .switch, insideSwitch: false), false)
check("the Toggle's label text is not",
      NonAppElements.isSwitchPart(elementType: .staticText, insideSwitch: true), false)
check("a switch and a toggle are switches",
      [XCUIElement.ElementType.switch, .toggle].map(NonAppElements.isSwitch), [true, true])
check("a button and a checkbox are not",
      [XCUIElement.ElementType.button, .checkBox, .other].map(NonAppElements.isSwitch), [false, false, false])

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all NonAppElements tests passed")
