// Unit tests for the roles of a navigation stack's and a TabView's system
// chrome (PILOT-1260), run on the host Mac without a simulator:
// `ios-agent/Tests/run-unit-tests.sh`. The trees are hierarchy dumps recorded
// from the native fixture app (`native-ios-test-app`) on an iPhone Duo and an
// iPhone 17 Pro simulator, both iOS 27.2 (`Tests/Fixtures`). The Duo lays the
// chrome out differently: its TabView has no tab bar (the items are buttons
// in iOS 27's bar host), it publishes a navigation title's header trait only
// some of the time, and its back button floats in the bar host with no label.
//
// A dump carries no traits, so every title here is read without the header
// trait, as the Duo often publishes it.

import XCTest

var failures = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want \(want)")
    }
}

let fixtures = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Tests/Fixtures"

/// A recorded tree after the passes the snapshot finder and the dumper run
/// over every snapshot.
func prepared(_ name: String) -> [String: Any] {
    var tree = HierarchyFixture.load("\(fixtures)/\(name)")
    BarHost.markHosts(in: &tree)
    RoleMapping.markNavigationTitles(in: &tree)
    return tree
}

/// One node of a tree as the match walk sees it.
struct Seen {
    let type: XCUIElement.ElementType
    let label: String
    let identifier: String
    let traits: UInt64
    let inTabBar: Bool
    let isEmptyBarHost: Bool
    let isTabBarHost: Bool
}

/// Every node of `tree` in pre-order, with the context the match walk
/// (SnapshotElementFinder.findMatches) and the dumper derive on the way down.
func walk(_ tree: [String: Any]) -> [Seen] {
    var seen: [Seen] = []
    func visit(_ node: [String: Any], inTabBar: Bool) {
        let type = CellFrames.elementType(of: node)
        seen.append(Seen(
            type: type,
            label: node["label"] as? String ?? "",
            identifier: node["identifier"] as? String ?? "",
            traits: node["traits"] as? UInt64 ?? 0,
            inTabBar: inTabBar,
            isEmptyBarHost: BarHost.isMarkedEmpty(node),
            isTabBarHost: BarHost.isMarkedTabBarHost(node)
        ))
        for child in node["children"] as? [[String: Any]] ?? [] {
            visit(child, inTabBar: inTabBar || BarHost.isTabBar(node))
        }
    }
    visit(tree, inTabBar: false)
    return seen
}

/// The labels of the nodes getByRole(`role`) matches in `tree`.
func matching(_ role: String, in tree: [String: Any]) -> [String] {
    walk(tree).filter {
        RoleMapping.matches(
            role: role, elementType: $0.type, traits: $0.traits, value: nil, hasNameFilter: false,
            inTabBar: $0.inTabBar, inAlert: false, isEmptyBarHost: $0.isEmptyBarHost,
            isTabBarHost: $0.isTabBarHost
        )
    }.map(\.label)
}

/// The labels of the nodes reported with `role` (the dump's `tapsmith-role`).
func reported(_ role: String, in tree: [String: Any]) -> [String] {
    walk(tree).filter {
        RoleMapping.resolveRole(
            for: $0.type, traits: $0.traits, inTabBar: $0.inTabBar, isEmptyBarHost: $0.isEmptyBarHost,
            isTabBarHost: $0.isTabBarHost
        ) == role
    }.map(\.label)
}

let duoTabs = prepared("iphone-duo-27.2/tabs.xml")
let duoToolbar = prepared("iphone-duo-27.2/toolbar.xml")
let duoHome = prepared("iphone-duo-27.2/home.xml")
let proTabs = prepared("iphone-17-pro-27.2/tabs.xml")

// ─── Navigation titles are headings ───

check("Duo: the TabView screen's title is a heading", matching("heading", in: duoTabs), ["Tabs"])
check("Duo: the TabView screen's title reports heading", reported("heading", in: duoTabs), ["Tabs"])
check("Duo: the toolbar screen's title is a heading", matching("heading", in: duoToolbar), ["Toolbar"])
check("Duo: the root screen's title is a heading", matching("heading", in: duoHome), ["Native Screens"])
check("17 Pro: the title is a heading", matching("heading", in: proTabs), ["Tabs"])
check("Duo: a tab's content text is still text", reported("text", in: duoTabs).contains("Feed tab content"), true)

func navigationBar(identifier: String, _ children: [[String: Any]]) -> [String: Any] {
    [
        "elementType": XCUIElement.ElementType.navigationBar.rawValue,
        "label": "", "identifier": identifier, "children": children,
    ]
}

