// Unit tests for getByRole (PILOT-834, PILOT-707): RoleMapping's role rule
// and RoleName's name rule, with the placeholder fallback for a text input
// that has no label or title, replayed from the SDK's conformance fixture so
// the locator playground and the agents agree. Each case also says which role
// the hierarchy dump reports for the element (RoleMapping.resolveRole), which
// is all the playground knows of its traits. Also QueryIndex.placeholderLiveIndex, which re-finds such a match
// through a live placeholderValue query.

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
        .textField, .secureTextField, .textView, .searchField, .button, .staticText, .other, .link, .image,
        .slider, .switch, .toggle, .tab, .tabBar, .checkBox, .stepper, .progressIndicator, .activityIndicator,
        .cell, .table,
    ]
    var map: [String: XCUIElement.ElementType] = [:]
    for type in types { map[RoleMapping.typeName(for: type)] = type }
    return map
}()

/// The fixture's trait names, as the bits RoleMapping reads.
let traitsByName: [String: UInt64] = [
    "button": AccessibilityTrait.button,
    "link": AccessibilityTrait.link,
    "image": AccessibilityTrait.image,
    "staticText": AccessibilityTrait.staticText,
    "header": AccessibilityTrait.header,
    "adjustable": AccessibilityTrait.adjustable,
    "searchField": AccessibilityTrait.searchField,
]

let fixturePath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "../packages/tapsmith/src/__tests__/fixtures/role-conformance.json"
if let data = FileManager.default.contents(atPath: fixturePath),
   let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
   let cases = root["cases"] as? [[String: Any]] {
    let iosCases = cases.filter { $0["platform"] as? String == "ios" }
    expect("the conformance fixture has iOS cases", iosCases.count > 50)
    for c in iosCases {
        let why = c["why"] as? String ?? ""
        let typeName = c["type"] as? String ?? ""
        guard let type = typesByName[typeName] else {
            expect("\(why): known type \(typeName)", false)
            continue
        }
        let label = c["label"] as? String ?? ""
        let title = c["title"] as? String ?? ""
        let placeholder = c["placeholder"] as? String ?? ""
        let value = c["value"] as? String ?? ""
        let role = c["role"] as? String ?? ""
        let inTabBar = c["inTabBar"] as? Bool ?? false
        var traits: UInt64 = 0
        for name in c["traits"] as? [String] ?? [] {
            guard let bit = traitsByName[name] else {
                expect("\(why): known trait \(name)", false)
                continue
            }
            traits |= bit
        }
        let want = c["matches"] as? Bool ?? false
        let reported = RoleMapping.resolveRole(for: type, traits: traits, inTabBar: inTabBar)
        expect("reports \(c["reportedRole"] as? String ?? "no role") \(why)",
               reported == (c["reportedRole"] as? String ?? ""))
        let isRole = RoleMapping.matches(
            role: role, elementType: type, traits: traits, value: value,
            hasNameFilter: c["name"] != nil, inTabBar: inTabBar
        )
        if c["name"] == nil {
            expect("role \(role) \(why)", isRole == want)
        } else if let name = c["name"] as? String {
            let got = isRole && RoleName.matches(
                elementType: type, label: label, title: title, placeholder: placeholder,
                name: name, exact: c["exact"] as? Bool ?? false
            )
            expect("string \(why)", got == want)
        } else if let name = c["name"] as? [String: Any] {
            let source = name["source"] as? String ?? ""
            let flags = name["flags"] as? String ?? ""
            let re = TextRegex(
                pattern: name["pattern"] as? String ?? "",
                ignoreCase: name["ignoreCase"] as? Bool ?? false,
                display: "/\(source)/\(flags)"
            )
            let got = isRole && RoleName.matches(
                elementType: type, label: label, title: title, placeholder: placeholder, regex: re
            )
            expect("regex /\(source)/\(flags) \(why)", re.error == nil && got == want)
        } else {
            expect("\(why): has a name", false)
        }
    }
} else {
    expect("the conformance fixture is readable at \(fixturePath)", false)
}

// placeholderName: only a text input with no label or title.
expect("placeholderName of a label-less field",
       RoleName.placeholderName(elementType: .textField, label: "", title: "", placeholder: "Title") == "Title")
expect("no placeholderName for a labelled field",
       RoleName.placeholderName(elementType: .textField, label: "Email", title: "", placeholder: "Title") == nil)
expect("no placeholderName without a placeholder",
       RoleName.placeholderName(elementType: .textField, label: "", title: "", placeholder: "") == nil)
expect("no placeholderName for a button",
       RoleName.placeholderName(elementType: .button, label: "", title: "", placeholder: "Go") == nil)

// placeholderLiveIndex: the match's index among the nodes a live
// `placeholderValue == p` query (scoped to its type) returns.
let field = XCUIElement.ElementType.textField.rawValue
let nodes: [QueryNode] = [
    QueryNode(typeRaw: field, label: "", identifier: "", placeholder: "Title"),
    QueryNode(typeRaw: XCUIElement.ElementType.staticText.rawValue, label: "Title", identifier: ""),
    QueryNode(typeRaw: field, label: "Notes", identifier: "", placeholder: "Title"),
    QueryNode(typeRaw: field, label: "", identifier: "", placeholder: "Body"),
    QueryNode(typeRaw: field, label: "", identifier: "", placeholder: "Title"),
    QueryNode(typeRaw: field, label: "", identifier: "second", placeholder: "Title"),
]
expect("first placeholder match is index 0",
       QueryIndex.placeholderLiveIndex(of: 0, in: nodes, scopeTypeRaw: field) == 0)
// A labelled field with the same placeholder is returned by the query too.
expect("same-placeholder fields before it count, labelled or not",
       QueryIndex.placeholderLiveIndex(of: 4, in: nodes, scopeTypeRaw: field) == 2)
expect("an identifier narrows the query to its own id",
       QueryIndex.placeholderLiveIndex(of: 5, in: nodes, scopeTypeRaw: field) == 0)

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all RoleName tests passed")
