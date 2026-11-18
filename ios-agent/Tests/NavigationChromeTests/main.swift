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
    BarHost.markEmptyHosts(in: &tree)
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
            isEmptyBarHost: BarHost.isMarkedEmpty(node)
        ))
        for child in node["children"] as? [[String: Any]] ?? [] {
            visit(child, inTabBar: inTabBar || type == .tabBar)
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
            inTabBar: $0.inTabBar, inAlert: false, isEmptyBarHost: $0.isEmptyBarHost
        )
    }.map(\.label)
}

/// The labels of the nodes reported with `role` (the dump's `tapsmith-role`).
func reported(_ role: String, in tree: [String: Any]) -> [String] {
    walk(tree).filter {
        RoleMapping.resolveRole(
            for: $0.type, traits: $0.traits, inTabBar: $0.inTabBar, isEmptyBarHost: $0.isEmptyBarHost
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

print(failures == 0 ? "ALL OK" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
