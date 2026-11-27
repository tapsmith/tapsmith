import XCTest

/// UIAccessibilityTraits bits (from UIKit) that carry a role.
enum AccessibilityTrait {
    static let button: UInt64 = 1 << 0        // UIAccessibilityTraitButton
    static let link: UInt64 = 1 << 1          // UIAccessibilityTraitLink
    static let image: UInt64 = 1 << 2         // UIAccessibilityTraitImage
    static let staticText: UInt64 = 1 << 6    // UIAccessibilityTraitStaticText
    static let searchField: UInt64 = 1 << 10  // UIAccessibilityTraitSearchField
    static let adjustable: UInt64 = 1 << 12   // UIAccessibilityTraitAdjustable (slider, stepper, picker wheel)
    static let header: UInt64 = 1 << 16       // UIAccessibilityTraitHeader
    /// UIAccessibilityTraitTextEntry (private): UIKit gives it to a text view
    /// only while it can be edited — a UIKit UITextView, a SwiftUI
    /// TextEditor, React Native's multi-line TextInput — and not to a
    /// read-only one, which carries the static-text trait instead (PILOT-697).
    static let textEntry: UInt64 = 1 << 18
    /// UIAccessibilityTraitBackButton (private): UIKit gives it to a
    /// navigation stack's system back button, in UIKit, SwiftUI and React
    /// Navigation native stacks alike, and to no other bar button (a root
    /// screen's leading Edit or Close, a bottom toolbar's Back and an iPad
    /// sidebar toggle have the button trait only). Recorded
    /// on iOS 18.5 and 27.2 iPhone simulators (PILOT-1261, PILOT-1532).
    static let backButton: UInt64 = 1 << 27

    /// The identifier UIKit gives the system back button on iOS 26 and
    /// later. iOS 18 drops it once a push settles (recorded on 18.5; 17 is
    /// unrecorded and assumed alike, PILOT-1532).
    static let backButtonIdentifier = "BackButton"

    /// Whether an element is a navigation stack's system back button: a
    /// button identified as `BackButton`, or one carrying the back-button
    /// trait — the only mark it keeps on iOS 18, whose back button
    /// is labelled with the previous screen's title and has no identifier.
    /// Traits that couldn't be read (nil) never mark it.
    static func isSystemBackButton(elementType: XCUIElement.ElementType, identifier: String, traits: UInt64?) -> Bool {
        guard elementType == .button else { return false }
        return identifier == backButtonIdentifier || (traits ?? 0) & backButton != 0
    }

    /// A snapshot node's traits, read through XCTest's private `traits`
    /// property, or nil when that property is missing (a future Xcode may
    /// rename it) or holds no number.
    ///
    /// Bare `value(forKey:)` on an NSObject that doesn't have the key throws
    /// an Objective-C NSUnknownKeyException, which is *not* catchable from
    /// Swift and crashes the agent, so `responds(to:)` is checked first.
    static func read(from snapshot: XCUIElementSnapshot) -> UInt64? {
        guard let object = snapshot as? NSObject,
              object.responds(to: NSSelectorFromString("traits")) else { return nil }
        switch object.value(forKey: "traits") {
        case let value as UInt64: return value
        case let value as NSNumber: return value.uint64Value
        default: return nil
        }
    }
}

/// Maps Tapsmith role names to XCUIElement.ElementType values.
/// Mirrors the Android agent's roleClassMap in ElementFinder.kt.
enum RoleMapping {

