// Unit tests for AgentAuth (PILOT-969): the first line on every daemon
// connection must carry the launch token.

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

func authLine(_ token: String) -> String {
    #"{"id":"auth","method":"auth","params":{"token":"\#(token)"}}"#
}

func json(_ line: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: line.data(using: .utf8)!) as? [String: Any]) ?? [:]
}

let auth = AgentAuth(token: token)
expect("accepts the auth line with the launch token", auth.refusal(line: authLine(token)) == nil)
expect("refuses another token", auth.refusal(line: authLine(String(repeating: "cd", count: 32))) == "wrong token")
expect("refuses a prefix of the token", auth.refusal(line: authLine(String(token.dropLast()))) == "wrong token")
expect("refuses an empty token", auth.refusal(line: authLine("")) == "wrong token")
expect("refuses a missing token",
       auth.refusal(line: #"{"id":"auth","method":"auth","params":{}}"#) == "wrong token")
expect("refuses a command sent before authenticating",
       auth.refusal(line: #"{"id":"1","method":"getClipboard","params":{"token":"\#(token)"}}"#) != nil)
expect("refuses a line that is not JSON", auth.refusal(line: "hello") != nil)

for missing in [nil, ""] as [String?] {
    let unconfigured = AgentAuth(token: missing)
    expect("an agent started without a token refuses even an empty token",
           unconfigured.refusal(line: authLine("")) != nil)
    expect("an agent started without a token refuses any token",
           unconfigured.refusal(line: authLine(token)) != nil)
}

expect("constant-time compare: equal", AgentAuth.constantTimeEquals([1, 2, 3], [1, 2, 3]))
expect("constant-time compare: differs", !AgentAuth.constantTimeEquals([1, 2, 3], [1, 2, 4]))
expect("constant-time compare: longer", !AgentAuth.constantTimeEquals([1, 2, 3], [1, 2, 3, 0]))
expect("constant-time compare: empty vs empty", AgentAuth.constantTimeEquals([], []))

let ack = json(AgentAuth.ackLine())
expect("the ack is what the daemon reads",
       ack["id"] as? String == "auth"
           && (ack["result"] as? [String: Any])?["authenticated"] as? Bool == true)
let refusal = json(AgentAuth.refusalLine("wrong token"))
let error = refusal["error"] as? [String: Any]
expect("the refusal is what the daemon reads",
       refusal["id"] as? String == "auth"
           && error?["type"] as? String == "UNAUTHORIZED"
           && error?["message"] as? String == "wrong token")
expect("the ack is one line", !AgentAuth.ackLine().contains("\n"))

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("AgentAuth: all tests passed")
