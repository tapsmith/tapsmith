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
}

// What is repaired by typing again.
do {
    expect("short is typed again", TypingCheck.retypes(.short, before: "", secure: false))
    expect("scrambled is typed again", TypingCheck.retypes(.scrambled, before: "x", secure: false))
    expect("a change is not", !TypingCheck.retypes(.changed, before: "", secure: false))
    expect("complete is not", !TypingCheck.retypes(.complete, before: "", secure: false))
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
