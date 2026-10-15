import Foundation

/// Whitespace-normalized text matching for `getByText` and accessible-name
/// matching (PILOT-510), the way Playwright matches text: runs of whitespace
/// collapse to one space and the ends are trimmed, on both the element's
/// label and the query, exact or substring. A label rendered with a
/// non-breaking space (`Welcome to&nbsp;Expo`) or a line break then matches a
/// query typed with plain spaces. As in Playwright, a substring match ignores
/// case and an exact one doesn't.
///
/// "Whitespace" is JavaScript's `\s` set, the same set the Android agent's
/// TextMatch.kt and the SDK's trace-viewer matcher use.
///
/// The snapshot walk compares normalized strings, except a substring match,
/// which evaluates the same ICU pattern the live queries use (see `contains`).
/// XCUIElement queries can't normalize, so they get an ICU pattern
/// (`label MATCHES %@`, a full match) that accepts the same labels: the
/// query's words, escaped, joined by one-or-more whitespace.
enum TextMatch {
    /// JavaScript's `\s`: ECMAScript WhiteSpace and LineTerminator code points.
    private static let whitespace: Set<Unicode.Scalar> = {
        var set: Set<Unicode.Scalar> = [
            "\u{09}", "\u{0A}", "\u{0B}", "\u{0C}", "\u{0D}", "\u{20}", "\u{A0}", "\u{1680}",
            "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}",
        ]
        for value in UInt32(0x2000)...UInt32(0x200A) {
            if let scalar = Unicode.Scalar(value) { set.insert(scalar) }
        }
        return set
    }()

    /// The same set as an ICU character class.
    private static let wsClass =
        "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"

    /// Collapse whitespace runs to one space and trim.
    static func normalize(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        var pendingSpace = false
        for scalar in text.unicodeScalars {
            if whitespace.contains(scalar) {
                pendingSpace = true
            } else {
                if pendingSpace && !out.isEmpty { out.append(" ") }
                pendingSpace = false
                out.append(scalar)
            }
        }
        return String(out)
    }

    /// Whether `text` equals `query` once both are normalized.
    static func equals(_ text: String, _ query: String) -> Bool {
        normalize(text) == normalize(query)
    }

    /// Whether the normalized `text` contains the normalized `query`,
    /// ignoring case — Playwright's non-exact getByText (PILOT-522).
    /// Evaluated with the very predicate the live XCUIElement queries use
    /// (`MATCHES containsPattern`), so the snapshot walk and a live query
    /// agree on every label — NSPredicate's ICU folding has corners (full
    /// folding, width under `(?i)`) no Swift string search reproduces — and
    /// a live query's positional index binds the element the walk matched.
    static func contains(_ text: String, _ query: String) -> Bool {
        NSPredicate(format: "SELF MATCHES %@", containsPattern(query)).evaluate(with: text)
    }

    /// Whether `childText` is one of the child texts iOS joined with ", " to
    /// form `label` (or the whole label), compared normalized.
    static func containsChildText(_ label: String, childText: String) -> Bool {
        let label = normalize(label)
        let child = normalize(childText)
        if label == child { return true }
        if label.hasPrefix(child + ", ") { return true }
        if label.hasSuffix(", " + child) { return true }
        if label.contains(", " + child + ", ") { return true }
        return false
    }

    /// Whether `text` matches the accessible-name `query` the way Playwright's
    /// getByRole `name` does (PILOT-549): by default a case-insensitive
    /// substring; with `exact`, case-sensitive equality — or, as iOS joins
    /// child text into one label with ", ", one whole child of that label.
    /// Whitespace is normalized either way.
    static func nameMatches(_ text: String, _ query: String, exact: Bool) -> Bool {
        if exact {
            return equals(text, query) || containsChildText(text, childText: query)
        }
        let needle = normalize(query).lowercased()
        return needle.isEmpty || normalize(text).lowercased().contains(needle)
    }

    /// ICU full-match pattern: the label equals `query` after normalizing both.
    static func exactPattern(_ query: String) -> String {
        "\(wsClass)*\(words(query))\(wsClass)*"
    }

    /// ICU full-match pattern: the normalized label contains the normalized
    /// `query`, ignoring case (PILOT-522), the same test as `contains`.
    static func containsPattern(_ query: String) -> String {
        "(?is).*\(words(query)).*"
    }

    /// ICU full-match pattern for `containsChildText`: the whole label, or a
    /// first, middle or last child of a ", "-joined label.
    static func concatenatedLabelPattern(_ query: String) -> String {
        "(?s)(?:\(wsClass)*|.*,\(wsClass)+)\(words(query))(?:\(wsClass)*|,\(wsClass)+.*)"
    }

