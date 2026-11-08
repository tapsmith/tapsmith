import CoreGraphics
import Foundation

/// How a paced `typeText` (a typing delay above zero) checks what it typed
/// (PILOT-1012). It no longer waits for the field to show each character in
/// turn: it types the first key alone and waits for the field to take it
/// (a field just focused can drop keys while the keyboard reacts to the
/// first), sends the rest as one burst of key events, then reads the field
/// once the burst is in. A field that shows the keys short or out of order
/// once it holds still (a React Native controlled input falling behind) is
/// emptied and typed again a key at a time; one that shows something the
/// keys cannot have produced fails the action.
enum TypingCheck {
    /// The fastest burst: 100 keys a second lost no key in Speedrun's
    /// measurements (up to 300 did not either); the losses it saw came from
    /// `_XCT_sendString`, which this path does not use.
    static let maxCharactersPerSecond = 100

    /// The burst's rate for a typing delay: one key every `delayMs`, never
    /// faster than `maxCharactersPerSecond`.
    static func charactersPerSecond(delayMs: Int) -> Int {
        guard delayMs > 0 else { return maxCharactersPerSecond }
        return min(maxCharactersPerSecond, max(1, 1000 / delayMs))
    }

    /// What of `text` goes into the field as keys, and whether Return is
    /// pressed after them. A single-line field treats Return as submit (and
    /// usually gives up focus), so nothing after the first newline reaches
    /// it: the keys stop there and Return follows. A multi-line field types
    /// newlines like any other character.
    static func plan(_ text: String, multiline: Bool) -> (keys: String, submit: Bool) {
        guard !multiline, let newline = text.firstIndex(of: "\n") else { return (text, false) }
        return (String(text[..<newline]), true)
    }

    enum Reading: Equatable {
        /// The field shows exactly what was meant.
        case complete
        /// Some keys are not in yet (still arriving, or lost): what the field
        /// shows after what it held before is made only of typed characters,
        /// and fewer of them.
        case short
        /// Every typed character is there, in another order.
        case scrambled
        /// The field shows something the keys cannot have produced: it
        /// rewrote the text (a format, autocorrect), lost what it held
        /// before, or (a secure field) holds more characters than typed.
        case changed
    }

    /// Compare what the field shows with what it held before plus the keys
    /// typed. A secure field reads back only as bullets, so only lengths
    /// can be compared; one holding fewer than before lost what it held.
    static func read(_ shown: String, before: String, typed: String, secure: Bool) -> Reading {
        if secure {
            // Fewer characters than it held: it lost them (iOS empties a
            // secure field that takes a key after gaining focus), and keys
            // sent again could make the count right with the wrong text.
            if shown.count < before.count { return .changed }
            let expected = before.count + typed.count
            if shown.count == expected { return .complete }
            return shown.count < expected ? .short : .changed
        }
        if shown == before + typed { return .complete }
        guard shown.hasPrefix(before) else { return .changed }
        let added = shown.dropFirst(before.count)
        var left: [Character: Int] = [:]
        for character in typed { left[character, default: 0] += 1 }
        for character in added {
            guard let count = left[character], count > 0 else { return .changed }
            left[character] = count - 1
        }
        return added.count == typed.count ? .scrambled : .short
    }

    /// Whether a field showing `reading`, holding still, is worth emptying and
    /// typing again a key at a time. Only when what it should end up holding
    /// is known: a secure field's earlier content cannot be read back.
    static func retypes(_ reading: Reading, before: String, secure: Bool) -> Bool {
        switch reading {
        case .short, .scrambled: return !secure || before.isEmpty
        case .complete, .changed: return false
        }
    }

    /// Whether a first key that has not shown is sent again. Not into a
    /// secure field that held text: iOS empties one typed into after it
    /// takes focus, so its count cannot tell a lost key from a key that
    /// replaced the content (one bullet before, one after), and a resend
    /// could make the count right with the wrong text.
    static func resendsFirstKey(before: String, secure: Bool) -> Bool {
        !secure || before.isEmpty
    }

    /// The text input with keyboard focus, as typing into a field that
    /// moves the focus on by itself (one box per digit) watches it: a key
    /// has landed once this changes.
    struct FocusedInput: Equatable {
        var frame: CGRect
        var value: String
    }

    /// The inputs typing went through, each once, in the order it first
    /// reached them (`frames` as read, repeats included). Frames read from
    /// the tree and from an element's whole-point bounds differ by rounding.
    static func inVisitOrder(_ frames: [CGRect]) -> [CGRect] {
        var order: [CGRect] = []
        for frame in frames where !contains(order, frame) {
            order.append(frame)
        }
        return order
    }

