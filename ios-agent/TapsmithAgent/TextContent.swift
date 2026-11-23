import XCTest

/// What getByText reads on iOS (PILOT-794): the iOS stand-in for an element's
/// text content. Playwright's getByText matches text content and returns the
/// innermost element holding it; an iOS element has no text content, only a
/// label, a title and a value, so this decides which of them count.
///
/// - A label or title is text content, except on a control whose label is
///   only its accessible name (`nameOnlyTypes`): SwiftUI draws a Toggle's or
///   a Stepper's label as a separate static text, and a Slider's label isn't
///   drawn at all. getByLabel and getByRole's name find those controls. An
///   image's label is its alt text, a name too (PILOT-1366): Playwright finds
///   an `<img alt>` with getByAltText or getByRole("img"), never getByText,
///   and Android's getByText never reads a content description, so a caption
///   under a labelled image is one match. A button's label stays text: an
///   icon button's can't be told from a text button's.
/// - A value is text content only where it is the text on screen
///   (`valueTextTypes`): static text, a picker wheel's selected row. A
///   switch's "0"/"1", a stepper's or a slider's value, a button's value or
///   an accessibilityValue are not. Nor is a text input's typed value
///   (`textInputTypes`, PILOT-1417), as an `<input>`'s value is not in
///   Playwright and an EditText's is not on Android: after typing "Alpha"
///   into a search field, getByText("Alpha") waits for the result, not the
///   field. The placeholder an empty field shows as its value still is, as
///   an empty EditText's hint is (`inputValueText`). A text view that can't
///   be edited (`RoleMapping.isReadOnlyTextView`: terms copy, React Native's
///   `<TextInput multiline editable={false} />`) is text on screen, not an
///   input, so its value stays text.
/// - A label that starts with its nearest labelled ancestor's label and ", "
///   (a SwiftUI Stepper's buttons: "Quantity: 1, Increment") is read without
///   that prefix: the text belongs to the ancestor.
/// - An exact match on one ", "-joined part of a label isn't one when the
///   node's table row shows that part as a static text of its own, outside
///   the node: UIKit's edit-mode Remove and Reorder controls repeat their
///   row's texts (`matchesExact`, PILOT-1374).
/// - Innermost (`SnapshotElementFinder.findMatches`): a getByText match that
///   contains another match is dropped, as Playwright's text engine drops an
///   element whose child matches. A Toggle row, a NavigationLink, an alert
///   give way to the static text they hold.
/// - A checkbox or radio button (`LabelMatch.isChoice`) matched by its label
///   gives way to another match whose text its label holds
///   (`withoutChoices`). React Native hides a checkbox's own texts inside it,
///   so its label is the only copy of a text it shows and stays text; but a
///   text on screen as another element is that element's, and the
///   checkbox's label only names it ("Toggle Buy oat milk" beside the row's
///   "Buy oat milk"), as Android's getByText never reads a CheckBox's
///   content description.
///
/// One rule shared by the snapshot walk and the trace viewer's offline
/// matcher (`trace-viewer/components/text-content.ts`), pinned by the SDK's
/// conformance fixture (`text-content-conformance.json`), which the host
/// tests replay (ios-agent/Tests/TextContentTests).
enum TextContent {
    /// Controls and images whose label is their accessible name, not text on screen.
    static let nameOnlyTypes: Set<XCUIElement.ElementType> = [
        .switch, .toggle, .slider, .stepper, .image,
    ]

    /// Element types whose value is the text they show: a picker wheel's
    /// selected row is only its value.
    static let valueTextTypes: Set<XCUIElement.ElementType> = [
        .staticText, .pickerWheel,
    ]

    /// Text inputs: their value is text only while it is the placeholder an
    /// empty field shows.
    static let textInputTypes: Set<XCUIElement.ElementType> = [
        .textField, .secureTextField, .textView, .searchField,
    ]

    /// A text input's value as text content: the placeholder it shows when
    /// empty (XCUITest reports an empty field's placeholder as its value),
    /// else "" — a typed value is not text. A value typed to equal the
    /// placeholder reads as the placeholder; a snapshot can't tell them apart.
    static func inputValueText(value: String, placeholder: String) -> String {
        !value.isEmpty && value == placeholder ? value : ""
    }

    /// One node's text content, as getByText compares it.
    struct Texts {
        let label: String
        let title: String
        let value: String
    }

    /// The node's label, title and value as text content: each empty when it
    /// isn't. `containerLabel` is the nearest ancestor's non-empty label;
    /// `placeholder` the node's placeholderValue; `readOnlyTextView` whether
    /// it is a text view that can't be edited (RoleMapping.isReadOnlyTextView).
    static func texts(
        elementType: XCUIElement.ElementType,
        label: String,
        title: String,
        value: String,
        placeholder: String,
        readOnlyTextView: Bool,
        containerLabel: String
    ) -> Texts {
        let nameOnly = nameOnlyTypes.contains(elementType)
        let valueText: String
        if valueTextTypes.contains(elementType) || readOnlyTextView {
            valueText = value
        } else if textInputTypes.contains(elementType) {
            valueText = inputValueText(value: value, placeholder: placeholder)
        } else {
            valueText = ""
        }
        return Texts(
            label: nameOnly ? "" : ownLabel(label, containerLabel: containerLabel),
            title: nameOnly ? "" : title,
            value: valueText
        )
    }

