// Unit tests for TouchSettle (PILOT-791): the wait for a touch target to stop
// changing on screen, driven with a fake clock and a scripted sampler.

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

/// A fake clock: each sample costs `sampleCost` seconds, and sleeps advance
/// the clock by exactly what was asked for.
final class Harness {
    var now = t0
    var slept: [TimeInterval] = []
    var samples: [Int?]
    var taken = 0
    let sampleCost: TimeInterval

    init(_ samples: [Int?], sampleCost: TimeInterval = 0.05) {
        self.samples = samples
        self.sampleCost = sampleCost
    }

    func run(deadline: Date) -> TouchSettle.Outcome {
        TouchSettle.wait(
            deadline: deadline,
            now: { self.now },
            sleep: { self.slept.append($0); self.now = self.now.addingTimeInterval($0) },
            sample: { () -> Int? in
                self.now = self.now.addingTimeInterval(self.sampleCost)
                // Past the script: the screen holds its last state.
                let value = self.taken < self.samples.count ? self.samples[self.taken] : self.samples.last!
                self.taken += 1
                return value
            }
        )
    }
}

// A target that is already still settles on the second sample.
do {
    let h = Harness([7, 7])
    expect("static target settles after two samples", h.run(deadline: t0.addingTimeInterval(1)) == .settled(samples: 2))
    expect("static target: no sleep when sampling already takes longer than a frame gap", h.slept.isEmpty)
}

// A target that changes (the popover scaling in) is sampled until two
// consecutive samples agree.
do {
    let h = Harness([1, 2, 3, 3])
    expect("animating target settles once two consecutive samples agree",
           h.run(deadline: t0.addingTimeInterval(1)) == .settled(samples: 4))
}

// A, B, A is not stable: only consecutive samples count.
do {
    let h = Harness([1, 2, 1, 2, 1, 1])
    expect("only consecutive equal samples count as stable",
           h.run(deadline: t0.addingTimeInterval(1)) == .settled(samples: 6))
}

// A target that never stops changing (a spinner inside a button) is bounded:
// the touch goes ahead at the deadline instead of failing or stalling.
do {
    let h = Harness(Array(0..<1000).map { Optional($0) })
    let outcome = h.run(deadline: t0.addingTimeInterval(1))
    if case .stillChanging(let n) = outcome {
        expect("a target that never settles stops at the deadline", h.now <= t0.addingTimeInterval(1.05) && n >= 2)
    } else {
        expect("a target that never settles stops at the deadline", false)
    }
}

// Samples closer together than one frame gap could both fall inside one
// rendered frame, so the loop spaces them (Playwright compares two
// consecutive animation frames).
do {
    let h = Harness([5, 5], sampleCost: 0.005)
    _ = h.run(deadline: t0.addingTimeInterval(1))
    let total = h.slept.reduce(0, +)
    expect("fast samples are spaced at least the minimum gap apart",
           abs(total + 0.005 - TouchSettle.minSampleGapSeconds) < 1e-6)
}

// A sampler that cannot read the target (it went away, or the screenshot
// failed) ends the wait: the touch's own error reporting takes it from there.
do {
    let first = Harness([nil])
    expect("unreadable first sample ends the wait", first.run(deadline: t0.addingTimeInterval(1)) == .unreadable)
    let later = Harness([1, 2, nil])
    expect("unreadable later sample ends the wait", later.run(deadline: t0.addingTimeInterval(1)) == .unreadable)
    expect("no sample is taken after an unreadable one", later.taken == 3)
}

// No time left (the daemon's read deadline is close): no samples at all.
do {
    let h = Harness([1, 1])
    expect("no time left: the touch goes ahead unsampled", h.run(deadline: t0) == .noTime)
    expect("no time left: nothing sampled", h.taken == 0)
}

// The deadline: at most maxWaitSeconds, and never into the margin the touch
// needs before the daemon's read deadline (plus any reserved hold time).
do {
    let free = TouchSettle.deadline(now: t0, readDeadline: nil, reserveSeconds: 0)
    expect("without a read deadline the wait is capped at maxWaitSeconds",
           free == t0.addingTimeInterval(TouchSettle.maxWaitSeconds))
    let far = TouchSettle.deadline(now: t0, readDeadline: t0.addingTimeInterval(30), reserveSeconds: 0)
    expect("a far read deadline does not extend the cap", far == t0.addingTimeInterval(TouchSettle.maxWaitSeconds))
    let near = TouchSettle.deadline(now: t0, readDeadline: t0.addingTimeInterval(1.5), reserveSeconds: 0)
    expect("a near read deadline shortens the wait to leave the touch its margin",
           abs(near.timeIntervalSince(t0) - (1.5 - TouchSettle.readDeadlineMarginSeconds)) < 1e-6)
    let press = TouchSettle.deadline(now: t0, readDeadline: t0.addingTimeInterval(3), reserveSeconds: 1.8)
    expect("a long press's hold is reserved before the read deadline",
           abs(press.timeIntervalSince(t0) - (3 - 1.8 - TouchSettle.readDeadlineMarginSeconds)) < 1e-6)
    let past = TouchSettle.deadline(now: t0, readDeadline: t0.addingTimeInterval(0.5), reserveSeconds: 0)
    expect("a read deadline inside the margin leaves no settle time", past <= t0)
}

if failures > 0 {
    print("\(failures) TouchSettle test(s) failed")
    exit(1)
}
print("All TouchSettle tests passed")
