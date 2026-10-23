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
        let inset = min(12, max(1, area.width / 4))
        return CGPoint(x: max(area.minX + 1, area.maxX - inset), y: area.midY)
    }

    /// The fallback point inside `area` (planned again after the first tap,
    /// which can have moved the field), or nil when it is next to the first
    /// tap (a narrow field: the same tap again would not do better).
    static func fallbackPoint(in area: CGRect, after first: CGPoint) -> CGPoint? {
        let centre = CGPoint(x: area.midX, y: area.midY)
        return abs(centre.x - first.x) < 8 && abs(centre.y - first.y) < 8 ? nil : centre
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
    /// after the tap (nil: none).
    static func verdict(
        element: Input,
        focusedBefore: Input?,
        focusedAfter: Input?,
        keyboardOnScreen: Bool
    ) -> Verdict {
        guard let after = focusedAfter else {
            return keyboardOnScreen ? .unverifiable : .notFocused
        }
        // Where the element was resolved, or an input inside it (type() on a
        // field's wrapper). Bounds are integer-truncated.
        if framesMatch(after.frame, element.frame)
            || element.frame.insetBy(dx: -1.5, dy: -1.5).contains(after.frame) {
            return .focused
        }
        // Somewhere else: the element itself only if it moved or resized on
        // taking focus (a keyboard-avoiding layout lifts it; a search bar
        // slides up and narrows for Cancel). An identifier or placeholder on
        // both sides decides which input it is.
        if !element.identifier.isEmpty && !after.identifier.isEmpty {
            return element.identifier == after.identifier ? .focused : .notFocused
        }
        // Below that, it must also be an input that took focus with this tap:
        // one that already had it is another field keeping its focus
        // (placeholders repeat: several "Required" rows).
        let changed = focusedBefore.map { $0 != after } ?? true
        if !element.placeholder.isEmpty && !after.placeholder.isEmpty {
            return changed && element.placeholder == after.placeholder && element.className == after.className
                ? .focused : .notFocused
        }
        // Nothing else to tell them apart by: an input of the element's kind.
        return changed && element.className == after.className ? .focused : .notFocused
    }

    private static func framesMatch(_ a: CGRect, _ b: CGRect) -> Bool {
        let tolerance: CGFloat = 1.5
        return abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance
            && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }
}
