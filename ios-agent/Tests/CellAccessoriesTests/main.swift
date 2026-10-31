// Unit tests for CellAccessories and DescendantText (PILOT-895), run on the
// host Mac without a simulator: `ios-agent/Tests/run-unit-tests.sh`. The trees
// are shaped like the snapshot of a plain UITableViewController recorded on an
// iPhone 17 Pro / iOS 26 simulator: each row is a `.cell` with an empty label,
// its text in a child static text, and UIKit's accessory indicator a childless,
// not-enabled `.button` labelled "chevron" or "checkmark".

import XCTest

var failures = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want \(want)")
    }
}

func node(
    _ type: XCUIElement.ElementType,
    label: String = "",
    value: String? = nil,
    enabled: Bool = true,
    _ children: [[String: Any]] = []
) -> [String: Any] {
    var dict: [String: Any] = ["elementType": type.rawValue, "label": label, "enabled": enabled]
    if let value { dict["value"] = value }
    if !children.isEmpty { dict["children"] = children }
    return dict
}

func children(_ dict: [String: Any]) -> [[String: Any]] {
    dict["children"] as? [[String: Any]] ?? []
}

func enabled(_ dict: [String: Any]) -> Bool? { dict["enabled"] as? Bool }

/// A UIKit row as the simulator reports it: background views, the text, the
/// separator, then the accessories.
func row(_ text: String, cellEnabled: Bool = true, accessories: [[String: Any]]) -> [String: Any] {
    node(.cell, enabled: cellEnabled, [
        node(.other, [node(.other)]),
        node(.staticText, label: text),
        node(.other),
    ] + accessories)
}

let chevron = node(.button, label: "chevron", enabled: false)
let checkmark = node(.button, label: "checkmark", enabled: false)
let moreInfo = node(.button, label: "More Info")
/// A custom accessoryView: a disabled UIButton, which has a title child.
let buy = node(.button, label: "Buy", enabled: false, [node(.staticText, label: "Buy")])

func normalized(_ dict: [String: Any]) -> [String: Any] {
    var d = dict
    CellAccessories.normalizeIndicators(in: &d)
    return d
}

func table(_ rows: [[String: Any]]) -> [String: Any] {
    node(.application, label: "App", [node(.window, [node(.table, [node(.staticText, label: "Nothing selected")] + rows)])])
}

func rowsOf(_ app: [String: Any]) -> [[String: Any]] {
    Array(children(children(children(app)[0])[0]).dropFirst())
}

// MARK: - Accessory indicators take their cell's enabled state

do {
    let app = normalized(table([
        row("Row 1", accessories: [chevron]),
        row("Row 2", accessories: [moreInfo]),
        row("Row 3", accessories: [moreInfo, chevron]),
        row("Row 4", accessories: [checkmark]),
        row("Row 5", accessories: [buy]),
        row("Row 6", cellEnabled: false, accessories: [chevron]),
    ]))
    let rows = rowsOf(app)
    check("a disclosure chevron reads enabled, as its row", enabled(children(rows[0])[3]), true)
    check("a disclosure chevron is marked as an indicator", CellAccessories.isMarkedIndicator(children(rows[0])[3]), true)
    check("the detail button (More Info) is left alone", enabled(children(rows[1])[3]), true)
    check("the detail button is not an indicator", CellAccessories.isMarkedIndicator(children(rows[1])[3]), false)
    check("detail disclosure: the chevron beside More Info reads enabled", enabled(children(rows[2])[4]), true)
    check("a checkmark reads enabled, as its row", enabled(children(rows[3])[3]), true)
    check("a custom disabled accessory button stays disabled", enabled(children(rows[4])[3]), false)
    check("a custom disabled accessory button is not an indicator", CellAccessories.isMarkedIndicator(children(rows[4])[3]), false)
    check("a disabled row's chevron reads disabled", enabled(children(rows[5])[3]), false)
    check("the row's text is untouched", children(rows[0])[1]["label"] as? String, "Row 1")
}

do {
    // Only a cell's own direct child: a chevron-labelled disabled button
    // elsewhere is the app's, and so is one nested deeper inside a row.
    let loose = normalized(node(.application, [node(.other, [chevron])]))
    check("a disabled 'chevron' button outside a cell keeps its state", enabled(children(children(loose)[0])[0]), false)
    let nested = normalized(node(.cell, [node(.other, [chevron])]))
    check("a disabled 'chevron' button nested inside a row's view keeps its state",
          enabled(children(children(nested)[0])[0]), false)
    let withChild = normalized(node(.cell, [node(.button, label: "chevron", enabled: false, [node(.image)])]))
    check("a 'chevron' button with children is not UIKit's indicator", enabled(children(withChild)[0]), false)
    let otherLabel = normalized(node(.cell, [node(.button, label: "Chevron", enabled: false)]))
    check("the label must match exactly", enabled(children(otherLabel)[0]), false)
    let image = normalized(node(.cell, [node(.image, label: "chevron", enabled: false)]))
    check("only a button is an indicator", enabled(children(image)[0]), false)
    let enabledChevron = normalized(node(.cell, [node(.button, label: "chevron")]))
    check("an enabled 'chevron' button is not marked", CellAccessories.isMarkedIndicator(children(enabledChevron)[0]), false)
}

