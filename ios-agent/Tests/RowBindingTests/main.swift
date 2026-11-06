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

// ─── needsCheck ───

check("a row's repeated button is checked", RowBinding.needsCheck(inRow: true, uniqueInQuery: false), true)
check("a row's one-of-a-kind text is not", RowBinding.needsCheck(inRow: true, uniqueInQuery: true), false)
check("outside a row nothing is", RowBinding.needsCheck(inRow: false, uniqueInQuery: false), false)

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
