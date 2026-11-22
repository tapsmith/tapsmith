// Unit tests for KeyboardDismissPlanner (PILOT-363), run on the host Mac
// without a simulator: `ios-agent/Tests/run-unit-tests.sh`. The trees are
// shaped like ones recorded from an iPhone 17 / iOS 26.1 simulator on the test
// app's /occlusion screen (a text field and buttons in a plain view, no scroll
// view) with the keyboard up.

import XCTest

typealias Node = OcclusionAnalyzer.Node
typealias Row = (depth: Int, type: XCUIElement.ElementType, label: String, id: String, frame: CGRect)
typealias Planner = KeyboardDismissPlanner

var failures = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want \(want)")
    }
}

func checkTrue(_ name: String, _ condition: Bool, _ detail: @autoclosure () -> String = "") {
    if condition {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name) \(detail())")
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

func planner(_ rows: [Row]) -> Planner {
    Planner(analyzer: OcclusionAnalyzer(nodes: tree(rows), screen: screen))
}

/// The iPhone keyboard windows as recorded on iOS 26 (default return key).
/// The keyboard covers 529–874.
func keyboardWindows(returnLabel: String = "return", returnId: String = "Return", extraKeys: [Row] = []) -> [Row] {
    [
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
        (6, .button, "shift", "shift", R(6, 692, 51, 56)),
        (6, .button, returnLabel, returnId, R(299, 748, 98, 56)),
        (4, .button, "Emoji", "", R(8, 805, 68, 69)),
        (4, .button, "Dictate", "dictation", R(325, 805, 68, 69)),
    ] + extraKeys
}

/// The app's window chrome: the navigation bar and RN's full-screen wrappers.
let appHead: [Row] = [
    (0, .application, "Tapsmith Test App", "", screen),
    (1, .window, "", "", screen),
    (2, .other, "", "", screen),
    (3, .navigationBar, "", "Occlusion", R(0, 62, 402, 54)),
    (4, .button, "Back", "BackButton", R(16, 62, 90, 44)),
    (3, .other, "", "", R(0, 116, 402, 758)),
]

/// The /occlusion top field's frame, as the live focus query reports it.
let occlusionInput = R(17, 133, 368, 43)

/// A focused field in the screen's content: `withField` puts it first under
/// `appHead`'s content container, above the keyboard.
let contentFieldFrame = R(16, 480, 200, 30)
/// `rows` with the focused field (at `field`) as the first child of the
/// first scroll view, table, collection or web view in them.
func withFieldInScroller(_ rows: [Row], field: CGRect = contentFieldFrame) -> [Row] {
    var rows = rows
    let scrollers: [XCUIElement.ElementType] = [.scrollView, .table, .collectionView, .webView]
    guard let i = rows.firstIndex(where: { scrollers.contains($0.type) }) else { return rows }
    rows.insert((rows[i].depth + 1, .textField, "Field", "", field), at: i + 1)
    return rows
}

func withField(_ rows: [Row]) -> [Row] {
    var rows = rows
    rows.insert((4, .textField, "Field", "", contentFieldFrame), at: appHead.count)
    return rows
}

/// /occlusion with the keyboard up: no scroll view.
let occlusionContent: [Row] = [
    (4, .other, "", "", R(16, 132, 370, 45)),
    (5, .textField, "Occlusion input", "occlusion-input", R(17, 133, 368, 43)),
    (4, .staticText, "bottom=0 covered=0", "occlusion-counts", R(16, 189, 370, 34)),
    (4, .button, "Make bottom action tall", "", R(16, 235, 45, 33)),
    (4, .button, "Show overlay", "", R(73, 235, 110, 33)),
    (4, .button, "Covered action", "", R(16, 325, 370, 56)),
    (4, .button, "Pass-through action", "", R(16, 393, 370, 56)),
    (4, .other, "", "pass-through-overlay", R(16, 393, 370, 56)),
    (4, .staticText, "Read the terms before continuing.", "", R(16, 461, 370, 19)),
    (5, .link, "terms", "", R(84, 461, 42, 19)),
    (4, .other, "", "", R(16, 732, 370, 46)),
    (5, .textField, "Bottom input", "bottom-input", R(17, 733, 368, 44)),
    (4, .button, "Bottom action", "", R(16, 794, 370, 56)),
    (2, .other, "", "", R(120, 862, 277, 10)),
    (3, .staticText, "tapsmith-hooks:1;epoch=0", "tapsmith-hooks", R(120, 862, 277, 10)),
]

let occlusion = appHead + occlusionContent + keyboardWindows()

/// A login-like screen: a scroll view with fields and a button at its centre.
let scrollScreen: [Row] = appHead + [
    (4, .scrollView, "", "", R(0, 116, 402, 758)),
    (5, .other, "", "", R(0, 116, 402, 600)),
    (6, .staticText, "Sign In", "", R(16, 132, 370, 34)),
    (6, .textField, "Email", "email-input", R(16, 180, 370, 44)),
    (6, .secureTextField, "Password", "password-input", R(16, 240, 370, 44)),
    (6, .button, "Sign in", "", R(16, 300, 370, 200)),
] + keyboardWindows()

func notInside(_ p: CGPoint, _ rects: [CGRect]) -> Bool {
    !rects.contains { $0.insetBy(dx: -Planner.touchClearance + 0.01, dy: -Planner.touchClearance + 0.01).contains(p) }
}

// MARK: - No keyboard

let noKeyboard = planner(appHead + occlusionContent)
check("no keyboard: no scroll drag", noKeyboard.scrollSwipeStart(focusedFrame: nil), nil)
check("no keyboard: no dismiss key", noKeyboard.dismissKey(), nil)
check("no keyboard: no blank spot", noKeyboard.blankPoint(focusedFrame: occlusionInput), nil)

// MARK: - 1. Scroll view drag

// PILOT-363: the old drag started at the screen centre (201, 437) whatever
// was there — on /occlusion that is "Pass-through action", which the drag
// pressed. Without a scroll view there is no drag at all.
check("no scroll view: no drag", planner(occlusion).scrollSwipeStart(focusedFrame: occlusionInput), nil)

do {
    let p = planner(scrollScreen).scrollSwipeStart(focusedFrame: R(16, 180, 370, 44))
    checkTrue("scroll view: drag offered", p != nil)
    if let p {
        let dragY = screen.height * Planner.swipeFraction
        checkTrue("scroll view: start above the keyboard", p.y < 529, "\(p)")
        checkTrue("scroll view: drag ends inside the scroll view", p.y - dragY >= 116, "\(p)")
        checkTrue("scroll view: start off the controls", notInside(p, [
            R(16, 180, 370, 44), R(16, 240, 370, 44), R(16, 300, 370, 200),
        ]), "\(p)")
    }
}

do {
    // A scroll view whose visible content is all controls: no drag. A drag
    // that does not start a scroll (sideways in a vertical list) presses the
    // control it starts on.
    let full: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 116, 402, 758)),
        (5, .button, "Big", "", R(0, 116, 402, 758)),
    ] + keyboardWindows()
    check("scroll view full of controls: no drag", planner(withFieldInScroller(full)).scrollSwipeStart(focusedFrame: contentFieldFrame), nil)
    // A web view is not dragged: WKWebView does not dismiss on drag, and the
    // page sees the gesture.
    let web: [Row] = appHead + [(4, .webView, "", "", R(0, 116, 402, 758))] + keyboardWindows()
    check("web view: no drag", planner(withFieldInScroller(web)).scrollSwipeStart(focusedFrame: contentFieldFrame), nil)
    for type in [XCUIElement.ElementType.table, .collectionView] {
        let list: [Row] = appHead + [(4, type, "", "", R(0, 116, 402, 758))] + keyboardWindows()
        checkTrue("\(type.rawValue) is dragged", planner(withFieldInScroller(list)).scrollSwipeStart(focusedFrame: contentFieldFrame) != nil)
    }
}

do {
    // Role-less Pressables (labeled .other), text and a web view inside the
    // scroll content block the start as much as buttons do.
    let rows: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 116, 402, 758)),
        (5, .other, "Row one", "", R(0, 116, 402, 200)),
        (5, .staticText, "Heading", "", R(0, 316, 402, 100)),
        (5, .webView, "", "", R(0, 416, 402, 458)),
    ] + keyboardWindows()
    check("scroll content of role-less rows, text and a web view: no drag",
          planner(withFieldInScroller(rows)).scrollSwipeStart(focusedFrame: contentFieldFrame), nil)
}

