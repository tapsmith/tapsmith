import XCTest
import Foundation

/// Dumps the current UI hierarchy as an XML string.
///
/// Uses the app snapshot for fast, single-IPC traversal instead of
/// per-element XCUIElement queries (which take 7+ seconds due to
/// individual IPC round-trips for each property access).
class HierarchyDumper {
    private let app: XCUIApplication
    private let bundleId: String

    init(app: XCUIApplication, bundleId: String = "") {
        self.app = app
        self.bundleId = bundleId
    }

    /// Dump the full UI hierarchy as an XML string using snapshot.
    ///
    /// Throws when the app has no accessibility server (`kAXErrorAPIDisabled`,
    /// PILOT-462): the XCUIElement fallback would hit the same missing server,
    /// spend ~8 s retrying and end in XCTest's "Interrupting test" exception,
    /// so the caller gets an actionable error instead.
    func dump() throws -> String {
        do {
            let snapshot = try app.snapshot()
            return dump(from: snapshot)
        } catch {
            if LaunchAccessibilityCheck.isAccessibilityUnreachable("\(error)") {
                NSLog("[HierarchyDumper] Snapshot failed, app not reachable through accessibility: \(error)")
                throw AgentError.actionFailed(LaunchAccessibilityCheck.unreachableMessage(bundleId: bundleId))
            }
            NSLog("[HierarchyDumper] Snapshot failed, falling back to XCUIElement traversal: \(error)")
            return dumpFallback()
        }
    }

    /// Dump the UI hierarchy via direct XCUIElement traversal.
    func dumpFallback() -> String {
        var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        xml += "<hierarchy>\n"
        dumpElementFallback(app, depth: 1, into: &xml)
        xml += "</hierarchy>\n"
        return xml
    }

    /// Dump the UI hierarchy from a pre-taken snapshot (avoids an extra IPC).
    func dump(from snapshot: XCUIElementSnapshot) -> String {
        var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        xml += "<hierarchy>\n"
        var dict = convertKeys(snapshot.dictionaryRepresentation)
        SnapshotElementFinder.annotateTraits(dict: &dict, snapshot: snapshot)
        dumpNode(dict, depth: 1, into: &xml)
        xml += "</hierarchy>\n"
        return xml
    }

    // MARK: - Snapshot-based dump (fast path)

    private func dumpNode(_ node: [String: Any], depth: Int, into xml: inout String) {
        let indent = String(repeating: "  ", count: depth)
        let elTypeRaw = (node["elementType"] as? UInt) ?? (node["elementType"] as? Int).map(UInt.init) ?? 0
        let elType = XCUIElement.ElementType(rawValue: elTypeRaw) ?? .other
        let typeName = RoleMapping.typeName(for: elType)

        let label = escapeXML(node["label"] as? String ?? "")
        let identifier = escapeXML(node["identifier"] as? String ?? "")
        let value = escapeXML(node["value"] as? String ?? "")
        let placeholder = escapeXML(node["placeholderValue"] as? String ?? "")
        let title = node["title"] as? String ?? ""
        let isEnabled = node["enabled"] as? Bool ?? true
        let isSelected = node["selected"] as? Bool ?? false
        let hasFocus = node["hasFocus"] as? Bool ?? false
        let frame = parseFrame(node)

        let bounds = "[\(Int(frame.origin.x)),\(Int(frame.origin.y))]"
            + "[\(Int(frame.origin.x + frame.width)),\(Int(frame.origin.y + frame.height))]"
        let visible = frame.width > 0 && frame.height > 0

        // Resolve role from traits (heading, link, alert, etc.) and element type.
        let traits = SnapshotElementFinder.extractTraits(from: node)
        let role = RoleMapping.resolveRole(for: elType, traits: traits)

        xml += "\(indent)<\(typeName)"
        xml += " label=\"\(label)\""
        xml += " identifier=\"\(identifier)\""
        xml += " value=\"\(value)\""
        xml += " placeholderValue=\"\(placeholder)\""
        // The title names an input for getByLabel, like the label (PILOT-666).
        if !title.isEmpty {
            xml += " title=\"\(escapeXML(title))\""
        }
        xml += " type=\"\(typeName)\""
        if !role.isEmpty {
            xml += " tapsmith-role=\"\(escapeXML(role))\""
        }
        xml += " enabled=\"\(isEnabled)\""
        xml += " visible=\"\(visible)\""
        xml += " selected=\"\(isSelected)\""
        xml += " hasFocus=\"\(hasFocus)\""
        xml += " bounds=\"\(bounds)\""

        let children = node["children"] as? [[String: Any]] ?? []

        if children.isEmpty {
            xml += " />\n"
        } else {
            xml += ">\n"
            for child in children {
                dumpNode(child, depth: depth + 1, into: &xml)
            }
            xml += "\(indent)</\(typeName)>\n"
        }
    }

