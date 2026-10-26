// Unit tests for TextMatch (PILOT-510): whitespace-normalized text and
// accessible-name matching, and the ICU patterns the XCUIElement queries use.

import Foundation

var failures = 0

func expect(_ name: String, _ ok: Bool) {
    if ok {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name)")
    }
}

/// Evaluate a pattern the way XCUITest does: `label MATCHES %@` (a full match).
func matches(_ pattern: String, _ text: String) -> Bool {
    NSPredicate(format: "SELF MATCHES %@", pattern).evaluate(with: text)
}

// normalize: JavaScript's \s set collapses to one space; ends are trimmed.
expect("NBSP becomes a space", TextMatch.normalize("Welcome to\u{00A0}Expo") == "Welcome to Expo")
expect("runs of mixed Unicode spaces collapse",
       TextMatch.normalize("  a \u{202F}\u{2003} b\n\tc \u{3000}") == "a b c")
expect("whitespace-only becomes empty", TextMatch.normalize(" \u{00A0}\n ") == "")
expect("zero-width space is not whitespace", TextMatch.normalize("a\u{200B}b") == "a\u{200B}b")

// equals / contains on normalized strings.
expect("equals across NBSP", TextMatch.equals("Welcome to\u{00A0}Expo", "Welcome to Expo"))
expect("equals across a line break", TextMatch.equals("Line one\nLine two", "Line one Line two"))
expect("equals ignores query padding", TextMatch.equals("Save draft", " Save  draft "))
expect("equals is still exact", !TextMatch.equals("Welcome to Expo", "Welcome to"))
expect("equals is case-sensitive", !TextMatch.equals("Welcome", "welcome"))
expect("contains across NBSP", TextMatch.contains("Welcome to\u{00A0}Expo", "to Expo"))
expect("contains with padded query", TextMatch.contains("Welcome to\u{00A0}Expo!", " to  Expo "))
expect("contains rejects a non-substring", !TextMatch.contains("Welcome to\u{00A0}Expo", "to Expos"))
expect("empty query is contained in anything", TextMatch.contains("anything", "\u{00A0}"))

// Concatenated child labels (iOS joins child text with ", ").
expect("child text inside a concatenated label",
       TextMatch.containsChildText("Intro, Welcome to\u{00A0}Expo, More", childText: "Welcome to Expo"))
expect("first child of a concatenated label",
       TextMatch.containsChildText("Welcome to\u{00A0}Expo, More", childText: "Welcome to Expo"))
expect("last child of a concatenated label",
       TextMatch.containsChildText("Intro,\u{00A0}Welcome to Expo", childText: "Welcome to Expo"))
expect("a partial child is not a child",
       !TextMatch.containsChildText("Intro, Welcome to Expo now", childText: "Welcome to Expo"))

// ICU patterns, evaluated like an XCUIElement predicate.
expect("exact pattern: NBSP", matches(TextMatch.exactPattern("Welcome to Expo"), "Welcome to\u{00A0}Expo"))
expect("exact pattern: line break", matches(TextMatch.exactPattern("Line one Line two"), "Line one\nLine two"))
expect("exact pattern: padded text", matches(TextMatch.exactPattern("a b"), "\u{2028}a\u{205F}\u{FEFF}b\r\n"))
expect("exact pattern: whole text only", !matches(TextMatch.exactPattern("Welcome to"), "Welcome to Expo"))
expect("exact pattern: words stay separate", !matches(TextMatch.exactPattern("WelcometoExpo"), "Welcome to Expo"))
expect("contains pattern: NBSP", matches(TextMatch.containsPattern("to Expo"), "Welcome to\u{00A0}Expo"))
expect("contains pattern: across lines", matches(TextMatch.containsPattern("one Line"), "Line one\nLine two"))
expect("contains pattern: multi-line text", matches(TextMatch.containsPattern("two"), "Line one\nLine two\nthree"))
expect("contains pattern: not a substring", !matches(TextMatch.containsPattern("to Expos"), "Welcome to Expo"))
expect("metacharacters are literal (exact)", matches(TextMatch.exactPattern("Total: $5.00 (x)"), "Total: $5.00 (x)"))
expect("metacharacters are literal (dot)", !matches(TextMatch.exactPattern("a.c"), "abc"))
expect("metacharacters are literal (contains)", matches(TextMatch.containsPattern("[beta]*"), "Try [beta]* now"))
expect("metacharacters are literal (quantifier)", !matches(TextMatch.containsPattern("a+"), "aaa"))
expect("backslash sequences are literal", matches(TextMatch.exactPattern("\\Q\\E"), "\\Q\\E"))

