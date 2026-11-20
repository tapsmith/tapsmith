// Unit tests for SystemAlert: which SpringBoard alert is a leftover
// "Open in “App”?" prompt, how an alert is described in error messages, and
// the bounded queue of alerts the agent answered for the daemon to collect.

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

let openIn = SystemAlert(title: "Open in “priya-app”?", buttons: ["Cancel", "Open"])

expect("an Open-in prompt with Cancel and Open is recognised", openIn.isOpenInPrompt)
expect(
    "with straight quotes too",
    SystemAlert(title: "Open in \"My App\"?", buttons: ["Cancel", "Open"]).isOpenInPrompt
)
expect(
    "not without a Cancel button (nothing safe to press)",
    !SystemAlert(title: "Open in “priya-app”?", buttons: ["Open"]).isOpenInPrompt
)
expect(
    "not without an Open button (some other alert)",
    !SystemAlert(title: "Open in “priya-app”?", buttons: ["Cancel", "OK"]).isOpenInPrompt
)
expect(
    "not a permission prompt",
    !SystemAlert(
        title: "“Example” Would Like to Send You Notifications",
        buttons: ["Don’t Allow", "Allow"]
    ).isOpenInPrompt
)
expect(
    "not an alert whose title only mentions opening",
    !SystemAlert(title: "Could not open in Safari", buttons: ["Cancel", "Open"]).isOpenInPrompt
)

expect(
    "an alert is described by its title and buttons",
    openIn.description == "\"Open in “priya-app”?\" (buttons: Cancel, Open)"
)
expect(
    "an untitled alert says so",
    SystemAlert(title: "", buttons: ["OK"]).description == "an untitled alert (buttons: OK)"
)
expect(
    "an alert without buttons says so",
    SystemAlert(title: "Updating", buttons: []).description == "\"Updating\" (no buttons)"
)
expect(
    "the covering sentence names the alert and why locators miss",
    openIn.coveringSentence == "A system alert is covering the app: \"Open in “priya-app”?\" " +
        "(buttons: Cancel, Open). Locators only see the app under test, so nothing behind the alert " +
        "can be found, tapped or typed into until it is closed: close it on the device, or tap one " +
        "of its buttons with device.tapXY()."
)

do {
    var queue = SystemAlertEvents(capacity: 3)
    expect("an empty queue takes nothing", queue.take().isEmpty)
    queue.record(title: "Open in “a”?", button: "Cancel", timestampMs: 1)
    queue.record(title: "Open in “b”?", button: "Cancel", timestampMs: 2)
    let taken = queue.take()
    expect("records come back oldest first", taken.map { $0["title"] as? String } == ["Open in “a”?", "Open in “b”?"])
    expect("as the daemon's event shape", taken.first?["owner"] as? String == "com.apple.springboard"
        && taken.first?["kind"] as? String == "open-in-prompt"
        && taken.first?["button"] as? String == "Cancel"
        && taken.first?["ownedByTarget"] as? Bool == false
        && taken.first?["timestampMs"] as? Int64 == 1)
    expect("taking empties the queue", queue.take().isEmpty)
    for i in 0..<5 { queue.record(title: "t\(i)", button: "Cancel", timestampMs: Int64(i)) }
    expect("the queue keeps only the newest `capacity` records",
           queue.take().map { $0["title"] as? String } == ["t2", "t3", "t4"])
}

do {
    var check = LeftoverPromptCheck(interval: 15)
    let t0 = Date(timeIntervalSince1970: 1_000)
    expect("the first readiness check of a process looks", check.due(now: t0))
    expect("one soon after does not (warm resets wait for readiness every test)",
           !check.due(now: t0.addingTimeInterval(5)))
    expect("one after the interval looks again (a long-lived session's next run)",
           check.due(now: t0.addingTimeInterval(16)))
    expect("and restarts the interval", !check.due(now: t0.addingTimeInterval(20)))
    check.checked(at: t0.addingTimeInterval(40))
    expect("a launch's own check restarts it too", !check.due(now: t0.addingTimeInterval(50)))
    expect("until the interval has passed since it", check.due(now: t0.addingTimeInterval(56)))
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("SystemAlert: all passed")
