import XCTest
import Foundation
import ObjectiveC

/// Disables XCUITest's quiescence waiting and provides direct event synthesis.
///
/// XCUITest normally blocks all actions (tap, type, swipe) until the app is
/// "quiescent" — no animations, no timers, no pending network requests.
/// React Native apps are NEVER quiescent because the JS bridge keeps timers
/// running. This causes every action to block for 30+ seconds.
///
/// Three strategies are used:
/// 1. Set quiescence timeout to 0 via _XCTSetApplicationStateTimeout (WDA approach).
/// 2. Runtime swizzle: Replace the quiescence check on XCUIApplicationProcess.
/// 3. Direct event synthesis: Bypass XCUIElement/XCUICoordinate entirely using
///    XCTest's private XCSynthesizedEventRecord + XCPointerEventPath APIs.
///    This is the same approach used by Maestro and Appium/WebDriverAgent.
///
/// ## Tested Xcode versions
///
/// The swizzled methods are private XCTest APIs that can change between Xcode
/// releases. This code has been tested and confirmed working on:
///
/// - **Xcode 16.x** (iOS 18 simulators) — uses `waitForQuiescenceIncludingAnimationsIdle:`
/// - **Xcode 26.x** (iOS 26 simulators) — added 2-param and 3-param variants of
///   `waitForQuiescenceIncludingAnimationsIdle:isPreEvent:` and
///   `waitForQuiescenceIncludingAnimationsIdle:usingActivity:isPreEvent:`
///
/// If Apple renames or removes these methods in a future Xcode, `disableViaRuntime()`
/// will log warnings (look for "[Quiescence] WARNING") and `verifySwizzleTargetsExist()`
/// will return false. Actions will still work via direct event synthesis (strategy 3)
/// but may be slower due to quiescence timeouts.
enum QuiescenceDisabler {

    // MARK: - Health Check

    /// Verify that the private XCTest methods we need to swizzle still exist.
    /// Call at agent startup to detect Xcode updates that may have renamed or
    /// removed the methods. Returns true if at least one quiescence-wait method
    /// and the core event synthesis classes are present.
    static func verifySwizzleTargetsExist() -> Bool {
        var healthy = true

        // Check quiescence methods on XCUIApplicationProcess
        guard let processClass = NSClassFromString("XCUIApplicationProcess") else {
            NSLog("[Quiescence] HEALTH CHECK FAILED: XCUIApplicationProcess class not found")
            return false
        }

        let quiescenceSelectors = [
            "waitForQuiescenceIncludingAnimationsIdle:isPreEvent:",
            "waitForQuiescenceIncludingAnimationsIdle:usingActivity:isPreEvent:",
            "waitForQuiescenceIncludingAnimationsIdle:",
        ]

        let foundAny = quiescenceSelectors.contains { selName in
            class_getInstanceMethod(processClass, NSSelectorFromString(selName)) != nil
        }

        if !foundAny {
            NSLog("[Quiescence] HEALTH CHECK WARNING: No known quiescence-wait methods found on XCUIApplicationProcess. "
                + "This Xcode version may have renamed them — quiescence disabling may not work.")
            healthy = false
        }

        // Check event synthesis classes
        if objc_lookUpClass("XCPointerEventPath") == nil {
            NSLog("[Quiescence] HEALTH CHECK WARNING: XCPointerEventPath class not found")
            healthy = false
        }
        if objc_lookUpClass("XCSynthesizedEventRecord") == nil {
            NSLog("[Quiescence] HEALTH CHECK WARNING: XCSynthesizedEventRecord class not found")
            healthy = false
        }

        if healthy {
            NSLog("[Quiescence] Health check passed — swizzle targets present")
        }
        return healthy
    }

    // MARK: - Quiescence Disable

    /// Disable quiescence using Objective-C runtime method swizzling.
    /// Call BEFORE app.activate() so it takes effect immediately.
    static func disableViaRuntime() {
        guard let processClass = NSClassFromString("XCUIApplicationProcess") else {
            NSLog("[Quiescence] XCUIApplicationProcess class not found")
            return
        }

        dumpQuiescenceMethods(processClass)

        // Swizzle ALL quiescence wait variants — Xcode 26 has multiple variants
        // and different code paths (e.g., XCUICoordinate.tap() vs app.activate())
        // may call different ones. We must swizzle ALL of them.
        let candidates: [(String, Any)] = [
            // Xcode 26: 2 Bool params (animationsIdle + isPreEvent)
            ("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:", {
                let block: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
                return block as Any
            }()),
            // Xcode 26: 3 params variant (used by XCUICoordinate.tap())
            ("waitForQuiescenceIncludingAnimationsIdle:usingActivity:isPreEvent:", {
                let block: @convention(block) (AnyObject, Bool, AnyObject?, Bool) -> Void = { _, _, _, _ in }
                return block as Any
            }()),
            // Xcode 15-25: 1 Bool param
            ("waitForQuiescenceIncludingAnimationsIdle:", {
                let block: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
                return block as Any
            }()),
        ]

        var swizzledAny = false
        for (selName, block) in candidates {
            let sel = NSSelectorFromString(selName)
            if let method = class_getInstanceMethod(processClass, sel) {
                let imp = imp_implementationWithBlock(block)
                method_setImplementation(method, imp)
                NSLog("[Quiescence] Disabled via runtime swizzle of %@", selName)
                swizzledAny = true
            }
        }

        if !swizzledAny {
            NSLog("[Quiescence] WARNING: No direct quiescence wait method swizzled")
        }

        // Also swizzle the skip/query methods unconditionally
        let skipMethods: [(String, Any)] = [
            ("shouldSkipPreEventQuiescence", {
                let b: @convention(block) (AnyObject) -> Bool = { _ in true }
                return b as Any
            }()),
            ("shouldSkipPostEventQuiescence", {
                let b: @convention(block) (AnyObject) -> Bool = { _ in true }
                return b as Any
            }()),
            ("isQuiescent", {
                let b: @convention(block) (AnyObject) -> Bool = { _ in true }
                return b as Any
            }()),
            ("_initiateQuiescenceChecksIncludingAnimationsIdle:", {
                let b: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
                return b as Any
            }()),
        ]

        for (selName, block) in skipMethods {
            let sel = NSSelectorFromString(selName)
            if let method = class_getInstanceMethod(processClass, sel) {
                let imp = imp_implementationWithBlock(block)
                method_setImplementation(method, imp)
                NSLog("[Quiescence] Swizzled %@", selName)
            }
        }
    }