    private static func sameFrame(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) <= 1.5 && abs(a.minY - b.minY) <= 1.5
            && abs(a.width - b.width) <= 1.5 && abs(a.height - b.height) <= 1.5
    }

    /// Typing a key at a time while the focus moves: how long the focused
    /// input must hold still before a key is sent, and how long a key may
    /// take to show (a changed value, or the focus moving on).
    static let focusStillWait: TimeInterval = 0.4
    /// Typing a key at a time while the focus moves: how long the app gets to
    /// move the focus on after a key changed the input it went to (a React
    /// Native field moves it from its JavaScript change handler, which a busy
    /// app runs late). Spent in full only where the focus stays: the last
    /// field, or a field that takes several keys.
    static let focusHandOffWait: TimeInterval = 1.0
    /// Times a key that changed nothing is sent again.
    static let keyTries = 3

    /// Times the text is typed again before the action fails.
    static let retypeTries = 2
    /// How long the first key may take to show in the field before it is
    /// sent again (a field just focused can drop it).
    static let firstKeyWait: TimeInterval = 1.0
    /// Times the first key is sent before the action fails.
    static let firstKeyTries = 3
    /// After the burst: how long the field may take to show the text, on
    /// top of the time the burst itself takes to type.
    static let burstWait: TimeInterval = 2.0
    /// How long a short or scrambled reading must hold still before it is
    /// repaired: a slow app can still be catching up on the keys.
    static let stillWait: TimeInterval = 0.5
    /// Retyping a key at a time: how long each key may take to show.
    static let keyWait: TimeInterval = 0.4

    /// How long the burst of `count` keys takes to type at `rate`.
    static func burstDuration(count: Int, charactersPerSecond rate: Int) -> TimeInterval {
        TimeInterval(count) / TimeInterval(max(rate, 1))
    }

    /// Whether the keys after the first go as one burst. A burst's rate is
    /// whole keys a second, so a delay over a second would come out shorter
    /// than asked for: those keys are sent one at a time, the delay apart.
    static func burstsAtOnce(delayMs: Int) -> Bool { delayMs <= 1000 }

    /// How long `count` keys take to send with `delayMs` between them.
    static func typingDuration(count: Int, delayMs: Int) -> TimeInterval {
        burstsAtOnce(delayMs: delayMs)
            ? burstDuration(count: count, charactersPerSecond: charactersPerSecond(delayMs: delayMs))
            : TimeInterval(count) * TimeInterval(delayMs) / 1000
    }

    /// Typing a key at a time: how long to wait before the next key so keys
    /// stay at least `delayMs` apart (`lastSentAt` nil: none sent yet).
    static func waitBeforeKey(lastSentAt: Date?, delayMs: Int, now: Date) -> TimeInterval {
        guard let lastSentAt, delayMs > 0 else { return 0 }
        return max(0, TimeInterval(delayMs) / 1000 - now.timeIntervalSince(lastSentAt))
    }

    /// Whether `frame` is one of `frames` (the same input, read again).
    static func contains(_ frames: [CGRect], _ frame: CGRect) -> Bool {
        frames.contains { sameFrame($0, frame) }
    }

    /// Whether the SDK would take an action error with this message for a
    /// stale element: it looks for "stale" anywhere in it, then finds the
    /// element again and repeats the whole action.
    static func readsAsStale(_ message: String) -> Bool {
        message.range(of: "stale", options: .caseInsensitive) != nil
    }

    /// `message`, reading the same but no longer taken for a stale element:
    /// once a key may be in the field, repeating the action would type the
    /// text twice. "stale" can come from the field's own text quoted in the
    /// message, or from a lookup that lost the field (then said so first).
    /// Each "stale" gets a zero-width space after its "s".
    static func notStale(_ message: String) -> String {
        let marked = message.hasPrefix("typeText")
            ? message
            : "typeText lost the field after typing into it: \(message)"
        guard let pattern = try? NSRegularExpression(pattern: "(s)(tale)", options: .caseInsensitive) else {
            return marked
        }
        let range = NSRange(marked.startIndex..., in: marked)
        return pattern.stringByReplacingMatches(in: marked, range: range, withTemplate: "$1\u{200B}$2")
    }

    /// How the field's content is described in an error: a secure field's
    /// only by its length.
    static func describe(_ value: String, secure: Bool) -> String {
        secure ? "\(value.count) character(s)" : "\"\(value)\""
    }
}
