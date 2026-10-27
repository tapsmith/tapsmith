import XCTest
#if os(macOS)
import AppKit
#endif

// ─── Platform compatibility ───
//
// The agent sources build for both iOS and macOS UI-test bundles. iOS-only
// XCTest/UIKit APIs used from more than one place get a wrapper here; the
// rest are guarded with `#if os(iOS)` at the call site.

enum PlatformCompat {

    /// Thrown by commands that have no macOS counterpart (orientation, the
    /// home button), so the caller sees a clear refusal instead of a no-op.
    static func unsupportedOnMacOS(_ what: String) -> AgentError {
        AgentError.actionFailed("\(what) is not supported on macOS")
    }

    /// The app that draws system dialogs over the app under test: SpringBoard
    /// on iOS. nil on macOS, which has no SpringBoard (querying it throws
    /// "The app representing com.apple.springboard could not be found"), so
    /// callers take their "no system dialog present" branch.
    static func systemUIApp() -> XCUIApplication? {
        #if os(macOS)
        return nil
        #else
        return XCUIApplication(bundleIdentifier: "com.apple.springboard")
        #endif
    }

    static func screenshotCGImage(_ screenshot: XCUIScreenshot) -> CGImage? {
        #if os(macOS)
        return screenshot.image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        #else
        return screenshot.image.cgImage
        #endif
    }

    static func setClipboard(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }

    static func clipboardText() -> String? {
        #if os(macOS)
        return NSPasteboard.general.string(forType: .string)
        #else
        return UIPasteboard.general.string
        #endif
    }

    /// An accessibility value as text. macOS reports checkbox, radio and
    /// switch states as numbers (0/1), which `as? String` drops; iOS reports
    /// them as strings, and is left exactly as it was.
    static func valueString(_ value: Any?) -> String? {
        #if os(macOS)
        if let number = value as? NSNumber { return number.stringValue }
        #endif
        return value as? String
    }

    static func isDarkMode() -> Bool {
        #if os(macOS)
        return NSApplication.shared.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        #else
        return UITraitCollection.current.userInterfaceStyle == .dark
        #endif
    }
}

extension XCUIElement {
    /// `hasFocus` is iOS/tvOS-only. macOS reports keyboard focus through the
    /// `hasKeyboardFocus` attribute instead (the one Appium's Mac2 driver reads).
    var tapsmithHasFocus: Bool {
        #if os(macOS)
        return (value(forKey: "hasKeyboardFocus") as? Bool) ?? false
        #else
        return hasFocus
        #endif
    }
}

extension XCUIApplication.State {
    /// macOS has no `.runningBackgroundSuspended`.
    var isBackground: Bool {
        #if os(iOS)
        return self == .runningBackground || self == .runningBackgroundSuspended
        #else
        return self == .runningBackground
        #endif
    }
}
