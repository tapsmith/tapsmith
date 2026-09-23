import XCTest

/// Maps Tapsmith role names to XCUIElement.ElementType values.
/// Mirrors the Android agent's roleClassMap in ElementFinder.kt.
enum RoleMapping {

    /// Role name → list of XCUIElement.ElementType that represent that role.
    static let roleToElementTypes: [String: [XCUIElement.ElementType]] = [
        "button": [.button],
        "textfield": [.textField, .secureTextField],
        "checkbox": [.checkBox, .other],
        "switch": [.switch, .toggle],
        "image": [.image],
        "text": [.staticText],
        "heading": [.staticText],  // filtered by trait in practice
        "link": [.link],
        "list": [.table, .collectionView],
        "listitem": [.cell],
        "scrollview": [.scrollView],
        "progressbar": [.progressIndicator],
        "seekbar": [.slider],
        "radiobutton": [.radioButton, .other],
        "spinner": [.picker, .activityIndicator],
        "toolbar": [.toolbar],
        "tab": [.tab, .tabBar],
        // resolveRole(for:traits:) can publish "searchfield" off the
        // UIAccessibilityTraitSearchField bit — keep the reverse mapping
        // here so getByRole("searchfield") is symmetric and doesn't throw
        // "Unknown role".
        "searchfield": [.searchField],
        // RN renders these as .other with no distinguishing trait.
        // The name filter narrows the query; resolveRole won't report
        // these roles back (no trait to detect), so toHaveRole won't
        // match — but getByRole(..., { name }) will find the element.
        "alert": [.other],
        "combobox": [.other],
    ]

    /// The role reported for an element type that more than one role lists in
    /// `roleToElementTypes`. "heading" also queries `.staticText`, but a
    /// heading is only reported off the header trait, which `resolveRole`
    /// checks before this map.
    static let reverseRolePins: [XCUIElement.ElementType: String] = [
        .staticText: "text",
    ]

    /// Reverse mapping: XCUIElement.ElementType → role name.
    /// `.other` is excluded: multiple roles include it in their forward mapping
    /// (checkbox, radiobutton, alert, combobox) so getByRole can match generic
    /// Views by name, but the reverse can't pick one.
    static let elementTypeToRole = buildReverseMap(Array(roleToElementTypes), pins: reverseRolePins)

    /// Build the reverse map so the result never depends on the order of
    /// `entries`: Swift seeds Dictionary iteration per process, and "first
    /// mapping wins" made plain text report "heading" in some sessions
    /// (PILOT-365). A type listed under several roles gets its pinned role,
    /// or none at all if it has no pin.
    static func buildReverseMap(
        _ entries: [(key: String, value: [XCUIElement.ElementType])],
        pins: [XCUIElement.ElementType: String]
    ) -> [XCUIElement.ElementType: String] {
        var claims: [XCUIElement.ElementType: Set<String>] = [:]
        for (role, types) in entries {
            for type in types where type != .other {
                claims[type, default: []].insert(role)
            }
        }
        var map: [XCUIElement.ElementType: String] = [:]
        for (type, roles) in claims {
            if roles.count == 1 {
                map[type] = roles.first
            } else if let pinned = pins[type], roles.contains(pinned) {
                map[type] = pinned
            }
        }
        return map
    }

    /// Resolve a role name from an XCUIElement.ElementType.
    static func resolveRole(for elementType: XCUIElement.ElementType) -> String {
        return elementTypeToRole[elementType] ?? ""
    }

    /// Resolve a role name, preferring an accessibility-trait override when
    /// the element carries one. React Native exposes `accessibilityRole` as
    /// a trait bit (e.g. UIAccessibilityTraitHeader for `accessibilityRole="header"`),
    /// and the trait carries semantic intent that the element type doesn't.
    static func resolveRole(for elementType: XCUIElement.ElementType, traits: UInt64) -> String {
        let headerTrait: UInt64 = 1 << 16
        let buttonTrait: UInt64 = 1 << 0
        let linkTrait: UInt64 = 1 << 1
        let imageTrait: UInt64 = 1 << 2
        let adjustableTrait: UInt64 = 1 << 17
        let searchFieldTrait: UInt64 = 1 << 20

        // Trait-derived semantic roles take priority — these are the ones an
        // app explicitly declares via `accessibilityRole`.
        if traits & headerTrait != 0 { return "heading" }
        if traits & searchFieldTrait != 0 { return "searchfield" }
        if traits & adjustableTrait != 0 { return "seekbar" }
        if traits & linkTrait != 0 { return "link" }

        let typeRole = elementTypeToRole[elementType] ?? ""
        if !typeRole.isEmpty { return typeRole }

        // Generic .other elements with a button/image trait still convey role.
        if traits & buttonTrait != 0 { return "button" }
        if traits & imageTrait != 0 { return "image" }

        return ""
    }

