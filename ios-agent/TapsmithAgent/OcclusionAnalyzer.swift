import XCTest

/// Decides whether an element-addressed touch would land on the element or
/// on something drawn over it (PILOT-223), from one `app.snapshot()`.
///
/// XCUITest's `isHittable` already hit-tests the element's center, and on a
/// covered element it correctly reports `false` — but the agent used to fall
/// back to a raw coordinate tap at the center whenever `isHittable` said no
/// (to survive elements XCUITest wrongly calls unhittable), and that tap
/// landed on the cover and reported success. This type supplies the missing
/// evidence: the fallback may only fire when nothing in the snapshot covers
/// the touch point.
///
/// What counts as a cover:
/// - **The software keyboard.** Its `.keyboard` element's frame understates
///   what it covers (the predictive bar above it and the globe/dictation row
///   below it are outside it — observed on iOS 26), so the covered region is
///   grown to every in-screen node in the keyboard's windows and, for a
///   keyboard docked at the bottom, to the bottom edge. A target in the
///   visible part of that area is still tappable: the touch point moves to
///   the center of what the keyboard leaves visible, the same way Playwright
///   clicks the in-viewport part of a partly scrolled-out element.
/// - **Navigation, tab, and tool bars** the target is not part of, when they
///   are drawn over it: over the content of their own container (scroll
///   content passes under a nav bar even though the bar comes first in the
///   tree) or painted after it — not over a sheet presented on top of their
///   screen. They clip the visible area like the keyboard does.
/// - **An interactive control painted after the target** (later in a
///   pre-order walk, which is the drawing order) that is not the target's own
///   descendant and contains the touch point: a button, link, input, cell,
///   alert, sheet… This check only runs when XCUITest says the element is not
///   hittable. Plain views, texts, and images are never named: a
///   `pointerEvents="none"` overlay looks exactly like them, and on Xcode 26.6
///   it fools XCUITest's hit test as well (see `interactiveTypes`).
/// - **A loading overlay** (PILOT-979), when XCUITest says the element is not
///   hittable: a view painted after the target over the touch point that is
///   an activity or progress indicator or holds one. Apps lay one over a
///   screen while it loads, often see-through, and it takes the touches
///   though nothing in it is a control. A spinner over the point says "wait"
///   either way, so this is the one plain view that is named.
/// - **A sticky list row** (PILOT-979), when not hittable: another row of the
///   list the target's row is in, at least as wide as the target, over the
///   touch point — a section header floating over the rows scrolled under it.
///   A list's rows do not overlap otherwise.
///
/// A cover in the target's own window that the vertical list holding the
/// target can scroll away from — a sticky row, a bar, or a control outside
/// the list (a sticky footer's button) — is reported as `.coveredInList`, so
/// the touch can drag the target clear of it first (PILOT-980).
struct OcclusionAnalyzer {
    /// What the snapshot says about the target.
    enum Verdict: Equatable {
        /// Nothing covers `point` — touch there. `visible` is the part of the
        /// element left uncovered by the keyboard and bars (`point` is its
        /// center), for callers that want a different spot inside it.
        case clear(point: CGPoint, visible: CGRect)
        /// The element is covered, by the thing `by` names ("the keyboard",
        /// `button "Overlay"`).
        case covered(by: String)
        /// Covered by in-window chrome at `cover` that the vertical list at
        /// `list`, which holds the target but not the cover, can scroll the
        /// target clear of (PILOT-980).
        case coveredInList(by: String, cover: CGRect, list: CGRect)
        /// No part of the element is on screen.
        case offScreen
        /// The target is not hittable and could not be matched in the tree
        /// (it moved between the element read and the tree read — an
        /// animation). There is no evidence either way yet: read again, and
        /// only if it never settles fall back to `point`, as with no tree.
        case unlocated(point: CGPoint, visible: CGRect)
        /// The target was identified only from cached find-time data and
        /// nothing in the tree matches it any more — it unmounted (a screen
        /// transition while its cover was being waited out). Touching its old
        /// bounds would hit whatever replaced it.
        case gone
    }

    /// The target as last read from the device. `isLive` is false when the
    /// live element could not be read and the fields come from what was
    /// cached when the element was found; `elementType`, `label`, and
    /// `identifier` are nil when even that is unknown, and matching then
    /// falls back to the frame.
    struct Target {
        let frame: CGRect
        let elementType: XCUIElement.ElementType?
        let label: String?
        let identifier: String?
        var isLive = true
    }

