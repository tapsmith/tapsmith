// Unit tests for CommandMeta: which params of a command are a selector's and
// which are the daemon's own.

import Foundation

var failures = 0

func expect(_ name: String, _ ok: Bool) {
    if ok {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name)")
    }
}

// A trace capture of an action with no target (a swipe, a key press) carries
// only the daemon's keys. Taken for a selector, they made the agent look up
// an element with an empty selector, which matches the app itself: the trace
// showed a full-screen "element found" on an action with no element.
expect("a capture's own flags are not a selector",
       !CommandMeta.hasSelectorKeys(["screenshot": true, "hierarchy": false]))
expect("nor is the read timeout the daemon stamps on every command",
       !CommandMeta.hasSelectorKeys(["screenshot": true, "readTimeoutMs": 35_000]))
expect("nor is the host touch offer it stamps on a simulator",
       !CommandMeta.hasSelectorKeys(["screenshot": true, "hierarchy": true, "readTimeoutMs": 35_000, "hostTouch": true]))
expect("the offer's param is the one the daemon sends", HostTouch.offerParam == "hostTouch")
expect("no params at all is no selector", !CommandMeta.hasSelectorKeys([:]))

expect("a selector field beside them is a selector",
       CommandMeta.hasSelectorKeys(["screenshot": true, "readTimeoutMs": 35_000, "hostTouch": true, "testId": "email"]))
expect("an element id is a selector", CommandMeta.hasSelectorKeys(["hostTouch": true, "elementId": "e12"]))

if failures > 0 {
    print("\(failures) CommandMeta test(s) failed")
    exit(1)
}
print("All CommandMeta tests passed")