// Substring getByText ignores case, as Playwright's non-exact getByText does
// (PILOT-522); exact matching stays case-sensitive.
expect("contains ignores case (textTransform uppercase)", TextMatch.contains("GET STARTED", "get started"))
expect("contains ignores case, mixed and normalized", TextMatch.contains("Welcome to\u{00A0}Expo", "wElCoMe  TO"))
expect("contains ignores case, non-ASCII", TextMatch.contains("ÉCOLE NORMALE", "école"))
expect("contains ignoring case still needs a substring", !TextMatch.contains("GET STARTED", "get startedx"))
expect("contains pattern ignores case", matches(TextMatch.containsPattern("get started"), "GET STARTED"))
expect("contains pattern ignores case across NBSP", matches(TextMatch.containsPattern("TO expo"), "Welcome to\u{00A0}Expo"))
expect("contains pattern metacharacters stay literal", matches(TextMatch.containsPattern("[BETA]*"), "try [beta]* now"))
expect("exact pattern stays case-sensitive", !matches(TextMatch.exactPattern("get started"), "GET STARTED"))

// The snapshot walk (TextMatch.contains) and the live XCUIElement query
// (containsPattern) must agree, or the live query's index binds another
// element: including the case-folding corners ICU folds fully.
let foldCorpus: [(String, String)] = [
    ("STRASSE", "straße"), ("straße", "STRASSE"), ("İSTANBUL", "istanbul"), ("istanbul", "İSTANBUL"),
    ("\u{212A}elvin", "kelvin"), ("ſtop", "STOP"), ("STOP", "ſtop"), ("ΣΟΦΙΑΣ", "σοφιας"),
    ("σοφιας", "ΣΟΦΙΑΣ"), ("ﬁle", "FILE"), ("FILE", "ﬁle"), ("ÉCOLE", "école"), ("Save draft", "SAVE  DRAFT"),
    ("Sign out", "sign in"),
    // NSPredicate's MATCHES also ignores character width under (?i), which
    // Foundation's case-insensitive search does not; Greek dialytika go the
    // other way.
    ("ＯＫ", "ok"), ("OK", "ｏｋ"), ("\u{0390}", "\u{03AA}\u{0301}"),
]
for (text, query) in foldCorpus {
    expect("snapshot and live query agree: \(text) / \(query)",
           TextMatch.contains(text, query) == matches(TextMatch.containsPattern(query), text))
}

// The concatenated-label pattern accepts at least what containsChildText does.
let concat = TextMatch.concatenatedLabelPattern("Welcome to Expo")
expect("concatenated pattern: whole label", matches(concat, "Welcome to\u{00A0}Expo"))
expect("concatenated pattern: first child", matches(concat, "Welcome to\u{00A0}Expo, More"))
expect("concatenated pattern: middle child", matches(concat, "Intro, Welcome to Expo, More"))
expect("concatenated pattern: last child", matches(concat, "Intro,\u{00A0}Welcome to Expo"))
expect("concatenated pattern: multi-line label", matches(concat, "Intro\nline, Welcome to Expo"))
expect("concatenated pattern: not a partial child", !matches(concat, "Intro, Welcome to Expo now"))