    struct Node {
        let elementType: XCUIElement.ElementType
        let label: String
        let identifier: String
        let frame: CGRect
        /// One past the index of the last node in this node's subtree.
        var subtreeEnd: Int
        /// Index of the parent node (nil for the root).
        let parent: Int?
        /// Index of the top-level window node this node is in (nil for the
        /// application node itself).
        let window: Int?
    }

    /// Smallest visible extent (points, each axis) worth touching: anything
    /// thinner risks the integer-rounded touch point landing just outside.
    static let minVisibleExtent: CGFloat = 2

    /// A keyboard whose frame ends this close to the bottom of the screen is
    /// docked; the strip below it (globe / dictation row) belongs to it.
    static let dockedKeyboardSlack: CGFloat = 120

    /// The nodes, with an unloaded table row's contents placed at their row
    /// (`CellFrames`, PILOT-800): their snapshot frames are a placeholder on
    /// screen, which would make them covers of whatever really is there.
    let nodes: [Node]
    let screen: CGRect
    /// Each node's frame as the snapshot reported it — what a live read of
    /// the target reports too, so the target is located by it.
    private let snapshotFrames: [CGRect]

    init(nodes: [Node], screen: CGRect) {
        var placed = nodes
        // Pre-order: a parent is placed before its children. A node's
        // context is the one its parent hands its children.
        var childContexts: [CellFrames.Context] = []
        childContexts.reserveCapacity(nodes.count)
        for i in placed.indices {
            let context = placed[i].parent.map { childContexts[$0] } ?? CellFrames.Context(viewport: screen)
            let frame = CellFrames.effectiveFrame(of: nodes[i].frame, in: context)
            if frame != nodes[i].frame {
                let n = nodes[i]
                placed[i] = Node(
                    elementType: n.elementType, label: n.label, identifier: n.identifier, frame: frame,
                    subtreeEnd: n.subtreeEnd, parent: n.parent, window: n.window
                )
            }
            childContexts.append(CellFrames.childContext(of: nodes[i].elementType, frame: frame, in: context))
        }
        self.nodes = placed
        self.snapshotFrames = nodes.map(\.frame)
        self.screen = screen
    }

    init(snapshot: XCUIElementSnapshot, screenSize: CGSize) {
        var nodes: [Node] = []
        func walk(_ s: XCUIElementSnapshot, window: Int?, parent: Int?) {
            let index = nodes.count
            let ownWindow = s.elementType == .window && window == nil ? index : window
            nodes.append(Node(
                elementType: s.elementType,
                label: s.label,
                identifier: s.identifier,
                frame: s.frame,
                subtreeEnd: index + 1,
                parent: parent,
                window: s.elementType == .application ? nil : ownWindow
            ))
            for child in s.children { walk(child, window: ownWindow, parent: index) }
            nodes[index].subtreeEnd = nodes.count
        }
        walk(snapshot, window: nil, parent: nil)
        self.init(nodes: nodes, screen: CGRect(origin: .zero, size: screenSize))
    }

    // MARK: - Verdict

