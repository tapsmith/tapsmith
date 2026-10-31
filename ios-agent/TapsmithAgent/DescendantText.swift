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
    /// (`NonAppElements`), a table row's accessory indicator
    /// (`CellAccessories`, marked by `normalizeIndicators`) and a control
    /// whose label and value are not text on screen (`TextContent`).
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
                // A control whose label only names it and whose value is
                // not text on screen (TextContent.nameOnlyTypes: a switch's
                // "0"/"1", a slider's or a stepper's value) adds none of its
                // own: a UIKit settings row with a switch reads "Wi-Fi", not
                // "Wi-Fi 1". A SwiftUI Toggle row's switch holds the label's
                // static text (and its unlabelled knob), so its children
                // still count. A stepper's are its "<label>, Increment"
                // buttons and a slider has none: neither is text on screen.
                let type = elementType(of: child)
                if TextContent.nameOnlyTypes.contains(type) {
                    if type == .switch || type == .toggle {
                        let nested = collect(child, depth: depth + 1)
                        if !nested.isEmpty { parts.append(nested) }
                    }
                    continue
                }
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

    private static func elementType(of dict: [String: Any]) -> XCUIElement.ElementType {
        let raw: UInt?
        switch dict["elementType"] {
        case let v as UInt: raw = v
        case let v as Int: raw = v >= 0 ? UInt(v) : nil
        case let v as NSNumber: raw = UInt(v.uint64Value)
        default: raw = nil
        }
        return raw.flatMap { XCUIElement.ElementType(rawValue: $0) } ?? .other
    }
}
