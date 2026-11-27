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

// iOS 27 on the iPhone Duo (recorded on its simulator, the fixture's Toggles
// screen): the back button is a child of the floating Toolbar host, trailing,
// and the host comes first in the window, before the navigation bar (which
// holds nothing) and the content.
let duo = R(0, 0, 466, 678)
let floatingBack: [Row] = [
    (0, .application, "Native", "", duo),
    (1, .window, "", "", duo),
    (2, .toolbar, "Toolbar", "Toolbar", duo),
    (3, .button, "", "BackButton", R(399, 179, 38, 38)),
    (2, .navigationBar, "", "Toggles", R(0, 24, 466, 58)),
    (2, .other, "", "", duo),
    (3, .button, "Small", "", R(40, 299, 107, 32)),
]
check("iOS 27 floating toolbar: taps the back button in the Toolbar host",
      tapPoint(resolve(floatingBack, screen: duo)), CGPoint(x: 418, y: 198))

// The screen's own controls come after the host in the tree, so a list row
// under the floating back button is "painted after" it. It is the screen's
// content, not something presented over it.
var floatingOverRow = floatingBack
floatingOverRow.append((3, .cell, "About", "", R(0, 170, 466, 56)))
check("iOS 27 floating toolbar over a row: still taps the back button",
      tapPoint(resolve(floatingOverRow, screen: duo)), CGPoint(x: 418, y: 198))

// An app's own back button: no system identifier, labelled "Back".
let labelledBack: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .navigationBar, "", "Detail", R(0, 62, 402, 54)),
    (3, .button, "Back", "", R(8, 66, 60, 36)),
    (3, .button, "Share", "", R(340, 66, 44, 36)),
]
check("a bar button labelled Back counts", tapPoint(resolve(labelledBack)), CGPoint(x: 38, y: 84))

// React Navigation's HeaderBackButton in a custom headerLeft: the system back
// button is hidden, and the custom one is labelled "Go back", or
// "<previous title>, back" when it shows a label. Edit beside it is still not
// a back button.
for name in ["Go back", "Home, back"] {
    let custom: [Row] = [
        (0, .application, "App", "", screen),
        (1, .window, "", "", screen),
        (2, .navigationBar, "", "Detail", R(0, 62, 402, 54)),
        (3, .button, name, "", R(8, 66, 60, 36)),
        (3, .button, "Edit", "", R(330, 66, 54, 36)),
    ]
    check("React Navigation's custom back button \"\(name)\" counts", tapPoint(resolve(custom)), CGPoint(x: 38, y: 84))
}

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

// An alert over a pushed screen: the back button is there but covered. The
// alert's frame is its box, nowhere near the back button: a touch there lands
// on its dimming view.
var underAlert = pushedScreen(withHost: false)
underAlert += [
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .alert, "Delete file?", "", R(40, 330, 322, 200)),
    (4, .button, "Delete", "", R(60, 480, 140, 44)),
]
switch resolve(underAlert) {
case .covered(let by):
    check("a back button under an alert is covered", by.contains("Delete file?"), true)
default:
    failures += 1
    print("FAIL a back button under an alert: got \(resolve(underAlert)), want covered")
}

// An action sheet (`.sheet`) at the bottom of the screen covers it too.
var underActionSheet = pushedScreen(withHost: false)
underActionSheet += [
    (1, .window, "", "", screen),
    (2, .sheet, "Share photo", "", R(8, 600, 386, 240)),
    (3, .button, "Copy Link", "", R(8, 660, 386, 56)),
]
if case .covered = resolve(underActionSheet) {
    print("ok   a back button under an action sheet is covered")
} else {
    failures += 1
    print("FAIL a back button under an action sheet: got \(resolve(underActionSheet)), want covered")
}

// A control in a later window over the back button (a presented
// controller's own window) covers it; one elsewhere in that window does not.
var underWindowControl = pushedScreen(withHost: false)
underWindowControl += [
    (1, .window, "", "", screen),
    (2, .button, "Debug", "", R(0, 50, 120, 70)),
]
if case .covered(let by) = resolve(underWindowControl) {
    check("a control in a later window over the back button covers it", by.contains("Debug"), true)
} else {
    failures += 1
    print("FAIL a later window's control over the back button: got \(resolve(underWindowControl)), want covered")
}
var besideWindowControl = pushedScreen(withHost: false)
besideWindowControl += [
    (1, .window, "", "", screen),
    (2, .button, "Debug", "", R(300, 760, 80, 80)),
]
check("a control in a later window away from the back button does not cover it",
      tapPoint(resolve(besideWindowControl)), CGPoint(x: 38, y: 84))

