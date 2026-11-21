import XCTest

/// The label a settings row's control takes from its row, for getByLabel:
/// the row's title. iOS half of Android's RowName.kt.
///
/// UIKit labels a control in a `UITableViewCell` (an accessory `UISwitch`,
/// or one laid out in the content view) with its row's texts joined by
/// ", ", as VoiceOver reads them: a row titled "Wi-Fi" with the subtitle
/// "Join known networks" gives its switch the label "Wi-Fi, Join known
/// networks" (measured on iOS 18.5, 26.5 and 27.2 simulators). So
/// `getByRole("switch", { name: "Wi-Fi" })` already finds it, but
/// `getByLabel("Wi-Fi")`, which compares the whole label, did not. On
/// Android the same row's switch is labelled by the row's title, and the
/// subtitle describes the setting rather than labelling it.
///
/// So a checkable control whose own label is exactly that derived label is
/// marked with its row's title (`labelKey`), which LabelMatch also matches
/// and the hierarchy dump writes as `tapsmith-label`, so the picker can
/// suggest the title, which a changing subtitle does not break. A control
/// with a label of its own (`accessibilityLabel = "Bluetooth radio"`) keeps
/// it alone.
///
/// The row is the control's nearest `.cell` within `maxRowDepth` levels; a
/// list, scroll view or another checkable control in between means it is
/// not the row's control. The row's text is its static texts in tree order,
/// not counting what other controls hold (a "More Info" button, a SwiftUI
/// Toggle's own text), a row's accessory indicator or the hooks marker.
enum RowName {
    /// The row label set on a control, read by LabelMatch.
    static let labelKey = "tapsmith.rowLabel"

    /// The hierarchy dump's attribute for the row label, as on Android.
    static let labelDumpAttribute = "tapsmith-label"

    /// How many levels below its row a control may be.
    static let maxRowDepth = 4

    /// The control types a row labels: the checkable ones, as on Android.
    static let checkableTypes: Set<XCUIElement.ElementType> = [.switch, .toggle, .checkBox, .radioButton]

    /// The types no row is above: they hold rows.
    private static let containerTypes: Set<XCUIElement.ElementType> = [
        .table, .collectionView, .scrollView, .outline,
    ]

    /// The row label marked on `node`, or "".
    static func label(of node: [String: Any]) -> String {
        node[labelKey] as? String ?? ""
    }

    /// Mark every row-labelled control in `dict` (a string-keyed snapshot
    /// dictionary) with its row's title.
    static func markRowLabels(in dict: inout [String: Any]) {
        mark(&dict)
    }

    /// The row's text parts, in tree order.
    static func textParts(ofRow row: [String: Any]) -> [String] {
        var parts: [String] = []
        collectText(row, depth: 0, into: &parts)
        return parts
    }

    /// The row label `control` takes from `row`'s text parts, or nil: their
    /// first part, when the control is checkable and its own label is them
    /// joined by ", ".
    static func rowLabel(control: [String: Any], rowParts: [String]) -> String? {
        guard checkableTypes.contains(elementType(of: control)), let title = rowParts.first else { return nil }
        let label = TextMatch.normalize(control["label"] as? String ?? "")
        guard !label.isEmpty, label == TextMatch.normalize(rowParts.joined(separator: ", ")) else { return nil }
        return title
    }

    @discardableResult
    private static func mark(_ dict: inout [String: Any]) -> Bool {
        guard var children = dict["children"] as? [[String: Any]] else { return false }
        var changed = false
        if elementType(of: dict) == .cell {
            let parts = textParts(ofRow: dict)
            if !parts.isEmpty {
                for i in children.indices where markControls(in: &children[i], rowParts: parts, depth: 1) {
                    changed = true
                }
            }
        }
        // Rows nested anywhere below, including inside this one.
        for i in children.indices where mark(&children[i]) {
            changed = true
        }
        if changed { dict["children"] = children }
        return changed
    }

    /// Mark the row's controls in `node`, `depth` levels below the row.
    private static func markControls(in node: inout [String: Any], rowParts: [String], depth: Int) -> Bool {
        let type = elementType(of: node)
        if checkableTypes.contains(type) {
            // Another checkable control's parts (a SwiftUI Toggle's knob)
            // are its, not the row's.
            guard let title = rowLabel(control: node, rowParts: rowParts) else { return false }
            node[labelKey] = title
            return true
        }
        guard depth < maxRowDepth, type != .cell, !containerTypes.contains(type),
              var children = node["children"] as? [[String: Any]]
        else { return false }
        var changed = false
        for i in children.indices where markControls(in: &children[i], rowParts: rowParts, depth: depth + 1) {
            changed = true
        }
        if changed { node["children"] = children }
        return changed
    }

    private static func collectText(_ node: [String: Any], depth: Int, into parts: inout [String]) {
        guard depth < DescendantText.maxDepth, let children = node["children"] as? [[String: Any]] else { return }
        for child in children {
            let label = child["label"] as? String ?? ""
            if NonAppElements.isHooksMarker(label: label, title: child["title"] as? String ?? "",
                                            value: child["value"] as? String ?? "") { continue }
            switch elementType(of: child) {
            case .staticText:
                let text = TextMatch.normalize(label.isEmpty ? child["value"] as? String ?? "" : label)
                if !text.isEmpty { parts.append(text) }
            case .other:
                collectText(child, depth: depth + 1, into: &parts)
            default:
                // A control, an image, a nested row: not the row's text.
                continue
            }
        }
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
