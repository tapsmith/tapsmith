import CoreGraphics
import Foundation

/// A tap the agent asks the daemon to press in the middle of a command
/// (PILOT-1132): the tap that focuses a field for `typeText`, `clearText` or
/// `focus`, and the tap that puts the keyboard away (a blank spot beside the
/// field, the keyboard's dismiss key). On a simulator the daemon's HID helper
/// presses it in a few milliseconds; the agent's own touch, an XCTest event
/// record, takes about 150 ms to come back. Element taps already go that way
/// (`resolveActionPoint`), but those are planned once and pressed by the
/// daemon. These are made part-way through a command, and only the agent
/// knows where and when: a focusing tap is checked and tried again further
/// in, and each way of dismissing the keyboard is planned on a fresh snapshot.
///
/// So the agent asks on the command's own connection, before its answer, one
/// line each way:
///
///     agent  → {"hostRequest":{"seq":1,"method":"tap","x":201.5,"y":310,"holdMs":0}}
///     daemon → {"hostReply":{"seq":1,"status":"delivered"}}
///
/// It asks only when the command carried `hostTouch: true`: a daemon that can
/// press on this device (an iOS simulator, on macOS) says so with every
/// command. An older daemon, or one driving a physical device, does not, and
/// the agent's own touch is used as before.
///
/// Kept free of XCUITest and of the socket so the host unit tests can drive
/// it (`ios-agent/Tests/run-unit-tests.sh`).
enum HostTouch {
    /// The param the daemon stamps on a command to offer its taps.
    static let offerParam = "hostTouch"

    enum Outcome: Equatable {
        /// Pressed and lifted.
        case delivered
        /// Nothing was touched (the helper is not available): the agent makes
        /// the tap itself.
        case notSent(String)
        /// The daemon took the request and the tap was not confirmed. It may
        /// have landed, so the agent does not tap again: what follows the tap
        /// (the focus check, the wait for the keyboard to leave) decides.
        case failed(String)
    }

    /// Where and how the daemon should press a tap the agent planned at
    /// `point` (the app's interface space), held `hold` as the agent's own
    /// tap would hold it: the point in the helper's native portrait space
    /// (`HidTouch.nativePoint`), and the hold as HID presses it
    /// (`HidTouch.hold`: a one-frame tap back to back). nil when the daemon
    /// did not offer, or the screen is turned in a way that cannot be mapped:
    /// the agent's own touch, which XCTest places.
    static func plan(
        offered: Bool,
        point: CGPoint,
        hold: TimeInterval,
        screen: CGSize,
        device: HidTouch.DeviceTurn
    ) -> (point: CGPoint, holdMs: Int)? {
        guard offered, let native = HidTouch.nativePoint(point, screen: screen, device: device) else { return nil }
        return (native, Int((HidTouch.hold(forTapHold: hold) * 1000).rounded()))
    }

    /// The line that asks for a tap (without its newline).
    static func requestLine(seq: Int, point: CGPoint, holdMs: Int) -> String {
        let request: [String: Any] = [
            "hostRequest": [
                "seq": seq,
                "method": "tap",
                "x": Double(point.x),
                "y": Double(point.y),
                "holdMs": holdMs,
            ] as [String: Any],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: request),
              let line = String(data: data, encoding: .utf8) else { return "" }
        return line
    }

    /// The daemon's reply in `line`: which request it answers, and how. nil
    /// for every other line (a command), which goes to the command queue.
    static func reply(in line: String) -> (seq: Int, outcome: Outcome)? {
        // Most lines are commands: skip the parse for them.
        guard line.contains("\"hostReply\""),
              let json = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              json["method"] == nil,
              let reply = json["hostReply"] as? [String: Any],
              let seq = (reply["seq"] as? NSNumber)?.intValue
        else { return nil }
        let error = reply["error"] as? String ?? ""
        switch reply["status"] as? String {
        case "delivered": return (seq, .delivered)
        case "notSent": return (seq, .notSent(error))
        case "failed": return (seq, .failed(error))
        case let other: return (seq, .failed("unknown status: \(other ?? "none")"))
        }
    }

    /// The longest the agent waits for a reply: past the helper's own bound
    /// on confirming a tap (4 s, which the daemon gives 5 s plus the hold).
    static let maxReplyWaitSeconds: TimeInterval = 6
    /// Room left before the daemon's read deadline for the rest of the
    /// command and its answer.
    static let readDeadlineMarginSeconds: TimeInterval = 0.2
    /// With less than this to wait in, no request is made.
    static let minReplyWaitSeconds: TimeInterval = 0.25

    /// How long to wait for the daemon's reply to a request made at `now`:
    /// zero when the daemon's read deadline leaves no time to ask.
    static func replyWait(now: Date, readDeadline: Date?) -> TimeInterval {
        guard let readDeadline else { return maxReplyWaitSeconds }
        let left = readDeadline.timeIntervalSince(now) - readDeadlineMarginSeconds
        return left < minReplyWaitSeconds ? 0 : min(maxReplyWaitSeconds, left)
    }
}

/// Where the command's thread waits for the daemon's reply to a `HostTouch`
/// request, and the socket's thread leaves it. One request is out at a time
/// (the agent runs one command at a time, and a command waits for each
/// reply before it goes on).
final class HostTouchMailbox {
    private let condition = NSCondition()
    private var lastSeq = 0
    private var awaiting: Int?
    private var arrived: HostTouch.Outcome?

    /// Start a request: its sequence number.
    func begin() -> Int {
        condition.lock()
        defer { condition.unlock() }
        lastSeq += 1
        awaiting = lastSeq
        arrived = nil
        return lastSeq
    }

    /// A reply came in. One that answers a request no longer waited for (it
    /// came after that request's deadline) is dropped.
    func deliver(seq: Int, outcome: HostTouch.Outcome) {
        condition.lock()
        defer { condition.unlock() }
        guard seq == awaiting, arrived == nil else { return }
        arrived = outcome
        condition.signal()
    }

    /// The connection a request went out on closed: no reply will come. The
    /// daemon may have pressed before it went.
    func connectionLost() {
        condition.lock()
        defer { condition.unlock() }
        guard awaiting != nil, arrived == nil else { return }
        arrived = .failed("the connection to the daemon closed before it answered")
        condition.signal()
    }

    /// Wait for the reply to request `seq`, `timeout` at most. Without one,
    /// the tap may still have been pressed.
    func wait(seq: Int, timeout: TimeInterval) -> HostTouch.Outcome {
        condition.lock()
        defer {
            awaiting = nil
            arrived = nil
            condition.unlock()
        }
        let deadline = Date(timeIntervalSinceNow: timeout)
        while arrived == nil, awaiting == seq {
            if !condition.wait(until: deadline) { break }
        }
        return arrived ?? .failed("the daemon did not answer within \(Int((timeout * 1000).rounded())) ms")
    }
}
