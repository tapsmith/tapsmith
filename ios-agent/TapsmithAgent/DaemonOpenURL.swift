import Foundation
import ObjectiveC

/// Delivers a URL to an app without `XCUIApplication.open(_:)`, whose
/// `-[XCUIApplicationImpl _launchWithRequest:]` ends in a fixed `sleep(1)`
/// after the app has already received the URL (a stack sample of the runner
/// spends ~98% of the call in that sleep). Every warm deep link, and so
/// every warm app reset, paid that second.
///
/// Calls the testmanagerd request `open(_:)` wraps,
/// `-[XCTRunnerDaemonSession openURL:usingApplication:completion:]` on the
/// shared session, and waits for its completion instead of the sleep.
///
/// The class and methods are private, so they are looked up at run time and
/// checked against the Objective-C signatures this file calls them with
/// (as `RegionScreenshot` does). When anything is missing or has another
/// shape, `api` says why and `open` returns `.unavailable`; the caller then
/// uses `XCUIApplication.open(_:)`. The host test
/// (`Tests/DaemonOpenURLTests`) checks the installed XCTest still has them.
///
/// Uses no UIKit or XCTest types, so the host unit tests compile it.
enum DaemonOpenURL {
    /// Why the private request can't be used.
    enum Unavailable: Error, Equatable, CustomStringConvertible {
        case missingClass(String)
        case missingMethod(String)
        case signatureChanged(method: String, encoding: String)
        case noSession

        var description: String {
            switch self {
            case .missingClass(let name): return "class \(name) not found"
            case .missingMethod(let name): return "method \(name) not found"
            case .signatureChanged(let method, let encoding): return "\(method) has signature \(encoding)"
            case .noSession: return "the shared runner daemon session is not available"
            }
        }
    }

    /// How one delivery went.
    enum Outcome: Equatable {
        /// testmanagerd accepted the request: the app has the URL.
        case delivered
        /// The request completed with an error (or reported failure). The
        /// URL was not delivered, so the caller may deliver it another way.
        case failed(String)
        /// No completion before the deadline. The URL may still arrive, so
        /// the caller must not deliver it a second time.
        case timedOut
        /// The private request can't be called; nothing was sent.
        case unavailable(String)
    }

    /// The looked-up methods.
    struct API {
        fileprivate let sessionClass: AnyClass
        fileprivate let shared: SharedFunction
        fileprivate let sharedSelector: Selector
        fileprivate let open: OpenFunction
        fileprivate let openSelector: Selector
    }

    static let sessionClassName = "XCTRunnerDaemonSession"
    static let sharedSelectorName = "sharedSession"
    static let openSelectorName = "openURL:usingApplication:completion:"

    /// `+ (XCTRunnerDaemonSession *)sharedSession`
    static let sharedTypeEncoding = "@16@0:8"
    /// `- (void)openURL:(NSURL *)url usingApplication:(NSString *)bundleID completion:(void (^)(BOOL, NSError *))completion`
    static let openTypeEncoding = "v40@0:8@16@24@?32"

    typealias Completion = @convention(block) (Bool, NSError?) -> Void
    fileprivate typealias SharedFunction = @convention(c) (AnyObject, Selector) -> AnyObject?
    fileprivate typealias OpenFunction = @convention(c) (AnyObject, Selector, NSURL, NSString, Completion) -> Void

    /// The methods, looked up once.
    static let api: Result<API, Unavailable> = resolve()

