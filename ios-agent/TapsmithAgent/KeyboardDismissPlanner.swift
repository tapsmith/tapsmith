import XCTest

/// Decides how `hideKeyboard` may put the software keyboard away (PILOT-363),
/// from one `app.snapshot()`.
///
/// XCUITest runs outside the app, so it cannot resign the first responder.
/// All it can do is touch the screen the way a user would, and every touch
/// can land on something. This type finds, for each way of dismissing, a
/// place to touch that does nothing else:
///
/// 1. **Drag a scroll view** (`scrollSwipeStart`). A scroll view dismisses
///    the keyboard when dragged (React Native's ScrollView also dismisses on
///    any touch outside the focused field). Only offered when a native scroll
///    view is actually under the start point, and only from a spot clear of
///    its controls: the old unconditional drag at the screen centre pressed
///    whatever control sat there, because a short fast drag stays inside a
///    Pressable's press area. (A web view is not dragged: WKWebView does not
///    dismiss on drag, and the page would see the gesture.)
/// 2. **The keyboard's own dismiss key** (`dismissKey`) — the iPad keyboard
///    has one; the iPhone keyboard does not.
/// 3. **Tap a blank spot** (`blankPoint`): apps often dismiss on a tap
///    outside the field. Only where every element under the point is a plain
///    unlabeled container — no control, text, image, bar, or input — and in
///    the nearest container of the focused field that has room, so the tap
///    stays beside the field (inside a sheet, not on its backdrop).
/// 4. **The return key** (`returnKey`), last because it also submits the
///    field. Only for a single-line field (in a text view it types a new line)
///    and only when the key reads "return" or "done": "go", "send", "search",
///    "next"… name an app action.
///
/// If none of them dismisses the keyboard, `hideKeyboard` fails with
/// `failureMessage` instead of reporting success.
struct KeyboardDismissPlanner {
    typealias Node = OcclusionAnalyzer.Node

    /// A way of dismissing the keyboard, in the order they are tried.
    enum Strategy: CaseIterable {
        case scrollSwipe, dismissKey, blankTap, returnKey

        var summary: String {
            switch self {
            case .scrollSwipe: return "dragging a scroll view"
            case .dismissKey: return "the keyboard's dismiss key"
            case .blankTap: return "tapping a blank spot"
            case .returnKey: return "the return key"
            }
        }
    }

    /// What happened to a strategy: it ran and the keyboard stayed, or it was
    /// not possible on this screen (the reason says why).
    enum Outcome: Equatable {
        case keyboardStayed
        case notPossible(String)
    }

    /// Whether and where the return key may be pressed.
    enum ReturnKeyPlan: Equatable {
        case press(CGPoint)
        case notPossible(String)
    }

    /// Clearance (points) a touch point keeps from anything it must not hit.
    static let touchClearance: CGFloat = 8
    /// Spacing (points) of the candidate touch points.
    static let gridStep: CGFloat = 8
    /// Screen strip at the top left alone: the status bar is not in the app's
    /// snapshot, and a tap on it scrolls the screen's scroll view to the top.
    static let statusBarAllowance: CGFloat = 60
    /// How far the dismiss drag moves, as a fraction of the screen.
    static let swipeFraction: CGFloat = 0.03
    /// Smallest visible scroll view worth dragging.
    static let minScrollExtent: CGFloat = 44
    /// A labeled `.other` this large (a fraction of the screen) is a screen
    /// container with a testID, not a control.
    static let containerAreaFraction: CGFloat = 0.5
    /// A container covering this much of the screen is a window or modal
    /// root, where a sheet's backdrop lives: never part of a field's scope.
    static let fullScreenFraction: CGFloat = 0.95
    /// A container covering this much of the screen roots the field's own
    /// screen for the drag: a navigation screen's content (about 87% of an
    /// iPhone below its bar) or a page sheet (about 93%), never the window
    /// holding the screen a sheet was presented over.
    static let screenRootFraction: CGFloat = 0.85

