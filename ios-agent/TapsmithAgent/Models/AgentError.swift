import Foundation

/// Structured error types matching the Android agent's error protocol.
/// These map to the JSON error types sent back to the daemon.
///
/// A `LocalizedError`, so `localizedDescription` is the message: code that
/// reports an `Error` it caught (a read that failed inside a command) keeps
/// the cause instead of Foundation's generic "The operation couldn't be
/// completed" (PILOT-1252).
enum AgentError: LocalizedError {
    case elementNotFound(String)
    case timeout(String)
    case invalidSelector(String)
    case actionFailed(String)
    /// The target is on screen but something else is drawn over it, so a
    /// touch would land on the cover (PILOT-223). Distinct from
    /// ACTION_FAILED so the daemon's HID paths can surface it instead of
    /// retrying through the agent route (which would wait all over again).
    case elementCovered(String)
    case parseError(String)
    case invalidRequest(String)
    case internalError(String)

    var type: String {
        switch self {
        case .elementNotFound: return "ELEMENT_NOT_FOUND"
        case .timeout: return "TIMEOUT"
        case .invalidSelector: return "INVALID_SELECTOR"
        case .actionFailed: return "ACTION_FAILED"
        case .elementCovered: return "ELEMENT_COVERED"
        case .parseError: return "PARSE_ERROR"
        case .invalidRequest: return "INVALID_REQUEST"
        case .internalError: return "INTERNAL_ERROR"
        }
    }

    var message: String {
        switch self {
        case .elementNotFound(let msg),
             .timeout(let msg),
             .invalidSelector(let msg),
             .actionFailed(let msg),
             .elementCovered(let msg),
             .parseError(let msg),
             .invalidRequest(let msg),
             .internalError(let msg):
            return msg
        }
    }

    var errorDescription: String? { message }
}
