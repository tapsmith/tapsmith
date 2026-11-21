// Unit tests for RowName: a settings row's control is labelled by its row's
// title for getByLabel. Run on the host Mac without a simulator:
// `ios-agent/Tests/run-unit-tests.sh`. The rows are shaped like the native
// fixture app's UIKit Settings screen recorded on iOS 18.5, 26.5 and 27.2
// simulators: a `.cell` with an empty label holding background views, its
// static texts and the switch UIKit labels with those texts joined by ", ".

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

/// A UIKit settings row as the simulator reports it.
func row(_ texts: [String], control: [String: Any]) -> [String: Any] {
    node(.cell, value: control["value"] as? String, [node(.other, [node(.other)])]
        + texts.map { node(.staticText, label: $0) } + [node(.other), control])
}

/// Mark `tree` and return the row label of the first node of `type` in it, depth first.
func markedLabel(_ tree: [String: Any], _ type: XCUIElement.ElementType = .switch) -> String? {
    var dict = tree
    RowName.markRowLabels(in: &dict)
    func find(_ n: [String: Any]) -> [String: Any]? {
        if (n["elementType"] as? UInt) == type.rawValue { return n }
        for c in children(n) { if let f = find(c) { return f } }
        return nil
    }
    guard let found = find(dict) else { return nil }
    return found[RowName.labelKey] as? String
}

func table(_ rows: [[String: Any]]) -> [String: Any] { node(.table, rows) }

// ─── A row's derived label ───

check("a row with a subtitle labels its switch by its title",
      markedLabel(table([row(["Wi-Fi", "Join known networks"],
                             control: node(.switch, label: "Wi-Fi, Join known networks", value: "1"))])),
      "Wi-Fi")
check("a row with only a title labels its switch by it",
      markedLabel(table([row(["Airplane Mode"], control: node(.switch, label: "Airplane Mode", value: "0"))])),
      "Airplane Mode")
check("the label matches whitespace-normalized",
      markedLabel(table([row(["Personal  Hotspot", "Off"],
                             control: node(.switch, label: "Personal Hotspot, Off", value: "0"))])),
      "Personal Hotspot")
check("a switch with its own label keeps it alone",
      markedLabel(table([row(["Bluetooth"], control: node(.switch, label: "Bluetooth radio", value: "1"))])),
      nil)
check("an unlabelled switch takes no row label (no runtime reports one)",
      markedLabel(table([row(["Bluetooth"], control: node(.switch, value: "1"))])),
      nil)
check("a label with the texts in another order is the control's own",
      markedLabel(table([row(["Wi-Fi", "Join"], control: node(.switch, label: "Join, Wi-Fi", value: "1"))])),
      nil)

// A custom row lays its label and switch out in the content view (a stack).
check("a switch in the row's content view is labelled by the row's title",
      markedLabel(table([node(.cell, [node(.other, [node(.staticText, label: "Sync Photos"), node(.other),
                                                     node(.switch, label: "Sync Photos", value: "0")])])])),
      "Sync Photos")

// ─── What the row's text leaves out ───

check("a button's title is no part of the row's text",
      RowName.textParts(ofRow: node(.cell, [node(.staticText, label: "Row 6"), node(.button, label: "More Info"),
                                            node(.switch, label: "Row 6")])),
      ["Row 6"])
check("the hooks marker is no part of the row's text",
      RowName.textParts(ofRow: node(.cell, [node(.staticText, label: "tapsmith-hooks:1"),
                                            node(.staticText, label: "Wi-Fi")])),
      ["Wi-Fi"])
check("texts in generic containers count, in tree order",
      RowName.textParts(ofRow: node(.cell, [node(.other, [node(.staticText, label: "A")]),
                                            node(.staticText, label: "B")])),
      ["A", "B"])

// ─── Where a row stops ───

check("a switch outside any row takes no row label",
      markedLabel(node(.other, [node(.staticText, label: "Bluetooth"), node(.switch, label: "Bluetooth", value: "1")])),
      nil)
check("a row's list is no row: a switch below a nested table is not the row's",
      markedLabel(node(.cell, [node(.staticText, label: "Outer"),
                               node(.table, [node(.other, [node(.switch, label: "Outer", value: "1")])])])),
      nil)
check("a switch more than four levels below its row is not the row's",
      markedLabel(node(.cell, [node(.staticText, label: "Deep"),
                               node(.other, [node(.other, [node(.other, [node(.other, [
                                   node(.switch, label: "Deep", value: "1")])])])])])),
      nil)
check("a switch four levels below its row is the row's",
      markedLabel(node(.cell, [node(.staticText, label: "Deep"),
                               node(.other, [node(.other, [node(.other, [
                                   node(.switch, label: "Deep", value: "1")])])])])),
      "Deep")
check("a nested row labels its own switch",
      markedLabel(node(.cell, [node(.staticText, label: "Outer"),
                               node(.cell, [node(.staticText, label: "Inner"),
                                            node(.switch, label: "Inner", value: "1")])])),
      "Inner")

// A SwiftUI Form Toggle row: the row-sized switch holds the label's text
// and the knob (PILOT-790). The text is the Toggle's, not the row's, so the
// row has no text of its own and nothing is marked; the Toggle is named by
// its own label, as before.
do {
    let toggleRow = node(.cell, [node(.other, [node(.other, [
        node(.switch, label: "Dark Mode", value: "0", [node(.staticText, label: "Dark Mode"), node(.switch, value: "0")]),
    ])])])
    check("a SwiftUI Toggle row's text is the Toggle's", RowName.textParts(ofRow: toggleRow), [String]())
    check("a SwiftUI Toggle takes no row label", markedLabel(table([toggleRow])), nil)
}

// ─── Other checkable controls, not other controls ───

check("a checkbox is labelled by its row",
      markedLabel(table([row(["Remember me"], control: node(.checkBox, label: "Remember me", value: "0"))]), .checkBox),
      "Remember me")
check("a slider is not",
      markedLabel(table([row(["Volume"], control: node(.slider, label: "Volume", value: "50%"))]), .slider),
      nil)

// ─── The rule on its own ───

check("rowLabel: no parts, no label",
      RowName.rowLabel(control: node(.switch, label: "X"), rowParts: []), nil)
check("rowLabel: a button is not checkable",
      RowName.rowLabel(control: node(.button, label: "A, B"), rowParts: ["A", "B"]), nil)
check("rowLabel: the first part",
      RowName.rowLabel(control: node(.toggle, label: "A, B"), rowParts: ["A", "B"]), "A")

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all RowName tests passed")
