import XCTest

/// Where the contents of a table row with no loaded cell really are
/// (PILOT-800).
///
/// UIKit's `UITableView` exposes every row to accessibility, loaded or not —
/// that is how VoiceOver scrolls through a table. A row with no cell keeps
/// its real `.cell` frame (outside the table's visible area, where the row
/// would be), but every node inside it — its text, its accessory, its content
/// views — reports one shared placeholder frame at the table's origin, on
/// screen. Taken at face value, such a row reads as visible,
/// `scrollIntoView()` never scrolls to it, and a touch lands on whatever is at
/// the table's top-left.
///
/// A row only goes unloaded when it is outside what its scroll views show,
/// and then its content cannot be on screen either. So, inside a cell that
/// does not overlap the visible area of the scroll views around it, a node
/// that does not overlap the cell is a placeholder, and is placed at the cell
/// instead — off screen, on the side the row is on. Content of a cell that is
/// on screen is never moved, even when it lies outside the cell (a carousel
/// scrolled past the screen edge inside a row). A SwiftUI `List` is a
/// collection view and reports real frames, which the rule leaves alone.
enum CellFrames {
    /// What the walk knows about a node's surroundings.
    struct Context: Equatable {
        /// The screen area the scroll views around the node show.
        var viewport: CGRect
        /// The frame of the nearest cell around the node, when that cell is
        /// outside `viewport` (unloaded); nil otherwise.
        var offScreenCell: CGRect?

        init(viewport: CGRect, offScreenCell: CGRect? = nil) {
            self.viewport = viewport
            self.offScreenCell = offScreenCell
        }
    }

    static let scrollerTypes: Set<XCUIElement.ElementType> = [.scrollView, .table, .collectionView]

    /// The frame to report for a node whose snapshot frame is `frame`.
    /// Zero-size frames are left alone: they are invisible either way.
    static func effectiveFrame(of frame: CGRect, in context: Context) -> CGRect {
        guard let cell = context.offScreenCell, hasArea(frame), !overlaps(frame, cell) else { return frame }
        return cell
    }

    /// The context for the children of a node of `type` whose effective frame
    /// is `frame`, inside `context`.
    static func childContext(of type: XCUIElement.ElementType, frame: CGRect, in context: Context) -> Context {
        var child = context
        if scrollerTypes.contains(type) {
            child.viewport = context.viewport.intersection(frame)
        }
        if type == .cell {
            child.offScreenCell = hasArea(frame) && !overlaps(frame, child.viewport) ? frame : nil
        }
        return child
    }

    /// Rewrite, in a snapshot dictionary (string keys, as the agent converts
    /// it, rooted at the application), the frame of every placeholder node
    /// to its cell's. Run it after anything that pairs dictionary nodes with
    /// `XCUIElementSnapshot` nodes by frame
    /// (`SnapshotElementFinder.annotateTraits`).
    static func placeDetachedNodes(in dict: inout [String: Any]) {
        let root = frame(of: dict)
        place(&dict, in: Context(viewport: hasArea(root) ? root : .infinite))
    }

    /// Returns whether anything in `dict` changed, so unchanged subtrees are
    /// not written back (each write copies the dictionary).
    @discardableResult
    private static func place(_ dict: inout [String: Any], in context: Context) -> Bool {
        let raw = frame(of: dict)
        let effective = effectiveFrame(of: raw, in: context)
        var changed = false
        if effective != raw {
            setFrame(effective, of: &dict)
            changed = true
        }
        guard var children = dict["children"] as? [[String: Any]] else { return changed }
        let inner = childContext(of: elementType(of: dict), frame: effective, in: context)
        var childChanged = false
        for i in children.indices where place(&children[i], in: inner) { childChanged = true }
        if childChanged { dict["children"] = children }
        return changed || childChanged
    }

    // MARK: - Geometry

    private static func hasArea(_ r: CGRect) -> Bool {
        !r.isNull && r.width > 0 && r.height > 0
    }

    /// Whether the two share some area: rects that only touch along an edge
    /// do not (a row scrolled to end exactly at its table's top is off it).
    private static func overlaps(_ a: CGRect, _ b: CGRect) -> Bool {
        hasArea(a.intersection(b))
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
