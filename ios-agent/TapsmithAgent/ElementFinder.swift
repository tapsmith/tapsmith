import XCTest
import Foundation

/// Finds UI elements using XCUITest queries.
///
/// Mirrors the Android agent's ElementFinder.kt. Supports selector strategies:
/// role, text, contentDesc, className, testId, resourceId (identifier), xpath.
/// Maintains a cache of found elements so they can be referenced by ID.
class ElementFinder {
    private let app: XCUIApplication
    private var elementCache: [String: XCUIElement] = [:]
    private var cacheOrder: [String] = []
    private let lock = NSLock()

    /// Maximum number of cached elements before eviction. Kept high so a
    /// broad query's own matches (plus the pre-action trace capture) cannot
    /// evict ids the SDK is about to act on.
    private let maxCacheSize = 2000

    /// Clear all caches (call after app relaunch).
    func clearCaches() {
        lock.lock()
        elementCache.removeAll()
        cacheOrder.removeAll()
        lock.unlock()
    }

    /// Evict oldest entries when the cache exceeds `maxCacheSize`.
    /// Must be called while `lock` is held.
    private func pruneCacheLocked() {
        while elementCache.count > maxCacheSize, !cacheOrder.isEmpty {
            let oldest = cacheOrder.removeFirst()
            elementCache.removeValue(forKey: oldest)
        }
    }

    /// Screen dimensions for viewport ratio calculation.
    private var screenSize: CGSize {
        return app.windows.firstMatch.frame.size
    }

    init(app: XCUIApplication) {
        self.app = app
    }

    // MARK: - Public API

    /// Find a single element matching the selector.
    /// - Throws: AgentError.elementNotFound if no element matches.
    func findElement(_ selector: ElementSelector, parentId: String? = nil) throws -> ElementInfo {
        let elements = try findElements(selector, parentId: parentId)
        guard let first = elements.first else {
            throw AgentError.elementNotFound("No element found matching: \(describeSelector(selector))")
        }
        return first
    }

    /// Find all elements matching the selector.
    func findElements(_ selector: ElementSelector, parentId: String? = nil) throws -> [ElementInfo] {
        if let regexError = selector.regexError {
            throw AgentError.invalidSelector(regexError)
        }
        if let xpath = selector.xpath {
            return try findByXPath(xpath)
        }

        let root: XCUIElement
        if let parentId = parentId {
            guard let parent = getCachedElement(parentId) else {
                throw AgentError.elementNotFound("Parent element '\(parentId)' not found in cache")
            }
            root = parent
        } else {
            root = app
        }

        let xcElements = try findXCUIElements(selector, in: root)

        // Apply additional attribute filters
        let filtered = xcElements.filter { elem in
            if let wantEnabled = selector.enabled, elem.isEnabled != wantEnabled { return false }
            if let wantChecked = selector.checked {
                let isChecked = checkedState(
                    for: elem.elementType,
                    value: elem.value as? String,
                    selected: elem.isSelected
                )
                if isChecked != wantChecked { return false }
            }
            if let wantFocused = selector.focused, elem.hasFocus != wantFocused { return false }
            if let wantSelected = selector.selected, elem.isSelected != wantSelected { return false }
            if let wantExpanded = selector.expanded {
                let val = (elem.value as? String ?? "").lowercased()
                let isExpanded = val.contains("expanded")
                if isExpanded != wantExpanded { return false }
            }
            return true
        }

        return filtered.map { cacheAndConvert($0) }
    }

    /// Get a cached XCUIElement by its stable ID.
    /// - Throws: AgentError.elementNotFound if the ID is not in the cache.
    func getElement(_ elementId: String) throws -> XCUIElement {
        guard let elem = getCachedElement(elementId) else {
            throw AgentError.elementNotFound("Element '\(elementId)' not found. It may have gone stale.")
        }
        return elem
    }