    func analyze(_ target: Target, isHittable: Bool) -> Verdict {
        var visible = target.frame.intersection(screen)
        guard !visible.isNull,
              visible.width >= Self.minVisibleExtent,
              visible.height >= Self.minVisibleExtent else {
            return .offScreen
        }

        // Not readable live and nothing cached to recognise it by: a frame
        // alone would match a same-frame cover or replacement.
        if !target.isLive, !nodes.isEmpty,
           target.elementType == nil, target.label == nil, target.identifier == nil {
            return .gone
        }
        let targetIndex = locate(target)
        if targetIndex == nil, !target.isLive, !nodes.isEmpty { return .gone }
        // A live read of an unloaded table row's content returns its
        // placeholder frame, on screen; the row itself is not (PILOT-800).
        if let t = targetIndex, nodes[t].frame != snapshotFrames[t] { return .offScreen }
        // Content scrolled past its scroll view's edge is clipped, whatever
        // is drawn there (a JS header is painted before the list, so the
        // painted-after check would not see it).
        if let t = targetIndex {
            for a in ancestors(of: t) where Self.scrollerTypes.contains(nodes[a].elementType) {
                visible = visible.intersection(nodes[a].frame)
                if visible.isNull
                    || visible.width < Self.minVisibleExtent
                    || visible.height < Self.minVisibleExtent {
                    return .offScreen
                }
            }
        }
        let keyboardWindows = self.keyboardWindows()
        let targetInKeyboard = targetIndex.map { isInKeyboard($0, keyboardWindows: keyboardWindows) } ?? false

        var clips: [(rect: CGRect, name: String, node: Int?)] = []
        if !targetInKeyboard, let region = keyboardRegion(keyboardWindows: keyboardWindows) {
            clips.append((region, "the keyboard", nil))
        }
        for (i, node) in nodes.enumerated() where Self.barTypes.contains(node.elementType) {
            if let w = node.window, keyboardWindows.contains(w) { continue }
            if isSelfOrAncestor(i, of: targetIndex, targetFrame: target.frame) { continue }
            if !barCovers(i, target: targetIndex) { continue }
            clips.append((node.frame, describe(node), i))
        }
        for clip in clips {
            let before = visible
            visible = Self.subtract(clip.rect, from: visible)
            if visible.isNull
                || visible.width < Self.minVisibleExtent
                || visible.height < Self.minVisibleExtent {
                if let bar = clip.node, let t = targetIndex {
                    // A loading overlay drawn over the bar is what is in the
                    // way first: wait it out, and keep the drags for after.
                    if !isHittable, let loading = paintedOver(
                        t, at: CGPoint(x: before.midX, y: before.midY),
                        keyboardWindows: keyboardWindows, targetInKeyboard: targetInKeyboard
                    ).loading {
                        return .covered(by: loadingName(loading))
                    }
                    return chromeCover(clip.name, at: bar, over: t)
                }
                return .covered(by: clip.name)
            }
        }

        let point = CGPoint(x: visible.midX, y: visible.midY)
        // XCUITest's hit test passed: trust it over the snapshot (see the
        // type comment on pass-through overlays).
        if isHittable { return .clear(point: point, visible: visible) }
        // Without the target's place in the tree there is no telling what is
        // drawn over it: a live target that just moved can be read again; a
        // tree that has nothing to match (no snapshot) is no evidence.
        guard let t = targetIndex else {
            return nodes.isEmpty
                ? .clear(point: point, visible: visible)
                : .unlocated(point: point, visible: visible)
        }
        let (cover, loading) = paintedOver(t, at: point, keyboardWindows: keyboardWindows, targetInKeyboard: targetInKeyboard)
        if let loading {
            // The overlay is on top of any control under it: wait it out. A
            // control in the overlay (its Cancel button) is named, but is
            // never scrolled away from either.
            guard let cover, cover > loading else { return .covered(by: loadingName(loading)) }
            if cover < nodes[loading].subtreeEnd { return .covered(by: describe(nodes[cover])) }
        }
        if let cover {
            return chromeCover(describe(nodes[cover]), at: cover, over: t)
        }
        if let row = stickyRow(over: t, at: point, targetFrame: visible) {
            return chromeCover(describe(nodes[row.row]), at: row.row, over: t, list: row.list)
        }
        return .clear(point: point, visible: visible)
    }

    private func loadingName(_ i: Int) -> String { "a loading overlay (\(describe(nodes[i])))" }

    /// What is painted after target `t` over `point`: the topmost
    /// interactive control, and the outermost view that is or holds a
    /// progress indicator (a loading overlay).
    private func paintedOver(
        _ t: Int, at point: CGPoint, keyboardWindows: Set<Int>, targetInKeyboard: Bool
    ) -> (cover: Int?, loading: Int?) {
        // Runs of the same text as the target (a link inside a paragraph).
        let paragraph = nodes[t].parent.flatMap { nodes[$0].elementType == .staticText ? $0 : nil }

        var cover: Int?
        var loading: Int?
        for i in nodes[t].subtreeEnd..<nodes.count {
            let node = nodes[i]
            if let w = node.window, keyboardWindows.contains(w), !targetInKeyboard { continue }
            // Other runs of the same paragraph are laid out beside the target,
            // not over it — a line-wrapped sibling link's frame is the union
            // of its lines and can span the target's center. (A Text drawn
            // over a sibling Pressable is not a run of the target's text.)
            if let paragraph, node.parent == paragraph, Self.textRunTypes.contains(node.elementType) { continue }
            if isScrollIndicator(node) || isTapsmithHooksMarker(node) { continue }
            guard clippedFrame(of: i).contains(point) else { continue }
            if isInteractive(node) {
                cover = i
            } else if loading == nil, holdsProgressIndicator(i) {
                // The outermost such view: what the overlay is.
                loading = i
            }
        }
        return (cover, loading)
    }

