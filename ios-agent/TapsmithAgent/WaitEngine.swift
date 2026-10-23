import XCTest
import Foundation

/// Event-driven waiting engine using XCUITest's built-in wait mechanisms.
///
/// Mirrors the Android agent's WaitEngine.kt with a 3-phase wait pattern:
/// 1. Wait for element existence (XCUIElement.waitForExistence)
/// 2. Wait for element to become enabled
/// 3. Wait for positional stability (bounds not changing)
class WaitEngine {
    private let app: XCUIApplication

    private static let stabilityWindowMs: UInt64 = 150
    /// Cumulative time a moving element's frame must hold steady before it's
    /// considered settled. Must be < stabilityWindowMs so the early-exit can
    /// fire within the window; the gap absorbs single dropped frames on slow
    /// CI simulators that would otherwise read as a false settle.
    private static let requiredStableSeconds: TimeInterval = 0.10
    private static let defaultIdleTimeout: TimeInterval = 5.0
    private static let defaultElementTimeout: TimeInterval = 10.0

    init(app: XCUIApplication) {
        self.app = app
    }

    /// Wait until the UI is idle.
    /// On iOS, there's no direct equivalent to Android's waitForIdle.
    /// We use a brief sleep to allow animations to settle. Keep this short
    /// since it blocks the single-threaded command handler.
    func waitForIdle(timeoutMs: Int64 = 5000) {
        let maxWait: TimeInterval = 0.25
        Thread.sleep(forTimeInterval: min(TimeInterval(timeoutMs) / 1000.0, maxWait))
    }

    /// Wait until an element matching the selector exists, is enabled, and positionally stable.
    ///
    /// - Parameters:
    ///   - selector: The element selector to wait for
    ///   - timeoutMs: Maximum time to wait in milliseconds
    ///   - elementFinder: The element finder for the final result
    /// - Returns: ElementInfo for the found element
    /// - Throws: AgentError.timeout if the element does not appear within timeout
    func waitForElement(
        _ selector: ElementSelector,
        timeoutMs: Int64 = 10000,
        elementFinder: ElementFinder,
        snapshotFinder: SnapshotElementFinder? = nil
    ) throws -> ElementInfo {
        let timeout = TimeInterval(timeoutMs) / 1000.0
        let startTime = CFAbsoluteTimeGetCurrent()

        // Build a query for event-driven waiting
        let query = buildWaitQuery(selector)
        let queryFullyRepresentsSelector = waitQueryFullyRepresentsSelector(selector)

        if let query = query {
            let element = query.firstMatch

            // Phase 1: Wait for the element to exist.
            // For short timeouts (e.g. assertion polling at 500ms), use
            // element.exists which is a fast snapshot check. For longer
            // timeouts, use waitForExistence which subscribes to
            // accessibility notifications for event-driven waiting.
            let exists: Bool
            if timeout < 1.0 {
                exists = element.exists
            } else {
                exists = element.waitForExistence(timeout: timeout)
            }
            if !exists {
                throw AgentError.timeout(
                    "Timed out after \(timeoutMs)ms waiting for element to exist. "
                    + "Selector: \(describeSelector(selector))"
                )
            }

            // Some wait queries are intentionally coarse. For example,
            // getByRole("switch", { checked: true }) can only be expressed
            // as "any switch" in XCUIElementQuery; state and accessible-name
            // filters are applied by the snapshot finder. Never return the
            // coarse match directly, or negative state assertions become
            // false positives.
            //
            // Nor a match inside the keyboard: a query can't leave the
            // keyboard out, so `getByText("Done")` would find its Done key.
            // The snapshot walk does (NonAppElements, PILOT-756).
            if !queryFullyRepresentsSelector || isInKeyboard(element) {
                return try resolveValidatedElement(
                    selector,
                    timeoutMs: timeoutMs,
                    elementFinder: elementFinder,
                    snapshotFinder: snapshotFinder
                )
            }

            // Skip Phase 2 (enabled check) and Phase 3 (stability check)
            // for short timeouts — the assertion polling loop handles retries.
            if timeout >= 1.0 {
                // Phase 2: Wait for the element to become enabled
                if !element.isEnabled {
                    let enabledDeadline = startTime + timeout
                    while CFAbsoluteTimeGetCurrent() < enabledDeadline {
                        if element.isEnabled { break }
                        Thread.sleep(forTimeInterval: 0.1)
                    }
                    if !element.isEnabled {
                        throw AgentError.timeout(
                            "Timed out after \(timeoutMs)ms: element exists but is not enabled. "
                            + "Selector: \(describeSelector(selector))"
                        )
                    }
                }

                // Phase 3: Verify positional stability.
                //
                // Most elements are already static by the time they're found, so
                // confirm with two frame reads and skip the settle wait when they
                // match. Sleep one display frame (~16ms at 60Hz) between the reads
                // so motion is detected reliably regardless of how fast the
                // accessibility query returns — it's sub-millisecond on native
                // UIKit/SwiftUI and fast simulators, where two back-to-back reads
                // would otherwise catch the same animation frame and falsely
                // report stability. Only when motion is detected do we pay the
                // bounded stability window, requiring a cumulative period of no
                // movement before proceeding — a single matching read isn't
                // enough, since a slow CI simulator can drop a frame mid-animation
                // and momentarily look static. Capped by stabilityWindowMs so a
                // genuinely-animating element can't block past the original budget.
                let firstFrame = element.frame
                Thread.sleep(forTimeInterval: 0.016)
                let secondFrame = element.frame
                if firstFrame != secondFrame {
                    var lastFrame = secondFrame
                    // Monotonic clock: unaffected by wall-clock/NTP adjustments
                    // that could otherwise skew this elapsed-time loop.
                    let now0 = ProcessInfo.processInfo.systemUptime
                    var stableSince = now0
                    let stabilityDeadline = now0 + Double(Self.stabilityWindowMs) / 1000.0
                    while ProcessInfo.processInfo.systemUptime < stabilityDeadline {
                        Thread.sleep(forTimeInterval: 0.03)
                        let currentFrame = element.frame
                        let now = ProcessInfo.processInfo.systemUptime
                        if currentFrame != lastFrame {
                            stableSince = now
                        } else if now - stableSince >= Self.requiredStableSeconds {
                            break
                        }
                        lastFrame = currentFrame
                    }
                }
            }

            // Cache and return the element we already found — avoid a redundant
            // full tree traversal which can take 10+ seconds on React Native.
            return elementFinder.cacheElement(element)
        } else {
            // For selectors we can't express as a query (e.g., xpath, hint),
            // use a brief idle wait then check
            waitForIdle(timeoutMs: min(timeoutMs, 2000))
        }

        // Fallback: full lookup for selectors that don't have efficient queries
        // or that need filters unavailable to XCUIElementQuery.
        return try resolveValidatedElement(
            selector,
            timeoutMs: timeoutMs,
            elementFinder: elementFinder,
            snapshotFinder: snapshotFinder
        )
    }