    /// Return-key labels whose press only ends editing (plus the submit
    /// every return fires). Everything else is an app action.
    static let dismissingReturnLabels: Set<String> = ["return", "done"]
    /// The same keys by identifier. Identifiers are the key type's English
    /// name ("Return", "Go"; measured on iOS 26) while labels are localized,
    /// so the identifier decides whenever the key has one.
    static let dismissingReturnIdentifiers: Set<String> = ["Return", "Done"]
    /// Every label UIKit gives the return key (`UIReturnKeyType`), in English.
    static let returnKeyLabels: Set<String> = dismissingReturnLabels.union([
        "go", "google", "join", "next", "route", "search", "send", "yahoo", "emergency call", "continue",
    ])
    static let returnKeyIdentifiers: Set<String> = dismissingReturnIdentifiers.union([
        "Go", "Google", "Join", "Next", "Route", "Search", "Send", "Yahoo", "Emergency Call", "Continue",
    ])
    /// Scroll views the dismiss drag may use.
    static let draggableScrollerTypes: Set<XCUIElement.ElementType> = [.scrollView, .table, .collectionView]
    /// Single-line inputs: return ends editing instead of typing a new line.
    static let singleLineInputTypes: Set<XCUIElement.ElementType> = [.textField, .secureTextField, .searchField]
    static let textInputTypes: Set<XCUIElement.ElementType> = singleLineInputTypes.union([.textView])

    let analyzer: OcclusionAnalyzer
    var nodes: [Node] { analyzer.nodes }
    var screen: CGRect { analyzer.screen }

    init(analyzer: OcclusionAnalyzer) {
        self.analyzer = analyzer
    }

    init(snapshot: XCUIElementSnapshot, screenSize: CGSize) {
        self.init(analyzer: OcclusionAnalyzer(snapshot: snapshot, screenSize: screenSize))
    }

    // MARK: - Keyboard

    private var keyboardWindows: Set<Int> { analyzer.keyboardWindows() }

    /// The screen area the keyboard covers, or nil when no keyboard is on
    /// screen (none in the tree, or one that is zero-sized or off screen).
    var keyboardRegion: CGRect? {
        if let region = analyzer.keyboardRegion(keyboardWindows: keyboardWindows) {
            let onScreen = region.intersection(screen)
            if !onScreen.isNull, onScreen.width > 0, onScreen.height > 0 { return onScreen }
        }
        // The analyzer reads the first sized keyboard element; a stale one
        // left off screen (a keyboard-type switch) can come before the real
        // one. Any keyboard element on screen still covers its own frame.
        for node in nodes where node.elementType == .keyboard {
            let onScreen = node.frame.intersection(screen)
            if !onScreen.isNull, onScreen.width > 0, onScreen.height > 0 {
                return CGRect(x: screen.minX, y: onScreen.minY, width: screen.width, height: screen.maxY - onScreen.minY)
            }
        }
        return nil
    }

    /// The part of the screen an app touch may use: below the status bar and
    /// above the keyboard. Null when no keyboard is up.
    private var touchableArea: CGRect {
        guard let keyboard = keyboardRegion else { return .null }
        let top = screen.minY + Self.statusBarAllowance
        let bottom = min(keyboard.minY, screen.maxY)
        guard bottom > top else { return .null }
        return CGRect(x: screen.minX, y: top, width: screen.width, height: bottom - top)
    }

    /// Indices of the keyboard's own nodes (keys, bars): in a keyboard window
    /// or inside a `.keyboard` subtree.
    private func keyboardNodeIndices() -> [Int] {
        let windows = keyboardWindows
        return nodes.indices.filter { i in
            if let w = nodes[i].window, windows.contains(w) { return true }
            return analyzer.ancestors(of: i).contains { nodes[$0].elementType == .keyboard }
        }
    }

    /// Indices of the nodes inside the `.keyboard` element itself — the keys,
    /// without the accessory bars and input views around it in its window.
    private func keyIndices() -> [Int] {
        nodes.indices.filter { i in analyzer.ancestors(of: i).contains { nodes[$0].elementType == .keyboard } }
    }

    // MARK: - The focused field's scope

    /// The focused field's node, matched by the live focus query's frame.
    private func fieldIndex(_ focusedFrame: CGRect?) -> Int? {
        guard let focusedFrame else { return nil }
        return nodes.indices.last(where: {
            Self.textInputTypes.contains(nodes[$0].elementType)
                && OcclusionAnalyzer.framesMatch(nodes[$0].frame, focusedFrame, tolerance: 1.5)
        })
    }