do {
    // A sheet with a field over a screen whose scroll view is still in the
    // tree, behind an unlabeled backdrop: the screen behind is not dragged.
    let field = R(16, 316, 370, 44)
    let rows: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 116, 402, 758)),
        (2, .other, "", "", screen),
        (3, .other, "", "", screen),
        (3, .other, "", "", R(0, 300, 402, 574)),
        (4, .textField, "Comment", "", field),
    ] + keyboardWindows()
    check("scroll view behind a sheet: no drag", planner(rows).scrollSwipeStart(focusedFrame: field), nil)
    // A scroll view in the sheet that holds the field is.
    let inSheet: [Row] = appHead + [
        (2, .other, "", "", screen),
        (3, .other, "", "", screen),
        (3, .other, "", "", R(0, 300, 402, 574)),
        (4, .scrollView, "", "", R(0, 300, 402, 574)),
        (5, .textField, "Comment", "", field),
    ] + keyboardWindows()
    checkTrue("scroll view holding the field in its sheet: drag", planner(inSheet).scrollSwipeStart(focusedFrame: field) != nil)
    // One beside the field in the sheet is not (known limitation: only the
    // scroll view the field is in is dragged).
    let besideInSheet: [Row] = appHead + [
        (2, .other, "", "", screen),
        (3, .other, "", "", screen),
        (3, .other, "", "", R(0, 300, 402, 574)),
        (4, .textField, "Comment", "", field),
        (4, .scrollView, "", "", R(0, 370, 402, 504)),
    ] + keyboardWindows()
    check("scroll view beside the field in its sheet: no drag", planner(besideInSheet).scrollSwipeStart(focusedFrame: field), nil)
}

do {
    // A search row above a list: the list beside the field is not dragged
    // (known limitation: only the scroll view the field is in is).
    let field = R(16, 62, 300, 44)
    let rows: [Row] = [
        (0, .application, "App", "", screen),
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
        (3, .other, "", "", R(0, 62, 402, 44)),
        (4, .searchField, "Search", "", field),
        (4, .button, "Cancel", "", R(320, 62, 82, 44)),
        (3, .table, "", "", R(0, 110, 402, 764)),
    ] + keyboardWindows()
    check("list beside the field: no drag", planner(rows).scrollSwipeStart(focusedFrame: field), nil)
}

do {
    // A headerless screen that is one full-screen scroll view holding the
    // field: that scroll view is the field's screen root, and is dragged.
    let field = R(16, 80, 370, 44)
    let rows: [Row] = [
        (0, .application, "App", "", screen),
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
        (3, .scrollView, "", "", screen),
        (4, .other, "", "", R(0, 0, 402, 600)),
        (5, .textField, "Email", "", field),
    ] + keyboardWindows()
    checkTrue("full-screen scroll view holding the field: drag",
              planner(rows).scrollSwipeStart(focusedFrame: field) != nil)
    // A field in a scroll view (not full screen) gets a blank spot beside it:
    // the scroll view around it is not in the way.
    let inScroll: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 116, 402, 758)),
        (5, .other, "", "", R(0, 116, 402, 600)),
        (6, .textField, "Email", "", R(16, 132, 370, 44)),
    ] + keyboardWindows()
    checkTrue("field inside a scroll view: blank spot beside it",
              planner(inScroll).blankPoint(focusedFrame: R(16, 132, 370, 44)) != nil)
}

do {
    // A page sheet (it starts below the status bar, so it covers about 93%
    // of the screen) over a list screen that is still in the tree: the
    // sheet roots the field's screen, and the list behind it is not dragged.
    let field = R(16, 120, 370, 44)
    let rows: [Row] = [
        (0, .application, "App", "", screen),
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
        (3, .other, "", "", screen),
        (4, .table, "", "", R(0, 116, 402, 758)),
        (3, .other, "", "", R(0, 62, 402, 812)),
        (4, .textField, "Title", "", field),
    ] + keyboardWindows()
    check("page sheet over a list: the list behind is not dragged",
          planner(rows).scrollSwipeStart(focusedFrame: field), nil)
}

do {
    // A ScrollView (87% of the screen, under a navigation bar) whose content
    // container is the same size: the field's screen root is that container,
    // inside the scroll view, and the scroll view holding the field is still
    // dragged (the /keyboard "Put in scroll view" layout).
    let field = R(17, 133, 368, 43)
    let rows: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 116, 402, 758)),
        (5, .other, "", "", R(0, 116, 402, 758)),
        (6, .textField, "Plain input", "", field),
        (6, .button, "Centre action", "", R(16, 415, 370, 443)),
    ] + keyboardWindows()
    checkTrue("scroll view holding the field, same-sized content: drag",
              planner(rows).scrollSwipeStart(focusedFrame: field) != nil)
}

do {
    // No focused field known: no drag (a scroll view behind a sheet's
    // backdrop cannot be told from the field's own).
    let rows: [Row] = appHead + [(4, .scrollView, "", "", R(0, 116, 402, 758))] + keyboardWindows()
    check("no focused field known: no drag", planner(rows).scrollSwipeStart(focusedFrame: nil), nil)
    // A horizontal carousel inside a tappable card: a vertical drag that does
    // not scroll it would press the card.
    let cardField = R(16, 200, 200, 30)
    let card: [Row] = withFieldInScroller(appHead + [
        (4, .other, "Open card", "", R(0, 116, 402, 300)),
        (5, .scrollView, "", "", R(0, 116, 402, 300)),
    ] + keyboardWindows(), field: cardField)
    check("scroll view inside a labeled card: no drag", planner(card).scrollSwipeStart(focusedFrame: cardField), nil)
}

do {
    // A field in a table cell whose row selection does something: the cell
    // is not a blank spot, though it wraps the field.
    let field = R(100, 200, 280, 44)
    let rows: [Row] = appHead + [
        (4, .table, "", "", R(0, 116, 402, 758)),
        (5, .cell, "Name", "", R(0, 116, 402, 400)),
        (6, .textField, "Name", "", field),
    ] + keyboardWindows()
    let p = planner(rows).blankPoint(focusedFrame: field)
    checkTrue("field in a cell: blank spot not on the cell",
              p.map { !R(0, 116, 402, 400).contains($0) } ?? true, "\(String(describing: p))")
    // A composer in the keyboard's window (input accessory view) is in no
    // app scroll view: no drag (known limitation).
    let composer = R(8, 480, 300, 40)
    var kb = keyboardWindows()
    kb.insert((3, .textField, "Message", "", composer), at: 3)
    let chat: [Row] = appHead + [(4, .scrollView, "", "", R(0, 116, 402, 758))] + kb
    check("composer in the keyboard window: no drag", planner(chat).scrollSwipeStart(focusedFrame: composer), nil)
}

do {
    // A field in a sheet whose ScrollView content has been scrolled up: the
    // content container's frame reaches above the sheet, over the backdrop.
    // The blank spot must stay inside the scroll view's viewport.
    let field = R(16, 350, 370, 44)
    let rows: [Row] = appHead + [
        (2, .other, "", "", screen),
        (3, .other, "", "", screen),
        (3, .other, "", "", R(0, 300, 402, 574)),
        (4, .scrollView, "", "", R(0, 300, 402, 574)),
        (5, .other, "", "", R(0, 150, 402, 900)),
        (6, .textField, "Comment", "", field),
    ] + keyboardWindows()
    let p = planner(rows).blankPoint(focusedFrame: field)
    checkTrue("scrolled content in a sheet: blank spot inside the viewport",
              p.map { R(0, 300, 402, 574).contains($0) } ?? true, "\(String(describing: p))")
}

do {
    // A form scrolled down under a navigation bar: the scroll content's
    // frame (unclipped) covers the whole screen, but the field's screen is
    // the 87% below the bar. The blank spot is still found beside the field.
    let field = R(16, 300, 370, 44)
    let rows: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 116, 402, 758)),
        (5, .other, "", "", R(0, -400, 402, 1600)),
        (6, .other, "", "", R(16, 300, 370, 44)),
        (7, .textField, "Field", "", field),
        (6, .button, "Below", "", R(16, 360, 370, 44)),
    ] + keyboardWindows()
    checkTrue("scrolled-down form under a nav bar: blank spot found",
              planner(rows).blankPoint(focusedFrame: field) != nil)
}

