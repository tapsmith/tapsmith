import Foundation

/// "Has the app drawn real content yet?" — the poll loop behind the
/// `waitForAppReady` command (PILOT-1058; the Android agent's equivalent is
/// PILOT-976).
///
/// Right after a launch, a React Native app's accessibility tree is a bare
/// shell (application, window, a few empty containers) for as long as its JS
/// bundle takes to render. A warm deep link or a hooks-marker read sent into
/// that gap misfires: the warm path finds "no rendered content" and falls back
/// to a cold relaunch, and the marker is not there to read. The daemon and
/// the SDK wait on this before handing a freshly launched app back.
///
/// The caller supplies the check (a snapshot of the app read for
/// user-meaningful elements) and the clock, so the loop is plain Foundation
/// for the host-side unit tests.
enum AppReadiness {
    /// Pause between checks. A not-yet-rendered app's snapshot is small.
    static let pollInterval: TimeInterval = 0.1

    /// Whether one element of the app's tree shows the app has drawn real
    /// content: a text, input or control type (`isContentType`, decided by the
    /// caller from the XCTest element type), or any element other than the
    /// application node with a non-blank label or identifier. The second
    /// clause covers screens built only from labelled containers — React
    /// Native Pressables and testID'd Views come through as
    /// `XCUIElementTypeOther` — which would otherwise never read as ready.
    /// The bare shell after a launch (window and containers with neither)
    /// still does not count, nor does the application node, which carries the
    /// app's name from launch on. Matches the SDK's dump-based fallback.
    static func isRenderedContent(
        _ isContentType: Bool,
        _ isApplication: Bool,
        _ label: String,
        _ identifier: String
    ) -> Bool {
        if isContentType { return true }
        if isApplication { return false }
        return !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// What `wait` found: whether the app became ready, after how long and
    /// how many checks.
    struct Outcome {
        let ready: Bool
        let elapsedMs: Int
        let checks: Int
    }

    /// Run `check` until it is true or `timeoutMs` has passed, checking at
    /// least once and never sleeping past the bound. Running out of time is an
    /// answer, not an error: an app whose first screen has no text or controls
    /// never becomes "ready", and callers then go on.
    static func wait(
        timeoutMs: Int,
        now: () -> Date,
        sleep: (TimeInterval) -> Void,
        check: () -> Bool
    ) -> Outcome {
        let start = now()
        let budget = TimeInterval(max(timeoutMs, 0)) / 1000
        var checks = 0
        while true {
            checks += 1
            let ready = check()
            let elapsed = now().timeIntervalSince(start)
            let elapsedMs = Int((elapsed * 1000).rounded())
            if ready { return Outcome(ready: true, elapsedMs: elapsedMs, checks: checks) }
            if elapsed >= budget { return Outcome(ready: false, elapsedMs: elapsedMs, checks: checks) }
            sleep(min(pollInterval, budget - elapsed))
        }
    }
}
