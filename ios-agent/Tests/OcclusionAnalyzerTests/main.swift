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
// On Xcode 26.6 (CI) a pointerEvents="none" overlay fools XCUITest's hit test
// too, so "unhittable" is no evidence here: only an interactive control over
// the point counts as a cover.
checkPoint("pointerEvents=none overlay, unhittable (Xcode 26.6): still clear",
           pt.analyze(button("Pass-through action", R(16, 331.33, 370, 56)), isHittable: false),
           CGPoint(x: 201, y: 359.33))

// @tapsmith/react-native's hooks marker: a screen-sized transparent text in a
// pointerEvents="none" wrapper, painted after all content. On Xcode 26.6 (CI)
// it makes XCUITest call every element under it unhittable; it must never be
// named as their cover (it takes no touches). The visible corner copy carries
// the same label without the testID.
let hooksMarker: [Row] = [
    (2, .other, "", "", screen),
    (3, .staticText, "tapsmith-hooks:1;epoch=0;nav=1;boot=0bb7f557;url=tapsmithtest:///", "tapsmith-hooks", screen),
    (2, .other, "", "", R(300, 850, 100, 12)),
    (3, .staticText, "tapsmith-hooks:1;epoch=0;nav=1;boot=0bb7f557;url=tapsmithtest:///", "", R(300, 850, 100, 12)),
]
checkPoint("the test hooks marker is never a cover",
           analyzer(screenRows() + hooksMarker).analyze(button("Covered action", covered), isHittable: false),
           CGPoint(x: 201, y: 291.33))
check("…while a real cover under the marker still is",
      analyzer(screenRows(overlay: true) + hooksMarker).analyze(button("Covered action", covered), isHittable: false),
      .covered(by: "button \"Overlay\""))

// Only the marker's own text is exempt: a control that happens to carry the
// marker's label prefix is still a cover.
check("a control labeled with the marker prefix still covers",
      analyzer(screenRows(extra: [(4, .button, "tapsmith-hooks:fake", "", covered)]))
          .analyze(button("Covered action", covered), isHittable: false),
      .covered(by: "button \"tapsmith-hooks:fake\""))

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

// A cover candidate is clipped to its scroll views too: a row scrolled up out
// of the list keeps its full frame in the snapshot but is not drawn over the
// header. (On Xcode 26.6 every element can read unhittable, so this check
// runs for header taps on any scrolled list.)
let scrolledUnderHeader: [Row] = jsHeader + [(4, .button, "Row 0", "", R(0, 40, 402, 60))]
checkPoint("a row scrolled out of its list is not a cover for the header's Back button",
           analyzer(scrolledUnderHeader).analyze(button("Back", R(8, 60, 60, 44)), isHittable: false),
           CGPoint(x: 38, y: 82))

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

// A title Text drawn over a sibling Pressable (a card) is not an interactive
// control, so it is not named a cover (a pass-through label looks the same;
// telling them apart needs an accessibility hit test, PILOT-364).
let card: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", R(16, 400, 370, 120)),
    (3, .button, "Open card", "", R(16, 400, 370, 120)),
    (3, .staticText, "Card title", "", R(16, 440, 370, 40)),
]
checkPoint("a Text overlaid on an unhittable Pressable is not named a cover",
           analyzer(card).analyze(button("Open card", R(16, 400, 370, 120)), isHittable: false),
           CGPoint(x: 201, y: 460))
// …but an interactive control painted over it is.
let cardWithButton: [Row] = card + [(3, .button, "Close", "", R(16, 440, 370, 40))]
check("an interactive control over an unhittable target covers it",
      analyzer(cardWithButton).analyze(button("Open card", R(16, 400, 370, 120)), isHittable: false),
      .covered(by: "button \"Close\""))