// An in-app browser: the stack's system back button in the navigation bar,
// and the web view's own "Back" in a bottom toolbar, painted after it.
let browser: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .navigationBar, "", "Help", R(0, 62, 402, 54)),
    (3, .button, "Settings", "BackButton", R(16, 62, 44, 44)),
    (2, .webView, "", "", R(0, 116, 402, 672)),
    (2, .toolbar, "Toolbar", "Toolbar", R(0, 788, 402, 86)),
    (3, .button, "Back", "", R(20, 800, 44, 44)),
    (3, .button, "Forward", "", R(80, 800, 44, 44)),
]
check("the system back button wins over a toolbar button labelled Back",
      tapPoint(resolve(browser)), CGPoint(x: 38, y: 84))

// Two stacks (a full-screen cover's stack painted over the screen's): the
// one painted last.
var twoStacks = pushedScreen(withHost: false)
twoStacks += [
    (1, .window, "", "", screen),
    (2, .navigationBar, "", "UIKit Detail", R(0, 62, 402, 54)),
    (3, .button, "UIKit Root", "BackButton", R(16, 62, 80, 44)),
]
check("two stacks: the back button painted last", tapPoint(resolve(twoStacks)), CGPoint(x: 56, y: 84))

// A pop on iOS 27.2 (recorded on an iPhone 17 Pro simulator, the test app's
// Dialogs screen popped to its first screen): for a few hundred ms after the
// pop's animation the popped screen's back button is still in the tree, in
// the first screen's navigation bar, though no longer drawn. It has lost the
// button trait and kept the private back-button one (PILOT-1261).
let onScreenBackTraits: UInt64 = 0x2_0800_0001
let leavingBackTraits: UInt64 = 0x2_0800_0000

/// `rows` as nodes, with `traits` set on the nodes at the given indices.
func resolve(_ rows: [Row], traits: [Int: UInt64]) -> BackButton.Resolution {
    var nodes = tree(rows)
    for (i, value) in traits { nodes[i].traits = value }
    return BackButton.resolve(in: OcclusionAnalyzer(nodes: nodes, screen: screen))
}

let rootAfterPop: [Row] = [
    (0, .application, "Tapsmith Test App", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .navigationBar, "", "Tapsmith Test App", R(0, 62, 402, 54)),
    (4, .button, "Back", "BackButton", R(15.5, 61.5, 91, 45)),
    (4, .staticText, "Tapsmith Test App", "", R(127, 73, 148, 22)),
    (3, .other, "", "", screen),
    (4, .staticText, "Test Screens", "", R(16, 132, 370, 29)),
    toolbarHost(depth: 3),
]
check("iOS 27, the first screen just after a pop: the popped screen's back button is no back button",
      resolve(rootAfterPop, traits: [4: leavingBackTraits]), .none)
check("the same button with the button trait is tapped",
      tapPoint(resolve(rootAfterPop, traits: [4: onScreenBackTraits])), CGPoint(x: 61, y: 84))
check("a system back button whose traits can't be read is tapped",
      tapPoint(resolve(rootAfterPop, traits: [4: 0])), CGPoint(x: 61, y: 84))

// Popping to a screen that has its own back button: the popped screen's is
// painted after it, and the screen's own is the one tapped.
let pushedAfterPop: [Row] = [
    (0, .application, "App", "", screen),
    (1, .window, "", "", screen),
    (2, .navigationBar, "", "Level 1", R(0, 62, 402, 54)),
    (3, .button, "Back", "BackButton", R(16, 62, 90, 44)),
    (3, .button, "Back", "BackButton", R(15.5, 61.5, 91, 45)),
    toolbarHost(depth: 2),
]
check("after a pop to a pushed screen: that screen's own back button, not the popped one's",
      tapPoint(resolve(pushedAfterPop, traits: [3: onScreenBackTraits, 4: leavingBackTraits])),
      CGPoint(x: 61, y: 84))

// The iPhone Duo's floating back button, in the Toolbar host, never has the
// button trait (recorded on its 27.2 simulator): it is on screen all the same.
var duoNodes = tree(floatingBack)
duoNodes[3].traits = leavingBackTraits
check("iOS 27 floating toolbar: a back button without the button trait is still tapped",
      tapPoint(BackButton.resolve(in: OcclusionAnalyzer(nodes: duoNodes, screen: duo))), CGPoint(x: 418, y: 198))

