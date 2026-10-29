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

let offScreenCell = R(0, 901, 402, 53)
check("a node that misses its cell is a placeholder: it takes the cell's frame",
      CellFrames.effectiveFrame(of: R(0, 168, 55, 20), inCell: offScreenCell), offScreenCell)
check("a node inside its cell keeps its frame",
      CellFrames.effectiveFrame(of: R(20, 228, 44, 20), inCell: R(0, 212, 402, 53)), R(20, 228, 44, 20))
check("a node outside any cell keeps its frame",
      CellFrames.effectiveFrame(of: R(0, 168, 55, 20), inCell: nil), R(0, 168, 55, 20))
check("content overflowing its cell a little still belongs to it",
      CellFrames.effectiveFrame(of: R(20, 200, 44, 20), inCell: R(0, 212, 402, 53)), R(20, 200, 44, 20))
check("a separator on the cell's bottom edge belongs to it",
      CellFrames.effectiveFrame(of: R(20, 265, 362, 1), inCell: R(0, 212, 402, 53)), R(20, 265, 362, 1))
check("a zero-size node is left alone (it is invisible anyway)",
      CellFrames.effectiveFrame(of: R(0, 168, 0, 0), inCell: offScreenCell), R(0, 168, 0, 0))
check("a zero-size cell vouches for nothing",
      CellFrames.effectiveFrame(of: R(0, 168, 55, 20), inCell: R(0, 901, 0, 0)), R(0, 168, 55, 20))
check("a row above the screen (scrolled past) is placed above it",
      CellFrames.effectiveFrame(of: R(0, 168, 55, 20), inCell: R(0, -400, 402, 53)), R(0, -400, 402, 53))

// MARK: - Rewriting a snapshot dictionary

func table() -> [String: Any] {
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

var dict = table()
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
var nested = node(.cell, R(0, 901, 402, 200), [
    node(.cell, R(0, 168, 402, 53), [node(.staticText, R(0, 168, 55, 20), label: "Inner")]),
])
CellFrames.placeDetachedNodes(in: &nested)
check("a placeholder cell inside a cell moves to the outer cell", frame(children(nested)[0]), R(0, 901, 402, 200))
check("…and so does its content", frame(children(children(nested)[0])[0]), R(0, 901, 402, 200))

var plain = node(.other, R(0, 0, 402, 874), [node(.staticText, R(0, 168, 55, 20), label: "Hello")])
CellFrames.placeDetachedNodes(in: &plain)
check("a tree without cells is unchanged", frame(children(plain)[0]), R(0, 168, 55, 20))

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all CellFrames tests passed")
