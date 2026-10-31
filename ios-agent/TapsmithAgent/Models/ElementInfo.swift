import Foundation
import XCTest

/// Selector specification for finding elements.
/// Mirrors the Android agent's ElementSelector data class.
struct ElementSelector {
    var role: String?
    var name: String?
    /// getByRole `{ exact: true }`: match `name` case-sensitively and whole (PILOT-549).
    var nameExact: Bool = false
    /// getByRole `{ name: RegExp }` (PILOT-520); SelectorParser then leaves `name` nil.
    var nameRegex: TextRegex?
    var text: String?
    var textContains: String?
    /// getByText(RegExp) (PILOT-520): tested against label, title or value.
    var textRegex: TextRegex?
    var contentDesc: String?
    var hint: String?
    var className: String?
    var testId: String?
    var id: String?
    var xpath: String?
    var label: String?
    /// getByLabel(RegExp) (PILOT-520): tested against an input's label or title.
    var labelRegex: TextRegex?
    var enabled: Bool?
    var checked: Bool?
    var focused: Bool?
    var selected: Bool?
    var expanded: Bool?

    /// Whether a role selector filters by name, as a string or a RegExp.
    var hasNameFilter: Bool { name != nil || nameRegex != nil }

    /// Why a RegExp in this selector can't be used (ICU rejected it), if so.
    var regexError: String? {
        [nameRegex, textRegex, labelRegex].compactMap { $0?.error }.first
    }

    /// Whether a match is re-resolved as a live element by its own label
    /// (QueryIndex.liveIndex) rather than by the selector — needed when the
    /// selector also matches other labels (a substring role name, PILOT-549;
    /// a RegExp, PILOT-520; a case-insensitive substring getByText, PILOT-522)
    /// and would shift the positional index — or, for exact getByText,
    /// whose label query also returns the matches' suppressed ancestors and
    /// the controls TextContent leaves out (PILOT-794).
    var reResolvesByLabel: Bool {
        (role != nil && hasNameFilter) || textRegex != nil || labelRegex != nil || textContains != nil
            || text != nil
    }

    /// Whether the selector is a getByText one, whose matches give way to a
    /// matching descendant (innermost, TextContent, PILOT-794).
    var matchesInnermostOnly: Bool {
        text != nil || textContains != nil || textRegex != nil
    }

    /// Whether a role-only selector's match is re-resolved by its own label
    /// too: the roles no element-type query can express (a heading's trait,
    /// an RN checkbox's description), whose type-query index would count
    /// other elements (PILOT-608).
    var roleOnlyReResolvesByLabel: Bool {
        guard let role, !hasNameFilter else { return false }
        return RoleMapping.needsLabelReResolution(role: role)
    }

    /// Whether this is `getByRole("switch")` with no name: a named match is
    /// found again by its own label, since a live switch query also returns
    /// SwiftUI Toggle knobs, out of tree order (PILOT-790).
    var roleOnlySwitch: Bool {
        guard let role, !hasNameFilter else { return false }
        return RoleMapping.normalize(role) == "switch"
    }

    /// Whether this is `getByRole("textfield")` with no name: a live
    /// textfield query also returns read-only text views, which the match set
    /// leaves out (RoleMapping.isReadOnlyTextView, PILOT-697).
    var roleOnlyTextField: Bool {
        guard let role, !hasNameFilter else { return false }
        return RoleMapping.normalize(role) == "textfield"
    }
}

/// Bounding rectangle for an element.
struct ElementBounds {
    let left: Int
    let top: Int
    let right: Int
    let bottom: Int

    var centerX: Int { (left + right) / 2 }
    var centerY: Int { (top + bottom) / 2 }
    var width: Int { right - left }
    var height: Int { bottom - top }

    func toDict() -> [String: Any] {
        return [
            "left": left,
            "top": top,
            "right": right,
            "bottom": bottom,
            "centerX": centerX,
            "centerY": centerY,
            "width": width,
            "height": height,
        ]
    }
}

