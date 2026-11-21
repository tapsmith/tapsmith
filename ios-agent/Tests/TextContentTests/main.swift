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
            containerLabel: c["container"] as? String ?? ""
        )
        let want = c["matches"] as? Bool ?? false
        let query = c["query"] as? [String: Any] ?? [:]
        if let exact = query["exact"] as? String {
            expect("exact \(why)", TextContent.matchesExact(texts, exact) == want)
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

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all TextContent tests passed")