do {
    // A stale off-screen keyboard holding a "return" key before the real one
    // with a "send" key: the stale key is not judged or pressed.
    var rows = keyboardWindows(returnLabel: "send", returnId: "Send")
    rows.insert(contentsOf: [
        (2, .keyboard, "", "", R(0, 900, 402, 243)),
        (3, .button, "return", "Return", R(299, 1075, 98, 56)),
        (3, .button, "Hide keyboard", "", R(330, 1080, 60, 50)),
    ], at: 1)
    check("stale keyboard's return key is not the key",
          planner(appHead + rows).returnKey(focusedInput: .textField),
          .notPossible("the return key is \"send\", an app action"))
    check("stale keyboard's dismiss key is not the key", planner(appHead + rows).dismissKey(), nil)
}

do {
    // A button in the keyboard's window just above the keyboard region (an
    // accessory bar the region does not include) blocks the blank spot.
    let field = R(16, 132, 370, 44)
    var kb = keyboardWindows()
    kb.insert((3, .button, "Send", "", R(0, 180, 402, 349)), at: 3)
    let rows: [Row] = appHead + [
        (4, .other, "", "", R(0, 116, 402, 758)),
        (5, .textField, "Field", "", field),
    ] + kb
    let p = planner(rows).blankPoint(focusedFrame: field)
    checkTrue("keyboard-window button blocks the blank spot",
              p.map { !R(0, 180, 402, 349).insetBy(dx: -7, dy: -7).contains($0) } ?? true, "\(String(describing: p))")
    // A scroll view in the keyboard's window that holds the field is not
    // dragged (the keyboard's own scroller).
    var kb2 = keyboardWindows()
    kb2.insert(contentsOf: [
        (3, .scrollView, "", "", R(0, 116, 402, 400)),
        (4, .textField, "Composer", "", R(16, 132, 200, 30)),
    ], at: 3)
    check("keyboard-window scroll view holding the field: no drag",
          planner(appHead + kb2).scrollSwipeStart(focusedFrame: R(16, 132, 200, 30)), nil)
    // An inner scroll view inside an outer one is dragged: the outer scroll
    // view around it does not block its start point.
    let inner = R(16, 200, 200, 30)
    let nested: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 116, 402, 758)),
        (5, .scrollView, "", "", R(0, 150, 402, 350)),
        (6, .textField, "Field", "", inner),
    ] + keyboardWindows()
    checkTrue("inner scroll view inside an outer one: drag in the inner one",
              planner(nested).scrollSwipeStart(focusedFrame: inner).map { R(0, 150, 402, 350).contains($0) } ?? false)
    // No keyboard, field known: no drag.
    let noKb: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 116, 402, 758)),
        (5, .textField, "Field", "", inner),
    ]
    check("no keyboard with a known field: no drag", planner(noKb).scrollSwipeStart(focusedFrame: inner), nil)
    // A headerless screen: the status bar strip is never the blank spot.
    let headerless: [Row] = [
        (0, .application, "App", "", screen),
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
        (3, .other, "", "", R(0, 0, 402, 800)),
        (4, .textField, "Field", "", R(16, 62, 370, 44)),
        (4, .button, "Wall", "", R(0, 106, 402, 700)),
    ] + keyboardWindows()
    let hp = planner(headerless).blankPoint(focusedFrame: R(16, 62, 370, 44))
    checkTrue("status bar strip is not a blank spot (container from y=0)",
              hp.map { $0.y >= Planner.statusBarAllowance } ?? true, "\(String(describing: hp))")
}

do {
    // A stale off-screen keyboard element before the real one: the real one
    // still counts.
    var rows = keyboardWindows()
    rows.insert((2, .keyboard, "", "", R(0, 900, 402, 243)), at: 1)
    // The same region as without the stale element: the input view above the
    // keys (529–573 in the recorded tree) belongs to the keyboard.
    checkTrue("stale off-screen keyboard before the real one: region from the real one",
              planner(appHead + rows).keyboardRegion.map { $0.minY == 529 } ?? false,
              "\(String(describing: planner(appHead + rows).keyboardRegion))")
}

do {
    // The nearest scroll view holding the field has no clear spot (a
    // carousel of cards); the one around it does.
    let field = R(16, 150, 200, 30)
    let rows: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 116, 402, 758)),
        (5, .collectionView, "", "", R(0, 116, 402, 300)),
        (6, .other, "Card", "", R(0, 116, 402, 300)),
        (7, .textField, "Field", "", field),
    ] + keyboardWindows()
    checkTrue("falls back to an outer scroll view holding the field",
              planner(rows).scrollSwipeStart(focusedFrame: field).map { R(0, 416, 402, 113).contains($0) } ?? false)
}

do {
    // A keyboard element off screen, or zero-sized, covers nothing.
    var offScreen = keyboardWindows()
    offScreen = offScreen.map { row in
        row.type == .keyboard ? (row.depth, row.type, row.label, row.id, R(4.67, 900, 393, 243)) : row
    }.filter { $0.id != "inputView" && !($0.type == .other && $0.frame.minY == 529) && !($0.type == .other && $0.frame.minY == 573) }
    let offPlanner = planner(appHead + offScreen.filter { $0.type != .button && $0.type != .key })
    check("off-screen keyboard: no keyboard region", offPlanner.keyboardRegion, nil)
    let zero = keyboardWindows().map { row in
        row.type == .keyboard ? (row.depth, row.type, row.label, row.id, R(0, 874, 0, 0)) : row
    }
    check("zero-sized keyboard: no keyboard region", planner(appHead + zero).keyboardRegion, nil)
}

/// The tree recorded with a hardware keyboard attached (PILOT-792), on an
/// iPhone 17 Pro / iOS 26.4 simulator with a SwiftUI Form field focused: the
/// software keyboard stays in the tree, parked below the screen, while
/// nothing of it is drawn.
func parkedKeyboardTree() -> [Row] {
    appHead + [
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
        (3, .other, "", "", R(0, 874, 402, 311)),
        (4, .other, "", "SystemInputAssistantView", R(0, 874, 402, 78)),
        (5, .other, "", "", R(0, 874, 402, 78)),
        (6, .other, "", "CenterPageView", R(0, 874, 402, 44)),
        (7, .other, "", "", R(0, 274, 402, 1244)),
        (8, .scrollView, "", "", R(0, 874, 402, 44)),
        (7, .other, "Typing Predictions", "", R(0, 874, 402, 44)),
        (8, .other, "I", "", R(0, 874, 134, 44)),
        (3, .other, "", "", R(0, 952, 402, 233)),
        (4, .keyboard, "", "", R(0, 952, 402, 233)),
        (5, .other, "", "UIKeyboardLayoutStar Preview", R(0, 952, 402, 233)),
        (6, .key, "Q", "", R(4.67, 959, 39.33, 54)),
        (6, .button, "shift", "shift", R(4.67, 1067, 51.33, 54)),
        (6, .button, "done", "Done", R(300.67, 1121, 99, 54)),
    ]
}

do {
    // A hardware keyboard attached (PILOT-792), recorded on an iPhone 17 Pro /
    // iOS 26.4 simulator with a SwiftUI Form field focused: the software
    // keyboard stays in the tree, parked below the screen, while nothing of
    // it is drawn. Its window and the window's full-screen host are on
    // screen, and so is part of a 1244-point scroller. isKeyboardShown() and
    // hideKeyboard both read this as no keyboard.
    let parked = parkedKeyboardTree()
    let parkedPlanner = planner(parked)
    check("keyboard parked below the screen (hardware keyboard): no keyboard region",
          parkedPlanner.keyboardRegion, nil)
    check("keyboard parked below the screen: no return key to press",
          parkedPlanner.returnKey(focusedInput: .textField),
          .notPossible("the keyboard has no return key"))
}