    /// The field's ancestors, nearest first, up to (not including) the first
    /// that covers nearly the whole screen: the containers a touch meant for
    /// the field's own screen or sheet may use. Past them is a window or modal
    /// root, holding whatever surrounds the field (a sheet's backdrop, the
    /// screen behind a sheet).
    private func scopeAncestors(of field: Int) -> [Int] {
        var result: [Int] = []
        for a in analyzer.ancestors(of: field) {
            let f = nodes[a].frame.intersection(screen)
            if nodes[a].elementType == .window || nodes[a].elementType == .application { break }
            if !f.isNull, f.width * f.height >= screen.width * screen.height * Self.fullScreenFraction { break }
            result.append(a)
        }
        return result
    }

    /// The field's nearest ancestor covering nearly the whole screen: the
    /// root of its screen or of the modal or sheet it is in. Content beside
    /// the field (a list under a search bar) is inside it; the screen behind
    /// a sheet, in another branch of the tree, is not.
    private func screenRoot(of field: Int) -> Int? {
        analyzer.ancestors(of: field).first { a in
            let f = nodes[a].frame.intersection(screen)
            return !f.isNull && f.width * f.height >= screen.width * screen.height * Self.screenRootFraction
        }
    }

    private func isKeyLike(_ node: Node) -> Bool {
        (node.elementType == .button || node.elementType == .key)
            && node.frame.width > 0 && node.frame.height > 0
    }

    // MARK: - 1. Scroll view drag

    /// Where to start the dismiss drag, or nil when no native scroll view is
    /// on screen above the keyboard with a spot clear of its controls. The
    /// drag goes up (then, if that did not work, left) by `swipeFraction` of
    /// the screen from this point, so the point leaves room for it inside the
    /// scroll view. Only a scroll view in the focused field's (`focusedFrame`)
    /// own screen or sheet (`screenRoot`) counts — not the screen behind a
    /// sheet — so without a known focused field there is no drag. Scroll
    /// views are tried largest first.
    func scrollSwipeStart(focusedFrame: CGRect?) -> CGPoint? {
        let area = touchableArea
        guard !area.isNull else { return nil }
        let windows = keyboardWindows
        let dragY = screen.height * Self.swipeFraction
        let dragX = screen.width * Self.swipeFraction
        // Without the focused field there is no telling which screen is the
        // field's: a scroll view left behind a sheet's backdrop looks like any
        // other. A field in a keyboard window (an input accessory composer)
        // has no screen of its own there: any scroll view of the app may be
        // dragged.
        guard let field = fieldIndex(focusedFrame) else { return nil }
        let fieldInKeyboard = nodes[field].window.map { windows.contains($0) } ?? false
        let root = fieldInKeyboard ? nil : screenRoot(of: field)
        // A scroll view holding the field always counts (the root can be its
        // same-sized content container); otherwise it must be inside the root,
        // which itself counts (a headerless screen's root scroll view).
        let fieldAncestors = Set(analyzer.ancestors(of: field))
        func inFieldsScreen(_ i: Int) -> Bool {
            if fieldAncestors.contains(i) { return true }
            guard let root else { return true }
            return i >= root && i < nodes[root].subtreeEnd
        }

        // Scroll views left visible above the keyboard, largest first.
        var candidates: [(index: Int, visible: CGRect)] = []
        for (i, node) in nodes.enumerated() where Self.draggableScrollerTypes.contains(node.elementType) {
            if let w = node.window, windows.contains(w) { continue }
            if !inFieldsScreen(i) { continue }
            let visible = node.frame.intersection(area)
            guard !visible.isNull,
                  visible.width >= Self.minScrollExtent,
                  visible.height >= Self.minScrollExtent else { continue }
            candidates.append((i, visible))
        }
        candidates.sort { $0.visible.width * $0.visible.height > $1.visible.width * $1.visible.height }
        for (scroll, visible) in candidates {
            if let point = dragStart(in: scroll, visible: visible, dragX: dragX, dragY: dragY) { return point }
        }
        return nil
    }

