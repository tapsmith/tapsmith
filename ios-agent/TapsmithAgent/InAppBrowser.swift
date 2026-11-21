import XCTest

/// An SFSafariViewController's content in the app's tree (PILOT-1384).
///
/// An in-app browser (`expo-web-browser`'s `openBrowserAsync`, a plain
/// `SFSafariViewController`) is drawn by another process, SafariViewService,
/// and shown in the app through a remote view. On iOS 26 and 27,
/// `app.snapshot()` stops at that remote view: while the browser is up the
/// app's whole tree is a stack of empty `Other` nodes — the app's own screen
/// is left out too, as the browser is modal — so no locator matched its Done
/// button, and the hierarchy showed nothing. iOS 18's snapshot still descends
/// into it.
///
/// XCTest's element queries do cross the remote view (`app.buttons["Done"]`
/// exists), and a snapshot of an element found by one holds everything under
/// it. So when the app's tree is blank and SafariViewService is in the
/// foreground, the browser's root is found through a query and its snapshot
/// attached to the app's window: locators, the occlusion check, the
/// hierarchy dump and the MCP snapshot then see the browser as it is drawn,
/// over the app. Its elements are the app's to XCTest too (the query that
/// found them runs from the app), so they are touched like any other.
///
/// The browser's root is the one node SafariViewService names
/// `BrowserView?IsPageLoaded=…&WebViewProcessID=…`, so it is looked up by that
/// prefix.
enum InAppBrowser {
    static let serviceBundleId = "com.apple.SafariViewService"
    /// The start of the identifier of the browser's root node.
    static let rootIdentifierPrefix = "BrowserView"
    /// Set on the root of a snapshot dictionary that has a browser's content
    /// attached (`InAppBrowser.attach`). XCTest's live queries from the app
    /// still return the app's covered screen, which the snapshot leaves out,
    /// so a match in such a tree is found again by a query from the
    /// browser's root, where the snapshot's indices hold.
    static let attachedKey = "tapsmithInAppBrowser"

    /// Whether a tree holds nothing to match or show: below the root, only
    /// windows and plain views, none with a label, an identifier or a value.
    /// An app showing an in-app browser on iOS 26+ reads like this; an app's
    /// own screen never does, so a real screen never pays for the query.
    static func isBlank<Node>(
        _ root: Node,
        children: (Node) -> [Node],
        elementType: (Node) -> XCUIElement.ElementType,
        texts: (Node) -> [String]
    ) -> Bool {
        var stack = children(root)
        while let node = stack.popLast() {
            let type = elementType(node)
            guard type == .window || type == .other else { return false }
            if texts(node).contains(where: { !$0.isEmpty }) { return false }
            stack.append(contentsOf: children(node))
        }
        return true
    }

    /// Whether a snapshot dictionary (string keys, as the agent converts
    /// it) is blank (`isBlank`).
    static func isBlank(_ dict: [String: Any]) -> Bool {
        isBlank(
            dict,
            children: { $0["children"] as? [[String: Any]] ?? [] },
            elementType: { node in
                let raw = (node["elementType"] as? UInt) ?? (node["elementType"] as? Int).map(UInt.init) ?? 0
                return XCUIElement.ElementType(rawValue: raw) ?? .other
            },
            texts: { [$0["label"] as? String ?? "", $0["identifier"] as? String ?? "", $0["value"] as? String ?? ""] }
        )
    }

    /// Whether to look for an in-app browser's content: the app's tree is
    /// blank, SafariViewService is in the foreground, and the query
    /// (`lookCost` at most) can finish before `deadline`, when there is one.
    static func shouldLook(
        blank: Bool,
        serviceInForeground: Bool,
        now: Date,
        deadline: Date?,
        lookCost: TimeInterval
    ) -> Bool {
        guard blank, serviceInForeground else { return false }
        guard let deadline else { return true }
        return now.addingTimeInterval(lookCost) <= deadline
    }
}
