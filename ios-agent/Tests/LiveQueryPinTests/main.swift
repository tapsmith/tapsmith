// Unit tests for LiveQueryPin (PILOT-1065), run on the host Mac without a
// simulator: `ios-agent/Tests/run-unit-tests.sh`.

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

// A query by the element's own label returns only elements with that label.
let byLabel = LiveQueryPin(label: "Covered action", identifier: nil)
check("a read with the pinned label is admitted",
      byLabel.admits(label: "Covered action", identifier: ""), true)
// React reused the view and relabelled it while XCTest read it: the query
// matched it as "Covered action", its attributes came back as the
// replacement's. That read is not the element found.
check("a read whose label contradicts its own query is refused",
      byLabel.admits(label: "Replacement action", identifier: ""), false)
check("a label pin says nothing about the identifier",
      byLabel.admits(label: "Covered action", identifier: "anything"), true)

// A query by label and identifier needs both.
let byLabelAndId = LiveQueryPin(label: "Save", identifier: "save-button")
check("both pinned, both match", byLabelAndId.admits(label: "Save", identifier: "save-button"), true)
check("both pinned, identifier differs", byLabelAndId.admits(label: "Save", identifier: "other"), false)
check("both pinned, label differs", byLabelAndId.admits(label: "Saved", identifier: "save-button"), false)

// A query by identifier (getByTestId) still returns the element after its
// label changes: a button whose label counts down is the same button.
let byId = LiveQueryPin(label: nil, identifier: "countdown")
check("an identifier pin ignores a changed label",
      byId.admits(label: "2 s left", identifier: "countdown"), true)
check("an identifier pin refuses another identifier",
      byId.admits(label: "2 s left", identifier: "other"), false)

// A query keyed on neither (by type, or by place) pins nothing.
let none = LiveQueryPin.none
check("an empty pin admits any read", none.admits(label: "x", identifier: "y"), true)
check("an empty pin is the default", LiveQueryPin(), none)

if failures > 0 {
    print("\(failures) LiveQueryPin test(s) failed")
    exit(1)
}
print("All LiveQueryPin tests passed")