    /// A clear start point for the drag in scroll view `scroll`, or nil.
    private func dragStart(in scroll: Int, visible: CGRect, dragX: CGFloat, dragY: CGFloat) -> CGPoint? {
        let windows = keyboardWindows
        // Room for the drag: it ends dragY above and dragX left of the start.
        let starts = CGRect(
            x: visible.minX + dragX, y: visible.minY + dragY,
            width: visible.width - dragX, height: visible.height - dragY
        )
        guard starts.width > 0, starts.height > 0 else { return nil }

        // Under the point: the scroll view, its ancestors, and plain
        // containers — no control, text, image or web view of its content, and
        // nothing drawn over it from elsewhere (a screen whose own content
        // covers a scroll view left in the tree). A drag that does not start a
        // scroll (sideways in a vertical list, any drag in a carousel) presses
        // what it starts on, and a role-less Pressable is a labeled `.other`.
        // Its plain ancestors and enclosing scroll views are transparent; a
        // cell or labeled Pressable around it takes a drag that does not
        // scroll this one (a vertical drag on a horizontal carousel) as a press.
        let ancestors = Set(analyzer.ancestors(of: scroll).filter {
            isPlain($0) || Self.draggableScrollerTypes.contains(nodes[$0].elementType)
        })
        return clearestPoint(in: starts) { i in
            if i == scroll || ancestors.contains(i) { return false }
            if let w = nodes[i].window, windows.contains(w) { return false }
            return !isPlain(i)
        }
    }

    // MARK: - 2. Dismiss key

    /// The keyboard's own dismiss key (iPad: "Hide keyboard"), or nil.
    func dismissKey() -> CGPoint? {
        for i in keyboardNodeIndices() where isKeyLike(nodes[i]) {
            let names = [nodes[i].label, nodes[i].identifier].map { $0.lowercased() }
            let isDismiss = names.contains { name in
                name.contains("keyboard") && (name.contains("hide") || name.contains("dismiss"))
            }
            if isDismiss { return CGPoint(x: nodes[i].frame.midX, y: nodes[i].frame.midY) }
        }
        return nil
    }

    // MARK: - 3. Blank spot

    /// A point above the keyboard and below the status bar where every
    /// element is a plain unlabeled container, beside the focused field (at
    /// `focusedFrame`): inside its nearest ancestor that has such a spot, the
    /// spot furthest from anything else there. Staying in the field's own
    /// container keeps the tap off what surrounds it — a sheet's backdrop,
    /// which closes the sheet. nil when there is none, or when the focused
    /// field is not known or not in the tree.
    func blankPoint(focusedFrame: CGRect?) -> CGPoint? {
        let area = touchableArea
        guard !area.isNull, let field = fieldIndex(focusedFrame) else { return nil }
        let windows = keyboardWindows
        // The field's own containers (a scroll view it is in, a tap-to-dismiss
        // wrapper) are where the tap is meant to land, not in its way.
        // Only plain ones and scroll views: a cell or labeled row wrapping
        // the field would take the tap as a press.
        let fieldAncestors = Set(analyzer.ancestors(of: field).filter {
            isPlain($0) || Self.draggableScrollerTypes.contains(nodes[$0].elementType)
        })
        // Never a container covering the whole screen: that is where a sheet's
        // backdrop lives (a headerless screen's root looks the same, so such a
        // screen gets no blank tap).
        for container in scopeAncestors(of: field) {
            let rect = nodes[container].frame.intersection(area)
            if rect.isNull { continue }
            let point = clearestPoint(in: rect) { i in
                if fieldAncestors.contains(i) { return false }
                if let w = nodes[i].window, windows.contains(w) { return false }
                return !isPlain(i)
            }
            if let point { return point }
        }
        return nil
    }

    // MARK: - 4. Return key

