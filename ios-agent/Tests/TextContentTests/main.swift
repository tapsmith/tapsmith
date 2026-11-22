// Unit tests for TextContent (PILOT-794): what getByText reads on iOS,
// replayed from the SDK's conformance fixture so the trace playground's
// matcher and the agent agree.

import Foundation
import XCTest

var failures = 0

func expect(_ name: String, _ ok: Bool) {
    if ok {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name)")
    }
}

/// The element types the fixture names, by the type name the hierarchy dump writes.
let typesByName: [String: XCUIElement.ElementType] = {
    let types: [XCUIElement.ElementType] = [
        .staticText, .button, .switch, .toggle, .slider, .stepper, .textField, .secureTextField,
        .textView, .searchField, .other, .alert, .cell, .link, .progressIndicator, .pickerWheel, .image,
    ]
    var map: [String: XCUIElement.ElementType] = [:]
    for type in types { map[RoleMapping.typeName(for: type)] = type }
    return map
}()

expect("a toggle has a dump type name", RoleMapping.typeName(for: .toggle) == "XCUIElementTypeToggle")
expect("a picker wheel has a dump type name", RoleMapping.typeName(for: .pickerWheel) == "XCUIElementTypePickerWheel")
expect("a progress indicator has a dump type name",
       RoleMapping.typeName(for: .progressIndicator) == "XCUIElementTypeProgressIndicator")

// A generic wrapper copying a name-only descendant's label onto its own
// bounds (React Native's <Image accessibilityLabel>: an Other over the
// Image) is that descendant's name, not text (PILOT-1366).
expect("an Other echoing a same-target image's label is its name",
       TextContent.echoesName(wrapperType: .other, wrapperLabel: "The Flower Girl",
                              nodeType: .image, nodeLabel: "The Flower Girl", sameTarget: true))
expect("an Other echoing a same-target switch's label is its name",
       TextContent.echoesName(wrapperType: .other, wrapperLabel: "Wi-Fi",
                              nodeType: .switch, nodeLabel: "Wi-Fi", sameTarget: true))
expect("an Other with other bounds is a container, not an echo",
       !TextContent.echoesName(wrapperType: .other, wrapperLabel: "The Flower Girl",
                               nodeType: .image, nodeLabel: "The Flower Girl", sameTarget: false))
expect("an Other with another label is not an echo",
       !TextContent.echoesName(wrapperType: .other, wrapperLabel: "Gallery, The Flower Girl",
                               nodeType: .image, nodeLabel: "The Flower Girl", sameTarget: true))
expect("a button over a same-target image keeps its label as text",
       !TextContent.echoesName(wrapperType: .button, wrapperLabel: "Share",
                               nodeType: .image, nodeLabel: "Share", sameTarget: true))
expect("an Other over a same-target static text is no name echo",
       !TextContent.echoesName(wrapperType: .other, wrapperLabel: "Hello",
                               nodeType: .staticText, nodeLabel: "Hello", sameTarget: true))
expect("an unlabelled wrapper is not an echo",
       !TextContent.echoesName(wrapperType: .other, wrapperLabel: "",
                               nodeType: .image, nodeLabel: "", sameTarget: true))

