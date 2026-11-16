// Unit tests for DaemonOpenURL: XCTest's private open-URL request is still
// there, in the shape the agent calls it with, and the wait for its answer
// maps every timing to the right outcome. Built against the macOS XCTest of
// the installed Xcode, which ships the same XCTRunnerDaemonSession as the
// iOS one.

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

func caseOf(_ result: Result<DaemonOpenURL.API, DaemonOpenURL.Unavailable>) -> DaemonOpenURL.Unavailable? {
    if case .failure(let why) = result { return why }
    return nil
}

// Every warm deep link goes through this request; if an Xcode update renames
// it or changes its signature, the agent silently falls back to
// XCUIApplication.open(_:) and its fixed one-second sleep. This fails first.
switch DaemonOpenURL.api {
case .success:
    expect("the private open-URL request resolves on the installed XCTest", true)
case .failure(let why):
    print("     \(why)")
    expect("the private open-URL request resolves on the installed XCTest", false)
}

expect("a missing session class is reported, not crashed on",
       caseOf(DaemonOpenURL.resolve(sessionClass: "NoSuchSessionClass"))
           == .missingClass("NoSuchSessionClass"))
// A class without the methods (NSObject stands in for a renamed session).
expect("a missing method is reported",
       caseOf(DaemonOpenURL.resolve(sessionClass: "NSObject"))
           == .missingMethod("+NSObject sharedSession"))
// A method with the right name but another signature is refused, never
// called through the cast.
if case .failure(.signatureChanged(let method, let encoding)) = DaemonOpenURL.checkedMethod(
    NSObject.self, NSSelectorFromString("description"), "@24@0:8@16", className: "-NSObject"
) {
    expect("a method of another signature is refused",
           method == "-NSObject description" && encoding == "@16@0:8")
} else {
    expect("a method of another signature is refused", false)
}

// The wait, on a fake clock: each pump advances it 5 ms.
final class Clock {
    var now = Date(timeIntervalSince1970: 1_000_000)
    var pumps = 0
}

func run(timeout: TimeInterval = 2, _ start: (Clock, @escaping DaemonOpenURL.Completion) -> Void) -> (DaemonOpenURL.Outcome, Clock) {
    let clock = Clock()
    let outcome = DaemonOpenURL.awaitCompletion(
        timeout: timeout,
        now: { clock.now },
        pump: { clock.pumps += 1; clock.now.addTimeInterval(0.005) },
        start: { completion in start(clock, completion) }
    )
    return (outcome, clock)
}

let (immediate, immediateClock) = run { _, done in done(true, nil) }
expect("an answer inside the request is delivered without pumping",
       immediate == .delivered && immediateClock.pumps == 0)

var pending: DaemonOpenURL.Completion?
let (silent, silentClock) = run { _, done in pending = done }
expect("no answer by the deadline times out at the deadline",
       silent == .timedOut && (399...401).contains(silentClock.pumps))
// A late answer after the wait gave up must not crash or change anything.
pending?(true, nil)
expect("a late answer is ignored", true)

final class Deferred {
    var completion: DaemonOpenURL.Completion?
}
let deferred = Deferred()
let clock2 = Clock()
let afterPumps = DaemonOpenURL.awaitCompletion(
    timeout: 2,
    now: { clock2.now },
    pump: {
        clock2.pumps += 1
        clock2.now.addTimeInterval(0.005)
        if clock2.pumps == 3 { deferred.completion?(true, nil) }
    },
    start: { deferred.completion = $0 }
)
expect("an answer that arrives while pumping is delivered", afterPumps == .delivered && clock2.pumps == 3)

let (errored, _) = run { _, done in
    done(false, NSError(domain: "XCTDaemonErrorDomain", code: 1, userInfo: [NSLocalizedDescriptionKey: "no such app"]))
}
expect("an error answer is a failure carrying the error", errored == .failed("no such app"))

let (refused, _) = run { _, done in done(false, nil) }
expect("a false answer without an error is a failure", refused == .failed("the request reported failure"))

let (okWithError, _) = run { _, done in
    done(true, NSError(domain: "X", code: 2, userInfo: [NSLocalizedDescriptionKey: "odd"]))
}
expect("an error wins over a true flag", okWithError == .failed("odd"))

// Answered from another thread while the waiter pumps.
let threaded = DaemonOpenURL.awaitCompletion(
    timeout: 2,
    now: { Date() },
    pump: { Thread.sleep(forTimeInterval: 0.001) },
    start: { done in
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.02) { done(true, nil) }
    }
)
expect("an answer from another thread is seen", threaded == .delivered)

if failures > 0 {
    print("\(failures) DaemonOpenURL test(s) failed")
    exit(1)
}
print("All DaemonOpenURL tests passed")
