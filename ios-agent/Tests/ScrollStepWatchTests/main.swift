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

// A UIKit table hands back its reused cells' children in another order after
// a drag, at rest at the same frames: not a move (QA F2).
expect("the same nodes in another order give the same fingerprint",
       ScrollStepWatch.fingerprint(rows, in: list) == ScrollStepWatch.fingerprint(rows.reversed(), in: list))

// ─── regionNodes ───

struct Node { let frame: CGRect; let label: String; let children: [Node]; var scrolls = false; var cell = false }
let navBar = Node(frame: CGRect(x: 0, y: 62, width: 400, height: 106), label: "Title", children: [])
let table = Node(frame: CGRect(x: 0, y: 168, width: 400, height: 672), label: "", children: [
    Node(frame: frame(200), label: "Row 1", children: []),
    Node(frame: frame(244), label: "Row 2", children: []),
], scrolls: true)
let tree = Node(frame: CGRect(x: 0, y: 0, width: 400, height: 874), label: "App", children: [navBar, table])
let tableRegion = CGRect(x: 0, y: 168, width: 400, height: 672)
let inTable = ScrollStepWatch.regionNodes(root: tree, children: \.children, frame: \.frame, label: \.label, isScrollView: \.scrolls, isCell: \.cell, region: tableRegion)
expect("only the scroll container's own subtree counts when one has the region's frame",
       inTable.map(\.label).sorted() == ["", "Row 1", "Row 2"])
let movedBar = Node(frame: CGRect(x: 0, y: 61, width: 400, height: 108), label: "Title", children: [])
let tree2 = Node(frame: tree.frame, label: "App", children: [movedBar, table])
expect("a bar over the list that moves a point is not the list moving",
       ScrollStepWatch.fingerprint(inTable, in: tableRegion)
           == ScrollStepWatch.fingerprint(
               ScrollStepWatch.regionNodes(root: tree2, children: \.children, frame: \.frame, label: \.label, isScrollView: \.scrolls, isCell: \.cell, region: tableRegion),
               in: tableRegion))
let noMatch = ScrollStepWatch.regionNodes(root: tree, children: \.children, frame: \.frame, label: \.label,
                                          isScrollView: \.scrolls, isCell: \.cell, region: CGRect(x: 0, y: 0, width: 400, height: 150))
expect("with no scroll view covering half the region, every node counts", noMatch.count == 5)

// A full-screen List: the window and a non-scrolling overlay share its frame.
let screenRect = CGRect(x: 0, y: 0, width: 400, height: 874)
let fullList = Node(frame: screenRect, label: "", children: [Node(frame: frame(300), label: "Row 9", children: [])], scrolls: true)
let overlay = Node(frame: screenRect, label: "overlay", children: [])
let fullTree = Node(frame: screenRect, label: "App", children: [Node(frame: screenRect, label: "Window", children: [fullList, overlay])])
let picked = ScrollStepWatch.regionNodes(root: fullTree, children: \.children, frame: \.frame, label: \.label, isScrollView: \.scrolls, isCell: \.cell, region: screenRect)
expect("a full-screen list's own subtree counts, not a same-sized view that does not scroll",
       picked.map(\.label).sorted() == ["", "Row 9"])

// QA F2: a UITableView's scroll indicator resized by a point after a drag at the top.
let indicator = (frame: CGRect(x: 396, y: 171, width: 3, height: 81), label: "")
let indicatorAfter = (frame: CGRect(x: 396, y: 171, width: 3, height: 80), label: "")
expect("a scroll indicator changing is not the list moving",
       ScrollStepWatch.fingerprint(rows + [indicator], in: list) == ScrollStepWatch.fingerprint(rows + [indicatorAfter], in: list))

// QA F2: an unloaded UITableView row reports its contents at a placeholder
// frame at the table's origin, and which rows those are changes every drag.
func tableWith(unloaded label: String) -> Node {
    Node(frame: CGRect(x: 0, y: 168, width: 400, height: 672), label: "", children: [
        Node(frame: frame(200), label: "Row 1", children: [], cell: true),
        Node(frame: CGRect(x: 0, y: 2000, width: 400, height: 44), label: label, children: [
            Node(frame: CGRect(x: 0, y: 168, width: 58, height: 20), label: label, children: []),
        ], cell: true),
    ], scrolls: true)
}
let before = ScrollStepWatch.regionNodes(root: tableWith(unloaded: "Row 42"), children: \.children, frame: \.frame, label: \.label,
                                         isScrollView: \.scrolls, isCell: \.cell, region: tableRegion)
let after = ScrollStepWatch.regionNodes(root: tableWith(unloaded: "Row 76"), children: \.children, frame: \.frame, label: \.label,
                                        isScrollView: \.scrolls, isCell: \.cell, region: tableRegion)
expect("an unloaded row's placeholder contents are not the table moving",
       ScrollStepWatch.fingerprint(before, in: tableRegion) == ScrollStepWatch.fingerprint(after, in: tableRegion))

// A table under a large-title bar: its frame grows as the title collapses,
// away from the region read before the scroll. It is still the container.
let grownTable = Node(frame: CGRect(x: 0, y: 116, width: 400, height: 724), label: "", children: table.children, scrolls: true)
let grownTree = Node(frame: tree.frame, label: "App", children: [navBar, grownTable])
let inGrown = ScrollStepWatch.regionNodes(root: grownTree, children: \.children, frame: \.frame, label: \.label,
                                          isScrollView: \.scrolls, isCell: \.cell, region: tableRegion)
expect("a scroll container whose frame drifted from the region is still the one watched",
       inGrown.map(\.label).sorted() == ["", "Row 1", "Row 2"])

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all ScrollStepWatch tests passed")
