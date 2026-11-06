// Unit tests for RowAnchor (PILOT-952), run on the host Mac without a
// simulator: `ios-agent/Tests/run-unit-tests.sh`. The trees are shaped like a
// plain UITableViewController's snapshot: each row a `.cell` with an empty
// label, its text a child static text, and an accessory button.

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
    _ type: XCUIElement.ElementType, label: String = "", id: String = "", _ children: [[String: Any]] = []
) -> [String: Any] {
    var dict: [String: Any] = ["elementType": type.rawValue, "label": label, "identifier": id]
    if !children.isEmpty { dict["children"] = children }
    return dict
}

func row(_ text: String, _ extra: [[String: Any]] = [node(.button, label: "More Info")]) -> [String: Any] {
    node(.cell, [node(.staticText, label: text)] + extra)
}

// ─── cellCounts / anchor ───

let table = node(.table, [
    node(.staticText, label: "Header"),
    row("Row 1"), row("Row 2"), row("Row 2"),
    row("Row 3", [node(.staticText, label: "Detail"), node(.button, label: "More Info")]),
    row("Row 4", [node(.staticText, label: "Detail")]),
])
let counts = RowAnchor.cellCounts(in: table)
check("a row's own text counts once", counts["Row 1"], 1)
check("two rows with one text count twice", counts["Row 2"], 2)
check("a text outside every cell is not counted", counts["Header"], nil)
check("a shared second text counts per row", counts["Detail"], 2)
let rows = table["children"] as! [[String: Any]]
check("a row is anchored by its unique text", RowAnchor.anchor(ofCell: rows[1], counts: counts), "Row 1")
check("rows sharing their only text have no anchor", RowAnchor.anchor(ofCell: rows[2], counts: counts), nil)
check("the first unique text anchors, a shared one is skipped",
      RowAnchor.anchor(ofCell: rows[4], counts: counts), "Row 3")
check("a row with no text has no anchor",
      RowAnchor.anchor(ofCell: node(.cell, [node(.textField)]), counts: counts), nil)
// A static text repeated within one row still counts once for that row.
let twice = node(.table, [node(.cell, [node(.staticText, label: "A"), node(.staticText, label: "A")])])
check("a text twice in one row counts once", RowAnchor.cellCounts(in: twice)["A"], 1)
// A nested cell's text is in both cells, so it anchors neither.
let nested = node(.collectionView, [node(.cell, [node(.cell, [node(.staticText, label: "Inner")])])])
let nestedCounts = RowAnchor.cellCounts(in: nested)
check("a nested cell's text is held by both", nestedCounts["Inner"], 2)

// ─── Scope.visit ───

// A row: its text, a "More Info" button, a chevron, a second "More Info"
// with an identifier, then a third without.
let scope = RowAnchor.Scope(anchor: "Row 1")
let staticText = XCUIElement.ElementType.staticText.rawValue
let button = XCUIElement.ElementType.button.rawValue
let other = XCUIElement.ElementType.other.rawValue
check("the text is the first of its kind", scope.visit(typeRaw: staticText, label: "Row 1", identifier: "", typed: true), 0)
check("the first button is index 0", scope.visit(typeRaw: button, label: "More Info", identifier: "", typed: true), 0)
check("another label does not count", scope.visit(typeRaw: button, label: "chevron", identifier: "", typed: true), 0)
check("an id'd one counts among its id only",
      scope.visit(typeRaw: button, label: "More Info", identifier: "info", typed: true), 0)
check("a no-id one counts every earlier same-label button",
      scope.visit(typeRaw: button, label: "More Info", identifier: "", typed: true), 2)
check("an untyped query counts every type with the label",
      scope.visit(typeRaw: other, label: "More Info", identifier: "", typed: false), 3)
let skipped = RowAnchor.Scope(anchor: "x")
skipped.visitSubtree(node(.other, [node(.button, label: "Go"), node(.button, label: "Go")]))
check("a skipped subtree still counts", skipped.visit(typeRaw: button, label: "Go", identifier: "", typed: true), 2)

check(".other is untyped", RowAnchor.isTyped(other), false)
check(".button is typed", RowAnchor.isTyped(button), true)

if failures > 0 {
    print("\(failures) RowAnchor test(s) failed")
    exit(1)
}
print("All RowAnchor tests passed")
