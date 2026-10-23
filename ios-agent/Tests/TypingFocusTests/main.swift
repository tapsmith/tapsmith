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

typealias Input = TypingFocus.Input
let textField = "XCUIElementTypeTextField"

// The SwiftUI Form row from the ticket: frame [20,152][382,196] on iOS 18.
let row = CGRect(x: 20, y: 152, width: 362, height: 44)

func verdict(_ element: Input, tappedAt: CGPoint? = nil, before: Input?, after: Input?,
             keyboard: Bool = true) -> TypingFocus.Verdict {
    TypingFocus.verdict(element: element, tappedAt: tappedAt, focusedBefore: before, focusedAfter: after,
                        keyboardOnScreen: keyboard)
}

// Tap points: trailing first (caret at the end of existing text), then
// further in past a Form row's padding, then the centre.
do {
    let first = TypingFocus.trailingPoint(in: row)
    expect("first point is 12 pt in from the trailing edge", first == CGPoint(x: 370, y: 174))
    let next = TypingFocus.fallbackPoints(in: row, after: first)
    expect("then 40 pt in, inside the row's text input, then the centre",
           next == [CGPoint(x: 342, y: 174), CGPoint(x: 201, y: 174)])
    let moved = row.offsetBy(dx: 0, dy: -100)
    expect("fallbacks come from the area planned again",
           TypingFocus.fallbackPoints(in: moved, after: first).first == CGPoint(x: 342, y: 74))
    let narrow = CGRect(x: 0, y: 0, width: 20, height: 30)
    let narrowFirst = TypingFocus.trailingPoint(in: narrow)
    expect("narrow first point stays inside the field", narrowFirst.x > 0 && narrowFirst.x < 20)
    expect("no fallback next to the first tap", TypingFocus.fallbackPoints(in: narrow, after: narrowFirst).isEmpty)
    let medium = CGRect(x: 0, y: 0, width: 100, height: 30)
    let mediumNext = TypingFocus.fallbackPoints(in: medium, after: TypingFocus.trailingPoint(in: medium))
    expect("a medium field scales the inner inset to its width",
           mediumNext == [CGPoint(x: 75, y: 15), CGPoint(x: 50, y: 15)])
    let small = CGRect(x: 0, y: 0, width: 40, height: 30)
    expect("a small field skips the inner point next to the first",
           TypingFocus.fallbackPoints(in: small, after: TypingFocus.trailingPoint(in: small)) == [CGPoint(x: 20, y: 15)])
}

// No identity: frames and focus changes decide.
do {
    let field = Input(frame: row, className: textField)
    expect("the element itself has focus", verdict(field, before: nil, after: field) == .focused)
    expect("integer-truncated bounds still match",
           verdict(field, before: nil, after: Input(frame: row.offsetBy(dx: 0.6, dy: 0.4), className: textField),
                   keyboard: false) == .focused)
    expect("nothing focused and no keyboard: the tap missed (the ticket's bug)",
           verdict(field, before: nil, after: nil, keyboard: false) == .notFocused)
    expect("nothing reports focus but a keyboard is up: unverifiable",
           verdict(field, before: nil, after: nil, keyboard: true) == .unverifiable)

    let other = Input(frame: CGRect(x: 20, y: 240, width: 362, height: 44), className: textField)
    expect("another field kept the focus it had before the tap",
           verdict(field, before: other, after: other) == .notFocused)
    let lifted = Input(frame: row.offsetBy(dx: 0, dy: -120), className: textField)
    expect("the field took focus and moved", verdict(field, before: nil, after: lifted) == .focused)
    // Nothing tells a same-sized field that took focus and moved from one
    // that kept it and moved: the safe reading is "not focused" (a loud
    // failure, never typing into the other field).
    let otherMoved = Input(frame: CGRect(x: 20, y: 200, width: 362, height: 44), className: textField)
    expect("another same-sized field moving while it keeps focus",
           verdict(field, before: other, after: otherMoved) == .notFocused)
    let smaller = Input(frame: CGRect(x: 20, y: 400, width: 200, height: 30), className: textField)
    expect("the field took focus from a different-sized one and moved",
           verdict(field, before: smaller, after: lifted) == .focused)
    let inner = Input(frame: CGRect(x: 40, y: 160, width: 322, height: 28), className: textField)
    expect("an input inside the element took focus", verdict(field, before: nil, after: inner) == .focused)
    expect("an input inside the element that already had focus", verdict(field, before: inner, after: inner) == .focused)
    let secure = Input(frame: CGRect(x: 20, y: 600, width: 100, height: 30), className: "XCUIElementTypeSecureTextField")
    expect("an input of another kind elsewhere took focus: not this element",
           verdict(field, before: nil, after: secure) == .notFocused)
}

