import CoreGraphics

/// Whether a match inside a table or collection row is still bound to its
/// own live element (PILOT-952).
///
/// The agent finds a match again as a live `XCUIElement` by its place in a
/// query: the n-th node with its label, or the n-th of its type. That relies
/// on the live query returning nodes in the snapshot's order. A row's
/// controls repeat on every row (a "More Info" detail button, a swipe
/// action's "Delete", any accessory button with the same label), and once a
/// `UITableView` has scrolled and reused its cells, the live query's order no
/// longer follows the tree's: the n-th "More Info" is another row's. A touch
/// sent through it reached Row 67's button for Row 68's, and reported
/// success.
///
/// So such a binding is checked each time it is used (its query is evaluated
/// again on every read, so one check would not hold while the table moves):
/// the live element must be where the match was found. One that is elsewhere is dropped, and
/// the element is touched at the frame it was found at, as a row's accessory
/// indicator always is (`CellAccessories`, PILOT-895), which checks against a
/// fresh tree that it is still there. A binding nothing else could be bound
/// to (the only node its query returns) needs no check.
enum RowBinding {
    /// Whether a match's live element must be checked whenever it is used:
    /// it is a row or inside one, and its query returns other nodes too.
    static func needsCheck(inRow: Bool, uniqueInQuery: Bool) -> Bool {
        inRow && !uniqueInQuery
    }

    /// Whether the live element, read at `live` (nil: it could not be read),
    /// is the match found at `found`. Compared in whole points, as the SDK
    /// keys a target. A found frame with no area matches nothing.
    static func isFoundElement(found: CGRect, live: CGRect?) -> Bool {
        guard let live, found.width > 0, found.height > 0 else { return false }
        func points(_ r: CGRect) -> [Int] {
            [Int(r.minX), Int(r.minY), Int(r.maxX), Int(r.maxY)]
        }
        return points(found) == points(live)
    }
}
