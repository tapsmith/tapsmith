import Foundation

/// A Flutter tab: a destination of a Material `NavigationBar`,
/// `NavigationRail`, `NavigationDrawer`, `TabBar` or `BottomNavigationBar`.
/// Flutter's iOS embedding gives none of them a tab type or trait (the
/// NavigationBar and BottomNavigationBar items are buttons, the others static
/// text, or a generic view while selected); what marks them is the position
/// Flutter appends to the item's label for VoiceOver —
/// MaterialLocalizations.tabLabel, merged into the label after a line break:
/// `"Contact\nTab 2 of 3"`. The Android agent reads the same suffix
/// (FlutterTab.kt).
///
/// Such an element is a `tab` (`RoleMapping.resolveRole`), and it is named by
/// the label without that suffix (`"Contact"`, `RoleName`) as well as by its
/// whole label, so `getByRole("tab", { name: "Contact", exact: true })` finds
/// it whichever of those widgets draws it, and a locator written with the
/// whole label keeps working.
///
/// Flutter's default English localization only: an app that localizes its
/// Material strings publishes the suffix in its own language, which is not
/// read.
enum FlutterTab {
    /// The hierarchy dump's attribute for `name(of:)`, on the tab: the
    /// locator playground names the tab by it, as the Android dump's does.
    static let nameDumpAttribute = "tapsmith-name"

    private static let position: NSRegularExpression = {
        // A literal pattern: it compiles.
        try! NSRegularExpression(pattern: "^Tab [1-9][0-9]* of [1-9][0-9]*$")
    }()

    /// The tab's name — its label, without Flutter's position suffix — when
    /// `label` is a Flutter tab's, else nil. An item with no label of its own
    /// (an icon with no semantic label) is named "".
    static func name(of label: String) -> String? {
        guard !label.isEmpty else { return nil }
        let prefix: Substring
        let last: Substring
        if let lineBreak = label.range(of: "\n", options: .backwards) {
            prefix = label[..<lineBreak.lowerBound]
            last = label[lineBreak.upperBound...]
        } else {
            prefix = ""
            last = label[...]
        }
        let suffix = String(last)
        let range = NSRange(suffix.startIndex..., in: suffix)
        guard position.firstMatch(in: suffix, range: range) != nil else { return nil }
        return String(prefix)
    }
}