// Accessible-name matching (PILOT-549): Playwright's getByRole `name` is a
// case-insensitive substring by default; `exact` is case-sensitive and whole.
expect("name: case-insensitive", TextMatch.nameMatches("SIGN IN", "Sign In", exact: false))
expect("name: substring", TextMatch.nameMatches("Explore the app", "explor", exact: false))
expect("name: normalized substring", TextMatch.nameMatches("Welcome to\u{00A0}Expo", "TO  expo", exact: false))
expect("name: not a substring", !TextMatch.nameMatches("Sign out", "Sign in", exact: false))
expect("name: substring of a concatenated label", TextMatch.nameMatches("Intro, Sign In, More", "sign in", exact: false))
expect("name exact: normalized equality", TextMatch.nameMatches(" Sign\u{00A0}In ", "Sign In", exact: true))
expect("name exact: case-sensitive", !TextMatch.nameMatches("SIGN IN", "Sign In", exact: true))
expect("name exact: whole string", !TextMatch.nameMatches("Sign In now", "Sign In", exact: true))
expect("name exact: still a child of a concatenated label",
       TextMatch.nameMatches("Intro, Sign In, More", "Sign In", exact: true))
expect("name exact: child label is case-sensitive",
       !TextMatch.nameMatches("Intro, SIGN IN, More", "Sign In", exact: true))


// Live re-resolution index for role+name matches (PILOT-549): the position
// within what `label == L [AND identifier == I]` on the scoped type returns.
func node(_ type: UInt, _ label: String, _ id: String = "") -> QueryNode {
    QueryNode(typeRaw: type, label: label, identifier: id)
}
let other: UInt = 46, button: UInt = 9, staticText: UInt = 48
// Two "Delete" buttons: the first has a testID, the second none. The second's
// query (label only) also returns the first, so it is index 1.
let deletes = [node(other, "Delete", "delete-1"), node(other, "Delete")]
expect("no-id node counts earlier id'd same-label nodes", QueryIndex.liveIndex(of: 1, in: deletes, scopeTypeRaw: nil) == 1)
expect("id'd node counts only its id", QueryIndex.liveIndex(of: 0, in: deletes, scopeTypeRaw: nil) == 0)
// Rows sharing a testID but not a label.
let rows = [node(other, "Item 1", "row"), node(other, "Item 2", "row")]
expect("same id, different label: own label only", QueryIndex.liveIndex(of: 1, in: rows, scopeTypeRaw: nil) == 0)
// An .any query (RN .other) also returns a native button and a heading with the same label.
let saves = [node(staticText, "Save"), node(other, "Save"), node(button, "Save"), node(other, "Save")]
expect(".any scope counts every same-label node", QueryIndex.liveIndex(of: 3, in: saves, scopeTypeRaw: nil) == 3)
expect("a specific scope counts only its type", QueryIndex.liveIndex(of: 2, in: saves, scopeTypeRaw: button) == 0)

// A substring getByText match found only through its value (an RN field's
// placeholder, empty label) is re-resolved by the selector's own query, so
// its index counts every earlier node of the scoped type that query returns
// (PILOT-522) — not its position among matches of every type.
let textField: UInt = 49
let emailScreen = [
    QueryNode(typeRaw: staticText, label: "EMAIL", identifier: ""),
    QueryNode(typeRaw: textField, label: "", identifier: "", title: "", value: "Email"),
    QueryNode(typeRaw: textField, label: "", identifier: "", title: "", value: "Confirm email"),
]
let emailMatched = QueryIndex.substringMatches(in: emailScreen, query: "email")
expect("substring fallback: the query returns all three nodes", emailMatched == [true, true, true])
expect("substring fallback: first field is index 0 in the field query",
       QueryIndex.substringLiveIndex(of: 1, in: emailScreen, scopeTypeRaw: textField, matched: emailMatched) == 0)
expect("substring fallback: second field counts the first",
       QueryIndex.substringLiveIndex(of: 2, in: emailScreen, scopeTypeRaw: textField, matched: emailMatched) == 1)
