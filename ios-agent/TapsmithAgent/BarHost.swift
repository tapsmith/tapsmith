import XCTest

/// The host of a bar, which iOS 27 lays over every navigation container
/// (PILOT-1207): a `Toolbar` ("Toolbar"/"Toolbar") the size of the
/// container — a window's, or a sheet's of any height — laid out beside the
/// container's content. It is empty on a screen with no toolbar, and
/// otherwise holds the toolbar's items, laid out in it as floating capsules.
/// On an iPhone 17 Pro it is the container's last child; the iPhone Duo
/// (PILOT-1251) lays it out first, and in a TabView alone in a wrapper of its
/// own size after the tab's content.
///
/// One rule, read by everything that has to tell a host from a bar:
/// - `OcclusionAnalyzer.isBarHost`: a host's frame covers nothing; only the
///   items in it do (and `KeyboardDismissPlanner` treats it as plain).
/// - Locators: an empty host — holding nothing, or only the Duo's floating
///   back button — is no toolbar a user can see, so no locator matches it,
///   though what it holds still matches (`markHosts`; PILOT-1219 for
///   roles, PILOT-1251 for the rest). A host holding items is the one
///   toolbar of its screen.
enum BarHost {
    /// One level of a node's ancestry: the frame of the container it sits in,
    /// and the frames of its siblings there (not its own).
    typealias Level = (container: CGRect, siblings: [CGRect])

    /// Whether a node of `elementType` and `frame` is the host of a bar rather
    /// than a bar. `levels` is its ancestry, innermost first: its parent's
    /// frame and its siblings', then its parent's parent's and the parent's
    /// siblings', and so on. Only the levels the rule needs are read.
    ///
    /// Only a bar type can be one; any other control still blocks. A host
    /// fills its whole container and is laid out beside content that fills
    /// it too: a sibling, before or after it (iOS lays it out last on most
    /// devices, first on the iPhone Duo). A node alone in a wrapper of its
    /// own size is judged as that wrapper, one level up (the Duo's TabView
    /// host). A real bar is never laid out beside all of its container's
    /// content: one in a wrapper of its own size (a `UIViewRepresentable`, a
    /// React Native view around a custom tab bar) shares it with nothing, or
    /// with something smaller (a badge), and that wrapper does not fill the
    /// screen it sits in. Size alone can't tell them apart: a short sheet or
    /// an iPad popover gets a host too.
    static func isHost(
        elementType: XCUIElement.ElementType,
        frame: CGRect,
        levels: some Sequence<Level>
    ) -> Bool {
        wrappers(elementType: elementType, frame: frame, levels: levels) != nil
    }

    /// How many wrappers of its own size a host sits alone in (0: it is laid
    /// out directly beside the content), or nil when the node is no host —
    /// `isHost`'s rule. On the iPhone Duo a TabView's host is the one in a
    /// wrapper (`markHosts`).
    private static func wrappers(
        elementType: XCUIElement.ElementType,
        frame: CGRect,
        levels: some Sequence<Level>
    ) -> Int? {
        guard OcclusionAnalyzer.barTypes.contains(elementType) else { return nil }
        var frame = frame
        var wrappers = 0
        for level in levels {
            let container = level.container
            guard container.width > 0, container.height > 0,
                  frame.insetBy(dx: -1, dy: -1).contains(container) else { return nil }
            if level.siblings.contains(where: { OcclusionAnalyzer.framesMatch($0, container) }) { return wrappers }
            guard level.siblings.isEmpty else { return nil }
            frame = container
            wrappers += 1
        }
        return nil
    }

    /// What a live query reads of a host: iOS 27 labels and identifies every
    /// one "Toolbar".
    private static let hostAttributes: NSDictionary = [
        "elementType": XCUIElement.ElementType.toolbar.rawValue,
        "label": "Toolbar",
        "identifier": "Toolbar",
        "title": "",
        "value": "",
        "placeholderValue": "",
    ]

    /// Whether a live query with `predicate` can return a host — so what it
    /// returns could be an empty one, which no locator matches.
    static func mayMatchHost(_ predicate: NSPredicate) -> Bool {
        predicate.evaluate(with: hostAttributes)
    }

    /// Key under which `markHosts` marks a host that holds nothing.
    static let emptyHostKey = "tapsmithEmptyBarHost"

    /// Key under which `markHosts` marks the iPhone Duo's TabView host.
    static let tabBarHostKey = "tapsmithTabBarHost"

