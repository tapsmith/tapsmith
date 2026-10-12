import XCTest

/// getByLabel's rule (PILOT-666), shared by the snapshot walk and the live
/// XCUIElement query, and replayed against the SDK's conformance fixture
/// (`label-conformance.json`) so the locator playground matches the same
/// elements: an input of one of `inputTypes`, named by its label or title —
/// a string compared whole and whitespace-normalized, a RegExp tested
/// against the raw text.
enum LabelMatch {
    /// The input types getByLabel finds.
    static let inputTypes: Set<XCUIElement.ElementType> = [
        .textField, .secureTextField, .textView,
        .switch, .slider, .stepper, .picker,
        .checkBox, .radioButton,
    ]

    /// An empty `query` matches nothing: SelectorParser drops an empty label,
    /// so it never reaches the finders as a criterion.
    static func matches(elementType: XCUIElement.ElementType, label: String, title: String, query: String) -> Bool {
        !query.isEmpty && inputTypes.contains(elementType)
            && (TextMatch.equals(label, query) || TextMatch.equals(title, query))
    }

    static func matches(elementType: XCUIElement.ElementType, label: String, title: String, regex: TextRegex) -> Bool {
        inputTypes.contains(elementType) && (regex.matches(label) || regex.matches(title))
    }
}