// iOS 18.5 (recorded on an iPhone 15 Pro simulator, Xcode 27.2): once a push
// settles, the system back button has no `BackButton` identifier, in React
// Navigation's native stack, a SwiftUI NavigationStack and a UIKit
// UINavigationController alike. It keeps the private back-button trait
// (bit 27) in every sample from 0.05 to 3 s after the push; a root screen's
// leading Edit (SwiftUI) or Close (UIKit `leftBarButtonItem`) has the button
// trait only (PILOT-1532).
let iPhone15Pro = R(0, 0, 393, 852)
let backTraits18: UInt64 = 0x2_0800_0001
let plainButtonTraits18: UInt64 = 0x2_0000_0001

/// `rows` on the iPhone 15 Pro, with `traits` set on the nodes at the given
/// indices.
func resolve18(_ rows: [Row], traits: [Int: UInt64]) -> BackButton.Resolution {
    var nodes = tree(rows)
    for (i, value) in traits { nodes[i].traits = value }
    return BackButton.resolve(in: OcclusionAnalyzer(nodes: nodes, screen: iPhone15Pro))
}

// expo-router's native stack, a todo pushed from the list (the trace's
// action-008 hierarchy): the back button is labelled with the list's title.
let rnPushed18: [Row] = [
    (0, .application, "LQG Shop", "", iPhone15Pro),
    (1, .window, "", "", iPhone15Pro),
    (2, .other, "", "", iPhone15Pro),
    (3, .navigationBar, "", "Todo", R(0, 53, 393, 44)),
    (4, .button, "Todos", "", R(0, 53, 77, 44)),
    (4, .staticText, "Todo", "", R(177, 65, 39, 20)),
    (3, .other, "", "", R(0, 97, 393, 755)),
    (4, .staticText, "Todo #3", "detail-id", R(24, 121, 345, 27)),
]
check("iOS 18 React Navigation pushed screen: taps the back button found by its trait",
      tapPoint(resolve18(rnPushed18, traits: [4: backTraits18])), CGPoint(x: 38.5, y: 75))
check("iOS 18 React Navigation pushed screen: a back button whose traits can't be read is no back button",
      resolve18(rnPushed18, traits: [:]), .none)
check("iOS 18: a bar button with the button trait only is no back button",
      resolve18(rnPushed18, traits: [4: plainButtonTraits18]), .none)

// A SwiftUI NavigationStack in a TabView (persona D's dump): a large title,
// the tab bar after the stack.
let swiftUIPushed18: [Row] = [
    (0, .application, "BrewLog", "", iPhone15Pro),
    (1, .window, "", "", iPhone15Pro),
    (2, .other, "", "", iPhone15Pro),
    (3, .navigationBar, "", "Guinness", R(0, 53, 393, 96)),
    (4, .button, "Beers", "", R(0, 53, 74, 44)),
    (4, .staticText, "Guinness", "", R(16, 101, 148, 40)),
    (3, .other, "", "", iPhone15Pro),
    (2, .tabBar, "Tab Bar", "", R(0, 769, 393, 83)),
    (3, .button, "Beers", "list.bullet", R(2, 770, 127, 48)),
]
check("iOS 18 SwiftUI NavigationStack pushed screen: taps the back button found by its trait",
      tapPoint(resolve18(swiftUIPushed18, traits: [4: backTraits18, 8: plainButtonTraits18])), CGPoint(x: 37, y: 75))

// A UIKit UINavigationController's pushed screen.
let uiKitPushed18: [Row] = [
    (0, .application, "BrewLog", "", iPhone15Pro),
    (1, .window, "", "", iPhone15Pro),
    (2, .navigationBar, "", "KitDetail1", R(0, 59, 393, 44)),
    (3, .button, "KitRoot", "", R(0, 59, 86, 44)),
    (3, .staticText, "KitDetail1", "", R(158, 70, 75, 20)),
]
check("iOS 18 UIKit UINavigationController pushed screen: taps the back button found by its trait",
      tapPoint(resolve18(uiKitPushed18, traits: [3: backTraits18])), CGPoint(x: 43, y: 81))

