// Unit tests for SwipeGeometry (PILOT-934): where a direction swipe starts and
// ends, across the screen or inside the region scrollIntoView() picked.

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

let screen = CGRect(x: 0, y: 0, width: 400, height: 800)

// The screen: from the centre, half the screen at most (the old swipeScreen).
do {
    let up = SwipeGeometry.endpoints(in: screen, direction: "up", ratio: 0.6)
    expect("screen up starts at the centre", up?.start == CGPoint(x: 200, y: 400))
    expect("screen up ends half the screen up (ratio capped at 0.5)", up?.end == CGPoint(x: 200, y: 0))
    let down = SwipeGeometry.endpoints(in: screen, direction: "DOWN", ratio: 0.25)
    expect("screen down, case-insensitive, a quarter of the screen", down?.end == CGPoint(x: 200, y: 600))
    let left = SwipeGeometry.endpoints(in: screen, direction: "left", ratio: 0.5)
    expect("screen left goes along the width", left?.end == CGPoint(x: 0, y: 400))
}

// A region: everything relative to the region, never outside it.
do {
    let sheet = CGRect(x: 20, y: 300, width: 360, height: 400)
    let up = SwipeGeometry.endpoints(in: sheet, direction: "up", ratio: 0.6)
    expect("region up starts at the region's centre", up?.start == CGPoint(x: 200, y: 500))
    expect("region up ends at the region's top edge", up?.end == CGPoint(x: 200, y: 300))
    let right = SwipeGeometry.endpoints(in: sheet, direction: "right", ratio: 0.4)
    expect("region right goes along the region's width", right?.end == CGPoint(x: 344, y: 500))
}

do {
    expect("an unknown direction has no endpoints", SwipeGeometry.endpoints(in: screen, direction: "sideways", ratio: 0.5) == nil)
    expect("an empty region has no endpoints", SwipeGeometry.endpoints(in: CGRect(x: 0, y: 10, width: 300, height: 0), direction: "up", ratio: 0.5) == nil)
    expect("a negative ratio does not swipe backwards",
           SwipeGeometry.endpoints(in: screen, direction: "up", ratio: -1)?.end == CGPoint(x: 200, y: 400))
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all swipe geometry tests passed")