func staticText(_ label: String) -> [String: Any] {
    ["elementType": XCUIElement.ElementType.staticText.rawValue, "label": label, "identifier": ""]
}

func titled(_ tree: [String: Any]) -> [String: Any] {
    var tree = tree
    RoleMapping.markNavigationTitles(in: &tree)
    return tree
}

check(
    "a text in a navigation bar that is not its title stays text",
    matching("heading", in: titled(navigationBar(identifier: "Inbox", [staticText("Inbox"), staticText("3 unread")]))),
    ["Inbox"]
)
check(
    "a navigation bar with no identifier has no title to mark",
    matching("heading", in: titled(navigationBar(identifier: "", [staticText("")]))),
    []
)
check(
    "a title's own traits are kept",
    {
        var text = staticText("Inbox")
        text["traits"] = UInt64(1 << 6)
        let tree = titled(navigationBar(identifier: "Inbox", [text]))
        return (tree["children"] as? [[String: Any]])?.first?["traits"] as? UInt64 ?? 0
    }(),
    UInt64(1 << 6 | 1 << 16)
)
check(
    "a matching text deeper in the bar is not its title",
    matching("heading", in: titled(navigationBar(identifier: "Inbox", [[
        "elementType": XCUIElement.ElementType.other.rawValue, "label": "", "identifier": "",
        "children": [staticText("Inbox")],
    ]]))),
    []
)

// ─── The iPhone Duo's TabView: its bar host is the tab bar ───

// The Duo has no tab bar: a TabView's items are buttons in iOS 27's bar host,
// which it lays out alone in a wrapper of its own size after the tab's content.
check("Duo: the TabView's items are tabs", matching("tab", in: duoTabs), ["Feed", "Search", "Profile"])
check("Duo: the TabView's items report tab", reported("tab", in: duoTabs), ["Feed", "Search", "Profile"])
check("Duo: the TabView's host is the tablist", matching("tablist", in: duoTabs), ["Toolbar"])
check("Duo: the TabView's host reports tablist", reported("tablist", in: duoTabs), ["Toolbar"])
check("Duo: the TabView's host is no toolbar", matching("toolbar", in: duoTabs), [])
check("Duo: the TabView screen reports no toolbar", reported("toolbar", in: duoTabs), [])
check("Duo: the stack's host is still empty", walk(duoTabs).filter(\.isEmptyBarHost).count, 1)
check("Duo: the back button is no tab", reported("button", in: duoTabs).contains(""), true)
check("Duo: a toolbar's host is still the toolbar", matching("toolbar", in: duoToolbar), ["Toolbar"])
check("Duo: a toolbar's items are no tabs", matching("tab", in: duoToolbar), [])
check("Duo: a toolbar is no tablist", matching("tablist", in: duoToolbar), [])
check("Duo: the root screen has no tab", matching("tab", in: duoHome), [])
check("Duo: the root screen has no tablist", matching("tablist", in: duoHome), [])
check("Duo: the root screen has no toolbar", matching("toolbar", in: duoHome), [])
/// `tree` with no button selected.
func unselected(_ tree: [String: Any]) -> [String: Any] {
    var tree = tree
    tree["selected"] = false
    tree["children"] = (tree["children"] as? [[String: Any]] ?? []).map(unselected)
    return tree
}

// Toolbar items in a host of the TabView's shape (none of them a selected
// tab) stay a toolbar's items.
var unselectedDuoTabs = unselected(HierarchyFixture.load("\(fixtures)/iphone-duo-27.2/tabs.xml"))
BarHost.markHosts(in: &unselectedDuoTabs)
check("Duo: a host of the TabView's shape with no selected button is no tablist",
      matching("tablist", in: unselectedDuoTabs), [])
check("Duo: a host of the TabView's shape with no selected button is a toolbar",
      matching("toolbar", in: unselectedDuoTabs), ["Toolbar"])
check("Duo: its buttons are no tabs", matching("tab", in: unselectedDuoTabs), [])

check("17 Pro: the tab bar's items are tabs", matching("tab", in: proTabs), ["Feed", "Search", "Profile"])
check("17 Pro: the tab bar is the tablist", matching("tablist", in: proTabs), ["Tab Bar"])
check("17 Pro: no tab-bar host", walk(proTabs).filter(\.isTabBarHost).count, 0)
check("17 Pro: the TabView screen has no toolbar", matching("toolbar", in: proTabs), [])

print(failures == 0 ? "ALL OK" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
