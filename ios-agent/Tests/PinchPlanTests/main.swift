// Unit tests for PinchPlan (PILOT-825): where a pinch's two fingers start
// and end inside an element's visible area.

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

func near(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) < 0.001 }
func near(_ a: CGPoint, _ b: CGPoint) -> Bool { near(a.x, b.x) && near(a.y, b.y) }
func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }

func plan(_ area: CGRect, _ scale: Double) -> PinchPlan? {
    if case .success(let p) = PinchPlan.make(in: area, scale: scale) { return p }
    return nil
}

func refusal(_ area: CGRect, _ scale: Double) -> PinchPlan.Refusal? {
    if case .failure(let r) = PinchPlan.make(in: area, scale: scale) { return r }
    return nil
}

// A 300x400 area at (50, 100): inset 10% → (80, 140, 240x320), diagonal 400.
let area = CGRect(x: 50, y: 100, width: 300, height: 400)
let centre = CGPoint(x: 200, y: 300)

if let p = plan(area, 0.5) {
    expect("pinch in starts across the whole inset diagonal", near(distance(p.firstStart, p.secondStart), 400))
    expect("pinch in ends at scale × start", near(distance(p.firstEnd, p.secondEnd), 200))
    expect("first finger starts at the inset bottom-left", near(p.firstStart, CGPoint(x: 80, y: 460)))
    expect("second finger starts at the inset top-right", near(p.secondStart, CGPoint(x: 320, y: 140)))
    let (a, b) = p.positions(at: 0.5)
    expect("halfway the fingers are 3/4 of the way apart", near(distance(a, b), 300))
    expect("the fingers stay centred", near(CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2), centre))
    expect("positions at 0 are the starts", near(p.positions(at: 0).0, p.firstStart))
    expect("positions at 1 are the ends", near(p.positions(at: 1).1, p.secondEnd))
} else {
    expect("pinch in plans", false)
}

if let p = plan(area, 2) {
    expect("pinch out ends across the whole inset diagonal", near(distance(p.firstEnd, p.secondEnd), 400))
    expect("pinch out starts at end ÷ scale", near(distance(p.firstStart, p.secondStart), 200))
    expect("pinch out ends at the inset corners", near(p.firstEnd, CGPoint(x: 80, y: 460)) && near(p.secondEnd, CGPoint(x: 320, y: 140)))
} else {
    expect("pinch out plans", false)
}

// An extreme scale never brings the fingers closer than the minimum span.
if let p = plan(area, 0.01) {
    expect("tiny scale floors the end span", near(distance(p.firstEnd, p.secondEnd), PinchPlan.minimumSpan))
} else {
    expect("tiny scale plans", false)
}
if let p = plan(area, 100) {
    expect("huge scale floors the start span", near(distance(p.firstStart, p.secondStart), PinchPlan.minimumSpan))
} else {
    expect("huge scale plans", false)
}

// Every point stays inside the area.
for scale in [0.1, 0.5, 0.9, 1.1, 2, 10] {
    if let p = plan(area, scale) {
        let points = [p.firstStart, p.firstEnd, p.secondStart, p.secondEnd]
        expect("scale \(scale) stays inside the area", points.allSatisfy { area.contains($0) })
    } else {
        expect("scale \(scale) plans", false)
    }
}

// Refusals: a scale that is not a pinch, or no room for two fingers.
expect("scale 1 is refused", refusal(area, 1) == .noChange)
expect("scale 0 is refused", refusal(area, 0) == .invalidScale)
expect("negative scale is refused", refusal(area, -2) == .invalidScale)
expect("NaN scale is refused", refusal(area, .nan) == .invalidScale)
expect("infinite scale is refused", refusal(area, .infinity) == .invalidScale)
expect("empty area is refused", refusal(.zero, 0.5) == .areaTooSmall(span: 0))
expect("null area is refused", refusal(.null, 0.5) == .areaTooSmall(span: 0))
if case .areaTooSmall(let span)? = refusal(CGRect(x: 0, y: 0, width: 30, height: 30), 0.5) {
    expect("a 30pt square is too small to pinch", near(span, (24 * 24 * 2).squareRoot()))
} else {
    expect("a 30pt square is too small to pinch", false)
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all PinchPlan tests passed")