// Presented containers cover what is under them too.
let alertOver: [Row] = screenRows(extra: [(4, .alert, "Delete?", "", R(40, 250, 322, 200))])
check("an alert over an unhittable target covers it",
      alertOver.isEmpty ? .offScreen : analyzer(alertOver).analyze(button("Covered action", covered), isHittable: false),
      // A native alert is named as one (PILOT-919).
      .covered(by: "alert \"Delete?\""))

// ─── Loading overlays (PILOT-979) ───

// A React Native loading overlay: a plain view (it may be see-through) over
// the screen, with an ActivityIndicator in it. XCUITest's hit test lands on it,
// so the target reads unhittable; the overlay is no interactive control.
let loadingOverlay: [Row] = [
    (3, .other, "", "loading-overlay", R(0, 116, 402, 758)),
    (4, .activityIndicator, "In progress", "", R(181, 475, 40, 40)),
]
var loadingRows = screenRows()
loadingRows.insert(contentsOf: loadingOverlay, at: loadingRows.count - 2)
check("a plain overlay holding a spinner covers an unhittable target",
      analyzer(loadingRows).analyze(button("Covered action", covered), isHittable: false),
      .covered(by: "a loading overlay (element \"loading-overlay\")"))
checkPoint("…but XCUITest's hit test still wins when it says hittable",
           analyzer(loadingRows).analyze(button("Covered action", covered), isHittable: true),
           CGPoint(x: 201, y: 291.33))
check("a spinner right over the touch point covers it",
      analyzer(screenRows(extra: [(4, .activityIndicator, "In progress", "", R(181, 271, 40, 40))]))
          .analyze(button("Covered action", covered), isHittable: false),
      .covered(by: "a loading overlay (progressbar \"In progress\")"))
check("a progress bar counts as well",
      analyzer(screenRows(extra: [(4, .other, "", "", R(0, 200, 402, 200)),
                                  (5, .progressIndicator, "Uploading", "", R(16, 380, 370, 4))]))
          .analyze(button("Covered action", covered), isHittable: false),
      .covered(by: "a loading overlay (element)"))
checkPoint("a spinner painted after the target that misses the point is not a cover",
           analyzer(screenRows(extra: [(4, .activityIndicator, "", "", R(181, 600, 40, 40))]))
               .analyze(button("Covered action", covered), isHittable: false),
           CGPoint(x: 201, y: 291.33))
checkPoint("a spinner inside the target is not a cover",
           analyzer(screenRows(extra: []).enumerated().flatMap { i, row -> [Row] in
               row.label == "Covered action" && row.type == .staticText
                   ? [row, (5, .activityIndicator, "", "", R(340, 271, 40, 40))] : [row]
           }).analyze(button("Covered action", covered), isHittable: false),
           CGPoint(x: 201, y: 291.33))
// The trailing full-screen RN wrappers are painted after everything; one that
// holds no spinner is still no cover (pass-through overlays look the same).
checkPoint("a plain overlay with no spinner is still not a cover",
           analyzer(screenRows(passThrough: true)).analyze(button("Pass-through action", R(16, 331.33, 370, 56)), isHittable: false),
           CGPoint(x: 201, y: 359.33))

// ─── Sticky list rows and scrolling clear of chrome (PILOT-979, PILOT-980) ───

/// A screen with a vertical list (116..874) under a nav bar; rows 44 tall.
func listRows(_ rows: [Row], after: [Row] = []) -> [Row] {
    [
        (0, .application, "App", "", screen),
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
        (3, .navigationBar, "List", "", R(0, 62, 402, 54)),
        (3, .table, "", "", R(0, 116, 402, 758)),
    ] + rows + after
}
let list = R(0, 116, 402, 758)

// UIKit floats a section header over the rows scrolled under it.
let stickyHeader: [Row] = listRows([
    (4, .other, "Section A", "", R(0, 116, 402, 28)),
    (4, .cell, "", "", R(0, 120, 402, 44)),
    (5, .staticText, "Row 5", "", R(16, 130, 200, 20)),
    (4, .cell, "", "", R(0, 164, 402, 44)),
])
check("a section header floating over an unhittable row covers it, and can be scrolled away from",
      analyzer(stickyHeader).analyze(.init(frame: R(0, 120, 402, 44), elementType: .cell, label: "", identifier: ""), isHittable: false),
      .coveredInList(by: "element \"Section A\"", cover: R(0, 116, 402, 28), list: list))
