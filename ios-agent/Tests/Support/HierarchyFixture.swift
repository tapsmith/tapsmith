// Loads a hierarchy dump the agent recorded on a simulator (the XML
// `HierarchyDumper` writes, as a trace archive holds it) back into the
// snapshot dictionary the agent's passes read: element type, label,
// identifier, value, placeholder, selected and enabled state, and frame.
// Everything the agent derived when it wrote the dump (`tapsmith-*`
// attributes, the role) is left out, and so are traits, which a dump does
// not carry: a test runs the agent's own passes over the tree again.

import XCTest

enum HierarchyFixture {
    /// The tree under `<hierarchy>` in the dump at `path`: its root node.
    static func load(_ path: String) -> [String: Any] {
        guard let parser = XMLParser(contentsOf: URL(fileURLWithPath: path)) else {
            fatalError("cannot read fixture \(path)")
        }
        let delegate = Builder()
        parser.delegate = delegate
        guard parser.parse(), let root = delegate.root else {
            fatalError("cannot parse fixture \(path): \(parser.parserError.map { "\($0)" } ?? "no root")")
        }
        return root
    }

    /// `XCUIElementType…` names, as `RoleMapping.typeName` writes them, to
    /// their element types.
    private static let types: [String: XCUIElement.ElementType] = {
        var map: [String: XCUIElement.ElementType] = [:]
        for raw in UInt(0)...UInt(100) {
            guard let type = XCUIElement.ElementType(rawValue: raw) else { continue }
            map[RoleMapping.typeName(for: type)] = type
        }
        return map
    }()

    /// `[x1,y1][x2,y2]` to a frame.
    private static func frame(_ bounds: String) -> CGRect {
        let numbers = bounds.split(whereSeparator: { "[],".contains($0) }).compactMap { Double($0) }
        guard numbers.count == 4 else { return .zero }
        return CGRect(x: numbers[0], y: numbers[1], width: numbers[2] - numbers[0], height: numbers[3] - numbers[1])
    }

    private final class Builder: NSObject, XMLParserDelegate {
        var root: [String: Any]?
        private var stack: [[String: Any]] = []

        func parser(
            _ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
            qualifiedName: String?, attributes: [String: String]
        ) {
            guard name != "hierarchy" else { return }
            let type = HierarchyFixture.types[attributes["type"] ?? name] ?? .other
            let frame = HierarchyFixture.frame(attributes["bounds"] ?? "")
            stack.append([
                "elementType": type.rawValue,
                "label": attributes["label"] ?? "",
                "identifier": attributes["identifier"] ?? "",
                "value": attributes["value"] ?? "",
                "placeholderValue": attributes["placeholderValue"] ?? "",
                "selected": attributes["selected"] == "true",
                "enabled": attributes["enabled"] != "false",
                "frame": [
                    "X": Double(frame.minX), "Y": Double(frame.minY),
                    "Width": Double(frame.width), "Height": Double(frame.height),
                ],
            ])
        }

        func parser(
            _ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?
        ) {
            guard name != "hierarchy", let node = stack.popLast() else { return }
            if stack.isEmpty {
                root = node
            } else {
                var parent = stack.removeLast()
                parent["children"] = (parent["children"] as? [[String: Any]] ?? []) + [node]
                stack.append(parent)
            }
        }
    }
}
