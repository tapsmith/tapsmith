// Unit tests for OcclusionAnalyzer (PILOT-223), run on the host Mac without a
// simulator: `ios-agent/Tests/run-unit-tests.sh`. The analyzer is pure tree and
// geometry logic over snapshot nodes, so these build it with hand-made trees
// shaped like the ones recorded from an iPhone 17 / iOS 26.1 simulator on the
// test app's /occlusion screen.

import XCTest

typealias Node = OcclusionAnalyzer.Node
typealias Row = (depth: Int, type: XCUIElement.ElementType, label: String, id: String, frame: CGRect)

var failures = 0

func check(_ name: String, _ got: OcclusionAnalyzer.Verdict, _ want: OcclusionAnalyzer.Verdict) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want \(want)")
    }
}

/// `.clear` at `point`, whatever the visible rect.
func checkPoint(_ name: String, _ got: OcclusionAnalyzer.Verdict, _ want: CGPoint) {
    if case .clear(let point, _) = got, point == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want clear at \(want)")
    }
}

/// Build nodes from pre-order rows, each with its depth in the tree.
func tree(_ rows: [Row]) -> [Node] {
    var nodes: [Node] = []
    var stack: [(depth: Int, index: Int)] = []
    for row in rows {
        while let last = stack.last, last.depth >= row.depth {
            nodes[last.index].subtreeEnd = nodes.count
            stack.removeLast()
        }
        let parent = stack.last?.index
        let parentWindow = parent.flatMap { nodes[$0].window }
        let index = nodes.count
        let window: Int? = row.type == .application
            ? nil
            : (row.type == .window && parentWindow == nil ? index : parentWindow)
        nodes.append(Node(
            elementType: row.type, label: row.label, identifier: row.id, frame: row.frame,
            subtreeEnd: index + 1, parent: parent, window: window
        ))
        stack.append((row.depth, index))
    }
    while let last = stack.popLast() { nodes[last.index].subtreeEnd = nodes.count }
    return nodes
}

func R(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect {
    CGRect(x: x, y: y, width: w, height: h)
}

let screen = R(0, 0, 402, 874)

/// The two keyboard windows as recorded on iOS 26: the remote input view host
/// and the keys. The `.keyboard` element (573–816) is smaller than what the
/// keyboard covers (529–874).
let keyboardWindows: [Row] = [
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .other, "", "", R(0, 529, 402, 345)),
    (4, .other, "", "inputView", R(4.67, 529, 393, 345)),
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .other, "", "", R(0, 529, 402, 345)),
    (4, .other, "", "", R(4.67, -71, 393, 1244)),
    (4, .other, "", "", R(0, 573, 402, 301)),
    (5, .keyboard, "", "", R(4.67, 573, 393, 243)),
    (6, .key, "g", "", R(182, 636, 39, 56)),
]

func screenRows(
    bottomHeight: Double = 56,
    overlay: Bool = false,
    passThrough: Bool = false,
    extra: [Row] = []
) -> [Row] {
    var rows: [Row] = [
        (0, .application, "Tapsmith Test App", "", screen),
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
        (3, .navigationBar, "Occlusion", "", R(0, 62, 402, 54)),
        (4, .button, "Back", "", R(8, 70, 40, 40)),
        (3, .other, "", "", R(0, 116, 402, 758)),
        (4, .button, "Covered action", "", R(16, 263.33, 370, 56)),
        (5, .staticText, "Covered action", "", R(100, 280, 150, 20)),
    ]
    if overlay { rows.append((4, .button, "Overlay", "", R(16, 263.33, 370, 56))) }
    rows.append((4, .button, "Pass-through action", "", R(16, 331.33, 370, 56)))
    if passThrough { rows.append((4, .other, "", "pass-through-overlay", R(16, 331.33, 370, 56))) }
    rows.append((4, .button, "Bottom action", "", R(16, 850 - bottomHeight, 370, bottomHeight)))
    rows += extra
    // React Native screens end with full-screen, unlabeled, childless wrappers
    // painted after all content.
    rows.append((3, .other, "", "", screen))
    rows.append((4, .other, "", "", screen))
    return rows
}

