// Unit tests for TypingFocus (PILOT-829): where type() taps to focus a text
// input, and whether that tap gave it focus.

import CoreGraphics
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

// The SwiftUI Form row from the ticket: frame [20,152][382,196] on iOS 18.
let row = CGRect(x: 20, y: 152, width: 362, height: 44)

// Tap points: trailing first (caret at the end of existing text), then the
// centre, which lands inside a row-wide frame's text input.
do {
    let points = TypingFocus.tapPoints(in: row)
    expect("two points for a wide field", points.count == 2)
    expect("first point is 12 pt in from the trailing edge", points.first == CGPoint(x: 370, y: 174))
    expect("second point is the centre", points.last == CGPoint(x: 201, y: 174))
    let narrow = TypingFocus.tapPoints(in: CGRect(x: 0, y: 0, width: 20, height: 30))
    expect("one point for a narrow field", narrow.count == 1)
    expect("narrow point stays inside the field", narrow[0].x > 0 && narrow[0].x < 20)
}

// Verdicts.
do {
    expect("the element itself has focus",
           TypingFocus.verdict(element: row, focusedBefore: nil, focusedAfter: row, keyboardOnScreen: true) == .focused)
    expect("integer-truncated bounds still match",
           TypingFocus.verdict(element: row, focusedBefore: nil,
                               focusedAfter: row.offsetBy(dx: 0.6, dy: 0.4), keyboardOnScreen: false) == .focused)
    expect("nothing focused and no keyboard: the tap missed (the ticket's bug)",
           TypingFocus.verdict(element: row, focusedBefore: nil, focusedAfter: nil, keyboardOnScreen: false) == .notFocused)
    expect("nothing reports focus but a keyboard is up: unverifiable, type anyway",
           TypingFocus.verdict(element: row, focusedBefore: nil, focusedAfter: nil, keyboardOnScreen: true) == .unverifiable)

    let other = CGRect(x: 20, y: 240, width: 362, height: 44) // same size, another row
    expect("another field kept the focus it had before the tap",
           TypingFocus.verdict(element: row, focusedBefore: other, focusedAfter: other, keyboardOnScreen: true) == .notFocused)
    let lifted = row.offsetBy(dx: 0, dy: -120) // a keyboard-avoiding layout moved it
    expect("the field took focus and moved: same size, focus changed",
           TypingFocus.verdict(element: row, focusedBefore: nil, focusedAfter: lifted, keyboardOnScreen: true) == .focused)
    expect("the field took focus from another and moved",
           TypingFocus.verdict(element: row, focusedBefore: other, focusedAfter: lifted, keyboardOnScreen: true) == .focused)
    let inner = CGRect(x: 40, y: 160, width: 322, height: 28)
    expect("an input inside the element took focus",
           TypingFocus.verdict(element: row, focusedBefore: nil, focusedAfter: inner, keyboardOnScreen: true) == .focused)
    expect("an input inside the element that already had focus counts too",
           TypingFocus.verdict(element: row, focusedBefore: inner, focusedAfter: inner, keyboardOnScreen: true) == .focused)
    let elsewhere = CGRect(x: 20, y: 600, width: 100, height: 30)
    expect("a different-sized input elsewhere took focus: not this element",
           TypingFocus.verdict(element: row, focusedBefore: nil, focusedAfter: elsewhere, keyboardOnScreen: true) == .notFocused)
}

if failures > 0 {
    print("\(failures) TypingFocus test(s) failed")
    exit(1)
}
print("TypingFocus: all tests passed")
