// Unit tests for KeyboardSettle: how long the agent waits after the keyboard
// left, and how often its keyboard waits look.

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

/// A clock the wait drives: sampling takes `sampleCost`, and the screen shows
/// `frames[i]` at the i-th sample (the last one from then on).
final class FakeScreen {
    var time: TimeInterval = 0
    var samples = 0
    let frames: [Int?]
    let sampleCost: TimeInterval

    init(_ frames: [Int?], sampleCost: TimeInterval = 0.02) {
        self.frames = frames
        self.sampleCost = sampleCost
    }

    func wait(ceiling: TimeInterval = KeyboardSettle.maxWaitSeconds) -> KeyboardSettle.Outcome {
        let start = Date(timeIntervalSince1970: 0)
        return KeyboardSettle.waitUntilStill(
            deadline: start.addingTimeInterval(ceiling),
            now: { start.addingTimeInterval(self.time) },
            sleep: { self.time += $0 },
            sample: {
                let frame = self.frames[min(self.samples, self.frames.count - 1)]
                self.samples += 1
                self.time += self.sampleCost
                return frame
            }
        )
    }
}

// A screen that is already still costs the stillness window, not the old
// fixed 0.35 s.
let still = FakeScreen([1])
expect("a still screen is settled", still.wait() == .still)
expect("after the stillness window", still.time >= KeyboardSettle.stillSeconds && still.time < 0.2)

// The app's layout still moving as the keyboard goes (a KeyboardAvoidingView):
// the window starts again with every change.
let moving = FakeScreen([1, 2, 3, 4, 4])
expect("a moving screen is waited out", moving.wait() == .still)
expect("until it has held still for the whole window",
       moving.time >= 3 * 0.034 + KeyboardSettle.stillSeconds)

// A relayout that starts a moment after the keyboard is gone (a React Native
// screen laying out from its keyboardDidHide handler): two equal samples a
// frame or two apart are not enough.
let lateStart = FakeScreen([1, 1, 2, 3, 3, 3, 3, 3, 3])
expect("a change inside the window starts it again", lateStart.wait() == .still)
expect("and the wait outlasts the change", lateStart.samples >= 6)

// A screen that never holds still (a spinner): the ceiling, as before.
var spinner: [Int?] = []
for i in 0..<200 { spinner.append(i) }
let spinning = FakeScreen(spinner)
expect("a screen that never settles is waited for until the ceiling", spinning.wait() == .stillChanging)
expect("which is the old fixed wait", spinning.time >= 0.35 && spinning.time < 0.45)

// A screen that cannot be sampled: the old fixed wait.
let unreadable = FakeScreen([nil])
expect("an unreadable screen is waited out", unreadable.wait() == .unreadable)
expect("for the old fixed wait", unreadable.time >= 0.35 && unreadable.time < 0.45)
let wentDark = FakeScreen([1, nil])
expect("so is one that stops being readable", wentDark.wait() == .unreadable && wentDark.time >= 0.35)

// The deadline is the caller's.
let rushed = FakeScreen([1])
expect("a deadline already passed takes no sample", rushed.wait(ceiling: 0) == .stillChanging && rushed.samples == 0)
let short = FakeScreen([1])
expect("a deadline inside the window ends the wait there",
       short.wait(ceiling: 0.05) == .stillChanging && short.time < 0.1)

if failures > 0 {
    print("\(failures) KeyboardSettle test(s) failed")
    exit(1)
}
print("All KeyboardSettle tests passed")