checkPoint("rows that only touch do not cover each other",
           analyzer(stickyHeader).analyze(.init(frame: R(0, 164, 402, 44), elementType: .cell, label: "", identifier: ""), isHittable: false),
           CGPoint(x: 201, y: 186))
// A React Native ScrollView's content view holds its rows.
let rnSticky: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .scrollView, "", "", list),
    (3, .other, "", "", R(0, 0, 402, 3000)),
    (4, .other, "Sticky header", "", R(0, 116, 402, 50)),
    (4, .button, "Row 5", "", R(0, 130, 402, 60)),
]
check("a sticky header in a React Native ScrollView's content covers a row under it",
      analyzer(rnSticky).analyze(button("Row 5", R(0, 130, 402, 60)), isHittable: false),
      .coveredInList(by: "element \"Sticky header\"", cover: R(0, 116, 402, 50), list: list))
let grid: [Row] = listRows([
    (4, .cell, "Left", "", R(0, 200, 201, 100)),
    (4, .other, "badge", "", R(150, 220, 80, 30)),
])
checkPoint("a narrower sibling (a badge) is not a sticky row",
           analyzer(grid).analyze(.init(frame: R(0, 200, 201, 100), elementType: .cell, label: "Left", identifier: ""), isHittable: false),
           CGPoint(x: 100.5, y: 250))

// A sticky footer's button over a row of the list, outside the list.
let footer: [Row] = listRows([
    (4, .cell, "Row 20", "", R(0, 790, 402, 44)),
], after: [(3, .button, "Checkout", "", R(0, 774, 402, 100))])
check("a control outside the list over an unhittable row can be scrolled away from",
      analyzer(footer).analyze(.init(frame: R(0, 790, 402, 44), elementType: .cell, label: "Row 20", identifier: ""), isHittable: false),
      .coveredInList(by: "button \"Checkout\"", cover: R(0, 774, 402, 100), list: list))
// The same control inside the list moves with the row: no scrolling away.
let inListButton: [Row] = listRows([
    (4, .cell, "Row 20", "", R(0, 790, 402, 44)),
    (4, .button, "Checkout", "", R(0, 774, 402, 100)),
])
check("a control inside the same list is a plain cover",
      analyzer(inListButton).analyze(.init(frame: R(0, 790, 402, 44), elementType: .cell, label: "Row 20", identifier: ""), isHittable: false),
      .covered(by: "button \"Checkout\""))
// A presented alert is never scrolled away from, even when one of its
// buttons is what covers the point.
let alertWithButtons: [Row] = listRows([
    (4, .cell, "Row 5", "", R(0, 300, 402, 44)),
], after: [(3, .alert, "Delete?", "", R(40, 250, 322, 200)),
           (4, .button, "Delete", "", R(40, 290, 322, 44)),
           (4, .button, "Cancel", "", R(40, 334, 322, 44))])
check("an alert's button over a row is a plain cover",
      analyzer(alertWithButtons).analyze(.init(frame: R(0, 300, 402, 44), elementType: .cell, label: "Row 5", identifier: ""), isHittable: false),
      .covered(by: "button \"Delete\""))
// A control in another window (an overlay window) is not scrolled away from.
let otherWindowButton: [Row] = listRows([(4, .cell, "Row 20", "", R(0, 790, 402, 44))])
    + [(1, .window, "", "", screen), (2, .button, "Toast action", "", R(0, 774, 402, 100))]
check("a control in another window is a plain cover",
      analyzer(otherWindowButton).analyze(.init(frame: R(0, 790, 402, 44), elementType: .cell, label: "Row 20", identifier: ""), isHittable: false),
      .covered(by: "button \"Toast action\""))