    /// Whether a generic wrapper's label is only its name-only descendant's
    /// name, copied onto the same bounds: React Native exposes an
    /// `<Image accessibilityLabel>` as an Other over the Image, both labelled
    /// (PILOT-1366). getByText doesn't match the wrapper either, so a
    /// labelled container around it keeps its match. A button's label stays
    /// text, as the button's own is.
    static func echoesName(
        wrapperType: XCUIElement.ElementType,
        wrapperLabel: String,
        nodeType: XCUIElement.ElementType,
        nodeLabel: String,
        sameTarget: Bool
    ) -> Bool {
        wrapperType == .other && sameTarget && nameOnlyTypes.contains(nodeType)
            && !TextMatch.normalize(wrapperLabel).isEmpty && TextMatch.equals(wrapperLabel, nodeLabel)
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
    /// (whitespace-normalized), or one ", "-joined child of the label or
    /// title (React Native merges a touchable's child texts into its label).
    /// Literal, like the substring form (PILOT-880): a label that lacks the
    /// text's trailing punctuation — a React Native touchable's
    /// accessibilityLabel "Forgot password" hiding its "Forgot password?"
    /// text — is not that text, as an alert's "Log out" button is not its
    /// "Log out?" title.
    ///
    /// Not a joined part its table row shows as a text of its own
    /// (`rowShowsQuery`, PILOT-1374): UIKit labels a row's edit-mode Remove
    /// and Reorder controls "Remove A, 981 195, Alpha (a@example.com)", its
    /// texts joined after a localized verb. That label names the row; the
    /// text is the row's static text, not the control's.
    static func matchesExact(_ texts: Texts, _ query: String, rowShowsQuery: Bool = false) -> Bool {
        if TextMatch.equals(texts.label, query) || TextMatch.equals(texts.title, query)
            || TextMatch.equals(texts.value, query) {
            return true
        }
        if rowShowsQuery { return false }
        return TextMatch.containsChildText(texts.label, childText: query)
            || TextMatch.containsChildText(texts.title, childText: query)
    }

    /// Whether `query`, matched only as a joined part of `node`'s label or
    /// title, is shown by `rowCell` (the node's nearest enclosing table or
    /// collection row, in snapshot form) as a static text outside the node:
    /// then the part is the row's text, and `matchesExact` drops it.
    static func rowShows(
        _ query: String, texts: Texts, node: [String: Any], rowCell: [String: Any]?
    ) -> Bool {
        guard let rowCell else { return false }
        // A whole-label match stands, wherever the node is.
        if matchesExact(texts, query, rowShowsQuery: true) { return false }
        return staticTextCount(in: rowCell, equalTo: query) > staticTextCount(in: node, equalTo: query)
    }

    /// How many static texts in the snapshot subtree at `node` (itself
    /// included) have the label `query`, whitespace-normalized. A row shows
    /// the query outside a node in it when the row has more than the node.
    static func staticTextCount(in node: [String: Any], equalTo query: String) -> Int {
        var count = 0
        if elementTypeRaw(node["elementType"]) == XCUIElement.ElementType.staticText.rawValue,
           TextMatch.equals(node["label"] as? String ?? "", query) {
            count += 1
        }
        for child in node["children"] as? [[String: Any]] ?? [] {
            count += staticTextCount(in: child, equalTo: query)
        }
        return count
    }

    private static func elementTypeRaw(_ raw: Any?) -> UInt? {
        switch raw {
        case let value as UInt: return value
        case let value as Int: return value >= 0 ? UInt(value) : nil
        case let value as UInt64: return UInt(value)
        case let value as NSNumber: return value.uintValue
        case let value as String: return UInt(value)
        default: return nil
        }
    }

    /// getByText's matches without each checkbox or radio button whose label
    /// holds a text another match shows: that text is the other element's,
    /// and the label only names the choice after it ("Toggle Buy oat milk"
    /// beside "Buy oat milk"). `choiceLabel` is a choice's label, nil for
    /// anything else; `shownTexts` what a match shows (`shownTexts(label:…)`).
    /// A choice whose label no other match shows keeps its match: its label
    /// is the only copy of a text inside it, as for a radio whose "Medium"
    /// sits beside an unrelated "Size: medium".
    static func withoutChoices<Match>(
        _ matches: [Match], choiceLabel: (Match) -> String?, shownTexts: (Match) -> [String]
    ) -> [Match] {
        let shown = matches.filter { choiceLabel($0) == nil }.flatMap(shownTexts)
            .filter { !TextMatch.normalize($0).isEmpty }
        guard !shown.isEmpty else { return matches }
        return matches.filter { match in
            guard let label = choiceLabel(match) else { return true }
            return !shown.contains { TextMatch.contains(label, $0) }
        }
    }

    /// The texts a getByText match shows, as `withoutChoices` compares them:
    /// its label and title, and a static text's value.
    static func shownTexts(
        elementType: XCUIElement.ElementType, label: String, title: String, value: String
    ) -> [String] {
        elementType == .staticText ? [label, title, value] : [label, title]
    }

    /// getByText(string): a case-insensitive substring of the label, title or value.
    static func matchesSubstring(_ texts: Texts, _ query: String) -> Bool {
        TextMatch.contains(texts.label, query) || TextMatch.contains(texts.title, query)
            || TextMatch.contains(texts.value, query)
    }

    /// getByText(RegExp): tested against the raw label, title or value.
    static func matchesRegex(_ texts: Texts, _ regex: TextRegex) -> Bool {
        regex.matches(texts.label) || regex.matches(texts.title) || regex.matches(texts.value)
    }
}
