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

// ─── iOS 27 full-window toolbar host (PILOT-1207) ───

// Recorded from an iPhone 17 Pro / iOS 27.2 simulator: every app window gets a
// last child `Toolbar` ("Toolbar"/"Toolbar") the size of the window, with one
// empty `.other` in it, painted after all content.
let ios27Form: [Row] = [
    (0, .application, "Tapsmith Native", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .navigationBar, "", "Login Form", R(0, 62, 402, 106)),
    (4, .button, "Native Screens", "BackButton", R(16, 62, 44, 44)),
    (3, .other, "", "", screen),
    (4, .collectionView, "", "", screen),
    (5, .cell, "", "", R(20, 172, 362, 44)),
    (6, .textField, "", "", R(36, 183, 330, 22)),
]
let ios27Placeholder: [Row] = [
    (3, .toolbar, "Toolbar", "Toolbar", screen),
    (4, .other, "", "", screen),
]
let email = OcclusionAnalyzer.Target(frame: R(36, 183, 330, 22), elementType: .textField, label: "", identifier: "")
for hittable in [true, false] {
    check("iOS 27's empty full-window toolbar does not cover a text field (hittable: \(hittable))",
          analyzer(ios27Form + ios27Placeholder).analyze(email, isHittable: hittable),
          .clear(point: CGPoint(x: 201, y: 194), visible: R(36, 183, 330, 22)))
}

// A real bottom toolbar on iOS 27: the same full-window host, now holding the
// items as floating capsules near the bottom. The host's frame is not the
// bar; the items are what is drawn over the content.
let ios27BottomBar: [Row] = [
    (3, .toolbar, "Toolbar", "Toolbar", screen),
    (4, .other, "", "", screen),
    (5, .other, "", "", R(0, 62, 402, 812)),
    (6, .other, "", "", R(28, 798, 91, 48)),
    (7, .button, "Archive", "", R(33, 804, 81, 36)),
    (6, .other, "", "", R(267, 798, 107, 48)),
    (7, .button, "Compose", "", R(272, 804, 97, 36)),
]
let rowUnderArchive = OcclusionAnalyzer.Target(frame: R(16, 796, 120, 52), elementType: .cell, label: "", identifier: "")
let bottomBarScreen = ios27Form + [(5, .cell, "", "", R(16, 796, 120, 52))] + ios27BottomBar
check("iOS 27: a row under a bottom-toolbar item is covered by the item, not by the host",
      analyzer(bottomBarScreen).analyze(rowUnderArchive, isHittable: false),
      .covered(by: "button \"Archive\""))
check("iOS 27: a text field above a bottom toolbar is not covered by its host",
      analyzer(ios27Form + ios27BottomBar).analyze(email, isHittable: true),
      .clear(point: CGPoint(x: 201, y: 194), visible: R(36, 183, 330, 22)))
checkPoint("iOS 27: a bottom-toolbar item is touched where it is",
           analyzer(ios27Form + ios27BottomBar).analyze(button("Compose", R(272, 804, 97, 36)), isHittable: true),
           CGPoint(x: 320.5, y: 822))
// A bar of bar size still covers what is under it, on any runtime.
check("a row fully under a bar-sized bottom toolbar is covered by it",
      analyzer(ios27Form + [(5, .cell, "", "", R(16, 800, 370, 40)), (3, .toolbar, "", "", R(0, 790, 402, 84))])
          .analyze(.init(frame: R(16, 800, 370, 40), elementType: .cell, label: "", identifier: ""), isHittable: true),
      .covered(by: "toolbar"))
// The host spans its own window, which need not be the screen (an iPad
// split view, a Stage Manager window).
let halfWindow = R(0, 0, 201, 874)
check("a toolbar spanning its window narrower than the screen is a host too",
      analyzer([
          (0, .application, "App", "", screen),
          (1, .window, "", "", halfWindow),
          (2, .other, "", "", halfWindow),
          (3, .textField, "", "", R(20, 183, 160, 22)),
          (2, .toolbar, "Toolbar", "Toolbar", halfWindow),
      ]).analyze(.init(frame: R(20, 183, 160, 22), elementType: .textField, label: "", identifier: ""), isHittable: true),
      .clear(point: CGPoint(x: 100, y: 194), visible: R(20, 183, 160, 22)))

