import CoreGraphics
import Foundation

/// Turns the device for `setOrientation` and waits for the app's window to
/// turn after it (pure, so the host tests can drive it with a fake clock).
///
/// The agent caches the screen size and uses it to decide what is on screen.
/// `setOrientation` re-reads it after turning the device, but on a loaded
/// simulator the app's window can still be portrait a few hundred
/// milliseconds after the turn. Caching that read left every element of the
/// rotated layout outside the cached screen, so nothing on it counted as
/// visible until the next turn.
enum RotationSettle {
    static let pollInterval: TimeInterval = 0.1
    /// How long a set orientation is given to take before it is read back.
    static let turnSettleSeconds: TimeInterval = 0.4
    /// How many times the orientation is set before the agent gives up.
    static let turnAttempts = 2

    /// Turns the device to `target`: sets it, waits, reads it back, and sets
    /// it once more if it has not taken. Returns nil when a read-back shows
    /// the device turned, or when the last set raised nothing (a physical
    /// device's accelerometer can turn it back, and the device's own
    /// orientation is a valid state); otherwise the error the last set gave.
    ///
    /// `set` returns the error XCTest raised, if any. On a loaded simulator
    /// the setter can raise an automation issue (`kAXErrorIPCTimeout` while
    /// XCTest lists the active applications) after the turn has gone through
    /// (PILOT-1072): the read-back decides, so such a turn is not reported as
    /// a failure. `read` returns nil when the orientation cannot be read.
    static func turnDevice<Orientation: Equatable>(
        to target: Orientation,
        set: (Orientation) -> String?,
        read: () -> Orientation?,
        sleep: (TimeInterval) -> Void = Thread.sleep(forTimeInterval:)
    ) -> String? {
        var lastError: String?
        for _ in 0..<turnAttempts {
            lastError = set(target)
            sleep(turnSettleSeconds)
            if read() == target { return nil }
        }
        return lastError
    }

    /// Reads the window until its shape matches `landscape` (wider than tall)
    /// or `deadline` passes, and returns the last size read. An app that does
    /// not rotate keeps its shape: the wait then ends at the deadline with the
    /// size the window really has.
    static func waitForWindow(
        landscape: Bool,
        deadline: Date,
        now: () -> Date = Date.init,
        sleep: (TimeInterval) -> Void = Thread.sleep(forTimeInterval:),
        readSize: () -> CGSize
    ) -> CGSize {
        while true {
            let size = readSize()
            if size.width > 0, size.height > 0, (size.width > size.height) == landscape {
                return size
            }
            let remaining = deadline.timeIntervalSince(now())
            if remaining <= 0 { return size }
            sleep(min(pollInterval, remaining))
        }
    }
}
