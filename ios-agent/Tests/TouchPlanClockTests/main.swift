// Unit tests for TouchPlanClock (PILOT-223): the deadline bookkeeping of the
// agent's occlusion wait loop, driven with a fake clock.

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

let t0 = Date(timeIntervalSince1970: 1_000_000)
func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

// Sleeping: poll at 250 ms, never past the deadline; nil once it has passed.
do {
    let clock = TouchPlanClock(start: t0, timeoutMs: 2000)
    expect("sleeps one poll interval while time remains", clock.sleepBeforeNextPass(at: at(0.5)) == 0.25)
    expect("never sleeps past the deadline",
           clock.sleepBeforeNextPass(at: at(1.9)).map { abs($0 - 0.1) < 1e-6 } == true)
    expect("no further pass once the deadline has passed", clock.sleepBeforeNextPass(at: at(2.0)) == nil)
}

// Lateness: only well past the deadline (the daemon waits timeout + 5 s), and
// never for a zero budget (a single check on the daemon's default deadline).
do {
    let clock = TouchPlanClock(start: t0, timeoutMs: 1000)
    expect("a pass ending 3.5 s past the deadline may still act", !clock.isTooLateToAct(at: at(4.5)))
    expect("a pass ending 4.5 s past the deadline must not act", clock.isTooLateToAct(at: at(5.5)))
    let zero = TouchPlanClock(start: t0, timeoutMs: 0)
    expect("a zero budget is never too late", !zero.isTooLateToAct(at: at(30)))
}

// With the daemon's read deadline (readTimeoutMs, counted from when the
// command arrived), lateness is judged against it, not guessed: refuse once a
// touch could no longer answer before the daemon gives up.
do {
    let received = t0.addingTimeInterval(-1.5) // resolve etc. ran before planning
    let clock = TouchPlanClock(start: t0, timeoutMs: 10_000,
                               readDeadline: received.addingTimeInterval(15))
    expect("with a read deadline: acting 1.2 s before it is fine", !clock.isTooLateToAct(at: at(12.3)))
    expect("with a read deadline: acting 0.8 s before it is refused", clock.isTooLateToAct(at: at(12.7)))
    let press = TouchPlanClock(start: t0, timeoutMs: 1000, readDeadline: t0.addingTimeInterval(6),
                               reserveSeconds: 1.5)
    expect("a long press reserves its duration before the read deadline", press.isTooLateToAct(at: at(3.6)))
    expect("…and may start while it still fits", !press.isTooLateToAct(at: at(3.4)))
    let derivedZero = TouchPlanClock(start: t0, timeoutMs: 0, readDeadline: t0.addingTimeInterval(5))
    expect("a derived zero budget is still guarded by the read deadline", derivedZero.isTooLateToAct(at: at(4.5)))
}

// Unlocated settle: re-read for up to 1 s from the first unlocated pass,
// regardless of the budget (a zero budget must not fall back at once).
do {
    var clock = TouchPlanClock(start: t0, timeoutMs: 0)
    expect("zero budget: first unlocated pass re-reads", !clock.shouldFallBackWhenUnlocated(at: at(0)))
    expect("zero budget: still settling at 0.6 s", !clock.shouldFallBackWhenUnlocated(at: at(0.6)))
    expect("zero budget: falls back after 1 s", clock.shouldFallBackWhenUnlocated(at: at(1.05)))

    var long = TouchPlanClock(start: t0, timeoutMs: 30_000)
    expect("long budget: first unlocated pass at 2 s re-reads", !long.shouldFallBackWhenUnlocated(at: at(2)))
    expect("long budget: falls back 1 s after the first unlocated pass, not at the timeout",
           long.shouldFallBackWhenUnlocated(at: at(3.01)))
}

print(failures == 0 ? "ALL OK" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
