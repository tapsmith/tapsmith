import Foundation

/// A SpringBoard alert on screen: its title and its buttons' labels, read
/// from one snapshot (CommandHandler.readSpringBoardAlert).
///
/// Locators only see the app under test, so an alert SpringBoard draws over
/// it (an "Open in “App”?" prompt a dev tool left behind, a permission
/// prompt) hides every element underneath without appearing in the app's
/// hierarchy. The agent names it in the errors such an alert causes, cancels
/// a leftover "Open in" prompt before it launches the app, and answers any
/// alert still up at a test boundary (`leftoverAnswer`).
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

    /// The button that answers this alert when it is a leftover: one still up
    /// when a test has ended, or when an app reset begins, so nothing the
    /// next test does can have raised it. An "Open in" prompt is cancelled
    /// (see `cancelLeftoverOpenInPrompt`); anything else is answered per
    /// SystemDialogPolicy: the first allow-style label it has, in the
    /// policy's order, else the first dismissive one. Labels match whole, so
    /// a denial ("Don’t Allow") is never pressed: iOS asks for a permission
    /// once per bundle id, and a denial stays until the app is reinstalled.
    /// Nil when no button is safe to press; the alert then stays up and is
    /// named in the errors it causes.
    var leftoverAnswer: String? {
        if isOpenInPrompt { return "Cancel" }
        for label in SystemDialogPolicy.allowButtonLabels + SystemDialogPolicy.dismissButtonLabels
        where buttons.contains(label) {
            return label
        }
        return nil
    }

    /// `"Title" (buttons: A, B)`, for error messages and logs.
    var description: String {
        let name = title.isEmpty ? "an untitled alert" : "\"\(title)\""
        let list = buttons.isEmpty ? "no buttons" : "buttons: \(buttons.joined(separator: ", "))"
        return "\(name) (\(list))"
    }

    /// Leftover "Open in" prompts one check cancels at most. Each unanswered
    /// `simctl openurl` (say `npx expo run:ios` run twice) queues another,
    /// shown as soon as the one before it closes; the bound keeps a prompt
    /// that will not close from holding the check.
    static let maxLeftoverPromptsPerCheck = 3

    /// Whether a warm deep-link delivery, by how it went (`deliverWarmURL`'s
    /// answer), can have raised an "Open in" prompt of Tapsmith's own.
    /// testmanagerd's open-URL request ("daemon") hands the URL to the app
    /// without one, so a prompt seen after it was left by something else
    /// and is cancelled, not opened. `XCUIApplication.open` ("xctest") can
    /// raise one, and so may anything that might have fallen back to it.
    static func deliveryMayRaiseOwnPrompt(_ delivery: String) -> Bool {
        delivery != "daemon"
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

    /// The kind of a leftover "Open in" prompt cancelled before a launch.
    static let openInPromptKind = "open-in-prompt"
    /// The kind of an alert answered at a test boundary
    /// (`SystemAlert.leftoverAnswer`).
    static let leftoverAlertKind = "leftover-alert"

    /// Record an alert the agent answered with `button`.
    mutating func record(title: String, button: String, kind: String = openInPromptKind, timestampMs: Int64) {
        events.append([
            "title": title,
            "owner": "com.apple.springboard",
            "ownedByTarget": false,
            "kind": kind,
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
/// check (a launch, a link delivery: `checked(at:)`) also restarts. Warm
/// link deliveries check on the same clock; in between, their wait loops
/// cancel any prompt the delivery cannot have raised
/// (`deliveryMayRaiseOwnPrompt`), so a leftover is not opened. A prompt a
/// readiness check skips stays up and is named in errors.
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
