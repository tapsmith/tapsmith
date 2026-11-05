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

if failures > 0 {
    print("\(failures) RotationSettle test(s) failed")
    exit(1)
}
print("RotationSettle tests passed")
