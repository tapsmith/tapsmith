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
        .textField, .secureTextField, .textView, .switch, .slider, .stepper, .picker,
        .checkBox, .radioButton, .searchField, .button, .staticText, .other,
    ]
    var map: [String: XCUIElement.ElementType] = [:]
    for type in types { map[RoleMapping.typeName(for: type)] = type }
    return map
}()

expect("a text view has a dump type name", RoleMapping.typeName(for: .textView) == "XCUIElementTypeTextView")
expect("a stepper has a dump type name", RoleMapping.typeName(for: .stepper) == "XCUIElementTypeStepper")

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
        let want = c["matches"] as? Bool ?? false
        if let query = c["query"] as? String {
            let got = LabelMatch.matches(elementType: type, label: label, title: title, query: query)
            expect("string \(why)", got == want)
        } else if let query = c["query"] as? [String: Any] {
            let source = query["source"] as? String ?? ""
            let flags = query["flags"] as? String ?? ""
            let re = TextRegex(
                pattern: query["pattern"] as? String ?? "",
                ignoreCase: query["ignoreCase"] as? Bool ?? false,
                display: "/\(source)/\(flags)"
            )
            let got = LabelMatch.matches(elementType: type, label: label, title: title, regex: re)
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
