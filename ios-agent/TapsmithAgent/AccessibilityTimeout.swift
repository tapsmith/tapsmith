import XCTest

/// XCTest's accessibility timeout: how long one accessibility request (a
/// snapshot, or an element query's lookup) may wait for the app before it
/// fails (PILOT-978).
///
/// XCTest's default is about 15 s, and the agent never changed it, so a
/// single snapshot taken while the app is stuck in a transition or has its
/// main thread busy could block a command for 15 s — and `takeSnapshot()`
/// retries, so one call could block far longer than the daemon waits for its
/// answer. With a short timeout a stuck request gives way and is retried
/// (`SnapshotRetry`) inside the command's deadline instead of being waited
/// out. WebDriverAgent exposes the same knob as `snapshotTimeout`.
///
/// The setter is private XCTest API on the device's accessibility interface
/// (`XCUIDevice.accessibilityInterface`): `_setAXTimeout:error:` on current
/// Xcode, `setAXTimeout:` on older ones. When neither exists the timeout is
/// left at XCTest's default and startup carries on.
enum AccessibilityTimeout {
    /// The timeout the agent sets at startup, in seconds.
    static let seconds: TimeInterval = 2.0

    enum Outcome: Equatable {
        /// The timeout was set, through the named selector.
        case set(selector: String)
        /// The setter exists but reported failure.
        case failed(selector: String, error: String)
        /// This Xcode has no setter the agent knows: XCTest's default stays.
        case unavailable
    }

    /// Set XCTest's accessibility timeout. Main thread (XCTest API).
    @discardableResult
    static func apply(_ seconds: TimeInterval = AccessibilityTimeout.seconds) -> Outcome {
        let device = XCUIDevice.shared as NSObject
        let interfaceSelector = NSSelectorFromString("accessibilityInterface")
        guard device.responds(to: interfaceSelector),
              let client = device.perform(interfaceSelector)?.takeUnretainedValue() as? NSObject
        else { return .unavailable }

        let withError = NSSelectorFromString("_setAXTimeout:error:")
        if client.responds(to: withError) {
            typealias Setter = @convention(c) (
                NSObject, Selector, Double, UnsafeMutablePointer<NSError?>?
            ) -> Bool
            let setter = unsafeBitCast(client.method(for: withError), to: Setter.self)
            var error: NSError?
            if setter(client, withError, seconds, &error) {
                return .set(selector: "_setAXTimeout:error:")
            }
            return .failed(selector: "_setAXTimeout:error:", error: error.map { "\($0)" } ?? "no error")
        }

        let plain = NSSelectorFromString("setAXTimeout:")
        if client.responds(to: plain) {
            typealias Setter = @convention(c) (NSObject, Selector, Double) -> Void
            unsafeBitCast(client.method(for: plain), to: Setter.self)(client, plain, seconds)
            return .set(selector: "setAXTimeout:")
        }
        return .unavailable
    }

    /// The startup log line for an outcome.
    static func describe(_ outcome: Outcome, seconds: TimeInterval = AccessibilityTimeout.seconds) -> String {
        switch outcome {
        case .set(let selector):
            return "Accessibility timeout set to \(seconds) s (\(selector))"
        case .failed(let selector, let error):
            return "WARNING: could not set the accessibility timeout (\(selector)): \(error); "
                + "XCTest's default (~15 s) applies"
        case .unavailable:
            return "WARNING: this Xcode has no accessibility-timeout setter the agent knows; "
                + "XCTest's default (~15 s) applies"
        }
    }
}