func analyzer(_ rows: [Row]) -> OcclusionAnalyzer {
    OcclusionAnalyzer(nodes: tree(rows), screen: screen)
}

func button(_ label: String, _ frame: CGRect, live: Bool = true) -> OcclusionAnalyzer.Target {
    .init(frame: frame, elementType: .button, label: label, identifier: "", isLive: live)
}

let bottom = R(16, 794, 370, 56)
let covered = R(16, 263.33, 370, 56)

// ─── Keyboard ───

let kb = analyzer(screenRows() + keyboardWindows)
check("keyboard covers the bottom button (center below the .keyboard frame)",
      kb.analyze(button("Bottom action", bottom), isHittable: false), .covered(by: "the keyboard"))
// Defensive: measured on iOS 26, XCUITest calls this button unhittable (its hit
// test covers the whole keyboard window); a coordinate gesture must not
// press the keyboard even if a runtime ever said otherwise.
check("keyboard covers even if XCUITest were to call it hittable",
      kb.analyze(button("Bottom action", bottom), isHittable: true), .covered(by: "the keyboard"))
checkPoint("half-covered button: touch the visible part (above the predictive bar at 529)",
           analyzer(screenRows(bottomHeight: 400) + keyboardWindows)
               .analyze(button("Bottom action", R(16, 450, 370, 400)), isHittable: true),
           CGPoint(x: 201, y: 489.5))
checkPoint("a key inside the keyboard is not covered by the keyboard",
           kb.analyze(.init(frame: R(182, 636, 39, 56), elementType: .key, label: "g", identifier: ""), isHittable: true),
           CGPoint(x: 201.5, y: 664))
checkPoint("no keyboard: the bottom button is clear",
           analyzer(screenRows()).analyze(button("Bottom action", bottom), isHittable: true),
           CGPoint(x: 201, y: 822))

// An app view with testID "inputView" in the main window must not make that
// window a keyboard window.
let appInputView: [Row] = [(4, .other, "", "inputView", R(16, 700, 370, 40))]
check("app testID 'inputView' does not exempt main-window targets from the keyboard",
      analyzer(screenRows(extra: appInputView) + keyboardWindows)
          .analyze(button("Bottom action", bottom), isHittable: false),
      .covered(by: "the keyboard"))

// A hardware keyboard's small assistant bar near the bottom is not docked:
// it covers its own frame, not the full width.
let assistantBar: [Row] = [
    (1, .window, "", "", screen),
    (2, .keyboard, "", "", R(150, 800, 100, 44)),
]
checkPoint("a small assistant bar does not cover full-width bottom content beside it",
           analyzer(screenRows(extra: [(4, .button, "Tab", "", R(16, 800, 80, 44))]) + assistantBar)
               .analyze(button("Tab", R(16, 800, 80, 44)), isHittable: true),
           CGPoint(x: 56, y: 822))

// A runtime that puts the keyboard in the app's main window must not make
// every app element "part of the keyboard".
let keyboardInMainWindow: [Row] = screenRows(extra: [(4, .button, "Middle action", "", R(16, 600, 370, 56))]) + [
    (2, .other, "", "", R(0, 529, 402, 345)),
    (3, .keyboard, "", "", R(4.67, 573, 393, 243)),
    (4, .key, "g", "", R(182, 636, 39, 56)),
]
check("keyboard inside the main window still covers app elements behind it",
      analyzer(keyboardInMainWindow).analyze(button("Middle action", R(16, 600, 370, 56)), isHittable: false),
      .covered(by: "the keyboard"))
checkPoint("…and a key inside that keyboard is still tappable",
           analyzer(keyboardInMainWindow)
               .analyze(.init(frame: R(182, 636, 39, 56), elementType: .key, label: "g", identifier: ""), isHittable: true),
           CGPoint(x: 201.5, y: 664))

// ─── Painted-after covers ───

let ov = analyzer(screenRows(overlay: true))
check("overlay covers an unhittable target",
      ov.analyze(button("Covered action", covered), isHittable: false), .covered(by: "button \"Overlay\""))
checkPoint("hittable wins over the snapshot",
           ov.analyze(button("Covered action", covered), isHittable: true), CGPoint(x: 201, y: 291.33))
