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
/// A row that shows a text no other row shows is found again through that
/// text (`RowAnchor`), which follows the row wherever it scrolls. A row with
/// no such text falls back to this: its binding is checked each time it is
/// used (its query is evaluated again on every read, so one check would not
/// hold while the table moves): the live element must be where the match was
/// found. One that is elsewhere is dropped, and the element is touched at the
/// frame it was found at, as a row's accessory indicator always is
/// (`CellAccessories`, PILOT-895), which checks against a fresh tree that it
/// is still there. A binding nothing else could be bound to (the only node
/// its query returns, in a list that shows every row) needs no check.
enum RowBinding {
    /// What the match walk records about a match's row (RowAnchor).
    struct Tags: Equatable {
        /// The anchor of the row it is found through, if any.
        var anchor: String?
        /// Its index among that row's nodes the query inside the row returns;
        /// nil when it is that row itself.
        var index: Int?
        /// Whether it is found by position inside an enclosing row, past an
        /// unanchored row nested in it (a carousel cell in a table row):
        /// that inner list reuses its cells too, so the place can change.
        var nested = false
        /// Whether the anchoring row's list exposes every row (a
        /// UITableView), so the anchor, unique in the snapshot, is unique.
        var anchorListExposesEveryRow = false
        /// Whether the innermost row's list exposes every row.
        var listExposesEveryRow = false
    }

    /// The tags of a match in a row. `ownAnchor`: the match is a row with an
    /// anchor of its own. `enclosing`: the innermost enclosing row with an
    /// anchor, its list's flag, and whether it holds rows of its own;
    /// `index`: the match's index in it. A place counted in a row that holds
    /// rows can change as their list loads cells, wherever the match sits.
    /// `innermostAnchored`: whether the innermost row around the match (the
    /// match itself, for a row) has an anchor of its own.
    static func tags(
        ownAnchor: String?,
        ownListExposesEveryRow: Bool,
        enclosing: (anchor: String, listExposesEveryRow: Bool, holdsRows: Bool)?,
        index: Int?,
        innermostAnchored: Bool,
        listExposesEveryRow: Bool
    ) -> Tags {
        if let ownAnchor {
            return Tags(
                anchor: ownAnchor, index: nil, nested: false,
                anchorListExposesEveryRow: ownListExposesEveryRow, listExposesEveryRow: ownListExposesEveryRow
            )
        }
        if let enclosing, let index {
            return Tags(
                anchor: enclosing.anchor, index: index, nested: !innermostAnchored || enclosing.holdsRows,
                anchorListExposesEveryRow: enclosing.listExposesEveryRow,
                listExposesEveryRow: listExposesEveryRow && enclosing.listExposesEveryRow
            )
        }
        return Tags(listExposesEveryRow: listExposesEveryRow)
    }

    /// How a match's live element is bound and checked.
    struct Plan: Equatable {
        /// Found through its row's anchor instead of by its place in a query.
        var throughAnchor = false
        /// Checked on every use to be at the frame it was found at.
        var checkFrame = false
        /// Checked once, on its first use, to be at the frame it was found
        /// at, and trusted from then on.
        var checkFrameOnce = false
        /// Checked once per command that its anchor still names one row.
        var checkAnchor = false
    }

    /// The plan for a match. `bound`: the usual query found a live element
    /// for it (it keeps none on purpose otherwise: a switch beside SwiftUI
    /// Toggle knobs, a getByLabel match). `uniqueInQuery`: that query returns
    /// no other node. The anchor replaces only a binding by place among
    /// others; one the usual query alone finds, in a list that shows every
    /// row, stands. `treeHasLazyList`: the tree holds a collection view
    /// somewhere, which can load a cell with the same anchor later: the
    /// query for the anchor's row looks at every cell of the app, so even a
    /// UITableView's anchor is then checked.
    ///
    /// Outside any row, a binding by place among others is frame-checked
    /// too, once: XCTest's live query need not list nodes in the snapshot's
    /// order. On a React Navigation screen it listed the bottom tab bar's
    /// buttons before the header's drawer toggle, which comes first in the
    /// tree, so `getByRole("button").first()` was bound to the first tab, and
    /// its tap touched that tab and reported success. On its first use, such
    /// a binding is checked and, if need be, bound again (`firstUse`); then
    /// it is followed wherever it moves (a field the keyboard pushes up is
    /// still read live), and only a touch planned on it checks that the live
    /// element still has the identity found.
    static func plan(bound: Bool, inRow: Bool, uniqueInQuery: Bool, tags: Tags, treeHasLazyList: Bool) -> Plan {
        guard bound else { return Plan() }
        guard inRow else { return Plan(checkFrameOnce: !uniqueInQuery) }
        if uniqueInQuery && tags.listExposesEveryRow { return Plan() }
        guard tags.anchor != nil else { return Plan(checkFrame: true) }
        return Plan(
            throughAnchor: true, checkFrame: tags.nested,
            checkAnchor: !tags.anchorListExposesEveryRow || treeHasLazyList
        )
    }

