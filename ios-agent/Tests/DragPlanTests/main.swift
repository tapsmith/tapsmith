// Unit tests for DragPlan: where an element-to-element drag starts and ends.

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

// The test app's drag row, in portrait: the draggable at the left, the drop
// zone at the right.
let source = CGRect(x: 32, y: 500, width: 80, height: 80)
let target = CGRect(x: 270, y: 500, width: 100, height: 80)

// The anchors sit inside each frame, biased toward the other one.
let planned = DragPlan.points(from: source, to: target)
expect("the start lies in the source", source.contains(planned.start))
expect("the end lies in the target", target.contains(planned.end))
expect("the start leans toward the target", planned.start.x > source.midX)
expect("the end leans toward the source", planned.end.x < target.midX)

// Upright: the agent's touch takes the interface points as they are.
let tall = CGSize(width: 402, height: 874)
let upright = DragPlan.nativePoints(from: source, to: target, screen: tall, device: .portrait)
expect("upright: the points as planned", upright.start == planned.start && upright.end == planned.end)

// The same row in landscape (874x402 interface). setOrientation("landscape")
// turns the device to landscapeLeft. Unmapped, the drag pressed at interface
// points that are somewhere else on the native portrait screen.
let wide = CGSize(width: 874, height: 402)
let lSource = CGRect(x: 100, y: 250, width: 80, height: 80)
let lTarget = CGRect(x: 700, y: 250, width: 100, height: 80)
let lPlanned = DragPlan.points(from: lSource, to: lTarget)
let left = DragPlan.nativePoints(from: lSource, to: lTarget, screen: wide, device: .landscapeLeft)
expect("landscapeLeft: the start is mapped into native portrait space",
       left.start == CGPoint(x: 402 - lPlanned.start.y, y: lPlanned.start.x))
expect("landscapeLeft: the end is mapped into native portrait space",
       left.end == CGPoint(x: 402 - lPlanned.end.y, y: lPlanned.end.x))
expect("landscapeLeft: both points lie on the native screen",
       CGRect(origin: .zero, size: tall).contains(left.start)
           && CGRect(origin: .zero, size: tall).contains(left.end))
// A drag along the interface's x axis runs along the native y axis.
expect("landscapeLeft: a sideways drag runs down the native screen",
       left.start.x == left.end.x && left.end.y > left.start.y)

let right = DragPlan.nativePoints(from: lSource, to: lTarget, screen: wide, device: .landscapeRight)
expect("landscapeRight: the start is mapped into native portrait space",
       right.start == CGPoint(x: lPlanned.start.y, y: 874 - lPlanned.start.x))
expect("landscapeRight: a sideways drag runs up the native screen",
       right.start.x == right.end.x && right.end.y < right.start.y)

// The app did not rotate (a tall window on a turned device): its interface
// space is the native one.
let unrotated = DragPlan.nativePoints(from: source, to: target, screen: tall, device: .landscapeLeft)
expect("a tall window on a turned device: the points as planned",
       unrotated.start == planned.start && unrotated.end == planned.end)

// The turn cannot be told (a wide window, device face up): the points stand.
let unknown = DragPlan.nativePoints(from: lSource, to: lTarget, screen: wide, device: .other)
expect("an unknown turn: the points as planned",
       unknown.start == lPlanned.start && unknown.end == lPlanned.end)

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all DragPlan tests passed")