    /// Whether a drag that starts at `point` would press the vertical list at
    /// `list` that holds `target` (PILOT-980), and nothing else: no control
    /// painted after the list lies over the point — a dialog's backdrop, a
    /// second bar stacked on the cover — and the keyboard does not. A drag
    /// that started there would press that instead. Nor does anything in the
    /// layer the cover (`cover`, its frame) is laid out in, other than the
    /// views that hold it: a dialog's backdrop with no role (a React Native
    /// Pressable reads as `.other`) sits beside the dialog's card in one
    /// host; a host that only lays out the chrome holds nothing else there.
    /// False too when the list is not among the target's ancestors.
    func isDragStartOnList(_ target: Target, list: CGRect, cover: CGRect, at point: CGPoint) -> Bool {
        guard let t = locate(target),
              let l = ancestors(of: t).first(where: {
                  Self.listTypes.contains(nodes[$0].elementType) && Self.framesMatch(nodes[$0].frame, list)
              }) else { return false }
        let keyboardWindows = self.keyboardWindows()
        if let region = keyboardRegion(keyboardWindows: keyboardWindows), region.contains(point) { return false }
        for i in nodes[l].subtreeEnd..<nodes.count {
            let node = nodes[i]
            if let w = node.window, keyboardWindows.contains(w) { continue }
            if isScrollIndicator(node) || isTapsmithHooksMarker(node) { continue }
            if (isInteractive(node) || Self.barTypes.contains(node.elementType)), clippedFrame(of: i).contains(point) {
                return false
            }
        }
        return !coverLayerLies(over: point, cover: cover, after: nodes[l].subtreeEnd)
    }

    /// Whether something in the cover's layer — the outermost view painted
    /// after the list (from index `start`) that holds the cover — other than
    /// the cover and the views holding it lies over `point`.
    private func coverLayerLies(over point: CGPoint, cover: CGRect, after start: Int) -> Bool {
        guard start < nodes.count,
              let c = (start..<nodes.count).first(where: { Self.framesMatch(clippedFrame(of: $0), cover) }) else { return false }
        let holders = Set(ancestors(of: c).filter { $0 >= start })
        guard let layer = holders.min() else { return false }
        for i in layer..<nodes[layer].subtreeEnd where !holders.contains(i) && !(i >= c && i < nodes[c].subtreeEnd) {
            let node = nodes[i]
            if isScrollIndicator(node) || isTapsmithHooksMarker(node) { continue }
            if clippedFrame(of: i).contains(point) { return true }
        }
        return false
    }

    /// The interactive control painted after the target that contains any of
    /// `points`, described — or nil. `analyze` checks covers only at the
    /// visible area's centre, which is where a tap lands; a gesture that
    /// touches down elsewhere in the area (a pinch's fingers, PILOT-825) checks
    /// its own points here. Skips what `analyze` skips: the keyboard's windows
    /// (it clips the area instead), scroll indicators and the hooks marker.
    /// nil too when the target cannot be placed in the tree, as there is then
    /// no telling what is painted after it.
    func interactiveCover(of target: Target, at points: [CGPoint]) -> String? {
        guard let t = locate(target) else { return nil }
        let keyboardWindows = self.keyboardWindows()
        let targetInKeyboard = isInKeyboard(t, keyboardWindows: keyboardWindows)
        for i in nodes[t].subtreeEnd..<nodes.count {
            let node = nodes[i]
            if let w = node.window, keyboardWindows.contains(w), !targetInKeyboard { continue }
            if isScrollIndicator(node) || isTapsmithHooksMarker(node) { continue }
            guard isInteractive(node) else { continue }
            let frame = clippedFrame(of: i)
            if points.contains(where: { frame.contains($0) }) { return describe(node) }
        }
        return nil
    }

    // MARK: - Loading overlays and sticky rows (PILOT-979)

    static let progressTypes: Set<XCUIElement.ElementType> = [.activityIndicator, .progressIndicator]

    /// Presented containers: never scrolled away from.
    static let presentedTypes: Set<XCUIElement.ElementType> = [.alert, .sheet, .dialog, .popover]