// A checkout bar: a "Total" label above its button. Clearing only the button
// would leave the row under the label.
let checkoutBar: [Row] = listRows([
    (4, .cell, "Row 20", "", R(0, 800, 402, 44)),
], after: [(3, .other, "", "checkout-bar", R(0, 700, 402, 174)),
           (4, .staticText, "Total $42", "", R(16, 710, 200, 30)),
           (4, .button, "Checkout", "", R(0, 774, 402, 100))])
check("a control in a bar over a list is cleared as the whole bar",
      analyzer(checkoutBar).analyze(.init(frame: R(0, 800, 402, 44), elementType: .cell, label: "Row 20", identifier: ""), isHittable: false),
      .coveredInList(by: "button \"Checkout\"", cover: R(0, 700, 402, 174), list: list))
// A React Native ScrollView whose content has a background view behind its
// rows: not a sticky row.
let rnBackground: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .scrollView, "", "", list),
    (3, .other, "", "", R(0, 0, 402, 3000)),
    (4, .other, "", "content-background", R(0, 0, 402, 3000)),
    (4, .button, "Row 5", "", R(0, 130, 402, 60)),
]
checkPoint("a background behind a scroll view's rows is not a sticky row",
           analyzer(rnBackground).analyze(button("Row 5", R(0, 130, 402, 60)), isHittable: false),
           CGPoint(x: 201, y: 160))
// A presented alert is never scrolled away from.
let alertOverList: [Row] = listRows([
    (4, .cell, "Row 5", "", R(0, 300, 402, 44)),
], after: [(3, .alert, "Delete?", "", R(40, 250, 322, 200))])
check("an alert over a row is a plain cover",
      analyzer(alertOverList).analyze(.init(frame: R(0, 300, 402, 44), elementType: .cell, label: "Row 5", identifier: ""), isHittable: false),
      .covered(by: "alert \"Delete?\""))
// A tab bar over a row: bars are checked whatever XCUITest says.
let tabBarOverList: [Row] = listRows([
    (4, .cell, "Row 20", "", R(0, 800, 402, 44)),
], after: [(3, .tabBar, "Tab Bar", "", R(0, 791, 402, 83))])
check("a row entirely under a tab bar can be scrolled away from",
      analyzer(tabBarOverList).analyze(.init(frame: R(0, 800, 402, 44), elementType: .cell, label: "Row 20", identifier: ""), isHittable: true),
      .coveredInList(by: "tab bar \"Tab Bar\"", cover: R(0, 791, 402, 83), list: list))
check("a loading overlay over a row is waited out, not scrolled away from",
      analyzer(listRows([(4, .cell, "Row 5", "", R(0, 300, 402, 44))],
                        after: [(3, .other, "", "", list), (4, .activityIndicator, "", "", R(181, 475, 40, 40))]))
          .analyze(.init(frame: R(0, 300, 402, 44), elementType: .cell, label: "Row 5", identifier: ""), isHittable: false),
      .covered(by: "a loading overlay (element)"))

// A loading overlay drawn over a footer button is what is in the way first:
// wait it out (a drag under it would be wasted), whatever chrome is beneath.
let overlayOverFooter: [Row] = footer + [(3, .other, "", "", screen), (4, .activityIndicator, "", "", R(181, 475, 40, 40))]
check("a loading overlay over a footer button is waited out, not scrolled away from",
      analyzer(overlayOverFooter).analyze(.init(frame: R(0, 790, 402, 44), elementType: .cell, label: "Row 20", identifier: ""), isHittable: false),
      .covered(by: "a loading overlay (element)"))
let cancelInOverlay: [Row] = listRows([(4, .cell, "Row 20", "", R(0, 790, 402, 44))],
    after: [(3, .other, "", "", R(0, 600, 402, 274)),
            (4, .activityIndicator, "", "", R(181, 620, 40, 40)),
            (4, .button, "Cancel", "", R(0, 774, 402, 100))])
