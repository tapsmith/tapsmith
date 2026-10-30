import XCTest

/// UIKit's built-in table-row accessory indicators (PILOT-895).
///
/// A `UITableViewCell` with `accessoryType = .disclosureIndicator` or
/// `.checkmark` exposes its indicator to accessibility as a childless
/// `.button` labelled "chevron" or "checkmark", with the not-enabled trait.
/// It is decoration, not a control: a touch on it selects the row, like a
/// touch anywhere else on the row. Read at face value, `toBeEnabled()` fails
/// on it and every action refuses it as disabled. Its label is not text the
/// row displays either, so a row's text must not include it.
///
/// So, in a snapshot dictionary, such a node takes its cell's enabled state
/// and is marked (`indicatorKey`), which `DescendantText` reads.
///
/// The traits cannot tell the indicator from a real disabled button (both
/// read 0x200000101 on an iOS 26 simulator), so the rule is narrow: a direct
/// child of a cell, a `.button`, not enabled, with no children, labelled
/// exactly as UIKit labels its indicators. A custom `accessoryView` button
/// has a title child, or another label, and keeps its own state. The
/// detail button ("More Info") is a real, enabled control and is left alone.
enum CellAccessories {
    /// Set to `true` on a node the rule recognised as an accessory indicator.
    static let indicatorKey = "tapsmith.cellAccessoryIndicator"

    /// The labels UIKit gives its built-in accessory indicators.
    static let indicatorLabels: Set<String> = ["chevron", "checkmark"]

    /// Whether `child`, a direct child of a `.cell`, is a built-in accessory
    /// indicator, judged on the snapshot's own values.
    static func isIndicator(_ child: [String: Any]) -> Bool {
        guard elementType(of: child) == .button,
              (child["enabled"] as? Bool) == false,
              (child["children"] as? [[String: Any]] ?? []).isEmpty
        else { return false }
        return indicatorLabels.contains(child["label"] as? String ?? "")
    }

    /// Whether the rule marked `node` as an accessory indicator.
    static func isMarkedIndicator(_ node: [String: Any]) -> Bool {
        node[indicatorKey] as? Bool ?? false
    }

    /// Give every accessory indicator in `dict` (a string-keyed snapshot
    /// dictionary) its cell's enabled state, and mark it.
    static func normalizeIndicators(in dict: inout [String: Any]) {
        normalize(&dict)
    }

    /// Returns whether anything in `dict` changed, so unchanged subtrees are
    /// not written back (each write copies the dictionary).
    @discardableResult
    private static func normalize(_ dict: inout [String: Any]) -> Bool {
        guard var children = dict["children"] as? [[String: Any]] else { return false }
        let isCell = elementType(of: dict) == .cell
        let cellEnabled = dict["enabled"] as? Bool ?? true
        var changed = false
        for i in children.indices {
            if isCell && isIndicator(children[i]) {
                children[i]["enabled"] = cellEnabled
                children[i][indicatorKey] = true
                changed = true
            } else if normalize(&children[i]) {
                changed = true
            }
        }
        if changed { dict["children"] = children }
        return changed
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
