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
        // getByRole `{ exact: true }` rides inside the role object (PILOT-549).
        let nameExact = (roleObj as? [String: Any])?["exact"] as? Bool ?? false
        // RegExp locators (PILOT-520). With a RegExp name, `name` only carries
        // its literal for agents that predate RegExp support, so it is not a
        // name filter here.
        let nameRegex = TextRegex.fromJSON((roleObj as? [String: Any])?["nameRegex"])
        let name = nameRegex == nil ? nonEmpty(source["name"] as? String) : nil

        // Handle "resourceId" (sent by daemon) or "id" (legacy)
        let resourceId = nonEmpty(params["resourceId"] as? String) ?? nonEmpty(params["id"] as? String)

        return ElementSelector(
            role: role,
            name: name,
            nameExact: nameExact,
            nameRegex: nameRegex,
            text: nonEmpty(params["text"] as? String),
            textContains: nonEmpty(params["textContains"] as? String),
            textRegex: TextRegex.fromJSON(params["textRegex"]),
            contentDesc: nonEmpty(params["contentDesc"] as? String),
            hint: nonEmpty(params["hint"] as? String),
            className: nonEmpty(params["className"] as? String),
            testId: nonEmpty(params["testId"] as? String),
            id: resourceId,
            xpath: nonEmpty(params["xpath"] as? String),
            label: nonEmpty(params["label"] as? String),
            labelRegex: TextRegex.fromJSON(params["labelRegex"]),
            enabled: params["enabled"] as? Bool,
            checked: params["checked"] as? Bool,
            focused: params["focused"] as? Bool,
            selected: params["selected"] as? Bool,
            expanded: params["expanded"] as? Bool
        )
    }

    /// Check whether the params contain any selector field: any key that
    /// is not one of the daemon's own (`CommandMeta`).
    static func hasSelector(_ params: [String: Any]) -> Bool {
        CommandMeta.hasSelectorKeys(params)
    }

    /// Return nil for empty strings.
    private static func nonEmpty(_ str: String?) -> String? {
        guard let s = str, !s.isEmpty else { return nil }
        return s
    }
}
