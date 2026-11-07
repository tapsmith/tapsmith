import Foundation

/// What a match's live query requires of every element it returns: the
/// label, identifier or placeholder it is keyed on, when it is (PILOT-1065).
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
    /// How the query matches the label, when it does.
    enum LabelRule: Equatable {
        /// `label == value`.
        case exact(String)
        /// A description (`getByDescription`): the label is the value, or
        /// holds it as one ", "-joined part — iOS joins a container's child
        /// texts that way (`SnapshotElementFinder.concatenatedLabelPredicate`).
        case description(String)

        func admits(_ label: String) -> Bool {
            switch self {
            case .exact(let value):
                return label == value
            case .description(let value):
                return label == value
                    || label.hasPrefix(value + ", ")
                    || label.hasSuffix(", " + value)
                    || label.contains(", " + value + ", ")
            }
        }
    }

    /// How the query matches the label, if it does.
    var label: LabelRule?
    /// The exact identifier the query matches on, if it does.
    var identifier: String?
    /// The exact placeholder the query matches on, if it does (a field named
    /// by its placeholder, PILOT-834).
    var placeholder: String?

    init(label: LabelRule? = nil, identifier: String? = nil, placeholder: String? = nil) {
        self.label = label
        self.identifier = identifier
        self.placeholder = placeholder
    }

    /// A query keyed on neither (by type, or by place): pins nothing.
    static let none = LiveQueryPin()

    /// Whether a live read with this label, identifier and placeholder can be
    /// one the query returned.
    func admits(label: String, identifier: String, placeholder: String = "") -> Bool {
        if let rule = self.label, !rule.admits(label) { return false }
        if let pinned = self.identifier, pinned != identifier { return false }
        if let pinned = self.placeholder, pinned != placeholder { return false }
        return true
    }
}