check("a control inside a loading overlay is named but never scrolled away from",
      analyzer(cancelInOverlay).analyze(.init(frame: R(0, 790, 402, 44), elementType: .cell, label: "Row 20", identifier: ""), isHittable: false),
      .covered(by: "button \"Cancel\""))
let overlayOverTabBar: [Row] = tabBarOverList + [(3, .other, "", "", screen), (4, .activityIndicator, "", "", R(181, 475, 40, 40))]
check("a loading overlay over a tab bar is waited out before the bar is scrolled away from",
      analyzer(overlayOverTabBar).analyze(.init(frame: R(0, 800, 402, 44), elementType: .cell, label: "Row 20", identifier: ""), isHittable: false),
      .covered(by: "a loading overlay (element)"))
check("…while a hittable target under the tab bar is still scrolled clear",
      analyzer(overlayOverTabBar).analyze(.init(frame: R(0, 800, 402, 44), elementType: .cell, label: "Row 20", identifier: ""), isHittable: true),
      .coveredInList(by: "tab bar \"Tab Bar\"", cover: R(0, 791, 402, 83), list: list))

// React Native (recorded on iOS 26.4, the test app's /covers screen): the
// ScrollView's content view sits in another wrapper, and each row lists its
// own empty background view beside its controls. The sticky header is the
// wrapper holding "sticky-header".
let rnNestedSticky: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .scrollView, "", "", R(16, 326, 370, 531)),
    (3, .other, "", "", R(16, 26, 370, 1940)),
    (4, .other, "", "", R(16, 26, 370, 1940)),
    (5, .button, "Row 5", "covers-row", R(16, 326, 290, 60)),
    (5, .other, "", "", R(16, 326, 370, 60)),
    (6, .other, "", "sticky-header", R(16, 326, 370, 60)),
    (7, .staticText, "Sticky header", "", R(32, 346, 200, 20)),
    (5, .other, "", "", R(16, 326, 370, 60)),
    (5, .button, "Add", "", R(306, 326, 80, 59)),
    (5, .button, "Row 6", "covers-row", R(16, 386, 290, 60)),
    (5, .other, "", "", R(16, 386, 370, 60)),
]
check("a sticky header in React Native's nested content view covers the row under it",
      analyzer(rnNestedSticky).analyze(.init(frame: R(16, 326, 290, 60), elementType: .button, label: "Row 5", identifier: "covers-row"), isHittable: false),
      .coveredInList(by: "element", cover: R(16, 326, 370, 60), list: R(16, 326, 370, 531)))
checkPoint("a row's own empty background view is not a sticky row",
           analyzer(rnNestedSticky).analyze(.init(frame: R(16, 386, 290, 60), elementType: .button, label: "Row 6", identifier: "covers-row"), isHittable: false),
           CGPoint(x: 161, y: 416))

// ─── Where a clearing drag may start (PILOT-980) ───

func expectBool(_ name: String, _ got: Bool, _ want: Bool) {
    if got == want { print("ok   \(name)") } else { failures += 1; print("FAIL \(name): got \(got), want \(want)") }
}
let row20 = OcclusionAnalyzer.Target(frame: R(0, 790, 402, 44), elementType: .cell, label: "Row 20", identifier: "")
expectBool("a drag starting on the list itself is on the list",
           analyzer(footer).isDragStartOnList(row20, list: list, cover: R(0, 774, 402, 100), at: CGPoint(x: 201, y: 766)), true)
// An in-window dialog (a JS modal): its full-screen dismissing backdrop lies
// where the drag would start.
let dialogOverList: [Row] = listRows([(4, .cell, "Row 20", "", R(0, 790, 402, 44))],
    after: [(3, .other, "", "", screen),
            (4, .button, "Close modal", "", screen),
            (4, .other, "", "", R(20, 700, 362, 174)),
            (5, .button, "OK", "", R(20, 774, 362, 100))])