let fixturePath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "../packages/tapsmith/src/__tests__/fixtures/text-content-conformance.json"
if let data = FileManager.default.contents(atPath: fixturePath),
   let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
   let cases = root["cases"] as? [[String: Any]] {
    // The Android cases are the Android agent's (LocatorConformanceTest).
    let iosCases = cases.filter { $0["platform"] as? String == "ios" }
    expect("the conformance fixture has iOS cases", iosCases.count > 30)
    for c in iosCases {
        let why = c["why"] as? String ?? ""
        let typeName = c["type"] as? String ?? ""
        guard let type = typesByName[typeName] else {
            expect("\(why): known type \(typeName)", false)
            continue
        }
        let texts = TextContent.texts(
            elementType: type,
            label: c["label"] as? String ?? "",
            title: c["title"] as? String ?? "",
            value: c["value"] as? String ?? "",
            placeholder: c["placeholder"] as? String ?? "",
            containerLabel: c["container"] as? String ?? ""
        )
        let want = c["matches"] as? Bool ?? false
        let query = c["query"] as? [String: Any] ?? [:]
        if let exact = query["exact"] as? String {
            // In a table row beside static texts, as the snapshot walk sees it.
            let node: [String: Any] = [
                "elementType": type.rawValue, "label": c["label"] as? String ?? "",
                "title": c["title"] as? String ?? "", "value": c["value"] as? String ?? "",
                "placeholderValue": c["placeholder"] as? String ?? "",
            ]
            let rowCell: [String: Any]? = (c["row"] as? [String]).map { labels in
                [
                    "elementType": XCUIElement.ElementType.cell.rawValue, "label": "",
                    "children": [node] + labels.map {
                        ["elementType": XCUIElement.ElementType.staticText.rawValue, "label": $0] as [String: Any]
                    },
                ]
            }
            let rowShows = TextContent.rowShows(exact, texts: texts, node: node, rowCell: rowCell)
            expect("exact \(why)", TextContent.matchesExact(texts, exact, rowShowsQuery: rowShows) == want)
        } else if let substring = query["substring"] as? String {
            expect("substring \(why)", TextContent.matchesSubstring(texts, substring) == want)
        } else if let pattern = query["pattern"] as? String {
            let source = query["source"] as? String ?? ""
            let flags = query["flags"] as? String ?? ""
            let re = TextRegex(
                pattern: pattern,
                ignoreCase: query["ignoreCase"] as? Bool ?? false,
                display: "/\(source)/\(flags)"
            )
            expect("regex /\(source)/\(flags) \(why)", re.error == nil && TextContent.matchesRegex(texts, re) == want)
        } else {
            expect("\(why): has a query", false)
        }
    }
} else {
    expect("the conformance fixture is readable at \(fixturePath)", false)
}

// A recorded UIKit table in edit mode (PILOT-1374): each row's Remove and
// Reorder controls are labelled "Remove A, 981 195, Alpha (a@example.com)".
// An exact getByText of a row's text matches the row's static text alone.
let fixturesDir = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "Tests/Fixtures"
let table = HierarchyFixture.load("\(fixturesDir)/iphone-se-18.2/edit-mode-table.xml")

/// The labels of the nodes an exact getByText of `query` matches in `tree`,
/// with each node's container label and nearest row as the walk passes them.
func exactMatches(_ query: String, in tree: [String: Any]) -> [String] {
    var found: [String] = []
    func walk(_ node: [String: Any], containerLabel: String, rowCell: [String: Any]?) {
        let type = XCUIElement.ElementType(rawValue: node["elementType"] as? UInt ?? 0) ?? .other
        let label = node["label"] as? String ?? ""
        let texts = TextContent.texts(
            elementType: type, label: label, title: node["title"] as? String ?? "",
            value: node["value"] as? String ?? "",
            placeholder: node["placeholderValue"] as? String ?? "", containerLabel: containerLabel
        )
        let rowShows = TextContent.rowShows(query, texts: texts, node: node, rowCell: rowCell)
        if TextContent.matchesExact(texts, query, rowShowsQuery: rowShows) {
            found.append("\(RoleMapping.typeName(for: type)):\(label)")
        }
        for child in node["children"] as? [[String: Any]] ?? [] {
            walk(child, containerLabel: label.isEmpty ? containerLabel : label, rowCell: type == .cell ? node : rowCell)
        }
    }
    walk(tree, containerLabel: "", rowCell: nil)
    return found
}

expect("a row's text in an edit-mode table is its static text alone",
       exactMatches("Alpha (a@example.com)", in: table) == ["XCUIElementTypeStaticText:Alpha (a@example.com)"])
expect("every row's text is its static text alone",
       exactMatches("Charlie (c@example.com)", in: table) == ["XCUIElementTypeStaticText:Charlie (c@example.com)"])
expect("a code every row shows is each row's static text",
       exactMatches("981 195", in: table) == Array(repeating: "XCUIElementTypeStaticText:981 195", count: 3))
expect("an initial is its static text",
       exactMatches("A", in: table) == ["XCUIElementTypeStaticText:A"])
expect("outside its row, a Remove control's joined part still matches",
       TextContent.rowShows("Alpha (a@example.com)",
                            texts: TextContent.texts(elementType: .button,
                                                     label: "Remove A, 981 195, Alpha (a@example.com)",
                                                     title: "", value: "", placeholder: "", containerLabel: ""),
                            node: [:], rowCell: nil) == false)

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all TextContent tests passed")
