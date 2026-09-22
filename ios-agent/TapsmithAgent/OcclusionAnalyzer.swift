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
/// - **Anything painted after the target** (later in a pre-order walk, which
///   is the drawing order) that is not the target's own descendant, contains
///   the touch point, and is *substantive* — not a plain unlabeled container.
///   This check only runs when XCUITest says the element is not hittable: a
///   `pointerEvents="none"` overlay shows up in the snapshot on top of its
///   target exactly like a real cover, and only the hit test can tell them
///   apart. Plain full-screen `Other` wrappers are painted after most content
///   in React Native trees, hence the substantive filter.
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

    let nodes: [Node]
    let screen: CGRect

    init(nodes: [Node], screen: CGRect) {
        self.nodes = nodes
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

        var clips: [(rect: CGRect, name: String)] = []
        if !targetInKeyboard, let region = keyboardRegion(keyboardWindows: keyboardWindows) {
            clips.append((region, "the keyboard"))
        }
        for (i, node) in nodes.enumerated() where Self.barTypes.contains(node.elementType) {
            if let w = node.window, keyboardWindows.contains(w) { continue }
            if isSelfOrAncestor(i, of: targetIndex, targetFrame: target.frame) { continue }
            if !barCovers(i, target: targetIndex) { continue }
            clips.append((node.frame, describe(node)))
        }
        for clip in clips {
            visible = Self.subtract(clip.rect, from: visible)
            if visible.isNull
                || visible.width < Self.minVisibleExtent
                || visible.height < Self.minVisibleExtent {
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
        // Runs of the same text as the target (a link inside a paragraph).
        let paragraph = nodes[t].parent.flatMap { nodes[$0].elementType == .staticText ? $0 : nil }

        var cover: Node?
        for i in nodes[t].subtreeEnd..<nodes.count {
            let node = nodes[i]
            if let w = node.window, keyboardWindows.contains(w), !targetInKeyboard { continue }
            // Other runs of the same paragraph are laid out beside the target,
            // not over it — a line-wrapped sibling link's frame is the union
            // of its lines and can span the target's center. (A Text drawn
            // over a sibling Pressable is not a run of the target's text.)
            if let paragraph, node.parent == paragraph, Self.textRunTypes.contains(node.elementType) { continue }
            if isScrollIndicator(node) { continue }
            guard isSubstantive(node), node.frame.contains(point) else { continue }
            cover = node
        }
        if let cover { return .covered(by: describe(cover)) }
        return .clear(point: point, visible: visible)
    }

    // MARK: - Target lookup

    /// The target's index in `nodes`: the deepest node whose frame matches
    /// and whose type/label/identifier match where known. Deepest, because
    /// React Native often wraps an element in a same-frame, same-label parent
    /// — picking the parent would count the target itself as painted after.
    func locate(_ target: Target) -> Int? {
        var match: Int?
        for (i, node) in nodes.enumerated() {
            guard Self.framesMatch(node.frame, target.frame) else { continue }
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

    // MARK: - Helpers

    static let barTypes: Set<XCUIElement.ElementType> = [.navigationBar, .tabBar, .toolbar]
    static let scrollerTypes: Set<XCUIElement.ElementType> = [.scrollView, .table, .collectionView, .webView]
    static let textRunTypes: Set<XCUIElement.ElementType> = [.staticText, .link]

    private func ancestors(of i: Int) -> [Int] {
        var result: [Int] = []
        var p = nodes[i].parent
        while let a = p {
            result.append(a)
            p = nodes[a].parent
        }
        return result
    }

    /// A scroll view's indicator ("Vertical scroll bar, 2 pages"): drawn over
    /// the content's edge, but it never takes touches.
    private func isScrollIndicator(_ node: Node) -> Bool {
        guard node.elementType == .other,
              let p = node.parent, Self.scrollerTypes.contains(nodes[p].elementType) else { return false }
        return node.label.lowercased().contains("scroll bar")
    }

    /// Worth naming as a cover: a typed element, or a generic one that carries
    /// a label or identifier (a Pressable backdrop with a testID). Unlabeled
    /// `Other` wrappers, windows, and the application are layout, not covers.
    private func isSubstantive(_ node: Node) -> Bool {
        switch node.elementType {
        case .application, .window:
            return false
        case .other:
            return !node.label.isEmpty || !node.identifier.isEmpty
        default:
            return true
        }
    }

    func describe(_ node: Node) -> String {
        let kind: String
        switch node.elementType {
        case .navigationBar: kind = "navigation bar"
        case .tabBar: kind = "tab bar"
        case .toolbar: kind = "toolbar"
        case .other: kind = "element"
        // Named here, not via RoleMapping: its reverse map is built from a
        // Dictionary, so .staticText comes out "text" or "heading" per process.
        case .staticText: kind = "text"
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
