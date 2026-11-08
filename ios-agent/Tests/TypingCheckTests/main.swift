// Unit tests for TypingCheck (PILOT-1012): how a paced typeText reads back
// what it typed, and when it types it again.

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

// The burst's rate follows the typing delay, capped at 100 keys a second.
do {
    expect("typingDelay 10 types 100 keys a second", TypingCheck.charactersPerSecond(delayMs: 10) == 100)
    expect("typingDelay 50 types 20 keys a second", TypingCheck.charactersPerSecond(delayMs: 50) == 20)
    expect("a delay under 10 ms still types at 100 a second", TypingCheck.charactersPerSecond(delayMs: 1) == 100)
    expect("no delay types at the cap", TypingCheck.charactersPerSecond(delayMs: 0) == 100)
    expect("a delay over a second still types a key a second", TypingCheck.charactersPerSecond(delayMs: 5000) == 1)
    expect("20 keys at 100 a second take 0.2 s",
           abs(TypingCheck.burstDuration(count: 20, charactersPerSecond: 100) - 0.2) < 0.0001)
    expect("a delay up to a second goes as one burst", TypingCheck.burstsAtOnce(delayMs: 1000))
    expect("a delay over a second sends key by key (a burst's rate is whole keys a second)",
           !TypingCheck.burstsAtOnce(delayMs: 2000))
    expect("5 keys with a 2 s delay take 10 s", abs(TypingCheck.typingDuration(count: 5, delayMs: 2000) - 10) < 0.0001)
    expect("20 keys with a 10 ms delay take 0.2 s", abs(TypingCheck.typingDuration(count: 20, delayMs: 10) - 0.2) < 0.0001)
}

// Typing a key at a time keeps the delay between keys.
do {
    let sent = Date(timeIntervalSinceReferenceDate: 100)
    expect("no wait before the first key", TypingCheck.waitBeforeKey(lastSentAt: nil, delayMs: 2000, now: sent) == 0)
    expect("a 2 s delay waits out what is left of it",
           abs(TypingCheck.waitBeforeKey(lastSentAt: sent, delayMs: 2000, now: sent.addingTimeInterval(0.5)) - 1.5) < 0.0001)
    expect("no wait once the delay has passed",
           TypingCheck.waitBeforeKey(lastSentAt: sent, delayMs: 2000, now: sent.addingTimeInterval(3)) == 0)
    expect("no delay, no wait", TypingCheck.waitBeforeKey(lastSentAt: sent, delayMs: 0, now: sent) == 0)
}

// An empty input reports its placeholder as its value; it reads as empty.
do {
    expect("a value equal to the placeholder reads as empty", TypingCheck.shownValue("–", placeholder: "–") == "")
    expect("a typed value reads as itself", TypingCheck.shownValue("1", placeholder: "–") == "1")
    expect("no placeholder, no change", TypingCheck.shownValue("1", placeholder: nil) == "1")
    expect("an empty placeholder is not a match", TypingCheck.shownValue("", placeholder: "") == "")
}

// Retyping across fields empties each field once.
do {
    let a = CGRect(x: 10, y: 10, width: 40, height: 40)
    let b = CGRect(x: 60, y: 10, width: 40, height: 40)
    let aRounded = CGRect(x: 10.4, y: 9.7, width: 40, height: 40)
    expect("a field met before is known again (rounding)", TypingCheck.contains([a], aRounded))
    expect("another field is not", !TypingCheck.contains([a], b))
}

// Return ends typing in a single-line field; a multi-line one types it.
do {
    let single = TypingCheck.plan("foo\nbar", multiline: false)
    expect("single-line: keys up to the newline", single.keys == "foo")
    expect("single-line: Return pressed after them", single.submit)
    let multi = TypingCheck.plan("foo\nbar", multiline: true)
    expect("multi-line: the newline is a key like any other", multi.keys == "foo\nbar" && !multi.submit)
    let onlyReturn = TypingCheck.plan("\n", multiline: false)
    expect("a lone newline is just Return", onlyReturn.keys.isEmpty && onlyReturn.submit)
    let plain = TypingCheck.plan("hello", multiline: false)
    expect("no newline: every key, no Return", plain.keys == "hello" && !plain.submit)
}

