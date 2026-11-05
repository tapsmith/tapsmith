import CoreGraphics
import Foundation

/// Waits for the app's window to turn after `setOrientation` (pure, so the
/// host tests can drive it with a fake clock).
///
/// The agent caches the screen size and uses it to decide what is on screen.
/// `setOrientation` re-reads it after turning the device, but on a loaded
/// simulator the app's window can still be portrait a few hundred
/// milliseconds after the turn. Caching that read left every element of the
/// rotated layout outside the cached screen, so nothing on it counted as
/// visible until the next turn.
enum RotationSettle {
    static let pollInterval: TimeInterval = 0.1

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
