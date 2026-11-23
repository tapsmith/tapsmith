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
// Outside any row, XCTest's live query still need not return nodes in the
// snapshot's order (it listed a React Navigation tab bar's buttons before the
// header's toggle, which comes first in the tree): a binding by place among
// others is checked, once, on its first use: that order does not change as
// the element moves, so a field that moves once typing focuses it keeps its
// live element. One its query alone returns stands.
check("outside a row, by place among others: frame-checked once",
      RowBinding.plan(bound: true, inRow: false, uniqueInQuery: false, tags: Tags(), treeHasLazyList: false),
      Plan(checkFrameOnce: true))
check("outside a row, unique in its query: as before",
      RowBinding.plan(bound: true, inRow: false, uniqueInQuery: true, tags: Tags(), treeHasLazyList: false), Plan())
check("outside a row, no live element on purpose stays none",
      RowBinding.plan(bound: false, inRow: false, uniqueInQuery: false, tags: Tags(), treeHasLazyList: false), Plan())
check("no live element on purpose stays none",
      RowBinding.plan(bound: false, inRow: true, uniqueInQuery: false, tags: tableRow, treeHasLazyList: false), Plan())
check("a table row's repeated button goes through its row",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: false, tags: tableRow, treeHasLazyList: false), Plan(throughAnchor: true))
check("a binding unique in a table stands",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: true, tags: tableRow, treeHasLazyList: false), Plan())
check("a collection view's anchor is checked",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: true, tags: listRow, treeHasLazyList: false),
      Plan(throughAnchor: true, checkAnchor: true))
// A collection view elsewhere in the tree could load a cell with the same
// anchor: a table's anchor is checked too.
check("a table row's anchor beside a collection view is checked",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: false, tags: tableRow, treeHasLazyList: true),
      Plan(throughAnchor: true, checkAnchor: true))
check("nested in an unanchored row: anchored and frame-checked",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: true, tags: nestedRow, treeHasLazyList: false),
      Plan(throughAnchor: true, checkFrame: true))
check("no anchor: frame-checked",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: false, tags: noAnchorTable, treeHasLazyList: false), Plan(checkFrame: true))
check("no anchor, unique in a table: as before",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: true, tags: noAnchorTable, treeHasLazyList: false), Plan())
check("no anchor, unique in a collection view: frame-checked",
      RowBinding.plan(bound: true, inRow: true, uniqueInQuery: true, tags: noAnchorList, treeHasLazyList: false), Plan(checkFrame: true))

// ─── firstUse (a binding by place among others, outside any row) ───

typealias FirstUse = RowBinding.FirstUse
let toggle = CGRect(x: 5, y: 61.33, width: 50, height: 40)
let firstTab = CGRect(x: 0, y: 873.33, width: 146.67, height: 48.67)
let elsewhere = CGRect(x: 300, y: 61.33, width: 50, height: 40)
var lookalikesRead = 0
func lookalikes(_ frames: [CGRect?], complete: Bool = true) -> () -> (frames: [CGRect?], complete: Bool) {
    { lookalikesRead += 1; return (frames, complete) }
}
lookalikesRead = 0
check("bound where it was found: kept", RowBinding.firstUse(
    found: toggle, live: toggle, liveIsFoundIdentity: true, lookalikes: lookalikes([])
), FirstUse.keep)
check("bound where it was found: nothing else read", lookalikesRead, 0)
// The live query listed the tab bar's buttons first: index 0 is a tab. The
// toggle is the one element with its type, label and identifier at the frame
// it was found at.
check("bound to another element: re-bound to the one at the found frame", RowBinding.firstUse(
    found: toggle, live: firstTab, liveIsFoundIdentity: false, lookalikes: lookalikes([elsewhere, toggle])
), FirstUse.rebind(1))
// Two unnamed buttons, listed out of order: same identity, other frame.
check("bound to a lookalike: re-bound", RowBinding.firstUse(
    found: toggle, live: firstTab, liveIsFoundIdentity: true, lookalikes: lookalikes([firstTab, toggle])
), FirstUse.rebind(1))
// The element moved since it was found (a panel still sliding in, a field the
// keyboard pushed up): nothing is at the found frame, and the live element is
// the only element with the identity found. Followed, as before.
check("moved since found, no lookalike: kept", RowBinding.firstUse(
    found: toggle, live: firstTab, liveIsFoundIdentity: true, lookalikes: lookalikes([firstTab])
), FirstUse.keep)
// With lookalikes, one that moved cannot be told from another listed at its
// place: not kept, so the touch goes to the found frame.
check("moved since found, with lookalikes: dropped", RowBinding.firstUse(
    found: toggle, live: firstTab, liveIsFoundIdentity: true, lookalikes: lookalikes([firstTab, elsewhere])
), FirstUse.drop)
// Lookalikes past the ones read could hold the element found.
check("moved since found, lookalikes not all read: dropped", RowBinding.firstUse(
    found: toggle, live: firstTab, liveIsFoundIdentity: true, lookalikes: lookalikes([firstTab], complete: false)
), FirstUse.drop)
check("another element, nothing at the found frame: dropped", RowBinding.firstUse(
    found: toggle, live: firstTab, liveIsFoundIdentity: false, lookalikes: lookalikes([elsewhere])
), FirstUse.drop)
check("unreadable live element: dropped", RowBinding.firstUse(
    found: toggle, live: nil, liveIsFoundIdentity: false, lookalikes: lookalikes([])
), FirstUse.drop)
// Two lookalikes at the found frame: the element found is one of them, so it
// has not moved and the live element elsewhere is not it; nor can the two be
// told apart.
check("two at the found frame, another element: dropped", RowBinding.firstUse(
    found: toggle, live: firstTab, liveIsFoundIdentity: false, lookalikes: lookalikes([toggle, toggle])
), FirstUse.drop)
check("two at the found frame, a lookalike elsewhere: dropped", RowBinding.firstUse(
    found: toggle, live: firstTab, liveIsFoundIdentity: true, lookalikes: lookalikes([toggle, toggle, firstTab])
), FirstUse.drop)

// ─── checksFrameAfterFirstUse ───

check("the only element with its identity: followed", RowBinding.checksFrameAfterFirstUse(.keep, lookalikes: 1), false)
check("kept among lookalikes: frame-checked", RowBinding.checksFrameAfterFirstUse(.keep, lookalikes: 3), true)
check("lookalikes not known: frame-checked", RowBinding.checksFrameAfterFirstUse(.keep, lookalikes: nil), true)
check("re-bound to the only one: followed", RowBinding.checksFrameAfterFirstUse(.rebind(0), lookalikes: 1), false)
check("re-bound among lookalikes: frame-checked", RowBinding.checksFrameAfterFirstUse(.rebind(1), lookalikes: 2), true)
check("dropped: no live element to check", RowBinding.checksFrameAfterFirstUse(.drop, lookalikes: 2), false)

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