    /// Get the XCUIElement.ElementType values for a role name.
    /// - Throws: AgentError.invalidSelector if the role is unknown.
    static func elementTypes(for role: String) throws -> [XCUIElement.ElementType] {
        let normalized = roleAliases[role.lowercased()] ?? role.lowercased()
        guard let types = roleToElementTypes[normalized] else {
            let known = roleToElementTypes.keys.sorted().joined(separator: ", ")
            throw AgentError.invalidSelector("Unknown role: '\(role)'. Known roles: \(known)")
        }
        return types
    }

    /// Cross-platform role aliases — kept in sync with Android's
    /// `ROLE_ALIASES` map and the SDK's `normalizeRole`. Lets users pass
    /// either the React Native spelling ("header", "slider", "search") or the
    /// Tapsmith/Playwright canonical ("heading", "seekbar", "searchfield").
    ///
    /// **Parity contract:** this map MUST stay in sync with
    /// `packages/tapsmith/src/expect.ts ROLE_ALIASES` and
    /// `agent/app/.../ElementFinder.kt ROLE_ALIASES`. The SDK side has
    /// the locking parity test (`expect.test.ts > ROLE_ALIASES parity`);
    /// when you add an alias here, also update both other files and
    /// extend that test. Drift causes silent per-platform mismatches
    /// where the SDK normalizes one way and this side reports the
    /// other, leading `toHaveRole` to either fail loudly or (worse)
    /// match the wrong element.
    static let roleAliases: [String: String] = [
        "header": "heading",
        "slider": "seekbar",
        "search": "searchfield",
    ]

    /// Check if a UIAccessibilityTraits bitmask matches a role.
    /// This handles React Native components (Pressable, TouchableOpacity) that
    /// set accessibilityRole but render as generic UIViews (.other element type).
    static func matchesTrait(role: String, traits: UInt64) -> Bool {
        // UIAccessibilityTrait constants (from UIKit)
        let buttonTrait: UInt64 = 1 << 0           // UIAccessibilityTraitButton
        let linkTrait: UInt64 = 1 << 1              // UIAccessibilityTraitLink
        let headerTrait: UInt64 = 1 << 16           // UIAccessibilityTraitHeader
        let searchFieldTrait: UInt64 = 1 << 20      // UIAccessibilityTraitSearchField
        let imageTrait: UInt64 = 1 << 2             // UIAccessibilityTraitImage
        let staticTextTrait: UInt64 = 1 << 6        // UIAccessibilityTraitStaticText
        let adjustableTrait: UInt64 = 1 << 17       // UIAccessibilityTraitAdjustable (slider/picker)

        switch role.lowercased() {
        case "button": return traits & buttonTrait != 0
        case "link": return traits & linkTrait != 0
        case "heading", "header": return traits & headerTrait != 0
        case "image": return traits & imageTrait != 0
        case "text": return traits & staticTextTrait != 0
        case "seekbar", "slider": return traits & adjustableTrait != 0
        case "searchfield": return traits & searchFieldTrait != 0
        default: return false
        }
    }

    /// Convert an XCUIElement.ElementType to a string name for the className field.
    /// Uses the XCUIElementType naming convention (e.g., "XCUIElementTypeButton").
    static func typeName(for elementType: XCUIElement.ElementType) -> String {
        switch elementType {
        case .button: return "XCUIElementTypeButton"
        case .staticText: return "XCUIElementTypeStaticText"
        case .textField: return "XCUIElementTypeTextField"
        case .secureTextField: return "XCUIElementTypeSecureTextField"
        case .image: return "XCUIElementTypeImage"
        case .cell: return "XCUIElementTypeCell"
        case .table: return "XCUIElementTypeTable"
        case .collectionView: return "XCUIElementTypeCollectionView"
        case .scrollView: return "XCUIElementTypeScrollView"
        case .switch: return "XCUIElementTypeSwitch"
        case .toggle: return "XCUIElementTypeToggle"
        case .slider: return "XCUIElementTypeSlider"
        case .progressIndicator: return "XCUIElementTypeProgressIndicator"
        case .activityIndicator: return "XCUIElementTypeActivityIndicator"
        case .picker: return "XCUIElementTypePicker"
        case .toolbar: return "XCUIElementTypeToolbar"
        case .tabBar: return "XCUIElementTypeTabBar"
        case .tab: return "XCUIElementTypeTab"
        case .link: return "XCUIElementTypeLink"
        case .checkBox: return "XCUIElementTypeCheckBox"
        case .radioButton: return "XCUIElementTypeRadioButton"
        case .searchField: return "XCUIElementTypeSearchField"
        case .navigationBar: return "XCUIElementTypeNavigationBar"
        case .webView: return "XCUIElementTypeWebView"
        case .window: return "XCUIElementTypeWindow"
        case .alert: return "XCUIElementTypeAlert"
        case .sheet: return "XCUIElementTypeSheet"
        case .other: return "XCUIElementTypeOther"
        default: return "XCUIElementType(\(elementType.rawValue))"
        }
    }
}