// The roots: SwiftUI's leading Edit (a button holding a button, the inner one
// with the button trait) and trailing Add; UIKit's leading Close. Neither is a
// back button, though each sits where one would.
let swiftUIRoot18: [Row] = [
    (0, .application, "BrewLog", "", iPhone15Pro),
    (1, .window, "", "", iPhone15Pro),
    (2, .navigationBar, "", "Beers", R(0, 53, 393, 96)),
    (3, .button, "Edit", "", R(16, 61, 37, 28)),
    (4, .button, "", "", R(16, 61, 37, 28)),
    (5, .button, "Edit", "", R(16, 61, 37, 28)),
    (3, .button, "Add", "addBeerButton", R(338, 61, 38, 28)),
    (3, .staticText, "Beers", "", R(16, 101, 91, 40)),
]
check("iOS 18 SwiftUI root with a leading Edit: no back button",
      resolve18(swiftUIRoot18, traits: [3: 0x2_0000_0000, 4: 0x2_0000_0000, 5: plainButtonTraits18, 6: 0x2_0000_0000]),
      .none)
let uiKitRoot18: [Row] = [
    (0, .application, "BrewLog", "", iPhone15Pro),
    (1, .window, "", "", iPhone15Pro),
    (2, .navigationBar, "", "KitRoot", R(0, 59, 393, 44)),
    (3, .button, "Close", "", R(8, 59, 54, 44)),
    (3, .staticText, "KitRoot", "", R(167, 70, 59, 20)),
]
check("iOS 18 UIKit root with a leading Close: no back button",
      resolve18(uiKitRoot18, traits: [3: plainButtonTraits18]), .none)

// The back-button trait on something that is no button, or on a button
// outside any bar, is no back button.
var traitOnText = rnPushed18
traitOnText[4] = (4, .staticText, "Todos", "", R(0, 53, 77, 44))
check("iOS 18: the back-button trait on a static text is no back button",
      resolve18(traitOnText, traits: [4: backTraits18]), .none)
var traitInContent = rnPushed18
traitInContent.remove(at: 4)
traitInContent.append((4, .button, "Todos", "", R(0, 200, 77, 44)))
check("iOS 18: a button with the back-button trait outside a bar is no back button",
      resolve18(traitInContent, traits: [traitInContent.count - 1: backTraits18]), .none)

// A popped back button found by its trait alone, left in the bar of the
// screen popped to without the button trait (the shape iOS 27 leaves,
// PILOT-1261): still no back button.
check("a trait-only back button that has lost the button trait is no back button",
      resolve18(rnPushed18, traits: [4: leavingBackTraits]), .none)

// Mid-push with both screens' back buttons found by their trait: the one on
// screen.
let midPush18: [Row] = [
    (0, .application, "App", "", iPhone15Pro),
    (1, .window, "", "", iPhone15Pro),
    (2, .navigationBar, "", "Level 2", R(0, 53, 393, 44)),
    (3, .button, "Level 0", "", R(-200, 53, 77, 44)),
    (3, .button, "Level 1", "", R(0, 53, 77, 44)),
]
check("iOS 18 mid-push: the on-screen trait-only back button",
      tapPoint(resolve18(midPush18, traits: [3: backTraits18, 4: backTraits18])), CGPoint(x: 38.5, y: 75))

// The shared rule.
check("isSystemBackButton: the BackButton identifier",
      AccessibilityTrait.isSystemBackButton(elementType: .button, identifier: "BackButton", traits: nil), true)
check("isSystemBackButton: the back-button trait",
      AccessibilityTrait.isSystemBackButton(elementType: .button, identifier: "", traits: backTraits18), true)
check("isSystemBackButton: neither",
      AccessibilityTrait.isSystemBackButton(elementType: .button, identifier: "", traits: plainButtonTraits18), false)
check("isSystemBackButton: unread traits",
      AccessibilityTrait.isSystemBackButton(elementType: .button, identifier: "", traits: nil), false)
check("isSystemBackButton: not a button",
      AccessibilityTrait.isSystemBackButton(elementType: .other, identifier: "", traits: backTraits18), false)

// Reading again before refusing: for a second, and never past the
// daemon's deadline.
let t0 = Date(timeIntervalSinceReferenceDate: 0)
check("reads again just after the first read",
      BackButton.shouldReadAgain(started: t0, now: t0.addingTimeInterval(0.2), deadline: nil), true)
check("stops after a second",
      BackButton.shouldReadAgain(started: t0, now: t0.addingTimeInterval(0.95), deadline: nil), false)
check("stops before the daemon's deadline",
      BackButton.shouldReadAgain(started: t0, now: t0.addingTimeInterval(0.2), deadline: t0.addingTimeInterval(0.4)), false)

if failures > 0 {
    print("\(failures) BackButton test(s) failed")
    exit(1)
}
print("All BackButton tests passed")
