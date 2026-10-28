import XCTest

/// What getByText reads on iOS (PILOT-794): the iOS stand-in for an element's
/// text content. Playwright's getByText matches text content and returns the
/// innermost element holding it; an iOS element has no text content, only a
/// label, a title and a value, so this decides which of them count.
///
/// - A label or title is text content, except on a control whose label is
///   only its accessible name (`nameOnlyTypes`): SwiftUI draws a Toggle's or
///   a Stepper's label as a separate static text, and a Slider's label isn't
///   drawn at all. getByLabel and getByRole's name find those controls.
/// - A value is text content only where it is the text on screen
///   (`valueTextTypes`): static text, the typed text of a text input, a
///   picker wheel's selected row. A
///   switch's "0"/"1", a stepper's or a slider's value, a button's value or
///   an accessibilityValue are not.
/// - A label that starts with its nearest labelled ancestor's label and ", "
///   (a SwiftUI Stepper's buttons: "Quantity: 1, Increment") is read without
///   that prefix: the text belongs to the ancestor.
/// - Innermost (`SnapshotElementFinder.findMatches`): a getByText match that
///   contains another match is dropped, as Playwright's text engine drops an
///   element whose child matches. A Toggle row, a NavigationLink, an alert
///   give way to the static text they hold.
///
/// One rule shared by the snapshot walk and the trace viewer's offline
/// matcher (`trace-viewer/components/text-content.ts`), pinned by the SDK's
/// conformance fixture (`text-content-conformance.json`), which the host
/// tests replay (ios-agent/Tests/TextContentTests).
enum TextContent {
    /// Controls whose label is their accessible name, not text on screen.
    static let nameOnlyTypes: Set<XCUIElement.ElementType> = [
        .switch, .toggle, .slider, .stepper,
    ]

    /// Element types whose value is the text they show: a picker wheel's
    /// selected row is only its value.
    static let valueTextTypes: Set<XCUIElement.ElementType> = [
        .staticText, .textField, .secureTextField, .textView, .searchField, .pickerWheel,
    ]

    /// One node's text content, as getByText compares it.
    struct Texts {
        let label: String
        let title: String
        let value: String
    }

    /// The node's label, title and value as text content: each empty when it
    /// isn't. `containerLabel` is the nearest ancestor's non-empty label.
    static func texts(
        elementType: XCUIElement.ElementType,
        label: String,
        title: String,
        value: String,
        containerLabel: String
    ) -> Texts {
        let nameOnly = nameOnlyTypes.contains(elementType)
        return Texts(
            label: nameOnly ? "" : ownLabel(label, containerLabel: containerLabel),
            title: nameOnly ? "" : title,
            value: valueTextTypes.contains(elementType) ? value : ""
        )
    }

    /// `label` without the ", "-joined prefix it repeats from its container.
    static func ownLabel(_ label: String, containerLabel: String) -> String {
        let container = TextMatch.normalize(containerLabel)
        guard !container.isEmpty else { return label }
        let normalized = TextMatch.normalize(label)
        let prefix = container + ", "
        guard normalized.hasPrefix(prefix) else { return label }
        return String(normalized.dropFirst(prefix.count))
    }

    /// getByText(string, { exact: true }): the whole label, title or value
    /// (whitespace-normalized), one ", "-joined child of the label or title
    /// (React Native merges a touchable's child texts into its label), or
    /// the label without the text's trailing punctuation ("Forgot password"
    /// for "Forgot password?": a React Native touchable's accessibilityLabel
    /// hides the text it wraps).
    static func matchesExact(_ texts: Texts, _ query: String) -> Bool {
        if TextMatch.equals(texts.label, query) || TextMatch.equals(texts.title, query)
            || TextMatch.equals(texts.value, query) {
            return true
        }
        if TextMatch.containsChildText(texts.label, childText: query)
            || TextMatch.containsChildText(texts.title, childText: query) {
            return true
        }
        return matchesIgnoringTrailingPunctuation(TextMatch.normalize(texts.label), TextMatch.normalize(query))
    }

    /// getByText(string): a case-insensitive substring of the label, title or
    /// value — or, so that it finds whatever `matchesExact` finds
    /// (PILOT-880), the end of a label without the query's trailing
    /// punctuation: "Forgot password?" in a link labelled "Forgot password".
    static func matchesSubstring(_ texts: Texts, _ query: String) -> Bool {
        if TextMatch.contains(texts.label, query) || TextMatch.contains(texts.title, query)
            || TextMatch.contains(texts.value, query) {
            return true
        }
        return endsWithIgnoringTrailingPunctuation(
            TextMatch.normalize(texts.label).lowercased(), TextMatch.normalize(query).lowercased()
        )
    }

    /// getByText(RegExp): tested against the raw label, title or value.
    static func matchesRegex(_ texts: Texts, _ regex: TextRegex) -> Bool {
        regex.matches(texts.label) || regex.matches(texts.title) || regex.matches(texts.value)
    }

    /// Whether two strings are equal once trailing punctuation and symbols
    /// are dropped from both.
    static func matchesIgnoringTrailingPunctuation(_ a: String, _ b: String) -> Bool {
        guard !a.isEmpty && !b.isEmpty else { return false }
        return droppingTrailingPunctuation(a) == droppingTrailingPunctuation(b)
    }

    /// Whether `text` ends with `query` once trailing punctuation and symbols
    /// are dropped from both: the substring form of
    /// `matchesIgnoringTrailingPunctuation`. Only for a query that ends in
    /// punctuation, and never for punctuation alone.
    static func endsWithIgnoringTrailingPunctuation(_ text: String, _ query: String) -> Bool {
        let trimmedQuery = droppingTrailingPunctuation(query)
        guard !trimmedQuery.isEmpty, trimmedQuery != query else { return false }
        return droppingTrailingPunctuation(text).hasSuffix(trimmedQuery)
    }

    private static func droppingTrailingPunctuation(_ s: String) -> String {
        let punct = CharacterSet.punctuationCharacters.union(.symbols)
        let trimmed = s.unicodeScalars.reversed().drop(while: { punct.contains($0) })
        return String(String.UnicodeScalarView(trimmed.reversed()))
    }
}
