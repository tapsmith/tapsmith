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
/// named by its label alone, as in Playwright. So is the system back
/// button's "Back" (`backButtonName`, PILOT-1260). A Flutter tab is named
/// by its label without the position Flutter appends (`FlutterTab`) as well
/// as by its whole label.
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

    /// The name of the system back button (`BackButton`, in UIKit and
    /// SwiftUI stacks alike) when it has no label or title, as VoiceOver
    /// reads one with no title. The iPhone Duo simulator (iOS 27) publishes
    /// its back button with no label (PILOT-1260); other devices label it
    /// with the previous screen's title, which names it alone.
    static let backButtonName = "Back"

    /// `backButtonName` when the element is the system back button with no
    /// label or title, else nil.
    static func backButtonName(
        elementType: XCUIElement.ElementType, label: String, title: String, identifier: String
    ) -> String? {
        guard elementType == .button, identifier == "BackButton",
              TextMatch.normalize(label).isEmpty, TextMatch.normalize(title).isEmpty
        else { return nil }
        return backButtonName
    }

    /// The name the element has only as a fallback — its placeholder or the
    /// back button's "Back" — or nil when it is named by its label or title
    /// (or has no fallback).
    private static func fallbackName(
        elementType: XCUIElement.ElementType, label: String, title: String, placeholder: String, identifier: String
    ) -> String? {
        placeholderName(elementType: elementType, label: label, title: title, placeholder: placeholder)
            ?? backButtonName(elementType: elementType, label: label, title: title, identifier: identifier)
    }

    /// Whether the element's name matches `name` (TextMatch.nameMatches): a
    /// case-insensitive substring, or with `exact` the whole name — for a
    /// label or title also one child of a ", "-joined label; a placeholder
    /// or "Back" is one string, so only whole.
    static func matches(
        elementType: XCUIElement.ElementType, label: String, title: String, placeholder: String,
        identifier: String, name: String, exact: Bool
    ) -> Bool {
        if let tabName = FlutterTab.name(of: label), TextMatch.nameMatches(tabName, name, exact: exact) {
            return true
        }
        if TextMatch.nameMatches(label, name, exact: exact) || TextMatch.nameMatches(title, name, exact: exact) {
            return true
        }
        guard let fallback = fallbackName(
            elementType: elementType, label: label, title: title, placeholder: placeholder, identifier: identifier
        ) else { return false }
        return exact ? TextMatch.equals(fallback, name) : TextMatch.nameMatches(fallback, name, exact: false)
    }

    /// `matches` for a RegExp name (PILOT-520), tested against each
    /// whitespace-normalized name source. A placeholder-named field (or an
    /// unlabelled back button) is tested against its placeholder ("Back")
    /// alone: its empty label and title are not its name, so a RegExp that
    /// matches "" does not match it.
    static func matches(
        elementType: XCUIElement.ElementType, label: String, title: String, placeholder: String,
        identifier: String, regex: TextRegex
    ) -> Bool {
        if let tabName = FlutterTab.name(of: label), !tabName.isEmpty, regex.nameMatches(tabName) {
            return true
        }
        if let fallback = fallbackName(
            elementType: elementType, label: label, title: title, placeholder: placeholder, identifier: identifier
        ) {
            return regex.nameMatches(fallback)
        }
        return regex.nameMatches(label) || regex.nameMatches(title)
    }
}