    private static func words(_ query: String) -> String {
        let normalized = normalize(query)
        if normalized.isEmpty { return "" }
        return normalized
            .split(separator: " ")
            .map { NSRegularExpression.escapedPattern(for: String($0)) }
            .joined(separator: "\(wsClass)+")
    }
}

/// One snapshot node, as the live XCUIElement re-resolution query sees it.
struct QueryNode {
    let typeRaw: UInt
    let label: String
    let identifier: String
    var title: String = ""
    var value: String = ""
}

/// Positional bookkeeping for re-resolving a role+name snapshot match through
/// a live XCUIElement query (PILOT-549). That query finds the match again by
/// its exact label (and identifier, when it has one), scoped to its element
/// type when the type is specific. Its index must therefore count every node
/// of the app's tree that the same query returns — other roles, other
/// scopes, unmatched same-label nodes included — not just the matches.
enum QueryIndex {
    /// The index of `nodes[ordinal]` within the live query's results, where
    /// `nodes` is the app's descendants in pre-order (XCUIElementQuery order)
    /// and `scopeTypeRaw` is the query's element type, or nil for any type.
    static func liveIndex(of ordinal: Int, in nodes: [QueryNode], scopeTypeRaw: UInt?) -> Int {
        let target = nodes[ordinal]
        var count = 0
        for node in nodes[..<ordinal]
        where node.label == target.label
            && (target.identifier.isEmpty || node.identifier == target.identifier)
            && (scopeTypeRaw == nil || node.typeRaw == scopeTypeRaw) {
            count += 1
        }
        return count
    }

    /// The index of `nodes[ordinal]` within a live substring-text query
    /// (`label/title/value MATCHES containsPattern(query)`, PILOT-522) on the
    /// scoped type: every earlier node of that type the same predicate
    /// matches — for a match with no label to re-resolve it by.
    static func substringLiveIndex(of ordinal: Int, in nodes: [QueryNode], scopeTypeRaw: UInt?, query: String) -> Int {
        var count = 0
        for node in nodes[..<ordinal]
        where (scopeTypeRaw == nil || node.typeRaw == scopeTypeRaw)
            && (TextMatch.contains(node.label, query) || TextMatch.contains(node.title, query)
                || TextMatch.contains(node.value, query)) {
            count += 1
        }
        return count
    }
}

/// A getBy* RegExp (PILOT-520), as the daemon forwards it. `pattern` is the
/// SDK's translation of the JavaScript RegExp, written so ICU (behind both
/// NSRegularExpression and NSPredicate `MATCHES`) reads it with JavaScript's
/// semantics — whitespace, digit and word classes, anchors and `.` are all
/// spelled out — so only `ignoreCase` is left to the engine. `display` is the
/// RegExp as written, for messages.
struct TextRegex {
    let pattern: String
    let ignoreCase: Bool
    let display: String
    /// Nil when ICU rejects the pattern; `error` then says why.
    let regex: NSRegularExpression?
    let error: String?

    init(pattern: String, ignoreCase: Bool, display: String) {
        self.pattern = pattern
        self.ignoreCase = ignoreCase
        self.display = display
        do {
            regex = try NSRegularExpression(pattern: pattern, options: ignoreCase ? [.caseInsensitive] : [])
            error = nil
        } catch let failure {
            regex = nil
            error = "Invalid RegExp \(display): \(failure.localizedDescription)"
        }
    }

    /// Parse the daemon's `{pattern, ignoreCase, display}` object; nil when absent.
    static func fromJSON(_ value: Any?) -> TextRegex? {
        guard let obj = value as? [String: Any] else { return nil }
        let pattern = obj["pattern"] as? String ?? ""
        return TextRegex(
            pattern: pattern,
            ignoreCase: obj["ignoreCase"] as? Bool ?? false,
            display: obj["display"] as? String ?? "/\(pattern)/"
        )
    }

    /// Whether the RegExp matches anywhere in `text`, like `RegExp.prototype.test`.
    func matches(_ text: String) -> Bool {
        guard let regex else { return false }
        return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// `matches` against the whitespace-normalized text — how a role name is
    /// tested (Playwright tests the normalized accessible name).
    func nameMatches(_ text: String) -> Bool {
        matches(TextMatch.normalize(text))
    }

    /// The same test as a whole-string ICU pattern, for `label MATCHES %@`:
    /// any prefix, the RegExp, any suffix. The wrappers are non-capturing, so
    /// backreferences keep their numbers.
    var fullMatchPattern: String {
        "\(ignoreCase ? "(?i)" : "")(?s:.*?)(?:\(pattern))(?s:.*)"
    }
}
