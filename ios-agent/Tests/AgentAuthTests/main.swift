// Unit tests for AgentAuth and ConnectionGate (PILOT-969): every daemon
// connection opens with a mutual challenge-response on the launch token.

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

let token = String(repeating: "ab", count: 32)
let challenge = String(repeating: "0123456789abcdef", count: 4)
let daemonNonce = String(repeating: "d", count: 64)

func authLine(proof: String, nonce: String = daemonNonce) -> String {
    #"{"id":"auth","method":"auth","params":{"nonce":"\#(nonce)","proof":"\#(proof)"}}"#
}

func daemonProof(_ token: String = token, challenge: String = challenge) -> String {
    AgentAuth.proof(token: token, role: "daemon", nonce: challenge)
}

func json(_ line: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: line.data(using: .utf8)!) as? [String: Any]) ?? [:]
}

func refusal(_ verdict: AgentAuth.Verdict) -> String? {
    if case .refused(let reason) = verdict { return reason }
    return nil
}

// The vector shared with the daemon (agent_auth.rs) and the Android agent.
expect("daemon proof matches the shared vector",
       AgentAuth.proof(token: token, role: "daemon", nonce: challenge)
           == "9a11a9da9d0f2172d5801943fbf6124fa424af0de00767c54b12a04791e64f3a")
expect("agent proof matches the shared vector",
       AgentAuth.proof(token: token, role: "agent", nonce: challenge)
           == "9e9de4b1c2ee0bdfa527a9a8194aab687a211461a9461da1fd5fc353b2a91493")

let auth = AgentAuth(token: token)

if case .accepted(let ack) = auth.judge(line: authLine(proof: daemonProof()), challenge: challenge) {
    let result = json(ack)["result"] as? [String: Any]
    expect("accepts a daemon that proves it holds the token",
           json(ack)["id"] as? String == "auth" && result?["authenticated"] as? Bool == true)
    expect("and proves it back on the daemon's nonce",
           result?["proof"] as? String == AgentAuth.proof(token: token, role: "agent", nonce: daemonNonce))
    expect("the token never goes out", !ack.contains(token))
} else {
    expect("accepts a daemon that proves it holds the token", false)
}

expect("refuses another token's proof",
       refusal(auth.judge(line: authLine(proof: daemonProof(String(repeating: "cd", count: 32))), challenge: challenge))
           == "wrong token")
expect("refuses the agent-side proof reflected back",
       refusal(auth.judge(line: authLine(proof: AgentAuth.proof(token: token, role: "agent", nonce: challenge)),
                          challenge: challenge)) == "wrong token")
expect("refuses a proof for another challenge",
       refusal(auth.judge(line: authLine(proof: daemonProof(challenge: daemonNonce)), challenge: challenge))
           == "wrong token")