do {
    // A parked keyboard (the same off-screen frame read after read) stops
    // the wait for it to slide in; a moving one does not.
    let parkedFrame = [R(0, 952, 402, 233)]
    var parked = ParkedKeyboardWatch()
    let parkedReads = (1...ParkedKeyboardWatch.parkedReads).map { _ in parked.isParked(after: parkedFrame) }
    check("same off-screen frame: parked only on the last of parkedReads reads",
          parkedReads, Array(repeating: false, count: ParkedKeyboardWatch.parkedReads - 1) + [true])
    var sliding = ParkedKeyboardWatch()
    let slidingReads = [900.0, 900, 880, 880, 880, 880].map { sliding.isParked(after: [R(0, $0, 402, 233)]) }
    check("a frame that moves restarts the count", slidingReads, [false, false, false, false, false, true])
    check("the recorded parked tree lists its keyboard frame", planner(parkedKeyboardTree()).keyboardFrames, parkedFrame)
}

do {
    // A scroll view left in the tree under a screen that covers it: the
    // point must not be on the covering screen's controls.
    let covered: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 116, 402, 758)),
        (3, .other, "", "", R(0, 116, 402, 758)),
        (4, .button, "Cover", "", R(0, 116, 402, 758)),
    ] + keyboardWindows()
    check("scroll view under another screen's control: no drag", planner(withFieldInScroller(covered)).scrollSwipeStart(focusedFrame: contentFieldFrame), nil)
}

do {
    let behindKeyboard: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 540, 402, 300)),
    ] + keyboardWindows()
    check("scroll view behind the keyboard: no drag",
          planner(withFieldInScroller(behindKeyboard, field: R(16, 600, 200, 30))).scrollSwipeStart(focusedFrame: R(16, 600, 200, 30)), nil)
}

do {
    // The keyboard window's own scroller does not count.
    let keyboardScroller = appHead + occlusionContent + keyboardWindows(extraKeys: [
        (4, .scrollView, "", "", R(0, 200, 402, 300)),
    ])
    check("keyboard's own scroll view: no drag", planner(keyboardScroller).scrollSwipeStart(focusedFrame: occlusionInput), nil)
}

// MARK: - 2. Dismiss key

check("iPhone keyboard: no dismiss key", planner(occlusion).dismissKey(), nil)
do {
    let iPad = appHead + occlusionContent + keyboardWindows(extraKeys: [
        // As recorded on an iPad Air 11-inch (M2) simulator: no identifier.
        (4, .button, "Hide keyboard", "", R(330, 760, 60, 50)),
    ])
    check("iPad keyboard: dismiss key", planner(iPad).dismissKey(), CGPoint(x: 360, y: 785))
    let appButton = appHead + occlusionContent + [
        (4, .button, "Hide keyboard", "", R(16, 480, 100, 40)),
    ] + keyboardWindows()
    check("an app button named like the key is not the key", planner(appButton).dismissKey(), nil)
}

// MARK: - iOS 27 toolbar host (PILOT-1207)

// iOS 27 lays a `Toolbar` host the size of its container over the screen's
// content (a full-size content layer before it), empty or holding a bottom
// toolbar's items as floating capsules. The host is not a blocker; its items
// are.
func withIOS27Host(_ rows: [Row], items: [Row] = []) -> [Row] {
    // Last in the app's window: before the keyboard's windows.
    let split = rows.indices.dropFirst(2).first { rows[$0].type == .window } ?? rows.count
    return Array(rows[..<split]) + [
        (3, .other, "", "", screen),
        (3, .toolbar, "Toolbar", "Toolbar", screen),
        (4, .other, "", "", screen),
    ] + items + Array(rows[split...])
}
do {
    let host27 = withIOS27Host(scrollScreen)
    checkTrue("iOS 27 host: scroll drag still offered",
              planner(host27).scrollSwipeStart(focusedFrame: R(16, 180, 370, 44)) != nil)
    checkTrue("iOS 27 host: blank spot still found",
              planner(withIOS27Host(occlusion)).blankPoint(focusedFrame: occlusionInput) != nil)
    // A capsule in the host still blocks: a full-width one over the drag area
    // leaves no start there.
    let capsule = R(0, 116, 402, 413)
    let p = planner(withIOS27Host(scrollScreen, items: [(4, .button, "Archive", "", capsule)]))
        .scrollSwipeStart(focusedFrame: R(16, 180, 370, 44))
    checkTrue("iOS 27 host: its item still blocks a drag start", p.map { notInside($0, [capsule]) } ?? true, "\(String(describing: p))")
}

do {
    // Only a bar can be a host: a control laid out the same way (filling its
    // container, over a full-size earlier sibling) still blocks.
    let split = scrollScreen.indices.dropFirst(2).first { scrollScreen[$0].type == .window } ?? scrollScreen.count
    let coverRows: [Row] = Array(scrollScreen[..<split]) + [
        (3, .other, "", "", screen),
        (3, .button, "Cover", "", screen),
    ] + Array(scrollScreen[split...])
    check("container-sized control over a full-size sibling: no drag",
          planner(coverRows).scrollSwipeStart(focusedFrame: R(16, 180, 370, 44)), nil)
}

// MARK: - The system status bar off the top strip (PILOT-1262)

// The iPhone Duo simulator (iOS 27.2) shows its status bar as a column at the
// right edge, not a strip along the top. A SwiftUI Form there leaves that
// column empty beside its rows, and the drag started in it opened Control
// Center. Frames recorded from the Duo's keyboard screen and SpringBoard.
let duoScreen = R(0, 0, 466, 678)
/// SpringBoard's status bar content on the Duo (the union of its items).
let duoStatusBar = R(378, 0, 88, 176.33)
let duoNameField = R(40, 97, 322, 22)
let duoForm: [Row] = [
    (0, .application, "Tapsmith Native", "", duoScreen),
    (1, .window, "", "", duoScreen),
    (2, .other, "", "", duoScreen),
    (3, .other, "", "", duoScreen),
    (3, .toolbar, "Toolbar", "Toolbar", duoScreen),
    (4, .other, "", "", R(394, 174, 48, 48)),
    (5, .button, "", "BackButton", R(399, 179, 38, 38)),
    (3, .navigationBar, "", "Keyboard", R(0, 24, 466, 58)),
    (4, .staticText, "Keyboard", "", R(20, 31, 125, 34)),
    (3, .other, "", "", duoScreen),
    (4, .collectionView, "", "", duoScreen),
    (5, .cell, "", "", R(20, 82, 362, 52)),
    (6, .textField, "", "", duoNameField),
    (5, .cell, "", "", R(20, 134, 362, 52)),
    (6, .staticText, "Nothing submitted", "", R(40, 149, 200, 22)),
    (5, .cell, "", "", R(20, 186, 362, 130)),
    (6, .textView, "", "notes", R(40, 201, 322, 100)),
    (5, .cell, "", "", R(20, 316, 362, 44)),
    (6, .button, "Save Notes", "", R(40, 327, 100, 22)),
    // The keyboard, its top at 376.
    (1, .window, "", "", duoScreen),
    (2, .other, "", "", duoScreen),
    (3, .other, "", "", R(0, 376, 466, 302)),
    (4, .other, "", "", R(0, 420, 466, 258)),
    (5, .keyboard, "", "", R(0, 420, 466, 250)),
    (6, .key, "q", "", R(4, 430, 42, 50)),
    (6, .button, "return", "Return", R(360, 610, 100, 50)),
]
func duoPlanner(statusBar: CGRect?) -> Planner {
    Planner(analyzer: OcclusionAnalyzer(nodes: tree(duoForm), screen: duoScreen), statusBar: statusBar)
}
/// The area a drag starting at `p` sweeps (it goes up, then left, by
/// `swipeFraction` of the screen), widened by the touch clearance.
func dragSweep(from p: CGPoint, screen: CGRect) -> CGRect {
    let dx = screen.width * Planner.swipeFraction, dy = screen.height * Planner.swipeFraction
    return CGRect(x: p.x - dx, y: p.y - dy, width: dx, height: dy)
        .insetBy(dx: -Planner.touchClearance + 0.01, dy: -Planner.touchClearance + 0.01)
}
do {
    // Without knowing where the status bar is, the Form's empty margin under
    // it looks like the clearest spot (the bug).
    let unknown = duoPlanner(statusBar: nil).scrollSwipeStart(focusedFrame: duoNameField)
    checkTrue("Duo, status bar unknown: the drag is still offered (the old pick)", unknown != nil)
    let p = duoPlanner(statusBar: duoStatusBar).scrollSwipeStart(focusedFrame: duoNameField)
    checkTrue("Duo form: a drag start is found off the status bar", p != nil)
    if let p {
        checkTrue("Duo form: the drag never touches the side status bar",
                  !dragSweep(from: p, screen: duoScreen).intersects(duoStatusBar), "\(p)")
        checkTrue("Duo form: the drag starts above the keyboard", p.y < 376, "\(p)")
        checkTrue("Duo form: the drag starts clear of the back button and the rows",
                  notInside(p, [R(399, 179, 38, 38), R(20, 82, 362, 278)]), "\(p)")
    }
    // A status bar covering the only clear column leaves no drag.
    check("Duo form: status bar over the whole free column: no drag",
          duoPlanner(statusBar: R(378, 0, 88, 678)).scrollSwipeStart(focusedFrame: duoNameField), nil)
}

