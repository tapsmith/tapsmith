// Unit tests for SnapshotRetry (PILOT-978): how many times takeSnapshot()
// tries a failed or empty snapshot, and that no try starts once it could not
// finish before the daemon stops waiting for the command.

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

let now = Date(timeIntervalSinceReferenceDate: 1_000)

// Without a deadline (an older daemon): up to five tries.
do {
    let retry = SnapshotRetry(deadline: nil, attemptCost: 2.5)
    expect("retries after the first failure", retry.shouldRetry(failedAttempts: 1, now: now))
    expect("retries after the fourth failure", retry.shouldRetry(failedAttempts: 4, now: now))
    expect("stops after five tries", !retry.shouldRetry(failedAttempts: 5, now: now))
}

// With a deadline far off: the deadline does not shorten the tries.
do {
    let retry = SnapshotRetry(deadline: now.addingTimeInterval(60), attemptCost: 2.5)
    expect("a far deadline still allows a retry", retry.shouldRetry(failedAttempts: 1, now: now))
    expect("a far deadline does not add tries", !retry.shouldRetry(failedAttempts: 5, now: now))
}

// No try starts that could not finish before the deadline.
do {
    let retry = SnapshotRetry(deadline: now.addingTimeInterval(10), attemptCost: 2.5)
    expect("retries while pause + one try fit before the deadline",
           retry.shouldRetry(failedAttempts: 1, now: now.addingTimeInterval(7.3)))
    expect("stops once pause + one try would end after the deadline",
           !retry.shouldRetry(failedAttempts: 1, now: now.addingTimeInterval(7.31)))
    expect("stops at the deadline", !retry.shouldRetry(failedAttempts: 1, now: now.addingTimeInterval(10)))
    expect("stops past the deadline (a try that itself overran it)",
           !retry.shouldRetry(failedAttempts: 1, now: now.addingTimeInterval(90)))
}

// A deadline already too close for a retry: only the first try runs.
do {
    let retry = SnapshotRetry(deadline: now.addingTimeInterval(1), attemptCost: 2.5)
    expect("a deadline too close for a second try stops after the first",
           !retry.shouldRetry(failedAttempts: 1, now: now))
}

if failures > 0 {
    print("\(failures) SnapshotRetry test(s) failed")
    exit(1)
}
print("All SnapshotRetry tests passed")
