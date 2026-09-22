import Foundation

/// Parses JSON params into an ElementSelector.
/// Mirrors the Android agent's parseSelectorParams in CommandHandler.kt.
enum SelectorParser {

    /// Parse a JSON dictionary into an ElementSelector.
    static func parse(_ params: [String: Any]) -> ElementSelector {
        // Handle "role" which can be either a string or a {"role": "...", "name": "..."} object
        let roleObj = params["role"]
        let source: [String: Any]
        if let roleDict = roleObj as? [String: Any] {
            source = roleDict
        } else {
            source = params
        }

        let role = nonEmpty(source["role"] as? String)
        let name = nonEmpty(source["name"] as? String)

        // Handle "resourceId" (sent by daemon) or "id" (legacy)
        let resourceId = nonEmpty(params["resourceId"] as? String) ?? nonEmpty(params["id"] as? String)

        return ElementSelector(
            role: role,
            name: name,
            text: nonEmpty(params["text"] as? String),
            textContains: nonEmpty(params["textContains"] as? String),
            contentDesc: nonEmpty(params["contentDesc"] as? String),
            hint: nonEmpty(params["hint"] as? String),
            className: nonEmpty(params["className"] as? String),
            testId: nonEmpty(params["testId"] as? String),
            id: resourceId,
            xpath: nonEmpty(params["xpath"] as? String),
            label: nonEmpty(params["label"] as? String),
            enabled: params["enabled"] as? Bool,
            checked: params["checked"] as? Bool,
            focused: params["focused"] as? Bool,
            selected: params["selected"] as? Bool,
            expanded: params["expanded"] as? Bool
        )
    }

    /// Check whether the params contain any selector field.
    /// The daemon merges selector fields into params alongside meta keys
    /// like "screenshot", "hierarchy", and "readTimeoutMs" (stamped on every
    /// command), so any other key is a selector.
    static func hasSelector(_ params: [String: Any]) -> Bool {
        params.keys.contains { !metaKeys.contains($0) }
    }

    private static let metaKeys: Set<String> = ["screenshot", "hierarchy", "readTimeoutMs"]

    /// Return nil for empty strings.
    private static func nonEmpty(_ str: String?) -> String? {
        guard let s = str, !s.isEmpty else { return nil }
        return s
    }
}
