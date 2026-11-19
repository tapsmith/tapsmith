import XCTest

/// Turns the software keyboard's frames into the app's interface space on a
/// turned screen. Pure, so the rules are host-testable.
///
/// On iOS 26 (measured on 26.5, iPhone and iPad), with the screen turned to
/// landscape, the keyboard's window reports its own frame in the app's
/// interface space, wider than tall, but its first child is a container the
/// size of the screen with its sides swapped, at the origin. Everything in
/// that container (the keys, the dismiss key, the prediction bar) is in the
/// device's native portrait space. Every other frame in the snapshot,
/// including the input view host window above the keys, is in interface
/// space. iOS 27 reports the keyboard in interface space already, with no
/// such container, so nothing is turned there.
///
/// Each frame in a native container is turned back with the inverse of
/// `HidTouch.nativePoint`, for the way the device is turned. When that can't
/// be told (a device lying flat), the frames stand, as the agent's touches do
/// (`TouchSpace`): a turn read off the keyboard alone would turn the keys
/// into a space no touch maps back out of.
///
/// The device's turn is read only once a native container is found: it is a
/// round trip to the test runner, and most snapshots have none.
enum KeyboardSpace {
    /// Rounding slack when comparing a frame with the screen's size.
    static let tolerance: CGFloat = 1

    /// Whether `frame` is a native portrait container on a screen whose app
    /// window is `screen`: the screen with its sides swapped, at the origin,
    /// on a screen wider than tall.
    static func isNativeContainer(_ frame: CGRect, screen: CGSize) -> Bool {
        guard screen.width > screen.height else { return false }
        return abs(frame.minX) <= tolerance && abs(frame.minY) <= tolerance
            && abs(frame.width - screen.height) <= tolerance
            && abs(frame.height - screen.width) <= tolerance
    }

    /// The landscape turn a native container is laid out for, or nil when
    /// the device is not turned to landscape.
    static func landscapeTurn(_ device: HidTouch.DeviceTurn) -> HidTouch.DeviceTurn? {
        switch device {
        case .landscapeLeft, .landscapeRight: return device
        case .portrait, .portraitUpsideDown, .other: return nil
        }
    }

    /// `point`, in native portrait space, in the app's interface space on a
    /// screen whose app window is `screen` (wider than tall), turned `turn`
    /// (`.landscapeLeft` or `.landscapeRight`; anything else leaves it). The
    /// inverse of `HidTouch.nativePoint`.
    static func interfacePoint(_ point: CGPoint, screen: CGSize, turn: HidTouch.DeviceTurn) -> CGPoint {
        let nativeWidth = screen.height
        let nativeHeight = screen.width
        switch turn {
        case .landscapeLeft:
            // native = (nativeWidth - y, x)
            return CGPoint(x: point.y, y: nativeWidth - point.x)
        case .landscapeRight:
            // native = (y, nativeHeight - x)
            return CGPoint(x: nativeHeight - point.y, y: point.x)
        case .portrait, .portraitUpsideDown, .other:
            return point
        }
    }

    /// `interfacePoint` for a rect: its sides swap.
    static func interfaceRect(_ rect: CGRect, screen: CGSize, turn: HidTouch.DeviceTurn) -> CGRect {
        let corner = interfacePoint(CGPoint(x: rect.minX, y: rect.minY), screen: screen, turn: turn)
        let opposite = interfacePoint(CGPoint(x: rect.maxX, y: rect.maxY), screen: screen, turn: turn)
        return CGRect(
            x: min(corner.x, opposite.x),
            y: min(corner.y, opposite.y),
            width: abs(opposite.x - corner.x),
            height: abs(opposite.y - corner.y)
        )
    }

    // MARK: - Snapshot nodes

    /// `nodes` (pre-order, as `OcclusionAnalyzer` reads a snapshot) with
    /// every frame inside a native container that holds a keyboard turned
    /// into interface space. `screen` is the app's window as the snapshot
    /// saw it.
    static func turnIntoInterface(
        _ nodes: [OcclusionAnalyzer.Node], screen: CGSize, device: @autoclosure () -> HidTouch.DeviceTurn
    ) -> [OcclusionAnalyzer.Node] {
        guard screen.width > screen.height else { return nodes }
        var result = nodes
        var deviceTurn: HidTouch.DeviceTurn?
        var i = 0
        while i < nodes.count {
            let end = nodes[i].subtreeEnd
            guard isNativeContainer(nodes[i].frame, screen: screen),
                  nodes[i..<end].contains(where: { $0.elementType == .keyboard })
            else { i += 1; continue }
            if deviceTurn == nil { deviceTurn = device() }
            guard let turn = deviceTurn.flatMap(landscapeTurn) else { return nodes }
            for j in i..<end {
                let n = nodes[j]
                result[j] = OcclusionAnalyzer.Node(
                    elementType: n.elementType, label: n.label, identifier: n.identifier,
                    frame: interfaceRect(n.frame, screen: screen, turn: turn),
                    subtreeEnd: n.subtreeEnd, parent: n.parent, window: n.window, traits: n.traits
                )
            }
            i = end
        }
        return result
    }

    // MARK: - Snapshot dictionaries

    /// The same for a snapshot's string-keyed dictionary (the tree the
    /// locators and the hierarchy dump read), whose root is the application:
    /// its frame is the app's window.
    static func turnIntoInterface(in root: inout [String: Any], device: @autoclosure () -> HidTouch.DeviceTurn) {
        let screen = CellFrames.frame(of: root).size
        guard screen.width > screen.height else { return }
        var deviceTurn: HidTouch.DeviceTurn?
        turnContainers(in: &root, screen: screen) {
            if deviceTurn == nil { deviceTurn = device() }
            return deviceTurn.flatMap(landscapeTurn)
        }
    }

    private static func turnContainers(
        in node: inout [String: Any], screen: CGSize, turn: () -> HidTouch.DeviceTurn?
    ) {
        if isNativeContainer(CellFrames.frame(of: node), screen: screen), holdsKeyboard(node) {
            if let turn = turn() { turnAll(in: &node, screen: screen, turn: turn) }
            return
        }
        guard var children = node["children"] as? [[String: Any]] else { return }
        for k in children.indices { turnContainers(in: &children[k], screen: screen, turn: turn) }
        node["children"] = children
    }

    private static func turnAll(in node: inout [String: Any], screen: CGSize, turn: HidTouch.DeviceTurn) {
        if node["frame"] != nil { CellFrames.setFrame(interfaceRect(CellFrames.frame(of: node), screen: screen, turn: turn), of: &node) }
        guard var children = node["children"] as? [[String: Any]] else { return }
        for k in children.indices { turnAll(in: &children[k], screen: screen, turn: turn) }
        node["children"] = children
    }

    private static func holdsKeyboard(_ node: [String: Any]) -> Bool {
        if CellFrames.elementType(of: node) == .keyboard { return true }
        return (node["children"] as? [[String: Any]] ?? []).contains(where: holdsKeyboard)
    }
}