/// Information about a found UI element.
/// Mirrors the Android agent's ElementInfo data class and the proto ElementInfo message.
struct ElementInfo {
    let elementId: String
    let className: String
    let text: String?
    let contentDescription: String?
    let resourceId: String?
    let hint: String?
    let bounds: ElementBounds
    let isEnabled: Bool
    let isChecked: Bool
    let isFocused: Bool
    let isClickable: Bool
    let isFocusable: Bool
    let isScrollable: Bool
    let isVisible: Bool
    let isSelected: Bool
    /// Number of direct children of this element.
    ///
    /// **Path asymmetry — read with care:**
    /// - The snapshot path (`SnapshotElementFinder` / `findElementsBySnapshot`) populates this from the snapshot dictionary, so it reflects the true accessibility-tree fan-out.
    /// - The live `XCUIElement` path (`makeFromXCUIElement`) returns `0` regardless of the actual child count — calling `element.children(...)` here would synchronously dump the subtree, which is the exact cost we built the snapshot path to avoid.
    ///
    /// In practice the snapshot path serves all SDK queries, so consumers see real counts. Don't read this field from internal call sites that may have come through the live path without verifying which finder produced the `ElementInfo`.
    let childCount: Int
    let role: String
    let viewportRatio: Float
    /// The element is a native alert or inside one (PILOT-862): the SDK
    /// keeps an alert's contents and the app views behind it out of each
    /// other's scope by it. Only the snapshot walk can see an element's
    /// ancestors, so the live `XCUIElement` path leaves it false; the SDK
    /// scopes with snapshot (`findElements`) results only.
    var inAlert: Bool = false

    func toDict() -> [String: Any] {
        var dict: [String: Any] = [
            "elementId": elementId,
            "className": className,
            "bounds": bounds.toDict(),
            "enabled": isEnabled,
            "checked": isChecked,
            "focused": isFocused,
            "clickable": isClickable,
            "focusable": isFocusable,
            "scrollable": isScrollable,
            "visible": isVisible,
            "selected": isSelected,
            "childCount": childCount,
            "role": role,
            "viewportRatio": Double(viewportRatio),
            "inAlert": inAlert,
        ]
        // Use NSNull for nil values to match Android's JSONObject.NULL behavior
        dict["text"] = text as Any? ?? NSNull()
        dict["contentDescription"] = contentDescription as Any? ?? NSNull()
        dict["resourceId"] = resourceId as Any? ?? NSNull()
        dict["hint"] = hint as Any? ?? NSNull()
        return dict
    }

    /// Build an `ElementInfo` from a live `XCUIElement`.
    ///
    /// Both `SnapshotElementFinder.toElementInfo(_ element:elementId:)` and
    /// `ElementFinder.toElementInfo(_ element:elementId:)` route through
    /// here so the two XCUIElement-based code paths can't drift on text
    /// derivation, role resolution, hint surfacing, or checked-state
    /// detection. Past dual-implementation bugs (round-7 `text`, round-8
    /// `checkedState`, round-cold-4 `traits`-aware role) were caused by
    /// only updating one of the two parallel methods. Keep this helper
    /// the single source of truth for live-element conversion.
    ///
    /// `bounds` and `viewportRatio` are pre-computed by the caller
    /// because each path measures the screen differently. `traits` is
    /// resolved here via KVC (with a `responds(to:)` guard, mirroring
    /// `SnapshotElementFinder.annotateTraits`) so the returned `role`
    /// honours React Native `accessibilityRole` flags. A live element can't
    /// see its ancestors, so the caller says whether it is inside a tab bar
    /// (`inTabBar`, from find time), which makes a button a tab (PILOT-514).
    static func makeFromXCUIElement(
        _ element: XCUIElement,
        elementId: String,
        bounds: ElementBounds,
        viewportRatio: Float,
        inTabBar: Bool
    ) -> ElementInfo {
        let elType = element.elementType
        let label = element.label
        let identifier = element.identifier
        // Only text-input elements carry a meaningful `placeholderValue`.
        // Reading it on every element is an extra IPC per node that adds up
        // on screens with many siblings; gating here keeps the live-element
        // path lean for non-text widgets where the value is always nil.
        let isTextInput = elType == .textField
            || elType == .secureTextField
            || elType == .textView
            || elType == .searchField
        let placeholderValue = isTextInput ? (element.placeholderValue ?? "") : ""
        let value = element.value as? String

        let className = RoleMapping.typeName(for: elType)
        let traits = ElementInfo.extractTraits(from: element)
        let role = RoleMapping.resolveRole(for: elType, traits: traits, inTabBar: inTabBar)

        let isSelected = element.isSelected
        let isChecked = ElementInfo.deriveCheckedState(
            elementType: elType,
            value: value,
            selected: isSelected
        )

        let displayText = ElementInfo.deriveDisplayText(
            elementType: elType,
            value: value,
            placeholderValue: placeholderValue,
            label: label
        )

        return ElementInfo(
            elementId: elementId,
            className: className,
            text: displayText,
            contentDescription: label.isEmpty ? nil : label,
            resourceId: identifier.isEmpty ? nil : identifier,
            hint: placeholderValue.isEmpty ? nil : placeholderValue,
            bounds: bounds,
            isEnabled: element.isEnabled,
            isChecked: isChecked,
            isFocused: element.hasFocus,
            isClickable: bounds.width > 0 && bounds.height > 0,
            isFocusable: true,
            isScrollable: elType == .scrollView
                || elType == .table
                || elType == .collectionView,
            isVisible: viewportRatio > 0,
            isSelected: isSelected,
            // Always 0 on the live XCUIElement path. See the `childCount`
            // doc on the struct for the asymmetry vs. the snapshot path.
            childCount: 0,
            role: role,
            viewportRatio: viewportRatio
        )
    }

