// Unit tests for KeyboardSpace (PILOT-1284), run on the host Mac without a
// simulator: `ios-agent/Tests/run-unit-tests.sh`. The fixtures are hierarchy
// dumps recorded on the test app's /turned screen, turned to landscapeLeft,
// with the keyboard up for its text field (Tests/Fixtures/*/
// landscape-keyboard.xml). iOS 26.5 reports the keyboard's own frames in
// native portrait space; iOS 27.2 does not.
//
// Usage: keyboard-space-tests <fixtures dir>

import XCTest

typealias Node = OcclusionAnalyzer.Node
typealias Planner = KeyboardDismissPlanner

var failures = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want \(want)")
    }
}

func checkTrue(_ name: String, _ condition: Bool, _ detail: @autoclosure () -> String = "") {
    if condition {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name) \(detail())")
    }
}

func R(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect {
    CGRect(x: x, y: y, width: w, height: h)
}

/// `[x1,y1][x2,y2]`, as a dump writes bounds.
func B(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> CGRect {
    R(x1, y1, x2 - x1, y2 - y1)
}

let fixtures = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Tests/Fixtures"
func fixture(_ name: String) -> [String: Any] { HierarchyFixture.load("\(fixtures)/\(name)") }

/// The nodes `OcclusionAnalyzer(snapshot:)` reads from a snapshot, from its
/// dictionary: pre-order, each with its parent and top-level window.
func nodes(_ root: [String: Any]) -> [Node] {
    var nodes: [Node] = []
    func walk(_ d: [String: Any], window: Int?, parent: Int?) {
        let index = nodes.count
        let type = CellFrames.elementType(of: d)
        let ownWindow = type == .window && window == nil ? index : window
        nodes.append(Node(
            elementType: type, label: d["label"] as? String ?? "", identifier: d["identifier"] as? String ?? "",
            frame: CellFrames.frame(of: d), subtreeEnd: index + 1, parent: parent,
            window: type == .application ? nil : ownWindow
        ))
        for child in d["children"] as? [[String: Any]] ?? [] { walk(child, window: ownWindow, parent: index) }
        nodes[index].subtreeEnd = nodes.count
    }
    walk(root, window: nil, parent: nil)
    return nodes
}

func frames(_ nodes: [Node], _ match: (Node) -> Bool) -> [CGRect] { nodes.filter(match).map(\.frame) }
func frame(_ nodes: [Node], label: String) -> CGRect? { nodes.first { $0.label == label }?.frame }
let keyboardType: (Node) -> Bool = { $0.elementType == .keyboard }

// MARK: - The mapping is HidTouch.nativePoint's inverse

do {
    let screen = CGSize(width: 874, height: 402)
    for turn in [HidTouch.DeviceTurn.landscapeLeft, .landscapeRight] {
        let rect = R(75, 238, 724, 162)
        let native = HidTouch.nativeRect(rect, screen: screen, device: turn)!
        check("\(turn): an interface rect turned native and back is itself",
              KeyboardSpace.interfaceRect(native, screen: screen, turn: turn), rect)
        let point = CGPoint(x: 700, y: 380)
        let nativePoint = HidTouch.nativePoint(point, screen: screen, device: turn)!
        check("\(turn): an interface point turned native and back is itself",
              KeyboardSpace.interfacePoint(nativePoint, screen: screen, turn: turn), point)
    }
}

// MARK: - Detecting the native container

do {
    let wide = CGSize(width: 874, height: 402)
    checkTrue("the screen with its sides swapped is a native container",
              KeyboardSpace.isNativeContainer(R(0, 0, 402, 874), screen: wide))
    checkTrue("within rounding", KeyboardSpace.isNativeContainer(R(0.4, 0, 402.67, 874), screen: wide))
    checkTrue("the screen itself is not", !KeyboardSpace.isNativeContainer(R(0, 0, 874, 402), screen: wide))
    checkTrue("a swapped rect away from the origin is not",
              !KeyboardSpace.isNativeContainer(R(0, 20, 402, 874), screen: wide))
    checkTrue("on an upright screen nothing is",
              !KeyboardSpace.isNativeContainer(R(0, 0, 874, 402), screen: CGSize(width: 402, height: 874)))
}

// MARK: - Which turn

do {
    check("landscapeLeft", KeyboardSpace.landscapeTurn(.landscapeLeft), .landscapeLeft)
    check("landscapeRight", KeyboardSpace.landscapeTurn(.landscapeRight), .landscapeRight)
    for device in [HidTouch.DeviceTurn.portrait, .portraitUpsideDown, .other] {
        check("\(device): no landscape turn", KeyboardSpace.landscapeTurn(device), nil)
    }
}

// MARK: - iPhone 17 Pro, iOS 26.5, landscapeLeft

do {
    var dict = fixture("iphone-17-pro-26.5/landscape-keyboard.xml")
    let raw = nodes(dict)
    let screen = CGSize(width: 874, height: 402)
    check("26.5 iPhone: the keyboard is reported in native space", frames(raw, keyboardType), [B(2, 75, 164, 799)])

    // Before: the planner finds nothing to touch.
    let rawPlanner = Planner(analyzer: OcclusionAnalyzer(nodes: raw, screen: CGRect(origin: .zero, size: screen)))
    let field = B(17, 194, 267, 229)
    checkTrue("26.5 iPhone unturned: no blank spot (the bug)", rawPlanner.blankPoint(focusedFrame: field) == nil)

    let turned = KeyboardSpace.turnIntoInterface(raw, screen: screen, device: .landscapeLeft)
    check("26.5 iPhone: the keyboard is turned to the bottom of the screen", frames(turned, keyboardType), [B(75, 238, 799, 400)])
    check("26.5 iPhone: the return key is at the bottom right", frame(turned, label: "return"), B(654, 349, 799, 384))
    let container = raw.firstIndex { $0.frame == R(0, 0, 402, 874) }!
    check("26.5 iPhone: the native container becomes the screen", turned[container].frame, R(0, 0, 874, 402))
    check("26.5 iPhone: the input view's window, already in interface space, is left alone",
          turned.first { $0.identifier == "inputView" }?.frame, B(75, 194, 799, 402))
    check("26.5 iPhone: the app's own field is left alone",
          turned.first { $0.identifier == "turned-field" }?.frame, field)

    let planner = Planner(analyzer: OcclusionAnalyzer(nodes: turned, screen: CGRect(origin: .zero, size: screen)))
    let region = planner.keyboardRegion
    checkTrue("26.5 iPhone: the keyboard covers the bottom of the screen",
              region.map { $0.maxY >= 400 && $0.minY == 194 } ?? false, "\(String(describing: region))")
    checkTrue("26.5 iPhone: a blank spot beside the field above the keyboard",
              planner.blankPoint(focusedFrame: field).map { $0.y < region!.minY } ?? false)
    if case .press(let p) = planner.returnKey(focusedInput: .textField) {
        checkTrue("26.5 iPhone: the return key is pressed where it is", B(654, 349, 799, 384).contains(p), "\(p)")
    } else {
        checkTrue("26.5 iPhone: the return key is found", false)
    }
    check("26.5 iPhone: no dismiss key on an iPhone", planner.dismissKey(), nil)

    // Lying flat, the turn can't be told, and the agent's touches are not
    // mapped either (TouchSpace): the frames stand, as they did.
    check("26.5 iPhone lying flat: nothing is turned",
          KeyboardSpace.turnIntoInterface(raw, screen: screen, device: .other).map(\.frame), raw.map(\.frame))
    var flat = dict
    KeyboardSpace.turnIntoInterface(in: &flat, device: .other)
    check("26.5 iPhone lying flat: the dictionary is left alone", nodes(flat).map(\.frame), raw.map(\.frame))

    // The dictionary the dump and the locators read turns the same way.
    KeyboardSpace.turnIntoInterface(in: &dict, device: .landscapeLeft)
    check("26.5 iPhone: the dictionary turns as the nodes do", nodes(dict).map(\.frame), turned.map(\.frame))
}

// MARK: - iPad Pro 11, iOS 26.5, landscapeLeft

do {
    let raw = nodes(fixture("ipad-pro-11-26.5/landscape-keyboard.xml"))
    let screen = CGSize(width: 1210, height: 834)
    check("26.5 iPad: the keyboard is reported in native space", frames(raw, keyboardType), [B(3, 0, 373, 1210)])
    let turned = KeyboardSpace.turnIntoInterface(raw, screen: screen, device: .landscapeLeft)
    check("26.5 iPad: the keyboard is turned to the bottom of the screen", frames(turned, keyboardType), [B(0, 461, 1210, 831)])
    check("26.5 iPad: the hide keyboard key is at the bottom right", frame(turned, label: "Hide keyboard"), B(1070, 729, 1206, 814))
    let planner = Planner(analyzer: OcclusionAnalyzer(nodes: turned, screen: CGRect(origin: .zero, size: screen)))
    check("26.5 iPad: the dismiss key is pressed at its centre", planner.dismissKey(), CGPoint(x: 1138, y: 771.5))
    checkTrue("26.5 iPad: a blank spot beside the field",
              planner.blankPoint(focusedFrame: turned.first { $0.identifier == "turned-field" }?.frame) != nil)

    let rawPlanner = Planner(analyzer: OcclusionAnalyzer(nodes: raw, screen: CGRect(origin: .zero, size: screen)))
    checkTrue("26.5 iPad unturned: the dismiss key is not found where it is (the bug)",
              rawPlanner.dismissKey().map { !B(1070, 729, 1206, 814).contains($0) } ?? true)
}

// MARK: - iOS 27.2 and portrait: already in interface space

for (name, size) in [
    ("iphone-17-27.2/landscape-keyboard.xml", CGSize(width: 874, height: 402)),
    ("ipad-pro-11-27.2/landscape-keyboard.xml", CGSize(width: 1210, height: 834)),
    ("iphone-17-pro-26.5/portrait-keyboard.xml", CGSize(width: 402, height: 874)),
] {
    var dict = fixture(name)
    let raw = nodes(dict)
    for device in [HidTouch.DeviceTurn.landscapeLeft, .landscapeRight, .other] {
        check("\(name) \(device): nothing is turned",
              KeyboardSpace.turnIntoInterface(raw, screen: size, device: device).map(\.frame), raw.map(\.frame))
    }
    KeyboardSpace.turnIntoInterface(in: &dict, device: .landscapeLeft)
    check("\(name): the dictionary is left alone", nodes(dict).map(\.frame), raw.map(\.frame))
}

do {
    let planner = Planner(analyzer: OcclusionAnalyzer(
        nodes: nodes(fixture("ipad-pro-11-27.2/landscape-keyboard.xml")), screen: R(0, 0, 1210, 834)
    ))
    check("27.2 iPad: the dismiss key, as reported", planner.dismissKey(), CGPoint(x: 1138, y: 771))
}

// MARK: - Synthetic trees

/// A landscape tree whose keyboard window holds a native container, laid out
/// for `turn`, with the keyboard docked at the interface's bottom.
func syntheticTree(turn: HidTouch.DeviceTurn, extraContainerInAppWindow: Bool = false) -> [Node] {
    let screen = CGSize(width: 874, height: 402)
    let keyboard = B(0, 240, 874, 402)
    let key = B(700, 350, 800, 390)
    let native = { HidTouch.nativeRect($0, screen: screen, device: turn)! }
    var rows: [(CGRect, XCUIElement.ElementType, String, Int?, Int?)] = [
        (R(0, 0, 874, 402), .application, "", nil, nil),
        (R(0, 0, 874, 402), .window, "", 0, 1),
    ]
    if extraContainerInAppWindow {
        rows.append((R(0, 0, 402, 874), .other, "portrait-locked", 1, 1))
    }
    let kbWindow = rows.count
    rows += [
        (R(0, 0, 874, 402), .window, "", 0, kbWindow),
        (R(0, 0, 402, 874), .other, "", kbWindow, kbWindow),
        (native(keyboard), .keyboard, "", kbWindow + 1, kbWindow),
        (native(key), .button, "return", kbWindow + 2, kbWindow),
    ]
    var nodes = rows.enumerated().map { i, row in
        Node(elementType: row.1, label: row.2, identifier: row.2, frame: row.0, subtreeEnd: i + 1, parent: row.3, window: row.4)
    }
    // Parents' subtrees end at the end of the list, except the app window's.
    nodes[0].subtreeEnd = nodes.count
    nodes[1].subtreeEnd = kbWindow
    for i in kbWindow..<nodes.count { nodes[i].subtreeEnd = nodes.count }
    return nodes
}

do {
    let screen = CGSize(width: 874, height: 402)
    for turn in [HidTouch.DeviceTurn.landscapeLeft, .landscapeRight] {
        let raw = syntheticTree(turn: turn)
        let turned = KeyboardSpace.turnIntoInterface(raw, screen: screen, device: turn)
        check("\(turn): the keyboard is turned back", frames(turned, keyboardType), [B(0, 240, 874, 402)])
        check("\(turn): its key too", frame(turned, label: "return"), B(700, 350, 800, 390))
    }
    let withAppContainer = syntheticTree(turn: .landscapeLeft, extraContainerInAppWindow: true)
    let turned = KeyboardSpace.turnIntoInterface(withAppContainer, screen: screen, device: .landscapeLeft)
    check("a screen-sized swapped node with no keyboard in it is left alone",
          turned.first { $0.identifier == "portrait-locked" }?.frame, R(0, 0, 402, 874))
    check("upright screen: nothing is turned",
          KeyboardSpace.turnIntoInterface(withAppContainer, screen: CGSize(width: 402, height: 874), device: .portrait).map(\.frame),
          withAppContainer.map(\.frame))
}

// MARK: - The device's turn is read only when a snapshot needs it

do {
    var reads = 0
    func readTurn() -> HidTouch.DeviceTurn { reads += 1; return .landscapeLeft }
    for name in ["iphone-17-pro-26.5/portrait-keyboard.xml", "iphone-17-27.2/landscape-keyboard.xml"] {
        var dict = fixture(name)
        let size = CellFrames.frame(of: dict).size
        _ = KeyboardSpace.turnIntoInterface(nodes(dict), screen: size, device: readTurn())
        KeyboardSpace.turnIntoInterface(in: &dict, device: readTurn())
    }
    check("no native container: the turn is never read", reads, 0)
    var dict = fixture("iphone-17-pro-26.5/landscape-keyboard.xml")
    _ = KeyboardSpace.turnIntoInterface(nodes(dict), screen: CGSize(width: 874, height: 402), device: readTurn())
    KeyboardSpace.turnIntoInterface(in: &dict, device: readTurn())
    check("a native container: the turn is read once per snapshot", reads, 2)
}

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all keyboard space tests passed")
