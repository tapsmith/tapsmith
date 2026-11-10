import Foundation
import ObjectiveC

/// Waits for the app's UIKit animations to finish before an element is
/// touched (PILOT-1129).
///
/// UIKit drops touches while a view controller presentation or dismissal is
/// animating: a tap that lands on a React Native `Modal`'s button while the
/// modal is still fading in does nothing, and reports success. The touch
/// settle (`TouchSettle`) does not catch every such tap. Near the end of an
/// ease-out fade, the target's region looks the same on two consecutive
/// samples for 60 ms or more, while the transition is still running. A slow
/// simulator stalls for that long anywhere in the fade. The settle then calls
/// the target still, and the touch is lost.
///
/// So before a touch is planned, the agent asks XCTest whether the app's
/// animations are idle: `-[XCUIApplicationProcess _notifyWhenAnimationsAreIdle:]`,
/// which XCTest's own pre-event quiescence check uses. Its answer comes from
/// the app process, where XCTest tracks every UIView animation block,
/// presentation transitions included. A React Native app's own animations
/// (`Animated`, the native driver, an `ActivityIndicator`) are not UIView
/// animations, so a never-idle React Native screen still answers at once.
/// The rest of XCTest's quiescence check (an idle main run loop, which a React
/// Native app never reaches) stays off (`QuiescenceDisabler`).
///
/// The wait is bounded: an animation that outlasts it (a repeating UIView
/// animation) is touched through, as before. The method is private, so it is
/// looked up at run time and checked against the Objective-C signature it is
/// called with; when anything is missing, the touch goes ahead without the
/// wait, as it did before. The host test (`Tests/AnimationsIdleTests`) checks
/// the installed XCTest still has it in this shape.
///
/// Uses no UIKit or XCTest types, so the host unit tests compile it.
enum AnimationsIdle {
    /// Longest wait for the app's animations to end. Presentation and
    /// dismissal transitions run 0.3–0.5 s; a starved CI simulator takes
    /// longer to finish one.
    static let maxWaitSeconds: TimeInterval = 1
    /// Room left before the daemon's read deadline to plan the touch, make it
    /// and answer (the margin the touch plan keeps).
    static let readDeadlineMarginSeconds = TouchPlanClock.readDeadlineMarginSeconds

    static let processClassName = "XCUIApplicationProcess"
    static let currentProcessSelectorName = "currentProcess"
    static let notifySelectorName = "_notifyWhenAnimationsAreIdle:"
    static let supportsSelectorName = "_supportsAnimationsIdleNotifications"

    /// `- (XCUIApplicationProcess *)currentProcess` (on `XCUIApplication`)
    static let currentProcessTypeEncoding = "@16@0:8"
    /// `- (void)_notifyWhenAnimationsAreIdle:(void (^)(NSError *))handler`
    static let notifyTypeEncoding = "v24@0:8@?16"
    /// `- (BOOL)_supportsAnimationsIdleNotifications`
    static let supportsTypeEncoding = "B16@0:8"

    enum Outcome: Equatable {
        /// The app reported its animations idle.
        case idle
        /// Still animating at the deadline; touch anyway.
        case timedOut
        /// The question could not be asked (no process, the private method is
        /// missing or changed shape, or the app does not support it).
        case unavailable
        /// No time left before the deadline to ask.
        case noTime
    }

    /// When the wait must end: `maxWaitSeconds` from now, or earlier when the
    /// daemon's read deadline (less the margin and any reserved hold, e.g. a
    /// long press's duration) comes first.
    static func deadline(now: Date, readDeadline: Date?, reserveSeconds: TimeInterval) -> Date {
        let cap = now.addingTimeInterval(maxWaitSeconds)
        guard let readDeadline else { return cap }
        return min(cap, readDeadline.addingTimeInterval(-(readDeadlineMarginSeconds + max(0, reserveSeconds))))
    }

    /// Ask with `request` and wait until it calls back or `deadline` passes.
    /// `request` returns false when it could not ask; it may call back on any
    /// thread, at once, late (after the wait gave up) or never.
    static func wait(
        deadline: Date,
        now: () -> Date = Date.init,
        request: (_ done: @escaping () -> Void) -> Bool
    ) -> Outcome {
        let left = deadline.timeIntervalSince(now())
        guard left > 0 else { return .noTime }
        // One semaphore per wait: a late answer to an earlier wait can't end
        // this one.
        let answered = DispatchSemaphore(value: 0)
        guard request({ answered.signal() }) else { return .unavailable }
        return answered.wait(timeout: .now() + left) == .success ? .idle : .timedOut
    }