    /// Text-derivation rules shared by both XCUIElement paths and the
    /// snapshot-dict path's textfield branch. For text fields surface
    /// only the typed value (placeholder-equal value reads as empty);
    /// other element types fall back to value, then label.
    ///
    /// **Live-vs-snapshot divergence:** the snapshot path's
    /// `DescendantText.collect` aggregates the
    /// labels of an `.other` wrapper's (or a `.cell`'s) descendants when the wrapper has
    /// no value/label of its own — so a `Pressable` with an inner
    /// `<Text>Submit</Text>` reads as `"Submit"` via the snapshot path.
    /// The live `XCUIElement` path here does NOT walk descendants
    /// (calling `element.children(...)` is the cost we built the
    /// snapshot path to avoid), so the same wrapper read live returns
    /// `nil`. In practice all SDK queries route through the snapshot
    /// path, so consumers see aggregated text; any future code wiring
    /// this method into a query path needs to accept the divergence or
    /// add an explicit descendant aggregator here.
    static func deriveDisplayText(
        elementType: XCUIElement.ElementType,
        value: String?,
        placeholderValue: String,
        label: String
    ) -> String? {
        let isTextField =
            elementType == .textField || elementType == .secureTextField
                || elementType == .textView || elementType == .searchField
        if isTextField {
            let v = value ?? ""
            if v.isEmpty || v == placeholderValue {
                return nil
            }
            return v
        }
        if let v = value, !v.isEmpty {
            return v
        }
        return label.isEmpty ? nil : label
    }

    /// Read `traits` off an XCUIElement via KVC. Mirrors
    /// `SnapshotElementFinder.annotateTraits` — `responds(to:)` first so
    /// a future Xcode that drops the property doesn't crash with an
    /// uncatchable `NSUnknownKeyException`.
    ///
    /// `XCElementSnapshot` is documented to expose `traits` via KVC; the
    /// live `XCUIElement` is not. In practice today's Xcode forwards the
    /// key onto the underlying snapshot, so the same call works on both,
    /// but if a future SDK rev breaks that forwarding, trait-derived role
    /// resolution on this code path silently degrades to type-only. Log
    /// once when the responds-check fails so the regression surfaces in
    /// the agent log instead of failing tests with an unhelpful "no role".
    static func extractTraits(from element: XCUIElement) -> UInt64 {
        guard let nsElement = element as? NSObject,
              nsElement.responds(to: NSSelectorFromString("traits")) else {
            ElementInfo.liveTraitsKvcMissLogger.log(
                "[Tapsmith] XCUIElement does not respond to KVC `traits`. " +
                    "Trait-derived roles via the live-element path will not resolve. " +
                    "Likely cause: Xcode SDK change. Snapshot path is unaffected."
            )
            return 0
        }
        let raw = nsElement.value(forKey: "traits")
        if let v = raw as? UInt64 { return v }
        if let v = raw as? NSNumber { return v.uint64Value }
        if let v = raw as? Int { return UInt64(bitPattern: Int64(v)) }
        return 0
    }

    private static let liveTraitsKvcMissLogger = OneShotLogger()

    /// Pulled out of `SnapshotElementFinder` so the live-element paths
    /// can use the same React Native compound-value parsing.
    /// Element types that natively expose state via `selected` (switch,
    /// toggle, checkbox, radio button) fall through to that flag when
    /// the value string isn't recognized.
    static func deriveCheckedState(
        elementType: XCUIElement.ElementType,
        value: String?,
        selected: Bool
    ) -> Bool {
        let normalized = (value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        switch normalized {
        case "1", "true", "on", "yes", "selected", "checked":
            return true
        case "0", "false", "off", "no", "not selected", "unchecked":
            return false
        default:
            break
        }
        // RN compound values: "checkbox, checked", "radio button, unchecked", etc.
        if normalized.hasSuffix(", checked") || normalized.hasSuffix(", selected") {
            return true
        }
        if normalized.hasSuffix(", unchecked") || normalized.hasSuffix(", not selected") {
            return false
        }
        // Fall through to platform-native state for togglable element types.
        switch elementType {
        case .switch, .toggle, .checkBox, .radioButton:
            return selected
        default:
            return false
        }
    }
}
