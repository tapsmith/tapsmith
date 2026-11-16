import Foundation

/// The params of a command that are the daemon's own, not a selector's.
/// Kept free of XCUITest so the host unit tests can drive it
/// (`ios-agent/Tests/run-unit-tests.sh`).
enum CommandMeta {
    /// A trace capture's flags, and the keys the daemon stamps on every
    /// command: how long it will wait for the answer, and (on a simulator)
    /// its offer to press taps (`HostTouch`). A key the daemon starts
    /// stamping belongs here: left out, every selector-less trace capture
    /// looks up an element with an empty selector, which matches the app
    /// itself.
    static let keys: Set<String> = ["screenshot", "hierarchy", "readTimeoutMs", HostTouch.offerParam]

    /// Whether `params` hold anything besides the daemon's own keys: the
    /// daemon merges a selector's fields into the params, so any other key
    /// is a selector field.
    static func hasSelectorKeys(_ params: [String: Any]) -> Bool {
        params.keys.contains { !keys.contains($0) }
    }
}
