import XCTest

/// Finding a table or collection row's content again by the row's own text
/// (PILOT-952).
///
/// The agent finds a match again as a live `XCUIElement` through a query. A
/// query by position (the n-th "More Info" button) is wrong once a
/// `UITableView` has scrolled: the live query no longer returns rows in the
/// snapshot's order as the table reuses its cells, so the n-th is another
/// row's. A row is told apart by what it shows, which is also how a test
/// picks it (`getByRole("listitem").filter({ hasText: "Row 40" })`). So a
/// match in a row that shows a static text no other row shows (its
/// *anchor*) is found again as: the cell containing that text, then, inside
/// it, the node with the match's type, label and identifier, at its index
/// among the cell's nodes that have them. That follows the row wherever it
/// scrolls, and whichever cell shows it.
///
/// A row with no such text (its texts are shared with other rows, or it
/// shows none) gets no anchor, and its matches are found as before, with
/// `RowBinding`'s check.
enum RowAnchor {
    /// How many cells hold each static text label, each cell counted once
    /// per label (a cell nested in another counts for both). Empty labels are
    /// left out.
    static func cellCounts(in dict: [String: Any]) -> [String: Int] {
        var counts: [String: Int] = [:]
        countCells(dict, into: &counts)
        return counts
    }

    /// The anchor of `cell`: the first static text label in its subtree, in
    /// tree order, that no other cell holds (`counts`, from `cellCounts`).
    static func anchor(ofCell cell: [String: Any], counts: [String: Int]) -> String? {
        var found: String?
        walk(cell) { node in
            guard found == nil, elementType(of: node) == .staticText else { return }
            let label = node["label"] as? String ?? ""
            if !label.isEmpty, counts[label] == 1 { found = label }
        }
        return found
    }

    /// The nodes of one anchored cell seen so far in tree order, to number a
    /// match among the cell's nodes that the query finding it inside the cell
    /// returns (`index`).
    final class Scope {
        let anchor: String
        private var byTypeLabel: [String: Int] = [:]
        private var byTypeLabelId: [String: Int] = [:]
        private var byLabel: [String: Int] = [:]
        private var byLabelId: [String: Int] = [:]

        init(anchor: String) { self.anchor = anchor }

        /// Record a node of the cell (not the cell itself), in tree order,
        /// and return its index among the earlier ones that a query inside
        /// the cell for it returns: by its type when `typed` (else any
        /// type), its label, and its identifier when it has one.
        @discardableResult
        func visit(typeRaw: UInt, label: String, identifier: String, typed: Bool) -> Int {
            let tl = "\(typeRaw)\u{1}\(label)"
            let tli = "\(tl)\u{1}\(identifier)"
            let lid = "\(label)\u{1}\(identifier)"
            let index: Int
            switch (typed, identifier.isEmpty) {
            case (true, true): index = byTypeLabel[tl, default: 0]
            case (true, false): index = byTypeLabelId[tli, default: 0]
            case (false, true): index = byLabel[label, default: 0]
            case (false, false): index = byLabelId[lid, default: 0]
            }
            byTypeLabel[tl, default: 0] += 1
            byTypeLabelId[tli, default: 0] += 1
            byLabel[label, default: 0] += 1
            byLabelId[lid, default: 0] += 1
            return index
        }

        /// Record every node of `dict`'s subtree, `dict` included: nodes the
        /// match walk skips that a query inside the cell still returns.
        func visitSubtree(_ dict: [String: Any]) {
            RowAnchor.walk(dict) { node in
                visit(
                    typeRaw: RowAnchor.typeRaw(of: node),
                    label: node["label"] as? String ?? "",
                    identifier: node["identifier"] as? String ?? "",
                    typed: true
                )
            }
        }
    }

    /// Whether a query for a node of this type is scoped to the type: a
    /// generic `.other` node is looked for among every type.
    static func isTyped(_ typeRaw: UInt) -> Bool {
        guard let type = XCUIElement.ElementType(rawValue: typeRaw) else { return false }
        return type != .other && type != .any
    }

    // MARK: - Tree access

    private static func countCells(_ dict: [String: Any], into counts: inout [String: Int]) {
        if elementType(of: dict) == .cell {
            var labels = Set<String>()
            walk(dict) { node in
                guard elementType(of: node) == .staticText else { return }
                let label = node["label"] as? String ?? ""
                if !label.isEmpty { labels.insert(label) }
            }
            for label in labels { counts[label, default: 0] += 1 }
        }
        for child in dict["children"] as? [[String: Any]] ?? [] { countCells(child, into: &counts) }
    }

    /// Pre-order over `dict` and its descendants.
    static func walk(_ dict: [String: Any], _ visit: ([String: Any]) -> Void) {
        visit(dict)
        for child in dict["children"] as? [[String: Any]] ?? [] { walk(child, visit) }
    }

    static func typeRaw(of dict: [String: Any]) -> UInt {
        switch dict["elementType"] {
        case let v as UInt: return v
        case let v as Int: return v >= 0 ? UInt(v) : 0
        case let v as NSNumber: return UInt(v.uint64Value)
        default: return 0
        }
    }

    private static func elementType(of dict: [String: Any]) -> XCUIElement.ElementType {
        XCUIElement.ElementType(rawValue: typeRaw(of: dict)) ?? .other
    }
}