do {
    // A blank tap keeps off a side status bar too: the only gap beside the
    // field is a column the status bar covers the top of.
    let field = R(16, 132, 300, 44)
    let rows = fieldScreen([(4, .button, "Wall", "", R(0, 0, 340, 874))], field: field)
    let sideBar = R(340, 0, 62, 300)
    let open = Planner(analyzer: OcclusionAnalyzer(nodes: tree(rows), screen: screen), statusBar: nil)
        .blankPoint(focusedFrame: field)
    checkTrue("side status bar unknown: the gap's clearest spot is under it", open.map { sideBar.contains($0) } ?? false, "\(String(describing: open))")
    let p = Planner(analyzer: OcclusionAnalyzer(nodes: tree(rows), screen: screen), statusBar: sideBar)
        .blankPoint(focusedFrame: field)
    checkTrue("side status bar: blank spot found below it", p != nil)
    if let p { checkTrue("side status bar: blank spot clear of it", notInside(p, [sideBar]), "\(p)") }
    // A top status bar changes nothing the top strip did not already rule out.
    check("top status bar: same blank spot as without it",
          Planner(analyzer: OcclusionAnalyzer(nodes: tree(occlusion), screen: screen), statusBar: R(0, 0, 402, 54))
              .blankPoint(focusedFrame: occlusionInput),
          planner(occlusion).blankPoint(focusedFrame: occlusionInput))
    check("top status bar: same drag start as without it",
          Planner(analyzer: OcclusionAnalyzer(nodes: tree(scrollScreen), screen: screen), statusBar: R(0, 0, 402, 54))
              .scrollSwipeStart(focusedFrame: R(16, 180, 370, 44)),
          planner(scrollScreen).scrollSwipeStart(focusedFrame: R(16, 180, 370, 44)))
}

// Where SpringBoard draws the status bar, from its snapshot.
do {
    // The Duo: the status bar element is the size of the screen; its items
    // sit in a column at the right.
    let duoSpringBoard: [Row] = [
        (0, .application, "SpringBoard", "", duoScreen),
        (1, .window, "", "", duoScreen),
        (2, .statusBar, "", "", duoScreen),
        (3, .other, "", "", R(378, 0, 88, 176.33)),
        (4, .other, "", "", R(390.67, 20.33, 55, 137.33)),
        (5, .other, "", "", R(399, 30, 37, 37)),
        (5, .staticText, "19:53", "", R(396.67, 83, 43, 19.33)),
        (5, .other, "", "", R(394.67, 106.67, 47, 47)),
        (1, .window, "", "", R(0, 0, 669, 951)),
        (2, .other, "", "", R(0, 0, 669, 951)),
    ]
    check("Duo SpringBoard: the status bar is the column of its items",
          Planner.statusBarRegion(springboard: OcclusionAnalyzer(nodes: tree(duoSpringBoard), screen: duoScreen)),
          R(378, 0, 88, 176.33))
    // iPhone 17 Pro (iOS 27.2 and 26.5): a strip along the top.
    let proSpringBoard: [Row] = [
        (0, .application, "SpringBoard", "", screen),
        (1, .window, "", "", screen),
        (2, .statusBar, "", "", R(0, 0, 402, 54)),
        (3, .other, "", "", R(0, 0, 402, 54)),
        (4, .staticText, "19:54", "", R(51, 22.33, 46, 20.33)),
        (4, .other, "", "", R(339, 26.33, 27.67, 13)),
    ]
    check("iPhone SpringBoard: the status bar is the top strip",
          Planner.statusBarRegion(springboard: OcclusionAnalyzer(nodes: tree(proSpringBoard), screen: screen)),
          R(0, 0, 402, 54))
    let noBar: [Row] = [(0, .application, "SpringBoard", "", screen), (1, .window, "", "", screen)]
    check("no status bar in SpringBoard: none",
          Planner.statusBarRegion(springboard: OcclusionAnalyzer(nodes: tree(noBar), screen: screen)), nil)
    let empty: [Row] = [(0, .application, "SpringBoard", "", screen), (1, .statusBar, "", "", screen)]
    check("a screen-sized status bar with no items: none",
          Planner.statusBarRegion(springboard: OcclusionAnalyzer(nodes: tree(empty), screen: screen)), nil)
    // SpringBoard laid out in another orientation than the app (it stays
    // portrait under a landscape app): its frames are not the app's.
    // The Duo's other display: a status bar in a window of its own size.
    let otherDisplay: [Row] = Array(duoSpringBoard.prefix(8)) + [
        (1, .window, "", "", R(0, 0, 669, 951)),
        (2, .statusBar, "", "", R(0, 0, 669, 54)),
        (3, .staticText, "19:53", "", R(51, 22, 46, 20)),
    ]
    check("a status bar on another display counts for nothing",
          Planner.statusBarRegion(springboard: OcclusionAnalyzer(nodes: tree(otherDisplay), screen: duoScreen)),
          R(378, 0, 88, 176.33))
    let landscape = R(0, 0, 874, 402)
    check("SpringBoard in another orientation than the app: none",
          Planner.statusBarRegion(springboard: OcclusionAnalyzer(nodes: tree(proSpringBoard), screen: landscape)), nil)
    let offScreen: [Row] = [
        (0, .application, "SpringBoard", "", screen),
        (1, .statusBar, "", "", R(0, 0, 402, 54)),
        (2, .other, "", "", R(0, -60, 402, 54)),
        (2, .other, "", "", R(0, 0, 0, 0)),
    ]
    check("status bar items off screen or empty count for nothing beyond the bar itself",
          Planner.statusBarRegion(springboard: OcclusionAnalyzer(nodes: tree(offScreen), screen: screen)),
          R(0, 0, 402, 54))
}

// MARK: - 3. Blank spot

do {
    let p = planner(occlusion).blankPoint(focusedFrame: occlusionInput)
    checkTrue("occlusion: blank spot found", p != nil)
    if let p {
        checkTrue("blank spot: above the keyboard, below the status bar", p.y < 529 && p.y > Planner.statusBarAllowance, "\(p)")
        let rows = occlusion.filter { row in
            if row.type == .application || row.type == .window || row.id == "tapsmith-hooks" { return false }
            return row.type != .other || !row.label.isEmpty || row.id == "pass-through-overlay"
        }
        checkTrue("blank spot: clear of every control, text, bar and input", notInside(p, rows.map(\.frame)), "\(p)")
    }
    check("no focused field known: no blank spot", planner(occlusion).blankPoint(focusedFrame: nil), nil)
    check("focused field not in the tree: no blank spot",
          planner(occlusion).blankPoint(focusedFrame: R(0, 600, 50, 20)), nil)
}

/// A screen holding only a field at `field`, inside `content`.
func fieldScreen(_ content: [Row], field: CGRect = R(16, 132, 370, 44)) -> [Row] {
    appHead + content + [(4, .textField, "Field", "", field)] + keyboardWindows()
}

