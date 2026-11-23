// Unit tests for LabelMatch (PILOT-666): getByLabel's rule, replayed from the
// SDK's conformance fixture so the locator playground and the agent agree.

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
        .textField, .secureTextField, .textView, .switch, .toggle, .slider, .stepper, .picker,
        .checkBox, .radioButton, .searchField, .button, .staticText, .other,
    ]
    var map: [String: XCUIElement.ElementType] = [:]
    for type in types { map[RoleMapping.typeName(for: type)] = type }
    return map
}()

expect("a text view has a dump type name", RoleMapping.typeName(for: .textView) == "XCUIElementTypeTextView")
expect("a stepper has a dump type name", RoleMapping.typeName(for: .stepper) == "XCUIElementTypeStepper")

// A checkbox or radio button: its native type, or a generic view React
// Native describes as one in its value.
expect("a described checkbox is a choice", LabelMatch.isChoice(elementType: .other, value: "checkbox, checked"))
expect("a described radio is a choice", LabelMatch.isChoice(elementType: .other, value: "radio button, unchecked"))
expect("a native check box is a choice", LabelMatch.isChoice(elementType: .checkBox, value: nil))
expect("a described combo box is no choice", !LabelMatch.isChoice(elementType: .other, value: "combo box"))
expect("an undescribed view is no choice", !LabelMatch.isChoice(elementType: .other, value: nil))
expect("a static text described as a checkbox is no choice",
       !LabelMatch.isChoice(elementType: .staticText, value: "checkbox, unchecked"))
// A text view's label holding one text twice (React Native's empty multi-line input).
expect("a repeated text view label", LabelMatch.unrepeated("Notes Notes", elementType: .textView) == "Notes")
expect("a repeated label, whitespace-normalized",
       LabelMatch.unrepeated(" Delivery  notes Delivery notes ", elementType: .textView) == "Delivery notes")
expect("a repeated label with non-ASCII text", LabelMatch.unrepeated("Café 🍰 Café 🍰", elementType: .textView) == "Café 🍰")
expect("a text field's label is never unrepeated", LabelMatch.unrepeated("Notes Notes", elementType: .textField).isEmpty)
expect("another placeholder is no repeat", LabelMatch.unrepeated("Notes Add a note", elementType: .textView).isEmpty)
expect("an even label is no repeat", LabelMatch.unrepeated("NotesNotes", elementType: .textView).isEmpty)
expect("a single space is no repeat", LabelMatch.unrepeated(" ", elementType: .textView).isEmpty)

let fixturePath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "../packages/tapsmith/src/__tests__/fixtures/label-conformance.json"
if let data = FileManager.default.contents(atPath: fixturePath),
   let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
   let cases = root["cases"] as? [[String: Any]] {
    let iosCases = cases.filter { $0["platform"] as? String == "ios" }
    expect("the conformance fixture has iOS cases", iosCases.count > 20)
    for c in iosCases {
        let why = c["why"] as? String ?? ""
        let typeName = c["type"] as? String ?? ""
        guard let type = typesByName[typeName] else {
            expect("\(why): known type \(typeName)", false)
            continue
        }
        let label = c["label"] as? String ?? ""
        let title = c["title"] as? String ?? ""
        let rowLabel = c["rowLabel"] as? String ?? ""
        let value = c["value"] as? String ?? ""
        let want = c["matches"] as? Bool ?? false
        if let query = c["query"] as? String {
            let got = LabelMatch.matches(
                elementType: type, label: label, title: title, value: value, rowLabel: rowLabel, query: query
            )
            expect("string \(why)", got == want)
        } else if let query = c["query"] as? [String: Any] {
            let source = query["source"] as? String ?? ""
            let flags = query["flags"] as? String ?? ""
            let re = TextRegex(
                pattern: query["pattern"] as? String ?? "",
                ignoreCase: query["ignoreCase"] as? Bool ?? false,
                display: "/\(source)/\(flags)"
            )
            let got = LabelMatch.matches(
                elementType: type, label: label, title: title, value: value, rowLabel: rowLabel, regex: re
            )
            expect("regex /\(source)/\(flags) \(why)", re.error == nil && got == want)
        } else {
            expect("\(why): has a query", false)
        }
    }
} else {
    expect("the conformance fixture is readable at \(fixturePath)", false)
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all LabelMatch tests passed")
