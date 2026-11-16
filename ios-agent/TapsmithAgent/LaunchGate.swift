import Foundation

/// Before launching the app under test, waits for the daemon's "launch gate".
///
/// On a cold simulator start the daemon terminates the app and, when asked,
/// wipes its data while xcodebuild starts, then creates a host file whose path
/// it passes in `TAPSMITH_LAUNCH_GATE` (a simulator process reads host paths).
/// The runner waits for that file and deletes it before launching, so the
/// launch never races the wipe. Deleting it is the acknowledgement: the daemon
/// vouches for this launch as the session's clean one only when the file is
/// gone, so an older agent, a runner that gave up waiting, or one that could
/// not delete the file all leave the session to clear and relaunch as before.
///
/// Pure logic only — the file system and clock are passed in — so it is unit
/// tested on the host (Tests/LaunchGateTests).
enum LaunchGate {
    static let environmentKey = "TAPSMITH_LAUNCH_GATE"

    /// Longer than the daemon gives its terminate + wipe (20 s), so the gate
    /// opens before the runner gives up whenever the daemon is alive.
    static let defaultTimeout: TimeInterval = 30

    enum Outcome: Equatable {
        /// The gate opened and was acknowledged.
        case opened(waitedMs: Int)
        /// The gate opened but could not be deleted.
        case unacknowledged
        /// The gate never opened within the bound.
        case timedOut
    }

    static func wait(
        path: String,
        timeout: TimeInterval = defaultTimeout,
        pollInterval: TimeInterval = 0.01,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        remove: (String) -> Bool = { (try? FileManager.default.removeItem(atPath: $0)) != nil },
        now: () -> Date = Date.init,
        sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }
    ) -> Outcome {
        let started = now()
        while !fileExists(path) {
            if now().timeIntervalSince(started) >= timeout { return .timedOut }
            sleep(pollInterval)
        }
        guard remove(path) else { return .unacknowledged }
        return .opened(waitedMs: Int((now().timeIntervalSince(started) * 1000).rounded()))
    }
}