    /// Look the methods up. Only checks them: neither is called here, so the
    /// host test can resolve without a testmanagerd session. The class name
    /// is a parameter so the host test can check the failure answers.
    static func resolve(sessionClass name: String = sessionClassName) -> Result<API, Unavailable> {
        guard let sessionClass = NSClassFromString(name) else { return .failure(.missingClass(name)) }
        let sharedSelector = NSSelectorFromString(sharedSelectorName)
        let openSelector = NSSelectorFromString(openSelectorName)
        guard let metaclass = object_getClass(sessionClass) else { return .failure(.missingClass(name)) }
        let shared: Method
        let open: Method
        switch checkedMethod(metaclass, sharedSelector, sharedTypeEncoding, className: "+\(name)") {
        case .success(let found): shared = found
        case .failure(let why): return .failure(why)
        }
        switch checkedMethod(sessionClass, openSelector, openTypeEncoding, className: "-\(name)") {
        case .success(let found): open = found
        case .failure(let why): return .failure(why)
        }
        return .success(API(
            sessionClass: sessionClass,
            shared: unsafeBitCast(method_getImplementation(shared), to: SharedFunction.self),
            sharedSelector: sharedSelector,
            open: unsafeBitCast(method_getImplementation(open), to: OpenFunction.self),
            openSelector: openSelector
        ))
    }

    /// The method `selector` of `cls` (a metaclass for a class method), when
    /// its Objective-C type encoding is `expected`.
    static func checkedMethod(
        _ cls: AnyClass, _ selector: Selector, _ expected: String, className: String
    ) -> Result<Method, Unavailable> {
        let name = "\(className) \(NSStringFromSelector(selector))"
        guard let found = class_getInstanceMethod(cls, selector) else {
            return .failure(.missingMethod(name))
        }
        let actual = method_getTypeEncoding(found).map { String(cString: $0) } ?? ""
        guard actual == expected else {
            return .failure(.signatureChanged(method: name, encoding: actual))
        }
        return .success(found)
    }

    /// Ask testmanagerd to open `url` in the app `bundleId`, and wait up to
    /// `timeout` for it to answer. Call on the main thread: the completion
    /// can be delivered through the main queue, which this pumps.
    static func open(_ url: URL, bundleId: String, timeout: TimeInterval) -> Outcome {
        let resolved: API
        switch api {
        case .success(let found): resolved = found
        case .failure(let why): return .unavailable(why.description)
        }
        guard let session = resolved.shared(resolved.sessionClass, resolved.sharedSelector) else {
            return .unavailable(Unavailable.noSession.description)
        }
        return awaitCompletion(
            timeout: timeout,
            now: Date.init,
            pump: pumpMainRunLoop,
            start: { completion in
                resolved.open(session, resolved.openSelector, url as NSURL, bundleId as NSString, completion)
            }
        )
    }

    /// Start a request whose answer arrives through `completion`, and wait
    /// for it until `timeout`, calling `pump` between checks. The completion
    /// may run on any thread, at once (inside `start`) or after the deadline;
    /// a late one is ignored. Separate from `open` so the host test can drive
    /// every timing.
    static func awaitCompletion(
        timeout: TimeInterval,
        now: () -> Date,
        pump: () -> Void,
        start: (@escaping Completion) -> Void
    ) -> Outcome {
        let box = CompletionBox()
        let deadline = now().addingTimeInterval(timeout)
        start { ok, error in box.finish(ok: ok, error: error) }
        while true {
            if let answer = box.answer {
                if let error = answer.error { return .failed(error.localizedDescription) }
                return answer.ok ? .delivered : .failed("the request reported failure")
            }
            if now() >= deadline { return .timedOut }
            pump()
        }
    }

    private static func pumpMainRunLoop() {
        // `run` returns at once when the run loop has no sources; sleep so
        // that case does not spin.
        if !RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.005)) {
            Thread.sleep(forTimeInterval: 0.002)
        }
    }

    /// The completion's answer, shared with whichever thread delivers it.
    private final class CompletionBox {
        private let lock = NSLock()
        private var stored: (ok: Bool, error: NSError?)?

        var answer: (ok: Bool, error: NSError?)? {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }

        func finish(ok: Bool, error: NSError?) {
            lock.lock()
            defer { lock.unlock() }
            if stored == nil { stored = (ok, error) }
        }
    }
}
