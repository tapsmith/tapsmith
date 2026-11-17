// Unit tests for BackButton (PILOT-1225), run on the host Mac without a
// simulator: `ios-agent/Tests/run-unit-tests.sh`. The trees are shaped like
// ones recorded from the native fixture app (native-ios-test-app) on iPhone 17
// Pro simulators running iOS 26.5 and 27.2, and, for the floating toolbar
// host, from agent-device's report of the iOS 27 iPhone Duo.

import XCTest

typealias Node = OcclusionAnalyzer.Node
typealias Row = (depth: Int, type: XCUIElement.ElementType, label: String, id: String, frame: CGRect)

var failures = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want \(want)")
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

func resolve(_ rows: [Row], screen: CGRect = screen) -> BackButton.Resolution {
    BackButton.resolve(in: OcclusionAnalyzer(nodes: tree(rows), screen: screen))
}

func tapPoint(_ resolution: BackButton.Resolution) -> CGPoint? {
    if case .tap(let point, _) = resolution { return point }
    return nil
}

/// The iOS 27 Toolbar host: the last child of the window's navigation
/// container, as big as the window, after content as big (PILOT-1207).
func toolbarHost(depth: Int, frame: CGRect = screen) -> Row { (depth, .toolbar, "Toolbar", "Toolbar", frame) }

/// A pushed screen with the system back button in its navigation bar, as on
/// iOS 26.5 (no host) and 27.2 (with one).
func pushedScreen(withHost: Bool) -> [Row] {
    var rows: [Row] = [
        (0, .application, "Native", "", screen),
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
        (3, .navigationBar, "", "Toggles", R(0, 62, 402, 106)),
        (4, .button, "Native Screens", "BackButton", R(16, 62, 44, 44)),
        (4, .staticText, "Toggles", "", R(16, 119, 120, 41)),
        (3, .other, "", "", screen),
        (4, .switch, "Dark Mode", "", R(16, 200, 370, 52)),
    ]
    if withHost { rows.append(toolbarHost(depth: 3)) }
    return rows
}

check("pushed screen, iOS 26: taps the back button's center",
      tapPoint(resolve(pushedScreen(withHost: false))), CGPoint(x: 38, y: 84))
check("pushed screen, iOS 27 with the empty Toolbar host: taps the back button's center",
      tapPoint(resolve(pushedScreen(withHost: true))), CGPoint(x: 38, y: 84))

if case .tap(_, let ancestors) = resolve(pushedScreen(withHost: false)) {
    check("the tap's ancestor types start at the navigation bar", ancestors.first, .navigationBar)
} else {
    failures += 1
    print("FAIL pushed screen: no tap to read ancestor types from")
}

// A stack's root: Edit leading, Close trailing, no back button. The first
// bar button (Edit) is what `navigationBars.buttons.firstMatch` used to tap.
let rootWithEdit: [Row] = [
    (0, .application, "Native", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .navigationBar, "", "UIKit Root", R(0, 62, 402, 54)),
    (4, .button, "Edit", "", R(20, 66, 54, 36)),
    (4, .button, "Close", "", R(313, 66, 68, 36)),
    (3, .button, "Open UIKit Detail", "", R(24, 180, 354, 30)),
    toolbarHost(depth: 3),
]
check("root screen with Edit and Close: no back button", resolve(rootWithEdit), .none)

// After Edit is tapped, SwiftUI's EditButton becomes "Done" with the
// identifier "checkmark": still not a back button.
var rootEditing = rootWithEdit
rootEditing[4] = (4, .button, "Done", "checkmark", R(20, 66, 36, 36))
check("root screen in edit mode: no back button", resolve(rootEditing), .none)

