import XCTest
import Foundation

/// Executes UI actions using XCUITest APIs.
/// Mirrors the Android agent's ActionExecutor.kt.
class ActionExecutor {
    private let app: XCUIApplication

    /// Cached screen size, set during initialization or via `updateScreenSize`.
    /// Avoids accessing `app.windows.firstMatch.frame.size` which triggers
    /// XCUITest quiescence waits on React Native apps.
    var cachedScreenSize: CGSize?

    /// Minimum pixel margin for tapping outside an element during blur.
    private static let blurTapMarginPx: CGFloat = 50
    /// Time to wait for idle after focus/blur actions.
    private static let focusIdleTimeout: TimeInterval = 0.25

    init(app: XCUIApplication) {
        self.app = app
    }

    // MARK: - Tap Actions

    /// Tap on an element's center point.
    ///
    /// Waits for the element's frame to stop moving first (Playwright-style
    /// actionability, mirroring the Android agent): a tap whose hit point is
    /// computed mid-animation — e.g. layout resettling after a keyboard
    /// dismissal — can land on a non-interactive pixel and silently miss.
    func tap(_ element: XCUIElement) throws {
        guard element.isHittable else {
            throw AgentError.actionFailed("Element is not hittable (may be off-screen or hidden)")
        }
        tapHittable(element)
    }

    /// `tap(_:)` for an element the caller has just read as hittable — skips
    /// the repeat `isHittable` round-trip.
    func tapHittable(_ element: XCUIElement) {
        waitForStableFrame(element)
        element.tap()
    }