expectBool("a drag starting on a dialog's backdrop is not on the list",
           analyzer(dialogOverList).isDragStartOnList(row20, list: list, cover: R(20, 700, 362, 174), at: CGPoint(x: 201, y: 692)), false)
// The same dialog with a role-less backdrop (a React Native Pressable with no
// accessibilityRole reads as .other): still not the list.
let rolelessBackdrop: [Row] = listRows([(4, .cell, "Row 20", "", R(0, 790, 402, 44))],
    after: [(3, .other, "", "", screen),
            (4, .other, "", "", screen),
            (4, .other, "", "", R(20, 700, 362, 174)),
            (5, .button, "OK", "", R(20, 774, 362, 100))])
expectBool("a drag starting on a role-less dialog backdrop is not on the list",
           analyzer(rolelessBackdrop).isDragStartOnList(row20, list: list, cover: R(20, 700, 362, 174), at: CGPoint(x: 201, y: 692)), false)
// A full-screen host that only lays a footer out (pointerEvents box-none)
// holds the footer but nothing else at the drag start.
let footerInHost: [Row] = listRows([(4, .cell, "Row 20", "", R(0, 790, 402, 44))],
    after: [(3, .other, "", "", screen),
            (4, .button, "Checkout", "", R(0, 774, 402, 100))])
expectBool("a drag starting under a host that only lays out the footer is on the list",
           analyzer(footerInHost).isDragStartOnList(row20, list: list, cover: R(0, 774, 402, 100), at: CGPoint(x: 201, y: 766)), true)
expectBool("a target whose list is not found never gets a drag",
           analyzer(footer).isDragStartOnList(row20, list: R(0, 0, 10, 10), cover: R(0, 774, 402, 100), at: CGPoint(x: 201, y: 766)), false)

// ─── Keyboard first (PILOT-622) ───

func checkKF(_ name: String, _ got: OcclusionAnalyzer.KeyboardFirst, _ want: OcclusionAnalyzer.KeyboardFirst) {
    if got == want { print("ok   \(name)") } else { failures += 1; print("FAIL \(name): got \(got), want \(want)") }
}

/// The test app's login screen: a form inside a React Native ScrollView.
func loginRows(scroll: Bool = true) -> [Row] {
    let container: XCUIElement.ElementType = scroll ? .scrollView : .other
    return [
        (0, .application, "Tapsmith Test App", "", screen),
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
        (3, container, "", "", R(0, 116, 402, 413)),
        (4, .staticText, "Sign In", "", R(24, 140, 200, 34)),
        (4, .textField, "Email", "email-input", R(24, 210, 354, 44)),
        (4, .secureTextField, "Password", "password-input", R(24, 290, 354, 44)),
        (4, .button, "Sign in", "", R(24, 360, 354, 48)),
        (5, .staticText, "Sign in", "", R(170, 372, 62, 22)),
        (3, .other, "", "", screen),
    ]
}
let signIn = button("Sign in", R(24, 360, 354, 48))
checkKF("keyboard up, a button in a scroll view: put the keyboard away first",
        analyzer(loginRows() + keyboardWindows).keyboardFirst(signIn), .putKeyboardAway)
let staleThenReal: [Row] = [
    (1, .window, "", "", screen),
    (2, .keyboard, "", "", R(0, 900, 402, 243)),
] + keyboardWindows
checkKF("a stale off-screen keyboard before the real one (keyboard-type switch): still a keyboard",
        analyzer(loginRows() + staleThenReal).keyboardFirst(signIn), .putKeyboardAway)
checkKF("only an off-screen keyboard element: no keyboard",
        analyzer(loginRows() + [(1, .window, "", "", screen), (2, .keyboard, "", "", R(0, 900, 402, 243))]).keyboardFirst(signIn),
        .noKeyboard)
checkKF("no keyboard: nothing to do",
        analyzer(loginRows()).keyboardFirst(signIn), .noKeyboard)
