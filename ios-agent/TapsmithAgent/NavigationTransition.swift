import XCTest

/// A navigation stack's push or pop in progress, as a snapshot shows it
/// (PILOT-985).
///
/// While a `UINavigationController` animates (a native stack in React Native,
/// a SwiftUI `NavigationStack`), both screens are in the accessibility tree:
/// for about half a second, or a sixth of that with Reduce Motion. Frames are
/// model values, so each screen already reads where it ends up. A locator
/// resolved then sees the outgoing screen's elements too, some of them at
/// on-screen frames: a back button that every screen has is ambiguous, and an
/// index into its matches means nothing to a live query answered a moment
/// later, when the outgoing screen has gone.
///
/// So a locator doesn't resolve against such a tree: `settle` reads again until
/// the transition is over. The wait is short (a touch couldn't land during the
/// transition anyway), and bounded, since all that can be told about a tree is
/// its shape: a full-screen carousel that isn't in a scroll view looks the same.
/// A shape that outlasts the bound is taken for what it is, and resolved against.
///
/// Measured on iOS 26.4 and 18.5, react-native-screens and SwiftUI: the screens
/// are `.other` children of an `.other` of the same size. The incoming one is
/// at its parent's frame. The outgoing one is level with it, 30% aside on a
/// push (the parallax) and one whole width aside on a pop. Not told apart:
/// transitions that keep the screens aligned (a fade), and modal presentations.
///
/// Kept free of XCUITest's live API so the host unit tests can drive it
/// (`ios-agent/Tests/run-unit-tests.sh`).
enum NavigationTransition {
    /// Longest wait for a transition to end. It runs 0.5 s on a fast machine,
    /// more on a starved CI simulator. A look-alike pays this whenever its
    /// shape changes.
    static let maxWaitSeconds: TimeInterval = 2
    /// Pause between reads. A read takes about as long again.
    static let pollSeconds: TimeInterval = 0.05
    /// Room left before the daemon's read deadline to resolve and answer.
    static let readDeadlineMarginSeconds: TimeInterval = 0.25
    /// Slack in comparing frames: they can be fractional on one side only.
    private static let tolerance: CGFloat = 1

    /// What identifies the transition `tree` shows, or nil when it shows none.
    static func signature(of tree: [String: Any]) -> String? {
        signature(of: tree, window: frame(of: tree).size)
    }

    /// Wait for the tree to stop showing a transition, and return the last one
    /// read. `known` is the shape that last outlasted the wait, which isn't
    /// waited for again while it stays: a look-alike would otherwise cost every
    /// locator the whole bound.
    static func settle<Tree>(
        first: Tree,
        signature: (Tree) -> String?,
        known: inout String?,
        readDeadline: Date?,
        now: () -> Date,
        sleep: (TimeInterval) -> Void,
        next: () throws -> Tree
    ) rethrows -> Tree {
        var tree = first
        var current = signature(tree)
        guard current != nil else {
            known = nil
            return tree
        }
        guard current != known else { return tree }
        let cap = now().addingTimeInterval(maxWaitSeconds)
        let deadline = readDeadline.map { min(cap, $0.addingTimeInterval(-readDeadlineMarginSeconds)) } ?? cap
        while now().addingTimeInterval(pollSeconds) < deadline {
            sleep(pollSeconds)
            tree = try next()
            current = signature(tree)
            if current == nil {
                known = nil
                return tree
            }
        }
        // A wait the daemon's deadline cut short says nothing about the shape.
        if deadline == cap { known = current }
        return tree
    }

    private static func signature(of node: [String: Any], window: CGSize) -> String? {
        let children = node["children"] as? [[String: Any]] ?? []
        if let found = shiftedScreen(in: node, children: children, window: window) { return found }
        for child in children {
            if let found = signature(of: child, window: window) { return found }
        }
        return nil
    }

    private static func shiftedScreen(in node: [String: Any], children: [[String: Any]], window: CGSize) -> String? {
        guard children.count >= 2, elementType(of: node) == .other else { return nil }
        let parent = frame(of: node)
        guard parent.width * 2 >= window.width, parent.height * 2 >= window.height else { return nil }
        let screens = children.filter { elementType(of: $0) == .other }.map { frame(of: $0) }
        guard screens.contains(where: { same($0.minX, parent.minX) && isScreen($0, in: parent) }) else { return nil }
        guard let outgoing = screens.first(where: { screen in
            guard isScreen(screen, in: parent) else { return false }
            let shift = abs(screen.minX - parent.minX)
            return shift > tolerance && shift <= parent.width + tolerance
        }) else { return nil }
        return "\(Int(parent.minX)),\(Int(parent.width))x\(Int(parent.height)) \(Int(outgoing.minX))"
    }

    /// Whether `screen` is as big as `parent` and level with it.
    private static func isScreen(_ screen: CGRect, in parent: CGRect) -> Bool {
        same(screen.width, parent.width) && same(screen.height, parent.height) && same(screen.minY, parent.minY)
    }

    private static func same(_ a: CGFloat, _ b: CGFloat) -> Bool {
        abs(a - b) <= tolerance
    }

    private static func elementType(of dict: [String: Any]) -> XCUIElement.ElementType {
        let raw = (dict["elementType"] as? UInt) ?? (dict["elementType"] as? NSNumber)?.uintValue ?? 0
        return XCUIElement.ElementType(rawValue: raw) ?? .other
    }

    /// Same keys as `SnapshotElementFinder.parseFrame`.
    private static func frame(of dict: [String: Any]) -> CGRect {
        guard let f = dict["frame"] as? [String: Any] else { return .zero }
        return CGRect(
            x: (f["X"] as? Double) ?? (f["x"] as? Double) ?? 0,
            y: (f["Y"] as? Double) ?? (f["y"] as? Double) ?? 0,
            width: (f["Width"] as? Double) ?? (f["width"] as? Double) ?? 0,
            height: (f["Height"] as? Double) ?? (f["height"] as? Double) ?? 0
        )
    }
}
