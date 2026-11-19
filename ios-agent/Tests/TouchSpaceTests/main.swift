// Unit tests for TouchSpace: where the agent's own synthesized touch lands
// a point it planned in the app's interface space.

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

let tall = CGSize(width: 402, height: 874)
let wide = CGSize(width: 874, height: 402)
let point = CGPoint(x: 700, y: 100)

// ─── Points ───

// Upright: the touch takes the interface point as it is.
expect("portrait: the point stands",
       TouchSpace(screen: tall, device: .portrait).point(CGPoint(x: 30, y: 600)) == CGPoint(x: 30, y: 600))

// Turned: mapped as the HID helper's taps are. Unmapped, x 700 is past the
// native screen's 402-point width, and the touch went nowhere.
let left = TouchSpace(screen: wide, device: .landscapeLeft)
let right = TouchSpace(screen: wide, device: .landscapeRight)
expect("landscapeLeft: mapped as HidTouch maps it",
       left.point(point) == HidTouch.nativePoint(point, screen: wide, device: .landscapeLeft))
expect("landscapeLeft: on the native screen", CGRect(origin: .zero, size: tall).contains(left.point(point)))
expect("landscapeRight: mapped as HidTouch maps it",
       right.point(point) == HidTouch.nativePoint(point, screen: wide, device: .landscapeRight))
expect("landscapeRight: on the native screen", CGRect(origin: .zero, size: tall).contains(right.point(point)))

// An app that did not turn with the device: its window is still tall.
expect("an app that did not turn: the point stands",
       TouchSpace(screen: tall, device: .landscapeLeft).point(CGPoint(x: 30, y: 600)) == CGPoint(x: 30, y: 600))

// The turn cannot be told: XCTest's placement, as before.
expect("a wide window on a flat device: the point stands",
       TouchSpace(screen: wide, device: .other).point(point) == point)
expect("a tall window upside down: the point stands",
       TouchSpace(screen: tall, device: .portraitUpsideDown).point(CGPoint(x: 30, y: 600)) == CGPoint(x: 30, y: 600))

// ─── Directions ───

// A swipe "left" in the interface must still go left on the screen the user
// sees: in landscapeLeft the interface's x axis is the native y axis.
let start = CGPoint(x: 600, y: 200)
let end = CGPoint(x: 400, y: 200)
let ns = left.point(start)
let ne = left.point(end)
expect("landscapeLeft: an interface swipe left moves along native y", ns.x == ne.x && ne.y < ns.y)
let rs = right.point(start)
let re = right.point(end)
expect("landscapeRight: an interface swipe left moves along native y", rs.x == re.x && re.y > rs.y)

// ─── Pinch ───

let area = CGRect(x: 500, y: 100, width: 300, height: 250)
if case .success(let plan) = PinchPlan.make(in: area, scale: 2) {
    let mapped = left.pinch(plan)
    expect("pinch: every finger mapped",
           mapped.firstStart == left.point(plan.firstStart) && mapped.firstEnd == left.point(plan.firstEnd)
               && mapped.secondStart == left.point(plan.secondStart) && mapped.secondEnd == left.point(plan.secondEnd))
    func span(_ a: CGPoint, _ b: CGPoint) -> CGFloat { ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot() }
    expect("pinch: the fingers open as far as planned",
           abs(span(mapped.firstEnd, mapped.secondEnd) - span(plan.firstEnd, plan.secondEnd)) < 0.001)
    let native = CGRect(origin: .zero, size: tall)
    expect("pinch: every landscape finger on the native screen",
           [mapped.firstStart, mapped.firstEnd, mapped.secondStart, mapped.secondEnd].allSatisfy(native.contains))
    expect("pinch: portrait plan unchanged", TouchSpace(screen: tall, device: .portrait).pinch(plan) == plan)
} else {
    expect("pinch plan made", false)
}

// ─── Settle region ───

let target = CGRect(x: 700, y: 100, width: 100, height: 60)
expect("settle, portrait: the rect stands",
       TouchSpace(screen: tall, device: .portrait).settleRect(CGRect(x: 30, y: 600, width: 40, height: 20))
           == CGRect(x: 30, y: 600, width: 40, height: 20))
expect("settle, landscapeLeft: mapped as HidTouch maps it",
       left.settleRect(target) == HidTouch.nativeRect(target, screen: wide, device: .landscapeLeft))

// Turn unknown: watch everywhere the target could be, so a target that is
// still moving is seen whichever way the screen is turned.
let unknownWide = TouchSpace(screen: wide, device: .other).settleRect(target)
expect("settle, wide window turn unknown: covers the landscapeLeft place",
       unknownWide.contains(HidTouch.nativeRect(target, screen: wide, device: .landscapeLeft)!))
expect("settle, wide window turn unknown: covers the landscapeRight place",
       unknownWide.contains(HidTouch.nativeRect(target, screen: wide, device: .landscapeRight)!))
let small = CGRect(x: 30, y: 600, width: 40, height: 20)
let unknownTall = TouchSpace(screen: tall, device: .portraitUpsideDown).settleRect(small)
expect("settle, upside down: covers the rect as it stands", unknownTall.contains(small))
expect("settle, upside down: covers the rect turned half way round",
       unknownTall.contains(CGRect(x: 402 - 70, y: 874 - 620, width: 40, height: 20)))

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all TouchSpace tests passed")