checkKF("a zero-sized keyboard element is no keyboard",
        analyzer(loginRows() + [(1, .window, "", "", screen), (2, .keyboard, "", "", R(0, 874, 402, 0))]).keyboardFirst(signIn),
        .noKeyboard)
checkKF("another text field takes the focus with the keyboard up: touched as is",
        analyzer(loginRows() + keyboardWindows).keyboardFirst(
            .init(frame: R(24, 290, 354, 44), elementType: .secureTextField, label: "Password", identifier: "password-input")),
        .touchAsIs)
checkKF("a field found only by its frame is still a field",
        analyzer(loginRows() + keyboardWindows).keyboardFirst(
            .init(frame: R(24, 210, 354, 44), elementType: nil, label: nil, identifier: nil)),
        .touchAsIs)
checkKF("a button outside any scroll view: touched as is",
        analyzer(loginRows(scroll: false) + keyboardWindows).keyboardFirst(signIn), .touchAsIs)
checkKF("a key of the keyboard: touched as is",
        analyzer(loginRows() + keyboardWindows).keyboardFirst(
            .init(frame: R(182, 636, 39, 56), elementType: .key, label: "g", identifier: "")),
        .touchAsIs)
checkKF("a target not in the tree: touched as is",
        analyzer(loginRows() + keyboardWindows).keyboardFirst(button("Gone", R(24, 700, 354, 48))), .touchAsIs)
let inWebView: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .webView, "", "", R(0, 116, 402, 413)),
    (3, .button, "Go", "", R(24, 360, 354, 48)),
]
let inTable: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .table, "", "", R(0, 116, 402, 413)),
    (3, .cell, "New York", "", R(0, 160, 402, 44)),
]
checkKF("a native table row (a suggestion list) is touched with the keyboard up",
        analyzer(inTable + keyboardWindows).keyboardFirst(
            .init(frame: R(0, 160, 402, 44), elementType: .cell, label: "New York", identifier: "")),
        .touchAsIs)
let webInScroll: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .scrollView, "", "", R(0, 116, 402, 600)),
    (3, .webView, "", "", R(0, 116, 402, 413)),
    (4, .button, "Go", "", R(24, 360, 354, 48)),
]
let withClear: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .scrollView, "", "", R(0, 116, 402, 413)),
    (3, .textField, "Search", "", R(24, 210, 354, 44)),
    (4, .button, "Clear text", "", R(340, 220, 24, 24)),
]
checkKF("a text field's own clear button: touched as is",
        analyzer(withClear + keyboardWindows).keyboardFirst(button("Clear text", R(340, 220, 24, 24))), .touchAsIs)
checkKF("web content inside a scroll view: touched as is",
        analyzer(webInScroll + keyboardWindows).keyboardFirst(button("Go", R(24, 360, 354, 48))), .touchAsIs)
checkKF("a web view is not a React Native scroll view: touched as is",
        analyzer(inWebView + keyboardWindows).keyboardFirst(button("Go", R(24, 360, 354, 48))), .touchAsIs)

// ─── Geometry ───

check("off screen", analyzer(screenRows()).analyze(button("Gone", R(16, 900, 370, 56)), isHittable: false),
      .offScreen)

// ─── Unloaded table rows (PILOT-800) ───
// A plain UITableView as recorded on iOS 26: an unloaded row keeps its real
// cell frame (below the screen) while its contents sit at a placeholder at
// the table's origin, over the table header.
let tableRows: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .table, "", "", R(0, 168, 402, 672)),
    (3, .staticText, "Nothing selected", "", R(0, 168, 402, 44)),
    (3, .cell, "", "", R(0, 212, 402, 53)),
    (4, .staticText, "Row 1", "", R(20, 228, 44, 20)),
    (4, .button, "chevron", "", R(371, 231, 11, 14)),
    (3, .cell, "", "", R(0, 901, 402, 53)),
    (4, .button, "chevron", "", R(0, 168, 10, 14)),
    (4, .staticText, "Row 14", "", R(0, 168, 55, 20)),
]
let table = analyzer(tableRows)
let row14 = OcclusionAnalyzer.Target(frame: R(0, 168, 55, 20), elementType: .staticText, label: "Row 14", identifier: "")
check("an unloaded row's text, read live at its placeholder: off screen, not touched there",
      table.analyze(row14, isHittable: false), .offScreen)