// A sheet on iOS 27 gets its own host, the size of the sheet's container
// (below the status bar), laid over the sheet's nav bar and content.
let ios27Sheet: [Row] = [
    (0, .application, "Tapsmith Native", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .other, "", "", R(0, 62, 402, 812)),
    (4, .navigationBar, "", "Sheet", R(0, 78, 402, 106)),
    (5, .other, "", "", R(316, 82, 66, 36)),
    (6, .button, "Done", "", R(316, 82, 66, 36)),
    (5, .staticText, "Sheet", "", R(16, 135, 93, 41)),
    (4, .other, "", "", R(0, 62, 402, 812)),
    (5, .staticText, "Sheet content", "", R(147, 501, 107, 21)),
    (4, .toolbar, "Toolbar", "Toolbar", R(0, 62, 402, 812)),
    (5, .other, "", "", R(0, 62, 402, 812)),
]
for hittable in [true, false] {
    checkPoint("iOS 27: a sheet's own toolbar host does not cover its Done button (hittable: \(hittable))",
               analyzer(ios27Sheet).analyze(button("Done", R(316, 82, 66, 36)), isHittable: hittable),
               CGPoint(x: 349, y: 100))
}
// A real bar wrapped in a view of its own size (a UIViewRepresentable host)
// fills its container too, but is laid over nothing in it: still a bar.
check("a bar alone in a wrapper of its own size still covers what is under it",
      analyzer(ios27Form + [
          (5, .cell, "", "", R(16, 800, 370, 40)),
          (3, .other, "", "", R(0, 790, 402, 84)),
          (4, .toolbar, "", "", R(0, 790, 402, 84)),
      ]).analyze(.init(frame: R(16, 800, 370, 40), elementType: .cell, label: "", identifier: ""), isHittable: true),
      .covered(by: "toolbar"))

// ... and so does one in a bar-sized wrapper with something smaller laid out
// before it (a badge before a custom React Native tab bar): it is not laid
// over content that fills the wrapper, so it is not a host.
checkPoint("a bar in a bar-sized wrapper after a sibling still clips a row half under it",
           analyzer(ios27Form + [
               (5, .cell, "", "", R(16, 770, 370, 60)),
               (3, .other, "", "", R(0, 790, 402, 84)),
               (4, .staticText, "3", "", R(300, 792, 16, 16)),
               (4, .tabBar, "", "", R(0, 790, 402, 84)),
               (5, .button, "Home", "", R(20, 795, 80, 50)),
           ]).analyze(.init(frame: R(16, 770, 370, 60), elementType: .cell, label: "", identifier: ""), isHittable: true),
           CGPoint(x: 201, y: 780))

// The iPhone Duo simulator (iOS 27.2, PILOT-1251) lays the host out first in
// the screen's container, before the navigation bar and the content, and on a
// pushed screen it holds the floating back button.
let duo = R(0, 0, 466, 678)
func duoAnalyzer(_ rows: [Row]) -> OcclusionAnalyzer { OcclusionAnalyzer(nodes: tree(rows), screen: duo) }
let duoToggles: [Row] = [
    (0, .application, "Tapsmith Native", "", duo),
    (1, .window, "", "", duo),
    (2, .other, "", "", duo),
    (3, .other, "", "", duo),
    (4, .toolbar, "Toolbar", "Toolbar", duo),
    (5, .other, "", "", duo),
    (6, .other, "", "", R(394, 174, 48, 48)),
    (7, .button, "", "BackButton", R(399, 179, 38, 38)),
    (4, .navigationBar, "", "Toggles", R(0, 24, 466, 58)),
    (5, .staticText, "Toggles", "", R(20, 31, 90, 34)),
    (4, .other, "", "", duo),
    (5, .collectionView, "", "", duo),
    (6, .cell, "", "", R(20, 300, 426, 52)),
    (7, .button, "Large", "", R(300, 310, 107, 32)),
]
for hittable in [true, false] {
    checkPoint("iPhone Duo: a host laid out first does not cover the content (hittable: \(hittable))",
               duoAnalyzer(duoToggles).analyze(button("Large", R(300, 310, 107, 32)), isHittable: hittable),
               CGPoint(x: 353.5, y: 326))
}
checkPoint("iPhone Duo: the back button in a first host is touched where it is",
           duoAnalyzer(duoToggles).analyze(.init(frame: R(399, 179, 38, 38), elementType: .button, label: "", identifier: "BackButton"),
                                        isHittable: false),
           CGPoint(x: 418, y: 198))
