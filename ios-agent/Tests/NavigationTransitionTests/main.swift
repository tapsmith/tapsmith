// Unit tests for NavigationTransition (PILOT-985), run on the host Mac without
// a simulator: `ios-agent/Tests/run-unit-tests.sh`. The trees are shaped like
// snapshots recorded mid-transition: react-native-screens and SwiftUI
// NavigationStack on an iPhone 17 Pro / iOS 26.4 and an iPhone 16 / iOS 18.5.

import XCTest

var failures = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want \(want)")
    }
}

func node(
    _ type: XCUIElement.ElementType,
    _ x: Double, _ y: Double, _ w: Double, _ h: Double,
    _ children: [[String: Any]] = []
) -> [String: Any] {
    var dict: [String: Any] = [
        "elementType": type.rawValue,
        "frame": ["X": x, "Y": y, "Width": w, "Height": h],
    ]
    if !children.isEmpty { dict["children"] = children }
    return dict
}

/// `container` inside an application + window + wrapper of the given size.
func app(_ w: Double, _ h: Double, _ container: [String: Any]) -> [String: Any] {
    node(.application, 0, 0, w, h, [node(.window, 0, 0, w, h, [node(.other, 0, 0, w, h, [container])])])
}

func midTransition(_ tree: [String: Any]) -> Bool {
    NavigationTransition.signature(of: tree) != nil
}

// MARK: - The shape

let backButton = node(.button, -109, 77, 90, 21)

check("iOS 26 push: the outgoing screen sits 30% to the left of the incoming one", midTransition(app(402, 874,
    node(.other, 0, 0, 402, 874, [
        node(.other, -121, 0, 402, 874, [backButton]),
        node(.other, 0, 0, 402, 874),
        node(.other, 0, 0, 402, 874),
        node(.other, 0, 0, 402, 874, [node(.button, 12, 77, 90, 21)]),
        node(.other, 100, 0, 1, 1),
    ]))), true)
check("iOS 26 pop: the outgoing screen sits past the right edge", midTransition(app(402, 874,
    node(.other, 0, 0, 402, 874, [
        node(.other, 0, 0, 402, 874),
        node(.other, 0, 0, 402, 874, [node(.button, 12, 77, 90, 21)]),
        node(.other, 100, 0, 1, 1),
        node(.other, 402, 0, 402, 874),
    ]))), true)
check("iOS 18 push", midTransition(app(393, 852,
    node(.other, 0, 0, 393, 852, [
        node(.other, -118, 0, 393, 852),
        node(.other, 0, 0, 393, 852),
        node(.other, 0, 0, 393, 852),
    ]))), true)
check("iOS 18 pop", midTransition(app(393, 852,
    node(.other, 0, 0, 393, 852, [
        node(.other, 0, 0, 393, 852),
        node(.other, 393, 0, 393, 852),
    ]))), true)
check("a fractional parallax offset", midTransition(app(402, 874,
    node(.other, 0, 0, 402, 874, [
        node(.other, -120.6, 0, 402, 874),
        node(.other, 0, 0, 402, 874),
    ]))), true)
check("right-to-left: the outgoing screen sits 30% to the right", midTransition(app(402, 874,
    node(.other, 0, 0, 402, 874, [
        node(.other, 121, 0, 402, 874),
        node(.other, 0, 0, 402, 874),
    ]))), true)
check("right-to-left pop: past the left edge", midTransition(app(402, 874,
    node(.other, 0, 0, 402, 874, [
        node(.other, 0, 0, 402, 874),
        node(.other, -402, 0, 402, 874),
    ]))), true)
check("landscape", midTransition(app(874, 402,
    node(.other, 0, 0, 874, 402, [
        node(.other, -262, 0, 874, 402),
        node(.other, 0, 0, 874, 402),
    ]))), true)
check("a stack inside a tab, shorter than the window", midTransition(app(402, 874,
    node(.other, 0, 0, 402, 791, [
        node(.other, -121, 0, 402, 791),
        node(.other, 0, 0, 402, 791),
    ]))), true)

check("a settled screen", midTransition(app(402, 874,
    node(.other, 0, 0, 402, 874, [
        node(.other, 0, 0, 402, 874, [node(.button, 12, 77, 90, 21)]),
        node(.other, 0, 0, 402, 874),
    ]))), false)
check("the screen on its own, with no incoming one at the parent's frame", midTransition(app(402, 874,
    node(.other, 0, 0, 402, 874, [node(.other, -121, 0, 402, 874)]))), false)
check("a pager in a scroll view", midTransition(app(402, 874,
    node(.scrollView, 0, 0, 402, 874, [
        node(.other, 0, 0, 402, 874),
        node(.other, 402, 0, 402, 874),
    ]))), false)
