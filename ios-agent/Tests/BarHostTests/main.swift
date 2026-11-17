// Unit tests for BarHost (PILOT-1207, PILOT-1219), run on the host Mac without
// a simulator: `ios-agent/Tests/run-unit-tests.sh`. The trees are shaped like
// the snapshots recorded on an iPhone 17 Pro / iOS 27.2 simulator from the
// native fixture app: every navigation container ends with a `Toolbar`
// ("Toolbar"/"Toolbar") the size of the container, empty on a screen with no
// toolbar and holding a bottom toolbar's items when there is one.

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

func R(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect {
    CGRect(x: x, y: y, width: w, height: h)
}

func node(
    _ type: XCUIElement.ElementType,
    _ frame: CGRect,
    label: String = "",
    identifier: String = "",
    value: String = "",
    _ children: [[String: Any]] = []
) -> [String: Any] {
    var dict: [String: Any] = [
        "elementType": type.rawValue,
        "label": label,
        "identifier": identifier,
        "value": value,
        "frame": ["X": Double(frame.minX), "Y": Double(frame.minY), "Width": Double(frame.width), "Height": Double(frame.height)],
    ]
    if !children.isEmpty { dict["children"] = children }
    return dict
}

func host(_ frame: CGRect, _ children: [[String: Any]]) -> [String: Any] {
    node(.toolbar, frame, label: "Toolbar", identifier: "Toolbar", children)
}

func children(_ dict: [String: Any]) -> [[String: Any]] {
    dict["children"] as? [[String: Any]] ?? []
}

/// Whether markEmptyHosts tagged `dict` as an empty host.
func tagged(_ dict: [String: Any]) -> Bool {
    dict[BarHost.emptyHostKey] as? Bool ?? false
}

/// The tree after markEmptyHosts.
func marked(_ tree: [String: Any]) -> [String: Any] {
    var tree = tree
    BarHost.markEmptyHosts(in: &tree)
    return tree
}

let screen = R(0, 0, 402, 874)

// MARK: - The structural rule

check("a toolbar filling its container, laid over content that fills it too, is a host",
      BarHost.isHost(elementType: .toolbar, frame: screen, container: screen, earlierSiblings: [R(0, 62, 402, 106), screen]),
      true)
check("a host's frame may overhang its container by a point",
      BarHost.isHost(elementType: .toolbar, frame: R(-1, 0, 403, 875), container: screen, earlierSiblings: [screen]),
      true)
check("a sheet-sized host (the sheet's container, not the window) is a host",
      BarHost.isHost(elementType: .toolbar, frame: R(0, 62, 402, 812), container: R(0, 62, 402, 812),
                     earlierSiblings: [R(0, 78, 402, 106), R(0, 62, 402, 812)]),
      true)
check("a bar alone in a wrapper of its own size is a bar",
      BarHost.isHost(elementType: .toolbar, frame: R(0, 790, 402, 84), container: R(0, 790, 402, 84), earlierSiblings: []),
      false)
check("a bar in a wrapper of its own size after something smaller (a badge) is a bar",
      BarHost.isHost(elementType: .tabBar, frame: R(0, 790, 402, 84), container: R(0, 790, 402, 84),
                     earlierSiblings: [R(300, 792, 16, 16)]),
      false)
check("a bar-sized toolbar in a screen-sized container is a bar",
      BarHost.isHost(elementType: .toolbar, frame: R(0, 790, 402, 84), container: screen, earlierSiblings: [screen]),
      false)
check("only a bar type can be a host",
      BarHost.isHost(elementType: .button, frame: screen, container: screen, earlierSiblings: [screen]),
      false)
check("a container with no area hosts nothing",
      BarHost.isHost(elementType: .toolbar, frame: screen, container: R(0, 0, 0, 0), earlierSiblings: [R(0, 0, 0, 0)]),
      false)

// MARK: - Empty hosts

// iOS 27.2, a screen with no toolbar (the fixture's Login Form): the window's
// host holds one empty view.
let content: [String: Any] = node(.other, screen, [
    node(.collectionView, screen, [node(.cell, R(20, 172, 362, 44), [node(.textField, R(36, 183, 330, 22))])]),
])
let navBar: [String: Any] = node(.navigationBar, R(0, 62, 402, 106), identifier: "Login Form", [
    node(.button, R(16, 62, 44, 44), label: "Native Screens", identifier: "BackButton"),
])
func window(_ last: [String: Any]) -> [String: Any] {
    node(.application, screen, label: "Tapsmith Native", [
        node(.window, screen, [node(.other, screen, [navBar, content, last])]),
    ])
}
func hostIn(_ tree: [String: Any]) -> [String: Any] {
    children(children(children(tree)[0])[0])[2]
}

let emptyScreen = marked(window(host(screen, [node(.other, screen)])))
check("iOS 27: the empty window-sized host of a screen with no toolbar is tagged", tagged(hostIn(emptyScreen)), true)
check("iOS 27: nothing else on that screen is tagged",
      tagged(children(children(emptyScreen)[0])[0]) || tagged(children(children(children(emptyScreen)[0])[0])[0]),
      false)

// iOS 27.2, the fixture's bottom-toolbar screen: the host holds the items as
// capsules, deep inside unlabelled views (one of them zero-size).
let withItems = marked(window(host(screen, [
    node(.other, screen, [
        node(.other, R(0, 62, 402, 812), [
            node(.other, R(0, 62, 0, 0), [
                node(.other, R(28, 798, 91, 48), [node(.button, R(33, 804, 81, 36), label: "Archive")]),
                node(.other, R(267, 798, 107, 48), [node(.button, R(272, 804, 97, 36), label: "Compose")]),
            ]),
        ]),
    ]),
])))
check("iOS 27: a host holding a bottom toolbar's items is not tagged: it is the toolbar", tagged(hostIn(withItems)), false)

// A NavigationStack sheet gets its own sheet-sized host (empty here).
let sheetFrame = R(0, 62, 402, 812)
let sheetTree = marked(node(.application, screen, [
    node(.window, screen, [node(.other, screen, [
        node(.other, sheetFrame, [
            node(.navigationBar, R(0, 78, 402, 106), identifier: "Sheet", [node(.button, R(316, 82, 66, 36), label: "Done")]),
            node(.other, sheetFrame, [node(.staticText, R(147, 501, 107, 21), label: "Sheet content")]),
            host(sheetFrame, [node(.other, sheetFrame)]),
        ]),
    ])]),
]))
check("iOS 27: a sheet's empty host is tagged",
      tagged(children(children(children(children(sheetTree)[0])[0])[0])[2]), true)

// What counts as an item: anything but an unlabelled, id-less, value-less
// generic view.
for (name, item) in [
    ("a labelled view", node(.other, R(20, 800, 80, 40), label: "Edit")),
    ("a view with an identifier", node(.other, R(20, 800, 80, 40), identifier: "edit")),
    ("a static text", node(.staticText, R(20, 800, 80, 40))),
    ("an image", node(.image, R(20, 800, 40, 40))),
] {
    check("a host holding \(name) is not empty",
          tagged(hostIn(marked(window(host(screen, [node(.other, screen, [item])]))))), false)
}
check("a host holding nothing at all is empty", tagged(hostIn(marked(window(host(screen, []))))), true)

// A real bar is never tagged, empty or not: only a host can be empty.
let realBarTree = marked(window(node(.toolbar, R(0, 790, 402, 84))))
check("an empty bar-sized toolbar is a bar, not an empty host", tagged(hostIn(realBarTree)), false)
let wrappedBar = marked(node(.application, screen, [node(.window, screen, [
    node(.other, screen, [content, node(.other, R(0, 790, 402, 84), [node(.toolbar, R(0, 790, 402, 84))])]),
])]))
check("an empty toolbar alone in a wrapper of its own size is a bar",
      tagged(children(children(children(children(wrappedBar)[0])[0])[1])[0]), false)

check("containsEmptyHost finds an empty host deep in the tree", BarHost.containsEmptyHost(emptyScreen), true)
check("containsEmptyHost finds none where the host holds items", BarHost.containsEmptyHost(withItems), false)

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all BarHost tests passed")