    /// Role name → list of XCUIElement.ElementType that represent that role.
    /// The keys are the SDK's `NATIVE_ROLES` (`packages/tapsmith/src/roles.ts`),
    /// which rejects any other role before it reaches the agent; `roles.test.ts`
    /// pins the two together (PILOT-556).
    static let roleToElementTypes: [String: [XCUIElement.ElementType]] = [
        "button": [.button],
        // A multi-line text view (RN `<TextInput multiline />`, UITextView,
        // SwiftUI TextEditor) too, as Android's multi-line EditText (PILOT-697).
        "textfield": [.textField, .secureTextField, .textView],
        "checkbox": [.checkBox, .other],
        "switch": [.switch, .toggle],
        "image": [.image],
        "text": [.staticText],
        // Candidate types for queries; `matches` requires the header trait.
        "heading": [.staticText],
        "link": [.link],
        "list": [.table, .collectionView],
        "listitem": [.cell],
        "scrollview": [.scrollView],
        // An indeterminate ProgressView / UIActivityIndicatorView is a
        // progressbar, as ARIA and Android have it (PILOT-797); it still
        // matches "spinner" too, which it was before.
        "progressbar": [.progressIndicator, .activityIndicator],
        "seekbar": [.slider],
        "radiobutton": [.radioButton, .other],
        "spinner": [.picker, .activityIndicator],
        "toolbar": [.toolbar],
        // A UITabBar's items are buttons inside the bar, not `.tab`
        // elements: `matches` also accepts those (`isTabBarItem`), and the bar
        // itself is a "tablist" (PILOT-514).
        "tab": [.tab],
        // resolveRole(for:traits:) can publish "searchfield" off the
        // UIAccessibilityTraitSearchField bit — keep the reverse mapping
        // here so getByRole("searchfield") is symmetric and doesn't throw
        // "Unknown role".
        "searchfield": [.searchField],
        // RN renders these (and its checkbox and radio) as .other with no
        // distinguishing trait: `matches` looks for RN's role description in
        // the value, or takes a named query's word for it. resolveRole
        // won't report these roles back for a generic view, so toHaveRole
        // won't match one. A native alert — SwiftUI's .alert, a
        // UIAlertController alert, RN's Alert.alert — is `.alert`, which is
        // reported (PILOT-919); the views and text inside it are not alerts
        // (`matches`, `inAlert`).
        "alert": [.alert, .other],
        "combobox": [.other],
        // React Native's other description-only roles (PILOT-664): the
        // Android agent reads them from the role description; here they are
        // generic views a named query finds (`undescribedOtherRoles`). Those
        // with a native type match it too (PILOT-702): a UIMenu's items, a
        // Stepper, and the menu bar / radio group types XCUITest defines.
        "menu": [.menu, .other],
        "menubar": [.menuBar, .other],
        "menuitem": [.menuItem, .other],
        "radiogroup": [.radioGroup, .other],
        "scrollbar": [.other],
        "spinbutton": [.stepper, .other],
        "summary": [.other],
        "tablist": [.tabBar, .other],
        "timer": [.other],
    ]

    /// The role reported for an element type that more than one role lists in
    /// `roleToElementTypes`. "heading" also queries `.staticText`, but a
    /// heading is only reported off the header trait, which `resolveRole`
    /// checks before this map. An activity indicator is a progressbar that
    /// still matches "spinner" (PILOT-797).
    static let reverseRolePins: [XCUIElement.ElementType: String] = [
        .staticText: "text",
        .activityIndicator: "progressbar",
    ]

    /// Reverse mapping: XCUIElement.ElementType → role name.
    /// `.other` is excluded: multiple roles include it in their forward mapping
    /// (checkbox, radiobutton, alert, combobox, …) so getByRole can match generic
    /// Views by name, but the reverse can't pick one.
    static let elementTypeToRole = buildReverseMap(Array(roleToElementTypes), pins: reverseRolePins)