// A TabView: the tab's host, holding the floating tab bar, is alone in a
// wrapper of its own size after the tab's content. Content under a tab
// button is still covered by the button.
let duoTabs: [Row] = [
    (0, .application, "Tapsmith Native", "", duo),
    (1, .window, "", "", duo),
    (2, .other, "", "", duo),
    (3, .other, "", "", duo),
    (4, .staticText, "Feed tab content", "", R(126, 352, 129, 21)),
    (4, .button, "Under", "", R(400, 500, 30, 20)),
    (3, .other, "", "", duo),
    (4, .toolbar, "Toolbar", "Toolbar", duo),
    (5, .other, "", "", R(394, 492, 48, 162)),
    (6, .button, "Feed", "house", R(396, 494, 44, 58)),
]
for hittable in [true, false] {
    checkPoint("iPhone Duo: a host alone in a same-size wrapper does not cover the tab's content (hittable: \(hittable))",
               duoAnalyzer(duoTabs).analyze(.init(frame: R(126, 352, 129, 21), elementType: .staticText,
                                               label: "Feed tab content", identifier: ""), isHittable: hittable),
               CGPoint(x: 190.5, y: 362.5))
}
check("iPhone Duo: content under a floating tab button is still covered by the button",
      duoAnalyzer(duoTabs).analyze(button("Under", R(400, 500, 30, 20)), isHittable: false),
      .covered(by: "button \"Feed\""))

// A sheet at a small detent (or an iPad popover) gets the same host, however
// short: a host is told by what it is laid over, not by its size.
let shortSheet: [Row] = [
    (0, .application, "Tapsmith Native", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .other, "", "", R(0, 624, 402, 250)),
    (4, .navigationBar, "", "Sheet", R(0, 640, 402, 54)),
    (4, .other, "", "", R(0, 624, 402, 250)),
    (5, .button, "Save", "", R(150, 760, 102, 44)),
    (4, .toolbar, "Toolbar", "Toolbar", R(0, 624, 402, 250)),
    (5, .other, "", "", R(0, 624, 402, 250)),
]
checkPoint("iOS 27: a short sheet's toolbar host does not cover its button",
           analyzer(shortSheet).analyze(button("Save", R(150, 760, 102, 44)), isHittable: true),
           CGPoint(x: 201, y: 782))
// A full-height bar whose earlier sibling is smaller than the container
// (a side rail after a badge) is still a bar.
check("a bar filling a tall wrapper after a smaller sibling still covers what is under it",
      analyzer(ios27Form + [
          (5, .cell, "", "", R(16, 300, 40, 40)),
          (3, .other, "", "", R(0, 0, 80, 874)),
          (4, .staticText, "3", "", R(60, 300, 16, 16)),
          (4, .toolbar, "", "", R(0, 0, 80, 874)),
      ]).analyze(.init(frame: R(16, 300, 40, 40), elementType: .cell, label: "", identifier: ""), isHittable: true),
      .covered(by: "toolbar"))

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
// XCUITest calls a React Native text field under a loading overlay hittable:
// the overlay still covers it (the focusing tap would land on the overlay).
// Another control over a hittable field is still left to the hit test.
let fieldUnderOverlay: [Row] = screenRows(extra: []).map { row in
    row.label == "Covered action" && row.type == .button ? (row.depth, .textField, "Covered field", row.id, row.frame) : row
}
var fieldLoadingRows = fieldUnderOverlay
fieldLoadingRows.insert(contentsOf: loadingOverlay, at: fieldLoadingRows.count - 2)
let coveredField = OcclusionAnalyzer.Target(frame: covered, elementType: .textField, label: "Covered field", identifier: "")
check("a loading overlay covers a text field XCUITest calls hittable",
      analyzer(fieldLoadingRows).analyze(coveredField, isHittable: true),
      .covered(by: "a loading overlay (element \"loading-overlay\")"))
checkPoint("…but a plain control over a hittable text field is left to the hit test",
           analyzer(fieldUnderOverlay).analyze(coveredField, isHittable: true),
           CGPoint(x: 201, y: 291.33))