    /// Whether the return key may be pressed to end editing, given the type of
    /// the input that has keyboard focus (nil when none could be found).
    func returnKey(focusedInput: XCUIElement.ElementType?) -> ReturnKeyPlan {
        guard let focused = focusedInput, Self.textInputTypes.contains(focused) else {
            return .notPossible("no focused text field was found")
        }
        guard Self.singleLineInputTypes.contains(focused) else {
            return .notPossible("the focused field is multi-line, where return types a new line")
        }
        // The keys inside the keyboard element only: an accessory bar's "Done"
        // button would not be the key that "\n" presses.
        let keys = keyIndices().filter { isKeyLike(nodes[$0]) }
        guard let key = keys.first(where: { Self.returnKeyIdentifiers.contains(nodes[$0].identifier) })
            ?? keys.first(where: {
                nodes[$0].identifier.isEmpty && Self.returnKeyLabels.contains(nodes[$0].label.lowercased())
            })
        else {
            return .notPossible("the keyboard has no return key")
        }
        let node = nodes[key]
        let label = node.label.lowercased()
        // An English action label vetoes the key whatever its identifier; a
        // label outside the English set (localized) leaves it to the identifier.
        let actionLabel = Self.returnKeyLabels.contains(label) && !Self.dismissingReturnLabels.contains(label)
        let dismisses = node.identifier.isEmpty
            ? Self.dismissingReturnLabels.contains(label)
            : Self.dismissingReturnIdentifiers.contains(node.identifier) && !actionLabel
        guard dismisses else {
            return .notPossible("the return key is \"\(node.label)\", an app action")
        }
        return .press(CGPoint(x: nodes[key].frame.midX, y: nodes[key].frame.midY))
    }

    // MARK: - Failure

    /// The error for a keyboard still up after every strategy.
    static func failureMessage(_ attempts: [(Strategy, Outcome)]) -> String {
        let tried = attempts.map { strategy, outcome -> String in
            switch outcome {
            case .keyboardStayed: return "\(strategy.summary) did not dismiss it"
            case .notPossible(let why): return "\(strategy.summary) was not possible (\(why))"
            }
        }
        return "The keyboard is still shown: " + tried.joined(separator: "; ")
            + ". Dismiss it the way this screen allows: tap its own Done or close control,"
            + " or call device.pressKey(\"enter\") if submitting the field is fine."
    }

    // MARK: - Helpers

    /// A node a touch may land on without doing anything: the application,
    /// a window, or an unlabeled container. A testID alone makes a container
    /// suspect (an icon-only Pressable looks like that) unless it is
    /// screen-sized. The test-hooks marker takes no touches.
    private func isPlain(_ i: Int) -> Bool {
        let node = nodes[i]
        if analyzer.isTapsmithHooksMarker(node) { return true }
        switch node.elementType {
        case .application, .window:
            return true
        case .other:
            guard node.label.isEmpty else { return false }
            if node.identifier.isEmpty { return true }
            let area = node.frame.intersection(screen)
            guard !area.isNull else { return true }
            return area.width * area.height >= screen.width * screen.height * Self.containerAreaFraction
        default:
            return false
        }
    }

    /// The grid point in `rect` furthest from every blocking node's frame and
    /// from `rect`'s edges, if that is at least `touchClearance`. Only nodes
    /// that overlap `rect` count.
    private func clearestPoint(in rect: CGRect, blockers: (Int) -> Bool) -> CGPoint? {
        guard !rect.isNull, rect.width >= 2 * Self.touchClearance, rect.height >= 2 * Self.touchClearance else {
            return nil
        }
        let blocked = nodes.indices.compactMap { i -> CGRect? in
            let f = nodes[i].frame
            guard f.width > 0, f.height > 0, f.intersects(rect.insetBy(dx: -Self.touchClearance, dy: -Self.touchClearance)),
                  blockers(i) else { return nil }
            return f
        }
        var best: (point: CGPoint, clearance: CGFloat)?
        var y = rect.minY + Self.touchClearance
        while y <= rect.maxY - Self.touchClearance {
            var x = rect.minX + Self.touchClearance
            while x <= rect.maxX - Self.touchClearance {
                let p = CGPoint(x: x, y: y)
                var clearance = min(x - rect.minX, rect.maxX - x, y - rect.minY, rect.maxY - y)
                for f in blocked {
                    clearance = min(clearance, Self.distance(from: p, to: f))
                    if clearance < Self.touchClearance { break }
                }
                if clearance >= Self.touchClearance, clearance > (best?.clearance ?? -1) {
                    best = (p, clearance)
                }
                x += Self.gridStep
            }
            y += Self.gridStep
        }
        return best?.point
    }

    /// Distance from `p` to the nearest point of `r` (0 inside it).
    static func distance(from p: CGPoint, to r: CGRect) -> CGFloat {
        let dx = max(r.minX - p.x, 0, p.x - r.maxX)
        let dy = max(r.minY - p.y, 0, p.y - r.maxY)
        return (dx * dx + dy * dy).squareRoot()
    }
}
