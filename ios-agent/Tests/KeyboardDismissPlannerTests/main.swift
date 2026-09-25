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
check("no keyboard: no scroll drag", noKeyboard.scrollSwipeStart(), nil)
check("no keyboard: no dismiss key", noKeyboard.dismissKey(), nil)
check("no keyboard: no blank spot", noKeyboard.blankPoint(focusedFrame: occlusionInput), nil)

// MARK: - 1. Scroll view drag

// PILOT-363: the old drag started at the screen centre (201, 437) whatever
// was there — on /occlusion that is "Pass-through action", which the drag
// pressed. Without a scroll view there is no drag at all.
check("no scroll view: no drag", planner(occlusion).scrollSwipeStart(), nil)

do {
    let p = planner(scrollScreen).scrollSwipeStart()
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
    check("scroll view full of controls: no drag", planner(full).scrollSwipeStart(), nil)
    // A web view is not dragged: WKWebView does not dismiss on drag, and the
    // page sees the gesture.
    let web: [Row] = appHead + [(4, .webView, "", "", R(0, 116, 402, 758))] + keyboardWindows()
    check("web view: no drag", planner(web).scrollSwipeStart(), nil)
    for type in [XCUIElement.ElementType.table, .collectionView] {
        let list: [Row] = appHead + [(4, type, "", "", R(0, 116, 402, 758))] + keyboardWindows()
        checkTrue("\(type.rawValue) is dragged", planner(list).scrollSwipeStart() != nil)
    }
}

do {
    // A scroll view left in the tree under a screen that covers it: the
    // point must not be on the covering screen's controls.
    let covered: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 116, 402, 758)),
        (3, .other, "", "", R(0, 116, 402, 758)),
        (4, .button, "Cover", "", R(0, 116, 402, 758)),
    ] + keyboardWindows()
    check("scroll view under another screen's control: no drag", planner(covered).scrollSwipeStart(), nil)
}

do {
    let behindKeyboard: [Row] = appHead + [
        (4, .scrollView, "", "", R(0, 540, 402, 300)),
    ] + keyboardWindows()
    check("scroll view behind the keyboard: no drag", planner(behindKeyboard).scrollSwipeStart(), nil)
}

do {
    // The keyboard window's own scroller does not count.
    let keyboardScroller = appHead + occlusionContent + keyboardWindows(extraKeys: [
        (4, .scrollView, "", "", R(0, 200, 402, 300)),
    ])
    check("keyboard's own scroll view: no drag", planner(keyboardScroller).scrollSwipeStart(), nil)
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
