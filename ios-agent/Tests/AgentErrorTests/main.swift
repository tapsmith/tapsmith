// Unit tests for AgentError (PILOT-1252): its `localizedDescription` is the
// message it carries, not Foundation's generic "The operation couldn't be
// completed. (TapsmithAgent.AgentError error 3.)", so code that reports an
// `Error` it caught (a read that failed inside a command) keeps the cause.

import Foundation

var failures = 0

func check(_ name: String, _ got: String, _ want: String) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want \(want)")
    }
}

let cases: [AgentError] = [
    .elementNotFound("no such element"),
    .timeout("timed out reading the screen"),
    .invalidSelector("bad selector"),
    .actionFailed("tap failed"),
    .elementCovered("covered by alert \"Info\""),
    .parseError("bad JSON"),
    .invalidRequest("missing key"),
    .internalError("snapshot failed"),
]
for error in cases {
    check("\(error.type) localizedDescription", error.localizedDescription, error.message)
    // As a plain Error, as a `catch` sees one.
    let erased: Error = error
    check("\(error.type) as Error", erased.localizedDescription, error.message)
    check("\(error.type) as NSError", (erased as NSError).localizedDescription, error.message)
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all AgentError tests passed")