check("a scroll view's content, wider than its pages", midTransition(app(402, 874,
    node(.scrollView, 0, 0, 402, 874, [
        node(.other, 0, 0, 1206, 874, [
            node(.other, 0, 0, 402, 874),
            node(.other, 402, 0, 402, 874),
        ]),
    ]))), false)
check("a small carousel, under half the window", midTransition(app(402, 874,
    node(.other, 0, 100, 402, 300, [
        node(.other, 0, 100, 402, 300),
        node(.other, 402, 100, 402, 300),
    ]))), false)
check("a page apart by more than one width", midTransition(app(402, 874,
    node(.other, 0, 0, 402, 874, [
        node(.other, 0, 0, 402, 874),
        node(.other, 804, 0, 402, 874),
    ]))), false)
check("a sibling shifted vertically: a sheet or a scrolled view", midTransition(app(402, 874,
    node(.other, 0, 0, 402, 874, [
        node(.other, 0, 0, 402, 874),
        node(.other, 0, 400, 402, 874),
    ]))), false)
check("buttons the size of a screen are not screens", midTransition(app(402, 874,
    node(.other, 0, 0, 402, 874, [
        node(.other, 0, 0, 402, 874),
        node(.button, -121, 0, 402, 874),
    ]))), false)
check("the shape deep in the tree is found", midTransition(app(402, 874,
    node(.other, 0, 0, 402, 874, [node(.other, 0, 0, 402, 874, [node(.other, 0, 0, 402, 874, [
        node(.other, -121, 0, 402, 874),
        node(.other, 0, 0, 402, 874),
    ])])]))), true)

// MARK: - The wait

/// Runs `settle` over the trees' signatures, on a fake clock where each new
/// tree takes `step` seconds.
final class Run {
    var nowAt = Date(timeIntervalSinceReferenceDate: 0)
    var reads = 0
    var known: String?
    let step: TimeInterval
    init(step: TimeInterval = 0.1, known: String? = nil) { self.step = step; self.known = known }
    func settle(_ signatures: [String?], readDeadline: TimeInterval? = nil) -> String? {
        var rest = signatures.dropFirst()
        let start = nowAt
        return NavigationTransition.settle(
            first: signatures[0],
            signature: { $0 },
            known: &known,
            readDeadline: readDeadline.map { start.addingTimeInterval($0) },
            now: { self.nowAt },
            sleep: { self.nowAt = self.nowAt.addingTimeInterval($0) },
            next: {
                self.reads += 1
                self.nowAt = self.nowAt.addingTimeInterval(self.step)
                return rest.count > 1 ? rest.removeFirst() : rest.first ?? signatures.last!
            }
        )
    }
    var elapsed: TimeInterval { nowAt.timeIntervalSinceReferenceDate }
}

do {
    let run = Run()
    check("a settled tree is read once", run.settle([nil]) ?? "settled", "settled")
    check("… with no wait", run.reads, 0)
    check("… and no time", run.elapsed, 0)
}
do {
    let run = Run()
    check("a transition is waited out", run.settle(["t", "t", nil]) ?? "settled", "settled")
    check("… until the tree has settled", run.reads, 2)
    check("… and it is not remembered", run.known ?? "none", "none")
}
do {
    let run = Run()
    let got = run.settle(["look-alike", "look-alike"])
    check("a shape that never goes away is resolved against at the bound", got ?? "settled", "look-alike")
    check("… within the bound and one read", run.elapsed <= NavigationTransition.maxWaitSeconds + 0.2, true)
    check("… and not before it", run.elapsed >= NavigationTransition.maxWaitSeconds - 0.2, true)
    check("… and is remembered", run.known ?? "none", "look-alike")
    let before = run.reads
    _ = run.settle(["look-alike"])
    check("… so the same shape isn't waited for again", run.reads, before)
    _ = run.settle(["other shape", nil])
    check("… a different shape is", run.reads, before + 1)
}
do {
    let run = Run(known: "look-alike")
    _ = run.settle([nil])
    check("a settled tree forgets the remembered shape", run.known ?? "none", "none")
}
do {
    let run = Run()
    let got = run.settle(["t", "t"], readDeadline: NavigationTransition.readDeadlineMarginSeconds + 0.3)
    check("the daemon's read deadline ends the wait early", got ?? "settled", "t")
    check("… with room left to answer", run.elapsed <= 0.4, true)
    check("… and a cut-short wait proves nothing about the shape", run.known ?? "none", "none")
}
do {
    let run = Run()
    _ = run.settle(["t"], readDeadline: 0.01)
    check("no time left: no wait at all", run.reads, 0)
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("All NavigationTransition tests passed")