    /// Mark the hosts in a snapshot dictionary that are no toolbar:
    /// - one that holds no toolbar items — nothing but unlabelled generic
    ///   views and the system back button — with `emptyHostKey`. That is the
    ///   host of a screen with no toolbar: no locator matches it (what it
    ///   holds still matches as usual).
    /// - the iPhone Duo's TabView host with `tabBarHostKey`: the Duo has no
    ///   tab bar, and lays a TabView's items out as buttons in a host alone in
    ///   a wrapper of its own size, one of them selected (PILOT-1260). That
    ///   host is the tab bar ("tablist") and its buttons are tabs, as a
    ///   `.tabBar` and its buttons are on other devices (`isTabBar`). A
    ///   toolbar's items are never laid out that way: they go in the host of
    ///   the navigation stack, laid out beside its content.
    static func markHosts(in dict: inout [String: Any]) {
        var ancestry: [Place] = []
        markHosts(in: &dict, ancestry: &ancestry)
    }

    /// Where a node sits: its container's frame, its siblings' frames and its
    /// own, and its index among them. The levels of `isHost` are built from
    /// these only for a bar.
    private typealias Place = (container: CGRect, frames: [CGRect], index: Int)

    private static func level(_ place: Place) -> Level {
        var siblings = place.frames
        siblings.remove(at: place.index)
        return (place.container, siblings)
    }

    /// `ancestry`: where each of `dict`'s ancestors sits, outermost first.
    private static func markHosts(in dict: inout [String: Any], ancestry: inout [Place]) {
        guard var children = dict["children"] as? [[String: Any]], !children.isEmpty else { return }
        let container = CellFrames.frame(of: dict)
        let frames = children.map { CellFrames.frame(of: $0) }
        for i in children.indices {
            let place: Place = (container, frames, i)
            let type = CellFrames.elementType(of: children[i])
            if OcclusionAnalyzer.barTypes.contains(type),
               let wrappers = wrappers(elementType: type, frame: frames[i],
                                       levels: ([place] + ancestry.reversed()).lazy.map(level)) {
                if !holdsItems(children[i]) {
                    children[i][emptyHostKey] = true
                } else if wrappers > 0, holdsSelectedButton(children[i]) {
                    children[i][tabBarHostKey] = true
                }
            }
            ancestry.append(place)
            markHosts(in: &children[i], ancestry: &ancestry)
            ancestry.removeLast()
        }
        dict["children"] = children
    }

    /// Whether `dict` is the system back button (`BackButton`, in UIKit and
    /// SwiftUI stacks alike).
    private static func isSystemBackButton(_ dict: [String: Any]) -> Bool {
        CellFrames.elementType(of: dict) == .button && dict["identifier"] as? String == "BackButton"
    }

    /// Whether `markHosts` marked `dict` as an empty host.
    static func isMarkedEmpty(_ dict: [String: Any]) -> Bool {
        dict[emptyHostKey] as? Bool == true
    }

    /// Whether `markHosts` marked `dict` as the iPhone Duo's TabView host.
    static func isMarkedTabBarHost(_ dict: [String: Any]) -> Bool {
        dict[tabBarHostKey] as? Bool == true
    }

    /// Whether `dict` is a tab bar, which makes the buttons in it tabs
    /// (`RoleMapping.isTabBarItem`): a `.tabBar`, or the iPhone Duo's TabView
    /// host.
    static func isTabBar(_ dict: [String: Any]) -> Bool {
        CellFrames.elementType(of: dict) == .tabBar || isMarkedTabBarHost(dict)
    }

    /// Whether a descendant of `dict` is a selected button: a TabView's
    /// current tab.
    private static func holdsSelectedButton(_ dict: [String: Any]) -> Bool {
        (dict["children"] as? [[String: Any]] ?? []).contains {
            (CellFrames.elementType(of: $0) == .button && $0["selected"] as? Bool == true) || holdsSelectedButton($0)
        }
    }

    /// Whether `dict` or a descendant is marked as an empty host.
    static func containsEmptyHost(_ dict: [String: Any]) -> Bool {
        if isMarkedEmpty(dict) { return true }
        return (dict["children"] as? [[String: Any]] ?? []).contains { containsEmptyHost($0) }
    }

    /// Whether a descendant of `dict` is anything but an unlabelled generic
    /// view or the system back button: a button, text, image, or a view with
    /// a label, identifier or value — an item a host holds. The iPhone Duo
    /// floats the back button of every pushed screen in the host
    /// (PILOT-1251); that is navigation, not a toolbar.
    private static func holdsItems(_ dict: [String: Any]) -> Bool {
        for child in dict["children"] as? [[String: Any]] ?? [] {
            if isSystemBackButton(child) { continue }
            let plain = CellFrames.elementType(of: child) == .other
                && (child["label"] as? String ?? "").isEmpty
                && (child["identifier"] as? String ?? "").isEmpty
                && (child["value"] as? String ?? "").isEmpty
            if !plain || holdsItems(child) { return true }
        }
        return false
    }
}
