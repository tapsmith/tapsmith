import XCTest

/// When a touch's keyboard-first step (PILOT-622) is worth an app snapshot,
/// and how long it may take.
///
/// Armed by the commands that focus a text input, so a tap pays for a
/// snapshot only after typing. Disarmed once a check finds no keyboard —
/// unless it was armed a moment ago, when the keyboard may still be sliding
/// in (a tap on a field, then straight away a tap on a button).
struct KeyboardFirstGate {
    /// How long after arming a check that finds no keyboard does not disarm.
    static let armGrace: TimeInterval = 1.5
    /// Longest the step may take, so a screen whose keyboard does not go
    /// costs little and still leaves the touch its time.
    static let maxStep: TimeInterval = 2.5
    /// Time kept back for the touch after the step.
    static let touchReserve: TimeInterval = 2
    /// Below this much time before the daemon gives up, the step is skipped.
    static let minRemaining: TimeInterval = 3

    private(set) var armedAt: Date?
    var isArmed: Bool { armedAt != nil }

    mutating func arm(at now: Date = Date()) { armedAt = now }
    mutating func disarm() { armedAt = nil }

    /// A check found no keyboard on screen.
    mutating func sawNoKeyboard(at now: Date = Date()) {
        guard let armed = armedAt, now.timeIntervalSince(armed) >= Self.armGrace else { return }
        armedAt = nil
    }

    /// When the step must be over, or nil when there is no time for it.
    /// `readDeadline` is when the daemon stops waiting (nil: unknown).
    static func stepDeadline(now: Date, readDeadline: Date?) -> Date? {
        guard let readDeadline else { return now.addingTimeInterval(maxStep) }
        let available = readDeadline.timeIntervalSince(now)
        guard available >= minRemaining else { return nil }
        return now.addingTimeInterval(min(maxStep, available - touchReserve))
    }
}

/// Tells a keyboard parked off screen from one still sliding in (PILOT-792).
///
/// With a hardware keyboard attached, iOS leaves the software keyboard in the
/// tree below the screen for as long as a field has focus. A keyboard that is
/// sliding in is off screen only for a moment. Fed one read at a time, this
/// calls the keyboard parked once its frames have stayed the same for
/// `parkedReads` reads in a row, so a wait for it to arrive can stop early.
struct ParkedKeyboardWatch {
    /// Identical off-screen reads in a row that make a keyboard parked.
    static let parkedReads = 4

    private var lastFrames: [CGRect]?
    private var sameReads = 0

