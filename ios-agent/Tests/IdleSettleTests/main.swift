// Unit tests for IdleSettle: how long the iOS agent's waitForIdle watches
// the screen for, and which part of it.

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

func near(_ a: TimeInterval, _ b: TimeInterval) -> Bool { abs(a - b) < 0.000_1 }

let now = Date(timeIntervalSinceReferenceDate: 1_000)
func seconds(_ deadline: Date) -> TimeInterval { deadline.timeIntervalSince(now) }

// ─── deadline ───

expect("a long timeout is capped at the quarter-second ceiling",
       near(seconds(IdleSettle.deadline(now: now, timeoutMs: 30_000, readDeadline: nil)), 0.25))
expect("a timeout under the ceiling is kept",
       near(seconds(IdleSettle.deadline(now: now, timeoutMs: 100, readDeadline: nil)), 0.1))
expect("a zero timeout ends the wait at once",
       near(seconds(IdleSettle.deadline(now: now, timeoutMs: 0, readDeadline: nil)), 0))
expect("a negative timeout ends the wait at once",
       near(seconds(IdleSettle.deadline(now: now, timeoutMs: -5, readDeadline: nil)), 0))
expect("a far read deadline leaves the ceiling alone",
       near(seconds(IdleSettle.deadline(now: now, timeoutMs: 1_000, readDeadline: now.addingTimeInterval(6))), 0.25))
expect("a near read deadline ends the wait its margin before it",
       near(seconds(IdleSettle.deadline(now: now, timeoutMs: 1_000, readDeadline: now.addingTimeInterval(0.3))),
            0.3 - IdleSettle.readDeadlineMarginSeconds))
expect("a read deadline inside the margin leaves no time (the caller returns at once)",
       IdleSettle.deadline(now: now, timeoutMs: 1_000, readDeadline: now.addingTimeInterval(0.1)) <= now)

// ─── screenRegion ───

expect("an upright phone's screen is the native region as it is",
       IdleSettle.screenRegion(CGSize(width: 393, height: 852)) == CGRect(x: 0, y: 0, width: 393, height: 852))
expect("a turned phone's screen maps back to native portrait",
       IdleSettle.screenRegion(CGSize(width: 852, height: 393)) == CGRect(x: 0, y: 0, width: 393, height: 852))
expect("an unknown screen size gives no region",
       IdleSettle.screenRegion(nil) == nil)
expect("an empty screen size gives no region",
       IdleSettle.screenRegion(CGSize(width: 0, height: 852)) == nil)

// ─── wait ───

/// A fake clock: sampling costs `sampleCost`, sleeping advances it.
final class Clock {
    var t = now
    var slept: TimeInterval = 0
    func sleep(_ s: TimeInterval) { t = t.addingTimeInterval(s); slept += s }
}

func run(_ frames: [Int?], sampleCost: TimeInterval = 0.017, budget: TimeInterval = 0.25) -> (TouchSettle.Outcome, Clock, Int) {
    let clock = Clock()
    var taken = 0
    let outcome = IdleSettle.wait(
        deadline: now.addingTimeInterval(budget),
        now: { clock.t },
        sleep: clock.sleep,
        sample: { () -> Int? in
            let frame = taken < frames.count ? frames[taken] : frames.last!
            taken += 1
            clock.t = clock.t.addingTimeInterval(sampleCost)
            return frame
        }
    )
    return (outcome, clock, taken)
}

do {
    let (outcome, clock, taken) = run([1, 1])
    expect("a still screen settles after two samples", outcome == .settled(samples: 2) && taken == 2)
    expect("a still screen costs well under the ceiling", seconds(clock.t) < 0.1)
}
do {
    let (outcome, _, _) = run([1, 2, 3, 3])
    expect("a screen that stops moving settles once two samples match", outcome == .settled(samples: 4))
}
do {
    let frames = (0..<100).map { Optional($0) }
    let (outcome, clock, _) = run(frames)
    if case .stillChanging = outcome {
        expect("a screen that never holds still ends at the ceiling", seconds(clock.t) >= 0.25 && seconds(clock.t) < 0.25 + 0.017 * 2)
    } else {
        expect("a screen that never holds still ends at the ceiling", false)
    }
}
do {
    let (outcome, clock, taken) = run([nil])
    expect("an unreadable screen is waited out to the deadline, as before",
           outcome == .unreadable && near(seconds(clock.t), 0.25) && taken == 1)
}
do {
    let (outcome, clock, taken) = run([1, 1], budget: 0)
    expect("no time: returns at once without sampling", outcome == .noTime && taken == 0 && clock.slept == 0)
}
do {
    let clock = Clock()
    IdleSettle.sleepUntil(now.addingTimeInterval(-1), now: { clock.t }, sleep: clock.sleep)
    expect("sleepUntil a passed deadline does not sleep", clock.slept == 0)
}

if failures > 0 {
    print("\(failures) IdleSettle test(s) failed")
    exit(1)
}
print("IdleSettle: all tests passed")