    /// Whether node `i` is a progress indicator or holds a visible one inside
    /// its frame.
    private func holdsProgressIndicator(_ i: Int) -> Bool {
        let frame = clippedFrame(of: i)
        for j in i..<nodes[i].subtreeEnd where Self.progressTypes.contains(nodes[j].elementType) {
            let f = clippedFrame(of: j)
            if !f.isNull, f.width > 0, f.height > 0, f.intersects(frame) { return true }
        }
        return false
    }

    /// Another row of the list the target's row is in, stuck over `point`:
    /// containing it, at least as wide as the target, and no taller than half
    /// the list. (The tree's order says nothing here: iOS lists a floating
    /// header before the rows it is drawn over.) A list's rows are
    /// the children of a table or collection view, or of a scroll view's
    /// content view (React Native).
    private func stickyRow(over t: Int, at point: CGPoint, targetFrame: CGRect) -> (row: Int, list: Int)? {
        var row = t
        while let content = nodes[row].parent {
            if let list = listOwning(content: content) {
                // The target inside a row stuck at the list's visible top or
                // bottom edge is in the sticky header itself, on top of the
                // row scrolled under it (the tree has no paint order to say
                // so). A target that is a row is still checked. The row's own
                // frame, not its clipped one: a row partly scrolled past the
                // edge is clipped to it without being stuck there.
                let edges = clippedFrame(of: list), rowFrame = nodes[row].frame
                if row != t, abs(rowFrame.minY - edges.minY) <= 1 || abs(rowFrame.maxY - edges.maxY) <= 1 {
                    return nil
                }
                for i in (content + 1)..<nodes[content].subtreeEnd where nodes[i].parent == content && i != row {
                    let node = nodes[i]
                    if isScrollIndicator(node) || isTapsmithHooksMarker(node) { continue }
                    let f = clippedFrame(of: i)
                    // A bar-sized row with content of its own — children or
                    // a label. A background laid behind the rows (a view
                    // filling the content), a row's own empty background
                    // view React Native lists beside its controls, or a
                    // plain View with a testID, which React Native flattens
                    // into an empty node with only that identifier, its
                    // contents listed beside it in whatever order XCUITest
                    // sorts them (the /visibility screen's banner and rows),
                    // is not a header stuck over one. A sticky header holds
                    // its contents (React Native) or carries a label (UIKit).
                    if f.contains(point), f.minX <= targetFrame.minX + 1, f.maxX >= targetFrame.maxX - 1,
                       f.height * 2 <= nodes[list].frame.height,
                       node.subtreeEnd > i + 1 || !node.label.isEmpty {
                        return (i, list)
                    }
                }
                return nil
            }
            row = content
        }
        return nil
    }

    /// The scroller whose rows are `content`'s children: `content` itself (a
    /// table, a collection view, a scroll view whose rows are direct
    /// children), or the scroll view `content` is the only content of —
    /// through any chain of only-child wrappers (React Native nests its
    /// content view in another).
    private func listOwning(content: Int) -> Int? {
        let type = nodes[content].elementType
        if type == .table || type == .collectionView || type == .scrollView { return content }
        var inner = content
        while let p = nodes[inner].parent {
            let children = ((p + 1)..<nodes[p].subtreeEnd).filter { nodes[$0].parent == p && !isScrollIndicator(nodes[$0]) }
            guard children == [inner] else { return nil }
            if nodes[p].elementType == .scrollView { return p }
            guard nodes[p].elementType == .other else { return nil }
            inner = p
        }
        return nil
    }

    /// The nearest vertical list holding target `t` but not node `cover`:
    /// a scroller ancestor (not a web view) with room to scroll the target
    /// up or down (taller than twice it).
    private func verticalList(holding t: Int, notHolding cover: Int) -> Int? {
        ancestors(of: t).first { a in
            Self.listTypes.contains(nodes[a].elementType)
                && !(a <= cover && nodes[a].subtreeEnd > cover)
                && nodes[a].frame.height > 2 * nodes[t].frame.height
        }
    }

    static let listTypes: Set<XCUIElement.ElementType> = [.scrollView, .table, .collectionView]

    /// `.coveredInList` when a vertical list can scroll target `t` clear of
    /// node `cover` (`list` when already known), else `.covered`.
    /// A cover in a presented container (an alert's button, a popover's
    /// row) or in another window is never scrolled away from: it is waited
    /// out, and a drag under it would touch it.
    private func chromeCover(_ name: String, at cover: Int, over t: Int, list known: Int? = nil) -> Verdict {
        let presented = ([cover] + ancestors(of: cover)).contains { Self.presentedTypes.contains(nodes[$0].elementType) }
        guard !presented, nodes[cover].window == nodes[t].window,
              let list = known ?? verticalList(holding: t, notHolding: cover) else { return .covered(by: name) }
        // A sticky row is cleared as itself; a control as the bar it sits in.
        let bounds = known != nil ? clippedFrame(of: cover) : chromeFrame(of: cover, over: t, list: list)
        return .coveredInList(by: name, cover: bounds, list: nodes[list].frame)
    }

