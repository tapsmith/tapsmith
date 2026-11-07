// Unit tests for ScrollStepWatch (PILOT-998): when an iOS scroll step waits
// for the list to stop, how it tells it has, and whether the list moved.

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

let list = CGRect(x: 0, y: 100, width: 400, height: 700)
func frame(_ y: CGFloat) -> CGRect { CGRect(x: 0, y: y, width: 400, height: 44) }

// ─── isFar ───

expect("a row more than a list's height below is far",
       ScrollStepWatch.isFar([(frame(1700), false)], region: list))
expect("a row more than a list's height above is far",
       ScrollStepWatch.isFar([(frame(-700), false)], region: list))
expect("a row within a list's height of the list is near",
       !ScrollStepWatch.isFar([(frame(1400), false)], region: list))
expect("a row on screen is near",
       !ScrollStepWatch.isFar([(frame(300), true)], region: list))
expect("no match is not far: the row may be about to show",
       !ScrollStepWatch.isFar([], region: list))
expect("one near match among far ones makes it near",
       !ScrollStepWatch.isFar([(frame(3000), false), (frame(900), false)], region: list))

// ─── movedFar ───

expect("a step that moved the element most of a list's length moved it",
       ScrollStepWatch.movedFar(before: [frame(2900)], after: [frame(2340)], region: list))
expect("a bounce caught part-way did not",
       !ScrollStepWatch.movedFar(before: [frame(2900)], after: [frame(2960)], region: list))
expect("sideways counts along the width",
       ScrollStepWatch.movedFar(before: [CGRect(x: 1200, y: 300, width: 100, height: 44)],
                                after: [CGRect(x: 800, y: 300, width: 100, height: 44)], region: list))
expect("no match before or after: not known to have moved",
       !ScrollStepWatch.movedFar(before: [], after: [frame(100)], region: list)
           && !ScrollStepWatch.movedFar(before: [frame(100)], after: [], region: list))

// ─── band ───

let band = ScrollStepWatch.band(of: list)
expect("the band is the list's middle third", band.minY == 100 + 700 / 2 - 700 / 6 && abs(band.height - 700 / 3) < 0.01)
expect("the band stops short of the scroll indicator", band.maxX == 400 - ScrollStepWatch.indicatorInset)

// ─── waitUntilStill ───

final class Harness {
    var now = Date(timeIntervalSince1970: 1_000_000)
    var samples: [Int?]
    var taken = 0
    init(_ samples: [Int?]) { self.samples = samples }
    func run(cap: TimeInterval = ScrollStepWatch.maxWaitSeconds) -> ScrollStepWatch.Outcome {
        let deadline = now.addingTimeInterval(cap)
        return ScrollStepWatch.waitUntilStill(
            deadline: deadline,
            now: { self.now },
            sleep: { self.now = self.now.addingTimeInterval($0) },
            sample: { () -> Int? in
                self.now = self.now.addingTimeInterval(0.015)
                defer { self.taken += 1 }
                return self.samples[min(self.taken, self.samples.count - 1)]
            }
        )
    }
}

do {
    let h = Harness([1])
    let start = h.now
    let outcome = h.run()
    expect("a list already still is still once it held for the hold time", {
        if case .still = outcome { return true } else { return false }
    }())
    let waited = h.now.timeIntervalSince(start)
    expect("…which takes about the hold time (\(waited))", waited >= ScrollStepWatch.holdSeconds && waited < 0.2)
}

do {
    let h = Harness([1, 2, 3, 4, 5, 6, 7, 7])
    let outcome = h.run()
    expect("a list that moves for a while is still after it stops", {
        if case .still(let n) = outcome { return n > 8 } else { return false }
    }())
}

do {
    let h = Harness(Array(0..<1000).map { Optional($0) })
    let start = h.now
    let outcome = h.run()
    expect("a list that never stops is given up on at the deadline", outcome == .changing(samples: h.taken))
    expect("…not long after it", h.now.timeIntervalSince(start) < ScrollStepWatch.maxWaitSeconds + 0.05)
}

do {
    expect("a failed first sample is unreadable", Harness([nil]).run() == .unreadable)
    expect("a failed later sample is unreadable", Harness([1, 2, nil]).run() == .unreadable)
}

// ─── fingerprint ───

let rows = [(frame: frame(200), label: "Row 1"), (frame: frame(244), label: "Row 2")]
let off = [(frame: frame(2000), label: "Row 40")]
expect("the same rows give the same fingerprint",
       ScrollStepWatch.fingerprint(rows + off, in: list) == ScrollStepWatch.fingerprint(rows, in: list))
expect("rows that moved change it",
       ScrollStepWatch.fingerprint(rows, in: list)
           != ScrollStepWatch.fingerprint(rows.map { (frame: $0.frame.offsetBy(dx: 0, dy: -100), label: $0.label) }, in: list))
expect("a row's new label changes it",
       ScrollStepWatch.fingerprint(rows, in: list)
           != ScrollStepWatch.fingerprint([rows[0], (frame: frame(244), label: "Row 3")], in: list))

expect("a sub-point difference does not change it",
       ScrollStepWatch.fingerprint(rows, in: list)
           == ScrollStepWatch.fingerprint(rows.map { (frame: $0.frame.offsetBy(dx: 0, dy: 0.3), label: $0.label) }, in: list))

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all ScrollStepWatch tests passed")
