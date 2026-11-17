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
/// navigation bar. A button labelled exactly "Back" in a bar counts too: an
/// app's own back button, or UIKit's when the previous title is too long.
enum BackButton {
    static let identifier = "BackButton"
    static let label = "Back"

    /// The bars a back button is drawn in: the navigation bar, and iOS 27's
    /// toolbar host (a `.toolbar` node). Never a tab bar.
    static let barTypes: Set<XCUIElement.ElementType> = [.navigationBar, .toolbar]

    enum Resolution: Equatable {
        /// Touch `point`, held as a button in `ancestorTypes` (`TapTiming`).
        case tap(point: CGPoint, ancestorTypes: [XCUIElement.ElementType])
        /// The screen has a back button, but something is drawn over it
        /// (an alert, a sheet's bar): `by` names it.
        case covered(by: String)
        /// No back button on screen.
        case none
    }

    /// Whether node `i` is a back button: a button identified or labelled
    /// as one, inside a navigation bar or a toolbar.
    static func isBackButton(_ i: Int, in analyzer: OcclusionAnalyzer) -> Bool {
        let node = analyzer.nodes[i]
        guard node.elementType == .button,
              node.identifier == identifier || node.label == label else { return false }
        return analyzer.ancestors(of: i).contains { barTypes.contains(analyzer.nodes[$0].elementType) }
    }

    /// The back button to touch. Of several (both screens of a push still in
    /// the tree, a stack inside a presented screen), the one painted last
    /// that nothing covers. One that is covered is reported as such only
    /// when no other can be touched; one that is off screen is no back
    /// button for this screen.
    ///
    /// The touch goes to the center of the button's on-screen part, and the
    /// only covers are interactive elements painted after it (an alert, a
    /// presented screen's controls). Bars are not covers here, unlike for an
    /// element tap (`OcclusionAnalyzer.analyze`): the button is part of a
    /// bar, and on iOS 27 it can sit in the Toolbar host over the navigation
    /// bar's frame.
    static func resolve(in analyzer: OcclusionAnalyzer) -> Resolution {
        var cover: String?
        for i in analyzer.nodes.indices.reversed() where isBackButton(i, in: analyzer) {
            let node = analyzer.nodes[i]
            let visible = node.frame.intersection(analyzer.screen)
            guard !visible.isNull,
                  visible.width >= OcclusionAnalyzer.minVisibleExtent,
                  visible.height >= OcclusionAnalyzer.minVisibleExtent else { continue }
            let point = CGPoint(x: visible.midX, y: visible.midY)
            let target = OcclusionAnalyzer.Target(
                frame: node.frame, elementType: node.elementType, label: node.label, identifier: node.identifier
            )
            if let by = analyzer.interactiveCover(of: target, at: [point]) {
                if cover == nil { cover = by }
                continue
            }
            return .tap(point: point, ancestorTypes: analyzer.ancestors(of: i).map { analyzer.nodes[$0].elementType })
        }
        return cover.map { .covered(by: $0) } ?? .none
    }
}