    /// What becomes of a binding by place among others outside any row on
    /// its first use.
    enum FirstUse: Equatable {
        /// It is the element found (or that element, moved since): keep it.
        case keep
        /// It is another element; the element found is the lookalike at this
        /// index: bind that instead.
        case rebind(Int)
        /// It is another element, and the one found cannot be told among its
        /// lookalikes: keep no live element.
        case drop
    }

    /// The first use of a binding by place among others outside any row,
    /// whose live element is read at `live` (nil: it could not be read). One
    /// still at the frame it was found at is kept. One elsewhere is either
    /// another element, listed at that place because the live query does not
    /// follow the tree's order, or the element found, moved since (a panel
    /// still sliding in, a field the keyboard pushed up). The element found
    /// is looked for at its frame among its lookalikes (`lookalikes`: the
    /// live frames of the elements with its type, label, identifier and
    /// placeholder, read only then, and whether every one was read), and
    /// bound if it is the one there. Failing that, the live element is kept
    /// only when it is the one element with the identity found
    /// (`liveIsFoundIdentity`, and no other lookalike), so it can only be the
    /// element found, moved; otherwise the element found cannot be told among
    /// its lookalikes, and the binding is dropped.
    static func firstUse(
        found: CGRect, live: CGRect?, liveIsFoundIdentity: Bool,
        lookalikes: () -> (frames: [CGRect?], complete: Bool)
    ) -> FirstUse {
        guard live != nil else { return .drop }
        if isFoundElement(found: found, live: live) { return .keep }
        let read = lookalikes()
        let atFound = read.frames.enumerated().filter { isFoundElement(found: found, live: $0.element) }
        if atFound.count == 1 { return .rebind(atFound[0].offset) }
        if atFound.isEmpty, read.complete, read.frames.count == 1, liveIsFoundIdentity { return .keep }
        return .drop
    }

    /// The lookalikes of an element found, from a query that returned
    /// `count` elements, of which at most `max` are read: `read(i)` reads
    /// the i-th one's frame and whether it has the identity found (nil: it
    /// could not be read). Their frames, their indices in the query, and
    /// whether every lookalike was read: not when the query returned more
    /// than `max`, or one could not be read (it could be the element found).
    static func readLookalikes(
        count: Int, max: Int, read: (Int) -> (frame: CGRect, isLookalike: Bool)?
    ) -> (frames: [CGRect?], indices: [Int], complete: Bool) {
        var frames: [CGRect?] = []
        var indices: [Int] = []
        var complete = count <= max
        for index in 0..<Swift.max(0, Swift.min(count, max)) {
            guard let element = read(index) else {
                complete = false
                continue
            }
            guard element.isLookalike else { continue }
            frames.append(element.frame)
            indices.append(index)
        }
        return (frames, indices, complete)
    }

    /// Whether a touch planned on a binding after its first use (`use`)
    /// must still find its live element at the frame it was found at, as a
    /// row's must: unless it is the only element with the identity found
    /// (`lookalikes`: how many have it, nil when not known). Its live query is
    /// evaluated again on every read, and an element mounted since with the
    /// same identity can take its place there; only its frame tells the two
    /// apart. One that is the only such element is followed wherever it
    /// moves.
    static func checksFrameAfterFirstUse(_ use: FirstUse, lookalikes: Int?) -> Bool {
        use != .drop && lookalikes != 1
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