// A hittable text field under an overlay whose Cancel button lies over it, or
// under a control painted after the overlay: still covered, by the control.
func asField(_ rows: [Row]) -> [Row] {
    rows.map { row in
        row.label == "Covered action" && row.type == .button ? (row.depth, .textField, "Covered field", row.id, row.frame) : row
    }
}
var fieldCancelRows = asField(screenRows())
fieldCancelRows.insert(contentsOf: [
    (3, .other, "", "loading-overlay", R(0, 116, 402, 758)),
    (4, .activityIndicator, "In progress", "", R(181, 475, 40, 40)),
    (4, .button, "Cancel", "", R(100, 270, 200, 44)),
], at: fieldCancelRows.count - 2)
check("a hittable text field under an overlay with its Cancel over the point is covered by Cancel",
      analyzer(fieldCancelRows).analyze(coveredField, isHittable: true),
      .covered(by: "button \"Cancel\""))
var fieldControlAfterRows = asField(screenRows())
fieldControlAfterRows.insert(contentsOf: loadingOverlay + [(3, .button, "Retry", "", R(100, 270, 200, 44))],
                             at: fieldControlAfterRows.count - 2)
check("a hittable text field under an overlay and a control painted after it is covered by the control",
      analyzer(fieldControlAfterRows).analyze(coveredField, isHittable: true),
      .covered(by: "button \"Retry\""))
// A control in the overlay over the point (its Cancel button) is named.
let loadingWithCancel: [Row] = [
    (3, .other, "", "loading-overlay", R(0, 116, 402, 758)),
    (4, .activityIndicator, "In progress", "", R(181, 475, 40, 40)),
    (4, .button, "Cancel", "", R(100, 270, 200, 44)),
]
var cancelRows = screenRows()
cancelRows.insert(contentsOf: loadingWithCancel, at: cancelRows.count - 2)
check("a control inside a loading overlay over the point is named as the cover",
      analyzer(cancelRows).analyze(button("Covered action", covered), isHittable: false),
      .covered(by: "button \"Cancel\""))

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

// A button's containers decide its hold (TapTiming): an alert's, an action
// sheet's and a segmented control's buttons are UIKit controls.
let alertRows: [Row] = [
    (0, .application, "", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .button, "Behind", "", R(16, 100, 370, 56)),
    (3, .segmentedControl, "", "", R(16, 170, 370, 32)),
    (4, .button, "Large", "", R(200, 170, 186, 32)),
    (2, .alert, "Delete?", "", R(40, 250, 322, 200)),
    (3, .other, "", "", R(40, 250, 322, 200)),
    (4, .button, "Delete", "", R(40, 400, 161, 50)),
    (2, .sheet, "Share", "", R(0, 600, 402, 274)),
    (3, .button, "Copy", "", R(16, 700, 370, 56)),
]
let alerts = analyzer(alertRows)
let containerCases: [(String, OcclusionAnalyzer.Target, [XCUIElement.ElementType])] = [
    ("a button in an alert sits in the alert", button("Delete", R(40, 400, 161, 50)), [.other, .alert, .window, .application]),
    ("a button in an action sheet sits in the sheet", button("Copy", R(16, 700, 370, 56)), [.sheet, .window, .application]),
    ("a segment sits in its segmented control", button("Large", R(200, 170, 186, 32)),
     [.segmentedControl, .other, .window, .application]),
    ("a button beside them sits in plain views", button("Behind", R(16, 100, 370, 56)), [.other, .window, .application]),
    ("an unplaced target has no known containers", button("Gone", R(5, 5, 10, 10)), []),
]
for (name, target, want) in containerCases {
    let got = alerts.ancestorTypes(of: target)
    if got == want { print("ok   \(name)") } else { failures += 1; print("FAIL \(name): got \(got.map(\.rawValue))") }
}