    /// A `request` for `wait` that asks `app` (an `XCUIApplication`) through
    /// XCTest's private API, or nil when that can't be used.
    static func request(for app: AnyObject) -> ((_ done: @escaping () -> Void) -> Bool)? {
        guard case .success(let api) = Self.api,
              (app as? NSObject)?.isKind(of: api.applicationClass) == true,
              let process = api.currentProcess(app, api.currentProcessSelector),
              process.isKind(of: api.processClass),
              api.supports(process, api.supportsSelector) else { return nil }
        return { done in
            api.notify(process, api.notifySelector) { _ in done() }
            return true
        }
    }

    // ─── The private API ───

    enum Unavailable: Error, Equatable, CustomStringConvertible {
        case missingClass(String)
        case missingMethod(String)
        case signatureChanged(method: String, encoding: String)

        var description: String {
            switch self {
            case .missingClass(let name): return "class \(name) not found"
            case .missingMethod(let name): return "method \(name) not found"
            case .signatureChanged(let method, let encoding): return "\(method) has signature \(encoding)"
            }
        }
    }

    typealias CurrentProcessFunction = @convention(c) (AnyObject, Selector) -> NSObject?
    typealias NotifyFunction = @convention(c) (AnyObject, Selector, @escaping @convention(block) (NSError?) -> Void) -> Void
    typealias SupportsFunction = @convention(c) (AnyObject, Selector) -> Bool

    struct API {
        let applicationClass: AnyClass
        let processClass: AnyClass
        let currentProcess: CurrentProcessFunction
        let currentProcessSelector: Selector
        let notify: NotifyFunction
        let notifySelector: Selector
        let supports: SupportsFunction
        let supportsSelector: Selector
    }

    /// The methods, looked up once.
    static let api: Result<API, Unavailable> = resolve()

    /// Look the methods up. The class names are parameters so the host test
    /// can check the failure answers.
    static func resolve(
        applicationClass appName: String = "XCUIApplication",
        processClass processName: String = processClassName
    ) -> Result<API, Unavailable> {
        guard let appClass = NSClassFromString(appName) else { return .failure(.missingClass(appName)) }
        guard let processClass = NSClassFromString(processName) else { return .failure(.missingClass(processName)) }
        let currentSelector = NSSelectorFromString(currentProcessSelectorName)
        let notifySelector = NSSelectorFromString(notifySelectorName)
        let supportsSelector = NSSelectorFromString(supportsSelectorName)
        let current: Method
        let notify: Method
        let supports: Method
        switch checkedMethod(appClass, currentSelector, currentProcessTypeEncoding) {
        case .success(let found): current = found
        case .failure(let why): return .failure(why)
        }
        switch checkedMethod(processClass, notifySelector, notifyTypeEncoding) {
        case .success(let found): notify = found
        case .failure(let why): return .failure(why)
        }
        switch checkedMethod(processClass, supportsSelector, supportsTypeEncoding) {
        case .success(let found): supports = found
        case .failure(let why): return .failure(why)
        }
        return .success(API(
            applicationClass: appClass,
            processClass: processClass,
            currentProcess: unsafeBitCast(method_getImplementation(current), to: CurrentProcessFunction.self),
            currentProcessSelector: currentSelector,
            notify: unsafeBitCast(method_getImplementation(notify), to: NotifyFunction.self),
            notifySelector: notifySelector,
            supports: unsafeBitCast(method_getImplementation(supports), to: SupportsFunction.self),
            supportsSelector: supportsSelector
        ))
    }

    /// The instance method `selector` of `cls`, when its Objective-C type
    /// encoding is `expected` — the shape this file calls it with.
    static func checkedMethod(_ cls: AnyClass, _ selector: Selector, _ expected: String) -> Result<Method, Unavailable> {
        let name = NSStringFromSelector(selector)
        guard let found = class_getInstanceMethod(cls, selector) else {
            return .failure(.missingMethod("\(NSStringFromClass(cls)) -\(name)"))
        }
        let actual = method_getTypeEncoding(found).map { String(cString: $0) } ?? ""
        guard actual == expected else {
            return .failure(.signatureChanged(method: "\(NSStringFromClass(cls)) -\(name)", encoding: actual))
        }
        return .success(found)
    }
}