    /// Build the reverse map so the result never depends on the order of
    /// `entries`: Swift seeds Dictionary iteration per process, and "first
    /// mapping wins" made plain text report "heading" in some sessions
    /// (PILOT-365). A type listed under several roles gets its pinned role,
    /// or none at all if it has no pin.
    static func buildReverseMap(
        _ entries: [(key: String, value: [XCUIElement.ElementType])],
        pins: [XCUIElement.ElementType: String]
    ) -> [XCUIElement.ElementType: String] {
        var claims: [XCUIElement.ElementType: Set<String>] = [:]
        for (role, types) in entries {
            for type in types where type != .other {
                claims[type, default: []].insert(role)
            }
        }
        var map: [XCUIElement.ElementType: String] = [:]
        for (type, roles) in claims {
            if roles.count == 1 {
                map[type] = roles.first
            } else if let pinned = pins[type], roles.contains(pinned) {
                map[type] = pinned
            }
        }
        return map
    }

    /// Resolve a role name from an XCUIElement.ElementType.
    static func resolveRole(for elementType: XCUIElement.ElementType) -> String {
        return elementTypeToRole[elementType] ?? ""
    }

    /// Give every navigation title in a snapshot dictionary the header trait,
    /// so it is a heading wherever traits are read (`resolveRole`, `matches`,
    /// the dump). A navigation title is a static text directly in a
    /// `.navigationBar` whose label is the bar's identifier: UIKit and SwiftUI
    /// identify a navigation bar by its title. UIKit gives the title the
    /// header trait, but the iPhone Duo simulator (iOS 27) publishes it only
    /// some of the time — on launch, not after a pop or a deep link, and not
    /// always on two reads of the same screen (PILOT-1260). Any other text in
    /// the bar (a subtitle, a principal item) keeps its own traits.
    static func markNavigationTitles(in dict: inout [String: Any]) {
        guard var children = dict["children"] as? [[String: Any]], !children.isEmpty else { return }
        let title = elementType(of: dict) == .navigationBar ? dict["identifier"] as? String ?? "" : ""
        for i in children.indices {
            if !title.isEmpty, elementType(of: children[i]) == .staticText,
               children[i]["label"] as? String == title {
                children[i]["traits"] = traitBits(of: children[i]) | AccessibilityTrait.header
            }
            markNavigationTitles(in: &children[i])
        }
        dict["children"] = children
    }

    /// The element types a scroll view's indicators are children of: every
    /// UIScrollView (a WKWebView's included) a snapshot can show.
    static let scrollIndicatorParents: Set<XCUIElement.ElementType> = [
        .scrollView, .table, .collectionView, .webView, .textView,
    ]

    /// Take the adjustable trait off each scroll view's indicators ("Vertical
    /// scroll bar, 2 pages"): generic views with the adjustable trait, like a
    /// React Native `accessibilityRole="adjustable"` view, but no seekbar.
    /// The label that says what they are is localized; their place is not —
    /// a direct child of a scroll view (PILOT-1329). An adjustable RN view
    /// placed directly in a scroll view loses its role with them, as every
    /// adjustable view had none before.
    static func markScrollIndicators(in dict: inout [String: Any]) {
        guard var children = dict["children"] as? [[String: Any]], !children.isEmpty else { return }
        let parentScrolls = scrollIndicatorParents.contains(elementType(of: dict))
        for i in children.indices {
            if parentScrolls, elementType(of: children[i]) == .other {
                let traits = traitBits(of: children[i])
                if traits & AccessibilityTrait.adjustable != 0 {
                    children[i]["traits"] = traits & ~AccessibilityTrait.adjustable
                }
            }
            markScrollIndicators(in: &children[i])
        }
        dict["children"] = children
    }

    /// A snapshot dictionary's element type.
    private static func elementType(of dict: [String: Any]) -> XCUIElement.ElementType {
        let raw = (dict["elementType"] as? UInt) ?? (dict["elementType"] as? Int).map(UInt.init)
            ?? (dict["elementType"] as? NSNumber)?.uintValue ?? 0
        return XCUIElement.ElementType(rawValue: raw) ?? .other
    }

