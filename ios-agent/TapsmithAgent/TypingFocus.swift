import CoreGraphics

/// Where type() and clear() tap to focus a text input, and whether the tap
/// gave it focus (PILOT-829). Kept free of XCUITest so the host unit tests can
/// drive it (`ios-agent/Tests/run-unit-tests.sh`).
///
/// A field's accessibility frame can be wider than the view that takes the
/// touch: a SwiftUI `Form` TextField on iOS 18 reports the whole row, ~20 pt
/// past the text input on each side, so a tap 12 pt in from the trailing edge
/// lands on the cell and focuses nothing. Typing then went to no field and
/// still reported success. So the trailing tap (which keeps the caret at the
/// end of existing text) is checked, followed by taps further in if it did not
/// take, and a field that never takes focus fails the command.
enum TypingFocus {
    /// A text input as the focus check sees it: the target element (from its
    /// resolve) or the input that has keyboard focus (from a live query).
    struct Input: Equatable {
        var frame: CGRect
        /// `XCUIElementType…` class name.
        var className: String
        /// Accessibility identifier, "" when none.
        var identifier: String = ""
        /// Placeholder, "" when none.
        var placeholder: String = ""
    }

    /// The first point to try inside `area` (the element's uncovered part):
    /// near the trailing edge, so the caret goes after existing text.
    static func trailingPoint(in area: CGRect) -> CGPoint {
        point(in: area, inset: 12)
    }

    /// The points to try next, inside `area` as planned again after the
    /// first tap (which can have moved the field), skipping any next to a
    /// point already tried: further in from the trailing edge, past a Form
    /// row's ~20 pt of padding, so the caret still goes after existing text;
    /// then the centre, for an input narrower than its frame on both sides.
    static func fallbackPoints(in area: CGRect, after first: CGPoint) -> [CGPoint] {
        var tried = [first]
        var points: [CGPoint] = []
        for candidate in [point(in: area, inset: 40), CGPoint(x: area.midX, y: area.midY)] {
            guard !tried.contains(where: { abs($0.x - candidate.x) < 8 && abs($0.y - candidate.y) < 8 }) else {
                continue
            }
            tried.append(candidate)
            points.append(candidate)
        }
        return points
    }

    private static func point(in area: CGRect, inset: CGFloat) -> CGPoint {
        let inset = min(inset, max(1, area.width / 4))
        return CGPoint(x: max(area.minX + 1, area.maxX - inset), y: area.midY)
    }

    enum Verdict: Equatable {
        /// The element (or an input inside it) has keyboard focus.
        case focused
        /// Focus is somewhere else, or nowhere and no keyboard is up: the
        /// tap did not land on the input.
        case notFocused
        /// No text input reports focus but a keyboard is on screen (content
        /// whose inputs do not report focus, such as some web content): no
        /// evidence either way, so typing goes ahead as before.
        case unverifiable
    }

    /// Whether a focusing tap on `element` took. `focusedBefore` /
    /// `focusedAfter` are the text input with keyboard focus before and
    /// after the tap (nil: none); `tappedAt` is where the tap landed, planned
    /// from the element's live position (nil: XCUITest tapped the element).
    static func verdict(
        element: Input,
        tappedAt: CGPoint?,
        focusedBefore: Input?,
        focusedAfter: Input?,
        keyboardOnScreen: Bool
    ) -> Verdict {
        guard let after = focusedAfter else {
            return keyboardOnScreen ? .unverifiable : .notFocused
        }
        // Where the element was resolved, or an input inside it (type() on a
        // field's wrapper), or the input under the tap: inputs do not
        // overlap, and the tap was planned from where the element is now
        // (its resolve-time frame can be stale: a Form still scrolling the
        // field that a tap() just focused). Bounds are integer-truncated.
        let tolerance: CGFloat = 1.5
        if framesMatch(after.frame, element.frame)
            || element.frame.insetBy(dx: -tolerance, dy: -tolerance).contains(after.frame)
            || tappedAt.map({ after.frame.insetBy(dx: -tolerance, dy: -tolerance).contains($0) }) == true {
            return .focused
        }
        // Somewhere else: the element itself only if it moved or resized on
        // taking focus (a keyboard-avoiding layout lifts it; a search bar
        // slides up and narrows for Cancel). That needs an input that took
        // focus with this tap: one that already had it is another field
        // keeping its focus (ids and placeholders repeat: list rows sharing a
        // testID, several "Required" rows).
        if let before = focusedBefore, isSameInput(before, after) { return .notFocused }
        // Not a text input itself (a wrapper around one, or an element known
        // only by its cached bounds): nothing of its own to compare.
        guard textInputClassNames.contains(element.className) else { return .focused }
        // An identifier or placeholder on both sides decides which input it is.
        if !element.identifier.isEmpty && !after.identifier.isEmpty {
            return element.identifier == after.identifier ? .focused : .notFocused
        }
        if !element.placeholder.isEmpty && !after.placeholder.isEmpty {
            return element.placeholder == after.placeholder && element.className == after.className
                ? .focused : .notFocused
        }
        // Nothing else to tell them apart by: an input of the element's kind.
        return element.className == after.className ? .focused : .notFocused
    }

    /// Whether two reads of the focused input are the same input: same kind,
    /// identity and size. Position is left out, so a field that keeps its
    /// focus while a layout moves it still counts as the same.
    private static func isSameInput(_ a: Input, _ b: Input) -> Bool {
        a.className == b.className && a.identifier == b.identifier && a.placeholder == b.placeholder
            && abs(a.frame.width - b.frame.width) <= 1.5 && abs(a.frame.height - b.frame.height) <= 1.5
    }

    static let textInputClassNames: Set<String> = [
        "XCUIElementTypeTextField", "XCUIElementTypeSecureTextField",
        "XCUIElementTypeTextView", "XCUIElementTypeSearchField",
    ]

    private static func framesMatch(_ a: CGRect, _ b: CGRect) -> Bool {
        let tolerance: CGFloat = 1.5
        return abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance
            && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }
}
