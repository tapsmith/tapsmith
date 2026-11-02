// Unit tests for XCTestIssueRelay (PILOT-978): what the agent does with an
// issue XCTest records inside its own calls, and that ObjCExceptionCatcher
// knows when it is catching on the current thread.

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

let issue = "Failed to get matching snapshot: No matches found for Descendants matching type Button"

// Disposition: raise inside a catcher, log once serving, record during startup.
do {
    expect("inside a catcher it raises, while serving",
           XCTestIssueRelay.disposition(catching: true, serving: true) == .raise)
    expect("inside a catcher it raises, during startup too",
           XCTestIssueRelay.disposition(catching: true, serving: false) == .raise)
    expect("outside a catcher while serving it is only logged (the agent must survive)",
           XCTestIssueRelay.disposition(catching: false, serving: true) == .logOnly)
    expect("outside a catcher during startup it is recorded (a failed launch still fails startup)",
           XCTestIssueRelay.disposition(catching: false, serving: false) == .record)
}

// The catcher's per-thread depth.
do {
    expect("not catching outside any catcher", !ObjCExceptionCatcher.isCatchingOnCurrentThread())
    var inside = false
    var nested = false
    var afterNested = false
    _ = ObjCExceptionCatcher.catchException {
        inside = ObjCExceptionCatcher.isCatchingOnCurrentThread()
        _ = ObjCExceptionCatcher.catchException {
            nested = ObjCExceptionCatcher.isCatchingOnCurrentThread()
        }
        afterNested = ObjCExceptionCatcher.isCatchingOnCurrentThread()
    }
    expect("catching inside a catcher", inside)
    expect("catching inside a nested catcher", nested)
    expect("still catching in the outer catcher after the nested one returns", afterNested)
    expect("not catching after the catcher returns", !ObjCExceptionCatcher.isCatchingOnCurrentThread())

    _ = ObjCExceptionCatcher.catchException {
        NSException(name: NSExceptionName("Boom"), reason: "boom", userInfo: nil).raise()
    }
    expect("not catching after a catcher that caught an exception",
           !ObjCExceptionCatcher.isCatchingOnCurrentThread())

    var otherThread = true
    let done = DispatchSemaphore(value: 0)
    _ = ObjCExceptionCatcher.catchException {
        Thread.detachNewThread {
            otherThread = ObjCExceptionCatcher.isCatchingOnCurrentThread()
            done.signal()
        }
        done.wait()
    }
    expect("a catcher on another thread does not count", !otherThread)
}

// handle(): an issue inside a catcher fails the call through the catcher,
// with the issue's own description, and the code after the failed call
// never runs.
do {
    var logged: [String] = []
    var reachedAfterIssue = false
    let error = ObjCExceptionCatcher.catchException {
        XCTestIssueRelay.handle(issue, serving: true, log: { logged.append($0) })
        reachedAfterIssue = true
    }
    expect("the catcher returns an error", error != nil)
    expect("the error carries the issue's description, not \"Interrupting test\"",
           error?.localizedDescription == issue)
    expect("the code after the failed XCTest call does not run", !reachedAfterIssue)
    expect("the issue is logged", logged.count == 1 && logged[0].contains(issue))
    expect("not catching after the raise unwound the catcher", !ObjCExceptionCatcher.isCatchingOnCurrentThread())
}

do {
    var logged: [String] = []
    let disposition = XCTestIssueRelay.handle(issue, serving: true, log: { logged.append($0) })
    expect("outside a catcher while serving: handled by logging", disposition == .logOnly)
    expect("... and logged", logged.count == 1 && logged[0].contains(issue))

    logged = []
    let startup = XCTestIssueRelay.handle(issue, serving: false, log: { logged.append($0) })
    expect("outside a catcher during startup: handed back to be recorded", startup == .record)
    expect("... and logged", logged.count == 1 && logged[0].contains(issue))
}

if failures > 0 {
    print("\(failures) XCTestIssueRelay test(s) failed")
    exit(1)
}
print("All XCTestIssueRelay tests passed")