// Identity: an identifier or placeholder on both sides decides.
do {
    // A search bar slides up and narrows for Cancel when it takes focus.
    let search = Input(frame: CGRect(x: 16, y: 110, width: 370, height: 36),
                       className: "XCUIElementTypeSearchField", placeholder: "Search")
    let searchFocused = Input(frame: CGRect(x: 16, y: 60, width: 300, height: 36),
                              className: "XCUIElementTypeSearchField", placeholder: "Search")
    expect("a search field that moved and narrowed on focus", verdict(search, before: nil, after: searchFocused) == .focused)

    let email = Input(frame: row, className: textField, placeholder: "Email")
    let emailLifted = Input(frame: row.offsetBy(dx: 0, dy: -200), className: textField, placeholder: "Email")
    expect("the field took focus and was lifted", verdict(email, before: nil, after: emailLifted) == .focused)

    // Placeholders repeat: another "Required" row keeping the focus it had
    // is not the target.
    let required = Input(frame: row, className: textField, placeholder: "Required")
    let otherRequired = Input(frame: row.offsetBy(dx: 0, dy: 88), className: textField, placeholder: "Required")
    expect("another field with the same placeholder kept its focus",
           verdict(required, before: otherRequired, after: otherRequired) == .notFocused)

    // Another same-sized field, moving while it keeps focus: not the target.
    let password = Input(frame: row.offsetBy(dx: 0, dy: 44), className: textField, placeholder: "Password")
    let passwordMoved = Input(frame: row.offsetBy(dx: 0, dy: 20), className: textField, placeholder: "Password")
    expect("another field moving while it keeps focus", verdict(email, before: password, after: passwordMoved) == .notFocused)

    let byId = Input(frame: row, className: textField, identifier: "email")
    expect("same identifier elsewhere: the element moved",
           verdict(byId, before: nil, after: Input(frame: row.offsetBy(dx: 0, dy: -80), className: textField,
                                                   identifier: "email")) == .focused)
    expect("different identifier elsewhere: another field",
           verdict(byId, before: nil, after: Input(frame: row.offsetBy(dx: 0, dy: -80), className: textField,
                                                   identifier: "password")) == .notFocused)
}

// Not a text input itself: a wrapper, or an element known only by its
// cached bounds (no class, no identity). A focus change with the tap decides.
do {
    let wrapper = Input(frame: row, className: "XCUIElementTypeOther", identifier: "email-wrapper")
    let innerLifted = Input(frame: CGRect(x: 40, y: 40, width: 322, height: 28), className: textField,
                            identifier: "email-input")
    expect("a wrapper whose input took focus and was lifted", verdict(wrapper, before: nil, after: innerLifted) == .focused)
    let cached = Input(frame: row, className: "")
    expect("a bounds-cache element whose input took focus and was lifted",
           verdict(cached, before: nil, after: Input(frame: row.offsetBy(dx: 0, dy: -150), className: textField)) == .focused)
    let other = Input(frame: row.offsetBy(dx: 0, dy: 300), className: textField)
    expect("a bounds-cache element while another input kept its focus",
           verdict(cached, before: other, after: other) == .notFocused)
}

// The tap point, planned from the element's live position, decides when
// the resolve-time frame is stale.
do {
    let email = Input(frame: row, className: textField, placeholder: "Email")
    let emailNow = Input(frame: row.offsetBy(dx: 0, dy: -60), className: textField, placeholder: "Email")
    expect("an already-focused field whose resolve-time frame is stale (Form still scrolling)",
           verdict(email, tappedAt: CGPoint(x: 370, y: 114), before: emailNow, after: emailNow) == .focused)
    let qty = Input(frame: row, className: textField, identifier: "qty")
    let otherQty = Input(frame: row.offsetBy(dx: 0, dy: -88), className: textField, identifier: "qty")
    expect("another row sharing the testID kept its focus",
           verdict(qty, tappedAt: CGPoint(x: 370, y: 174), before: otherQty, after: otherQty) == .notFocused)
    expect("another row sharing the testID kept its focus (element tap, no point)",
           verdict(qty, before: otherQty, after: otherQty) == .notFocused)
}

if failures > 0 {
    print("\(failures) TypingFocus test(s) failed")
    exit(1)
}
print("TypingFocus: all tests passed")