    /// The frame of the fixed chrome control `cover` sits in: its outermost
    /// ancestor that does not hold the target and is no taller than half of
    /// `list` — a bar, with its labels, not a full-screen host it is placed in.
    private func chromeFrame(of cover: Int, over t: Int, list: Int) -> CGRect {
        var node = cover
        while let p = nodes[node].parent,
              !(p <= t && nodes[p].subtreeEnd > t),
              nodes[p].frame.height * 2 <= nodes[list].frame.height {
            node = p
        }
        return clippedFrame(of: node)
    }

    // MARK: - Target lookup

    /// The target's index in `nodes`: the deepest node whose frame matches
    /// and whose type/label/identifier match where known. Deepest, because
    /// React Native often wraps an element in a same-frame, same-label parent
    /// — picking the parent would count the target itself as painted after.
    /// A frame matches as the snapshot reported it (a live read) or as placed
    /// (a find-time frame, which `CellFrames` placed the same way).
    func locate(_ target: Target) -> Int? {
        var match: Int?
        for (i, node) in nodes.enumerated() {
            guard Self.framesMatch(node.frame, target.frame) || Self.framesMatch(snapshotFrames[i], target.frame)
            else { continue }
            if let t = target.elementType, node.elementType != t { continue }
            if let l = target.label, node.label != l { continue }
            if let id = target.identifier, node.identifier != id { continue }
            match = i
        }
        return match
    }

    private func isSelfOrAncestor(_ i: Int, of target: Int?, targetFrame: CGRect) -> Bool {
        if let t = target { return i <= t && nodes[i].subtreeEnd > t }
        // Unknown place in the tree: a bar that fully contains the target
        // (a back button, a tab) is taken to be its ancestor.
        return nodes[i].frame.contains(targetFrame)
    }

    /// Whether bar `i` is drawn over the target. A bar is drawn over the
    /// content of its own container (scroll content passes under a nav bar
    /// even though the bar comes first in the tree), and over anything
    /// painted after it — but not over a sheet or modal presented on top of
    /// the screen it belongs to, which is painted after the bar's container.
    private func barCovers(_ i: Int, target: Int?) -> Bool {
        // Unknown place in the tree: assume it does.
        guard let t = target else { return true }
        if i >= nodes[t].subtreeEnd { return true }
        // A window or the application "contains" everything in it, including
        // a sheet presented over the bar's screen — that is not the bar's own
        // content.
        guard let container = nodes[i].parent,
              nodes[container].elementType != .window,
              nodes[container].elementType != .application else { return false }
        return container < t && nodes[container].subtreeEnd > t
    }

    // MARK: - Keyboard

    /// Top-level windows that host the software keyboard: windows other than
    /// the app's first (main) window holding a `.keyboard` node or the remote
    /// input view (`inputView`, observed on iOS 26 in a separate window from
    /// the keys). The main window never counts, even if a runtime puts the
    /// keyboard in it: that would make every app element "part of the
    /// keyboard" (and an app view could carry the same testID).
    func keyboardWindows() -> Set<Int> {
        let mainWindow = nodes.first(where: { $0.window != nil })?.window
        var windows = Set<Int>()
        for node in nodes {
            guard let w = node.window, w != mainWindow else { continue }
            if isKeyboardRoot(node) { windows.insert(w) }
        }
        return windows
    }

    private func isKeyboardRoot(_ node: Node) -> Bool {
        node.elementType == .keyboard || node.identifier == "inputView"
    }

    /// Whether node `t` is part of the keyboard itself (a key, the predictive
    /// bar): in a keyboard window, or inside the `.keyboard` subtree wherever
    /// it lives.
    private func isInKeyboard(_ t: Int, keyboardWindows: Set<Int>) -> Bool {
        if let w = nodes[t].window, keyboardWindows.contains(w) { return true }
        return ancestors(of: t).contains { nodes[$0].elementType == .keyboard }
    }

