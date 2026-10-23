import XCTest
import Foundation

/// What no user locator matches (PILOT-756, PILOT-830): the parts of the app's
/// accessibility tree that are not the app's own content.
///
/// - The application element. Its label is the app's name, so `getByText`
///   of any word in that name matched it.
/// - Everything inside the software keyboard (`.keyboard`): its keys and its
///   return, globe and dictation buttons, so a "Done" button next to an open
///   keyboard is not ambiguous with the keyboard's Done key. An input
///   accessory toolbar above the keyboard is the app's, and matches.
/// - The `@tapsmith/react-native` hooks marker, which exists only for
///   Tapsmith to read (CommandHandler's epoch wait, the daemon's dump parse).
///
/// The one place the agent decides it: the snapshot walk (findElements,
/// evaluateSelectors) asks `excludesNode` / `excludesSubtree`, and live
/// XCUIElement queries AND in `notHooksMarker` and check a first match against
/// the keyboard with `liesInKeyboard`. The trace viewer applies the same rule
/// to dumps (packages/tapsmith non-app-nodes.ts), and the Android agent its
/// own (NonAppNodes.kt).
enum NonAppElements {
    /// `@tapsmith/react-native`'s marker prefix; pinned to the SDK's
    /// HOOKS_MARKER_PREFIX by non-app-nodes.test.ts.
    static let hooksMarkerPrefix = "tapsmith-hooks:"

    /// Whether `text` is a hooks marker.
    static func isHooksMarker(_ text: String) -> Bool {
        text.hasPrefix(hooksMarkerPrefix)
    }

    /// Whether a node with these texts is a hooks marker (either copy: older
    /// package versions also drew a visible one). It is no one's visible
    /// text either, so a container's aggregated text leaves it out.
    static func isHooksMarker(label: String, title: String, value: String) -> Bool {
        isHooksMarker(label) || isHooksMarker(title) || isHooksMarker(value)
    }

    /// Whether no locator matches this node itself (its descendants still can).
    static func excludesNode(
        elementType: XCUIElement.ElementType,
        label: String,
        title: String,
        value: String
    ) -> Bool {
        elementType == .application || isHooksMarker(label: label, title: title, value: value)
    }

    /// Whether no locator matches this node or anything inside it.
    static func excludesSubtree(elementType: XCUIElement.ElementType) -> Bool {
        elementType == .keyboard
    }

    /// AND this into a live query so it never returns a hooks marker. Label
    /// only: `value` can be a number, which BEGINSWITH can't compare, and the
    /// marker is a text, whose label is its text.
    static let notHooksMarker = NSPredicate(format: "NOT (label BEGINSWITH %@)", hooksMarkerPrefix)

    /// Whether an element with `frame`, found by a live query, is part of the
    /// keyboard occupying `keyboardFrame`: its centre lies inside it. App
    /// content the keyboard covers reads as inside too: the wait engine
    /// re-checks such a match through the snapshot walk, and scroll-to-target
    /// skips it (it can't be tapped while covered anyway).
    static func liesInKeyboard(_ frame: CGRect, keyboardFrame: CGRect) -> Bool {
        guard !keyboardFrame.isEmpty, !frame.isNull else { return false }
        return keyboardFrame.contains(CGPoint(x: frame.midX, y: frame.midY))
    }
}

extension XCUIElementQuery {
    /// This query without the hooks marker (NonAppElements).
    func excludingHooksMarker() -> XCUIElementQuery {
        matching(NonAppElements.notHooksMarker)
    }
}
