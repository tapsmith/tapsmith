import XCTest

/// Where `pressKey("back")` touches (PILOT-1225). iOS has no back key, so the
/// agent taps the navigation stack's own back button — and only that: a
/// screen without one (a stack's root, a sheet) refuses rather than tapping
/// whatever else is in its bar (an Edit or Close button).
///
/// UIKit gives the system back button the identifier `BackButton`, in UIKit
/// and SwiftUI stacks alike (its label is the previous screen's title). It is
/// a child of the navigation bar up to iOS 26, and on iOS 26/27 iPhones;
/// iOS 27 can instead lay it out in the window's floating `Toolbar` host
/// (seen on the iPhone Duo, trailing rather than leading), outside the
/// navigation bar. A button labelled exactly "Back" in a bar counts too, but
/// only when there is no system back button: an app's own back button, or
/// UIKit's when the previous title is too long — not an in-app browser's
/// Back in a bottom toolbar beside the stack's real one.
enum BackButton {
    static let identifier = "BackButton"
    static let label = "Back"

    /// The bars a back button is drawn in: the navigation bar, and iOS 27's
    /// toolbar host (a `.toolbar` node). Never a tab bar.
    static let barTypes: Set<XCUIElement.ElementType> = [.navigationBar, .toolbar]

    /// What is presented modally over the screen wherever its frame is: an
    /// alert or action sheet's box leaves the back button's point uncovered,
    /// but a touch there lands on its dimming view, not the button.
    static let overlayTypes: Set<XCUIElement.ElementType> = [.alert, .sheet, .dialog, .popover]

    /// How long a screen with no back button (or a covered one) is read
    /// again before the key refuses: a push just tapped may not have begun,
    /// and an alert just dismissed may still be in the tree.
    static let waitSeconds: TimeInterval = 1
    static let pollSeconds: TimeInterval = 0.1
    /// Room left before the daemon's read deadline to answer.
    static let deadlineMarginSeconds: TimeInterval = 0.25

    enum Resolution: Equatable {
        /// Touch `point`, held as a button in `ancestorTypes` (`TapTiming`).
        case tap(point: CGPoint, ancestorTypes: [XCUIElement.ElementType])
        /// The screen has a back button, but something is presented over it
        /// (an alert): `by` names it.
        case covered(by: String)
        /// No back button on screen.
        case none
    }

    /// How node `i` is a back button, if it is one: a button inside a
    /// navigation bar or a toolbar, identified as the system one (`.system`)
    /// or only labelled "Back" (`.labelled`).
    enum Match { case system, labelled }

    static func match(_ i: Int, in analyzer: OcclusionAnalyzer) -> Match? {
        let node = analyzer.nodes[i]
        guard node.elementType == .button else { return nil }
        let match: Match
        if node.identifier == identifier {
            match = .system
        } else if node.label == label {
            match = .labelled
        } else {
            return nil
        }
        guard analyzer.ancestors(of: i).contains(where: { barTypes.contains(analyzer.nodes[$0].elementType) })
        else { return nil }
        return match
    }

    /// The back button to touch: a system one if there is any on screen,
    /// else one labelled "Back". Of several (both screens of a push still in
    /// the tree, a stack inside a presented screen), the one painted last
    /// that nothing covers. One that is covered is reported as such only
    /// when no other can be touched; one that is off screen is no back
    /// button for this screen.
    ///
    /// The touch goes to the center of the button's on-screen part. Bars are
    /// not covers here, unlike for an element tap (`OcclusionAnalyzer`): the
    /// button is part of a bar, and on iOS 27 it can sit in the Toolbar host
    /// over the navigation bar's frame. Nor is the screen's own content: the
    /// iOS 27 host can come first in the tree (the iPhone Duo), so every
    /// control of the screen is "painted after" the button there. What does
    /// cover it is something presented over the screen (`cover(of:at:in:)`).
    static func resolve(in analyzer: OcclusionAnalyzer) -> Resolution {
        var covered: String?
        for wanted in [Match.system, .labelled] {
            for i in analyzer.nodes.indices.reversed() where match(i, in: analyzer) == wanted {
                let visible = analyzer.nodes[i].frame.intersection(analyzer.screen)
                guard !visible.isNull,
                      visible.width >= OcclusionAnalyzer.minVisibleExtent,
                      visible.height >= OcclusionAnalyzer.minVisibleExtent else { continue }
                let point = CGPoint(x: visible.midX, y: visible.midY)
                if let by = cover(of: i, at: point, in: analyzer) {
                    if covered == nil { covered = by }
                    continue
                }
                return .tap(point: point, ancestorTypes: analyzer.ancestors(of: i).map { analyzer.nodes[$0].elementType })
            }
            if covered != nil { break }
        }
        return covered.map { .covered(by: $0) } ?? .none
    }

    /// What is presented over back button `i`, described — or nil: an alert,
    /// action sheet, dialog or popover painted after it (anywhere: it is
    /// modal), or an interactive control in a later window (a presented
    /// controller's own window) at `point`.
    static func cover(of i: Int, at point: CGPoint, in analyzer: OcclusionAnalyzer) -> String? {
        let nodes = analyzer.nodes
        for j in nodes[i].subtreeEnd..<nodes.count {
            let node = nodes[j]
            if overlayTypes.contains(node.elementType) { return analyzer.describe(node) }
            let inLaterWindow = node.window != nil && node.window != nodes[i].window
            if inLaterWindow, OcclusionAnalyzer.interactiveTypes.contains(node.elementType), node.frame.contains(point) {
                return analyzer.describe(node)
            }
        }
        return nil
    }

    /// Whether a screen read at `now` with no back button to touch is read
    /// again: within `waitSeconds` of `started`, and while another read can
    /// still finish before the daemon's `deadline`.
    static func shouldReadAgain(started: Date, now: Date, deadline: Date?) -> Bool {
        var limit = started.addingTimeInterval(waitSeconds)
        if let deadline { limit = min(limit, deadline.addingTimeInterval(-deadlineMarginSeconds)) }
        return now.addingTimeInterval(pollSeconds) < limit
    }
}