    /// The screen area the keyboard covers, or nil when no keyboard is up.
    func keyboardRegion(keyboardWindows: Set<Int>) -> CGRect? {
        guard let keyboard = nodes.first(where: {
            $0.elementType == .keyboard && $0.frame.width > 0 && $0.frame.height > 0
        })?.frame else { return nil }

        var top = keyboard.minY
        for node in nodes {
            guard let w = node.window, keyboardWindows.contains(w) else { continue }
            let f = node.frame
            // Skip full-window hosts and off-screen scrollers (a node at
            // y = -71 with height 1244 lives in the iOS 26 keyboard window).
            guard f.width > 0, f.height > 0,
                  f.minY >= screen.minY, f.maxY <= screen.maxY + 1,
                  f.height <= screen.height * 0.75,
                  f.maxX > keyboard.minX, f.minX < keyboard.maxX,
                  f.maxY > keyboard.minY else { continue }
            top = min(top, f.minY)
        }

        // Docked: near the bottom and (nearly) full width. A hardware
        // keyboard's small assistant bar near the bottom is neither, and
        // covers only its own frame.
        if keyboard.maxY >= screen.maxY - Self.dockedKeyboardSlack,
           keyboard.width >= screen.width * 0.9 {
            return CGRect(x: screen.minX, y: top, width: screen.width, height: screen.maxY - top)
        }
        return CGRect(x: keyboard.minX, y: top, width: keyboard.width, height: keyboard.maxY - top)
    }

    // MARK: - Keyboard first (PILOT-622)

    /// What a touch on an element should do about the software keyboard.
    enum KeyboardFirst: Equatable {
        /// No keyboard on screen.
        case noKeyboard
        /// Touch the element with the keyboard up.
        case touchAsIs
        /// Put the keyboard away first: the touch would only close it.
        case putKeyboardAway
    }

    /// What a React Native ScrollView or FlatList shows up as. Native tables
    /// and collection views do not eat a touch to close the keyboard (and
    /// their rows may be suggestions that only show while it is up), and a
    /// web view's page sees the touch whatever the keyboard.
    static let keyboardEatingScrollerTypes: Set<XCUIElement.ElementType> = [.scrollView]
    static let textInputTypes: Set<XCUIElement.ElementType> = [.textField, .secureTextField, .searchField, .textView]

    /// Whether a touch on `target` would be spent on closing the keyboard.
    /// A React Native ScrollView with the default
    /// `keyboardShouldPersistTaps="never"` closes the keyboard on the first
    /// touch after typing and gives the touch to nothing else — so when the
    /// keyboard is up and the target sits in a scroll view, the keyboard goes
    /// first. A text input is touched as is (focus moves, keyboard and all),
    /// and so is a key of the keyboard and anything not found in the tree.
    func keyboardFirst(_ target: Target) -> KeyboardFirst {
        let windows = keyboardWindows()
        // Any keyboard element with an on-screen part: a stale one left off
        // screen by a keyboard-type switch can come before the real one.
        let keyboardOnScreen = nodes.contains {
            $0.elementType == .keyboard && !$0.frame.intersection(screen).isEmpty
        }
        guard keyboardOnScreen else { return .noKeyboard }
        if let type = target.elementType, Self.textInputTypes.contains(type) { return .touchAsIs }
        guard let t = locate(target) else { return .touchAsIs }
        if Self.textInputTypes.contains(nodes[t].elementType) || isInKeyboard(t, keyboardWindows: windows) {
            return .touchAsIs
        }
        // Web content handles its own touches, even inside a scroll view.
        let up = ancestors(of: t)
        if up.contains(where: { nodes[$0].elementType == .webView }) { return .touchAsIs }
        // Part of a text input (its clear button): React Native leaves the
        // keyboard up for a touch on the input, and blurring would hide it.
        if up.contains(where: { Self.textInputTypes.contains(nodes[$0].elementType) }) { return .touchAsIs }
        let inScrollView = up.contains { Self.keyboardEatingScrollerTypes.contains(nodes[$0].elementType) }
        return inScrollView ? .putKeyboardAway : .touchAsIs
    }

    // MARK: - Helpers

    static let barTypes: Set<XCUIElement.ElementType> = [.navigationBar, .tabBar, .toolbar]
    static let scrollerTypes: Set<XCUIElement.ElementType> = [.scrollView, .table, .collectionView, .webView]
    static let textRunTypes: Set<XCUIElement.ElementType> = [.staticText, .link]

