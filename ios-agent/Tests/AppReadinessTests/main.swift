// Unit tests for AppReadiness (PILOT-1058): the poll loop behind the agent's
// `waitForAppReady` command, driven with a fake clock.

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

/// A fake clock: `sleep` advances it, and each check costs `checkCost` seconds.
final class FakeClock {
    var now = Date(timeIntervalSince1970: 1_000_000)
    var sleeps: [TimeInterval] = []
    func sleep(_ s: TimeInterval) {
        sleeps.append(s)
        now = now.addingTimeInterval(s)
    }
}

// Ready on the first check: one check, no sleep.
do {
    let clock = FakeClock()
    let outcome = AppReadiness.wait(timeoutMs: 10_000, now: { clock.now }, sleep: clock.sleep) { true }
    expect("ready at once: ready", outcome.ready)
    expect("ready at once: one check", outcome.checks == 1)
    expect("ready at once: no sleep", clock.sleeps.isEmpty)
}

// The empty shell for a while, then content: keeps polling until it appears.
do {
    let clock = FakeClock()
    var calls = 0
    let outcome = AppReadiness.wait(timeoutMs: 10_000, now: { clock.now }, sleep: clock.sleep) {
        calls += 1
        return calls >= 4
    }
    expect("content on the 4th check: ready", outcome.ready)
    expect("content on the 4th check: four checks", outcome.checks == 4)
    expect("polls at the poll interval",
           clock.sleeps.allSatisfy { abs($0 - AppReadiness.pollInterval) < 1e-9 })
    expect("elapsed counts the sleeps", outcome.elapsedMs == Int((3 * AppReadiness.pollInterval * 1000).rounded()))
}

// Never ready: an answer at the bound, not an error, and never sleeps past it.
do {
    let clock = FakeClock()
    let outcome = AppReadiness.wait(timeoutMs: 250, now: { clock.now }, sleep: clock.sleep) { false }
    expect("never ready: not ready", !outcome.ready)
    expect("never ready: elapsed reaches the bound", outcome.elapsedMs >= 250)
    let slept = clock.sleeps.reduce(0, +)
    expect("never ready: never sleeps past the bound", slept <= 0.25 + 1e-9)
    expect("never ready: checks again after the last sleep", outcome.checks == clock.sleeps.count + 1)
}

// A zero budget still checks once.
do {
    let clock = FakeClock()
    var calls = 0
    let outcome = AppReadiness.wait(timeoutMs: 0, now: { clock.now }, sleep: clock.sleep) {
        calls += 1
        return false
    }
    expect("zero budget: one check", calls == 1 && outcome.checks == 1)
    expect("zero budget: no sleep", clock.sleeps.isEmpty)
    expect("zero budget: not ready", !outcome.ready)
}

// A slow check that overruns the budget ends the wait without another sleep.
do {
    let clock = FakeClock()
    let outcome = AppReadiness.wait(timeoutMs: 500, now: { clock.now }, sleep: clock.sleep) {
        clock.now = clock.now.addingTimeInterval(0.6)
        return false
    }
    expect("slow check: one check", outcome.checks == 1)
    expect("slow check: no sleep after the budget is spent", clock.sleeps.isEmpty)
}

// What counts as rendered content, one element at a time.
do {
    let counts = AppReadiness.isRenderedContent
    expect("text/control types count", counts(true, false, "", ""))
    // RN Pressables and testID'd Views come through as labelled or
    // identified XCUIElementTypeOther: a screen of only those is rendered.
    expect("labelled container counts", counts(false, false, "Open settings", ""))
    expect("identified container counts", counts(false, false, "", "home-screen"))
    // The bare shell: windows and containers with neither.
    expect("blank container does not count", !counts(false, false, "", ""))
    expect("whitespace label does not count", !counts(false, false, "  ", ""))
    // The application node carries the app's name from launch on.
    expect("application node does not count", !counts(false, true, "Example", ""))
}

if failures > 0 {
    print("\(failures) AppReadiness test(s) failed")
    exit(1)
}
print("AppReadiness: all tests passed")
