import XCTest

/// The host of a bar, which iOS 27 lays over every navigation container
/// (PILOT-1207): a `Toolbar` ("Toolbar"/"Toolbar") the size of the
/// container — a window's, or a sheet's of any height — laid over the
/// container's content as its last child. It is empty on a screen with no
/// toolbar, and otherwise holds the toolbar's items, laid out in it as
/// floating capsules.
///
/// One rule, read by everything that has to tell a host from a bar:
/// - `OcclusionAnalyzer.isBarHost`: a host's frame covers nothing; only the
///   items in it do (and `KeyboardDismissPlanner` treats it as plain).
/// - Locators (PILOT-1219): an empty host is not a toolbar a user can see,
///   so it has no role and `getByRole("toolbar")` doesn't match it
///   (`markEmptyHosts`, `RoleMapping`). A host holding items is the one
///   toolbar of its screen.
enum BarHost {
    /// Whether a node of `elementType` and `frame`, whose parent's frame is
    /// `container` and which is laid out after siblings with
    /// `earlierSiblings` frames, is the host of a bar rather than a bar.
    ///
    /// Only a bar type can be one; any other control still blocks. A host
    /// fills its whole container and is laid over the content before it
    /// there: an earlier sibling that fills the container too. A real bar is
    /// never laid over all of its container's content: one in a wrapper of
    /// its own size (a `UIViewRepresentable`, a React Native view around a
    /// custom tab bar) shares it with nothing, or with something smaller (a
    /// badge). Size alone can't tell them apart: a short sheet or an iPad
    /// popover gets a host too.
    static func isHost(
        elementType: XCUIElement.ElementType,
        frame: CGRect,
        container: CGRect,
        earlierSiblings: some Sequence<CGRect>
    ) -> Bool {
        guard OcclusionAnalyzer.barTypes.contains(elementType),
              container.width > 0, container.height > 0,
              frame.insetBy(dx: -1, dy: -1).contains(container) else { return false }
        return earlierSiblings.contains { OcclusionAnalyzer.framesMatch($0, container) }
    }

    /// Key under which `markEmptyHosts` marks a host that holds nothing.
    static let emptyHostKey = "tapsmithEmptyBarHost"

    /// Mark every host in a snapshot dictionary that holds nothing — no
    /// descendant but unlabelled generic views — with `emptyHostKey`.
    /// That is the host of a screen with no toolbar: nothing on screen.
    static func markEmptyHosts(in dict: inout [String: Any]) {
        guard var children = dict["children"] as? [[String: Any]], !children.isEmpty else { return }
        let container = CellFrames.frame(of: dict)
        for i in children.indices {
            let child = children[i]
            if isHost(
                elementType: CellFrames.elementType(of: child),
                frame: CellFrames.frame(of: child),
                container: container,
                earlierSiblings: children[..<i].lazy.map { CellFrames.frame(of: $0) }
            ), !holdsItems(child) {
                children[i][emptyHostKey] = true
            }
            markEmptyHosts(in: &children[i])
        }
        dict["children"] = children
    }

    /// Whether a descendant of `dict` is anything but an unlabelled generic
    /// view: a button, text, image, or a view with a label, identifier or
    /// value — an item a host holds.
    private static func holdsItems(_ dict: [String: Any]) -> Bool {
        for child in dict["children"] as? [[String: Any]] ?? [] {
            let plain = CellFrames.elementType(of: child) == .other
                && (child["label"] as? String ?? "").isEmpty
                && (child["identifier"] as? String ?? "").isEmpty
                && (child["value"] as? String ?? "").isEmpty
            if !plain || holdsItems(child) { return true }
        }
        return false
    }
}