do {
    let field = R(16, 132, 370, 44)
    // Every spot above the keyboard is a control: no blank spot.
    check("screen of controls: no blank spot",
          planner(fieldScreen([(4, .button, "Wall", "", R(0, 0, 402, 874))])).blankPoint(focusedFrame: field), nil)
    // The only gap is the status bar strip.
    check("status bar strip is not a blank spot",
          planner(fieldScreen([(4, .button, "Wall", "", R(0, 50, 402, 824))])).blankPoint(focusedFrame: field), nil)
    // A small testID'd view (an icon-only Pressable) is not blank.
    let icon = fieldScreen([
        (4, .button, "Wall", "", R(0, 0, 402, 400)),
        (4, .other, "", "icon-button", R(0, 400, 402, 129)),
    ])
    check("small testID'd view is not blank", planner(icon).blankPoint(focusedFrame: field), nil)
    // A screen-sized testID'd container is.
    checkTrue("screen-sized testID'd container is blank",
              planner(fieldScreen([(4, .other, "", "screen-root", R(0, 116, 402, 758))])).blankPoint(focusedFrame: field) != nil)
    // The hooks marker, even screen-sized (as on CI), takes no touches.
    let marker: [Row] = appHead + [
        (4, .textField, "Field", "", field),
        (2, .staticText, "tapsmith-hooks:1;epoch=0", "tapsmith-hooks", screen),
    ] + keyboardWindows()
    checkTrue("hooks marker does not block a blank spot", planner(marker).blankPoint(focusedFrame: field) != nil)
}

do {
    // A sheet over a full-screen backdrop that closes it when tapped (an
    // unlabeled Pressable, indistinguishable from a plain view). The blank
    // spot must be inside the sheet, beside the field, not on the backdrop.
    let sheet = R(0, 300, 402, 574)
    let field = R(16, 316, 370, 44)
    let rows: [Row] = appHead + [
        (4, .other, "", "", R(0, 116, 402, 758)),
        (2, .other, "", "", screen),
        (3, .other, "", "", screen),
        (3, .other, "", "", sheet),
        (4, .textField, "Comment", "", field),
    ] + keyboardWindows()
    let p = planner(rows).blankPoint(focusedFrame: field)
    checkTrue("sheet: blank spot inside the sheet, not on the backdrop",
              p.map { sheet.contains($0) && notInside($0, [field]) } ?? false, "\(String(describing: p))")
}

do {
    // A sheet with no blank room over a close-on-press backdrop: no blank tap
    // (the walk stops before the full-screen modal root holding the backdrop).
    let field = R(16, 316, 370, 44)
    let rows: [Row] = appHead + [
        (2, .other, "", "", screen),
        (3, .other, "", "", screen),
        (3, .other, "", "", R(0, 300, 402, 574)),
        (4, .textField, "Comment", "", field),
        (4, .button, "Post", "", R(0, 300, 402, 16)),
        (4, .button, "Cancel", "", R(0, 360, 402, 170)),
        (4, .button, "Left", "", R(0, 316, 16, 44)),
        (4, .button, "Right", "", R(386, 316, 16, 44)),
    ] + keyboardWindows()
    check("sheet with no room: no blank tap on the backdrop", planner(rows).blankPoint(focusedFrame: field), nil)
}

// MARK: - Background images (PILOT-1177)

/// DreamSpinner's email sign-in screen with the password field focused, as
/// recorded on an iPhone 17 / iOS 26.4 simulator (trace hierarchy, runs of
/// identical screen-sized wrappers collapsed): a React Native ImageBackground
/// draws a screen-sized image behind a ScrollView form. The keyboard's return
/// key is "next", identifier "Next:".
let signInPassword = R(98, 430, 198, 45)
let signInBlockers: [CGRect] = [
    R(42, 94, 317, 64), R(96, 170, 210, 21), R(49, 264, 304, 20), R(49, 308, 48, 17),
    R(98, 337, 238, 45), R(66, 349, 20, 20), R(49, 401, 88, 17), signInPassword, R(66, 442, 20, 20),
    R(308, 438, 28, 28), R(49, 506, 304, 44), R(0, 533, 402, 30),
]
func signInScreen(background: Row? = (5, .image, "", "assets/assets/images/background-portrait.png", screen)) -> [Row] {
    var rows: [Row] = [
        (0, .application, "DreamSpinner", "", screen),
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
        (3, .other, "", "", screen),
        (4, .other, "", "", screen),
    ]
    if let background { rows.append(background) }
    rows += [
        (4, .other, "", "", screen),
        (4, .other, "", "", screen),
        (5, .other, "", "", screen),
        (6, .other, "", "", R(0, 62, 402, 504)),
        (7, .scrollView, "", "", R(0, 62, 402, 504)),
        (8, .other, "", "", R(0, 62, 402, 738)),
        (9, .other, "", "", R(0, 62, 402, 738)),
        (10, .staticText, "DreamSpinner", "", R(42, 94, 317, 64)),
        (10, .staticText, "Unleash endless creativity", "", R(96, 170, 210, 21)),
        (10, .other, "", "", R(24, 239, 354, 449)),
        (10, .staticText, "Sign in to continue to DreamSpinner", "", R(49, 264, 304, 20)),
        (10, .staticText, "EMAIL", "", R(49, 308, 48, 17)),
        (10, .other, "", "", R(49, 333, 304, 52)),
        (10, .other, "", "", R(98, 337, 238, 45)),
        (11, .textField, "", "", R(98, 337, 238, 45)),
        (10, .other, "", "", R(66, 349, 20, 20)),
        (11, .image, "get mail", "envelope.fill", R(66, 349, 20, 20)),
        (10, .staticText, "PASSWORD", "", R(49, 401, 88, 17)),
        (10, .other, "", "", R(49, 426, 304, 52)),
        (10, .other, "", "", R(98, 430, 198, 45)),
        (11, .secureTextField, "", "", signInPassword),
        (10, .other, "", "", R(66, 442, 20, 20)),
        (11, .image, "lock", "lock.fill", R(66, 442, 20, 20)),
        (10, .button, "Show password", "", R(308, 438, 28, 28)),
        (10, .button, "Sign in", "", R(49, 506, 304, 44)),
        (10, .button, "Forgot password?", "", R(237, 557, 116, 17)),
        (10, .button, "Sign up", "", R(243, 588, 79, 32)),
        (8, .other, "Horizontal scroll bar, 1 page", "", R(0, 533, 402, 30)),
        // The keyboard: region from 566, return key "next" / "Next:".
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
        (3, .other, "", "", R(0, 566, 402, 308)),
        (4, .other, "", "inputView", R(0, 566, 402, 308)),
        (1, .window, "", "", screen),
        (2, .other, "", "", screen),
        (3, .other, "", "", R(0, 566, 402, 308)),
        (4, .other, "", "", R(0, 583, 402, 233)),
        (5, .keyboard, "", "", R(0, 583, 402, 233)),
        (6, .key, "q", "", R(4, 590, 39, 54)),
        (6, .button, "shift", "shift", R(4, 698, 51, 54)),
        (6, .key, "delete", "delete", R(348, 698, 51, 54)),
        (6, .key, "numbers", "more", R(4, 752, 99, 54)),
        (6, .key, " ", "space", R(103, 752, 197, 54)),
        (6, .button, "next", "Next:", R(300, 752, 99, 54)),
        (4, .other, "", "", R(0, 583, 402, 291)),
        (5, .button, "Dictate", "dictation", R(325, 805, 68, 69)),
    ]
    return rows
}

do {
    // PILOT-1177: the screen-sized background image blocked every point, so
    // hideKeyboard found neither a drag start nor a blank spot and failed.
    let signIn = planner(signInScreen())
    check("sign-in screen: keyboard region from the trace", signIn.keyboardRegion, R(0, 566, 402, 308))
    let drag = signIn.scrollSwipeStart(focusedFrame: signInPassword)
    checkTrue("background image: scroll view drag offered", drag != nil)
    if let p = drag {
        checkTrue("background image: drag starts in the scroll view above the keyboard",
                  R(0, 62, 402, 504).contains(p) && p.y < 566, "\(p)")
        checkTrue("background image: drag starts clear of the form's controls and text",
                  notInside(p, signInBlockers), "\(p)")
    }
    let blank = signIn.blankPoint(focusedFrame: signInPassword)
    checkTrue("background image: blank spot found", blank != nil)
    if let p = blank {
        checkTrue("background image: blank spot in the scroll view above the keyboard",
                  R(0, 62, 402, 504).contains(p) && p.y < 566, "\(p)")
        checkTrue("background image: blank spot clear of the form's controls and text",
                  notInside(p, signInBlockers), "\(p)")
    }
    // Without the image the same screen plans the same way.
    checkTrue("no background image: blank spot found",
              planner(signInScreen(background: nil)).blankPoint(focusedFrame: signInPassword) != nil)
    // A labeled background (SwiftUI labels an asset image with its name) is
    // a background too; one cropped by the screen counts its visible part.
    checkTrue("labeled background image: blank spot found",
              planner(signInScreen(background: (5, .image, "background", "background", screen)))
                  .blankPoint(focusedFrame: signInPassword) != nil)
    checkTrue("background image taller than the screen: blank spot found",
              planner(signInScreen(background: (5, .image, "", "", R(0, -200, 402, 1400))))
                  .blankPoint(focusedFrame: signInPassword) != nil)
    // The keyboard's "next" key is an app action — refused for that reason,
    // not as a missing key ("Next:" carries a colon on iOS 26.4).
    check("sign-in screen: \"Next:\" is the return key, an app action",
          signIn.returnKey(focusedInput: .secureTextField),
          .notPossible("the return key is \"next\", an app action"))
}