do {
    // Element types arrive as NSNumber from a real snapshot.
    var dict: [String: Any] = [
        "elementType": NSNumber(value: XCUIElement.ElementType.cell.rawValue),
        "enabled": true,
        "children": [["elementType": NSNumber(value: XCUIElement.ElementType.button.rawValue), "label": "chevron", "enabled": false]],
    ]
    CellAccessories.normalizeIndicators(in: &dict)
    check("NSNumber element types are read", enabled(children(dict)[0]), true)
}

do {
    // A tree with no cells is returned as it was.
    let plain = node(.application, [node(.button, label: "OK", enabled: false)])
    check("no cells: nothing changes", NSDictionary(dictionary: normalized(plain)).isEqual(to: plain), true)
}

// MARK: - A row's text

do {
    let app = normalized(table([
        row("Row 1", accessories: [chevron]),
        row("Row 3", accessories: [moreInfo, chevron]),
        row("Row 4", accessories: [checkmark]),
        row("Row 5", accessories: [buy]),
    ]))
    let rows = rowsOf(app)
    check("a row's text is its static text, without the chevron", DescendantText.collect(rows[0]), "Row 1")
    check("a detail-disclosure row keeps the More Info button's name", DescendantText.collect(rows[1]), "Row 3 More Info")
    check("a checkmark is no part of a row's text", DescendantText.collect(rows[2]), "Row 4")
    check("a custom accessory button's title is part of the text", DescendantText.collect(rows[3]), "Row 5 Buy")
    // Without normalisation (the indicator never marked) the label is text.
    check("an unmarked chevron is read like any button", DescendantText.collect(row("Row 1", accessories: [chevron])), "Row 1 chevron")
}

check("a cell aggregates its descendants' text", DescendantText.aggregates(.cell), true)
check("a generic container aggregates", DescendantText.aggregates(.other), true)
check("a table does not", DescendantText.aggregates(.table), false)
check("a scroll view does not", DescendantText.aggregates(.scrollView), false)
check("a button does not", DescendantText.aggregates(.button), false)

do {
    let hooks = node(.other, [node(.staticText, label: "tapsmith-hooks:1"), node(.staticText, label: "Hello")])
    check("the hooks marker is no one's text", DescendantText.collect(hooks), "Hello")
    let valued = node(.other, [node(.staticText, label: "Name"), node(.button, label: "Plan", value: "Pro")])
    check("a child's value comes before its label", DescendantText.collect(valued), "Name Pro")
    // A switch's "0"/"1" and a slider's value are not text on screen.
    let wifi = node(.cell, [node(.staticText, label: "Wi-Fi"), node(.switch, label: "Wi-Fi", value: "1")])
    check("a row's switch adds no text", DescendantText.collect(wifi), "Wi-Fi")
    let unlabelled = node(.cell, [node(.staticText, label: "Bluetooth"), node(.switch, value: "0")])
    check("an unlabelled switch adds no text", DescendantText.collect(unlabelled), "Bluetooth")
    let controls = node(.cell, [
        node(.staticText, label: "Volume"), node(.slider, label: "Volume", value: "50%"),
        node(.stepper, label: "Count", [node(.button, label: "Count, Increment")]), node(.toggle, value: "1"),
    ])
    check("sliders, steppers and toggles add no text", DescendantText.collect(controls), "Volume")
    // A SwiftUI Form Toggle row: the row-sized switch holds the label's text
    // and the knob (measured on an iOS 26 simulator).
    let toggleRow = node(.cell, [node(.other, [node(.other, [
        node(.switch, label: "Dark Mode", value: "0", [node(.staticText, label: "Dark Mode"), node(.switch, value: "0")]),
    ])])])
    check("a SwiftUI Toggle row reads its label's text", DescendantText.collect(toggleRow), "Dark Mode")
    let nested = node(.cell, [node(.other, [node(.other, [node(.staticText, label: "Deep")])])])
    check("text nested under unlabelled views is found", DescendantText.collect(nested), "Deep")
    var deep = node(.staticText, label: "Too deep")
    for _ in 0...DescendantText.maxDepth { deep = node(.other, [deep]) }
    check("recursion stops at maxDepth", DescendantText.collect(deep), "")
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all CellAccessories/DescendantText tests passed")