    /// The traits `SnapshotElementFinder.annotateTraits` spliced into a
    /// snapshot dictionary (0 when none were read), as its `extractTraits`
    /// reads them.
    static func traitBits(of dict: [String: Any]) -> UInt64 {
        switch dict["traits"] {
        case let v as UInt64: return v
        case let v as UInt: return UInt64(v)
        case let v as Int: return UInt64(bitPattern: Int64(v))
        case let v as NSNumber: return v.uint64Value
        default: return 0
        }
    }

    /// Whether an element is an item of a tab bar: a button with a `.tabBar`
    /// ancestor, the iPhone Duo's TabView host or the iPad's floating tab bar
    /// (`inTabBar`, `BarHost.holdsTab`). UIKit and SwiftUI tab bars expose
    /// their items as buttons, never as `.tab` elements, so this is how
    /// getByRole("tab") finds them (PILOT-514, PILOT-1260, PILOT-1282).
    static func isTabBarItem(_ elementType: XCUIElement.ElementType, inTabBar: Bool) -> Bool {
        inTabBar && elementType == .button
    }

    /// Resolve a role name, preferring an accessibility-trait override when
    /// the element carries one. React Native exposes `accessibilityRole` as
    /// a trait bit (e.g. UIAccessibilityTraitHeader for `accessibilityRole="header"`),
    /// and the trait carries semantic intent that the element type doesn't.
    /// `inTabBar` is whether the element has a `.tabBar` ancestor: a button
    /// there is a tab (`isTabBarItem`). `isEmptyBarHost`: whether it is the
    /// empty host iOS 27 lays over a screen with no toolbar
    /// (`BarHost.markHosts`, PILOT-1219), which is nothing a user can
    /// see and has no role. `isTabBarHost`: whether it is the iPhone Duo's
    /// TabView host or the iPad's floating tab bar (`BarHost.markHosts`,
    /// PILOT-1260, PILOT-1282), which is the tab bar.
    /// A live element can't tell either; its callers pass what was found
    /// with it. `label`: the element's label, whose line-broken "Tab 2 of 3"
    /// suffix makes a Flutter navigation destination a tab (`FlutterTab`).
    static func resolveRole(
        for elementType: XCUIElement.ElementType, traits: UInt64, inTabBar: Bool, isEmptyBarHost: Bool = false,
        isTabBarHost: Bool = false, label: String = ""
    ) -> String {
        typealias Trait = AccessibilityTrait

        if isEmptyBarHost { return "" }
        if isTabBarHost { return "tablist" }

        // Trait-derived semantic roles take priority — these are the ones an
        // app explicitly declares via `accessibilityRole`.
        if traits & Trait.header != 0 { return "heading" }
        if traits & Trait.link != 0 { return "link" }

        if isTabBarItem(elementType, inTabBar: inTabBar) || FlutterTab.name(of: label) != nil { return "tab" }

        // A text view that can't be edited is text on screen, not an input.
        if isReadOnlyTextView(elementType, traits: traits) {
            return traits & Trait.staticText != 0 ? "text" : ""
        }

        let typeRole = elementTypeToRole[elementType] ?? ""
        if !typeRole.isEmpty { return typeRole }

        // Generic .other elements with a role trait still convey role. The
        // search-field and adjustable traits name a generic view's role only
        // (`isGenericTraitRole`): a stepper, picker wheel or page indicator
        // is adjustable too, and an RN TextInput with role="search" is a
        // textfield, as on Android.
        if isGenericTraitRole(elementType) {
            if traits & Trait.searchField != 0 { return "searchfield" }
            if traits & Trait.adjustable != 0 { return "seekbar" }
        }
        if traits & Trait.button != 0 { return "button" }
        if traits & Trait.image != 0 { return "image" }

        return ""
    }

    /// Whether the search-field and adjustable traits give an element of this
    /// type its role: only a generic view (React Native's
    /// `accessibilityRole="adjustable"` or `"search"`) has no other. A web
    /// range input is a `.slider` already.
    static func isGenericTraitRole(_ elementType: XCUIElement.ElementType) -> Bool {
        elementType == .other
    }