    /// Record the keyboard elements' frames from one read that found the
    /// keyboard off screen; true once it counts as parked.
    mutating func isParked(after frames: [CGRect]) -> Bool {
        sameReads = frames == lastFrames ? sameReads + 1 : 1
        lastFrames = frames
        return sameReads >= Self.parkedReads
    }
}

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
///    any touch outside the focused field). Only the native scroll view the
///    focused field is in, and only from a spot clear of its controls: the old unconditional drag at the screen centre pressed
///    whatever control sat there, because a short fast drag stays inside a
///    Pressable's press area. (A web view is not dragged: WKWebView does not
///    dismiss on drag, and the page would see the gesture.)
/// 2. **The keyboard's own dismiss key** (`dismissKey`) — the iPad keyboard
///    has one; the iPhone keyboard does not.
/// 3. **Tap a blank spot** (`blankPoint`): apps often dismiss on a tap
///    outside the field. Only where every element under the point is a plain
///    unlabeled container or a background image — no control, text, smaller
///    image, bar, or input — and in the nearest container of the focused
///    field that has room, so the tap stays beside the field (inside a
///    sheet, not on its backdrop).
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
    enum Strategy {
        case scrollSwipe, dismissKey, blankTap, scrollerBlankTap, returnKey

        var summary: String {
            switch self {
            case .scrollSwipe: return "dragging a scroll view"
            case .dismissKey: return "the keyboard's dismiss key"
            case .blankTap: return "tapping a blank spot"
            case .scrollerBlankTap: return "tapping a blank spot in the target's scroll view"
            case .returnKey: return "the return key"
            }
        }
    }

    /// Strategies `hideKeyboard` uses, in order. Not the blank tap in a
    /// target's scroll view: hideKeyboard has no target.
    static let hideKeyboardStrategies: [Strategy] = [.scrollSwipe, .dismissKey, .blankTap, .returnKey]

    /// Strategies a touch's keyboard-first step may use (PILOT-622), in
    /// order. A blank tap: it is what the user's own first tap would have
    /// done on a React Native ScrollView — first in the scroll view the
    /// target is in, the one that would eat the touch (PILOT-1432: a search
    /// field above a list sits in a plain view, where a tap beside the field
    /// leaves the keyboard up), then beside the field. Never the drag, which scrolls the
    /// content even when the keyboard stays (then the touch would no longer
    /// go ahead as before), and never the return key, which submits the
    /// field — the touch about to be made may be that submit.
    static let keyboardFirstStrategies: [Strategy] = [.scrollerBlankTap, .blankTap, .dismissKey]

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
    /// Kept even when `statusBar` says where the bar is, for a screen whose
    /// bar is hidden and for the top edge's own system gestures.
    static let statusBarAllowance: CGFloat = 60
    /// How far the dismiss drag moves, as a fraction of the screen.
    static let swipeFraction: CGFloat = 0.03
    /// Smallest visible scroll view worth dragging.
    static let minScrollExtent: CGFloat = 44
    /// A testID'd `.other` this large (a fraction of the screen) is a screen
    /// container, not a control; an image this large is a background
    /// (PILOT-1177), not an icon.
    static let containerAreaFraction: CGFloat = 0.5
    /// A container covering this much of the screen is a window or modal
    /// root, where a sheet's backdrop lives: never part of a field's scope.
    static let fullScreenFraction: CGFloat = 0.95

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
    /// Where the system status bar is on the screen (`statusBarRegion`), or
    /// nil when not known. Touches keep off it: a touch there opens Control
    /// Center. It is not always the top strip — the iPhone Duo simulator
    /// shows it as a column at the right edge (PILOT-1262).
    let statusBar: CGRect?
    var nodes: [Node] { analyzer.nodes }
    var screen: CGRect { analyzer.screen }

    init(analyzer: OcclusionAnalyzer, statusBar: CGRect? = nil) {
        self.analyzer = analyzer
        self.statusBar = statusBar
    }

    init(
        snapshot: XCUIElementSnapshot, screenSize: CGSize, device: @autoclosure () -> HidTouch.DeviceTurn, statusBar: CGRect? = nil
    ) {
        self.init(analyzer: OcclusionAnalyzer(snapshot: snapshot, screenSize: screenSize, device: device()), statusBar: statusBar)
    }

    // MARK: - The system status bar

    /// Where SpringBoard draws the status bar, in the app's screen space, from
    /// a SpringBoard snapshot read into `springboard` with the app's screen:
    /// the on-screen union of what is in its `.statusBar` elements, leaving
    /// out any element covering half the screen or more (the iPhone Duo's
    /// status bar element is the size of the screen; its items are a column
    /// at the right edge). nil when there is none, or when SpringBoard is laid
    /// out in another space than the app (it stays portrait under a landscape
    /// app), where its frames would point at the wrong place. Status bars in a
    /// window of another size belong to another display (the Duo has two).
    static func statusBarRegion(springboard: OcclusionAnalyzer) -> CGRect? {
        let screen = springboard.screen
        let nodes = springboard.nodes
        func sameSize(_ frame: CGRect) -> Bool {
            abs(frame.width - screen.width) <= 1 && abs(frame.height - screen.height) <= 1
        }
        if let root = nodes.first, root.elementType == .application, !sameSize(root.frame) { return nil }
        var region: CGRect?
        for bar in nodes.indices where nodes[bar].elementType == .statusBar {
            if let w = nodes[bar].window, !sameSize(nodes[w].frame) { continue }
            for i in bar..<nodes[bar].subtreeEnd {
                let onScreen = nodes[i].frame.intersection(screen)
                guard !onScreen.isNull, onScreen.width > 0, onScreen.height > 0,
                      onScreen.width * onScreen.height < screen.width * screen.height * Self.containerAreaFraction
                else { continue }
                region = region.map { $0.union(onScreen) } ?? onScreen
            }
        }
        return region
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
        // one. The real one covers its own frame plus, like the analyzer's
        // region, whatever of its windows sits on top of it (the input view
        // and bars above the keys).
        let windows = keyboardWindows
        for node in nodes where node.elementType == .keyboard {
            let keys = node.frame.intersection(screen)
            guard !keys.isNull, keys.width > 0, keys.height > 0 else { continue }
            var top = keys.minY
            for other in nodes {
                guard let w = other.window, windows.contains(w) else { continue }
                let f = other.frame
                guard f.width > 0, f.height > 0,
                      f.minY >= screen.minY, f.maxY <= screen.maxY + 1,
                      f.height <= screen.height * 0.75,
                      f.maxX > keys.minX, f.minX < keys.maxX,
                      f.maxY >= keys.minY else { continue }
                top = min(top, f.minY)
            }
            return CGRect(x: screen.minX, y: top, width: screen.width, height: screen.maxY - top)
        }
        return nil
    }

    /// The frames of every keyboard element, in tree order.
    var keyboardFrames: [CGRect] {
        nodes.filter { $0.elementType == .keyboard }.map(\.frame)
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
            // What is drawn of it: a scrolled content container reports its
            // full frame, which can cover the screen though it is inside an
            // 87% scroll view.
            let f = clippedToScrollers(nodes[a].frame.intersection(screen), around: a)
            if nodes[a].elementType == .window || nodes[a].elementType == .application { break }
            if !f.isNull, f.width * f.height >= screen.width * screen.height * Self.fullScreenFraction { break }
            result.append(a)
        }
        return result
    }

    /// A button or key on screen: a stale keyboard left off screen (a
    /// keyboard-type switch) keeps its keys in the tree, and they are not the
    /// keys "\n" or a tap would reach.
    private func isKeyLike(_ node: Node) -> Bool {
        guard node.elementType == .button || node.elementType == .key else { return false }
        let onScreen = node.frame.intersection(screen)
        return !onScreen.isNull && onScreen.width > 0 && onScreen.height > 0
    }

    /// `rect` clipped to the viewports of every scroll view around node `i`:
    /// a scrolled content container reports its full, unclipped frame, and
    /// the part scrolled past its scroll view is not drawn there (a sheet's
    /// backdrop may be).
    private func clippedToScrollers(_ rect: CGRect, around i: Int) -> CGRect {
        var rect = rect
        for a in analyzer.ancestors(of: i) where OcclusionAnalyzer.scrollerTypes.contains(nodes[a].elementType) {
            rect = rect.intersection(nodes[a].frame)
            if rect.isNull { return .null }
        }
        return rect
    }

    // MARK: - 1. Scroll view drag

    /// Where to start the dismiss drag, or nil. Only a native scroll view
    /// that holds the focused field (`focusedFrame`) is dragged — the one a
    /// user would drag to put that field's keyboard away. Any other scroll
    /// view may belong to a different screen (the one behind a sheet), so
    /// without a known focused field there is no drag, and a field beside a
    /// list rather than in it gets none either: the loop moves on to the
    /// other strategies, and fails loudly if none works. The drag goes up
    /// (then, if that did not work, left) by `swipeFraction` of the screen
    /// from this point, so the point leaves room for it inside the scroll
    /// view, above the keyboard, clear of its controls. The field's scroll
    /// views are tried nearest first.
    func scrollSwipeStart(focusedFrame: CGRect?) -> CGPoint? {
        let area = touchableArea
        guard !area.isNull, let field = fieldIndex(focusedFrame) else { return nil }
        let windows = keyboardWindows
        let dragY = screen.height * Self.swipeFraction
        let dragX = screen.width * Self.swipeFraction
        for scroll in analyzer.ancestors(of: field)
        where Self.draggableScrollerTypes.contains(nodes[scroll].elementType) {
            if let w = nodes[scroll].window, windows.contains(w) { continue }
            let visible = clippedToScrollers(nodes[scroll].frame.intersection(area), around: scroll)
            guard !visible.isNull,
                  visible.width >= Self.minScrollExtent,
                  visible.height >= Self.minScrollExtent else { continue }
            if let point = dragStart(in: scroll, visible: visible, dragX: dragX, dragY: dragY) { return point }
        }
        return nil
    }

    /// A clear start point for the drag in scroll view `scroll`, or nil.
    private func dragStart(in scroll: Int, visible: CGRect, dragX: CGFloat, dragY: CGFloat) -> CGPoint? {
        // Room for the drag: it ends dragY above and dragX left of the start.
        let starts = CGRect(
            x: visible.minX + dragX, y: visible.minY + dragY,
            width: visible.width - dragX, height: visible.height - dragY
        )
        guard starts.width > 0, starts.height > 0 else { return nil }

        // Under the point: the scroll view, its ancestors, and plain
        // containers — no control, text, image (but a background) or web view
        // of its content, and nothing drawn over it from elsewhere (a screen
        // whose own content covers a scroll view left in the tree). A drag that does not start a
        // scroll (sideways in a vertical list, any drag in a carousel) presses
        // what it starts on, and a role-less Pressable is a labeled `.other`.
        // Its plain ancestors and enclosing scroll views are transparent; a
        // cell or labeled Pressable around it takes a drag that does not
        // scroll this one (a vertical drag on a horizontal carousel) as a press.
        let ancestors = Set(analyzer.ancestors(of: scroll).filter {
            isPlain($0) || Self.draggableScrollerTypes.contains(nodes[$0].elementType)
        })
        // The drag sweeps up and left of its start: keep that whole sweep off
        // the status bar, wherever it is (a tap or drag there opens Control
        // Center or Notification Center).
        let keepOut = statusBar.map {
            [CGRect(x: $0.minX, y: $0.minY, width: $0.width + dragX, height: $0.height + dragY)]
        } ?? []
        return clearestPoint(in: starts, avoiding: keepOut) { i in
            if i == scroll || ancestors.contains(i) { return false }
            // Keyboard-window nodes block like any other: an accessory bar's
            // button or the predictive bar is not a blank spot.
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
            let rect = clippedToScrollers(nodes[container].frame.intersection(area), around: field)
            if rect.isNull { continue }
            let point = clearestPoint(in: rect, avoiding: statusBar.map { [$0] } ?? []) { i in
                if fieldAncestors.contains(i) { return false }
                return !isPlain(i)
            }
            if let point { return point }
        }
        return nil
    }

    /// A blank spot inside the scroll view `target` is in (keyboard first,
    /// PILOT-1432): above the keyboard and below the status bar, clear of
    /// everything but plain containers and the scroll views around it, the
    /// spot furthest from anything else. That scroll view is the one a
    /// React Native ScrollView with `keyboardShouldPersistTaps` "never" or
    /// "handled" puts the keyboard away for on a touch no child takes — the
    /// touch it would otherwise spend the target's tap on. The innermost
    /// such scroll view is tried first, then the ones around it. nil when
    /// the target is not found in the tree, is in no scroll view, or no
    /// scroll view of it has such a spot on screen.
    func blankPointInScroller(of target: OcclusionAnalyzer.Target) -> CGPoint? {
        let area = touchableArea
        guard !area.isNull, let t = analyzer.locate(target) else { return nil }
        let up = analyzer.ancestors(of: t)
        for scroller in up where OcclusionAnalyzer.keyboardEatingScrollerTypes.contains(nodes[scroller].elementType) {
            let rect = clippedToScrollers(nodes[scroller].frame.intersection(area), around: scroller)
            if rect.isNull { continue }
            // The scroll view and what holds it are where the touch lands:
            // plain containers and enclosing scroll views do not take it.
            let transparent = Set([scroller] + analyzer.ancestors(of: scroller).filter {
                isPlain($0) || OcclusionAnalyzer.scrollerTypes.contains(nodes[$0].elementType)
            })
            let point = clearestPoint(in: rect, avoiding: statusBar.map { [$0] } ?? []) { i in
                if transparent.contains(i) { return false }
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
        guard let key = keys.first(where: { Self.returnKeyIdentifiers.contains(Self.keyIdentifier(nodes[$0])) })
            ?? keys.first(where: {
                nodes[$0].identifier.isEmpty && Self.returnKeyLabels.contains(nodes[$0].label.lowercased())
            })
        else {
            return .notPossible("the keyboard has no return key")
        }
        let node = nodes[key]
        let identifier = Self.keyIdentifier(node)
        let label = node.label.lowercased()
        // An English action label vetoes the key whatever its identifier; a
        // label outside the English set (localized) leaves it to the identifier.
        let actionLabel = Self.returnKeyLabels.contains(label) && !Self.dismissingReturnLabels.contains(label)
        let dismisses = identifier.isEmpty
            ? Self.dismissingReturnLabels.contains(label)
            : Self.dismissingReturnIdentifiers.contains(identifier) && !actionLabel
        guard dismisses else {
            return .notPossible("the return key is \"\(node.label)\", an app action")
        }
        return .press(CGPoint(x: nodes[key].frame.midX, y: nodes[key].frame.midY))
    }

    /// A key's identifier without the trailing colon iOS 26.4 gives some
    /// return keys ("Next:"), which does not change the key.
    private static func keyIdentifier(_ node: Node) -> String {
        node.identifier.hasSuffix(":") ? String(node.identifier.dropLast()) : node.identifier
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
    /// a window, an unlabeled container, or a background image. A testID
    /// alone makes a container suspect (an icon-only Pressable looks like
    /// that) unless it is screen-sized. An image is an icon or picture that
    /// may take a tap unless it covers at least half the screen: then it is
    /// the screen's background (React Native's ImageBackground, PILOT-1177),
    /// labeled or not (SwiftUI labels an asset image with its name). A
    /// tappable image is wrapped in a button or labeled view, which still
    /// blocks. The test-hooks marker takes no touches, and neither does
    /// iOS 27's container-sized toolbar host (its items still block).
    private func isPlain(_ i: Int) -> Bool {
        let node = nodes[i]
        if analyzer.isTapsmithHooksMarker(node) || analyzer.isBarHost(i) { return true }
        switch node.elementType {
        case .application, .window:
            return true
        case .other:
            guard node.label.isEmpty else { return false }
            if node.identifier.isEmpty { return true }
            return coversContainerArea(node)
        case .image:
            return coversContainerArea(node)
        default:
            return false
        }
    }

    /// Whether `node` covers at least `containerAreaFraction` of the screen
    /// (or none of it).
    private func coversContainerArea(_ node: Node) -> Bool {
        let area = node.frame.intersection(screen)
        guard !area.isNull else { return true }
        return area.width * area.height >= screen.width * screen.height * Self.containerAreaFraction
    }

    /// The grid point in `rect` furthest from every blocking node's frame, from
    /// every `keepOut` area and from `rect`'s edges, if that is at least
    /// `touchClearance`. Only nodes that overlap `rect` count.
    private func clearestPoint(in rect: CGRect, avoiding keepOut: [CGRect] = [], blockers: (Int) -> Bool) -> CGPoint? {
        guard !rect.isNull, rect.width >= 2 * Self.touchClearance, rect.height >= 2 * Self.touchClearance else {
            return nil
        }
        let reach = rect.insetBy(dx: -Self.touchClearance, dy: -Self.touchClearance)
        let blocked = nodes.indices.compactMap { i -> CGRect? in
            let f = nodes[i].frame
            guard f.width > 0, f.height > 0, f.intersects(reach), blockers(i) else { return nil }
            return f
        } + keepOut.filter { $0.intersects(reach) }
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