do {
    let field = R(16, 132, 370, 44)
    // An image smaller than half the screen may be a tappable picture or
    // icon: it still blocks, labeled or not.
    for (label, name) in [("", "unlabeled"), ("Photo", "labeled")] {
        let picture = fieldScreen([
            (4, .button, "Wall", "", R(0, 0, 402, 400)),
            (4, .image, label, "", R(0, 400, 402, 129)),
        ])
        check("small \(name) image is not blank", planner(picture).blankPoint(focusedFrame: field), nil)
    }
    // Just under half the screen still blocks; half the screen does not.
    let half = screen.width * screen.height * Planner.containerAreaFraction / screen.width
    // The rest of the room is a wall of controls.
    let underHalf = fieldScreen([
        (4, .image, "", "", R(0, 116, 402, half - 1)),
        (4, .button, "Wall", "", R(0, 116 + half - 1, 402, 874)),
    ])
    check("image just under half the screen covering the room: not blank",
          planner(underHalf).blankPoint(focusedFrame: field), nil)
    let atHalf = fieldScreen([
        (4, .image, "", "", R(0, 116, 402, half)),
        (4, .button, "Wall", "", R(0, 116 + half, 402, 874)),
    ])
    checkTrue("image of half the screen is a background", planner(atHalf).blankPoint(focusedFrame: field) != nil)
}

// MARK: - 4. Return key

check("single-line field, return key: press it",
      planner(occlusion).returnKey(focusedInput: .textField), .press(CGPoint(x: 348, y: 776)))
check("secure field, done key: press it",
      planner(appHead + keyboardWindows(returnLabel: "done", returnId: "Done")).returnKey(focusedInput: .secureTextField),
      .press(CGPoint(x: 348, y: 776)))
check("multi-line field: never press return",
      planner(occlusion).returnKey(focusedInput: .textView),
      .notPossible("the focused field is multi-line, where return types a new line"))
check("no focused field found: do not press",
      planner(occlusion).returnKey(focusedInput: nil), .notPossible("no focused text field was found"))
check("focused element is not a text input: do not press",
      planner(occlusion).returnKey(focusedInput: .button), .notPossible("no focused text field was found"))
for (label, id) in [("go", "Return"), ("send", "Send"), ("Search", "Search"), ("next", "Return"), ("Join", "Join")] {
    check("action return key \"\(label)\" (id \(id)): do not press",
          planner(appHead + keyboardWindows(returnLabel: label, returnId: id)).returnKey(focusedInput: .textField),
          .notPossible("the return key is \"\(label)\", an app action"))
}
// An accessory toolbar's Done button (outside the .keyboard element, in its
// window) does not stand in for a "send" return key.
do {
    // In tree order the accessory comes first: it is in the input view's
    // window, ahead of the keys.
    var rows = keyboardWindows(returnLabel: "send", returnId: "Send")
    rows.insert((4, .button, "Done", "Done", R(330, 490, 60, 39)), at: 4)
    check("accessory Done does not approve a send key",
          planner(appHead + rows).returnKey(focusedInput: .textField),
          .notPossible("the return key is \"send\", an app action"))
}
check("keyboard without a return key",
      planner(appHead + keyboardWindows(returnLabel: "space", returnId: "space")).returnKey(focusedInput: .textField),
      .notPossible("the keyboard has no return key"))
check("an app button labeled return is not the key",
      planner(appHead + [(4, .button, "return", "Return", R(16, 300, 100, 40))]
          + keyboardWindows(returnLabel: "space", returnId: "space")).returnKey(focusedInput: .textField),
      .notPossible("the keyboard has no return key"))
// Labels are localized, identifiers are not: a French keyboard's default key.
check("localized default return key: press it",
      planner(appHead + keyboardWindows(returnLabel: "retour", returnId: "Return")).returnKey(focusedInput: .textField),
      .press(CGPoint(x: 348, y: 776)))
check("localized action key: do not press",
      planner(appHead + keyboardWindows(returnLabel: "aller", returnId: "Go")).returnKey(focusedInput: .textField),
      .notPossible("the return key is \"aller\", an app action"))
check("key without an identifier: judged by its label",
      planner(appHead + keyboardWindows(returnLabel: "done", returnId: "")).returnKey(focusedInput: .textField),
      .press(CGPoint(x: 348, y: 776)))
// iOS 26.4 gives some return keys a trailing colon ("Next:"); it does not
// change which key it is.
check("identifier with a colon, action key: do not press",
      planner(appHead + keyboardWindows(returnLabel: "go", returnId: "Go:")).returnKey(focusedInput: .textField),
      .notPossible("the return key is \"go\", an app action"))
check("identifier with a colon, done key: press it",
      planner(appHead + keyboardWindows(returnLabel: "done", returnId: "Done:")).returnKey(focusedInput: .textField),
      .press(CGPoint(x: 348, y: 776)))
check("identifier with a colon, localized default key: press it",
      planner(appHead + keyboardWindows(returnLabel: "retour", returnId: "Return:")).returnKey(focusedInput: .textField),
      .press(CGPoint(x: 348, y: 776)))
check("identifier with a colon, localized action key: do not press",
      planner(appHead + keyboardWindows(returnLabel: "suivant", returnId: "Next:")).returnKey(focusedInput: .textField),
      .notPossible("the return key is \"suivant\", an app action"))

// MARK: - Failure message

do {
    let message = Planner.failureMessage([
        (.scrollSwipe, .notPossible("no scroll view on screen")),
        (.dismissKey, .notPossible("the keyboard has none")),
        (.blankTap, .keyboardStayed),
        (.returnKey, .notPossible("the return key is \"go\", an app action")),
    ])
    checkTrue("failure message says the keyboard is still shown", message.hasPrefix("The keyboard is still shown"), message)
    checkTrue("failure message names every strategy and its outcome",
              message.contains("dragging a scroll view was not possible (no scroll view on screen)")
                  && message.contains("the keyboard's dismiss key was not possible")
                  && message.contains("tapping a blank spot did not dismiss it")
                  && message.contains("the return key was not possible (the return key is \"go\", an app action)"),
              message)
    checkTrue("failure message says what to do", message.contains("device.pressKey(\"enter\")"), message)
}

// PILOT-1432: the keyboard-first step's blank tap inside the scroll view the
// target is in. On a search screen the field sits above a React Native list,
// in a plain view that does not put the keyboard away when tapped; the list
// does, so the blank spot must be in the list.
let listSearchField = R(16, 132, 370, 44)
/// /list with the keyboard up: a search field and two counts above a
/// FlatList whose rows (React Native touchables) keep a 16 pt margin either
/// side and 8 pt apart.
func listScreen(rows count: Int, rowFrame: (Int) -> CGRect = { R(16, 242 + Double($0) * 66, 370, 58) }) -> [Row] {
    appHead + [
        (4, .searchField, "Search", "search-input", listSearchField),
        (4, .staticText, "30 items", "item-count", R(16, 192, 370, 17)),
        (4, .staticText, "0 selected", "selected-count", R(16, 217, 370, 17)),
        (4, .scrollView, "Shopping list", "", R(0, 242, 402, 632)),
        (5, .other, "", "", R(0, 242, 402, max(632, Double(count) * 66))),
    ] + (0..<count).flatMap { i -> [Row] in
        [
            (6, .other, "", "", rowFrame(i)),
            (7, .button, "Item \(i + 1)", "item-\(i + 1)", rowFrame(i)),
            (8, .staticText, "Item \(i + 1)", "", rowFrame(i).insetBy(dx: 16, dy: 12)),
        ]
    } + keyboardWindows()
}
func rowTarget(_ i: Int, _ frame: CGRect = R(16, 242 + Double(0) * 66, 370, 58)) -> OcclusionAnalyzer.Target {
    .init(frame: frame, elementType: .button, label: "Item \(i + 1)", identifier: "item-\(i + 1)")
}
let listViewport = R(0, 242, 402, 529 - 242)