    /// Property-based disable on a specific app's process instance.
    static func disable(for app: XCUIApplication) {
        let processSelector = NSSelectorFromString("applicationProcess")
        let altProcessSelector = NSSelectorFromString("_applicationProcess")

        var process: NSObject?

        if app.responds(to: processSelector) {
            process = app.perform(processSelector)?.takeUnretainedValue() as? NSObject
        } else if app.responds(to: altProcessSelector) {
            process = app.perform(altProcessSelector)?.takeUnretainedValue() as? NSObject
        }

        guard let proc = process else {
            NSLog("[Quiescence] Could not access applicationProcess instance")
            return
        }

        let setSelector = NSSelectorFromString("setWaitForQuiescence:")
        if proc.responds(to: setSelector) {
            proc.perform(setSelector, with: false as AnyObject)
            NSLog("[Quiescence] Disabled on process via setWaitForQuiescence:")
        }
    }

    private static func dumpQuiescenceMethods(_ cls: AnyClass) {
        var methodCount: UInt32 = 0
        guard let methods = class_copyMethodList(cls, &methodCount) else { return }
        defer { free(methods) }

        for i in 0..<Int(methodCount) {
            let name = NSStringFromSelector(method_getName(methods[i]))
            if name.lowercased().contains("quiesc") ||
               (name.lowercased().contains("idle") && name.lowercased().contains("wait")) {
                NSLog("[Quiescence] Available method: %@", name)
            }
        }
    }

    /// Nuclear option: swizzle every method containing "quiescence" or "Quiescence"
    /// on the given class. This is aggressive but ensures all quiescence checks
    /// are bypassed on Xcode 26 where Apple added many new checkpoints.
    static func disableAllQuiescenceMethods(on cls: AnyClass) {
        var methodCount: UInt32 = 0
        guard let methods = class_copyMethodList(cls, &methodCount) else { return }
        defer { free(methods) }

        for i in 0..<Int(methodCount) {
            let sel = method_getName(methods[i])
            let name = NSStringFromSelector(sel)

            // Skip non-quiescence methods
            guard name.contains("uiescence") || name.contains("Quiescence") else { continue }
            // Skip getters (we want to swizzle behavior methods)
            guard !name.hasPrefix("set") else { continue }

            // Determine the return type to create the right block
            let typeEncoding = String(cString: method_getTypeEncoding(methods[i])!)
            let imp: IMP

            if typeEncoding.hasPrefix("B") || typeEncoding.hasPrefix("c") {
                // Returns BOOL — make it return YES/true
                let block: @convention(block) () -> Bool = { true }
                imp = imp_implementationWithBlock(block)
            } else if typeEncoding.hasPrefix("v") {
                // Returns void — make it a no-op
                let block: @convention(block) () -> Void = { }
                imp = imp_implementationWithBlock(block)
            } else {
                continue // Skip methods with other return types
            }

            method_setImplementation(methods[i], imp)
            NSLog("[Quiescence] Force-disabled: %@", name)
        }
    }
}

// MARK: - Direct Event Synthesis

/// Synthesizes touch events directly via XCTest's private APIs, bypassing
/// XCUIElement/XCUICoordinate (which wait for quiescence).
///
/// Uses the same approach as Maestro: `unsafeBitCast` + `method(for:)` to call
/// private XCPointerEventPath/XCSynthesizedEventRecord methods from Swift.
enum EventSynthesizer {

