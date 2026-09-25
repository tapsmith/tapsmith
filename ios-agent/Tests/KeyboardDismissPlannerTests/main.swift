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
    checkTrue("stale off-screen keyboard before the real one: region from the real one",
              planner(appHead + rows).keyboardRegion.map { $0.minY < 874 && $0.minY >= 529 } ?? false,
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

if failures > 0 {
    print("\(failures) KeyboardDismissPlanner test(s) failed")
    exit(1)
}
print("All KeyboardDismissPlanner tests passed")