// Reading the field back.
do {
    typealias R = TypingCheck.Reading
    func read(_ shown: String, before: String = "", _ typed: String, secure: Bool = false) -> R {
        TypingCheck.read(shown, before: before, typed: typed, secure: secure)
    }
    expect("exact text is complete", read("test@example.com", "test@example.com") == .complete)
    expect("appended after what was there is complete", read("seed text", before: "seed ", "text") == .complete)
    expect("nothing typed yet is short", read("", "test") == .short)
    expect("an in-string drop is short (\"tet\")", read("tet", "test") == .short)
    expect("keys out of order are scrambled (\"sakerne\")", read("sakerne", "sneaker") == .scrambled)
    expect("out of order and short is short (\"saker\")", read("saker", "sneaker") == .short)
    expect("a character the keys did not type is a change (capitals)", read("Hello", "hello") == .changed)
    expect("a format inserted by the field is a change", read("(555) 1", "5551") == .changed)
    expect("a repeated key is a change, not complete", read("aab", "ab") == .changed)
    expect("losing what the field held is a change", read("text", before: "seed ", "text") == .changed)
    expect("repeated characters are counted", read("lol", "llo") == .scrambled)
    expect("emoji count as one character", read("a😀", "a😀") == .complete && read("a", "a😀") == .short)

    expect("secure: same length is complete", read("•••••", "abcde", secure: true) == .complete)
    expect("secure: fewer is short", read("•••", "abcde", secure: true) == .short)
    expect("secure: more is a change", read("••••••", "abcde", secure: true) == .changed)
    expect("secure: counted after what it held", read("•••••", before: "••", "abc", secure: true) == .complete)
    expect("secure: fewer than it held is a change (iOS emptied it on the first key)",
           read("•", before: "••", "x", secure: true) == .changed)
    expect("secure: an emptied field refilled to the expected count is still caught early",
           read("••", before: "••", "x", secure: true) == .short)
}

// What is repaired by typing again.
do {
    expect("short is typed again", TypingCheck.retypes(.short, before: "", secure: false))
    expect("scrambled is typed again", TypingCheck.retypes(.scrambled, before: "x", secure: false))
    expect("a change is not", !TypingCheck.retypes(.changed, before: "", secure: false))
    expect("complete is not", !TypingCheck.retypes(.complete, before: "", secure: false))
    expect("the first key is sent again into a plain field", TypingCheck.resendsFirstKey(before: "ab", secure: false))
    expect("and into an empty secure field", TypingCheck.resendsFirstKey(before: "", secure: true))
    expect("not into a secure field that held text (iOS may have emptied it: one bullet can be the new key)",
           !TypingCheck.resendsFirstKey(before: "•", secure: true))
    expect("an empty secure field is typed again", TypingCheck.retypes(.short, before: "", secure: true))
    expect("a secure field with content is not (it cannot be read back)",
           !TypingCheck.retypes(.short, before: "••", secure: true))
}

// Typing across fields that move the focus on: each field once, in the
// order typing reached it, and their values read together.
do {
    let box1 = CGRect(x: 16, y: 300, width: 48, height: 44)
    let box2 = box1.offsetBy(dx: 56, dy: 0)
    let box3 = box2.offsetBy(dx: 56, dy: 0)
    let rounded = CGRect(x: 16, y: 300.4, width: 48.6, height: 44)
    expect("each field once, first visit first",
           TypingCheck.inVisitOrder([box1, box2, box2, box3, box2]) == [box1, box2, box3])
    expect("whole-point bounds match the tree's frame",
           TypingCheck.inVisitOrder([rounded, box1, box2]) == [rounded, box2])
    // A key sent to a box the app was about to leave is lost: "3" never
    // lands, and the boxes together read short.
    expect("a key lost between boxes reads short",
           TypingCheck.read(["1", "2", "4"].joined(), before: "", typed: "1234", secure: false) == .short)
    expect("every box holding its digit reads complete",
           TypingCheck.read(["1", "2", "3", "4"].joined(), before: "", typed: "1234", secure: false) == .complete)
}

// After a key is in the field, no error may read as a stale element (the
// SDK would type the whole text again), but it still says what happened.
do {
    let changed = "typeText: after the first key the field shows \"Stale bread. X\", not \"Stale bread. x\""
    let kept = TypingCheck.notStale(changed)
    expect("field text with Stale in it no longer reads as stale", !TypingCheck.readsAsStale(kept))
    expect("and reads the same once the zero-width space is gone",
           kept.replacingOccurrences(of: "\u{200B}", with: "") == changed)
    let lookup = "Element 'abc' not found. It may have gone stale."
    let lost = TypingCheck.notStale(lookup)
    expect("a lost field is said so, without reading as stale",
           !TypingCheck.readsAsStale(lost) && lost.hasPrefix("typeText lost the field after typing into it: "))
    expect("STALEMATE in any case", !TypingCheck.readsAsStale(TypingCheck.notStale("typeText: STALEMATE, StAlE")))
    expect("a message without it is unchanged", TypingCheck.notStale("typeText: short") == "typeText: short")
    expect("readsAsStale matches the SDK's case-insensitive check", TypingCheck.readsAsStale("x STALE y"))
}

// Errors describe a secure field's content by its length only.
do {
    expect("plain text is quoted", TypingCheck.describe("abc", secure: false) == "\"abc\"")
    expect("secure text is a count", TypingCheck.describe("•••", secure: true) == "3 character(s)")
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all TypingCheck tests passed")