    /// Whether `elementType` is a text view that can't be edited: no
    /// text-entry trait (`AccessibilityTrait.textEntry`). A multi-line input
    /// is a textfield, as Android's multi-line EditText is; a read-only text
    /// view (terms text, React Native's `<TextInput multiline
    /// editable={false} />`) is not one (PILOT-697). Traits of 0 mean they
    /// couldn't be read (SnapshotElementFinder.annotateTraits): the text view
    /// is then taken for the input it usually is.
    static func isReadOnlyTextView(_ elementType: XCUIElement.ElementType, traits: UInt64) -> Bool {
        elementType == .textView && traits != 0 && traits & AccessibilityTrait.textEntry == 0
    }

    /// Get the XCUIElement.ElementType values for a role name.
    /// - Throws: AgentError.invalidSelector if the role is unknown.
    static func elementTypes(for role: String) throws -> [XCUIElement.ElementType] {
        let normalized = roleAliases[role.lowercased()] ?? role.lowercased()
        guard let types = roleToElementTypes[normalized] else {
            let known = roleToElementTypes.keys.sorted().joined(separator: ", ")
            throw AgentError.invalidSelector("Unknown role: '\(role)'. Known roles: \(known)")
        }
        return types
    }

    /// The element types a type query must cover to find every element of
    /// `role`: its `roleToElementTypes` entry plus, for "tab", the buttons a
    /// tab bar's items are and the views a Flutter tab is, for "tablist" the bar host the iPhone Duo's
    /// TabView is (PILOT-1260; the iPad's floating tab bar is a generic
    /// `.other`, already a tablist type), and for "alert" the static text an RN `Text`
    /// is (`staticTextRoles`), and for "seekbar" and "searchfield" the generic
    /// view an RN adjustable or search view is (`isGenericTraitRole`,
    /// PILOT-1329). A coarse query — callers still filter by
    /// `matches` or by the tab-bar ancestry.
    /// - Throws: AgentError.invalidSelector if the role is unknown.
    static func queryTypes(for role: String) throws -> [XCUIElement.ElementType] {
        let types = try elementTypes(for: role)
        let canonical = normalize(role)
        // A Flutter tab is a button, static text or a generic view (FlutterTab).
        if canonical == "tab" { return types + [.button, .staticText, .other] }
        if canonical == "tablist" { return types + [.toolbar] }
        if staticTextRoles.contains(canonical) { return types + [.staticText] }
        if canonical == "seekbar" || canonical == "searchfield" { return types + [.other] }
        return types
    }

    /// Cross-platform role aliases — kept in sync with Android's
    /// `ROLE_ALIASES` map and the SDK's `normalizeRole`. Lets users pass
    /// either the React Native spelling ("header", "slider", "search") or the
    /// Tapsmith/Playwright canonical ("heading", "seekbar", "searchfield").
    ///
    /// **Parity contract:** this map MUST stay in sync with
    /// `packages/tapsmith/src/roles.ts ROLE_ALIASES` and
    /// `agent/app/.../ElementFinder.kt ROLE_ALIASES`;
    /// `packages/tapsmith/src/__tests__/roles.test.ts` reads all three
    /// and fails on drift. Drift causes silent per-platform mismatches
    /// where the SDK normalizes one way and this side reports the
    /// other, leading `toHaveRole` to either fail loudly or (worse)
    /// match the wrong element.
    static let roleAliases: [String: String] = [
        "header": "heading",
        "slider": "seekbar",
        "search": "searchfield",
        "radio": "radiobutton",
    ]