// A dropdown's option is the first uncovered copy of its text, leaving out
// what showed it before the dropdown opened, touched where `analyze` says.
let optionRows: [Row] = [
    (0, .application, "", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .staticText, "Medium", "", R(16, 100, 370, 20)),
    (3, .other, "", "", R(16, 300, 370, 140)),
    (4, .staticText, "Medium", "", R(16, 340, 370, 20)),
    (4, .staticText, "Gone", "", R(16, 2000, 370, 20)),
    (4, .staticText, "Under", "", R(16, 380, 370, 20)),
    (4, .staticText, "Medium", "", R(16, 420, 370, 15)),
    (3, .scrollView, "", "", R(16, 450, 370, 100)),
    (4, .staticText, "Clipped", "", R(16, 560, 370, 20)),
    (4, .staticText, "Half", "", R(16, 540, 370, 20)),
    (3, .staticText, "Low", "", R(16, 590, 370, 30)),
    (3, .button, "Cover", "", R(0, 370, 402, 40)),
    (2, .sheet, "", "", R(0, 640, 402, 160)),
    (3, .staticText, "Large", "", R(16, 700, 370, 20)),
    (2, .toolbar, "", "", R(0, 600, 402, 40)),
]
let options = analyzer(optionRows)
func touch(_ result: OcclusionAnalyzer.OptionText) -> CGPoint? {
    if case .touchable(let point, _) = result { return point }
    return nil
}
let optionCases: [(String, Bool)] = [
    ("the first copy is the one picked", touch(options.optionText("Medium")) == CGPoint(x: 201, y: 110)),
    ("a text shown before the dropdown opened is left out, not a later copy",
     touch(options.optionText("Medium", excluding: [R(16, 100, 370, 20)])) == CGPoint(x: 201, y: 350)),
    ("every copy there before leaves nothing",
     options.optionText("Medium", excluding: options.textFrames("Medium")) == .absent),
    ("a copy off screen before the open is left out, so it is not taken for the option",
     options.optionText("Gone", excluding: options.textFrames("Gone")) == .absent),
    ("an option a control covers is present but not touched", options.optionText("Under") == .present),
    ("an option scrolled out of its list is present but not touched", options.optionText("Clipped") == .present),
    ("an option off screen is present but not touched", options.optionText("Gone") == .present),
    ("a missing option is absent", options.optionText("Missing") == .absent),
    ("a half-shown option is touched in its shown part", touch(options.optionText("Half")) == CGPoint(x: 201, y: 545)),
    ("an option half under a toolbar is touched clear of it", touch(options.optionText("Low")) == CGPoint(x: 201, y: 595)),
]
for (name, ok) in optionCases {
    if ok { print("ok   \(name)") } else { failures += 1; print("FAIL \(name)") }
}
if case .touchable(_, let types) = options.optionText("Large"), types.contains(.sheet) {
    print("ok   an option in a sheet sits in the sheet")
} else { failures += 1; print("FAIL an option in a sheet sits in the sheet") }

// ─── Plain bars laid over a list (PILOT-1424) ───

// A React Native screen: a list from y=100 to y=780 and a checkout bar the
// screen lays over its bottom 64 points. The bar is a plain view: XCUITest
// calls the row under it unhittable, and only the bar's shape says why.
func barScreen(row: CGRect, bar: [Row], barFirst: Bool = false, listType: XCUIElement.ElementType = .scrollView) -> OcclusionAnalyzer {
    let list: [Row] = [
        (3, listType, "", "list", R(0, 100, 402, 680)),
        (4, .other, "", "", R(0, 100, 402, 1400)),
        (5, .button, "Row", "row", row),
    ]
    let head: [Row] = [
        (0, .application, "App", "", screen),
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
    ]
    return analyzer(head + (barFirst ? bar + list : list + bar))
}
let checkoutBar: [Row] = [
    (3, .other, "", "checkout-bar", R(0, 716, 402, 64)),
    (4, .staticText, "Checkout bar", "", R(16, 737, 370, 22)),
]
func rowAt(_ y: Double) -> OcclusionAnalyzer.Target {
    .init(frame: R(16, y, 370, 48), elementType: .button, label: "Row", identifier: "row")
}
check("a row wholly under a plain bar laid over its list is covered by the bar",
      barScreen(row: R(16, 724, 370, 48), bar: checkoutBar).analyze(rowAt(724), isHittable: false),
      .covered(by: "element \"checkout-bar\"" + OcclusionAnalyzer.plainBarSuffix))
checkPoint("a row partly under the bar is touched on the part left showing",
           barScreen(row: R(16, 696, 370, 48), bar: checkoutBar).analyze(rowAt(696), isHittable: false),
           CGPoint(x: 201, y: 706))
checkPoint("a hittable row is not under the bar",
           barScreen(row: R(16, 724, 370, 48), bar: checkoutBar).analyze(rowAt(724), isHittable: true),
           CGPoint(x: 201, y: 748))
check("a bar named only by its text is named by what it holds",
      barScreen(row: R(16, 724, 370, 48), bar: [
          (3, .other, "", "", R(0, 716, 402, 64)),
          (4, .staticText, "Checkout bar", "", R(16, 737, 370, 22)),
      ]).analyze(rowAt(724), isHittable: false),
      .covered(by: "a bar holding text \"Checkout bar\"" + OcclusionAnalyzer.plainBarSuffix))