    private func resolveValidatedElement(
        _ selector: ElementSelector,
        timeoutMs: Int64,
        elementFinder: ElementFinder,
        snapshotFinder: SnapshotElementFinder?
    ) throws -> ElementInfo {
        do {
            if let snapshotFinder = snapshotFinder {
                return try snapshotFinder.findElement(selector)
            }
            return try elementFinder.findElement(selector)
        } catch {
            throw AgentError.timeout(
                "Timed out after \(timeoutMs)ms: element not found after waiting. "
                + "Selector: \(describeSelector(selector))"
            )
        }
    }

    /// Whether a live query's `element` is part of the software keyboard
    /// (NonAppElements.liesInKeyboard). Costs a keyboard query, and two
    /// frame reads when a keyboard is up — only on this wait path.
    private func isInKeyboard(_ element: XCUIElement) -> Bool {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return false }
        return NonAppElements.liesInKeyboard(element.frame, keyboardFrame: keyboard.frame)
    }

    /// Build an XCUIElementQuery from a selector for use with waitForExistence,
    /// never returning the hooks marker (NonAppElements). Returns nil if the
    /// selector type cannot be expressed as a direct query.
    private func buildWaitQuery(_ selector: ElementSelector) -> XCUIElementQuery? {
        buildSelectorQuery(selector)?.excludingHooksMarker()
    }

    private func buildSelectorQuery(_ selector: ElementSelector) -> XCUIElementQuery? {
        if let text = selector.text {
            return app.descendants(matching: .any)
                .matching(NSPredicate(format: "label MATCHES %@", TextMatch.exactPattern(text)))
        }
        if let textContains = selector.textContains {
            return app.descendants(matching: .any)
                .matching(NSPredicate(format: "label MATCHES %@", TextMatch.containsPattern(textContains)))
        }
        if let contentDesc = selector.contentDesc {
            return app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", contentDesc))
        }
        if let id = selector.id {
            return app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", id))
        }
        if let testId = selector.testId {
            return app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", testId))
        }
        if let className = selector.className {
            return app.descendants(matching: .any).matching(
                NSPredicate(format: "elementType == %d", elementTypeRawValue(className))
            )
        }
        if let role = selector.role {
            // queryTypes: a tab is also a tab bar's button (PILOT-514); the
            // snapshot finder then checks the ancestry.
            if let types = try? RoleMapping.queryTypes(for: role), !types.isEmpty {
                let rawValues = types.map { NSNumber(value: $0.rawValue) }
                let predicate = NSPredicate(format: "elementType IN %@", rawValues)
                return app.descendants(matching: .any).matching(predicate)
            }
        }
        // xpath, hint cannot be expressed as simple queries
        return nil
    }

    /// Whether any element returned by buildWaitQuery is guaranteed to satisfy
    /// the complete selector without a second pass through the snapshot matcher.
    private func waitQueryFullyRepresentsSelector(_ selector: ElementSelector) -> Bool {
        if selector.role != nil { return false }
        if selector.name != nil { return false }
        if selector.enabled != nil || selector.checked != nil || selector.focused != nil
            || selector.selected != nil || selector.expanded != nil {
            return false
        }

        let positiveSelectorCount = [
            selector.text,
            selector.textContains,
            selector.contentDesc,
            selector.hint,
            selector.className,
            selector.testId,
            selector.id,
            selector.xpath,
            selector.label,
        ].filter { $0 != nil }.count

        return positiveSelectorCount == 1
    }

    /// Get the raw value for an element type name.
    private func elementTypeRawValue(_ className: String) -> UInt {
        // Map className strings (both XCUIElementType names and common short names)
        // to XCUIElement.ElementType raw values. Aligns with RoleMapping.typeName.
        switch className {
        case "XCUIElementTypeButton", "button":
            return XCUIElement.ElementType.button.rawValue
        case "XCUIElementTypeStaticText", "statictext", "textview":
            return XCUIElement.ElementType.staticText.rawValue
        case "XCUIElementTypeTextField", "textfield", "edittext":
            return XCUIElement.ElementType.textField.rawValue
        case "XCUIElementTypeSecureTextField":
            return XCUIElement.ElementType.secureTextField.rawValue
        case "XCUIElementTypeImage", "image", "imageview":
            return XCUIElement.ElementType.image.rawValue
        case "XCUIElementTypeSwitch", "switch":
            return XCUIElement.ElementType.switch.rawValue
        case "XCUIElementTypeToggle":
            return XCUIElement.ElementType.toggle.rawValue
        case "XCUIElementTypeSlider", "slider":
            return XCUIElement.ElementType.slider.rawValue
        case "XCUIElementTypeCell", "cell":
            return XCUIElement.ElementType.cell.rawValue
        case "XCUIElementTypeTable", "table":
            return XCUIElement.ElementType.table.rawValue
        case "XCUIElementTypeCollectionView":
            return XCUIElement.ElementType.collectionView.rawValue
        case "XCUIElementTypeScrollView", "scrollview":
            return XCUIElement.ElementType.scrollView.rawValue
        case "XCUIElementTypeSearchField", "searchfield":
            return XCUIElement.ElementType.searchField.rawValue
        case "XCUIElementTypeTextView":
            return XCUIElement.ElementType.textView.rawValue
        case "XCUIElementTypePicker":
            return XCUIElement.ElementType.picker.rawValue
        case "XCUIElementTypeProgressIndicator":
            return XCUIElement.ElementType.progressIndicator.rawValue
        case "XCUIElementTypeActivityIndicator":
            return XCUIElement.ElementType.activityIndicator.rawValue
        case "XCUIElementTypeToolbar":
            return XCUIElement.ElementType.toolbar.rawValue
        case "XCUIElementTypeTabBar":
            return XCUIElement.ElementType.tabBar.rawValue
        case "XCUIElementTypeTab":
            return XCUIElement.ElementType.tab.rawValue
        case "XCUIElementTypeLink":
            return XCUIElement.ElementType.link.rawValue
        case "XCUIElementTypeCheckBox":
            return XCUIElement.ElementType.checkBox.rawValue
        case "XCUIElementTypeRadioButton":
            return XCUIElement.ElementType.radioButton.rawValue
        case "XCUIElementTypeOther":
            return XCUIElement.ElementType.other.rawValue
        default:
            return XCUIElement.ElementType.any.rawValue
        }
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
}
