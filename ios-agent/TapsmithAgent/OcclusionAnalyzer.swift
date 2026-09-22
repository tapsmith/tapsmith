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
/// - **Navigation, tab, and tool bars** the target is not part of. They are
///   drawn over content regardless of where they sit in the tree, so they
///   clip the visible area like the keyboard does.
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
        /// Nothing covers `point` — touch there.
        case clear(point: CGPoint)
        /// The element is covered, by the thing `by` names ("the keyboard",
        /// `button "Overlay"`).
        case covered(by: String)
        /// No part of the element is on screen.
        case offScreen
    }

    /// The target as last read from the device. `elementType`, `label`, and
    /// `identifier` are nil when the live element could not be read (only
    /// cached bounds survive); matching then falls back to the frame.
    struct Target {
        let frame: CGRect
        let elementType: XCUIElement.ElementType?
        let label: String?
        let identifier: String?
    }

    struct Node {
        let elementType: XCUIElement.ElementType
        let label: String
        let identifier: String
        let frame: CGRect
        /// One past the index of the last node in this node's subtree.
        var subtreeEnd: Int
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
        func walk(_ s: XCUIElementSnapshot, window: Int?) {
            let index = nodes.count
            let ownWindow = s.elementType == .window && window == nil ? index : window
            nodes.append(Node(
                elementType: s.elementType,
                label: s.label,
                identifier: s.identifier,
                frame: s.frame,
                subtreeEnd: index + 1,
                window: s.elementType == .application ? nil : ownWindow
            ))
            for child in s.children { walk(child, window: ownWindow) }
            nodes[index].subtreeEnd = nodes.count
        }
        walk(snapshot, window: nil)
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

        let targetIndex = locate(target)
        let keyboardWindows = self.keyboardWindows()
        let targetInKeyboard = targetIndex.flatMap { nodes[$0].window }.map(keyboardWindows.contains) ?? false

        var clips: [(rect: CGRect, name: String)] = []
        if !targetInKeyboard, let region = keyboardRegion(keyboardWindows: keyboardWindows) {
            clips.append((region, "the keyboard"))
        }
        for (i, node) in nodes.enumerated() where Self.barTypes.contains(node.elementType) {
            if let w = node.window, keyboardWindows.contains(w) { continue }
            if isAncestor(i, of: targetIndex, targetFrame: target.frame) { continue }
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
        if isHittable { return .clear(point: point) }
        // Without the target's place in the tree there is no telling what is
        // drawn over it — no evidence of a cover.
        guard let t = targetIndex else { return .clear(point: point) }

        var cover: Node?
        for i in nodes[t].subtreeEnd..<nodes.count {
            let node = nodes[i]
            if let w = node.window, keyboardWindows.contains(w), !targetInKeyboard { continue }
            guard isSubstantive(node), node.frame.contains(point) else { continue }
            cover = node
        }
        if let cover { return .covered(by: describe(cover)) }
        return .clear(point: point)
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

    private func isAncestor(_ i: Int, of target: Int?, targetFrame: CGRect) -> Bool {
        if let t = target { return i < t && nodes[i].subtreeEnd > t }
        // Unknown place in the tree: a bar that fully contains the target
        // (a back button, a tab) is taken to be its ancestor.
        return nodes[i].frame.contains(targetFrame)
    }

    // MARK: - Keyboard

    /// Top-level windows that host the software keyboard: any window holding
    /// a `.keyboard` node or the remote input view (`inputView`, observed on
    /// iOS 26 in a separate window from the keys).
    func keyboardWindows() -> Set<Int> {
        var windows = Set<Int>()
        for node in nodes {
            guard let w = node.window else { continue }
            if node.elementType == .keyboard || node.identifier == "inputView" {
                windows.insert(w)
            }
        }
        return windows
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

        if keyboard.maxY >= screen.maxY - Self.dockedKeyboardSlack {
            return CGRect(x: screen.minX, y: top, width: screen.width, height: screen.maxY - top)
        }
        return CGRect(x: keyboard.minX, y: top, width: keyboard.width, height: keyboard.maxY - top)
    }

    // MARK: - Helpers

    static let barTypes: Set<XCUIElement.ElementType> = [.navigationBar, .tabBar, .toolbar]

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
