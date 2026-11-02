import Foundation

/// What the agent does with an issue XCTest records inside its own API calls
/// (PILOT-978) — an automation failure such as "Failed to get matching
/// snapshot" or `kAXErrorIPCTimeout`, handed to the runner's
/// `record(_ issue:)` override.
///
/// Left to XCTest, a recorded automation failure interrupts the test: XCTest
/// raises its "Interrupting test" exception, which the agent's
/// `ObjCExceptionCatcher` catches, so the command fails and the agent
/// carries on. But the test stays marked as interrupted, and the next issue
/// XCTest records ends the test — and with it the agent, whose only test
/// serves every command (seen on a simulator: one failed element query, then
/// any later recorded issue, and the runner tore down). Nothing is recorded
/// any more. Instead:
///
/// - **inside an `ObjCExceptionCatcher`** on this thread (every command runs
///   in one): the issue is raised as an exception the catcher catches, so the
///   XCTest call that failed still aborts, exactly as XCTest's own
///   interruption did — never returning a made-up value such as a zero frame
///   to the code after it — and the command reports the issue's own
///   description instead of "Interrupting test";
/// - **outside one, once the agent is serving**: logged only. The agent must
///   outlive it, and raising here would end the process;
/// - **outside one, during startup**: recorded as before, so an app that
///   cannot be launched still fails the agent's startup loudly.
///
/// Every issue is logged.
enum XCTestIssueRelay {
    /// The name of the exception raised for an issue inside a catcher.
    static let exceptionName = NSExceptionName("TapsmithXCTestIssue")

    enum Disposition: Equatable {
        /// Raise it for the catcher on this thread to turn into an error.
        case raise
        /// Log it only.
        case logOnly
        /// Hand it to XCTest (`super.record`).
        case record
    }

    /// Set once startup is over and the agent serves commands. Main thread.
    static var serving = false

    static func disposition(catching: Bool, serving: Bool) -> Disposition {
        if catching { return .raise }
        return serving ? .logOnly : .record
    }

    /// Log the issue and act on it. Returns `.record` when the caller must
    /// pass the issue on to XCTest; otherwise the issue is handled (and for
    /// `.raise` this does not return).
    @discardableResult
    static func handle(
        _ description: String,
        catching: Bool = ObjCExceptionCatcher.isCatchingOnCurrentThread(),
        serving: Bool = XCTestIssueRelay.serving,
        log: (String) -> Void = { NSLog("%@", $0) }
    ) -> Disposition {
        let disposition = disposition(catching: catching, serving: serving)
        switch disposition {
        case .raise:
            log("[TapsmithAgent] XCTest issue (failing the command): \(description)")
            NSException(name: exceptionName, reason: description, userInfo: nil).raise()
        case .logOnly:
            log("[TapsmithAgent] XCTest issue (not recorded, agent continues): \(description)")
        case .record:
            log("[TapsmithAgent] XCTest issue during startup (recorded): \(description)")
        }
        return disposition
    }
}