checkPoint("own child text and trailing unlabeled wrappers are not covers",
           analyzer(screenRows()).analyze(button("Covered action", covered), isHittable: false),
           CGPoint(x: 201, y: 291.33))
let pt = analyzer(screenRows(passThrough: true))
checkPoint("pointerEvents=none overlay, hittable: clear",
           pt.analyze(button("Pass-through action", R(16, 331.33, 370, 56)), isHittable: true),
           CGPoint(x: 201, y: 359.33))
check("identifier-only overlay over an unhittable target: covered",
      pt.analyze(button("Pass-through action", R(16, 331.33, 370, 56)), isHittable: false),
      .covered(by: "element \"pass-through-overlay\""))

// ─── Cached (non-live) identity ───

check("cached identity picks the target, not the same-frame overlay",
      ov.analyze(button("Covered action", covered, live: false), isHittable: false),
      .covered(by: "button \"Overlay\""))
check("cached identity that matches nothing: the element is gone",
      ov.analyze(button("Continue", covered, live: false), isHittable: false), .gone)
check("not live and nothing cached to recognise it by: gone, even with a same-frame node",
      ov.analyze(.init(frame: covered, elementType: nil, label: nil, identifier: nil, isLive: false),
                 isHittable: false),
      .gone)
check("frame-only cached target with nothing at that frame: gone",
      ov.analyze(.init(frame: R(16, 600, 370, 56), elementType: nil, label: nil, identifier: nil, isLive: false),
                 isHittable: false),
      .gone)
check("an unhittable live target that cannot be located is read again, not tapped or 'gone'",
      ov.analyze(button("Continue", covered), isHittable: false),
      .unlocated(point: CGPoint(x: 201, y: 291.33), visible: covered))
checkPoint("with no tree at all there is no evidence: clear",
           OcclusionAnalyzer(nodes: [], screen: screen).analyze(button("Continue", covered), isHittable: false),
           CGPoint(x: 201, y: 291.33))

// ─── Bars ───

checkPoint("back button inside the nav bar is not clipped by it",
           analyzer(screenRows()).analyze(button("Back", R(8, 70, 40, 40)), isHittable: true),
           CGPoint(x: 28, y: 90))
checkPoint("a row half under its screen's nav bar: touch the visible half",
           analyzer(screenRows(extra: [(4, .button, "Row", "", R(16, 90, 370, 50))]))
               .analyze(button("Row", R(16, 90, 370, 50)), isHittable: false),
           CGPoint(x: 201, y: 128))
check("a row fully under its screen's nav bar: covered",
      analyzer(screenRows(extra: [(4, .button, "Row", "", R(16, 64, 370, 50))]))
          .analyze(button("Row", R(16, 64, 370, 50)), isHittable: false),
      .covered(by: "navigation bar \"Occlusion\""))
check("the bar itself as the target is not covered by itself",
      analyzer(screenRows()).analyze(
          .init(frame: R(0, 62, 402, 54), elementType: .navigationBar, label: "Occlusion", identifier: ""),
          isHittable: true),
      .clear(point: CGPoint(x: 201, y: 89), visible: R(0, 62, 402, 54)))
// A sheet presented over the screen is painted after the screen's container;
// the presenter's nav bar does not cover the sheet's header button.
let sheet: [Row] = [
    (2, .other, "", "", R(0, 60, 402, 814)),
    (3, .button, "Cancel", "", R(16, 72, 80, 40)),
]
var sheetRows = screenRows()
sheetRows.insert(contentsOf: sheet, at: sheetRows.count - 2)
checkPoint("a sheet's header button over the presenter's nav bar is not clipped",
           analyzer(sheetRows).analyze(button("Cancel", R(16, 72, 80, 40)), isHittable: true),
           CGPoint(x: 56, y: 92))

// ─── Scroll viewports ───

