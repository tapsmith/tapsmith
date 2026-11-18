import CryptoKit
import Foundation

/// How a daemon connection proves it holds the token the daemon put in the
/// runner's environment (`TAPSMITH_AGENT_TOKEN`), and how the agent proves it
/// back, without the token ever crossing the wire (PILOT-969).
///
/// The listener is bound to loopback, but a simulator's agent listens on the
/// Mac's own loopback, which other local processes can reach (or squat). So
/// every connection opens with a mutual challenge-response:
///
///     agent  → {"id":"auth","challenge":"<agent nonce>"}
///     daemon → {"id":"auth","method":"auth","params":{"nonce":"<daemon nonce>",
///               "proof":HMAC(token, "daemon:" + agent nonce)}}
///     agent  → {"id":"auth","result":{"authenticated":true,
///               "proof":HMAC(token, "agent:" + daemon nonce)}}
///           or {"id":"auth","error":{"type":"UNAUTHORIZED","message":"…"}} and close
///
/// HMAC-SHA256 keyed with the token's UTF-8 bytes, as lowercase hex; nonces
/// are 32 random bytes as lowercase hex. The daemon side is
/// `packages/tapsmith-core/src/agent_auth.rs`; the Android agent mirrors this
/// in AgentAuth.kt. An agent started without a token refuses everything.
///
/// Pure Foundation and CryptoKit, for the host unit tests.
struct AgentAuth {
    static let method = "auth"

    /// How long a new connection has to authenticate, in seconds.
    static let deadline: TimeInterval = 5

    private static let firstLine = "the first line must authenticate the connection"
    private static let nonceBytes = 32

    private let key: SymmetricKey?

    enum Verdict: Equatable {
        /// Send this ack and serve the connection.
        case accepted(ack: String)
        /// Send the refusal for this reason and close.
        case refused(reason: String)
    }

    init(token: String?) {
        if let token = token, !token.isEmpty {
            key = SymmetricKey(data: Data(token.utf8))
        } else {
            key = nil
        }
    }

    /// Judge the daemon's answer `line` to the `challenge` this agent sent.
    func judge(line: String, challenge: String) -> Verdict {
        guard let key = key else {
            return .refused(reason: "the agent was started without a token, so it accepts no connections")
        }
        guard let data = line.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              request["method"] as? String == Self.method
        else {
            return .refused(reason: Self.firstLine)
        }
        let params = request["params"] as? [String: Any]
        let offered = Array(((params?["proof"] as? String) ?? "").utf8)
        let expected = Array(Self.proof(key: key, role: "daemon", nonce: challenge).utf8)
        guard Self.constantTimeEquals(expected, offered) else {
            return .refused(reason: "wrong token")
        }
        let daemonNonce = (params?["nonce"] as? String) ?? ""
        guard Self.isNonce(daemonNonce) else {
            return .refused(reason: "the daemon's nonce is missing or malformed")
        }
        return .accepted(ack: Self.ackLine(proof: Self.proof(key: key, role: "agent", nonce: daemonNonce)))
    }

    static func newNonce() -> String {
        var generator = SystemRandomNumberGenerator()
        return hex((0..<nonceBytes).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }

    static func isNonce(_ s: String) -> Bool {
        s.utf8.count == nonceBytes * 2 && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    /// HMAC-SHA256 of `"<role>:<nonce>"` keyed with `token`, as lowercase hex.
    static func proof(token: String, role: String, nonce: String) -> String {
        proof(key: SymmetricKey(data: Data(token.utf8)), role: role, nonce: nonce)
    }

    private static func proof(key: SymmetricKey, role: String, nonce: String) -> String {
        hex(Array(HMAC<SHA256>.authenticationCode(for: Data("\(role):\(nonce)".utf8), using: key)))
    }

    private static func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Compares without revealing, through timing, how much matched.
    static func constantTimeEquals(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        var diff: UInt8 = a.count == b.count ? 0 : 1
        for i in 0..<max(a.count, b.count) {
            diff |= (i < a.count ? a[i] : 0) ^ (i < b.count ? b[i] : 0)
        }
        return diff == 0
    }

    static func challengeLine(nonce: String) -> String {
        line(["id": method, "challenge": nonce])
    }

    static func ackLine(proof: String) -> String {
        line(["id": method, "result": ["authenticated": true, "proof": proof]])
    }

    static func refusalLine(_ reason: String) -> String {
        line(["id": method, "error": ["type": "UNAUTHORIZED", "message": reason]])
    }

    private static func line(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}

/// One connection, turned into what the server does with it (PILOT-969): it
/// opens with the challenge (`start()`), then incoming bytes are split into
/// lines, blank lines skipped, and the first line judged by `AgentAuth`
/// against that challenge. It is answered (the ack) or refused (the refusal,
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
    private let challenge: String
    private var buffer = Data()
    private(set) var authenticated = false
    private var closed = false

    init(auth: AgentAuth, challenge: String = AgentAuth.newNonce()) {
        self.auth = auth
        self.challenge = challenge
    }

    /// What to send as soon as the connection opens.
    func start() -> Action {
        .send(AgentAuth.challengeLine(nonce: challenge))
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
            } else {
                switch auth.judge(line: line, challenge: challenge) {
                case .refused(let reason):
                    closed = true
                    buffer = Data()
                    actions.append(.sendAndClose(AgentAuth.refusalLine(reason)))
                    return actions
                case .accepted(let ack):
                    authenticated = true
                    actions.append(.send(ack))
                }
            }
        }
        return actions
    }
}