    /// Detect the current interface orientation for event synthesis records.
    /// Falls back to `.portrait` if the orientation can't be determined.
    private static var currentOrientation: Int {
        #if os(macOS)
        // macOS has no interface orientation; 1 is UIInterfaceOrientation.portrait.
        return 1
        #else
        var orientation = UIInterfaceOrientation.portrait
        if let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).first {
            orientation = scene.interfaceOrientation
        }
        return orientation.rawValue
        #endif
    }

    /// Tap at a screen coordinate. Returns true if synthesis succeeded.
    static func tap(at point: CGPoint) -> Bool {
        return synthesizeTap(at: point, duration: 0.1)
    }

    /// Outcome of a synthesized double-tap, so callers can fall back without
    /// over- or under-tapping.
    enum DoubleTapResult {
        /// Both taps were delivered.
        case done
        /// Nothing was delivered — the caller may safely run a full
        /// double-tap fallback.
        case notStarted
        /// The first tap landed but the second could not be dispatched. The
        /// caller must complete with exactly ONE more tap — a full double-tap
        /// fallback here would deliver three taps.
        case firstTapOnly
    }

    /// Double-tap at a screen coordinate.
    ///
    /// Primary mechanism (pre-iOS-26 runtimes): ONE event record carrying
    /// both taps as two pointer paths with disjoint time ranges
    /// (down/move/lift each). The replay honors the offsets inside the event
    /// system, so the inter-tap gap is fixed at `interval` regardless of CPU
    /// starvation on the host — unlike XCUIElement.doubleTap(), whose gap
    /// stretched past apps' double-tap windows (300-450ms) on loaded CI
    /// runners. Disjoint time ranges matter: sequential contacts read as one
    /// finger tapping twice, which tap recognizers accept; OVERLAPPING
    /// ranges are a two-finger tap, which they reject. A second
    /// pressDownAtOffset: on a single path is not an option — it is silently
    /// dropped on Xcode 26.
    ///
    /// iOS 26 runtimes need a different route entirely (all verified
    /// empirically on the iOS 26.5 simulator runtime, iPhone 17):
    /// - The multi-path record dispatch REPORTS success but the event
    ///   pipeline delivers at most the first path's tap — often none.
    /// - Two sequential single-path records (which individually deliver
    ///   reliably) are COALESCED when the inter-tap gap is small: at a
    ///   ~150ms gap only one tap reaches the app. The same is true of the
    ///   public XCUICoordinate.doubleTap(). Gaps of 200ms+ deliver both.
    /// So on iOS 26+ the primary is the sequential two-record route with the
    /// requested interval floored at 250ms — safely above the observed
    /// coalescing threshold (≲150-200ms) and below common double-tap
    /// recognizer windows (~300-500ms). The host-side sleep is shortened by
    /// the first record's dispatch latency to keep the app-visible gap at
    /// ~the interval.
    static func doubleTap(at point: CGPoint, intervalMs: Int = 0) -> DoubleTapResult {
        var interval = intervalMs > 0 ? TimeInterval(intervalMs) / 1000.0 : 0.15

        if runtimeCoalescesRapidTaps {
            interval = max(interval, 0.25)
        } else {
            if doubleTapSingleRecord(at: point, interval: interval) {
                return .done
            }
            NSLog("[EventSynth] double-tap single-record dispatch failed; falling back to sequential taps")
        }

        let start = Date()
        guard synthesizeTap(at: point, duration: 0.05) else { return .notStarted }
        // The dispatch completion fires only after the first tap has been
        // synthesized, so the app-visible gap starts HERE — sleep the full
        // interval from this point. Crediting dispatch-1's duration against
        // the gap (the previous behaviour) collapses the sleep to zero on a
        // loaded runner whose dispatch takes ≥ the interval, and the two
        // taps land within iOS 26's coalescing threshold → "Single tap".
        Thread.sleep(forTimeInterval: interval)
        // iOS 26 coalesces rapid SAME-POINT synthesized taps (newer 26.x
        // runtime builds do so even at 250ms+ gaps, verified on iOS 26.5).
        // Offset the second tap by 2pt — comfortably inside every double-tap
        // recognizer's slop radius, far outside the pipeline's same-point
        // coalescing match — so the pair always arrives as two taps. Keep the
        // verified +2 direction except within 2pt of the screen's right or
        // bottom edge, where it would land off-screen; the coalescing match
        // only cares that the points differ, not which way they differ.
        let second: CGPoint
        if runtimeCoalescesRapidTaps {
            // Direction doesn't matter to the same-point coalescing match, so
            // no screen-size lookup is needed (UIScreen is main-thread-bound
            // and commands run on the socket thread): points in the first
            // 300pt offset outward (+2 — safe, every iOS screen is ≥320pt),
            // everything else offsets inward (-2 — safe, the point itself is
            // on-screen).
            let dx: CGFloat = point.x <= 300 ? 2 : -2
            let dy: CGFloat = point.y <= 300 ? 2 : -2
            second = CGPoint(x: point.x + dx, y: point.y + dy)
        } else {
            second = point
        }
        guard synthesizeTap(at: second, duration: 0.05) else { return .firstTapOnly }
        let elapsed = Date().timeIntervalSince(start)
        if elapsed > 0.5 {
            NSLog(
                "[EventSynth] sequential double-tap took %.0fms end-to-end — may exceed the app's double-tap window",
                elapsed * 1000
            )
        }
        return .done
    }

    /// True on iOS 26+ runtimes, whose event pipeline mishandles synthesized
    /// double-taps two ways: a record with multiple sequential pointer paths
    /// delivers at most its first tap, and rapid same-point taps from
    /// separate records (or the public doubleTap()) are coalesced into one
    /// when the gap is ≲150-200ms. Single taps and gaps ≥200ms are
    /// unaffected. Pre-26 runtimes (e.g. iOS 18.x) replay multi-path records
    /// correctly and never coalesce.
    private static let runtimeCoalescesRapidTaps: Bool = {
        if #available(iOS 26.0, *) { return true }
        return false
    }()

    /// Build and dispatch a single event record containing two sequential
    /// single-finger taps (path 1: down@0 lift@tapDuration; path 2:
    /// down@tapDuration+interval lift@2*tapDuration+interval).
    private static func doubleTapSingleRecord(at point: CGPoint, interval: TimeInterval) -> Bool {
        let tapDuration: TimeInterval = 0.05

        guard let pathClass = objc_lookUpClass("XCPointerEventPath"),
              let recordClass = objc_lookUpClass("XCSynthesizedEventRecord")
        else { return false }

        let initSel = NSSelectorFromString("initForTouchAtPoint:offset:")
        let moveSel = NSSelectorFromString("moveToPoint:atOffset:")
        let liftSel = NSSelectorFromString("liftUpAtOffset:")
        let allocSel = NSSelectorFromString("alloc")

        guard let pathType = pathClass as? NSObject.Type,
              pathType.instancesRespond(to: initSel),
              pathType.instancesRespond(to: liftSel),
              let meta = object_getClass(pathClass),
              let allocImp = class_getMethodImplementation(meta, allocSel),
              let initImp = class_getMethodImplementation(pathClass, initSel)
        else { return false }

        // Alloc as a RAW pointer so ARC never manages the uninitialized
        // instance (init via IMP consumes alloc's +1) — same double-free
        // avoidance as the swipePath/drag paths below.
        typealias AllocFn = @convention(c) (AnyClass, Selector) -> UnsafeMutableRawPointer
        typealias InitMethod = @convention(c) (UnsafeMutableRawPointer, Selector, CGPoint, TimeInterval) -> Unmanaged<NSObject>?
        typealias MoveMethod = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> Void
        typealias OffsetMethod = @convention(c) (NSObject, Selector, TimeInterval) -> Void

        func makeTapPath(downAt offset: TimeInterval) -> NSObject? {
            let raw = unsafeBitCast(allocImp, to: AllocFn.self)(pathClass, allocSel)
            guard let path = unsafeBitCast(initImp, to: InitMethod.self)(raw, initSel, point, offset)?.takeRetainedValue()
            else { return nil }
            // Stationary move mid-tap, mirroring synthesizeTap: a touch with
            // no move event is intermittently misclassified/dropped by the
            // gesture pipeline (observed as the app registering only one of
            // the two taps).
            if path.responds(to: moveSel) {
                let moveFunc = unsafeBitCast(path.method(for: moveSel), to: MoveMethod.self)
                moveFunc(path, moveSel, point, offset + tapDuration * 0.5)
            }
            let liftFunc = unsafeBitCast(path.method(for: liftSel), to: OffsetMethod.self)
            liftFunc(path, liftSel, offset + tapDuration)
            return path
        }

        guard let path1 = makeTapPath(downAt: 0.0),
              let path2 = makeTapPath(downAt: tapDuration + interval)
        else { return false }

        let record: NSObject
        let recordInitSel = NSSelectorFromString("initWithName:interfaceOrientation:")
        if (recordClass as! NSObject.Type).instancesRespond(to: recordInitSel),
           let recordMeta = object_getClass(recordClass),
           let recordAllocImp = class_getMethodImplementation(recordMeta, allocSel),
           let recordInitImp = class_getMethodImplementation(recordClass, recordInitSel) {
            typealias RMethod = @convention(c) (UnsafeMutableRawPointer, Selector, NSString, Int) -> Unmanaged<NSObject>?
            let recordRaw = unsafeBitCast(recordAllocImp, to: AllocFn.self)(recordClass, allocSel)
            guard let r = unsafeBitCast(recordInitImp, to: RMethod.self)(
                recordRaw,
                recordInitSel,
                "tapsmith-double-tap" as NSString,
                currentOrientation
            )?.takeRetainedValue() else { return false }
            record = r
        } else {
            record = (recordClass as! NSObject.Type).init()
        }

        let addPathSel = NSSelectorFromString("addPointerEventPath:")
        guard record.responds(to: addPathSel) else { return false }
        // Add the LATER path first: the replay session's lifetime appears to
        // be derived from the first-added path, and adding the early tap first
        // intermittently raced session teardown against the second tap's
        // events (the app saw only one tap). With the later path first, the
        // session provably outlives both taps.
        record.perform(addPathSel, with: path2)
        record.perform(addPathSel, with: path1)

        // Daemon-session dispatch is the reliable route for this record type;
        // in-process synthesizeWithError: drops one of the taps far more often
        // (5/20 runs vs 1/20 measured locally).
        return dispatchViaDaemonSession(record) || dispatchSync(record) || dispatchViaDevice(record)
    }

    /// Swipe from one point to another. Used for keyboard dismissal and scrolling.
    static func swipe(from start: CGPoint, to end: CGPoint, duration: TimeInterval) -> Bool {
        guard let pathClass = objc_lookUpClass("XCPointerEventPath"),
              let recordClass = objc_lookUpClass("XCSynthesizedEventRecord")
        else { return false }

        // Create touch-down at start point
        let pathObj = pathClass.alloc() as! NSObject
        let initSel = NSSelectorFromString("initForTouchAtPoint:offset:")
        guard pathObj.responds(to: initSel) else { return false }
        let initImp = pathObj.method(for: initSel)
        typealias InitMethod = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> NSObject
        let path = unsafeBitCast(initImp, to: InitMethod.self)(pathObj, initSel, start, 0.0)

        // Move to end point
        let moveSel = NSSelectorFromString("moveToPoint:atOffset:")
        if path.responds(to: moveSel) {
            let moveImp = path.method(for: moveSel)
            typealias MoveMethod = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> Void
            unsafeBitCast(moveImp, to: MoveMethod.self)(path, moveSel, end, duration)
        }

        // Lift up
        let liftSel = NSSelectorFromString("liftUpAtOffset:")
        if path.responds(to: liftSel) {
            let liftImp = path.method(for: liftSel)
            typealias LiftMethod = @convention(c) (NSObject, Selector, TimeInterval) -> Void
            unsafeBitCast(liftImp, to: LiftMethod.self)(path, liftSel, duration + 0.01)
        }

        // Create record and dispatch
        let recordObj = recordClass.alloc() as! NSObject
        let recordInitSel = NSSelectorFromString("initWithName:interfaceOrientation:")
        let record: NSObject
        if recordObj.responds(to: recordInitSel) {
            let imp = recordObj.method(for: recordInitSel)
            typealias RMethod = @convention(c) (NSObject, Selector, NSString, Int) -> NSObject
            record = unsafeBitCast(imp, to: RMethod.self)(recordObj, recordInitSel, "tapsmith-swipe" as NSString, currentOrientation)
        } else {
            record = (recordClass as! NSObject.Type).init()
        }

        let addPathSel = NSSelectorFromString("addPointerEventPath:")
        if record.responds(to: addPathSel) {
            record.perform(addPathSel, with: path)
        }

        // Swipe/drag paths can stall waiting for the daemon callback on Xcode 26.
        // Prefer synchronous/local dispatch first so a stuck daemon reply does not
        // burn the full action timeout before we try the working fallbacks.
        return dispatchSync(record) || dispatchViaDevice(record) || dispatchViaDaemonSession(record)
    }

    /// Replay an arbitrary touch path as one synthesized gesture. `points` is
    /// [(location, offsetSeconds)] with the touch-down at the first entry
    /// (offset 0). Used by the interactive mirror's live-drag on iOS, where a
    /// touch cannot be streamed live — the full path is dispatched on release.
    static func swipePath(_ points: [(CGPoint, TimeInterval)]) -> Bool {
        guard points.count >= 2,
              let pathClass = objc_lookUpClass("XCPointerEventPath"),
              let recordClass = objc_lookUpClass("XCSynthesizedEventRecord")
        else { return false }

        let initSel = NSSelectorFromString("initForTouchAtPoint:offset:")
        // Allocate via the runtime as a RAW pointer so ARC never manages the
        // uninitialized instance: `init` (called through its IMP) consumes the
        // +1 from `alloc` and returns the fully-initialized, ARC-managed object.
        // Capturing the alloc result as an NSObject instead would let ARC release
        // that +1 a second time (init already consumed it) — a double-free.
        let allocSel = NSSelectorFromString("alloc")
        guard (pathClass as! NSObject.Type).instancesRespond(to: initSel),
              let meta = object_getClass(pathClass),
              let allocImp = class_getMethodImplementation(meta, allocSel),
              let initImp = class_getMethodImplementation(pathClass, initSel)
        else { return false }
        typealias AllocFn = @convention(c) (AnyClass, Selector) -> UnsafeMutableRawPointer
        // Return Unmanaged so we explicitly consume init's +1 (takeRetainedValue)
        // — a bare NSObject return leaks it — and handle a nil-returning init.
        typealias InitMethod = @convention(c) (UnsafeMutableRawPointer, Selector, CGPoint, TimeInterval) -> Unmanaged<NSObject>?
        let raw = unsafeBitCast(allocImp, to: AllocFn.self)(pathClass, allocSel)
        guard let path = unsafeBitCast(initImp, to: InitMethod.self)(raw, initSel, points[0].0, 0.0)?.takeRetainedValue() else { return false }

        // XCPointerEventPath requires strictly increasing offsets — coincident
        // timestamps (e.g. a coalesced move and the release rounding to the same
        // ms on the client) would otherwise yield an invalid, no-op gesture that
        // never engages the scroll/pan recognizer. Enforce monotonicity here.
        var lastOffset: TimeInterval = 0
        let moveSel = NSSelectorFromString("moveToPoint:atOffset:")
        if path.responds(to: moveSel) {
            let moveImp = path.method(for: moveSel)
            typealias MoveMethod = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> Void
            let moveFunc = unsafeBitCast(moveImp, to: MoveMethod.self)
            for (point, offset) in points.dropFirst() {
                let o = max(offset, lastOffset + 0.001)
                lastOffset = o
                moveFunc(path, moveSel, point, o)
            }
        }

        let liftSel = NSSelectorFromString("liftUpAtOffset:")
        if path.responds(to: liftSel) {
            let liftImp = path.method(for: liftSel)
            typealias LiftMethod = @convention(c) (NSObject, Selector, TimeInterval) -> Void
            unsafeBitCast(liftImp, to: LiftMethod.self)(path, liftSel, lastOffset + 0.01)
        }

        let recordInitSel = NSSelectorFromString("initWithName:interfaceOrientation:")
        let recordAllocSel = NSSelectorFromString("alloc")
        let record: NSObject
        // Allocate as a RAW pointer so ARC never manages the uninitialized
        // instance (init via IMP consumes alloc's +1) — same double-free
        // avoidance as the pointer path above.
        if (recordClass as! NSObject.Type).instancesRespond(to: recordInitSel),
           let meta = object_getClass(recordClass),
           let allocImp = class_getMethodImplementation(meta, recordAllocSel),
           let initImp = class_getMethodImplementation(recordClass, recordInitSel) {
            typealias AllocFn = @convention(c) (AnyClass, Selector) -> UnsafeMutableRawPointer
            typealias RMethod = @convention(c) (UnsafeMutableRawPointer, Selector, NSString, Int) -> Unmanaged<NSObject>?
            let raw = unsafeBitCast(allocImp, to: AllocFn.self)(recordClass, recordAllocSel)
            guard let r = unsafeBitCast(initImp, to: RMethod.self)(raw, recordInitSel, "tapsmith-swipe-path" as NSString, currentOrientation)?.takeRetainedValue() else { return false }
            record = r
        } else {
            record = (recordClass as! NSObject.Type).init()
        }

        let addPathSel = NSSelectorFromString("addPointerEventPath:")
        if record.responds(to: addPathSel) {
            record.perform(addPathSel, with: path)
        }

        // iOS 26 runtimes silently drop synthesized events dispatched via the
        // dispatchSync/synthesizeWithError: route in ~25% of runs (measured
        // during the double-tap work; the daemon-session route drops ~5%).
        // A dropped swipe record reports success while the view never moves —
        // the "streamed drag scrolls zero" CI flake. Prefer the reliable
        // route there; keep the historical order on pre-26 runtimes.
        if runtimeCoalescesRapidTaps {
            return dispatchViaDaemonSession(record) || dispatchSync(record) || dispatchViaDevice(record)
        }
        return dispatchSync(record) || dispatchViaDevice(record) || dispatchViaDaemonSession(record)
    }

    /// Drag from one point to another using a touch-down, short hold, move, and lift.
    /// Unlike swipe(), this intentionally avoids async fallback dispatchers because
    /// they are the part that tends to wedge the XCTest session on Xcode 26.
    static func drag(from start: CGPoint, to end: CGPoint, holdDuration: TimeInterval = 0.15) -> Bool {
        guard let pathClass = objc_lookUpClass("XCPointerEventPath"),
              let recordClass = objc_lookUpClass("XCSynthesizedEventRecord")
        else { return false }

        let initSel = NSSelectorFromString("initForTouchAtPoint:offset:")
        // Allocate via the runtime as a RAW pointer so ARC never manages the
        // uninitialized instance: `init` (called through its IMP) consumes the
        // +1 from `alloc` and returns the fully-initialized, ARC-managed object.
        // Capturing the alloc result as an NSObject instead would let ARC release
        // that +1 a second time (init already consumed it) — a double-free.
        let allocSel = NSSelectorFromString("alloc")
        guard (pathClass as! NSObject.Type).instancesRespond(to: initSel),
              let meta = object_getClass(pathClass),
              let allocImp = class_getMethodImplementation(meta, allocSel),
              let initImp = class_getMethodImplementation(pathClass, initSel)
        else { return false }
        typealias AllocFn = @convention(c) (AnyClass, Selector) -> UnsafeMutableRawPointer
        // Return Unmanaged so we explicitly consume init's +1 (takeRetainedValue)
        // — a bare NSObject return leaks it — and handle a nil-returning init.
        typealias InitMethod = @convention(c) (UnsafeMutableRawPointer, Selector, CGPoint, TimeInterval) -> Unmanaged<NSObject>?
        let raw = unsafeBitCast(allocImp, to: AllocFn.self)(pathClass, allocSel)
        guard let path = unsafeBitCast(initImp, to: InitMethod.self)(raw, initSel, start, 0.0)?.takeRetainedValue() else { return false }

        let moveSel = NSSelectorFromString("moveToPoint:atOffset:")
        if path.responds(to: moveSel) {
            let moveImp = path.method(for: moveSel)
            typealias MoveMethod = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> Void
            let moveFunc = unsafeBitCast(moveImp, to: MoveMethod.self)
            let nudge = CGPoint(
                x: start.x + (end.x - start.x) * 0.08,
                y: start.y + (end.y - start.y) * 0.08
            )
            let midpoint = CGPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)
            moveFunc(path, moveSel, nudge, holdDuration + 0.04)
            moveFunc(path, moveSel, midpoint, holdDuration + 0.08)
            moveFunc(path, moveSel, end, holdDuration + 0.2)
        }

        let liftSel = NSSelectorFromString("liftUpAtOffset:")
        if path.responds(to: liftSel) {
            let liftImp = path.method(for: liftSel)
            typealias LiftMethod = @convention(c) (NSObject, Selector, TimeInterval) -> Void
            unsafeBitCast(liftImp, to: LiftMethod.self)(path, liftSel, holdDuration + 0.24)
        }

        let recordInitSel = NSSelectorFromString("initWithName:interfaceOrientation:")
        let recordAllocSel = NSSelectorFromString("alloc")
        let record: NSObject
        // Allocate as a RAW pointer so ARC never manages the uninitialized
        // instance (init via IMP consumes alloc's +1) — same double-free
        // avoidance as the pointer path above.
        if (recordClass as! NSObject.Type).instancesRespond(to: recordInitSel),
           let meta = object_getClass(recordClass),
           let allocImp = class_getMethodImplementation(meta, recordAllocSel),
           let initImp = class_getMethodImplementation(recordClass, recordInitSel) {
            typealias AllocFn = @convention(c) (AnyClass, Selector) -> UnsafeMutableRawPointer
            typealias RMethod = @convention(c) (UnsafeMutableRawPointer, Selector, NSString, Int) -> Unmanaged<NSObject>?
            let raw = unsafeBitCast(allocImp, to: AllocFn.self)(recordClass, recordAllocSel)
            guard let r = unsafeBitCast(initImp, to: RMethod.self)(
                raw,
                recordInitSel,
                "tapsmith-drag" as NSString,
                currentOrientation
            )?.takeRetainedValue() else { return false }
            record = r
        } else {
            record = (recordClass as! NSObject.Type).init()
        }

        let addPathSel = NSSelectorFromString("addPointerEventPath:")
        if record.responds(to: addPathSel) {
            record.perform(addPathSel, with: path)
        }

        return dispatchSync(record)
    }

    /// Long-press at a screen coordinate.
    /// Unlike tap, this does NOT include an intermediate moveToPoint to avoid
    /// React Native's Pressability system firing onPress on touch-up.
    static func longPress(at point: CGPoint, duration: TimeInterval) -> Bool {
        guard let pathClass = objc_lookUpClass("XCPointerEventPath"),
              let recordClass = objc_lookUpClass("XCSynthesizedEventRecord")
        else { return false }

        let pathObj = pathClass.alloc() as! NSObject
        let initSel = NSSelectorFromString("initForTouchAtPoint:offset:")
        guard pathObj.responds(to: initSel) else { return false }
        let initImp = pathObj.method(for: initSel)
        typealias InitMethod = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> NSObject
        let path = unsafeBitCast(initImp, to: InitMethod.self)(pathObj, initSel, point, 0.0)

        // NO moveToPoint — just hold and release. The move event in
        // synthesizeTap causes TouchableOpacity to fire onPress after
        // onLongPress, which resets state in the test app.
        let liftSel = NSSelectorFromString("liftUpAtOffset:")
        if path.responds(to: liftSel) {
            let liftImp = path.method(for: liftSel)
            typealias LiftMethod = @convention(c) (NSObject, Selector, TimeInterval) -> Void
            unsafeBitCast(liftImp, to: LiftMethod.self)(path, liftSel, duration)
        }

        let record: NSObject
        let recordInitSel = NSSelectorFromString("initWithName:interfaceOrientation:")
        let recordObj = recordClass.alloc() as! NSObject
        if recordObj.responds(to: recordInitSel) {
            let imp = recordObj.method(for: recordInitSel)
            typealias RecordInitMethod = @convention(c) (NSObject, Selector, NSString, Int) -> NSObject
            record = unsafeBitCast(imp, to: RecordInitMethod.self)(recordObj, recordInitSel, "tapsmith-longpress" as NSString, currentOrientation)
        } else {
            record = (recordClass as! NSObject.Type).init()
        }

        let addPathSel = NSSelectorFromString("addPointerEventPath:")
        if record.responds(to: addPathSel) {
            record.perform(addPathSel, with: path)
        }

        if dispatchViaDaemonSession(record) { return true }
        if dispatchSync(record) { return true }
        if dispatchViaDevice(record) { return true }
        return false
    }

    /// Modifier flags for key press events.
    struct KeyModifiers: OptionSet {
        let rawValue: UInt64
        static let command = KeyModifiers(rawValue: 1 << 20) // UIKeyModifierCommand
        static let shift = KeyModifiers(rawValue: 1 << 17)   // UIKeyModifierShift
        static let option = KeyModifiers(rawValue: 1 << 19)  // UIKeyModifierAlternate
        static let control = KeyModifiers(rawValue: 1 << 18) // UIKeyModifierControl
    }

    /// Press a key with optional modifiers (e.g., Cmd+V for paste).
    static func keyPress(key: String, modifiers: KeyModifiers = []) -> Bool {
        guard let pathClass = objc_lookUpClass("XCPointerEventPath"),
              let recordClass = objc_lookUpClass("XCSynthesizedEventRecord")
        else { return false }

        // Create path for text input
        let pathObj = pathClass.alloc() as! NSObject
        let initSel = NSSelectorFromString("initForTextInput")
        guard pathObj.responds(to: initSel) else { return false }

        let initImp = pathObj.method(for: initSel)
        typealias InitMethod = @convention(c) (NSObject, Selector) -> NSObject
        let path = unsafeBitCast(initImp, to: InitMethod.self)(pathObj, initSel)

        // typeKey:modifiers:atOffset:
        let keySel = NSSelectorFromString("typeKey:modifiers:atOffset:")
        if path.responds(to: keySel) {
            let keyImp = path.method(for: keySel)
            typealias KeyMethod = @convention(c) (NSObject, Selector, NSString, UInt64, TimeInterval) -> Void
            let keyFunc = unsafeBitCast(keyImp, to: KeyMethod.self)
            keyFunc(path, keySel, key as NSString, modifiers.rawValue, 0.0)
        } else {
            NSLog("[EventSynth] typeKey:modifiers:atOffset: not available")
            return false
        }

        // Create record and add path
        let recordObj = recordClass.alloc() as! NSObject
        let recordInitSel = NSSelectorFromString("initWithName:interfaceOrientation:")
        let record: NSObject
        if recordObj.responds(to: recordInitSel) {
            let rImp = recordObj.method(for: recordInitSel)
            typealias RMethod = @convention(c) (NSObject, Selector, NSString, Int) -> NSObject
            record = unsafeBitCast(rImp, to: RMethod.self)(recordObj, recordInitSel, "tapsmith-key" as NSString, currentOrientation)
        } else {
            record = (recordClass as! NSObject.Type).init()
        }

        let addSel = NSSelectorFromString("addPointerEventPath:")
        if record.responds(to: addSel) {
            record.perform(addSel, with: path)
        }

        return dispatchViaDaemonSession(record) || dispatchSync(record) || dispatchViaDevice(record)
    }

    /// Type text using event synthesis (bypasses quiescence).
    ///
    /// Follows Maestro's exact approach:
    /// 1. Try _XCT_sendString (direct daemon text input API)
    /// 2. Fall back to XCPointerEventPath.typeText with slow first-char strategy
    ///    (type first char at speed 1, wait 500ms, type rest at speed 30)
    static func typeText(_ text: String) -> Bool {
        guard !text.isEmpty else { return true }

        // Approach 1: _XCT_sendString — direct text input via daemon proxy
        if sendStringViaDaemon(text) {
            return true
        }

        // Approach 2: XCPointerEventPath.typeText (Maestro-style slow typing)
        // Type first character slowly, wait, then type rest faster
        let firstChar = String(text.prefix(1))
        let rest = String(text.dropFirst())

        if !typeViaEventPath(firstChar, typingSpeed: 1) {
            return false
        }

        // Brief delay after first character (Maestro's workaround for iOS
        // dropping characters / not triggering delegates). 150ms is sufficient
        // on Apple Silicon with the _XCT_sendString primary path.
        Thread.sleep(forTimeInterval: 0.15)

        if !rest.isEmpty {
            return typeViaEventPath(rest, typingSpeed: 30)
        }
        return true
    }

    /// Send text via _XCT_sendString:maximumFrequency:completion: on daemon proxy.
    /// This is a higher-level API that types through the keyboard system.
    private static func sendStringViaDaemon(_ text: String) -> Bool {
        guard let sessionClass = objc_lookUpClass("XCTRunnerDaemonSession") else { return false }

        let sharedSel = NSSelectorFromString("sharedSession")
        let sessionNSObj = sessionClass as AnyObject
        guard sessionNSObj.responds(to: sharedSel),
              let session = sessionNSObj.perform(sharedSel)?.takeUnretainedValue() as? NSObject
        else { return false }

        let proxySel = NSSelectorFromString("daemonProxy")
        guard session.responds(to: proxySel),
              let proxy = session.perform(proxySel)?.takeUnretainedValue() as? NSObject
        else { return false }

        let sendSel = NSSelectorFromString("_XCT_sendString:maximumFrequency:completion:")
        guard proxy.responds(to: sendSel) else {
            NSLog("[EventSynth] _XCT_sendString not available on daemon proxy")
            return false
        }

        var success = false
        var done = false

        let imp = proxy.method(for: sendSel)
        typealias SendMethod = @convention(c) (NSObject, Selector, NSString, UInt64, @escaping @convention(block) (NSError?) -> Void) -> Void
        let sendFunc = unsafeBitCast(imp, to: SendMethod.self)
        // Use a moderate typing frequency. 30 chars/sec can drop characters
        // in React Native apps where the JS bridge processes keystrokes async.
        // 15 chars/sec (~67ms per keystroke) is reliable under CPU pressure
        // (e.g. 4+ parallel workers sharing a machine).
        sendFunc(proxy, sendSel, text as NSString, 15) { error in
            success = (error == nil)
            if let error = error {
                NSLog("[EventSynth] _XCT_sendString error: %@", error.localizedDescription)
            }
            done = true
        }

        // Pump the RunLoop while waiting instead of blocking with a semaphore.
        let deadline = Date(timeIntervalSinceNow: 30)
        while !done && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
        }
        if !done {
            NSLog("[EventSynth] _XCT_sendString timed out")
            return false
        }
        if success {
            NSLog("[EventSynth] Text sent via _XCT_sendString")
        }
        return success
    }

    /// Type text via XCPointerEventPath.typeText (lower-level API).
    private static func typeViaEventPath(_ text: String, typingSpeed: Int) -> Bool {
        guard let pathClass = objc_lookUpClass("XCPointerEventPath"),
              let recordClass = objc_lookUpClass("XCSynthesizedEventRecord")
        else { return false }

        // Create path for text input
        let pathObj = pathClass.alloc() as! NSObject
        let initSel = NSSelectorFromString("initForTextInput")
        guard pathObj.responds(to: initSel) else { return false }

        let initImp = pathObj.method(for: initSel)
        typealias InitMethod = @convention(c) (NSObject, Selector) -> NSObject
        let path = unsafeBitCast(initImp, to: InitMethod.self)(pathObj, initSel)

        // Type the text
        let typeSel = NSSelectorFromString("typeText:atOffset:typingSpeed:shouldRedact:")
        guard path.responds(to: typeSel) else { return false }

        let typeImp = path.method(for: typeSel)
        typealias TypeMethod = @convention(c) (NSObject, Selector, NSString, TimeInterval, UInt64, Bool) -> Void
        unsafeBitCast(typeImp, to: TypeMethod.self)(path, typeSel, text as NSString, 0.0, UInt64(typingSpeed), false)

        // Create record
        let recordObj = recordClass.alloc() as! NSObject
        let recordInitSel = NSSelectorFromString("initWithName:interfaceOrientation:")
        let record: NSObject
        if recordObj.responds(to: recordInitSel) {
            let rImp = recordObj.method(for: recordInitSel)
            typealias RMethod = @convention(c) (NSObject, Selector, NSString, Int) -> NSObject
            record = unsafeBitCast(rImp, to: RMethod.self)(recordObj, recordInitSel, "tapsmith-type" as NSString, currentOrientation)
        } else {
            record = (recordClass as! NSObject.Type).init()
        }

        let addPathSel = NSSelectorFromString("addPointerEventPath:")
        if record.responds(to: addPathSel) {
            record.perform(addPathSel, with: path)
        }

        // Dispatch via daemon session (Maestro approach)
        return dispatchViaDaemonSession(record) || dispatchSync(record) || dispatchViaDevice(record)
    }

    // MARK: - Private

    private static func synthesizeTap(at point: CGPoint, duration: TimeInterval) -> Bool {
        // 1. Create XCPointerEventPath for touch
        guard let pathClass = objc_lookUpClass("XCPointerEventPath") else {
            NSLog("[EventSynth] XCPointerEventPath class not found")
            return false
        }

        let pathObj = pathClass.alloc() as! NSObject
        let initSel = NSSelectorFromString("initForTouchAtPoint:offset:")
        guard pathObj.responds(to: initSel) else {
            NSLog("[EventSynth] XCPointerEventPath initForTouchAtPoint:offset: not found")
            return false
        }

        // Call initForTouchAtPoint:offset: using unsafeBitCast (Maestro approach)
        let initImp = pathObj.method(for: initSel)
        typealias InitMethod = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> NSObject
        let initFunc = unsafeBitCast(initImp, to: InitMethod.self)
        let path = initFunc(pathObj, initSel, point, 0.0)

        // Add a moveToPoint at the same location — this generates a touchesMoved
        // event which helps UIScrollView's gesture recognizer classify the gesture
        // as a stationary tap (not a scroll), allowing the event to pass through
        // to child responders like TouchableOpacity.
        let moveSel = NSSelectorFromString("moveToPoint:atOffset:")
        if path.responds(to: moveSel) {
            let moveImp = path.method(for: moveSel)
            typealias MoveMethod = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> Void
            let moveFunc = unsafeBitCast(moveImp, to: MoveMethod.self)
            moveFunc(path, moveSel, point, duration * 0.5)
        }

        // Call liftUpAtOffset:
        let liftSel = NSSelectorFromString("liftUpAtOffset:")
        if path.responds(to: liftSel) {
            let liftImp = path.method(for: liftSel)
            typealias LiftMethod = @convention(c) (NSObject, Selector, TimeInterval) -> Void
            let liftFunc = unsafeBitCast(liftImp, to: LiftMethod.self)
            liftFunc(path, liftSel, duration)
        }

        // 2. Create XCSynthesizedEventRecord and add the path
        guard let recordClass = objc_lookUpClass("XCSynthesizedEventRecord") else {
            NSLog("[EventSynth] XCSynthesizedEventRecord class not found")
            return false
        }

        let record: NSObject
        let recordInitSel = NSSelectorFromString("initWithName:interfaceOrientation:")
        let recordObj = recordClass.alloc() as! NSObject
        if recordObj.responds(to: recordInitSel) {
            // Use unsafeBitCast to pass interfaceOrientation as Int (not NSNumber)
            let imp = recordObj.method(for: recordInitSel)
            typealias RecordInitMethod = @convention(c) (NSObject, Selector, NSString, Int) -> NSObject
            let initFunc = unsafeBitCast(imp, to: RecordInitMethod.self)
            record = initFunc(recordObj, recordInitSel, "tapsmith-tap" as NSString, currentOrientation)
        } else {
            record = (recordClass as! NSObject.Type).init()
        }

        let addPathSel = NSSelectorFromString("addPointerEventPath:")
        if record.responds(to: addPathSel) {
            record.perform(addPathSel, with: path)
        }

        // 3. Try daemon session first (proven to deliver events to the app),
        // then sync, then device synthesizer as fallbacks.
        if dispatchViaDaemonSession(record) {
            return true
        }
        if dispatchSync(record) {
            return true
        }
        if dispatchViaDevice(record) {
            return true
        }
        NSLog("[EventSynth] All dispatch methods failed")
        return false
    }

    /// Synchronous dispatch using XCSynthesizedEventRecord.synthesizeWithError:
    /// This avoids the semaphore deadlock that can occur with async dispatch.
    private static func dispatchSync(_ record: NSObject) -> Bool {
        let sel = NSSelectorFromString("synthesizeWithError:")
        guard record.responds(to: sel) else {
            return false
        }

        var error: NSError?
        let imp = record.method(for: sel)
        typealias SynthMethod = @convention(c) (NSObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>) -> Bool
        let synthFunc = unsafeBitCast(imp, to: SynthMethod.self)
        let result = synthFunc(record, sel, &error)

        if let error = error {
            NSLog("[EventSynth] synthesizeWithError failed: %@", error.localizedDescription)
        }
        return result
    }

    /// Dispatch event via XCUIDevice.shared.eventSynthesizer (Appium/WDA approach)
    private static func dispatchViaDevice(_ record: NSObject) -> Bool {
        let device = XCUIDevice.shared as NSObject

        let synthSel = NSSelectorFromString("eventSynthesizer")
        guard device.responds(to: synthSel),
              let synthesizer = device.perform(synthSel)?.takeUnretainedValue() as? NSObject
        else {
            NSLog("[EventSynth] XCUIDevice.eventSynthesizer not available")
            return false
        }

        let dispatchSel = NSSelectorFromString("synthesizeEvent:completion:")
        guard synthesizer.responds(to: dispatchSel) else {
            NSLog("[EventSynth] eventSynthesizer.synthesizeEvent:completion: not available")
            return false
        }

        var success = false
        var done = false

        // Call synthesizeEvent:completion: using unsafeBitCast
        let imp = synthesizer.method(for: dispatchSel)
        typealias SynthMethod = @convention(c) (NSObject, Selector, NSObject, @escaping @convention(block) (Bool, NSError?) -> Void) -> Void
        let synthFunc = unsafeBitCast(imp, to: SynthMethod.self)
        synthFunc(synthesizer, dispatchSel, record) { result, error in
            if let error = error {
                NSLog("[EventSynth] Synthesis error: %@", error.localizedDescription)
            }
            success = result
            done = true
        }

        // Pump the RunLoop while waiting — do NOT block with a semaphore,
        // because we're on the main thread and the completion callback may
        // need the RunLoop to deliver XPC replies.
        let deadline = Date(timeIntervalSinceNow: 10)
        while !done && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
        }
        return success
    }

    /// Dispatch event via XCTRunnerDaemonSession (Maestro approach, fallback)
    private static func dispatchViaDaemonSession(_ record: NSObject) -> Bool {
        guard let sessionClass = objc_lookUpClass("XCTRunnerDaemonSession") else {
            NSLog("[EventSynth] XCTRunnerDaemonSession not available")
            return false
        }

        let sharedSel = NSSelectorFromString("sharedSession")
        let sessionNSObj = sessionClass as AnyObject
        guard sessionNSObj.responds(to: sharedSel),
              let session = sessionNSObj.perform(sharedSel)?.takeUnretainedValue() as? NSObject
        else {
            NSLog("[EventSynth] Could not get shared XCTRunnerDaemonSession")
            return false
        }

        let proxySel = NSSelectorFromString("daemonProxy")
        guard session.responds(to: proxySel),
              let proxy = session.perform(proxySel)?.takeUnretainedValue() as? NSObject
        else {
            NSLog("[EventSynth] Could not get daemonProxy")
            return false
        }

        let synthSel = NSSelectorFromString("_XCT_synthesizeEvent:completion:")
        guard proxy.responds(to: synthSel) else {
            NSLog("[EventSynth] _XCT_synthesizeEvent:completion: not available on proxy")
            return false
        }

        var success = false
        var done = false

        let imp = proxy.method(for: synthSel)
        typealias SynthMethod = @convention(c) (NSObject, Selector, NSObject, @escaping @convention(block) (NSError?) -> Void) -> Void
        let synthFunc = unsafeBitCast(imp, to: SynthMethod.self)
        synthFunc(proxy, synthSel, record) { error in
            success = (error == nil)
            if let error = error {
                NSLog("[EventSynth] Daemon synthesis error: %@", error.localizedDescription)
            }
            done = true
        }

        // Pump the RunLoop while waiting — do NOT block with a semaphore,
        // because we're on the main thread and the completion callback may
        // need the RunLoop to deliver XPC replies.
        let deadline = Date(timeIntervalSinceNow: 10)
        while !done && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
        }
        return success
    }

}