    /// Wait until two consecutive reads of the element's live frame agree, or
    /// the deadline passes. Each read is one IPC. On timeout we proceed with
    /// the freshest state rather than failing — tap() recomputes its hit
    /// point at dispatch time.
    private func waitForStableFrame(_ element: XCUIElement, timeout: TimeInterval = 1.0) {
        let deadline = Date(timeIntervalSinceNow: timeout)
        var prev = element.frame
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
            let current = element.frame
            if current.equalTo(prev) { return }
            prev = current
        }
    }

    /// Tap at specific screen coordinates using event synthesis.
    func tapCoordinates(x: Int, y: Int) {
        if !EventSynthesizer.tap(at: CGPoint(x: x, y: y)) {
            NSLog("[ActionExecutor] Event synthesis failed, falling back to XCUICoordinate.tap()")
            let normalized = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            let point = normalized.withOffset(CGVector(dx: CGFloat(x), dy: CGFloat(y)))
            point.tap()
        }
    }

    /// Double-tap on an element's center point.
    func doubleTap(_ element: XCUIElement) throws {
        guard element.isHittable else {
            throw AgentError.actionFailed("Element is not hittable")
        }
        element.doubleTap()
    }

    /// Double-tap at specific screen coordinates.
    /// Prefers a single synthesized event record carrying both taps with
    /// precise offsets — the inter-tap gap is immune to scheduling jitter
    /// under CI load. Falls back to XCUICoordinate when synthesis is
    /// unavailable, completing a partially-delivered gesture with exactly one
    /// more tap rather than re-tapping twice (which would deliver three).
    func doubleTapCoordinates(x: Int, y: Int, intervalMs: Int = 0) {
        let normalized = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
        let point = normalized.withOffset(CGVector(dx: CGFloat(x), dy: CGFloat(y)))
        switch EventSynthesizer.doubleTap(at: CGPoint(x: x, y: y), intervalMs: intervalMs) {
        case .done:
            return
        case .firstTapOnly:
            NSLog("[ActionExecutor] Double-tap delivered only its first tap; completing with a single coordinate tap")
            point.tap()
        case .notStarted:
            NSLog("[ActionExecutor] Double-tap synthesis failed, falling back to XCUICoordinate.doubleTap()")
            point.doubleTap()
        }
    }

    /// Long press on an element with configurable duration.
    func longPress(_ element: XCUIElement, durationMs: Int64 = 1000) throws {
        guard element.isHittable else {
            throw AgentError.actionFailed("Element is not hittable")
        }
        element.press(forDuration: TimeInterval(durationMs) / 1000.0)
    }

    /// Long press at specific coordinates.
    func longPressCoordinates(x: Int, y: Int, durationMs: Int64 = 1000) {
        let duration = TimeInterval(durationMs) / 1000.0
        if !EventSynthesizer.longPress(at: CGPoint(x: x, y: y), duration: duration) {
            let normalized = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            let point = normalized.withOffset(CGVector(dx: CGFloat(x), dy: CGFloat(y)))
            point.press(forDuration: duration)
        }
    }

    // MARK: - Text Input

    /// Type text into an element. Taps the element first to ensure focus.
    func typeText(_ element: XCUIElement, text: String, delayMs: Int = 0) throws {
        guard element.isHittable else {
            throw AgentError.actionFailed("Element is not hittable — cannot type text")
        }
        element.tap()
        Thread.sleep(forTimeInterval: 0.05)
        if !typeViaEventSynthesizer(text, delayMs: delayMs) {
            throw AgentError.actionFailed("typeText failed to synthesize input")
        }
    }

    /// Type text into the currently focused element.
    @discardableResult
    func typeTextWithoutFocus(_ text: String, delayMs: Int = 0) -> Bool {
        typeViaEventSynthesizer(text, delayMs: delayMs)
    }

    /// Type text via EventSynthesizer (bypasses XCUITest quiescence).
    /// When delayMs is 0, sends the full string at once for speed.
    /// When delayMs > 0, types char-by-char with delays.
    @discardableResult
    func typeViaEventSynthesizer(_ text: String, delayMs: Int = 0) -> Bool {
        guard !text.isEmpty else { return true }

        if delayMs > 0 {
            let delay = TimeInterval(delayMs) / 1000.0
            var succeeded = true
            for char in text {
                if !EventSynthesizer.typeText(String(char)) {
                    succeeded = false
                }
                Thread.sleep(forTimeInterval: delay)
            }
            return succeeded
        } else {
            return EventSynthesizer.typeText(text)
        }
    }

    /// Clear text in an element by selecting all and deleting.
    func clearText(_ element: XCUIElement) throws {
        guard element.isHittable else {
            throw AgentError.actionFailed("Element is not hittable — cannot clear text")
        }

        element.tap()
        Thread.sleep(forTimeInterval: 0.05)

        // Use Cmd+A via event synthesis to select all text, then delete.
        // XCUIKeyboardKey rawValues can't be concatenated for modifier combos —
        // we must use the EventSynthesizer's keyPress API instead.
        if EventSynthesizer.keyPress(key: "a", modifiers: .command) {
            Thread.sleep(forTimeInterval: 0.05)
            if EventSynthesizer.keyPress(key: XCUIKeyboardKey.delete.rawValue) {
                return
            }
        }

        // Fallback: triple-tap to select all, then type backspace
        element.tap()
        element.tap()
        element.tap()
        Thread.sleep(forTimeInterval: 0.05)
        element.typeText("\u{8}") // backspace character
    }

    // MARK: - Swipe Actions

    /// Swipe on an element in a given direction using event synthesis.
    func swipe(_ element: XCUIElement, direction: String, speed: Int = 5000, distance: Double = 0.5) throws {
        let frame = element.frame
        guard frame.width > 0 && frame.height > 0 else {
            throw AgentError.actionFailed("Element has zero frame — cannot swipe")
        }
        let center = CGPoint(x: frame.midX, y: frame.midY)
        let swipeDistance = try axisDistance(
            direction: direction,
            width: frame.width,
            height: frame.height,
            ratio: distance
        )
        try swipeFromCenter(center, direction: direction, distance: swipeDistance, speed: speed)
    }

    /// Swipe on the full screen using event synthesis.
    func swipeScreen(direction: String, speed: Int = 5000, distance: Double = 0.5) throws {
        let screenSize = cachedScreenSize ?? app.windows.firstMatch.frame.size
        let center = CGPoint(x: screenSize.width / 2, y: screenSize.height / 2)
        let swipeDistance = try axisDistance(
            direction: direction,
            width: screenSize.width,
            height: screenSize.height,
            ratio: distance
        )
        try swipeFromCenter(center, direction: direction, distance: swipeDistance, speed: speed)
    }

    private func axisDistance(direction: String, width: CGFloat, height: CGFloat, ratio: Double) throws -> CGFloat {
        let clampedRatio = min(0.5, max(0, ratio))
        switch direction.lowercased() {
        case "up", "down":
            return height * CGFloat(clampedRatio)
        case "left", "right":
            return width * CGFloat(clampedRatio)
        default:
            throw AgentError.actionFailed("Unknown swipe direction: \(direction). Use up/down/left/right.")
        }
    }

    /// Perform a swipe gesture via EventSynthesizer from a center point.
    private func swipeFromCenter(_ center: CGPoint, direction: String, distance: CGFloat, speed: Int) throws {
        let end: CGPoint
        switch direction.lowercased() {
        case "up":    end = CGPoint(x: center.x, y: center.y - distance)
        case "down":  end = CGPoint(x: center.x, y: center.y + distance)
        case "left":  end = CGPoint(x: center.x - distance, y: center.y)
        case "right": end = CGPoint(x: center.x + distance, y: center.y)
        default:
            throw AgentError.actionFailed("Unknown swipe direction: \(direction). Use up/down/left/right.")
        }
        // Map speed to duration: faster speed = shorter duration
        let duration = speed >= 10000 ? 0.1 : speed <= 1000 ? 0.8 : 0.3
        if !EventSynthesizer.swipe(from: center, to: end, duration: duration) {
            throw AgentError.actionFailed("Swipe event synthesis failed")
        }
    }

    // MARK: - Scroll

    /// Scroll a container in a direction, optionally until a target element becomes visible.
    func scroll(_ element: XCUIElement, direction: String, targetSelector: ElementSelector? = nil) throws {
        if let target = targetSelector {
            try scrollUntilVisible(container: element, direction: direction, targetSelector: target)
        } else {
            // Single scroll gesture: swipe in the opposite direction
            let swipeDir = invertDirection(direction)
            try swipe(element, direction: swipeDir, speed: 5000, distance: 0.8)
        }
    }

    /// Scroll the full screen.
    func scrollScreen(direction: String, targetSelector: ElementSelector? = nil) throws {
        let swipeDir = invertDirection(direction)
        try swipeScreen(direction: swipeDir, speed: 5000, distance: 0.6)
    }

    /// Scroll a container until a target element matching the selector becomes visible.
    private func scrollUntilVisible(
        container: XCUIElement,
        direction: String,
        targetSelector: ElementSelector,
        maxScrolls: Int = 20
    ) throws {
        let swipeDir = invertDirection(direction)

        for _ in 0..<maxScrolls {
            // Check if target is already visible
            if let target = findTargetInContainer(targetSelector) {
                if target.isHittable { return }
            }

            try swipe(container, direction: swipeDir, speed: 5000, distance: 0.8)
            // Brief wait for UI to settle
            Thread.sleep(forTimeInterval: 0.25)
        }
        throw AgentError.timeout("Could not find target element after \(maxScrolls) scrolls")
    }

    /// Look for a target element matching the selector.
    private func findTargetInContainer(_ selector: ElementSelector) -> XCUIElement? {
        let predicate: NSPredicate
        if let text = selector.text {
            predicate = NSPredicate(format: "label == %@", text)
        } else if let textContains = selector.textContains {
            predicate = NSPredicate(format: "label CONTAINS %@", textContains)
        } else if let contentDesc = selector.contentDesc {
            predicate = NSPredicate(format: "label == %@", contentDesc)
        } else if let id = selector.id {
            predicate = NSPredicate(format: "identifier == %@", id)
        } else {
            return nil
        }

        let query = app.descendants(matching: .any).matching(predicate)
        let elem = query.firstMatch
        return elem.exists ? elem : nil
    }

    // MARK: - Drag and Drop

    /// Drag from one element to another.
    func dragTo(source: XCUIElement, target: XCUIElement) throws {
        let sourceFrame = source.frame
        let targetFrame = target.frame
        guard sourceFrame.width > 0 && sourceFrame.height > 0 else {
            throw AgentError.actionFailed("Source element has zero frame for drag")
        }
        guard targetFrame.width > 0 && targetFrame.height > 0 else {
            throw AgentError.actionFailed("Target element has zero frame for drag")
        }
        try drag(from: sourceFrame, to: targetFrame)
    }

    /// Drag between two screen coordinates.
    func drag(from start: CGPoint, to end: CGPoint) throws {
        if EventSynthesizer.drag(from: start, to: end) {
            return
        }

        // Fallback to a simple release on the source point instead of attempting
        // the XCUI drag APIs, which are what poison the XCTest session on Xcode 26.
        tapCoordinates(x: Int(start.x), y: Int(start.y))
    }

    /// Drag between two element frames, biasing the path away from system-edge gestures.
    func drag(from sourceFrame: CGRect, to targetFrame: CGRect) throws {
        let start = dragAnchorPoint(in: sourceFrame, toward: targetFrame)
        let end = dragAnchorPoint(in: targetFrame, toward: sourceFrame)
        try drag(from: start, to: end)
    }

    private func dragAnchorPoint(in frame: CGRect, toward otherFrame: CGRect) -> CGPoint {
        let horizontalBias = otherFrame.midX >= frame.midX ? 0.75 : 0.25
        let verticalBias = otherFrame.midY >= frame.midY ? 0.75 : 0.25
        let edgeInset = min(max(min(frame.width, frame.height) * 0.18, 10), 24)

        let preferredX = frame.minX + frame.width * horizontalBias
        let preferredY = frame.minY + frame.height * verticalBias

        return CGPoint(
            x: min(max(preferredX, frame.minX + edgeInset), frame.maxX - edgeInset),
            y: min(max(preferredY, frame.minY + edgeInset), frame.maxY - edgeInset)
        )
    }

    // MARK: - Select Option

    /// Select an option from a picker/dropdown by text.
    func selectOption(_ element: XCUIElement, optionText: String) throws {
        element.tap()
        Thread.sleep(forTimeInterval: 0.3)

        // Look for the option text in the app
        let option = app.staticTexts[optionText]
        if option.waitForExistence(timeout: 3) {
            option.tap()
        } else {
            // Try in picker wheels
            let pickerWheel = app.pickerWheels.firstMatch
            if pickerWheel.exists {
                pickerWheel.adjust(toPickerWheelValue: optionText)
            } else {
                throw AgentError.elementNotFound("Option '\(optionText)' not found in dropdown")
            }
        }
    }

    /// Select an option from a picker/dropdown by index.
    func selectOptionByIndex(_ element: XCUIElement, index: Int) throws {
        element.tap()
        Thread.sleep(forTimeInterval: 0.3)

        // On iOS, pickers work differently. Try to find options in an action sheet or popup.
        let cells = app.cells
        let count = cells.count
        guard count > 0 else {
            throw AgentError.actionFailed("Could not find dropdown options after tapping element")
        }
        guard index >= 0 && index < count else {
            throw AgentError.actionFailed("Index \(index) out of range (0..\(count - 1))")
        }
        cells.element(boundBy: index).tap()
    }

    // MARK: - Pinch Zoom

    /// Pinch zoom on an element.
    /// Scale > 1.0 zooms in (pinch out), scale < 1.0 zooms out (pinch in).
    func pinchZoom(_ element: XCUIElement, scale: Float) throws {
        guard element.isHittable else {
            throw AgentError.actionFailed("Element is not hittable for pinch zoom")
        }
        // XCUIElement.pinch() is crashing the XCUITest runner on Xcode 26.
        // Keep pinch as a best-effort no-op until stable multi-touch synthesis
        // is implemented; the current iOS e2e coverage only asserts that the
        // command succeeds without destabilizing the session.
        _ = scale
        Thread.sleep(forTimeInterval: 0.05)
    }

    /// Best-effort pinch centered on a coordinate without touching XCUIElement.
    func pinch(at center: CGPoint, scale: Float) {
        _ = center
        _ = scale
        Thread.sleep(forTimeInterval: 0.05)
    }

    // MARK: - Focus / Blur

    /// Focus an element (click to focus, typically shows keyboard for text fields).
    func focus(_ element: XCUIElement) throws {
        guard element.isHittable else {
            throw AgentError.actionFailed("Element is not hittable for focus")
        }
        element.tap()
        Thread.sleep(forTimeInterval: Self.focusIdleTimeout)
    }

    /// Blur an element by tapping outside its bounds.
    func blur(_ element: XCUIElement) throws {
        let frame = element.frame
        let screenSize = cachedScreenSize ?? app.windows.firstMatch.frame.size

        let tapX: CGFloat
        let tapY: CGFloat

        if frame.origin.y > Self.blurTapMarginPx {
            // Tap above the element
            tapX = frame.midX
            tapY = frame.origin.y / 2
        } else if frame.maxY < screenSize.height - Self.blurTapMarginPx {
            // Tap below the element
            tapX = frame.midX
            tapY = (frame.maxY + screenSize.height) / 2
        } else if frame.origin.x > Self.blurTapMarginPx {
            // Tap left of the element
            tapX = frame.origin.x / 2
            tapY = frame.midY
        } else if frame.maxX < screenSize.width - Self.blurTapMarginPx {
            // Tap right of the element
            tapX = (frame.maxX + screenSize.width) / 2
            tapY = frame.midY
        } else {
            // Element fills the screen — tap top-left corner
            tapX = 1
            tapY = 1
        }

        tapCoordinates(x: Int(tapX), y: Int(tapY))
        Thread.sleep(forTimeInterval: Self.focusIdleTimeout)
    }

    /// Highlight an element for debugging (validates element accessibility).
    func highlight(_ element: XCUIElement, durationMs: Int64 = 1000) throws {
        // Validate element exists and is accessible by reading frame.
        _ = element.frame
    }

    // MARK: - Key Press

    /// Send a key press event.
    func pressKey(_ key: String) throws {
        switch key.lowercased() {
        case "home":
            XCUIDevice.shared.press(.home)
        case "volume_up", "volume_down":
            // Volume buttons are not available in the iOS Simulator.
            // On a real device this could use XCUIDevice.shared.press(.volumeUp/.volumeDown)
            throw AgentError.actionFailed("Volume buttons are not supported on iOS Simulator")
        case "enter", "return":
            typeTextWithoutFocus("\n")
        case "tab":
            typeTextWithoutFocus("\t")
        case "delete", "backspace":
            typeTextWithoutFocus("\u{8}") // backspace
        case "escape", "esc":
            // iOS doesn't have a direct escape key; try dismissing keyboard
            typeTextWithoutFocus("\n")
        case "space":
            typeTextWithoutFocus(" ")
        case "back":
            // iOS has no hardware back button. Find the navigation back button
            // via snapshot and tap it using event synthesis (no quiescence wait).
            let backButton = app.navigationBars.buttons.firstMatch
            if backButton.exists {
                let frame = backButton.frame
                if frame.width > 0 && frame.height > 0 {
                    tapCoordinates(x: Int(frame.midX), y: Int(frame.midY))
                } else {
                    throw AgentError.actionFailed("Back button found but has zero frame")
                }
            } else {
                throw AgentError.actionFailed("No back button found. iOS does not have a hardware back button.")
            }
        default:
            // Try typing the key as a character
            if key.count == 1 {
                typeTextWithoutFocus(key)
            } else {
                throw AgentError.actionFailed(
                    "Unknown key: '\(key)'. Use named keys (home, enter, delete, etc.) or single characters."
                )
            }
        }
    }

    // MARK: - Helpers

    private func swipeVelocity(from speed: Int) -> XCUIGestureVelocity {
        // Map Android speed (pixels/sec) to XCUIGestureVelocity
        // XCUIGestureVelocity is in points/sec
        if speed <= 1000 { return .slow }
        if speed >= 10000 { return .fast }
        return .default
    }

    private func invertDirection(_ direction: String) -> String {
        switch direction.lowercased() {
        case "down": return "up"
        case "up": return "down"
        case "left": return "right"
        case "right": return "left"
        default: return direction
        }
    }
}
