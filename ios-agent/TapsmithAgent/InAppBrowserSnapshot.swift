import XCTest

/// Reading an in-app browser's content into the app's snapshot
/// (`InAppBrowser`, PILOT-1384).
extension InAppBrowser {
    /// Whether `snapshot` is blank (`isBlank`).
    static func isBlank(_ snapshot: XCUIElementSnapshot) -> Bool {
        isBlank(
            snapshot,
            children: { $0.children },
            elementType: { $0.elementType },
            texts: { [$0.label, $0.identifier, ($0.value as? String) ?? ""] }
        )
    }

    /// `snapshot` with an in-app browser's content attached, when the app is
    /// showing one that it left out; otherwise `snapshot` itself.
    ///
    /// **Cost:** nothing when the tree is not blank. A blank tree reads
    /// SafariViewService's state (no IPC to the app) and, when it is in the
    /// foreground, makes one query: ~0.2–0.5 s when the browser is up, up to
    /// the accessibility timeout when it is not (a browser that has just
    /// gone, a blank screen of the app's own while one is up elsewhere). The
    /// query is skipped when it could not finish before `deadline`.
    static func complete(
        _ snapshot: XCUIElementSnapshot,
        app: XCUIApplication,
        deadline: Date?
    ) -> XCUIElementSnapshot {
        // The cheap checks first: a real screen is never blank, and the
        // service's state is XCTest's, read without asking the app.
        guard isBlank(snapshot),
              shouldLook(
                  blank: true,
                  serviceInForeground: XCUIApplication(bundleIdentifier: serviceBundleId).state == .runningForeground,
                  now: Date(),
                  deadline: deadline,
                  lookCost: AccessibilityTimeout.seconds + 0.5
              )
        else { return snapshot }
        let root = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", rootIdentifierPrefix))
            .firstMatch
        guard let browser = try? root.snapshot() else { return snapshot }
        NSLog("[InAppBrowser] The app's tree stops at an in-app browser; attaching its content")
        return attach(browser, to: snapshot)
    }

    /// `root` with `content` as the last child of its first window (drawn
    /// over the rest of it), or of `root` itself when it has no window.
    static func attach(_ content: XCUIElementSnapshot, to root: XCUIElementSnapshot) -> XCUIElementSnapshot {
        var children = root.children
        if let index = children.firstIndex(where: { $0.elementType == .window }) {
            let window = children[index]
            children[index] = AttachedSnapshot(base: window, children: window.children + [content])
        } else {
            children.append(content)
        }
        return AttachedSnapshot(base: root, children: children)
    }
}

/// A snapshot node with other children: `base`'s attributes and traits, and
/// `children` in place of its own (`InAppBrowser.attach`).
final class AttachedSnapshot: NSObject, XCUIElementSnapshot {
    private let base: XCUIElementSnapshot
    let children: [XCUIElementSnapshot]

    init(base: XCUIElementSnapshot, children: [XCUIElementSnapshot]) {
        self.base = base
        self.children = children
    }

    var dictionaryRepresentation: [XCUIElement.AttributeName: Any] {
        var dict = base.dictionaryRepresentation
        dict[XCUIElement.AttributeName(rawValue: "children")] = children.map { $0.dictionaryRepresentation }
        return dict
    }

    /// The base node's traits, read as `AccessibilityTrait.read` reads a
    /// snapshot's (XCTest's private `traits`).
    @objc var traits: NSNumber? {
        AccessibilityTrait.read(from: base).map { NSNumber(value: $0) }
    }

    var identifier: String { base.identifier }
    var frame: CGRect { base.frame }
    var value: Any? { base.value }
    var title: String { base.title }
    var label: String { base.label }
    var elementType: XCUIElement.ElementType { base.elementType }
    var isEnabled: Bool { base.isEnabled }
    var horizontalSizeClass: XCUIElement.SizeClass { base.horizontalSizeClass }
    var verticalSizeClass: XCUIElement.SizeClass { base.verticalSizeClass }
    var placeholderValue: String? { base.placeholderValue }
    var isSelected: Bool { base.isSelected }
    var hasFocus: Bool { base.hasFocus }
}
