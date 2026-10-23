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
/// end of existing text) is checked, followed by one at the centre if it did
/// not take, and a field that never takes focus fails the command.
enum TypingFocus {
    /// Points to try inside `area` (the element's uncovered part), in order:
    /// near the trailing edge, then the centre. One point when the two are
    /// next to each other (a narrow field).
    static func tapPoints(in area: CGRect) -> [CGPoint] {
        let inset = min(12, max(1, area.width / 4))
        let trailing = CGPoint(x: max(area.minX + 1, area.maxX - inset), y: area.midY)
        let centre = CGPoint(x: area.midX, y: area.midY)
        if abs(trailing.x - centre.x) < 8 { return [trailing] }
        return [trailing, centre]
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

    /// Whether a focusing tap on the element at `element` took.
    /// `focusedBefore` / `focusedAfter` are the frames of the text input with
    /// keyboard focus before and after the tap (nil: none).
    static func verdict(
        element: CGRect,
        focusedBefore: CGRect?,
        focusedAfter: CGRect?,
        keyboardOnScreen: Bool
    ) -> Verdict {
        guard let after = focusedAfter else {
            return keyboardOnScreen ? .unverifiable : .notFocused
        }
        // Bounds are integer-truncated.
        if framesMatch(after, element, tolerance: 1.5) { return .focused }
        // An input inside the element (type() on a field's wrapper).
        if element.insetBy(dx: -1.5, dy: -1.5).contains(after) { return .focused }
        // Focus moved with the tap to an input the size of this element: the
        // element itself, moved by taking focus (a keyboard-avoiding layout
        // lifts it). Unmoved focus on a same-sized input is another field
        // keeping the focus it had.
        let moved = focusedBefore.map { !framesMatch($0, after, tolerance: 1.5) } ?? true
        return moved && sizesMatch(after, element) ? .focused : .notFocused
    }

    private static func framesMatch(_ a: CGRect, _ b: CGRect, tolerance: CGFloat) -> Bool {
        abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance
            && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }

    private static func sizesMatch(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.width - b.width) <= 1.5 && abs(a.height - b.height) <= 1.5
    }
}
