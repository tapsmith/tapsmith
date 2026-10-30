import XCTest

/// The text a container shows through its descendants, for an element with
/// no value, title or label of its own (`ElementInfo.text` on the snapshot
/// path, which `toHaveText`, `toContainText` and `filter({ hasText })` read).
/// Mirrors Android's `collectDescendantText`.
enum DescendantText {
    /// Maximum recursion depth. Mirrors Android's `MAX_DESCENDANT_TEXT_DEPTH`
    /// so both platforms bound worst-case aggregation cost identically.
    static let maxDepth = 6

    /// Whether an element of `type` with no text of its own reports its
    /// descendants' text.
    ///
    /// - `.other`: wrapping containers, e.g. a React Native
    ///   `<View accessibilityRole="alert">` around its `<Text>`.
    /// - `.cell`: a UIKit table row, whose text is a child static text
    ///   (PILOT-895). Without it, `getByRole("listitem")
    ///   .filter({ hasText })` matched no UIKit row; Android rows aggregate.
    ///
    /// Other typed elements keep no text, so e.g. `toHaveText` on a table or
    /// a scroll view does not read out its whole content.
    static func aggregates(_ type: XCUIElement.ElementType) -> Bool {
        type == .other || type == .cell
    }

    /// Walk a snapshot subtree and join its descendants' text: each child
    /// gives its value, title or label, or, when it has none, its own
    /// descendants' text. Not part of any text: the hooks marker
    /// (`NonAppElements`) and a table row's accessory indicator
    /// (`CellAccessories`, marked by `normalizeIndicators`).
    static func collect(_ node: [String: Any], depth: Int = 0) -> String {
        if depth >= maxDepth { return "" }
        var parts: [String] = []
        if let children = node["children"] as? [[String: Any]] {
            for child in children {
                if NonAppElements.isHooksMarker(
                    label: child["label"] as? String ?? "",
                    title: child["title"] as? String ?? "",
                    value: child["value"] as? String ?? ""
                ) { continue }
                if CellAccessories.isMarkedIndicator(child) { continue }
                let ownText: String?
                if let v = child["value"] as? String, !v.isEmpty {
                    ownText = v
                } else if let t = child["title"] as? String, !t.isEmpty {
                    ownText = t
                } else if let l = child["label"] as? String, !l.isEmpty {
                    ownText = l
                } else {
                    ownText = nil
                }
                if let own = ownText {
                    // Child labels its own visible content; iOS accessibility
                    // typically auto-concatenates descendant text into the
                    // parent label already, so recursing further would
                    // duplicate ("Hello Hello").
                    parts.append(own)
                } else {
                    let nested = collect(child, depth: depth + 1)
                    if !nested.isEmpty { parts.append(nested) }
                }
            }
        }
        return parts.joined(separator: " ")
    }
}