expect("substring fallback: .any scope counts the header too",
       QueryIndex.substringLiveIndex(of: 1, in: emailScreen, scopeTypeRaw: nil, matched: emailMatched) == 1)
// An exact getByText match found only through its value (a label-less
// field's typed text) is re-resolved the same way, by the exact query
// (PILOT-794): a static text with that label earlier on screen counts only
// in an unscoped query, never as the field.
let nickScreen = [
    QueryNode(typeRaw: staticText, label: "nick", identifier: ""),
    QueryNode(typeRaw: textField, label: "", identifier: "", title: "", value: "nickname"),
    QueryNode(typeRaw: textField, label: "", identifier: "", title: "", value: "nick"),
]
let nickMatched = QueryIndex.exactMatches(in: nickScreen, query: "nick")
expect("exact fallback: the query returns the text and the field with that value", nickMatched == [true, false, true])
expect("exact fallback: the field is index 0 in the field query",
       QueryIndex.substringLiveIndex(of: 2, in: nickScreen, scopeTypeRaw: textField, matched: nickMatched) == 0)
expect("exact fallback: .any scope counts the text too",
       QueryIndex.substringLiveIndex(of: 2, in: nickScreen, scopeTypeRaw: nil, matched: nickMatched) == 1)
expect("exact fallback: whitespace-normalized",
       QueryIndex.exactMatches(in: [QueryNode(typeRaw: textField, label: "", identifier: "", title: "", value: "a\u{00A0}b")], query: "a b") == [true])

expect("contains: empty text holds only an empty query",
       !TextMatch.contains("", "email") && TextMatch.contains("", " "))

// RegExp locators (PILOT-520): the SDK's conformance fixture, replayed
// through ICU (NSRegularExpression for the snapshot walk, NSPredicate MATCHES
// with the whole-string wrapper for XCUIElement queries).
let fixturePath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "../packages/tapsmith/src/__tests__/fixtures/regex-conformance.json"
if let data = FileManager.default.contents(atPath: fixturePath),
   let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
   let cases = root["cases"] as? [[String: Any]] {
    expect("the conformance fixture has cases", cases.count > 50)
    for c in cases {
        let source = c["source"] as? String ?? ""
        let flags = c["flags"] as? String ?? ""
        let input = c["input"] as? String ?? ""
        let want = c["matches"] as? Bool ?? false
        let re = TextRegex(
            pattern: c["pattern"] as? String ?? "",
            ignoreCase: c["ignoreCase"] as? Bool ?? false,
            display: "/\(source)/\(flags)"
        )
        let why = c["why"] as? String ?? ""
        expect("regex /\(source)/\(flags): \(why)", re.error == nil && re.matches(input) == want)
        expect("predicate /\(source)/\(flags): \(why)", matches(re.fullMatchPattern, input) == want)
    }
} else {
    expect("the conformance fixture is readable at \(fixturePath)", false)
}

let saveRegex = TextRegex.fromJSON(["pattern": "^save", "ignoreCase": true, "display": "/^save/i"])
expect("fromJSON reads the daemon's object", saveRegex?.display == "/^save/i" && saveRegex?.matches("SAVE draft") == true)
expect("fromJSON of nothing is nil", TextRegex.fromJSON(nil) == nil)
let badRegex = TextRegex(pattern: "(?<=a+", ignoreCase: false, display: "/(?<=a+/")
expect("a pattern ICU rejects carries an error naming the RegExp",
       badRegex.error?.contains("/(?<=a+/") == true && !badRegex.matches("a"))
let nameRegex = TextRegex(pattern: "\\ASave\\u0020draft\\z", ignoreCase: false, display: "/^Save draft$/")
expect("a name RegExp tests the normalized name", nameRegex.nameMatches("  Save\u{202F}\n draft "))
expect("a name RegExp still needs the whole anchored name", !nameRegex.nameMatches("Save draft, more"))

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all TextMatch tests passed")