do {
    // Every row of a full list on screen: only the side margins are blank.
    let rows = listScreen(rows: 30)
    let p = planner(rows).blankPointInScroller(of: rowTarget(1, R(16, 308, 370, 58)))
    checkTrue("packed list: a blank spot in the list", p.map { listViewport.contains($0) } ?? false, "\(String(describing: p))")
    checkTrue("packed list: the blank spot is clear of every row",
              p.map { p in notInside(p, (0..<30).map { R(16, 242 + Double($0) * 66, 370, 58) }) } ?? false,
              "\(String(describing: p))")
    // The field-scope blank spot is outside the list: the plain view the
    // field sits in, which does not put the keyboard away.
    let fieldSpot = planner(rows).blankPoint(focusedFrame: listSearchField)
    checkTrue("packed list: the field's own blank spot is outside the list",
              fieldSpot.map { !R(0, 242, 402, 632).contains($0) } ?? true, "\(String(describing: fieldSpot))")
}

do {
    // One row left after filtering: the empty list below it is blank.
    let p = planner(listScreen(rows: 1)).blankPointInScroller(of: rowTarget(0))
    checkTrue("filtered list: a blank spot in the list", p.map { listViewport.contains($0) } ?? false, "\(String(describing: p))")
    checkTrue("filtered list: clear of the row", p.map { notInside($0, [R(16, 242, 370, 58)]) } ?? false, "\(String(describing: p))")
}

do {
    // Rows edge to edge with no gaps: nothing in the list is blank.
    let rows = listScreen(rows: 30, rowFrame: { R(0, 242 + Double($0) * 58, 402, 58) })
    check("edge-to-edge rows: no blank spot in the list",
          planner(rows).blankPointInScroller(of: rowTarget(0, R(0, 242, 402, 58))), nil)
}

do {
    // A target in no scroll view, or not in the tree: no spot.
    check("target in no scroll view: none",
          planner(occlusion).blankPointInScroller(
              of: .init(frame: R(16, 325, 370, 56), elementType: .button, label: "Covered action", identifier: "")),
          nil)
    check("target not in the tree: none",
          planner(listScreen(rows: 1)).blankPointInScroller(
              of: .init(frame: R(1, 2, 3, 4), elementType: .button, label: "Gone", identifier: "")),
          nil)
    check("no keyboard: none",
          planner(Array(listScreen(rows: 1).dropLast(keyboardWindows().count))).blankPointInScroller(of: rowTarget(0)), nil)
}

do {
    // A list entirely under the keyboard has no visible blank spot.
    let rows: [Row] = appHead + [
        (4, .searchField, "Search", "search-input", listSearchField),
        (4, .scrollView, "", "", R(0, 560, 402, 314)),
        (5, .button, "Item 1", "item-1", R(16, 560, 370, 58)),
    ] + keyboardWindows()
    check("list under the keyboard: none", planner(rows).blankPointInScroller(of: rowTarget(0, R(16, 560, 370, 58))), nil)
}

do {
    // A bar from elsewhere drawn over the list blocks the spot under it.
    let bar = R(0, 300, 402, 229)
    var rows = listScreen(rows: 1)
    rows.insert((4, .button, "Floating action", "", bar), at: appHead.count + 5 + 3)
    let p = planner(rows).blankPointInScroller(of: rowTarget(0))
    checkTrue("bar over the list blocks the spot", p.map { notInside($0, [bar, R(16, 242, 370, 58)]) } ?? true,
              "\(String(describing: p))")
}

do {
    // A horizontal carousel inside the vertical list: the spot may be in the
    // carousel or the list around it (a touch in either is a touch in the
    // list), and the outer scroll view does not block the inner one's.
    let rows: [Row] = appHead + [
        (4, .searchField, "Search", "search-input", listSearchField),
        (4, .scrollView, "", "", R(0, 242, 402, 632)),
        (5, .scrollView, "", "", R(0, 242, 402, 120)),
        (6, .button, "Card 1", "", R(16, 250, 150, 104)),
        (6, .button, "Card 2", "", R(182, 250, 150, 104)),
        (6, .button, "Card 3", "", R(348, 250, 150, 104)),
    ] + keyboardWindows()
    let p = planner(rows).blankPointInScroller(
        of: .init(frame: R(16, 250, 150, 104), elementType: .button, label: "Card 1", identifier: ""))
    checkTrue("carousel in a list: a spot in the list", p.map { listViewport.contains($0) } ?? false, "\(String(describing: p))")
    checkTrue("carousel in a list: clear of the cards",
              p.map { notInside($0, [R(16, 250, 150, 104), R(182, 250, 150, 104), R(348, 250, 150, 104)]) } ?? false,
              "\(String(describing: p))")
}

// PILOT-622: when the keyboard-first step runs, and for how long.
func checkGate(_ name: String, _ ok: Bool) {
    if ok { print("ok   \(name)") } else { failures += 1; print("FAIL \(name)") }
}
let t0 = Date(timeIntervalSinceReferenceDate: 1_000)
var gate = KeyboardFirstGate()
checkGate("gate starts disarmed", !gate.isArmed)
gate.arm(at: t0)
gate.sawNoKeyboard(at: t0.addingTimeInterval(0.2))
checkGate("no keyboard yet right after arming (still sliding in): stays armed", gate.isArmed)
gate.sawNoKeyboard(at: t0.addingTimeInterval(KeyboardFirstGate.armGrace))
checkGate("no keyboard after the grace: disarmed", !gate.isArmed)
checkGate("plenty of time: the step gets its full length",
          KeyboardFirstGate.stepDeadline(now: t0, readDeadline: t0.addingTimeInterval(35))
              == t0.addingTimeInterval(KeyboardFirstGate.maxStep))
checkGate("an MCP tap (5 s before the daemon gives up) still runs it, leaving the touch its reserve",
          KeyboardFirstGate.stepDeadline(now: t0, readDeadline: t0.addingTimeInterval(4))
              == t0.addingTimeInterval(4 - KeyboardFirstGate.touchReserve))
checkGate("too little time: skipped",
          KeyboardFirstGate.stepDeadline(now: t0, readDeadline: t0.addingTimeInterval(KeyboardFirstGate.minRemaining - 0.1)) == nil)
checkGate("unknown daemon deadline: the full length",
          KeyboardFirstGate.stepDeadline(now: t0, readDeadline: nil) == t0.addingTimeInterval(KeyboardFirstGate.maxStep))
checkGate("the blank tap in the target's scroll view comes first, then beside the field",
          KeyboardDismissPlanner.keyboardFirstStrategies.prefix(2) == [.scrollerBlankTap, .blankTap])
checkGate("hideKeyboard has no target, so no blank tap in its scroll view",
          !KeyboardDismissPlanner.hideKeyboardStrategies.contains(.scrollerBlankTap))
checkGate("no drag: it would scroll the content even when the keyboard stays",
          !KeyboardDismissPlanner.keyboardFirstStrategies.contains(.scrollSwipe))

// PILOT-622: the keyboard-first step before a tap must never press the
// return key — it submits the field, and the tap may be that submit.
if KeyboardDismissPlanner.keyboardFirstStrategies.contains(.returnKey) {
    failures += 1
    print("FAIL keyboard-first strategies include the return key")
} else {
    print("ok   keyboard-first strategies leave out the return key")
}

if failures > 0 {
    print("\(failures) KeyboardDismissPlanner test(s) failed")
    exit(1)
}
print("All KeyboardDismissPlanner tests passed")