// A sheet's own stack: a Done button in its bar; the presenting screen is
// not in the tree.
let sheet: [Row] = [
    (0, .application, "Native", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", R(0, 62, 402, 812)),
    (3, .navigationBar, "", "Sheet", R(0, 78, 402, 106)),
    (4, .button, "Done", "", R(316, 82, 66, 36)),
    (4, .staticText, "Sheet", "", R(16, 135, 93, 41)),
    (3, .staticText, "Sheet content", "", R(147, 501, 107, 21)),
    toolbarHost(depth: 3, frame: R(0, 62, 402, 812)),
]
check("sheet with only Done: no back button", resolve(sheet), .none)

// iOS 27 on the iPhone Duo: the back button is a child of the floating
// Toolbar host, trailing, and the navigation bar holds only the title.
let duo = R(0, 0, 466, 678)
let floatingBack: [Row] = [
    (0, .application, "Settings", "", duo),
    (1, .window, "", "", duo),
    (2, .other, "", "", duo),
    (3, .navigationBar, "", "General", R(0, 150, 466, 60)),
    (4, .staticText, "General", "", R(190, 160, 86, 40)),
    (3, .other, "", "", duo),
    (4, .cell, "About", "", R(16, 240, 434, 52)),
    (3, .toolbar, "Toolbar", "Toolbar", duo),
    (4, .button, "", "BackButton", R(399, 175, 38, 38)),
]
check("iOS 27 floating toolbar: taps the back button in the Toolbar host",
      tapPoint(resolve(floatingBack, screen: duo)), CGPoint(x: 418, y: 194))

// An app's own back button: no system identifier, labelled "Back".
let labelledBack: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .navigationBar, "", "Detail", R(0, 62, 402, 54)),
    (3, .button, "Back", "", R(8, 66, 60, 36)),
    (3, .button, "Share", "", R(340, 66, 44, 36)),
]
check("a bar button labelled Back counts", tapPoint(resolve(labelledBack)), CGPoint(x: 38, y: 84))

// Not in a bar: a "Back" button in the content, a BackButton in a tab bar.
let notInBar: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .navigationBar, "", "Home", R(0, 62, 402, 54)),
    (3, .button, "Edit", "", R(20, 66, 54, 36)),
    (2, .button, "Back", "", R(16, 300, 100, 44)),
    (2, .tabBar, "Tab Bar", "", R(0, 791, 402, 83)),
    (3, .button, "Back", "BackButton", R(0, 791, 100, 49)),
]
check("Back outside a navigation bar or toolbar: no back button", resolve(notInBar), .none)

// Mid-push: the outgoing screen's back button has slid off screen; the
// incoming one is on screen.
let midPush: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .navigationBar, "", "Level 2", R(0, 62, 402, 54)),
    (3, .button, "Level 0", "BackButton", R(-200, 62, 44, 44)),
    (3, .button, "Level 1", "BackButton", R(16, 62, 44, 44)),
]
check("mid-push: the on-screen back button", tapPoint(resolve(midPush)), CGPoint(x: 38, y: 84))

// Only off-screen: nothing to tap.
let offScreen: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .navigationBar, "", "Level 2", R(0, 62, 402, 54)),
    (3, .button, "Level 0", "BackButton", R(-200, 62, 44, 44)),
]
check("an off-screen back button is no back button", resolve(offScreen), .none)

// An alert over a pushed screen: the back button is there but covered.
var underAlert = pushedScreen(withHost: false)
underAlert += [
    (1, .window, "", "", screen),
    (2, .alert, "Delete file?", "", R(0, 0, 402, 874)),
    (3, .button, "Delete", "", R(60, 480, 140, 44)),
]
switch resolve(underAlert) {
case .covered(let by):
    check("a back button under an alert is covered", by.contains("Delete file?"), true)
default:
    failures += 1
    print("FAIL a back button under an alert: got \(resolve(underAlert)), want covered")
}

// Two stacks (a full-screen cover's stack painted over the screen's): the
// one painted last.
var twoStacks = pushedScreen(withHost: false)
twoStacks += [
    (1, .window, "", "", screen),
    (2, .navigationBar, "", "UIKit Detail", R(0, 62, 402, 54)),
    (3, .button, "UIKit Root", "BackButton", R(16, 62, 80, 44)),
]
check("two stacks: the back button painted last", tapPoint(resolve(twoStacks)), CGPoint(x: 56, y: 84))

if failures > 0 {
    print("\(failures) BackButton test(s) failed")
    exit(1)
}
print("All BackButton tests passed")
