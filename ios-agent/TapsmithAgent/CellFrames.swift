import XCTest

/// Where the contents of a table row with no loaded cell really are
/// (PILOT-800).
///
/// UIKit's `UITableView` exposes every row to accessibility, loaded or not —
/// that is how VoiceOver scrolls through a table. A row with no cell keeps
/// its real `.cell` frame (off screen, where the row would be), but every
/// node inside it — its text, its accessory, its content views — reports
/// one shared placeholder frame at the table's origin, on screen. Taken at
/// face value, such a row reads as visible, `scrollIntoView()` never
/// scrolls to it, and a touch lands on whatever is at the table's top-left.
///
/// The cell's frame is the witness: a node with a real frame lies in or on
/// its cell, so one that does not even touch its cell is a placeholder, and
/// is placed at its cell instead — off screen, on the side the row is on.
/// (A SwiftUI `List` is a collection view and reports real frames; the rule
/// leaves those alone because they lie in their cells.)
enum CellFrames {
    /// Slack, in points, before a node counts as clear of its cell: content
    /// on the cell's edge (a separator) or just over it still belongs to it.
    static let slack: CGFloat = 1

    /// The frame to report for a node whose snapshot frame is `frame`, inside
    /// a cell whose (effective) frame is `cellFrame` — nil outside any cell.
    /// Zero-size frames are left alone: they are invisible either way, and a
    /// zero-size cell says nothing about where its content is.
    static func effectiveFrame(of frame: CGRect, inCell cellFrame: CGRect?) -> CGRect {
        guard let cellFrame,
              frame.width > 0, frame.height > 0,
              cellFrame.width > 0, cellFrame.height > 0,
              !frame.intersects(cellFrame.insetBy(dx: -slack, dy: -slack)) else { return frame }
        return cellFrame
    }

    /// Rewrite, in a snapshot dictionary (string keys, as the agent converts
    /// it), the frame of every placeholder node to its cell's. Run it after
    /// anything that pairs dictionary nodes with `XCUIElementSnapshot` nodes
    /// by frame (`SnapshotElementFinder.annotateTraits`).
    static func placeDetachedNodes(in dict: inout [String: Any]) {
        place(&dict, inCell: nil)
    }

    /// Returns whether anything in `dict` changed, so unchanged subtrees are
    /// not written back (each write copies the dictionary).
    @discardableResult
    private static func place(_ dict: inout [String: Any], inCell cellFrame: CGRect?) -> Bool {
        let raw = frame(of: dict)
        let effective = effectiveFrame(of: raw, inCell: cellFrame)
        var changed = false
        if effective != raw {
            setFrame(effective, of: &dict)
            changed = true
        }
        guard var children = dict["children"] as? [[String: Any]] else { return changed }
        let around = elementType(of: dict) == .cell ? effective : cellFrame
        var childChanged = false
        for i in children.indices where place(&children[i], inCell: around) { childChanged = true }
        if childChanged { dict["children"] = children }
        return changed || childChanged
    }

    // MARK: - Dictionary access

    private static func elementType(of dict: [String: Any]) -> XCUIElement.ElementType {
        let raw: UInt?
        switch dict["elementType"] {
        case let v as UInt: raw = v
        case let v as Int: raw = v >= 0 ? UInt(v) : nil
        case let v as NSNumber: raw = UInt(v.uint64Value)
        default: raw = nil
        }
        return raw.flatMap { XCUIElement.ElementType(rawValue: $0) } ?? .other
    }

    /// Same keys as `SnapshotElementFinder.parseFrame`.
    private static func frame(of dict: [String: Any]) -> CGRect {
        guard let f = dict["frame"] as? [String: Any] else { return .zero }
        let x = (f["X"] as? Double) ?? (f["x"] as? Double) ?? 0
        let y = (f["Y"] as? Double) ?? (f["y"] as? Double) ?? 0
        let w = (f["Width"] as? Double) ?? (f["width"] as? Double) ?? 0
        let h = (f["Height"] as? Double) ?? (f["height"] as? Double) ?? 0
        return CGRect(x: x, y: y, width: w, height: h)
    }

    private static func setFrame(_ rect: CGRect, of dict: inout [String: Any]) {
        dict["frame"] = [
            "X": Double(rect.minX), "Y": Double(rect.minY),
            "Width": Double(rect.width), "Height": Double(rect.height),
        ]
    }
}
