import Foundation

/// What a match's live query requires of every element it returns: the
/// label and the identifier it is keyed on, when it is (PILOT-1065).
///
/// A touch is planned on a live read of the element it is for
/// (`XCUIElement.snapshot()` through the query the match was cached with).
/// XCTest answers that read in two steps: it resolves the query to an
/// element, then reads the element's attributes. React Native can reuse one
/// native view for two different elements — a ternary that swaps one
/// Pressable for another in the same place only changes the view's props —
/// so when the swap lands between the two steps, the query matched the view
/// as the element found ("Covered action") and its attributes come back as
/// the one that replaced it ("Replacement action"). Planned on that read,
/// the touch went to the replacement and reported success.
///
/// Such a read contradicts its own query: the query could not have returned
/// an element with that label. So a read is the element found only if the
/// pin admits it; one it does not admit is treated like a live element that
/// could not be read, and the analyzer judges the element by what was cached
/// when it was found (`OcclusionAnalyzer.Target.isLive`), which reports it
/// gone when nothing in the tree matches it any more.
///
/// Only what the query is keyed on is pinned. An element found by its
/// identifier (`getByTestId`) is still returned by its query after its label
/// changes — a countdown button is the same button — so its label is not
/// checked.
struct LiveQueryPin: Equatable {
    /// The exact label the query matches on, if it does.
    var label: String?
    /// The exact identifier the query matches on, if it does.
    var identifier: String?

    /// A query keyed on neither (by type, or by place): pins nothing.
    static let none = LiveQueryPin()

    /// Whether a live read with this label and identifier can be one the
    /// query returned.
    func admits(label: String, identifier: String) -> Bool {
        if let pinned = self.label, pinned != label { return false }
        if let pinned = self.identifier, pinned != identifier { return false }
        return true
    }
}
