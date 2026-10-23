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

check("the keyboard's subtree is excluded", NonAppElements.excludesSubtree(elementType: .keyboard), true)
check("a key itself is inside it, not a subtree root", NonAppElements.excludesSubtree(elementType: .key), false)
check("a toolbar (input accessory) is not", NonAppElements.excludesSubtree(elementType: .toolbar), false)
check("the application is not a subtree exclusion",
      NonAppElements.excludesSubtree(elementType: .application), false)

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

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all NonAppElements tests passed")