    /// A node's frame clipped to its scroll viewports: content scrolled past a
    /// scroll view's edge keeps its full frame in the snapshot but is not
    /// drawn there.
    private func clippedFrame(of i: Int) -> CGRect {
        var frame = nodes[i].frame
        for a in ancestors(of: i) where Self.scrollerTypes.contains(nodes[a].elementType) {
            frame = frame.intersection(nodes[a].frame)
        }
        return frame
    }

    func ancestors(of i: Int) -> [Int] {
        var result: [Int] = []
        var p = nodes[i].parent
        while let a = p {
            result.append(a)
            p = nodes[a].parent
        }
        return result
    }

    /// `@tapsmith/react-native`'s test hooks marker: a screen-sized
    /// transparent text in a `pointerEvents="none"` wrapper, painted after all
    /// content (versions before PILOT-830 also drew a small visible copy in a
    /// corner). It exists to be seen in the hierarchy and takes no touches —
    /// but on Xcode 26.6 it makes XCUITest call every element under it
    /// unhittable, and as a labeled text over every point it would otherwise
    /// be named the cover of all of them.
    func isTapsmithHooksMarker(_ node: Node) -> Bool {
        node.elementType == .staticText
            && (node.identifier == "tapsmith-hooks" || NonAppElements.isHooksMarker(node.label))
    }

    /// A scroll view's indicator ("Vertical scroll bar, 2 pages"): drawn over
    /// the content's edge, but it never takes touches.
    private func isScrollIndicator(_ node: Node) -> Bool {
        guard node.elementType == .other,
              let p = node.parent, Self.scrollerTypes.contains(nodes[p].elementType) else { return false }
        return node.label.lowercased().contains("scroll bar")
    }

    /// Controls and presented containers: what, drawn over the target, would
    /// take the touch. Measured on Xcode 26.6 (CI), XCUITest's hit test is
    /// fooled by `pointerEvents="none"` views (a testID'd overlay, the test
    /// hooks marker) just like the snapshot is, so "unhittable" is no
    /// evidence that a plain view, a text, or an image over the point is a
    /// real cover — only an interactive control is. A non-interactive view
    /// that does intercept touches (an unlabeled backdrop) still gets the old
    /// coordinate fallback; telling those apart needs an accessibility hit
    /// test (PILOT-364).
    static let interactiveTypes: Set<XCUIElement.ElementType> = [
        .button, .link, .textField, .secureTextField, .textView, .searchField,
        .switch, .toggle, .slider, .stepper, .segmentedControl, .picker, .pickerWheel,
        .cell, .checkBox, .radioButton, .menuItem, .menuButton, .popUpButton,
        .tab, .alert, .sheet, .dialog, .popover,
    ]

    private func isInteractive(_ node: Node) -> Bool {
        Self.interactiveTypes.contains(node.elementType)
    }

    func describe(_ node: Node) -> String {
        let kind: String
        switch node.elementType {
        case .navigationBar: kind = "navigation bar"
        case .tabBar: kind = "tab bar"
        case .toolbar: kind = "toolbar"
        case .other: kind = "element"
        default: kind = RoleMapping.elementTypeToRole[node.elementType] ?? "element"
        }
        let name = node.label.isEmpty ? node.identifier : node.label
        return name.isEmpty ? kind : "\(kind) \"\(name)\""
    }

    /// Frames from a live element read and from a snapshot can differ by
    /// sub-point rounding.
    static func framesMatch(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = 1) -> Bool {
        abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance
            && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }

    /// The largest axis-aligned piece of `rect` left after removing `cut`
    /// (`rect` itself when they don't overlap; null when nothing is left).
    static func subtract(_ cut: CGRect, from rect: CGRect) -> CGRect {
        let overlap = rect.intersection(cut)
        guard !overlap.isNull, overlap.width > 0, overlap.height > 0 else { return rect }
        let pieces = [
            CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: overlap.minY - rect.minY),
            CGRect(x: rect.minX, y: overlap.maxY, width: rect.width, height: rect.maxY - overlap.maxY),
            CGRect(x: rect.minX, y: rect.minY, width: overlap.minX - rect.minX, height: rect.height),
            CGRect(x: overlap.maxX, y: rect.minY, width: rect.maxX - overlap.maxX, height: rect.height),
        ].filter { $0.width > 0 && $0.height > 0 }
        return pieces.max { $0.width * $0.height < $1.width * $1.height } ?? .null
    }
}
