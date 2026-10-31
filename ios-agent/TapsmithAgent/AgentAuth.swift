import Foundation

/// The secret every daemon connection must present first (PILOT-969).
///
/// The listener is bound to loopback, but a simulator's agent listens on the
/// Mac's own loopback, so the first line on a connection must be
/// `{"id":"auth","method":"auth","params":{"token":"…"}}` carrying the token
/// the daemon put in the runner's environment (`TAPSMITH_AGENT_TOKEN`).
/// Anything else is refused and the connection closed. An agent started
/// without a token refuses everything.
///
/// Mirrors the Android agent's AgentAuth.kt. Pure Foundation, for the host
/// unit tests.
struct AgentAuth {
    static let method = "auth"

    /// How long a new connection has to authenticate, in seconds.
    static let deadline: TimeInterval = 5

    private let expected: [UInt8]?

    init(token: String?) {
        if let token = token, !token.isEmpty {
            expected = Array(token.utf8)
        } else {
            expected = nil
        }
    }

    /// Why `line` does not authenticate the connection, or nil when it does.
    func refusal(line: String) -> String? {
        guard let expected = expected else {
            return "the agent was started without a token, so it accepts no connections"
        }
        guard let data = line.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              request["method"] as? String == Self.method
        else {
            return "the first line must authenticate the connection"
        }
        let params = request["params"] as? [String: Any]
        let offered = Array(((params?["token"] as? String) ?? "").utf8)
        return Self.constantTimeEquals(expected, offered) ? nil : "wrong token"
    }

    /// Compares without revealing, through timing, how much matched.
    static func constantTimeEquals(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        var diff: UInt8 = a.count == b.count ? 0 : 1
        for i in 0..<max(a.count, b.count) {
            diff |= (i < a.count ? a[i] : 0) ^ (i < b.count ? b[i] : 0)
        }
        return diff == 0
    }

    static func ackLine() -> String {
        line(["id": method, "result": ["authenticated": true]])
    }

    static func refusalLine(_ reason: String) -> String {
        line(["id": method, "error": ["type": "UNAUTHORIZED", "message": reason]])
    }

    private static func line(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}

/// One connection's incoming bytes, turned into what the server does with
/// them (PILOT-969): split into lines, blank lines skipped, the first line
/// judged by `AgentAuth`. It is answered (the ack) or refused (the refusal,
/// then close), and never becomes a command. Every later line is a command.
/// Nothing comes out after a refusal.
///
/// Kept out of SocketServer so the host unit tests can drive it. Not thread
/// safe: SocketServer uses it only on its socket queue.
final class ConnectionGate {
    enum Action: Equatable {
        /// Write this line and carry on.
        case send(String)
        /// Write this line, then close the connection.
        case sendAndClose(String)
        /// A command for the handler.
        case command(String)
    }

    private let auth: AgentAuth
    private var buffer = Data()
    private(set) var authenticated = false
    private var closed = false

    init(auth: AgentAuth) {
        self.auth = auth
    }

    /// Feed bytes as they arrive; returns what to do, in order.
    func receive(_ data: Data) -> [Action] {
        guard !closed else { return [] }
        buffer.append(data)
        var actions: [Action] = []
        while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = buffer[buffer.startIndex..<newline]
            buffer = Data(buffer[buffer.index(after: newline)...])
            guard let line = String(data: lineData, encoding: .utf8),
                  !line.trimmingCharacters(in: .whitespaces).isEmpty
            else { continue }
            if authenticated {
                actions.append(.command(line))
            } else if let refusal = auth.refusal(line: line) {
                closed = true
                buffer = Data()
                actions.append(.sendAndClose(AgentAuth.refusalLine(refusal)))
                return actions
            } else {
                authenticated = true
                actions.append(.send(AgentAuth.ackLine()))
            }
        }
        return actions
    }
}
