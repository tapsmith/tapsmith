// Unit tests for RowBinding (PILOT-952), run on the host Mac without a
// simulator: `ios-agent/Tests/run-unit-tests.sh`.

import CoreGraphics
import Foundation

var failures = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want \(want)")
    }
}

// ─── tags ───

typealias Tags = RowBinding.Tags
// A row with an anchor of its own is found as the row holding it.
check("an anchored row", RowBinding.tags(
    ownAnchor: "t\u{1}Row 1", ownListExposesEveryRow: true, enclosing: nil, index: nil,
    innermostAnchored: true, listExposesEveryRow: true
), Tags(anchor: "t\u{1}Row 1", index: nil, nested: false, anchorListExposesEveryRow: true, listExposesEveryRow: true))
// A button in an anchored row is found inside it, at its index.
check("content of an anchored row", RowBinding.tags(
    ownAnchor: nil, ownListExposesEveryRow: false, enclosing: ("t\u{1}Row 1", true, false), index: 2,
    innermostAnchored: true, listExposesEveryRow: true
), Tags(anchor: "t\u{1}Row 1", index: 2, nested: false, anchorListExposesEveryRow: true, listExposesEveryRow: true))
// A carousel cell's button in a table row: found inside the table row, by a
// place the carousel's reuse can change, and in a list that does not show
// every row.
check("content of an unanchored row nested in an anchored one", RowBinding.tags(
    ownAnchor: nil, ownListExposesEveryRow: false, enclosing: ("t\u{1}Featured", true, true), index: 4,
    innermostAnchored: false, listExposesEveryRow: false
), Tags(anchor: "t\u{1}Featured", index: 4, nested: true, anchorListExposesEveryRow: true, listExposesEveryRow: false))
// The carousel cell itself, matched as a row with no anchor of its own.
check("an unanchored row nested in an anchored one", RowBinding.tags(
    ownAnchor: nil, ownListExposesEveryRow: false, enclosing: ("t\u{1}Featured", true, true), index: 1,
    innermostAnchored: false, listExposesEveryRow: false
).nested, true)
// The row's own button after its carousel: counted past the carousel's
// loaded cells, so its place can change too.
check("content of an anchored row that holds rows", RowBinding.tags(
    ownAnchor: nil, ownListExposesEveryRow: false, enclosing: ("t\u{1}Featured", true, true), index: 3,
    innermostAnchored: true, listExposesEveryRow: true
).nested, true)
check("a row with no anchor anywhere", RowBinding.tags(
    ownAnchor: nil, ownListExposesEveryRow: true, enclosing: nil, index: nil,
    innermostAnchored: false, listExposesEveryRow: true
), Tags(anchor: nil, index: nil, nested: false, anchorListExposesEveryRow: false, listExposesEveryRow: true))

// ─── plan ───

typealias Plan = RowBinding.Plan
let tableRow = Tags(anchor: "t\u{1}Row 70", index: 0, anchorListExposesEveryRow: true, listExposesEveryRow: true)
let listRow = Tags(anchor: "t\u{1}Alice", index: 0, anchorListExposesEveryRow: false, listExposesEveryRow: false)
let nestedRow = Tags(anchor: "t\u{1}Featured", index: 4, nested: true,
                     anchorListExposesEveryRow: true, listExposesEveryRow: false)
let noAnchorTable = Tags(listExposesEveryRow: true)
let noAnchorList = Tags(listExposesEveryRow: false)
check("outside a row: as before", RowBinding.plan(bound: true, inRow: false, uniqueInQuery: false, tags: Tags()), Plan())
check("no live element on purpose stays none",
      RowBinding.plan(bound: false, inRow: true, uniqueInQuery: false, tags: tableRow), Plan())
check("a table row's repeated button goes through its row",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: false, tags: tableRow), Plan(throughAnchor: true))
check("a binding unique in a table stands",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: true, tags: tableRow), Plan())
check("a collection view's anchor is checked",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: true, tags: listRow),
      Plan(throughAnchor: true, checkAnchor: true))
check("nested in an unanchored row: anchored and frame-checked",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: true, tags: nestedRow),
      Plan(throughAnchor: true, checkFrame: true))
check("no anchor: frame-checked",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: false, tags: noAnchorTable), Plan(checkFrame: true))
check("no anchor, unique in a table: as before",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: true, tags: noAnchorTable), Plan())
check("no anchor, unique in a collection view: frame-checked",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: true, tags: noAnchorList), Plan(checkFrame: true))

// ─── isFoundElement ───

// Row 68's "More Info" button where it was found, and Row 67's, one row
// (44 pt) above it: the live query bound the wrong one.
let row68 = CGRect(x: 349, y: 815.33, width: 22, height: 22)
let row67 = CGRect(x: 349, y: 771.33, width: 22, height: 22)
check("the button where it was found", RowBinding.isFoundElement(found: row68, live: row68), true)
check("another row's button", RowBinding.isFoundElement(found: row68, live: row67), false)
check("no live element", RowBinding.isFoundElement(found: row68, live: nil), false)
// Frames are compared in whole points, as the SDK keys a target: a read
// that differs below a point is the same element.
check("sub-point difference", RowBinding.isFoundElement(
    found: row68, live: CGRect(x: 349.2, y: 815.4, width: 22, height: 22)
), true)
// The contents of an unloaded row report a placeholder frame live, while the
// match was placed at its row (CellFrames, PILOT-800): not the same.
check("an unloaded row's placeholder", RowBinding.isFoundElement(
    found: CGRect(x: 0, y: 3200, width: 402, height: 44), live: CGRect(x: 0, y: 0, width: 0, height: 0)
), false)
check("a found frame with no area is never matched", RowBinding.isFoundElement(
    found: .zero, live: .zero
), false)

if failures > 0 {
    print("\(failures) RowBinding test(s) failed")
    exit(1)
}
print("All RowBinding tests passed")
