// Unit tests for the roles of a navigation stack's and a TabView's system
// chrome (PILOT-1260), run on the host Mac without a simulator:
// `ios-agent/Tests/run-unit-tests.sh`. The trees are hierarchy dumps recorded
// from the native fixture app (`native-ios-test-app`) on an iPhone Duo and an
// iPhone 17 Pro simulator, both iOS 27.2 (`Tests/Fixtures`). The Duo lays the
// chrome out differently: its TabView has no tab bar (the items are buttons
// in iOS 27's bar host), it publishes a navigation title's header trait only
// some of the time, and its back button floats in the bar host with no label
// (other devices label it with the previous screen's title).
//
// The iPad dumps (PILOT-1282, iPad Pro 11-inch, iOS 26.5 and 27.2) are of the fixture app's
// TabView and the test app's expo-router NativeTabs (a UITabBarController):
// iPadOS 26+ floats the tab bar at the top, with no tab bar node either.
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
    let title: String
    let identifier: String
    let traits: UInt64
    let inTabBar: Bool
    let isEmptyBarHost: Bool
    let isTabBarHost: Bool
    let selected: Bool
    let frame: CGRect
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
            title: node["title"] as? String ?? "",
            identifier: node["identifier"] as? String ?? "",
            traits: node["traits"] as? UInt64 ?? 0,
            inTabBar: inTabBar,
            isEmptyBarHost: BarHost.isMarkedEmpty(node),
            isTabBarHost: BarHost.isMarkedTabBarHost(node),
            selected: node["selected"] as? Bool ?? false,
            frame: CellFrames.frame(of: node)
        ))
        for child in node["children"] as? [[String: Any]] ?? [] {
            visit(child, inTabBar: inTabBar || BarHost.holdsTab(node, child))
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

/// The identifiers of the nodes getByRole(`role`, { name, exact }) matches in `tree`.
func named(_ role: String, _ name: String, exact: Bool = false, in tree: [String: Any]) -> [String] {
    walk(tree).filter {
        RoleMapping.matches(
            role: role, elementType: $0.type, traits: $0.traits, value: nil, hasNameFilter: true,
            inTabBar: $0.inTabBar, inAlert: false, isEmptyBarHost: $0.isEmptyBarHost,
            isTabBarHost: $0.isTabBarHost
        ) && RoleName.matches(
            elementType: $0.type, label: $0.label, title: $0.title, placeholder: "", identifier: $0.identifier,
            name: name, exact: exact
        )
    }.map(\.identifier)
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

// ─── The iPad's floating tab bar ───

// iPadOS 26+ floats a tab bar at the top with no tab bar node: a group under
// the navigation bar holds one button per tab, and each button holds a
// duplicate of itself (same label, frame and selected state). That group is
// the tablist and its buttons are tabs, for a SwiftUI TabView and a
// UITabBarController (expo-router NativeTabs) alike.

/// The nodes getByRole(`role`) matches in `tree`, after the SDK folds
/// same-target duplicates (same text and bounds) into one match
/// (`collapseSameTargetDuplicates`).
func collapsed(_ role: String, selected: Bool? = nil, in tree: [String: Any]) -> [String] {
    var seen = Set<String>()
    return walk(tree).filter {
        RoleMapping.matches(
            role: role, elementType: $0.type, traits: $0.traits, value: nil, hasNameFilter: false,
            inTabBar: $0.inTabBar, inAlert: false, isEmptyBarHost: $0.isEmptyBarHost,
            isTabBarHost: $0.isTabBarHost
        ) && (selected == nil || $0.selected == selected)
            && seen.insert("\($0.frame)|\($0.label)").inserted
    }.map(\.label)
}

/// How many matches of getByRole(`role`, { name, exact: true }) in `tree`
/// are left after the SDK's same-target collapse.
func collapsedCount(_ role: String, _ name: String, in tree: [String: Any]) -> Int {
    var seen = Set<String>()
    return walk(tree).filter {
        RoleMapping.matches(
            role: role, elementType: $0.type, traits: $0.traits, value: nil, hasNameFilter: true,
            inTabBar: $0.inTabBar, inAlert: false, isEmptyBarHost: $0.isEmptyBarHost,
            isTabBarHost: $0.isTabBarHost
        ) && RoleName.matches(
            elementType: $0.type, label: $0.label, title: $0.title, placeholder: "", identifier: $0.identifier,
            name: name, exact: true
        ) && seen.insert("\($0.frame)|\($0.label)").inserted
    }.count
}

// iOS 26.5 lays no bar host over the screen; 27.2 lays an empty one.
for (name, file, tabs, hosts) in [
    ("iPad 27.2 SwiftUI", "ipad-pro-11-27.2/tabs.xml", ["Feed", "Search", "Profile"], 1),
    ("iPad 27.2 NativeTabs", "ipad-pro-11-27.2/native-tabs.xml", ["Home", "Explore"], 1),
    ("iPad 26.5 SwiftUI", "ipad-pro-11-26.5/tabs.xml", ["Feed", "Search", "Profile"], 0),
    ("iPad 26.5 NativeTabs", "ipad-pro-11-26.5/native-tabs.xml", ["Home", "Explore"], 0),
] {
    let tree = prepared(file)
    check("\(name): the floating bar's items are tabs", collapsed("tab", in: tree), tabs)
    check("\(name): the floating bar's items report tab",
          Array(Set(reported("tab", in: tree))).sorted(), tabs.sorted())
    check("\(name): the selected tab is the first", collapsed("tab", selected: true, in: tree), [tabs[0]])
    check("\(name): the other tabs are not selected",
          collapsed("tab", selected: false, in: tree), Array(tabs.dropFirst()))
    check("\(name): the floating bar is the one tablist", collapsed("tablist", in: tree).count, 1)
    check("\(name): the floating bar reports tablist", reported("tablist", in: tree).count, 1)
    check("\(name): the tablist holds the tabs",
          walk(tree).filter { $0.isTabBarHost }.map(\.type), [.other])
    check("\(name): no toolbar", collapsed("toolbar", in: tree), [])
    check("\(name): the bar host, if any, is still empty", walk(tree).filter(\.isEmptyBarHost).count, hosts)
    check("\(name): a tab is one match by name", collapsedCount("tab", tabs[1], in: tree), 1)
    check("\(name): a tab is one button match by name", collapsedCount("button", tabs[1], in: tree), 1)
    check("\(name): the back button is no tab", collapsed("tab", in: tree).contains("Back"), false)
}

// A sidebar-adaptable TabView (iOS 18's `Tab` API): the bar also holds the
// sidebar toggle, a plain button, and the search tab, a button holding an
// image of itself. The first tab has a badge.
for (name, file) in [
    ("iPad 27.2 sidebar-adaptable", "ipad-pro-11-27.2/sidebar-tabs.xml"),
    ("iPad 26.5 sidebar-adaptable", "ipad-pro-11-26.5/sidebar-tabs.xml"),
] {
    let tree = prepared(file)
    check("\(name): the tabs, search included, are tabs",
          collapsed("tab", in: tree), ["Inbox", "Drafts", "Sent", "Search"])
    check("\(name): the badged tab is selected", collapsed("tab", selected: true, in: tree), ["Inbox"])
    check("\(name): the bar is the one tablist", collapsed("tablist", in: tree).count, 1)
    check("\(name): the sidebar toggle is no tab", collapsed("tab", in: tree).contains("Toggle sidebar"), false)
    check("\(name): the sidebar toggle reports button", reported("button", in: tree).contains("Toggle sidebar"), true)
    check("\(name): the search tab is one match by name", collapsedCount("tab", "Search", in: tree), 1)
}

/// A group of tab-bar-sized button pairs, as the iPad's floating tab bar
/// lays them out: `items` are (label, selected, nested duplicate).
func floatingBar(_ items: [(String, Bool, Bool)], extra: [[String: Any]] = []) -> [String: Any] {
    func button(_ label: String, _ selected: Bool, x: Int, _ children: [[String: Any]] = []) -> [String: Any] {
        [
            "elementType": XCUIElement.ElementType.button.rawValue, "label": label, "identifier": "",
            "selected": selected,
            "frame": ["X": Double(x), "Y": 142.0, "Width": 80.0, "Height": 36.0],
            "children": children,
        ]
    }
    let buttons = items.enumerated().map { i, item in
        button(item.0, item.1, x: 300 + 80 * i, item.2 ? [button(item.0, item.1, x: 300 + 80 * i)] : [])
    }
    return [
        "elementType": XCUIElement.ElementType.window.rawValue, "label": "", "identifier": "",
        "frame": ["X": 0.0, "Y": 0.0, "Width": 834.0, "Height": 1210.0],
        "children": [[
            "elementType": XCUIElement.ElementType.other.rawValue, "label": "", "identifier": "",
            "frame": ["X": 0.0, "Y": 138.0, "Width": 834.0, "Height": 44.0],
            "children": buttons + extra,
        ]],
    ]
}

func marked(_ tree: [String: Any]) -> [String: Any] {
    var tree = tree
    BarHost.markHosts(in: &tree)
    return tree
}

check("a group of button pairs, one selected, is a tablist",
      collapsed("tablist", in: marked(floatingBar([("A", true, true), ("B", false, true)]))).count, 1)
check("its buttons are tabs",
      collapsed("tab", in: marked(floatingBar([("A", true, true), ("B", false, true)]))), ["A", "B"])
check("a group of button pairs with none selected is no tablist",
      collapsed("tablist", in: marked(floatingBar([("A", false, true), ("B", false, true)]))), [])
check("…and its buttons are no tabs",
      collapsed("tab", in: marked(floatingBar([("A", false, true), ("B", false, true)]))), [])
check("a group of button pairs with two selected is no tablist",
      collapsed("tablist", in: marked(floatingBar([("A", true, true), ("B", true, true)]))), [])
check("a single selected button pair is no tablist",
      collapsed("tablist", in: marked(floatingBar([("A", true, true)]))), [])
check("plain buttons, one selected, are no tablist",
      collapsed("tablist", in: marked(floatingBar([("A", true, false), ("B", false, false)]))), [])
check("a group holding something besides buttons is no tablist",
      collapsed("tablist", in: marked(floatingBar([("A", true, true), ("B", false, true)], extra: [staticText("C")]))),
      [])
let withControl = marked(floatingBar([("A", true, true), ("B", false, true)], extra: [[
    "elementType": XCUIElement.ElementType.button.rawValue, "label": "Toggle", "identifier": "",
    "frame": ["X": 200.0, "Y": 142.0, "Width": 50.0, "Height": 36.0],
]]))
check("a plain button beside the pairs keeps the bar a tablist", collapsed("tablist", in: withControl).count, 1)
check("…and is no tab itself", collapsed("tab", in: withControl), ["A", "B"])
check("…but a button", collapsed("button", in: withControl).contains("Toggle"), true)
check("a selected plain button beside unselected pairs is no tablist",
      collapsed("tablist", in: marked(floatingBar([("A", false, true), ("B", false, true), ("C", true, false)]))), [])
check("one pair beside a plain button is no tablist",
      collapsed("tablist", in: marked(floatingBar([("A", true, true), ("B", false, false)]))), [])
check("a pair whose inner button has another label is no tab",
      collapsed("tablist", in: marked({
          var tree = floatingBar([("A", true, true), ("B", false, true)])
          var window = tree["children"] as! [[String: Any]]
          var group = window[0]
          var buttons = group["children"] as! [[String: Any]]
          var inner = buttons[1]["children"] as! [[String: Any]]
          inner[0]["label"] = "Other"
          buttons[1]["children"] = inner
          group["children"] = buttons
          window[0] = group
          tree["children"] = window
          return tree
      }())), [])

// The SDK folds an outer/inner pair into one match only when their bounds
// are identical, so an inner button inset in its outer one would make each
// tab two matches: such a bar is not recognised.
check("a pair whose inner button is inset in the outer one is no tab",
      collapsed("tablist", in: marked({
          var tree = floatingBar([("A", true, true), ("B", false, true)])
          var window = tree["children"] as! [[String: Any]]
          var group = window[0]
          var buttons = group["children"] as! [[String: Any]]
          var inner = buttons[1]["children"] as! [[String: Any]]
          inner[0]["frame"] = ["X": 390.0, "Y": 146.0, "Width": 60.0, "Height": 28.0]
          buttons[1]["children"] = inner
          group["children"] = buttons
          window[0] = group
          tree["children"] = window
          return tree
      }())), [])

// ─── The back button's name ───

check("Duo: the unlabelled back button is named Back", named("button", "Back", exact: true, in: duoTabs), ["BackButton"])
check("Duo: the toolbar screen's back button is named Back",
      named("button", "Back", exact: true, in: duoToolbar), ["BackButton"])
check("17 Pro: the back button is named by the previous title",
      named("button", "Native Screens", exact: true, in: proTabs), ["BackButton"])
check("17 Pro: the labelled back button is not named Back", named("button", "Back", in: proTabs), [])
check("Duo: the tabs are named by their labels", named("tab", "Profile", exact: true, in: duoTabs), ["person"])
check("Duo: the tablist is no button", named("button", "Toolbar", in: duoTabs), [])

print(failures == 0 ? "ALL OK" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
