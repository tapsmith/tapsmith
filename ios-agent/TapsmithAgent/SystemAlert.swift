import Foundation

/// A SpringBoard alert on screen: its title and its buttons' labels, read
/// from one snapshot (CommandHandler.readSpringBoardAlert).
///
/// Locators only see the app under test, so an alert SpringBoard draws over
/// it (an "Open in “App”?" prompt a dev tool left behind, a permission
/// prompt) hides every element underneath without appearing in the app's
/// hierarchy. The agent names it in the errors such an alert causes, and
/// cancels a leftover "Open in" prompt before it launches the app.
struct SystemAlert: Equatable {
    let title: String
    let buttons: [String]

    /// SpringBoard's confirmation for a custom URL scheme, "Open in “App”?",
    /// with its Cancel and Open buttons. `xcrun simctl openurl` (which
    /// `npx expo run:ios` ends with) raises it, and it stays up across app
    /// relaunches until someone answers it. English only, like the
    /// daemon's own deep-link handling of the same prompt.
    var isOpenInPrompt: Bool {
        title.hasPrefix("Open in ") && buttons.contains("Cancel") && buttons.contains("Open")
    }

    /// `"Title" (buttons: A, B)`, for error messages and logs.
    var description: String {
        let name = title.isEmpty ? "an untitled alert" : "\"\(title)\""
        let list = buttons.isEmpty ? "no buttons" : "buttons: \(buttons.joined(separator: ", "))"
        return "\(name) (\(list))"
    }

    /// The sentence an error appends when this alert is up.
    var coveringSentence: String {
        "A system alert is covering the app: \(description). " +
            "Locators only see the app under test, so nothing behind the alert can be found, " +
            "tapped or typed into until it is closed: close it on the device, or tap one of its " +
            "buttons with device.tapXY()."
    }
}

/// The alerts the agent answered on its own, oldest first, until the daemon
/// takes them (`takeSystemDialogEvents`). Each is the daemon's
/// SystemDialogEvent shape, as the Android agent reports its own. Bounded,
/// so a daemon that never asks (an older one) cannot grow it without limit.
struct SystemAlertEvents {
    let capacity: Int
    private var events: [[String: Any]] = []

    init(capacity: Int = 20) {
        self.capacity = capacity
    }

    /// Record a cancelled "Open in" prompt.
    mutating func record(title: String, button: String, timestampMs: Int64) {
        events.append([
            "title": title,
            "owner": "com.apple.springboard",
            "ownedByTarget": false,
            "kind": "open-in-prompt",
            "button": button,
            "timestampMs": timestampMs,
        ])
        if events.count > capacity {
            events.removeFirst(events.count - capacity)
        }
    }

    /// Every record so far, oldest first; empties the queue.
    mutating func take() -> [[String: Any]] {
        defer { events.removeAll() }
        return events
    }
}

/// When a readiness check (`waitForAppReady`) looks for a leftover "Open in"
/// prompt. Not on every call: warm resets wait for readiness every test, and
/// the SpringBoard query costs tens of milliseconds. Not once per agent
/// process either: a session can adopt an app that is already running long
/// after the agent started. So at most once per `interval`, which any other
/// check (a launch, a link delivery: `checked(at:)`) also restarts. A prompt
/// a readiness check skips stays up and is named in errors; the checks
/// before Tapsmith delivers a link, which would press its Open, are never
/// skipped.
struct LeftoverPromptCheck {
    let interval: TimeInterval
    private var last: Date?

    init(interval: TimeInterval = 15) {
        self.interval = interval
    }

    /// Whether to look now; when it says yes, the interval restarts.
    mutating func due(now: Date) -> Bool {
        if let last, now.timeIntervalSince(last) < interval { return false }
        last = now
        return true
    }

    /// A check made elsewhere (a launch) at `now`.
    mutating func checked(at now: Date) {
        last = now
    }
}