expect("refuses an empty proof", refusal(auth.judge(line: authLine(proof: ""), challenge: challenge)) == "wrong token")
expect("refuses the raw token in place of a proof",
       refusal(auth.judge(line: #"{"id":"auth","method":"auth","params":{"token":"\#(token)"}}"#, challenge: challenge))
           == "wrong token")
expect("refuses a malformed daemon nonce",
       refusal(auth.judge(line: authLine(proof: daemonProof(), nonce: "xyz"), challenge: challenge)) != nil)
expect("refuses a command sent before authenticating",
       refusal(auth.judge(line: #"{"id":"1","method":"getClipboard","params":{}}"#, challenge: challenge)) != nil)
expect("refuses a line that is not JSON", refusal(auth.judge(line: "hello", challenge: challenge)) != nil)

for missing in [nil, ""] as [String?] {
    let unconfigured = AgentAuth(token: missing)
    expect("an agent started without a token refuses everything",
           refusal(unconfigured.judge(line: authLine(proof: daemonProof()), challenge: challenge)) != nil
               && refusal(unconfigured.judge(line: authLine(proof: ""), challenge: challenge)) != nil)
}

let nonce = AgentAuth.newNonce()
expect("nonces are 64 lowercase hex", AgentAuth.isNonce(nonce))
expect("nonces are fresh", nonce != AgentAuth.newNonce())

expect("constant-time compare: equal", AgentAuth.constantTimeEquals([1, 2, 3], [1, 2, 3]))
expect("constant-time compare: differs", !AgentAuth.constantTimeEquals([1, 2, 3], [1, 2, 4]))
expect("constant-time compare: longer", !AgentAuth.constantTimeEquals([1, 2, 3], [1, 2, 3, 0]))

let refusalJson = json(AgentAuth.refusalLine("wrong token"))
let error = refusalJson["error"] as? [String: Any]
expect("the refusal is what the daemon reads",
       refusalJson["id"] as? String == "auth"
           && error?["type"] as? String == "UNAUTHORIZED"
           && error?["message"] as? String == "wrong token")

// ConnectionGate: what SocketServer does with one connection.
func bytes(_ s: String) -> Data { s.data(using: .utf8)! }
typealias Action = ConnectionGate.Action
let goodAck = AgentAuth.ackLine(proof: AgentAuth.proof(token: token, role: "agent", nonce: daemonNonce))

do {
    let gate = ConnectionGate(auth: auth, challenge: challenge)
    expect("the connection opens with the challenge",
           gate.start() == .send(AgentAuth.challengeLine(nonce: challenge)))
    let first = gate.receive(bytes(authLine(proof: daemonProof()) + "\n" + #"{"id":"1","method":"ping"}"# + "\n"))
    expect("the auth line is answered with the ack, never passed on as a command",
           first == [.send(goodAck), .command(#"{"id":"1","method":"ping"}"#)])
    expect("the connection counts as authenticated", gate.authenticated)
    let later = gate.receive(bytes(#"{"id":"2","method":"tap"}"# + "\n"))
    expect("later lines are commands", later == [.command(#"{"id":"2","method":"tap"}"#)])
}

do {
    let gate = ConnectionGate(auth: auth, challenge: challenge)
    let actions = gate.receive(bytes(authLine(proof: daemonProof(String(repeating: "cd", count: 32))) + "\n"
        + #"{"id":"1","method":"getClipboard"}"# + "\n"))
    expect("a wrong proof is refused and the connection closed, with nothing run",
           actions == [.sendAndClose(AgentAuth.refusalLine("wrong token"))])
    expect("a refused connection is not authenticated", !gate.authenticated)
    expect("nothing comes out after a refusal",
           gate.receive(bytes(authLine(proof: daemonProof()) + "\n" + #"{"id":"2","method":"tap"}"# + "\n")).isEmpty)
}

do {
    // A fresh challenge per connection: a proof for one does not open another.
    let gate = ConnectionGate(auth: auth)
    let actions = gate.receive(bytes(authLine(proof: daemonProof()) + "\n"))
    expect("a proof replayed from another connection's challenge is refused",
           actions == [.sendAndClose(AgentAuth.refusalLine("wrong token"))])
}

do {
    let gate = ConnectionGate(auth: auth, challenge: challenge)
    let actions = gate.receive(bytes(#"{"id":"1","method":"getClipboard","params":{}}"# + "\n"))
    expect("a command sent before authenticating is refused, not run",
           actions == [.sendAndClose(AgentAuth.refusalLine("the first line must authenticate the connection"))])
}

do {
    let gate = ConnectionGate(auth: auth, challenge: challenge)
    expect("blank lines before the auth line are skipped", gate.receive(bytes("\n  \n")).isEmpty)
    let line = authLine(proof: daemonProof()) + "\n"
    let half = line.index(line.startIndex, offsetBy: 20)
    expect("a partial line waits for its newline", gate.receive(bytes(String(line[..<half]))).isEmpty)
    expect("then the auth line is answered", gate.receive(bytes(String(line[half...]))) == [.send(goodAck)])
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("AgentAuth: all tests passed")
