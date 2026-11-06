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
/// match in a row that holds something no other row holds (its *anchor*: a
/// static text, an identifier, or a text field's placeholder, the first in
/// tree order) is found again as: the cell containing it, then, inside it,
/// the node with the match's type, label and identifier, at its index among
/// the cell's nodes that have them. That follows the row wherever it
/// scrolls, and whichever cell shows it.
///
/// A UITableView exposes every row, loaded or not, so an anchor unique in
/// its snapshot is unique. A collection view (a SwiftUI List or Form)
/// exposes only loaded cells, so another cell with the same anchor could
/// load later: there the anchor is checked to still name one cell, once in
/// each command that uses the match.
///
/// The anchor replaces only a binding by place among others, and where the
/// usual query keeps no live element on purpose there still is none
/// (`RowBinding.plan`). A row with no anchor (identical to another in all of
/// these, or holding none) is found as before, with `RowBinding`'s check.
enum RowAnchor {
    /// What tells a row apart, as a key: `kind`, then the value.
    enum Kind: String {
        case text = "t"
        case identifier = "i"
        case placeholder = "p"
    }

    static func key(_ kind: Kind, _ value: String) -> String { "\(kind.rawValue)\u{1}\(value)" }

    /// The anchor keys a node offers, in order of preference: a static
    /// text's label, an identifier, a placeholder. Empty values offer none.
    static func keys(of node: [String: Any]) -> [String] {
        var keys: [String] = []
        if elementType(of: node) == .staticText, let label = node["label"] as? String, !label.isEmpty {
            keys.append(key(.text, label))
        }
        if let identifier = node["identifier"] as? String, !identifier.isEmpty {
            keys.append(key(.identifier, identifier))
        }
        if let placeholder = node["placeholderValue"] as? String, !placeholder.isEmpty {
            keys.append(key(.placeholder, placeholder))
        }
        return keys
    }

    /// How many cells hold each anchor key (`keys(of:)`), each cell counted
    /// once per key (a cell nested in another counts for both).
    static func cellCounts(in dict: [String: Any]) -> [String: Int] {
        var counts: [String: Int] = [:]
        countCells(dict, into: &counts)
        return counts
    }

    /// The anchor of `cell`: the first key of its descendants, in tree
    /// order, that no other cell holds (`counts`, from `cellCounts`). The
    /// cell's own identifier is not one: a live `containing` query looks at
    /// descendants only.
    static func anchor(ofCell cell: [String: Any], counts: [String: Int]) -> String? {
        var found: String?
        walkDescendants(cell) { node in
            guard found == nil else { return }
            found = keys(of: node).first { counts[$0] == 1 }
        }
        return found
    }

    /// The predicate a live query finds the anchored cell's anchor node by;
    /// nil for a malformed key.
    static func predicate(forAnchor anchor: String) -> NSPredicate? {
        let parts = anchor.split(separator: "\u{1}", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, let kind = Kind(rawValue: String(parts[0])) else { return nil }
        let value = String(parts[1])
        switch kind {
        case .text:
            return NSPredicate(
                format: "elementType == %@ AND label == %@",
                NSNumber(value: XCUIElement.ElementType.staticText.rawValue), value
            )
        case .identifier:
            return NSPredicate(format: "identifier == %@", value)
        case .placeholder:
            return NSPredicate(format: "placeholderValue == %@", value)
        }
    }

    /// The nodes of one anchored cell seen so far in tree order, to number a
    /// match among the cell's nodes that the query finding it inside the cell
    /// returns (`index`).
    final class Scope {
        let anchor: String
        /// Whether the cell's list exposes every row (a UITableView).
        let listExposesEveryRow: Bool
        /// Whether the cell holds rows of its own (a carousel): their list
        /// loads and reuses cells, so a place counted past them can change.
        let holdsRows: Bool
        private var byTypeLabel: [String: Int] = [:]
        private var byTypeLabelId: [String: Int] = [:]
        private var byLabel: [String: Int] = [:]
        private var byLabelId: [String: Int] = [:]

        init(anchor: String, listExposesEveryRow: Bool, holdsRows: Bool = false) {
            self.anchor = anchor
            self.listExposesEveryRow = listExposesEveryRow
            self.holdsRows = holdsRows
        }

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
            var held = Set<String>()
            walkDescendants(dict) { node in held.formUnion(keys(of: node)) }
            for key in held { counts[key, default: 0] += 1 }
        }
        for child in dict["children"] as? [[String: Any]] ?? [] { countCells(child, into: &counts) }
    }

    /// Pre-order over `dict` and its descendants.
    static func walk(_ dict: [String: Any], _ visit: ([String: Any]) -> Void) {
        visit(dict)
        for child in dict["children"] as? [[String: Any]] ?? [] { walk(child, visit) }
    }

    /// How many nodes of the tree carry each identifier: an upper bound on
    /// what a live query narrowed by that identifier returns, whatever else
    /// the selector filtered on (PILOT-952).
    static func identifierCounts(in dict: [String: Any]) -> [String: Int] {
        var counts: [String: Int] = [:]
        walk(dict) { node in
            if let identifier = node["identifier"] as? String, !identifier.isEmpty {
                counts[identifier, default: 0] += 1
            }
        }
        return counts
    }

    /// Whether the tree holds a collection view, which exposes only the
    /// cells it has loaded.
    static func containsLazyList(_ dict: [String: Any]) -> Bool {
        var found = false
        walk(dict) { node in
            if !found, elementType(of: node) == .collectionView { found = true }
        }
        return found
    }

    /// Whether `cell` holds another cell among its descendants.
    static func holdsRows(_ cell: [String: Any]) -> Bool {
        var found = false
        walkDescendants(cell) { node in
            if !found, elementType(of: node) == .cell { found = true }
        }
        return found
    }

    /// Pre-order over `dict`'s descendants, not `dict` itself.
    static func walkDescendants(_ dict: [String: Any], _ visit: ([String: Any]) -> Void) {
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
