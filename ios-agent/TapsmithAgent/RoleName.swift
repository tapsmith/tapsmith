import XCTest

/// getByRole's name rule, shared by the snapshot walk and the live
/// XCUIElement query, and replayed against the SDK's conformance fixture
/// (`role-conformance.json`) so the locator playground names elements
/// the same way: an element is named by its label or title — or, when both
/// are empty and it is a text input (`placeholderNamedTypes`), by its
/// placeholder (PILOT-834). Playwright names an input with no label by its
/// placeholder; SwiftUI's `TextField("Title", text:)` publishes an empty
/// label and the text only as its placeholderValue.
///
/// The placeholder is a fallback, not one more name: a labelled field is
/// named by its label alone, as in Playwright.
enum RoleName {
    /// The element types a placeholder names when they have no label or title.
    static let placeholderNamedTypes: Set<XCUIElement.ElementType> = [
        .textField, .secureTextField, .searchField, .textView,
    ]

    /// The placeholder that names this element, or nil when it is named by
    /// its label or title (or has no placeholder to fall back to).
    static func placeholderName(
        elementType: XCUIElement.ElementType, label: String, title: String, placeholder: String
    ) -> String? {
        guard placeholderNamedTypes.contains(elementType), !placeholder.isEmpty,
              TextMatch.normalize(label).isEmpty, TextMatch.normalize(title).isEmpty
        else { return nil }
        return placeholder
    }

    /// Whether the element's name matches `name` (TextMatch.nameMatches): a
    /// case-insensitive substring, or with `exact` the whole name — for a
    /// label or title also one child of a ", "-joined label; a placeholder
    /// is one string, so only whole.
    static func matches(
        elementType: XCUIElement.ElementType, label: String, title: String, placeholder: String,
        name: String, exact: Bool
    ) -> Bool {
        if TextMatch.nameMatches(label, name, exact: exact) || TextMatch.nameMatches(title, name, exact: exact) {
            return true
        }
        guard let placeholderName = placeholderName(
            elementType: elementType, label: label, title: title, placeholder: placeholder
        ) else { return false }
        return exact ? TextMatch.equals(placeholderName, name) : TextMatch.nameMatches(placeholderName, name, exact: false)
    }

    /// `matches` for a RegExp name (PILOT-520), tested against each
    /// whitespace-normalized name source. A placeholder-named field is
    /// tested against its placeholder alone: its empty label and title are
    /// not its name, so a RegExp that matches "" does not match it.
    static func matches(
        elementType: XCUIElement.ElementType, label: String, title: String, placeholder: String,
        regex: TextRegex
    ) -> Bool {
        if let placeholderName = placeholderName(
            elementType: elementType, label: label, title: title, placeholder: placeholder
        ) {
            return regex.nameMatches(placeholderName)
        }
        return regex.nameMatches(label) || regex.nameMatches(title)
    }
}