    private func parseFrame(_ node: [String: Any]) -> CGRect {
        if let frameDict = node["frame"] as? [String: Any] {
            let x = (frameDict["X"] as? Double) ?? (frameDict["x"] as? Double) ?? 0
            let y = (frameDict["Y"] as? Double) ?? (frameDict["y"] as? Double) ?? 0
            let w = (frameDict["Width"] as? Double) ?? (frameDict["width"] as? Double) ?? 0
            let h = (frameDict["Height"] as? Double) ?? (frameDict["height"] as? Double) ?? 0
            return CGRect(x: x, y: y, width: w, height: h)
        }
        return .zero
    }

    private func convertKeys(_ raw: [XCUIElement.AttributeName: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in raw {
            if let children = value as? [[XCUIElement.AttributeName: Any]] {
                result[key.rawValue] = children.map { convertKeys($0) }
            } else if let child = value as? [XCUIElement.AttributeName: Any] {
                result[key.rawValue] = convertKeys(child)
            } else {
                result[key.rawValue] = value
            }
        }
        return result
    }

    // MARK: - XCUIElement fallback (slow path, used if snapshot fails)

    private func dumpElementFallback(_ element: XCUIElement, depth: Int, into xml: inout String) {
        let indent = String(repeating: "  ", count: depth)
        let typeName = RoleMapping.typeName(for: element.elementType)
        let frame = element.frame

        let bounds = "[\(Int(frame.origin.x)),\(Int(frame.origin.y))]"
            + "[\(Int(frame.origin.x + frame.width)),\(Int(frame.origin.y + frame.height))]"

        let label = escapeXML(element.label)
        let identifier = escapeXML(element.identifier)
        let value = escapeXML((element.value as? String) ?? "")
        let placeholder = escapeXML(element.placeholderValue ?? "")

        // Extract traits via KVC for role resolution in the fallback path.
        let traits: UInt64 = {
            guard let nsElement = element as? NSObject,
                  nsElement.responds(to: NSSelectorFromString("traits")) else { return 0 }
            let raw = nsElement.value(forKey: "traits")
            if let v = raw as? UInt64 { return v }
            if let v = raw as? NSNumber { return v.uint64Value }
            return 0
        }()
        let role = RoleMapping.resolveRole(for: element.elementType, traits: traits)

        xml += "\(indent)<\(typeName)"
        xml += " label=\"\(label)\""
        xml += " identifier=\"\(identifier)\""
        xml += " value=\"\(value)\""
        xml += " placeholderValue=\"\(placeholder)\""
        // One read: each XCUIElement attribute is an IPC round-trip.
        let title = element.title
        if !title.isEmpty {
            xml += " title=\"\(escapeXML(title))\""
        }
        xml += " type=\"\(typeName)\""
        if !role.isEmpty {
            xml += " tapsmith-role=\"\(escapeXML(role))\""
        }
        xml += " enabled=\"\(element.isEnabled)\""
        xml += " visible=\"\(element.exists && frame.width > 0 && frame.height > 0)\""
        xml += " selected=\"\(element.isSelected)\""
        xml += " hasFocus=\"\(element.hasFocus)\""
        xml += " bounds=\"\(bounds)\""

        let children = element.children(matching: .any)
        let childCount = children.count

        if childCount == 0 {
            xml += " />\n"
        } else {
            xml += ">\n"
            for i in 0..<childCount {
                let child = children.element(boundBy: i)
                if child.exists {
                    dumpElementFallback(child, depth: depth + 1, into: &xml)
                }
            }
            xml += "\(indent)</\(typeName)>\n"
        }
    }

    private func escapeXML(_ str: String) -> String {
        return str
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }
}