check("…even if XCUITest were to call it hittable", table.analyze(row14, isHittable: true), .offScreen)
let row1 = OcclusionAnalyzer.Target(frame: R(20, 228, 44, 20), elementType: .staticText, label: "Row 1", identifier: "")
checkPoint("a loaded row's text is touched where it is", table.analyze(row1, isHittable: false), CGPoint(x: 42, y: 238))
let header = OcclusionAnalyzer.Target(frame: R(0, 168, 402, 44), elementType: .staticText, label: "Nothing selected", identifier: "")
checkPoint("placeholder contents do not cover what is really at the table's origin",
           table.analyze(header, isHittable: false), CGPoint(x: 201, y: 190))
if table.nodes[8].frame == R(0, 901, 402, 53) { print("ok   placeholder nodes are placed at their cell") } else {
    failures += 1; print("FAIL placeholder nodes are placed at their cell: got \(table.nodes[8].frame)")
}

let piece = OcclusionAnalyzer.subtract(R(0, 50, 100, 10), from: R(0, 0, 100, 100))
if piece == R(0, 0, 100, 50) { print("ok   subtract keeps the largest piece") } else {
    failures += 1; print("FAIL subtract keeps the largest piece: got \(piece)")
}
let untouched = OcclusionAnalyzer.subtract(R(200, 200, 10, 10), from: R(0, 0, 100, 100))
if untouched == R(0, 0, 100, 100) { print("ok   subtract of a disjoint rect is a no-op") } else {
    failures += 1; print("FAIL subtract of a disjoint rect: got \(untouched)")
}

// PILOT-825: a pinch's fingers reach toward the area's corners, where a
// control floating over a map is drawn; the centre check does not see it.
let mapRows: [Row] = [
    (0, .application, "", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .map, "Map", "map", R(0, 100, 402, 600)),
    (4, .button, "Pin", "", R(150, 350, 40, 40)),
    (3, .button, "Locate me", "", R(330, 120, 60, 60)),
    (3, .scrollView, "", "", R(0, 700, 402, 100)),
    (4, .button, "Clipped", "", R(330, 600, 60, 60)),
]
let map = analyzer(mapRows)
let mapTarget = OcclusionAnalyzer.Target(frame: R(0, 100, 402, 600), elementType: .map, label: "Map", identifier: "map")
let cornerCover = map.interactiveCover(of: mapTarget, at: [CGPoint(x: 201, y: 400), CGPoint(x: 350, y: 150)])
if cornerCover == "button \"Locate me\"" { print("ok   a control over a finger's corner is the pinch's cover") } else {
    failures += 1; print("FAIL a control over a finger's corner is the pinch's cover: got \(String(describing: cornerCover))")
}
let clearCover = map.interactiveCover(of: mapTarget, at: [CGPoint(x: 100, y: 500), CGPoint(x: 170, y: 370)])
if clearCover == nil { print("ok   the target's own children and clipped content are not covers") } else {
    failures += 1; print("FAIL the target's own children and clipped content are not covers: got \(clearCover!)")
}
let lostTarget = OcclusionAnalyzer.Target(frame: R(5, 5, 10, 10), elementType: .map, label: "Gone", identifier: "")
if map.interactiveCover(of: lostTarget, at: [CGPoint(x: 350, y: 150)]) == nil {
    print("ok   an unplaced target names no cover")
} else {
    failures += 1; print("FAIL an unplaced target names no cover")
}

print(failures == 0 ? "ALL OK" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
