// Unit tests for CellFrames (PILOT-800), run on the host Mac without a
// simulator: `ios-agent/Tests/run-unit-tests.sh`. The trees are shaped like the
// snapshot of a plain UITableViewController recorded on an iPhone 17 Pro /
// iOS 26 simulator: a table at y 168, loaded rows with real frames, and rows
// with no loaded cell whose cell frame is real (below the screen) while every
// descendant sits at the placeholder [0,168].

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

func R(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect {
    CGRect(x: x, y: y, width: w, height: h)
}

func node(
    _ type: XCUIElement.ElementType,
    _ frame: CGRect,
    label: String = "",
    _ children: [[String: Any]] = []
) -> [String: Any] {
    var dict: [String: Any] = [
        "elementType": type.rawValue,
        "label": label,
        "frame": ["X": Double(frame.minX), "Y": Double(frame.minY), "Width": Double(frame.width), "Height": Double(frame.height)],
    ]
    if !children.isEmpty { dict["children"] = children }
    return dict
}

func frame(_ dict: [String: Any]) -> CGRect {
    let f = dict["frame"] as? [String: Any] ?? [:]
    return R(f["X"] as? Double ?? -1, f["Y"] as? Double ?? -1, f["Width"] as? Double ?? -1, f["Height"] as? Double ?? -1)
}

func children(_ dict: [String: Any]) -> [[String: Any]] {
    dict["children"] as? [[String: Any]] ?? []
}

// MARK: - The rule

let screen = R(0, 0, 402, 874)
let table = R(0, 168, 402, 672)
/// Inside the table, as the walk sees it.
let inTable = CellFrames.childContext(of: .table, frame: table, in: .init(viewport: screen))
func inCell(_ cell: CGRect) -> CellFrames.Context { CellFrames.childContext(of: .cell, frame: cell, in: inTable) }

let offScreenCell = R(0, 901, 402, 53)
check("a node that misses its off-screen cell is a placeholder: it takes the cell's frame",
      CellFrames.effectiveFrame(of: R(0, 168, 55, 20), in: inCell(offScreenCell)), offScreenCell)
check("a node inside its on-screen cell keeps its frame",
      CellFrames.effectiveFrame(of: R(20, 228, 44, 20), in: inCell(R(0, 212, 402, 53))), R(20, 228, 44, 20))
check("a node outside any cell keeps its frame",
      CellFrames.effectiveFrame(of: R(0, 168, 55, 20), in: inTable), R(0, 168, 55, 20))
check("content outside an on-screen cell is real, and keeps its frame (a carousel item past the edge)",
      CellFrames.effectiveFrame(of: R(800, 228, 150, 20), in: inCell(R(0, 212, 402, 120))), R(800, 228, 150, 20))
check("a zero-size node is left alone (it is invisible anyway)",
      CellFrames.effectiveFrame(of: R(0, 168, 0, 0), in: inCell(offScreenCell)), R(0, 168, 0, 0))
check("a zero-size cell vouches for nothing",
      CellFrames.effectiveFrame(of: R(0, 168, 55, 20), in: inCell(R(0, 901, 0, 0))), R(0, 168, 55, 20))
check("a row scrolled above the table is placed above it",
      CellFrames.effectiveFrame(of: R(0, 168, 55, 20), in: inCell(R(0, -400, 402, 53))), R(0, -400, 402, 53))
check("a row ending exactly at the table's top is off it: its placeholder at the top edge moves",
      CellFrames.effectiveFrame(of: R(0, 168, 55, 20), in: inCell(R(0, 115, 402, 53))), R(0, 115, 402, 53))
check("a row under the nav bar, above the table's area, is off it too",
      CellFrames.effectiveFrame(of: R(0, 168, 55, 20), in: inCell(R(0, 100, 402, 53))), R(0, 100, 402, 53))
check("a row the table's bottom edge cuts is on screen: its content stays",
      CellFrames.effectiveFrame(of: R(20, 828, 44, 20), in: inCell(R(0, 812, 402, 53))), R(20, 828, 44, 20))

// MARK: - Rewriting a snapshot dictionary

func tableApp() -> [String: Any] {
    node(.application, R(0, 0, 402, 874), [
        node(.table, R(0, 168, 402, 672), [
            node(.staticText, R(0, 168, 402, 44), label: "Nothing selected"),
            node(.cell, R(0, 212, 402, 53), [
                node(.other, R(0, 212, 402, 53)),
                node(.staticText, R(20, 228, 44, 20), label: "Row 1"),
            ]),
            node(.cell, R(0, 901, 402, 53), [
                node(.other, R(0, 168, 402, 53), [node(.other, R(0, 168, 402, 53))]),
                node(.button, R(0, 168, 10, 14), label: "chevron"),
                node(.staticText, R(0, 168, 55, 20), label: "Row 14"),
            ]),
        ]),
    ])
}

var dict = tableApp()
CellFrames.placeDetachedNodes(in: &dict)
let tableNode = children(dict)[0]
check("the table keeps its frame", frame(tableNode), R(0, 168, 402, 672))
check("a header outside any cell keeps its frame", frame(children(tableNode)[0]), R(0, 168, 402, 44))
let loaded = children(tableNode)[1]
check("a loaded cell keeps its frame", frame(loaded), R(0, 212, 402, 53))
check("a loaded row's text keeps its frame", frame(children(loaded)[1]), R(20, 228, 44, 20))
let unloaded = children(tableNode)[2]
check("an unloaded cell keeps its (real) frame", frame(unloaded), offScreenCell)
check("its text moves to the cell", frame(children(unloaded)[2]), offScreenCell)
check("its chevron moves to the cell", frame(children(unloaded)[1]), offScreenCell)
check("nested placeholders move too", frame(children(children(unloaded)[0])[0]), offScreenCell)
check("labels and types are untouched", children(unloaded)[2]["label"] as? String, "Row 14")

// A cell nested in an unloaded cell is measured against its parent's place.
func app(_ children: [[String: Any]]) -> [String: Any] {
    node(.application, screen, [node(.table, table, children)])
}
var nested = app([
    node(.cell, R(0, 901, 402, 200), [
        node(.cell, R(0, 168, 402, 53), [node(.staticText, R(0, 168, 55, 20), label: "Inner")]),
    ]),
])
CellFrames.placeDetachedNodes(in: &nested)
let outer = children(children(nested)[0])[0]
check("a placeholder cell inside an unloaded cell moves to the outer cell", frame(children(outer)[0]), R(0, 901, 402, 200))
check("…and so does its content", frame(children(children(outer)[0])[0]), R(0, 901, 402, 200))

// A loaded row holding a horizontal carousel scrolled past the screen edge.
var carousel = app([
    node(.cell, R(0, 212, 402, 120), [
        node(.collectionView, R(0, 212, 402, 120), [
            node(.cell, R(16, 222, 150, 100), [node(.staticText, R(20, 262, 80, 20), label: "Item 1")]),
            node(.cell, R(800, 222, 150, 100), [node(.staticText, R(804, 262, 80, 20), label: "Item 8")]),
        ]),
    ]),
])
CellFrames.placeDetachedNodes(in: &carousel)
let shelf = children(children(children(children(carousel)[0])[0])[0])
check("an off-screen carousel cell in an on-screen row keeps its frame", frame(shelf[1]), R(800, 222, 150, 100))
check("…and so does its text", frame(children(shelf[1])[0]), R(804, 262, 80, 20))
check("an on-screen carousel item keeps its frame", frame(children(shelf[0])[0]), R(20, 262, 80, 20))

var plain = node(.other, R(0, 0, 402, 874), [node(.staticText, R(0, 168, 55, 20), label: "Hello")])
CellFrames.placeDetachedNodes(in: &plain)
check("a tree without cells is unchanged", frame(children(plain)[0]), R(0, 168, 55, 20))

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all CellFrames tests passed")
