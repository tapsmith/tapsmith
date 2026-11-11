// Unit tests for HostTouch: the taps the agent asks the daemon to press in
// the middle of a command (a typeText's focusing tap, a hideKeyboard's tap on
// a blank spot), through the simulator's HID helper.

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

func json(_ line: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]) ?? [:]
}

// ─── Whether, where and how to press ───

let tall = CGSize(width: 402, height: 874)
let wide = CGSize(width: 874, height: 402)
let field = CGPoint(x: 350, y: 300)

// A text input is touched within one frame; over HID that is pressed and
// lifted back to back (`HidTouch.hold`), as an element tap on it is.
let focusTap = HostTouch.plan(offered: true, point: field, hold: TapTiming.hold(for: .textField),
                              screen: tall, device: .portrait)
expect("a focusing tap on a text field is pressed where planned, back to back",
       focusTap?.point == field && focusTap?.holdMs == 0)
// A blank spot beside the field: what is there is unknown, so the hold spans
// a frame, as the agent's own tap there does.
let blankTap = HostTouch.plan(offered: true, point: field, hold: TapTiming.hold(for: nil),
                              screen: tall, device: .portrait)
expect("a tap on an unknown target keeps its frame-spanning hold", blankTap?.holdMs == 20)
expect("a keyboard key is pressed back to back",
       HostTouch.plan(offered: true, point: field, hold: TapTiming.hold(for: .key),
                      screen: tall, device: .portrait)?.holdMs == 0)

// A daemon that did not offer (an older one, a physical device, Linux): the
// agent's own touch.
expect("no request without the daemon's offer",
       HostTouch.plan(offered: false, point: field, hold: 0.01, screen: tall, device: .portrait) == nil)

// The helper presses in the device's native portrait space.
let turned = HostTouch.plan(offered: true, point: CGPoint(x: 809.5, y: 156), hold: 0.02,
                            screen: wide, device: .landscapeLeft)
expect("on a rotated screen the point is mapped to native portrait",
       turned?.point == CGPoint(x: 246, y: 809.5))
expect("a turn that cannot be told gets the agent's own touch",
       HostTouch.plan(offered: true, point: field, hold: 0.01, screen: wide, device: .other) == nil)
expect("so does an upside-down device",
       HostTouch.plan(offered: true, point: field, hold: 0.01, screen: tall, device: .portraitUpsideDown) == nil)

// ─── The request line ───

let request = json(HostTouch.requestLine(seq: 3, point: CGPoint(x: 201.5, y: 310), holdMs: 20))
let body = request["hostRequest"] as? [String: Any] ?? [:]
expect("the request is one JSON line", !HostTouch.requestLine(seq: 3, point: field, holdMs: 0).contains("\n"))
expect("it names its sequence number", (body["seq"] as? Int) == 3)
expect("it asks for a tap", (body["method"] as? String) == "tap")
expect("at the point", (body["x"] as? Double) == 201.5 && (body["y"] as? Double) == 310)
expect("held as planned", (body["holdMs"] as? Int) == 20)
expect("a request is not an answer to the command", request["id"] == nil && request["result"] == nil)

// ─── The daemon's reply ───

func reply(_ line: String) -> (seq: Int, outcome: HostTouch.Outcome)? { HostTouch.reply(in: line) }

let delivered = reply(#"{"hostReply":{"seq":3,"status":"delivered"}}"#)
expect("a delivered tap", delivered?.seq == 3 && delivered?.outcome == .delivered)
let notSent = reply(#"{"hostReply":{"seq":4,"status":"notSent","error":"no helper"}}"#)
expect("a tap that touched nothing: the agent makes it", notSent?.outcome == .notSent("no helper"))
let failed = reply(#"{"hostReply":{"seq":5,"status":"failed","error":"no reply within 5020 ms"}}"#)
expect("a tap that may have landed", failed?.outcome == .failed("no reply within 5020 ms"))
// Anything else means the daemon pressed something this agent does not know
// about: never tap again on top of it.
expect("an unknown status counts as possibly landed",
       reply(#"{"hostReply":{"seq":6,"status":"later"}}"#)?.outcome == .failed("unknown status: later"))

// Everything that is not a reply is a command for the queue.
expect("a command is not a reply",
       reply(#"{"id":"a","method":"typeText","params":{"text":"x","hostTouch":true}}"#) == nil)
expect("a command typing the word is not a reply",
       reply(#"{"id":"a","method":"typeText","params":{"text":"\"hostReply\":{\"seq\":1}"}}"#) == nil)
expect("a command with a hostReply param is not a reply",
       reply(#"{"id":"a","method":"ping","params":{"hostReply":{"seq":1,"status":"delivered"}}}"#) == nil)
expect("a ping is not a reply", reply(#"{"id":"p","method":"ping"}"#) == nil)
expect("a line that is not JSON is not a reply", reply("hostReply") == nil)
expect("a reply without a sequence number answers nothing",
       reply(#"{"hostReply":{"status":"delivered"}}"#) == nil)

// ─── How long to wait for the reply ───

let now = Date(timeIntervalSince1970: 1_000)
expect("the helper's own bound on a tap, and a little more",
       HostTouch.replyWait(now: now, readDeadline: nil) == 6)
expect("never past the daemon's read deadline, less the room to answer",
       abs(HostTouch.replyWait(now: now, readDeadline: now.addingTimeInterval(2)) - 1.8) < 0.0001)
expect("no time left: no request",
       HostTouch.replyWait(now: now, readDeadline: now.addingTimeInterval(0.1)) == 0)

// ─── Waiting for the reply ───

// The command's thread waits while the socket's thread delivers.
let mailbox = HostTouchMailbox()
let first = mailbox.begin()
DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
    mailbox.deliver(seq: first, outcome: .delivered)
}
expect("the waiter gets the reply to its request", mailbox.wait(seq: first, timeout: 2) == .delivered)

// A daemon that never answers: the wait ends, and the tap may have landed.
let second = mailbox.begin()
let started = Date()
let unanswered = mailbox.wait(seq: second, timeout: 0.1)
expect("an unanswered request ends at its deadline",
       Date().timeIntervalSince(started) < 1 && unanswered == .failed("the daemon did not answer within 100 ms"))

// Its reply arriving late must not answer the next request.
let third = mailbox.begin()
expect("each request gets a new sequence number", third != second && second != first)
mailbox.deliver(seq: second, outcome: .delivered)
DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
    mailbox.deliver(seq: third, outcome: .notSent("no helper"))
}
expect("a late reply to an earlier request is dropped",
       mailbox.wait(seq: third, timeout: 2) == .notSent("no helper"))

// A reply that came before the wait began is still there.
let fourth = mailbox.begin()
mailbox.deliver(seq: fourth, outcome: .delivered)
expect("a reply that beat the wait is kept", mailbox.wait(seq: fourth, timeout: 0.05) == .delivered)

// The connection closing while a request is out: the daemon had it.
let fifth = mailbox.begin()
DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { mailbox.connectionLost() }
let lost = mailbox.wait(seq: fifth, timeout: 2)
expect("a lost connection releases the waiter",
       lost == .failed("the connection to the daemon closed before it answered"))
// With no request out, it changes nothing for the next one.
mailbox.connectionLost()
let sixth = mailbox.begin()
mailbox.deliver(seq: sixth, outcome: .delivered)
expect("a connection lost between requests does not fail the next", mailbox.wait(seq: sixth, timeout: 0.05) == .delivered)

if failures > 0 {
    print("\(failures) HostTouch test(s) failed")
    exit(1)
}
print("All HostTouch tests passed")
