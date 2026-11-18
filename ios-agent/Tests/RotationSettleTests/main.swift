// Unit tests for RotationSettle: setOrientation waits for the app's window to
// turn before the agent re-reads (and caches) the screen size, driven with a
// fake clock and a scripted window.

import CoreGraphics
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

let portrait = CGSize(width: 402, height: 874)
let landscape = CGSize(width: 874, height: 402)
let t0 = Date(timeIntervalSince1970: 1_000_000)

final class Harness {
    var now = t0
    var reads = 0
    let sizes: [CGSize]

    init(_ sizes: [CGSize]) { self.sizes = sizes }

    func run(landscape: Bool, timeout: TimeInterval = 2) -> CGSize {
        RotationSettle.waitForWindow(
            landscape: landscape,
            deadline: t0.addingTimeInterval(timeout),
            now: { self.now },
            sleep: { self.now = self.now.addingTimeInterval($0) },
            readSize: { () -> CGSize in
                // Past the script, the window keeps its last size.
                let size = self.reads < self.sizes.count ? self.sizes[self.reads] : self.sizes.last!
                self.reads += 1
                return size
            }
        )
    }
}

// A window that has already turned answers at once.
do {
    let h = Harness([landscape])
    expect("already landscape: one read", h.run(landscape: true) == landscape && h.reads == 1)
}

// A slow runner: the window is still portrait for the first reads after the
// device turned. The wait must not hand back that stale portrait size, which
// the agent would cache and use to call every landscape element off-screen.
do {
    let h = Harness([portrait, portrait, portrait, landscape])
    let size = h.run(landscape: true)
    expect("slow turn: waits for the landscape window", size == landscape && h.reads == 4)
    expect("slow turn: within the deadline", h.now <= t0.addingTimeInterval(2))
}

// Back to portrait works the same way.
do {
    let h = Harness([landscape, portrait])
    expect("turn back to portrait", h.run(landscape: false) == portrait && h.reads == 2)
}

// An app that does not rotate (portrait-only): give up at the deadline and
// return what the window says, so the caller caches the truth.
do {
    let h = Harness([portrait])
    let size = h.run(landscape: true, timeout: 1)
    expect("app that never turns: returns its window", size == portrait)
    expect("app that never turns: stops at the deadline", h.now >= t0.addingTimeInterval(1) && h.now < t0.addingTimeInterval(1.2))
}

// An unreadable window (zero frame) is not taken as turned.
do {
    let h = Harness([.zero, landscape])
    expect("zero frame is not an answer", h.run(landscape: true) == landscape && h.reads == 2)
}

// ─── turnDevice: setting the device's orientation (PILOT-1072) ───

enum Turn: Equatable { case portrait, landscape }

/// A device whose orientation setter can fail (an XCTest automation issue
/// such as kAXErrorIPCTimeout, raised after the turn was sent or before),
/// read back afterwards.
final class FakeDevice {
    var orientation: Turn = .portrait
    var sets = 0
    var sleeps: [TimeInterval] = []
    /// Per set call: whether it turns the device, and the error it raises.
    var script: [(turns: Bool, error: String?)]
    /// Reads that fail (nil) before reads succeed.
    var failedReads = 0

    init(_ script: [(turns: Bool, error: String?)]) { self.script = script }

    func turn(to target: Turn) -> String? {
        RotationSettle.turnDevice(
            to: target,
            set: { t in
                let step = self.sets < self.script.count ? self.script[self.sets] : (turns: true, error: nil)
                self.sets += 1
                if step.turns { self.orientation = t }
                return step.error
            },
            read: { () -> Turn? in
                if self.failedReads > 0 { self.failedReads -= 1; return nil }
                return self.orientation
            },
            sleep: { self.sleeps.append($0) }
        )
    }
}

let axTimeout = "Failed to get list of active applications: Accessibility error kAXErrorIPCTimeout"

// The plain case: one set, the device turns, no error.
do {
    let d = FakeDevice([(turns: true, error: nil)])
    expect("turn: succeeds", d.turn(to: .landscape) == nil && d.orientation == .landscape)
    expect("turn: one set", d.sets == 1)
}

// CI, 8 Nov 2026: the setter raised kAXErrorIPCTimeout after the device had
// turned (the retry started in landscape). The turn happened, so the command
// succeeds rather than failing a test whose device did what it asked.
do {
    let d = FakeDevice([(turns: true, error: axTimeout)])
    expect("raised after turning: succeeds", d.turn(to: .landscape) == nil)
    expect("raised after turning: not set again", d.sets == 1)
}

// The setter raised before the turn reached the device: set it again, once.
do {
    let d = FakeDevice([(turns: false, error: axTimeout), (turns: true, error: nil)])
    expect("raised before turning: retried and succeeds", d.turn(to: .landscape) == nil && d.orientation == .landscape)
    expect("raised before turning: two sets", d.sets == 2)
}

// Both sets raise and the device never turns: the command fails with the
// error XCTest gave, rather than reporting a turn that did not happen.
do {
    let d = FakeDevice([(turns: false, error: axTimeout), (turns: false, error: axTimeout)])
    let error = d.turn(to: .landscape)
    expect("never turns, raised: fails with XCTest's error", error?.contains("kAXErrorIPCTimeout") == true)
    expect("never turns, raised: two sets only", d.sets == 2)
}

// No error but the device did not take the turn (a physical device's
// accelerometer reverting it): set again once, then report success as
// before — the device's own orientation is a valid state, not a failure.
do {
    let d = FakeDevice([(turns: false, error: nil), (turns: false, error: nil)])
    expect("never turns, no error: not a failure", d.turn(to: .landscape) == nil)
    expect("never turns, no error: two sets", d.sets == 2)
}

// The read-back fails too (the same loaded AX server): a set that raised is
// tried again; once a set goes through without error, that is taken.
do {
    let d = FakeDevice([(turns: true, error: axTimeout), (turns: true, error: nil)])
    d.failedReads = 1
    expect("unreadable after a raised set: set again, succeeds", d.turn(to: .landscape) == nil && d.sets == 2)
}

// Each set is given time to take before it is read back.
do {
    let d = FakeDevice([(turns: false, error: axTimeout), (turns: true, error: nil)])
    _ = d.turn(to: .landscape)
    expect("settles after each set", d.sleeps == [RotationSettle.turnSettleSeconds, RotationSettle.turnSettleSeconds])
}

if failures > 0 {
    print("\(failures) RotationSettle test(s) failed")
    exit(1)
}
print("RotationSettle tests passed")
