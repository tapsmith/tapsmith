// Unit tests for AnimationsIdle: XCTest's private animations-idle request is
// still there, in the shape the agent calls it with, and the wait for its
// answer maps every timing to the right outcome. Built against the macOS
// XCTest of the installed Xcode, which ships the same XCUIApplication and
// XCUIApplicationProcess classes as the iOS one.

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

func caseOf(_ result: Result<AnimationsIdle.API, AnimationsIdle.Unavailable>) -> AnimationsIdle.Unavailable? {
    if case .failure(let why) = result { return why }
    return nil
}

func near(_ a: TimeInterval, _ b: TimeInterval) -> Bool { abs(a - b) < 0.000_1 }

// ─── The private API ───

// Every element touch waits through this request; if an Xcode update renames
// it or changes its signature, touches silently go back to landing on
// presentation transitions. This fails first.
switch AnimationsIdle.api {
case .success:
    expect("the private animations-idle request resolves on the installed XCTest", true)
case .failure(let why):
    print("     \(why)")
    expect("the private animations-idle request resolves on the installed XCTest", false)
}

expect("a missing application class is reported, not crashed on",
       caseOf(AnimationsIdle.resolve(applicationClass: "NoSuchApplicationClass"))
           == .missingClass("NoSuchApplicationClass"))
expect("a missing process class is reported, not crashed on",
       caseOf(AnimationsIdle.resolve(processClass: "NoSuchProcessClass"))
           == .missingClass("NoSuchProcessClass"))
// Classes without the methods (NSObject stands in for renamed ones).
expect("a missing currentProcess is reported",
       caseOf(AnimationsIdle.resolve(applicationClass: "NSObject"))
           == .missingMethod("NSObject -currentProcess"))
expect("a missing animations-idle request is reported",
       caseOf(AnimationsIdle.resolve(processClass: "NSObject"))
           == .missingMethod("NSObject -_notifyWhenAnimationsAreIdle:"))
// A method with the right name but another signature is refused, never
// called through the cast.
if case .failure(.signatureChanged(let method, let encoding)) = AnimationsIdle.checkedMethod(
    NSObject.self, NSSelectorFromString("description"), "v24@0:8@?16"
) {
    expect("a method of another signature is refused",
           method == "NSObject -description" && encoding == "@16@0:8")
} else {
    expect("a method of another signature is refused", false)
}
expect("an object that is not an XCUIApplication gets no request",
       AnimationsIdle.request(for: NSObject()) == nil)

// ─── deadline ───

let now = Date(timeIntervalSinceReferenceDate: 1_000)
func seconds(_ deadline: Date) -> TimeInterval { deadline.timeIntervalSince(now) }

expect("with no read deadline the wait is capped at its ceiling",
       near(seconds(AnimationsIdle.deadline(now: now, readDeadline: nil, reserveSeconds: 0)),
            AnimationsIdle.maxWaitSeconds))
expect("a far read deadline leaves the ceiling alone",
       near(seconds(AnimationsIdle.deadline(now: now, readDeadline: now.addingTimeInterval(60), reserveSeconds: 0)),
            AnimationsIdle.maxWaitSeconds))
expect("a near read deadline ends the wait its margin before it",
       near(seconds(AnimationsIdle.deadline(now: now, readDeadline: now.addingTimeInterval(1.5), reserveSeconds: 0)),
            1.5 - AnimationsIdle.readDeadlineMarginSeconds))
expect("a reserved hold (a long press) comes off the read deadline too",
       near(seconds(AnimationsIdle.deadline(now: now, readDeadline: now.addingTimeInterval(2), reserveSeconds: 0.5)),
            2 - AnimationsIdle.readDeadlineMarginSeconds - 0.5))
expect("a read deadline inside the margin leaves no time",
       AnimationsIdle.deadline(now: now, readDeadline: now.addingTimeInterval(0.5), reserveSeconds: 0) <= now)

// ─── wait ───

func timed(_ body: () -> AnimationsIdle.Outcome) -> (AnimationsIdle.Outcome, TimeInterval) {
    let start = Date()
    let outcome = body()
    return (outcome, Date().timeIntervalSince(start))
}

do {
    let (outcome, took) = timed {
        AnimationsIdle.wait(deadline: Date().addingTimeInterval(1)) { done in done(); return true }
    }
    expect("an app already idle answers at once", outcome == .idle && took < 0.1)
}

do {
    let (outcome, took) = timed {
        AnimationsIdle.wait(deadline: Date().addingTimeInterval(1)) { done in
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { done() }
            return true
        }
    }
    expect("an animation that ends is waited out, and no longer",
           outcome == .idle && took >= 0.09 && took < 0.5)
}

do {
    let (outcome, took) = timed {
        AnimationsIdle.wait(deadline: Date().addingTimeInterval(0.15)) { _ in true }
    }
    expect("an animation that outlasts the deadline is touched through at it",
           outcome == .timedOut && took >= 0.14 && took < 0.5)
}

do {
    var asked = false
    let outcome = AnimationsIdle.wait(deadline: Date().addingTimeInterval(1)) { _ in asked = true; return false }
    expect("a request that could not be made is reported unavailable", outcome == .unavailable && asked)
}

do {
    var asked = false
    let outcome = AnimationsIdle.wait(deadline: Date().addingTimeInterval(-0.01)) { _ in asked = true; return true }
    expect("no time left: nothing is asked", outcome == .noTime && !asked)
}

do {
    // The first wait gives up; its answer arrives during the second, which
    // must still wait for its own.
    var lateAnswer: (() -> Void)?
    _ = AnimationsIdle.wait(deadline: Date().addingTimeInterval(0.05)) { done in lateAnswer = done; return true }
    let (outcome, took) = timed {
        AnimationsIdle.wait(deadline: Date().addingTimeInterval(0.2)) { _ in
            lateAnswer?()
            return true
        }
    }
    expect("an earlier wait's late answer does not end a later wait",
           outcome == .timedOut && took >= 0.19)
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all AnimationsIdle tests passed")
