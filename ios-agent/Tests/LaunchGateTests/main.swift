// Unit tests for LaunchGate: how the runner waits for the daemon to finish
// terminating and wiping the app before it launches it, and how it tells the
// daemon it waited (by deleting the gate file).

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

/// A fake clock and file system: the gate file appears at `opensAt` seconds.
final class Fake {
    var now = Date(timeIntervalSince1970: 0)
    var opensAt: TimeInterval?
    var exists = false
    var removed = 0
    var removeSucceeds = true

    func fileExists(_ path: String) -> Bool {
        if let opensAt, now.timeIntervalSince1970 >= opensAt, removed == 0 { exists = true }
        return exists
    }
    func remove(_ path: String) -> Bool {
        removed += 1
        if removeSucceeds { exists = false }
        return removeSucceeds
    }
    func sleep(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }

    func wait(timeout: TimeInterval = 30) -> LaunchGate.Outcome {
        LaunchGate.wait(
            path: "/tmp/gate", timeout: timeout,
            fileExists: fileExists, remove: remove, now: { self.now }, sleep: sleep)
    }
}

do {
    let fake = Fake()
    fake.opensAt = 0
    expect("an open gate is passed at once", fake.wait() == .opened(waitedMs: 0))
    expect("and consumed: the file is deleted", fake.removed == 1 && !fake.exists)
}

do {
    let fake = Fake()
    fake.opensAt = 1.5
    let outcome = fake.wait()
    if case .opened(let ms) = outcome {
        expect("waits until the daemon opens the gate", ms >= 1500 && ms < 1600)
    } else {
        expect("waits until the daemon opens the gate", false)
    }
    expect("then consumes it", fake.removed == 1)
}

do {
    let fake = Fake()
    let outcome = fake.wait(timeout: 2)
    expect("a gate that never opens times out", outcome == .timedOut)
    expect("after the bound, not before", fake.now.timeIntervalSince1970 >= 2 && fake.now.timeIntervalSince1970 < 2.1)
    expect("and nothing is deleted (the daemon then knows the launch was not vouched for)", fake.removed == 0)
}

do {
    let fake = Fake()
    fake.opensAt = 0
    fake.removeSucceeds = false
    expect("a gate that cannot be deleted is still passed (the daemon falls back)",
           fake.wait() == .unacknowledged)
}

expect("the daemon's wipe deadline stays below the runner's wait",
       LaunchGate.defaultTimeout > 20)

if failures > 0 {
    print("\(failures) LaunchGate test(s) failed")
    exit(1)
}
print("All LaunchGate tests passed")