    /// Get the ElementInfo for a cached element, reading its current properties.
    func getElementInfo(_ elementId: String) throws -> ElementInfo {
        let elem = try getElement(elementId)
        return toElementInfo(elem, elementId: elementId)
    }

    // MARK: - Element Finding

    private func findXCUIElements(_ selector: ElementSelector, in root: XCUIElement) throws -> [XCUIElement] {
        var results: [XCUIElement] = []

        // Role-based selection
        if let role = selector.role {
            let types = try RoleMapping.elementTypes(for: role)
            for type in types {
                let query = root.descendants(matching: type)
                let matches = allElements(from: query)
                results.append(contentsOf: matches)
            }

            // Filter by accessible name if provided
            if let name = selector.name {
                results = results.filter { elem in
                    TextMatch.nameMatches(elem.label, name, exact: selector.nameExact)
                        || TextMatch.nameMatches(elem.title, name, exact: selector.nameExact)
                }
            } else if let nameRegex = selector.nameRegex {
                results = results.filter { elem in
                    nameRegex.nameMatches(elem.label) || nameRegex.nameMatches(elem.title)
                }
            }
            return results
        }

        // Text selector — search across all element types
        if let text = selector.text {
            let predicate = NSPredicate(format: "label MATCHES %@", TextMatch.exactPattern(text))
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // TextContains selector
        if let textContains = selector.textContains {
            let predicate = NSPredicate(format: "label MATCHES %@", TextMatch.containsPattern(textContains))
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // getByText(RegExp) (PILOT-520): the raw label, title or value, as the
        // snapshot walk tests it.
        if let textRegex = selector.textRegex {
            let pattern = textRegex.fullMatchPattern
            let predicate = NSPredicate(
                format: "label MATCHES %@ OR title MATCHES %@ OR value MATCHES %@",
                pattern, pattern, pattern
            )
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // ContentDesc selector (maps to accessibilityLabel on iOS)
        if let contentDesc = selector.contentDesc {
            let predicate = NSPredicate(format: "label == %@", contentDesc)
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // Hint selector (maps to placeholderValue on iOS)
        if let hint = selector.hint {
            let predicate = NSPredicate(format: "placeholderValue == %@", hint)
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // TestId selector (maps to accessibilityIdentifier on iOS)
        if let testId = selector.testId {
            let predicate = NSPredicate(format: "identifier == %@", testId)
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // ResourceId / id selector (also maps to accessibilityIdentifier on iOS)
        if let id = selector.id {
            let predicate = NSPredicate(format: "identifier == %@", id)
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // ClassName selector (maps to XCUIElement.ElementType)
        if let className = selector.className {
            if let type = elementTypeFromClassName(className) {
                let query = root.descendants(matching: type)
                return allElements(from: query)
            }
            // If className doesn't map to a known type, return empty
            return []
        }

        // Label selector: input elements whose label or title matches
        // (LabelMatch). Single query on .any avoids multiple expensive IPC
        // calls per element type.
        if let label = selector.label {
            let pattern = TextMatch.exactPattern(label)
            let predicate = NSPredicate(format: "label MATCHES %@ OR title MATCHES %@", pattern, pattern)
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query).filter { LabelMatch.inputTypes.contains($0.elementType) }
        }
        if let labelRegex = selector.labelRegex {
            let pattern = labelRegex.fullMatchPattern
            let predicate = NSPredicate(format: "label MATCHES %@ OR title MATCHES %@", pattern, pattern)
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query).filter { LabelMatch.inputTypes.contains($0.elementType) }
        }

        throw AgentError.invalidSelector("No valid selector criteria provided")
    }

    // MARK: - XPath

    /// Find elements by evaluating an XPath expression against the accessibility hierarchy.
    /// Note: XMLDocument/XPath is not available on iOS. XPath selectors are not supported.
    /// Users should prefer role(), text(), testId(), or other selector types on iOS.
    private func findByXPath(_ xpath: String) throws -> [ElementInfo] {
        // XMLDocument and XPath evaluation are macOS-only APIs (not available on iOS).
        // XPath is rarely used in practice — most selectors use role, text, or testId.
        throw AgentError.invalidSelector(
            "XPath selectors are not supported on iOS. "
            + "Use role(), text(), testId(), contentDesc(), or other selector types instead."
        )
    }

    // MARK: - Caching

    private func getCachedElement(_ elementId: String) -> XCUIElement? {
        lock.lock()
        defer { lock.unlock() }
        let cached = elementCache[elementId]
        if cached != nil {
            promoteToMostRecentlyUsed(&cacheOrder, elementId)
        }
        return cached
    }

    /// Cache an XCUIElement and return its ElementInfo. Called by WaitEngine
    /// to avoid redundant tree traversals after waitForExistence succeeds.
    func cacheElement(_ element: XCUIElement) -> ElementInfo {
        return cacheAndConvert(element)
    }

    private func cacheAndConvert(_ element: XCUIElement) -> ElementInfo {
        let elementId = UUID().uuidString
        lock.lock()
        elementCache[elementId] = element
        cacheOrder.append(elementId)
        pruneCacheLocked()
        lock.unlock()
        return toElementInfo(element, elementId: elementId)
    }

    // MARK: - Conversion

    private func toElementInfo(_ element: XCUIElement, elementId: String) -> ElementInfo {
        let frame = element.frame
        let bounds = ElementBounds(
            left: Int(frame.origin.x),
            top: Int(frame.origin.y),
            right: Int(frame.origin.x + frame.size.width),
            bottom: Int(frame.origin.y + frame.size.height)
        )
        let viewportRatio = computeViewportRatio(bounds)
        // Delegated to the shared factory in ElementInfo.swift so this
        // path can't drift from the sibling SnapshotElementFinder
        // implementation. Earlier the two methods diverged on `text`
        // (round 7), `checkedState` (round 8), and trait-aware role
        // resolution (round cold-4); consolidating here prevents that
        // class of regression.
        return ElementInfo.makeFromXCUIElement(
            element,
            elementId: elementId,
            bounds: bounds,
            viewportRatio: viewportRatio,
            // This query-based finder (xpath, parentId and the wait engine's
            // fast path) never knows an element's ancestors, so it can't tell
            // a tab bar's button from any other; the snapshot finder can
            // (PILOT-514).
            inTabBar: false
        )
    }

    // MARK: - Helpers

    private func computeViewportRatio(_ bounds: ElementBounds) -> Float {
        let screen = screenSize
        let screenRect = CGRect(x: 0, y: 0, width: screen.width, height: screen.height)
        let elemRect = CGRect(
            x: CGFloat(bounds.left),
            y: CGFloat(bounds.top),
            width: CGFloat(bounds.width),
            height: CGFloat(bounds.height)
        )

        let elementArea = elemRect.width * elemRect.height
        guard elementArea > 0 else { return 0 }

        let intersection = screenRect.intersection(elemRect)
        guard !intersection.isNull else { return 0 }

        let intersectionArea = intersection.width * intersection.height
        return Float(min(max(intersectionArea / elementArea, 0), 1))
    }

    /// Extract all concrete elements from an XCUIElementQuery, leaving out
    /// the hooks marker (NonAppElements). A scoped find starts from an
    /// element some locator found, which is never the application or the
    /// keyboard, so the keyboard's keys are not under it.
    private func allElements(from query: XCUIElementQuery) -> [XCUIElement] {
        let query = query.excludingHooksMarker()
        let count = query.count
        guard count > 0 else { return [] }
        var elements: [XCUIElement] = []
        for i in 0..<count {
            let elem = query.element(boundBy: i)
            if elem.exists {
                elements.append(elem)
            }
        }
        return elements
    }

    /// Map a className string (e.g., "XCUIElementTypeButton") to an ElementType.
    private func elementTypeFromClassName(_ className: String) -> XCUIElement.ElementType? {
        // Try direct mapping from known type names
        let typeMap: [String: XCUIElement.ElementType] = [
            "XCUIElementTypeButton": .button,
            "XCUIElementTypeStaticText": .staticText,
            "XCUIElementTypeTextField": .textField,
            "XCUIElementTypeSecureTextField": .secureTextField,
            "XCUIElementTypeTextView": .textView,
            "XCUIElementTypeImage": .image,
            "XCUIElementTypeCell": .cell,
            "XCUIElementTypeTable": .table,
            "XCUIElementTypeCollectionView": .collectionView,
            "XCUIElementTypeScrollView": .scrollView,
            "XCUIElementTypeSwitch": .switch,
            "XCUIElementTypeToggle": .toggle,
            "XCUIElementTypeSlider": .slider,
            "XCUIElementTypeProgressIndicator": .progressIndicator,
            "XCUIElementTypeActivityIndicator": .activityIndicator,
            "XCUIElementTypePicker": .picker,
            "XCUIElementTypeStepper": .stepper,
            "XCUIElementTypeToolbar": .toolbar,
            "XCUIElementTypeTabBar": .tabBar,
            "XCUIElementTypeTab": .tab,
            "XCUIElementTypeLink": .link,
            "XCUIElementTypeCheckBox": .checkBox,
            "XCUIElementTypeRadioButton": .radioButton,
            "XCUIElementTypeSearchField": .searchField,
            "XCUIElementTypeNavigationBar": .navigationBar,
            "XCUIElementTypeWebView": .webView,
            "XCUIElementTypeWindow": .window,
            "XCUIElementTypeAlert": .alert,
            "XCUIElementTypeOther": .other,
        ]
        return typeMap[className]
    }

    /// Parse a bounds string in [left,top][right,bottom] format.
    private func parseBoundsString(_ str: String) -> ElementBounds {
        let pattern = "\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: str, range: NSRange(str.startIndex..., in: str)),
              match.numberOfRanges == 5
        else {
            return ElementBounds(left: 0, top: 0, right: 0, bottom: 0)
        }

        func intAt(_ i: Int) -> Int {
            let range = Range(match.range(at: i), in: str)!
            return Int(str[range]) ?? 0
        }
        return ElementBounds(left: intAt(1), top: intAt(2), right: intAt(3), bottom: intAt(4))
    }

    private func describeSelector(_ selector: ElementSelector) -> String {
        var parts: [String] = []
        if let v = selector.role { parts.append("role=\(v)") }
        if let v = selector.name { parts.append("name=\(v)") }
        if selector.name != nil && selector.nameExact { parts.append("exact=true") }
        if let v = selector.nameRegex { parts.append("name=\(v.display)") }
        if let v = selector.text { parts.append("text=\(v)") }
        if let v = selector.textContains { parts.append("textContains=\(v)") }
        if let v = selector.textRegex { parts.append("text=\(v.display)") }
        if let v = selector.labelRegex { parts.append("label=\(v.display)") }
        if let v = selector.contentDesc { parts.append("contentDesc=\(v)") }
        if let v = selector.hint { parts.append("hint=\(v)") }
        if let v = selector.className { parts.append("className=\(v)") }
        if let v = selector.testId { parts.append("testId=\(v)") }
        if let v = selector.id { parts.append("id=\(v)") }
        if let v = selector.xpath { parts.append("xpath=\(v)") }
        return parts.joined(separator: ", ")
    }

    /// Thin delegate to the shared canonical implementation.
    private func checkedState(
        for elementType: XCUIElement.ElementType,
        value: String?,
        selected: Bool
    ) -> Bool {
        ElementInfo.deriveCheckedState(
            elementType: elementType,
            value: value,
            selected: selected
        )
    }
}