    /// Check if a UIAccessibilityTraits bitmask matches a role.
    /// This handles React Native components (Pressable, TouchableOpacity) that
    /// set accessibilityRole but render as generic UIViews (.other element type).
    static func matchesTrait(role: String, elementType: XCUIElement.ElementType, traits: UInt64) -> Bool {
        typealias Trait = AccessibilityTrait
        switch role.lowercased() {
        case "button": return traits & Trait.button != 0
        case "link": return traits & Trait.link != 0
        case "heading", "header": return traits & Trait.header != 0
        case "image": return traits & Trait.image != 0
        case "text": return traits & Trait.staticText != 0
        case "seekbar", "slider": return isGenericTraitRole(elementType) && traits & Trait.adjustable != 0
        case "searchfield": return isGenericTraitRole(elementType) && traits & Trait.searchField != 0
        default: return false
        }
    }

    // ─── Role matching (PILOT-608) ───

    /// The descriptions React Native puts first in a generic view's
    /// `accessibilityValue` for roles iOS has no trait for ("checkbox,
    /// unchecked"). The new architecture (Fabric) publishes the checkbox and
    /// radio ones; the old one (RCTView) also publishes alert and combobox.
    /// They are RN's English strings: a localized app publishes its own
    /// translation, which only a named query's fallback finds.
    static let otherRoleDescriptions: [String: String] = [
        "checkbox": "checkbox",
        "radiobutton": "radio button",
        "alert": "alert",
        "combobox": "combo box",
    ]

    /// React Native's other generic-view roles (PILOT-664). The new
    /// architecture — the only one from RN 0.82 — publishes no description
    /// for them (summary sets a trait `resolveRole` doesn't read), so only a
    /// named query finds one. The old architecture's descriptions ("menu
    /// item") aren't read: on the new one the same words are the app's own
    /// value text.
    static let undescribedOtherRoles: Set<String> = [
        "menu", "menubar", "menuitem", "radiogroup", "scrollbar", "spinbutton", "summary", "tablist", "timer",
    ]

    /// The generic-view roles a React Native `Text` also takes on iOS, where
    /// it is plain static text: Fabric publishes no trait or description for
    /// `<Text accessibilityRole="alert">`, so a static text is matched as a
    /// generic view is — by a description, or by a named query when no trait
    /// marks it as another role (PILOT-718). Only alert: a named checkbox,
    /// radio or menu item query would also match the label text beside one.
    static let staticTextRoles: Set<String> = ["alert"]

    /// Whether `role` (canonical) is matched on a generic view by its React
    /// Native description or, failing that, by a named query.
    private static func isGenericViewRole(_ canonical: String) -> Bool {
        otherRoleDescriptions[canonical] != nil || undescribedOtherRoles.contains(canonical)
    }

    /// The role names a selector may use for the same role, normalized to
    /// the canonical key of `roleToElementTypes`.
    static func normalize(_ role: String) -> String {
        let lowered = role.lowercased()
        return roleAliases[lowered] ?? lowered
    }