// A row scrolled half out of its scroll view, under a JS header (an unlabeled
// .other painted before the list, so the painted-after check cannot see it).
let jsHeader: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .other, "", "", R(0, 0, 402, 120)),
    (4, .button, "Back", "", R(8, 60, 60, 44)),
    (3, .scrollView, "", "", R(0, 120, 402, 754)),
    (4, .button, "Row 1", "", R(0, 100, 402, 60)),
    (4, .button, "Row 2", "", R(0, 160, 402, 60)),
]
checkPoint("a row half out of its scroll view: touch the part inside the viewport",
           analyzer(jsHeader).analyze(button("Row 1", R(0, 100, 402, 60)), isHittable: false),
           CGPoint(x: 201, y: 140))
check("a row wholly out of its scroll view: off screen",
      analyzer(jsHeader + [(4, .button, "Row 0", "", R(0, 40, 402, 60))])
          .analyze(button("Row 0", R(0, 40, 402, 60)), isHittable: false),
      .offScreen)

// A scroll indicator is painted over the content's edge but takes no touches.
let indicator: [Row] = jsHeader + [
    (4, .button, "Row 3", "", R(360, 300, 40, 40)),
    (4, .other, "Vertical scroll bar, 2 pages", "", R(380, 120, 22, 754)),
]
check("a scroll indicator over an unhittable row's point is not a cover",
      analyzer(indicator).analyze(button("Row 3", R(360, 300, 40, 40)), isHittable: false),
      .clear(point: CGPoint(x: 380, y: 320), visible: R(360, 300, 40, 40)))

// ─── Text runs ───

// "Terms" and a line-wrapped "Privacy Policy" in one paragraph: the second
// link's frame is the union of its two lines and spans the first's center.
let paragraph: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .staticText, "I agree to the Terms and Privacy Policy", "", R(16, 400, 370, 40)),
    (3, .link, "Terms", "", R(150, 400, 50, 20)),
    (3, .link, "Privacy Policy", "", R(16, 400, 370, 40)),
]
checkPoint("a sibling link's union frame does not cover an unhittable nested link",
           analyzer(paragraph).analyze(.init(frame: R(150, 400, 50, 20), elementType: .link, label: "Terms", identifier: ""),
                                       isHittable: false),
           CGPoint(x: 175, y: 410))

// A bar whose parent is the window itself does not cover a sheet presented in
// that window (only bars inside the target's own container do).
let windowParentedBar: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .navigationBar, "Presenter", "", R(0, 62, 402, 54)),
    (2, .other, "", "", R(0, 116, 402, 758)),
    (2, .other, "", "", R(0, 60, 402, 814)),
    (3, .button, "Cancel", "", R(16, 72, 80, 40)),
]
// The sheet's container is painted after the bar, so "painted after" does not
// apply either; the bar must simply not clip it.
checkPoint("a window-parented nav bar does not clip a sheet presented in that window",
           analyzer(windowParentedBar).analyze(button("Cancel", R(16, 72, 80, 40)), isHittable: true),
           CGPoint(x: 56, y: 92))

// A title Text drawn over a sibling Pressable (a card) is a cover, not a run
// of the target's text.
let card: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", R(16, 400, 370, 120)),
    (3, .button, "Open card", "", R(16, 400, 370, 120)),
    (3, .staticText, "Card title", "", R(16, 440, 370, 40)),
]
check("a sibling Text overlaid on an unhittable Pressable covers it",
      analyzer(card).analyze(button("Open card", R(16, 400, 370, 120)), isHittable: false),
      .covered(by: "text \"Card title\""))

// ─── Geometry ───

check("off screen", analyzer(screenRows()).analyze(button("Gone", R(16, 900, 370, 56)), isHittable: false),
      .offScreen)
let piece = OcclusionAnalyzer.subtract(R(0, 50, 100, 10), from: R(0, 0, 100, 100))
if piece == R(0, 0, 100, 50) { print("ok   subtract keeps the largest piece") } else {
    failures += 1; print("FAIL subtract keeps the largest piece: got \(piece)")
}
let untouched = OcclusionAnalyzer.subtract(R(200, 200, 10, 10), from: R(0, 0, 100, 100))
if untouched == R(0, 0, 100, 100) { print("ok   subtract of a disjoint rect is a no-op") } else {
    failures += 1; print("FAIL subtract of a disjoint rect: got \(untouched)")
}

print(failures == 0 ? "ALL OK" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
