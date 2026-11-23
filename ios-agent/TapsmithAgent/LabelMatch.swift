import XCTest

/// getByLabel's rule (PILOT-666), shared by the snapshot walk and the live
/// XCUIElement query, and replayed against the SDK's conformance fixture
/// (`label-conformance.json`) so the locator playground matches the same
/// elements: an input of one of `inputTypes`, or a React Native checkbox or
/// radio button (`isChoice`), named by its label or title, or by its settings
/// row's title (`rowLabel`, RowName) — a string compared whole and
/// whitespace-normalized, a RegExp tested against the raw text. A text view
/// whose label holds one text twice is also named by that text (`unrepeated`).
enum LabelMatch {
    /// The input types getByLabel finds: a `switch` role's toggle too, as
    /// Android's getByLabel walks every switch class (PILOT-697).
    static let inputTypes: Set<XCUIElement.ElementType> = [
        .textField, .secureTextField, .textView,
        .switch, .toggle, .slider, .stepper, .picker,
        .checkBox, .radioButton,
    ]

    /// The roles (RoleMapping's canonical names) of the generic views React
    /// Native describes in their value ("checkbox, unchecked") that are
    /// choices: inputs, as Android's CheckBox and RadioButton classes are.
    static let describedChoiceRoles: Set<String> = ["checkbox", "radiobutton"]

    /// Whether an element is a checkbox or radio button: its native type, or
    /// a generic view React Native describes as one. getByLabel finds it, and
    /// getByText gives way on its label to another match whose text it holds
    /// (`TextContent.withoutChoices`).
    static func isChoice(elementType: XCUIElement.ElementType, value: String?) -> Bool {
        if elementType == .checkBox || elementType == .radioButton { return true }
        guard elementType == .other, let described = RoleMapping.describedRole(in: value) else { return false }
        return describedChoiceRoles.contains { RoleMapping.otherRoleDescriptions[$0] == described }
    }

    /// Whether getByLabel looks at an element at all.
    static func isInput(elementType: XCUIElement.ElementType, value: String?) -> Bool {
        inputTypes.contains(elementType) || isChoice(elementType: elementType, value: value)
    }

    /// The label of a text view that holds one text twice, without the repeat
    /// ("Notes" for "Notes Notes"), else "". React Native appends an empty
    /// multi-line input's placeholder to its label, so one whose placeholder
    /// repeats its accessibilityLabel reads "Notes Notes" until it holds
    /// text. Whitespace-normalized; halves compared as UTF-16, as the SDK's
    /// copy (`iosUnrepeatedLabel`) compares them.
    static func unrepeated(_ label: String, elementType: XCUIElement.ElementType) -> String {
        guard elementType == .textView else { return "" }
        let units = Array(TextMatch.normalize(label).utf16)
        guard units.count % 2 == 1 else { return "" }
        let half = (units.count - 1) / 2
        guard half > 0, units[half] == 0x20, Array(units[..<half]) == Array(units[(half + 1)...]) else { return "" }
        return String(decoding: units[..<half], as: UTF16.self)
    }

    /// An empty `query` matches nothing: SelectorParser drops an empty label,
    /// so it never reaches the finders as a criterion.
    static func matches(
        elementType: XCUIElement.ElementType, label: String, title: String, value: String? = nil,
        rowLabel: String = "", query: String
    ) -> Bool {
        guard !query.isEmpty, isInput(elementType: elementType, value: value) else { return false }
        let repeated = unrepeated(label, elementType: elementType)
        return TextMatch.equals(label, query) || TextMatch.equals(title, query)
            || (!rowLabel.isEmpty && TextMatch.equals(rowLabel, query))
            || (!repeated.isEmpty && TextMatch.equals(repeated, query))
    }

    static func matches(
        elementType: XCUIElement.ElementType, label: String, title: String, value: String? = nil,
        rowLabel: String = "", regex: TextRegex
    ) -> Bool {
        guard isInput(elementType: elementType, value: value) else { return false }
        let repeated = unrepeated(label, elementType: elementType)
        return regex.matches(label) || regex.matches(title) || (!rowLabel.isEmpty && regex.matches(rowLabel))
            || (!repeated.isEmpty && regex.matches(repeated))
    }
}