checkPoint("a nameless view over the list (a pointerEvents=none fade) is no bar",
           barScreen(row: R(16, 724, 370, 48), bar: [(3, .other, "", "", R(0, 716, 402, 64))])
               .analyze(rowAt(724), isHittable: false),
           CGPoint(x: 201, y: 748))
checkPoint("a view over most of the list is no bar",
           barScreen(row: R(16, 724, 370, 48), bar: [(3, .other, "", "toast-host", R(0, 100, 402, 680))])
               .analyze(rowAt(724), isHittable: false),
           CGPoint(x: 201, y: 748))
checkPoint("a narrow badge over the list's edge is no bar",
           barScreen(row: R(16, 724, 370, 48), bar: [(3, .other, "", "badge", R(300, 716, 102, 64))])
               .analyze(rowAt(724), isHittable: false),
           CGPoint(x: 201, y: 748))
checkPoint("a bar listed before the list is under it",
           barScreen(row: R(16, 724, 370, 48), bar: checkoutBar, barFirst: true).analyze(rowAt(724), isHittable: false),
           CGPoint(x: 201, y: 748))
checkPoint("a web view's own bars are its content",
           barScreen(row: R(16, 724, 370, 48), bar: checkoutBar, listType: .webView).analyze(rowAt(724), isHittable: false),
           CGPoint(x: 201, y: 748))
check("a mini player stacked on a tab bar covers the rows under it",
      barScreen(row: R(16, 664, 370, 48), bar: [
          (3, .other, "", "mini-player", R(0, 652, 402, 64)),
          (3, .other, "", "tab-bar", R(0, 716, 402, 64)),
      ]).analyze(rowAt(664), isHittable: false),
      .covered(by: "element \"mini-player\"" + OcclusionAnalyzer.plainBarSuffix))
// iOS lists views top to bottom: a JS header laid over the list's top comes
// before the list in the tree.
check("a header laid over the top of the list, listed before it, covers the rows under it",
      barScreen(row: R(16, 110, 370, 48), bar: [(3, .other, "", "header", R(0, 100, 402, 64))], barFirst: true)
          .analyze(rowAt(110), isHittable: false),
      .covered(by: "element \"header\"" + OcclusionAnalyzer.plainBarSuffix))
check("a header laid over the top of the list, listed after it, covers the rows under it",
      barScreen(row: R(16, 110, 370, 48), bar: [(3, .other, "", "header", R(0, 100, 402, 64))])
          .analyze(rowAt(110), isHittable: false),
      .covered(by: "element \"header\"" + OcclusionAnalyzer.plainBarSuffix))
checkPoint("a row partly under a header listed before the list is touched below it",
           barScreen(row: R(16, 140, 370, 48), bar: [(3, .other, "", "header", R(0, 100, 402, 64))], barFirst: true)
               .analyze(rowAt(140), isHittable: false),
           CGPoint(x: 201, y: 176))
check("a button in the bar over the row is named before the bar",
      barScreen(row: R(16, 724, 370, 48), bar: checkoutBar + [(4, .button, "Pay", "", R(100, 720, 200, 56))])
          .analyze(rowAt(724), isHittable: false),
      .covered(by: "button \"Pay\""))

// ─── The system status bar ───

// Edge-to-edge content under the status bar of an iPhone 17 Pro (iOS 26.5):
// SpringBoard draws the bar over the top 54 pt and takes every touch there,
// though the app's snapshot does not hold it and XCUITest calls what is under
// it hittable.
let statusBarStrip = R(0, 0, 402, 54)
let underBar = R(16, 4, 160, 37)
let partlyUnderBar = R(226, 25, 160, 93)
// No header: the screen's content starts at the top of the screen.
let edgeToEdge = analyzer([
    (0, .application, "Tapsmith Test App", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .button, "Under", "", underBar),
    (3, .button, "Partly", "", partlyUnderBar),
    (3, .staticText, "under=0 partly=0", "", R(16, 182, 370, 20)),
])
check("a button wholly under the status bar: covered by it, though XCUITest calls it hittable",
      edgeToEdge.analyze(button("Under", underBar), isHittable: true, statusBar: statusBarStrip),
      .covered(by: "the status bar"))