    /// Whether an element is `role`, as `getByRole` matches it.
    ///
    /// - heading: the header trait, on any element type. Static text alone is
    ///   "text"; querying `.staticText` as a heading over-matched every label.
    /// - checkbox, radiobutton, alert, combobox: their native type, if any, or
    ///   a generic `.other` view (for alert, also static text:
    ///   `staticTextRoles`) carrying that role's React Native description
    ///   (`otherRoleDescriptions`). A generic view without one is accepted
    ///   only by a named query — the name is then what identifies it — and
    ///   only when nothing marks it as another role (another of these
    ///   descriptions, or a trait `resolveRole` reads). RN's new architecture publishes nothing
    ///   for alert and combobox, so a name is the only way to find those.
    /// - RN's other generic-view roles (menuitem, tablist, timer, …): their
    ///   native type, if any, or — having no description — a named query
    ///   on a generic view, on the same terms (`undescribedOtherRoles`).
    /// - textfield: a text view only while it can be edited
    ///   (`isReadOnlyTextView`, PILOT-697).
    /// - tab: a `.tab` element or a tab bar's item (`isTabBarItem`; `inTabBar`
    ///   is whether the element has a `.tabBar` ancestor), or a Flutter
    ///   navigation destination, known by its `label` (`FlutterTab`). The bar
    ///   itself is a tablist (PILOT-514).
    /// - alert: also a native `.alert`; and nothing inside one but another
    ///   `.alert` (`inAlert`: the element has an `.alert` ancestor), so a
    ///   named query finds the alert, not also its title text (PILOT-919).
    /// - every other role: its element types, or its trait.
    /// - no role at all: iOS 27's empty toolbar host (`isEmptyBarHost`,
    ///   `BarHost.markHosts`, PILOT-1219). A host holding a toolbar's
    ///   items is the toolbar.
    /// - tablist and nothing else: the iPhone Duo's TabView host or the
    ///   iPad's floating tab bar (`isTabBarHost`, PILOT-1260, PILOT-1282),
    ///   whose buttons are tabs (`inTabBar`).
    static func matches(
        role: String,
        elementType: XCUIElement.ElementType,
        traits: UInt64,
        value: String?,
        hasNameFilter: Bool,
        inTabBar: Bool,
        inAlert: Bool,
        isEmptyBarHost: Bool = false,
        isTabBarHost: Bool = false,
        label: String = ""
    ) -> Bool {
        if isEmptyBarHost { return false }
        let canonical = normalize(role)
        if isTabBarHost { return canonical == "tablist" }
        if canonical == "alert" && inAlert && elementType != .alert {
            return false
        }
        if canonical == "heading" {
            return traits & AccessibilityTrait.header != 0
        }
        if canonical == "tab" {
            return elementType == .tab || isTabBarItem(elementType, inTabBar: inTabBar)
                || FlutterTab.name(of: label) != nil
        }
        if canonical == "textfield" && isReadOnlyTextView(elementType, traits: traits) {
            return false
        }
        guard let types = roleToElementTypes[canonical] else { return false }
        if isGenericViewRole(canonical) {
            let generic = elementType == .other || (elementType == .staticText && staticTextRoles.contains(canonical))
            if !generic { return types.contains(elementType) }
            if let described = describedRole(in: value) { return described == otherRoleDescriptions[canonical] }
            return hasNameFilter && resolveRole(for: .other, traits: traits, inTabBar: false, label: label).isEmpty
        }
        return types.contains(elementType) || matchesTrait(role: canonical, elementType: elementType, traits: traits)
    }

    /// The role description React Native leads a generic view's accessibility
    /// value with ("checkbox" in "checkbox, unchecked"), lowercased — or nil.
    /// Only the first part counts: the states and the app's own value text
    /// follow it, and a value text of "Alert" doesn't make a radio an alert.
    static func describedRole(in value: String?) -> String? {
        guard let first = value?.split(separator: ",", omittingEmptySubsequences: false).first else { return nil }
        let part = first.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return otherRoleDescriptions.values.contains(part) ? part : nil
    }

    /// The roles a generic view can match by a trait alone (`matchesTrait`):
    /// an RN Pressable is an `.other` with the button trait, an RN adjustable
    /// view an `.other` with the adjustable one. No query on the role's
    /// element types returns such a view.
    static let traitMatchedRoles: Set<String> = ["button", "link", "image", "text", "seekbar", "searchfield"]

    /// Whether a role-only match of this element type was matched by a trait
    /// rather than by its type, so a query on the role's types can't find it
    /// again and its live element is found by its own label instead.
    static func matchedByTraitOnly(role: String, elementType: XCUIElement.ElementType) -> Bool {
        let canonical = normalize(role)
        guard traitMatchedRoles.contains(canonical), let types = roleToElementTypes[canonical] else { return false }
        return !types.contains(elementType)
    }