check("…and when it is not hittable",
      edgeToEdge.analyze(button("Under", underBar), isHittable: false, statusBar: statusBarStrip),
      .covered(by: "the status bar"))
check("a button partly under the status bar is touched on the part below it",
      edgeToEdge.analyze(button("Partly", partlyUnderBar), isHittable: true, statusBar: statusBarStrip),
      .clear(point: CGPoint(x: 306, y: 86), visible: R(226, 54, 160, 64)))
checkPoint("no status bar known (none shown, or SpringBoard unreadable): touched where it is",
           edgeToEdge.analyze(button("Under", underBar), isHittable: true, statusBar: nil),
           CGPoint(x: 96, y: 22.5))
checkPoint("the nav bar's back button below the status bar is not clipped by it",
           analyzer(screenRows()).analyze(button("Back", R(8, 70, 40, 40)), isHittable: true, statusBar: statusBarStrip),
           CGPoint(x: 28, y: 90))
// The analyzer clips by whatever region it is given — the iPhone Duo shows
// its status bar as a column at the right edge.
check("a button under a status bar column at the right edge: covered",
      analyzer(screenRows(extra: [(4, .button, "Side", "", R(360, 120, 40, 40))]))
          .analyze(button("Side", R(360, 120, 40, 40)), isHittable: true, statusBar: R(350, 0, 52, 874)),
      .covered(by: "the status bar"))

func checkBool(_ name: String, _ got: Bool, _ want: Bool) {
    if got == want { print("ok   \(name)") } else { failures += 1; print("FAIL \(name): got \(got), want \(want)") }
}
// Where the status bar can be: its place is learned from the first read that
// finds it shown, per screen size, and kept; until then, the top band.
// Whether it is shown is read afresh on every pass the gate lets through.
do {
    var gate = OcclusionAnalyzer.StatusBarGate()
    checkBool("nothing learned: a target in the top band may be under the bar",
              gate.mayCover(underBar, screen: screen), true)
    checkBool("nothing learned: a target reaching up into the top band may be",
              gate.mayCover(R(16, 60, 370, 200), screen: screen), true)
    checkBool("nothing learned: a nav bar's back button in the top band may be",
              gate.mayCover(R(8, 66, 40, 40), screen: screen), true)
    checkBool("a target well below the top band is not (most taps pay nothing)",
              gate.mayCover(covered, screen: screen), false)
    checkBool("a target off screen above is not",
              gate.mayCover(R(16, -200, 370, 50), screen: screen), false)
    gate.learn(nil, screen: screen)
    checkBool("a read that found no bar (hidden) teaches nothing: the top band still counts",
              gate.mayCover(R(8, 66, 40, 40), screen: screen), true)
    gate.learn(statusBarStrip, screen: screen)
    checkBool("learned: a header button below the bar is not under it (no read)",
              gate.mayCover(R(8, 66, 40, 40), screen: screen), false)
    checkBool("learned: a header starting right at the bar's bottom is not",
              gate.mayCover(R(0, 54, 402, 54), screen: screen), false)
    checkBool("learned: a button under the bar is",
              gate.mayCover(underBar, screen: screen), true)
    checkBool("learned: a button reaching up into the bar is",
              gate.mayCover(partlyUnderBar, screen: screen), true)
    checkBool("learned: a button inside a legacy nav bar laid at y=20 is (the bar reaches 54)",
              gate.mayCover(R(8, 22, 40, 40), screen: screen), true)
    let landscape = R(0, 0, 874, 402)
    checkBool("another screen size learns separately: the top band counts there",
              gate.mayCover(R(16, 60, 100, 30), screen: landscape), true)
    // The iPhone Duo's bar is a column at the right edge: once learned, a
    // target under it anywhere down the screen is checked.
    let duo = R(0, 0, 466, 951)
    gate.learn(R(378, 0, 88, 176.33), screen: duo)
    checkBool("Duo: a target under the column below the top band is",
              gate.mayCover(R(400, 120, 40, 40), screen: duo), true)
    checkBool("Duo: a target in the top band away from the column is not",
              gate.mayCover(R(16, 10, 100, 40), screen: duo), false)
    // A taller bar seen later (a call or recording banner) widens what is kept.
    gate.learn(R(0, 0, 402, 80), screen: screen)
    checkBool("learned regions grow, never shrink",
              gate.mayCover(R(8, 60, 40, 15), screen: screen), true)
}

print(failures == 0 ? "ALL OK" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