    /// Each role-only match's index for the role's type query: among the
    /// matches before it that the query returns, so a trait-matched generic
    /// view (`matchedByTraitOnly`), which it never returns, doesn't shift a
    /// slider or button after it onto the next one (PILOT-1329). A role no
    /// trait can match keeps each match's own index.
    static func typeQueryIndices(role: String, matchTypes: [XCUIElement.ElementType]) -> [Int] {
        guard traitMatchedRoles.contains(normalize(role)) else { return Array(matchTypes.indices) }
        var typed = 0
        return matchTypes.map { type in
            let index = typed
            if !matchedByTraitOnly(role: role, elementType: type) { typed += 1 }
            return index
        }
    }

    /// Whether a role-only match must be found again as a live element by its
    /// own label (QueryIndex) rather than by a query on the role's element types:
    /// a type query can't express a trait, a description or an ancestor, so
    /// its positional index would count every static text (heading), look
    /// for a native type an RN app never has (checkbox), or miss a tab bar's
    /// buttons (tab).
    static func needsLabelReResolution(role: String) -> Bool {
        let canonical = normalize(role)
        return canonical == "heading" || canonical == "tab" || isGenericViewRole(canonical)
    }

    /// Convert an XCUIElement.ElementType to a string name for the className field.
    /// Uses the XCUIElementType naming convention (e.g., "XCUIElementTypeButton").
    static func typeName(for elementType: XCUIElement.ElementType) -> String {
        switch elementType {
        case .button: return "XCUIElementTypeButton"
        case .staticText: return "XCUIElementTypeStaticText"
        case .textField: return "XCUIElementTypeTextField"
        case .secureTextField: return "XCUIElementTypeSecureTextField"
        case .textView: return "XCUIElementTypeTextView"
        case .image: return "XCUIElementTypeImage"
        case .cell: return "XCUIElementTypeCell"
        case .table: return "XCUIElementTypeTable"
        case .collectionView: return "XCUIElementTypeCollectionView"
        case .scrollView: return "XCUIElementTypeScrollView"
        case .switch: return "XCUIElementTypeSwitch"
        case .toggle: return "XCUIElementTypeToggle"
        case .slider: return "XCUIElementTypeSlider"
        case .progressIndicator: return "XCUIElementTypeProgressIndicator"
        case .activityIndicator: return "XCUIElementTypeActivityIndicator"
        case .picker: return "XCUIElementTypePicker"
        case .pickerWheel: return "XCUIElementTypePickerWheel"
        case .stepper: return "XCUIElementTypeStepper"
        case .menu: return "XCUIElementTypeMenu"
        case .menuItem: return "XCUIElementTypeMenuItem"
        case .menuBar: return "XCUIElementTypeMenuBar"
        case .radioGroup: return "XCUIElementTypeRadioGroup"
        case .toolbar: return "XCUIElementTypeToolbar"
        case .tabBar: return "XCUIElementTypeTabBar"
        case .tab: return "XCUIElementTypeTab"
        case .link: return "XCUIElementTypeLink"
        case .checkBox: return "XCUIElementTypeCheckBox"
        case .radioButton: return "XCUIElementTypeRadioButton"
        case .searchField: return "XCUIElementTypeSearchField"
        case .navigationBar: return "XCUIElementTypeNavigationBar"
        case .webView: return "XCUIElementTypeWebView"
        case .window: return "XCUIElementTypeWindow"
        case .alert: return "XCUIElementTypeAlert"
        case .sheet: return "XCUIElementTypeSheet"
        case .other: return "XCUIElementTypeOther"
        // Named so a dump reads as what they are (the trace viewer also
        // accepts the raw `XCUIElementType(<n>)` older dumps carry).
        case .application: return "XCUIElementTypeApplication"
        case .keyboard: return "XCUIElementTypeKeyboard"
        case .key: return "XCUIElementTypeKey"
        default: return "XCUIElementType(\(elementType.rawValue))"
        }
    }
}
