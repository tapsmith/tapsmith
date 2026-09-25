import XCTest
import Foundation

/// Routes incoming JSON commands to the appropriate handler.
///
/// JSON protocol:
///   Request:  {"id": "uuid", "method": "methodName", "params": {...}}
///   Response: {"id": "uuid", "result": {...}}
///         or: {"id": "uuid", "error": {"type": "...", "message": "..."}}
///
/// Mirrors the Android agent's CommandHandler.kt.
class CommandHandler {
    private var app: XCUIApplication
    private var elementFinder: ElementFinder
    private var snapshotFinder: SnapshotElementFinder
    private var actionExecutor: ActionExecutor
    private var waitEngine: WaitEngine
    private var hierarchyDumper: HierarchyDumper

    /// Cache of last clipboard text set via setClipboard.
    private var lastClipboardText = ""
    /// When the daemon gives up on the command being handled: its
    /// `readTimeoutMs`, counted from the command's arrival (PILOT-223 — the
    /// occlusion wait never touches past it). nil from an older daemon.
    private var commandReadDeadline: Date?

    // Interactive-mirror live-drag: iOS can't stream touches, so buffer the
    // path during the drag and dispatch it as one gesture on touchUp.
    // touchDown/Move/Up/Cancel arrive on gRPC pool threads, so all access to
    // touchPath is guarded by touchPathLock (Swift Array is not thread-safe).
    private var touchPath: [(CGPoint, TimeInterval)] = []
    private let touchPathLock = NSLock()

    init(
        app: XCUIApplication,
        elementFinder: ElementFinder,
        snapshotFinder: SnapshotElementFinder,
        actionExecutor: ActionExecutor,
        waitEngine: WaitEngine,
        hierarchyDumper: HierarchyDumper
    ) {
        self.app = app
        self.elementFinder = elementFinder
        self.snapshotFinder = snapshotFinder
        self.actionExecutor = actionExecutor
        self.waitEngine = waitEngine
        self.hierarchyDumper = hierarchyDumper
    }

    private func targetBundleId(fallback params: [String: Any]? = nil) -> String {
        if let bundleId = params?["bundleId"] as? String, !bundleId.isEmpty { return bundleId }
        if let package = params?["package"] as? String, !package.isEmpty { return package }
        return ProcessInfo.processInfo.environment["TAPSMITH_TARGET_BUNDLE_ID"] ?? ""
    }

    /// Accept SpringBoard's custom URL-scheme confirmation ("Open in <app>?")
    /// if it is covering the app after a deep-link launch.
    ///
    /// We tap Open, not Cancel: on a fresh simulator the confirmation can gate
    /// URL delivery, so cancelling leaves the deep link undelivered.
    @discardableResult
    private func acceptOpenInAppDialogIfPresent(
        springboard: XCUIApplication? = nil,
        timeout: TimeInterval = 0.0
    ) -> Bool {
        let sb = springboard ?? XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let openButton = sb.buttons["Open"]
        var exists = false
        _ = ObjCExceptionCatcher.catchException {
            exists = openButton.waitForExistence(timeout: timeout)
        }
        if exists {
            _ = ObjCExceptionCatcher.catchException {
                openButton.tap()
            }
            Thread.sleep(forTimeInterval: 0.2)
            return true
        }
        return false
    }

    /// True when the app's accessibility tree has rendered interactive content.
    ///
    /// Uses `app.snapshot()` — the same mechanism as `GetUiHierarchy` — rather
    /// than direct element queries (`app.staticTexts.firstMatch.exists`). After
    /// a deep link the daemon cold-launches the target app out of process via
    /// `simctl openurl`; XCUITest has not "attached" to a process it did not
    /// launch, so `XCUIApplication.state` and direct element existence queries
    /// are unreliable during that window (they report not-running / empty even
    /// while the app is foreground and fully rendered). `snapshot()` works in
    /// that same window, which is why hierarchy dumps succeed when the state
    /// query does not.
    private func appHasRenderedContent(_ app: XCUIApplication) -> Bool {
        var has = false
        _ = ObjCExceptionCatcher.catchException {
            guard let snapshot = try? app.snapshot() else { return }
            has = snapshotContainsContent(snapshot)
        }
        return has
    }

    /// Recursively check whether a snapshot tree contains any rendered,
    /// user-meaningful element (text, input, or control).
    private func snapshotContainsContent(_ snapshot: XCUIElementSnapshot) -> Bool {
        switch snapshot.elementType {
        case .staticText, .textField, .secureTextField, .textView, .searchField,
             .button, .link, .image, .switch:
            return true
        default:
            break
        }
        for child in snapshot.children where snapshotContainsContent(child) {
            return true
        }
        return false
    }

    private func safeAppState(_ app: XCUIApplication) -> XCUIApplication.State {
        var state: XCUIApplication.State = .unknown
        _ = ObjCExceptionCatcher.catchException {
            state = app.state
        }
        return state
    }

    /// Dismiss SpringBoard's "Open in <app>?" confirmation and wait for the
    /// target app to actually render content after a deep-link launch.
    ///
    /// Readiness is detected via `app.snapshot()` (content present) and SpringBoard
    /// queries (dialog accepted) — both work for the out-of-process, simctl-launched
    /// target app. We deliberately do NOT gate on `XCUIApplication.state`: it is
    /// unreliable until XCUITest attaches to the externally-launched process, and
    /// gating on it caused deep links that had actually reached their destination
    /// to be reported as failures.
    ///
    /// Returns true ONLY when the app has rendered content. On timeout it returns
    /// false — the first cold, trust-gated openurl on a fresh sim intermittently
    /// fails to foreground the app (it lands back on SpringBoard with no dialog),
    /// and the daemon re-delivers the deep link when we report not-delivered. We
    /// must NOT treat "no dialog" as success, or a never-launched app would be
    /// reported as ready and the next action would run against SpringBoard.
    private func waitForDeepLinkDestination(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            // One SpringBoard query per iteration: acceptOpenInAppDialogIfPresent
            // with timeout 0.0 is `.exists` + tap in a single call. If it taps a
            // dialog, loop again; otherwise check for rendered content.
            if self.acceptOpenInAppDialogIfPresent(springboard: springboard, timeout: 0.0) {
                // Dialog accepted — re-check on the next iteration.
            } else if appHasRenderedContent(app) {
                return true
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    enum HooksEpochOutcome {
        case acknowledged(UInt64)
        case hookError(String)
        case timedOut
    }

    /// Parse the `@tapsmith/react-native` marker
    /// (`tapsmith-hooks:<v>;epoch=<n>;url=<prefix>[;err=<msg>]`) out of a
    /// snapshot, if the app renders one.
    private func hooksMarker(
        in snapshot: XCUIElementSnapshot
    ) -> (epoch: UInt64, nav: UInt64?, boot: String?, err: String?)? {
        let candidates = [snapshot.label, snapshot.identifier, String(describing: snapshot.value ?? "")]
        for text in candidates {
            guard let range = text.range(of: "tapsmith-hooks:") else { continue }
            let body = text[range.upperBound...]
            let fields = body.split(separator: ";")
            // A different protocol version has unknown semantics — treat it as
            // no marker (same rule as the daemon and SDK parsers).
            guard let version = fields.first, version == "1" else { continue }
            var epoch: UInt64?
            var nav: UInt64?
            var boot: String?
            var err: String?
            for field in fields.dropFirst() {
                let parts = field.split(separator: "=", maxSplits: 1).map(String.init)
                guard parts.count == 2 else { continue }
                if parts[0] == "epoch" { epoch = UInt64(parts[1]) }
                if parts[0] == "nav" { nav = UInt64(parts[1]) }
                if parts[0] == "boot", !parts[1].isEmpty { boot = parts[1] }
                if parts[0] == "err", !parts[1].isEmpty {
                    err = parts[1].removingPercentEncoding ?? parts[1]
                }
            }
            if let epoch { return (epoch, nav, boot, err) }
        }
        for child in snapshot.children {
            if let found = hooksMarker(in: child) { return found }
        }
        return nil
    }

    /// The in-app hooks acknowledged a plain navigation deep link when the
    /// marker's `nav` counter (bumped for every URL the process receives)
    /// advanced past the value read before delivery — or, on a fresh process
    /// (`boot` changed), reports any nav ≥ 1 (the launch URL was handled).
    private func waitForHooksNav(
        _ app: XCUIApplication,
        greaterThan navBefore: UInt64,
        bootBefore: String?,
        timeout: TimeInterval
    ) -> Bool {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            if self.acceptOpenInAppDialogIfPresent(springboard: springboard, timeout: 0.0) {
                // Dialog accepted — re-check on the next iteration.
            } else {
                var acknowledged = false
                _ = ObjCExceptionCatcher.catchException {
                    guard let snapshot = try? app.snapshot(),
                          let marker = self.hooksMarker(in: snapshot),
                          let nav = marker.nav else { return }
                    if let bootBefore, let boot = marker.boot, boot != bootBefore {
                        acknowledged = nav >= 1
                    } else {
                        acknowledged = nav > navBefore
                    }
                }
                if acknowledged { return true }
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    /// Wait until the in-app hooks marker reports an epoch greater than
    /// `epochBefore` — the ack that a declared reset actually ran.
    /// The in-app hook acknowledged a reset when its epoch advanced past the
    /// value read before the request — or, when the marker's per-process
    /// `boot` token changed (the app was relaunched, so the counter restarted
    /// at 0), when the fresh process reports any epoch ≥ 1.
    private func hooksAcknowledged(
        epoch: UInt64, boot: String?, epochBefore: UInt64, bootBefore: String?
    ) -> Bool {
        if let bootBefore, let boot, boot != bootBefore { return epoch >= 1 }
        return epoch > epochBefore
    }

    private func waitForHooksEpoch(
        _ app: XCUIApplication,
        greaterThan epochBefore: UInt64,
        bootBefore: String?,
        timeout: TimeInterval
    ) -> HooksEpochOutcome {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            if self.acceptOpenInAppDialogIfPresent(springboard: springboard, timeout: 0.0) {
                // Dialog accepted — re-check on the next iteration.
            } else {
                var outcome: HooksEpochOutcome?
                _ = ObjCExceptionCatcher.catchException {
                    guard let snapshot = try? app.snapshot(),
                          let marker = self.hooksMarker(in: snapshot),
                          self.hooksAcknowledged(
                              epoch: marker.epoch, boot: marker.boot,
                              epochBefore: epochBefore, bootBefore: bootBefore
                          ) else { return }
                    if let err = marker.err {
                        outcome = .hookError(err)
                    } else {
                        outcome = .acknowledged(marker.epoch)
                    }
                }
                if let outcome { return outcome }
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return .timedOut
    }

    /// Wait for the UI hierarchy to change from its pre-deep-link state after
    /// a warm in-process delivery (`XCUIApplication.open(url:)` to an
    /// already-running app).
    ///
    /// `waitForDeepLinkDestination` is the wrong verify for the warm case: a
    /// warm app trivially "has rendered content", so it would report success
    /// even when the app dropped the Linking event and never navigated — the
    /// historical simulator failure mode this verify exists to catch. Instead
    /// we require the hierarchy to differ from the pre-open dump AND contain
    /// content. The content requirement keeps us polling through transitional
    /// screens that hide their accessibility elements (e.g. the test-app's
    /// `__reset` spinner), matching the cold verify's readiness bar.
    ///
    /// A deep link whose destination renders identically to the current screen
    /// never satisfies the change requirement and times out; the daemon then
    /// falls back to the cold path, which handles that case correctly. That
    /// trade (bounded extra latency, never a wrong verdict) is deliberate.
    private func waitForDeepLinkNavigation(
        _ app: XCUIApplication,
        before: String,
        timeout: TimeInterval
    ) -> Bool {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let dumper = HierarchyDumper(app: app)
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            // Same shape as waitForDeepLinkDestination: one SpringBoard query
            // per iteration in case "Open in <app>?" gates the warm delivery.
            if self.acceptOpenInAppDialogIfPresent(springboard: springboard, timeout: 0.0) {
                // Dialog accepted — re-check on the next iteration.
            } else {
                var navigated = false
                _ = ObjCExceptionCatcher.catchException {
                    guard let snapshot = try? app.snapshot() else { return }
                    if self.snapshotContainsContent(snapshot)
                        && dumper.dump(from: snapshot) != before {
                        navigated = true
                    }
                }
                if navigated {
                    return true
                }
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    /// Whether the simulator display is showing (near-)pure black where the
    /// app's content should be.
    ///
    /// CI simulators intermittently stop compositing the app's window while
    /// the process, its accessibility tree, and even tap dispatch keep
    /// working (observed on GitHub macOS runners, July 2026). Warm deep-link
    /// delivery verifies navigation via the accessibility tree, so without a
    /// pixel check it reports success against a black display and carries
    /// the broken state into subsequent tests; the cold path's terminate +
    /// relaunch recreates the render surface and recovers.
    ///
    /// Downscales one screenshot and takes the maximum channel value across
    /// all sampled pixels, excluding the top and bottom 12% (the status
    /// bar's clock/battery — and the home indicator — keep rendering even
    /// when the app's window has stopped compositing). Any visible content,
    /// including sparse light text on a dark-mode screen, produces bright
    /// samples; a false positive merely costs a cold relaunch, never a
    /// wrong verdict.
    private func displayAppearsBlack() -> Bool {
        let image = XCUIScreen.main.screenshot().image
        guard let cgImage = image.cgImage, cgImage.width > 8, cgImage.height > 8 else {
            return false
        }
        let sampleWidth = 64
        let sampleHeight = 128
        let bytesPerPixel = 4
        var pixels = [UInt8](repeating: 0, count: sampleWidth * sampleHeight * bytesPerPixel)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: sampleWidth,
                height: sampleHeight,
                bitsPerComponent: 8,
                bytesPerRow: sampleWidth * bytesPerPixel,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.interpolationQuality = .low
            context.draw(
                cgImage,
                in: CGRect(x: 0, y: 0, width: sampleWidth, height: sampleHeight)
            )
            return true
        }
        guard drawn else { return false }

        // Exclude both vertical ends rather than reasoning about CGContext
        // row order — the status bar is at one end, the home indicator at
        // the other, and both keep rendering over a dead app window.
        let excludedRows = Int(Double(sampleHeight) * 0.12)
        var maxChannel: UInt8 = 0
        for row in excludedRows..<(sampleHeight - excludedRows) {
            for col in 0..<sampleWidth {
                let offset = (row * sampleWidth + col) * bytesPerPixel
                maxChannel = max(maxChannel, pixels[offset], pixels[offset + 1], pixels[offset + 2])
            }
        }
        return maxChannel < 10
    }

    /// Dismiss any blocking iOS system dialog currently covering the app
    /// (e.g. "Save Password?", "Allow Notifications?", iCloud Keychain
    /// prompts). Returns true if a dialog was tapped through. Intended for
    /// physical iOS devices where iOS system UI can cover the app between
    /// test actions; simulators rarely show these dialogs, and the
    /// findElement call site is compiled out there (PILOT-290).
    ///
    /// Follows SystemDialogPolicy: permission prompts are ACCEPTED, never
    /// denied — a single denial of e.g. the notification prompt is
    /// permanent for that bundle id, with no supported reset short of
    /// reinstalling the app.
    ///
    /// Some dialogs are hosted by SpringBoard (notifications, location
    /// permission prompts). Others — notably iCloud Keychain's "Save
    /// Password?" prompt — are presented as a remote view controller
    /// inside the target app's process via AuthenticationServices, so
    /// they appear under the target app's hierarchy, not SpringBoard.
    /// We check both, but allow-style labels are only probed on
    /// SpringBoard: in the app's own hierarchy they could match ordinary
    /// in-app buttons ("Continue", "OK") and derail the test.
    /// When the simulator-side "Save Password?" probe last ran. It costs one
    /// extra query per first-snapshot miss, so it is rate-limited.
    private var lastSavePasswordProbe = Date.distantPast
    private let savePasswordProbeInterval: TimeInterval = 1.5

    /// Dismiss iOS 26's iCloud Keychain "Save Password?" sheet if it is up.
    /// Simulators do show this one system prompt after a sign-in. It is
    /// presented inside the target app's process, so it appears in the app's
    /// own hierarchy (an XCUIElementTypeSheet) and replaces the accessibility
    /// tree underneath — post-login assertions then see nothing but the
    /// sheet — and it never trips the UIInterruptionMonitor because snapshot
    /// queries are not interactions. The daemon disables autofill with
    /// `defaults write`, but under CoreSimulator pressure those writes time
    /// out and the sheet comes back. Only the "Not Now" button of a sheet
    /// titled "Save Password?" is ever tapped — scoped to the sheet so an
    /// app that happens to render those labels itself is left alone, and a
    /// dismissal, never a permission denial (PILOT-290). Probes at most once
    /// per `savePasswordProbeInterval` so the miss path stays cheap.
    @discardableResult
    private func dismissSavePasswordSheetIfPresent() -> Bool {
        let now = Date()
        guard now.timeIntervalSince(lastSavePasswordProbe) >= savePasswordProbeInterval else {
            return false
        }
        lastSavePasswordProbe = now
        let sheet = app.sheets
            .containing(.staticText, identifier: "Save Password?")
            .firstMatch
        guard sheet.exists else { return false }
        let notNow = sheet.buttons["Not Now"]
        guard notNow.exists else { return false }
        NSLog("[SystemDialog] Dismissing iCloud Keychain 'Save Password?' sheet via Not Now")
        notNow.tap()
        Thread.sleep(forTimeInterval: 0.2)
        return true
    }

    @discardableResult
    private func dismissBlockingSystemDialogs() -> Bool {
        if acceptOpenInAppDialogIfPresent(timeout: 0.1) {
            return true
        }

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let sweeps: [(XCUIApplication, [String])] = [
            (app, SystemDialogPolicy.dismissButtonLabels),
            (springboard, SystemDialogPolicy.allowButtonLabels + SystemDialogPolicy.dismissButtonLabels),
        ]
        for (source, labels) in sweeps {
            for label in labels {
                let button = source.buttons[label]
                if button.exists && button.isHittable {
                    button.tap()
                    Thread.sleep(forTimeInterval: 0.25)
                    return true
                }
            }
        }
        return false
    }

    /// Recreate the XCUIApplication and helper objects so the runner can
    /// rebind to a freshly relaunched app process without restarting xctrunner.
    private func rebindApp(bundleId: String? = nil) -> XCUIApplication {
        let resolvedBundleId = bundleId ?? targetBundleId()
        let refreshedApp = resolvedBundleId.isEmpty
            ? XCUIApplication()
            : XCUIApplication(bundleIdentifier: resolvedBundleId)
        // Re-apply instance-level quiescence disable on the new app object.
        // Class-level swizzling persists, but setWaitForQuiescence:false
        // is per-process-instance and needs to be set on each new XCUIApplication.
        QuiescenceDisabler.disable(for: refreshedApp)
        app = refreshedApp
        elementFinder = ElementFinder(app: refreshedApp)
        snapshotFinder = SnapshotElementFinder(app: refreshedApp)
        actionExecutor = ActionExecutor(app: refreshedApp)
        // Eagerly cache the screen size, but tolerate a transient XCUITest
        // interruption: `screenSize` probes `app.windows.firstMatch.frame`, a
        // direct query that can raise an "Interrupting test" NSException while
        // SpringBoard is still settling (e.g. right after a deep-link launch).
        // On failure leave the cache unset — ActionExecutor resolves it lazily
        // on next use — so re-binding never fails a command that already
        // succeeded.
        _ = ObjCExceptionCatcher.catchException {
            actionExecutor.cachedScreenSize = snapshotFinder.screenSize
        }
        waitEngine = WaitEngine(app: refreshedApp)
        hierarchyDumper = HierarchyDumper(app: refreshedApp)
        return refreshedApp
    }

    func handle(rawJson: String) -> String {
        guard let data = rawJson.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return errorResponse(id: nil, type: "PARSE_ERROR", message: "Invalid JSON")
        }

        let id = json["id"] as? String
        guard let method = json["method"] as? String else {
            return errorResponse(id: id, type: "INVALID_REQUEST", message: "Missing 'method' field")
        }

        let params = json["params"] as? [String: Any] ?? [:]
        commandReadDeadline = (params["readTimeoutMs"] as? NSNumber)
            .map { Date(timeIntervalSinceNow: $0.doubleValue / 1000) }

        do {
            var result: [String: Any]?
            var swiftError: Error?

            // Wrap in ObjC @try/@catch to prevent NSExceptions from
            // XCUITest private APIs from crashing the agent process.
            // Swift's do/catch only catches Swift Error types — ObjC
            // NSExceptions bypass it entirely and terminate the process.
            let objcError = ObjCExceptionCatcher.catchException {
                do {
                    result = try self.dispatch(method: method, params: params)
                } catch {
                    swiftError = error
                }
            }

            if let error = swiftError {
                throw error
            }
            if let objcError = objcError {
                let msg = objcError.localizedDescription
                NSLog("[TapsmithCommand] ObjC exception in method '\(method)': \(msg)")
                return errorResponse(id: id, type: "INTERNAL_ERROR", message: msg)
            }
            guard let result = result else {
                return errorResponse(id: id, type: "INTERNAL_ERROR", message: "Command dispatch returned no result")
            }
            return successResponse(id: id, result: result)
        } catch let error as AgentError {
            return errorResponse(id: id, type: error.type, message: error.message)
        } catch {
            NSLog("[TapsmithCommand] Error handling method '\(method)': \(error)")
            return errorResponse(id: id, type: "INTERNAL_ERROR", message: error.localizedDescription)
        }
    }

    /// An action's time budget from its params, in ms. JSON numbers arrive as
    /// NSNumber; absent (the SDK's explicit zero timeout) means no waiting.
    private func actionTimeoutMs(_ params: [String: Any]) -> Int64 {
        (params["timeout"] as? NSNumber)?.int64Value ?? 0
    }

    /// Resolve a top-level selector the way `findElement` does: one snapshot
    /// first; on a miss, clear a blocking system dialog and retry, then poll
    /// the wait engine for up to `timeoutMs` (only when it is at least 1 s).
    private func findTopLevelElement(_ selector: ElementSelector, timeoutMs timeout: Int64) throws -> ElementInfo {
        do {
            return try snapshotFinder.findElement(selector)
        } catch {
            // Before falling through to the wait engine, check for a
            // blocking iOS system dialog covering the target — iCloud
            // Keychain can pop up after a sign-in tap and obscure
            // post-login UI. If we tap one away, try the snapshot
            // once more before polling.
            //
            // Physical devices sweep every known dialog (Save
            // Password, Allow Notifications, …). Simulators only
            // handle the Keychain "Save Password?" sheet, the one
            // system prompt they do show (iOS 26): the full sweep
            // would probe two extra hierarchies on a hot path where
            // first-snapshot misses are routine, and it historically
            // denied permission prompts here, permanently poisoning
            // simulator notification state (PILOT-290).
            #if targetEnvironment(simulator)
            let dismissed = dismissSavePasswordSheetIfPresent()
            #else
            let dismissed = dismissBlockingSystemDialogs()
            #endif
            if dismissed, let retried = try? snapshotFinder.findElement(selector) {
                return retried
            }
            guard timeout >= 1000 else { throw error }
            // Element not in current snapshot — poll with wait engine
            return try waitEngine.waitForElement(
                selector,
                timeoutMs: timeout,
                elementFinder: elementFinder,
                snapshotFinder: snapshotFinder
            )
        }
    }

    // MARK: - Element Resolution

    /// Resolve an element from params, supporting both elementId (cached) and selector-based lookup.
    ///
    /// **Cost:** elementId path is several live `XCUIElement` property
    /// reads (~6–10 IPC) via `getElementInfo`; selector path is one
    /// `app.snapshot()` IPC + tree walk. The selector path is usually
    /// cheaper for repeated lookups against a fresh state because it
    /// re-reads the whole tree in one IPC instead of N attribute IPCs.
    /// Loops that re-resolve the same element across iterations (e.g.
    /// the `clearText` backspace loop) should prefer the selector
    /// form so each pass sees a fresh snapshot.
    private func resolveElement(_ params: [String: Any]) throws -> ElementInfo {
        if let elementId = params["elementId"] as? String, !elementId.isEmpty {
            // Try snapshot finder cache first, then fall back to old cache
            if let info = try? snapshotFinder.getElementInfo(elementId) {
                return info
            }
            // The live-query read can fail on newer iOS 26 runtimes even for
            // an id minted milliseconds earlier (the lazily-built XCUIElement
            // query evaluates differently live than the snapshot walk did,
            // and some selector shapes never get a query at all). The
            // find-time snapshot BOUNDS are cached unconditionally — recover
            // with a minimal ElementInfo so the coordinate-driven action
            // paths (planTouch) proceed instead of surfacing a spurious
            // "gone stale" for an element that is still on screen.
            // Guard degenerate frames: a cached CGRect.null has an infinite
            // origin, and Int(x) is a Swift runtime FATAL ERROR for both
            // non-finite and beyond-Int-range values — crashing the whole
            // agent over one bad cached frame. 100k pt is far beyond any
            // real screen.
            if let frame = snapshotFinder.getBounds(elementId),
               !frame.isNull, frame.origin.x.isFinite, frame.origin.y.isFinite,
               frame.size.width.isFinite, frame.size.height.isFinite,
               abs(frame.origin.x) < 100_000, abs(frame.origin.y) < 100_000,
               abs(frame.width) < 100_000, abs(frame.height) < 100_000 {
                return ElementInfo(
                    elementId: elementId,
                    className: "",
                    text: nil,
                    contentDescription: nil,
                    resourceId: nil,
                    hint: nil,
                    bounds: ElementBounds(
                        left: Int(frame.origin.x),
                        top: Int(frame.origin.y),
                        right: Int(frame.origin.x + frame.width),
                        bottom: Int(frame.origin.y + frame.height)
                    ),
                    isEnabled: true,
                    isChecked: false,
                    isFocused: false,
                    isClickable: true,
                    isFocusable: false,
                    isScrollable: false,
                    isVisible: true,
                    isSelected: false,
                    childCount: 0,
                    role: "",
                    viewportRatio: 1.0
                )
            }
            return try elementFinder.getElementInfo(elementId)
        }
        let selector = SelectorParser.parse(params)
        if selector.xpath != nil {
            return try elementFinder.findElement(selector)
        }
        // Use snapshot-based finding for speed (single IPC call)
        return try snapshotFinder.findElement(selector)
    }

    /// Resolve one end of a drag (source/target) from its params: a cached
    /// elementId when present, else a selector resolved against the given
    /// timeout. Mirrors `resolveElement` but the timeout lives on the parent
    /// dragAndDrop command, not these nested objects.
    private func resolveDragEnd(_ params: [String: Any], timeoutMs: Int64) throws -> ElementInfo {
        if let elementId = params["elementId"] as? String, !elementId.isEmpty {
            if let info = try? snapshotFinder.getElementInfo(elementId) {
                return info
            }
            return try elementFinder.getElementInfo(elementId)
        }
        let selector = SelectorParser.parse(params)
        do {
            return try snapshotFinder.findElement(selector)
        } catch {
            return try waitEngine.waitForElement(
                selector,
                timeoutMs: timeoutMs,
                elementFinder: elementFinder,
                snapshotFinder: snapshotFinder
            )
        }
    }

    /// Get the XCUIElement for an element ID, checking both caches.
    ///
    /// **Cost:** O(1) cache lookup, no IPC. The IPC happens later when
    /// the caller reads a property off the returned element — each
    /// `.value`, `.label`, `.frame`, `.isHittable` access crosses
    /// the test runner ↔ app boundary. Batch property reads or
    /// prefer `resolveElement` (which dumps everything in one
    /// snapshot pass) when you need more than one attribute.
    private func getXCUIElement(_ elementId: String) throws -> XCUIElement {
        if let elem = try? snapshotFinder.getElement(elementId) {
            return elem
        }
        return try elementFinder.getElement(elementId)
    }


    // MARK: - Occlusion-aware touch planning (PILOT-223)

    /// How an element-addressed touch should be delivered.
    private enum TouchPlan {
        /// XCUITest's hit test passed — tap through the element itself.
        case hittableElement(XCUIElement)
        /// Touch at this screen point; nothing in the snapshot covers it.
        /// `visible` is the uncovered part of the element around it.
        case point(CGPoint, visible: CGRect)
        /// No part of the element is on screen.
        case offScreen
    }

    /// Decide where a touch on `element` can land, waiting up to `timeoutMs`
    /// for anything covering it to go away (Playwright waits out a click's
    /// intercepting element the same way). Throws ELEMENT_COVERED, naming the
    /// cover, when it is still there at the deadline — never plans a touch
    /// that would land on the cover.
    ///
    /// `preferElementTap` short-circuits to `.hittableElement` when XCUITest
    /// calls the element hittable, skipping the snapshot: `XCUIElement.tap()`
    /// picks its own hit point, which already avoids the keyboard (it taps
    /// the visible part of a half-covered element). Coordinate gestures
    /// (double tap, long press, HID input) need an explicit point and always
    /// take the snapshot.
    ///
    /// **Cost** per pass: `isHittable` (one hit-test IPC); when not
    /// short-circuited, one `snapshot()` of the element plus one of the app.
    private func planTouch(
        _ element: ElementInfo,
        timeoutMs: Int64,
        preferElementTap: Bool,
        reserveMs: Int64 = 0
    ) throws -> TouchPlan {
        var clock = TouchPlanClock(
            start: Date(),
            timeoutMs: timeoutMs,
            readDeadline: commandReadDeadline,
            reserveSeconds: Double(max(0, reserveMs)) / 1000
        )
        while true {
            let xcElem = try? getXCUIElement(element.elementId)
            let hittable = xcElem?.isHittable ?? false
            if preferElementTap, hittable, let xcElem {
                try refuseIfLate(clock)
                return .hittableElement(xcElem)
            }
            let verdict = occlusionVerdict(for: element, xcElem: xcElem, isHittable: hittable)
            // Checked after the pass: a slow pass that ends past the deadline
            // fails now instead of paying for another one.
            try refuseIfLate(clock)
            var sleep = clock.sleepBeforeNextPass(at: Date())
            switch verdict {
            case .clear(let point, let visible)?:
                return .point(point, visible: visible)
            case .unlocated(let point, let visible)?:
                // Moved between the two reads (animating): read again for a
                // moment — whatever the budget — and fall back to the old
                // coordinate tap only if it does not settle.
                if clock.shouldFallBackWhenUnlocated(at: Date()) {
                    return .point(point, visible: visible)
                }
                sleep = TouchPlanClock.pollSeconds
            case .offScreen?:
                return .offScreen
            case .gone?:
                // "stale" makes the SDK re-resolve an id-addressed handle.
                throw AgentError.elementNotFound(
                    "Element not found any more — it went away before it could be touched (it may have gone stale)"
                )
            case .covered(let cover)?:
                guard sleep != nil else {
                    throw AgentError.elementCovered(coveredMessage(cover, timeoutMs: timeoutMs))
                }
                NSLog("[TapsmithCommand] \(element.elementId) is covered by \(cover); waiting")
            case nil:
                // No tree to check against. A hittable element lets XCUITest
                // pick its own hit point (a coordinate from its bounds could
                // be under the keyboard); an unhittable one is never touched
                // blind — it could be anything on top.
                if hittable, let xcElem { return .hittableElement(xcElem) }
                guard sleep != nil else {
                    throw AgentError.actionFailed(
                        "Element is not hittable, and the UI hierarchy could not be read to check what covers it"
                    )
                }
            }
            if let sleep { Thread.sleep(forTimeInterval: sleep) }
        }
    }

    private func refuseIfLate(_ clock: TouchPlanClock) throws {
        guard clock.isTooLateToAct(at: Date()) else { return }
        throw AgentError.actionFailed(
            "Ran out of time checking whether the element is covered: the daemon would give up before the touch finished, so not touching it"
        )
    }

    /// nil when no tree could be read.
    private func occlusionVerdict(
        for element: ElementInfo,
        xcElem: XCUIElement?,
        isHittable: Bool
    ) -> OcclusionAnalyzer.Verdict? {
        let target: OcclusionAnalyzer.Target
        if let snap = try? xcElem?.snapshot() {
            target = .init(frame: snap.frame, elementType: snap.elementType, label: snap.label, identifier: snap.identifier)
        } else {
            // The live element can't be read (it unmounted, or an iOS 26 live
            // query that fails for an element still on screen): identify it
            // by what was cached when it was found. If that no longer matches
            // anything, the analyzer reports it gone.
            let b = element.bounds
            let frame = snapshotFinder.getBounds(element.elementId)
                ?? CGRect(x: b.left, y: b.top, width: b.width, height: b.height)
            let identity = snapshotFinder.getIdentity(element.elementId)
            target = .init(
                frame: frame,
                elementType: identity?.elementType,
                label: identity?.label,
                identifier: identity?.identifier,
                isLive: false
            )
        }
        let screenSize = snapshotFinder.screenSize
        // takeSnapshot retries a transiently failing or empty snapshot.
        guard let appSnapshot = try? snapshotFinder.takeSnapshot() else { return nil }
        return OcclusionAnalyzer(snapshot: appSnapshot, screenSize: screenSize)
            .analyze(target, isHittable: isHittable)
    }

    private func coveredMessage(_ cover: String, timeoutMs: Int64) -> String {
        var message = "Element is covered by \(cover), so a touch would land on it instead"
        if timeoutMs > 0 { message += " (still covered after waiting \(timeoutMs)ms)" }
        if cover == "the keyboard" {
            message += ". Dismiss the keyboard first (device.hideKeyboard()) or scroll the element into view."
        }
        return message
    }

    /// Tap a resolved element. Prefer XCUIElement.tap() — synthesized
    /// coordinate events are unreliable with UIKit/RN gesture recognizers
    /// regardless of element type. A coordinate tap is only the fallback for
    /// elements XCUITest calls unhittable, and only at a point the snapshot
    /// shows uncovered (PILOT-223: the unguarded fallback tapped covers).
    private func tapResolvedElement(_ element: ElementInfo, timeoutMs: Int64) throws {
        // Surface a stale id up front (the SDK's re-resolve retry keys on the
        // "gone stale" message) — but only once nothing else can tap: the
        // bounds-cache recovery path in resolveElement hands us ids with no
        // live query that the coordinate fallback can still tap.
        var staleError: Error?
        do { _ = try getXCUIElement(element.elementId) } catch { staleError = error }

        switch try planTouch(element, timeoutMs: timeoutMs, preferElementTap: true) {
        case .hittableElement(let xcElem):
            actionExecutor.tapHittable(xcElem)
        case .point(let point, _):
            NSLog("[TapsmithCommand] \(element.elementId) is not hittable; tapping the uncovered point \(point)")
            actionExecutor.tapCoordinates(x: Int(point.x.rounded()), y: Int(point.y.rounded()))
        case .offScreen:
            throw staleError ?? AgentError.actionFailed("Element is not hittable (may be off-screen or hidden)")
        }
    }

    /// Double-tap a resolved element. Prefer coordinate synthesis: it encodes
    /// both taps in one event record with precise offsets, so the inter-tap
    /// gap cannot be stretched past the app's double-tap window by CI load.
    /// XCUIElement.doubleTap() (whose two taps are subject to scheduling
    /// jitter) is the fallback when no part of the element is on screen.
    private func doubleTapResolvedElement(_ element: ElementInfo, intervalMs: Int, timeoutMs: Int64) throws {
        // An evicted id needs no up-front lookup to raise "stale": with no
        // live query and nothing cached to recognise it by, planTouch reports
        // it gone. Ids that never had a query (placeholder, className, …)
        // still take the coordinate path.
        switch try planTouch(element, timeoutMs: timeoutMs, preferElementTap: false) {
        case .point(let point, _):
            actionExecutor.doubleTapCoordinates(
                x: Int(point.x.rounded()),
                y: Int(point.y.rounded()),
                intervalMs: intervalMs
            )
        case .hittableElement, .offScreen:
            try actionExecutor.doubleTap(try getXCUIElement(element.elementId))
        }
    }

    /// Where a focusing tap (type, clear, focus) may land. Those taps land at
    /// a coordinate, so like the gestures they wait out a cover and then
    /// throw ELEMENT_COVERED rather than focus-tapping the keyboard (a stray
    /// key into the field that has focus) or an overlay.
    private enum FocusTarget: Equatable {
        /// Tap inside this uncovered part of the element.
        case area(CGRect)
        /// Tap through the XCUIElement: hittable with no tree to pick a point
        /// from, or off screen — its hittability guard refuses the latter
        /// (the find-time bounds could be anything by now).
        case element
    }

    /// `focusTarget` for a field that may already have focus. One immediate
    /// check first: when a focusing tap can land, the field gets it (it puts
    /// the caret at the end). When it cannot — typically the field is behind
    /// the keyboard it raised — and a live query confirms the field is the
    /// focused input, nil: input already goes to it. Otherwise wait out the
    /// cover as usual. Only the live query decides: `isFocused` can come from
    /// a stale hint after the app moved focus itself (skipping the tap then
    /// would type into another field), or be absent altogether (an id served
    /// from the bounds cache).
    private func focusTargetUnlessFocused(_ element: ElementInfo, timeoutMs: Int64) throws -> FocusTarget? {
        do {
            return try focusTarget(element, timeoutMs: 0)
        } catch {
            if isLiveFocused(element) { return nil }
            guard timeoutMs > 0 else { throw error }
            return try focusTarget(element, timeoutMs: timeoutMs)
        }
    }

    private func isLiveFocused(_ element: ElementInfo) -> Bool {
        guard let live = snapshotFinder.liveFocusedTextInputFrame() else { return false }
        let b = element.bounds
        let frame = CGRect(x: b.left, y: b.top, width: b.width, height: b.height)
        // Bounds are integer-truncated.
        return OcclusionAnalyzer.framesMatch(live, frame, tolerance: 1.5)
    }

    private func focusTarget(_ element: ElementInfo, timeoutMs: Int64) throws -> FocusTarget {
        switch try planTouch(element, timeoutMs: timeoutMs, preferElementTap: false) {
        case .point(_, let visible):
            return .area(visible)
        case .hittableElement, .offScreen:
            return .element
        }
    }

    /// Refocus a field mid-command (a typeText retry, clearText's refocuses),
    /// planned against the element as it is now: the first focusing tap can
    /// have moved it (a KeyboardAvoidingView lifting it above the keyboard),
    /// so an area captured before that tap would now be under the keyboard.
    /// One check, no waiting — a covered field throws ELEMENT_COVERED and an
    /// off-screen one refuses, never a blind tap.
    private func refocusForTyping(_ element: ElementInfo, settleTime: TimeInterval) throws {
        let plan: TouchPlan
        do {
            plan = try planTouch(element, timeoutMs: 0, preferElementTap: false)
        } catch {
            // Still the focused input (typically behind the keyboard it
            // raised): input reaches it without a tap.
            if isLiveFocused(element) { return }
            throw error
        }
        switch plan {
        case .point(_, let visible):
            try focusElementForTyping(element, settleTime: settleTime, within: visible)
        case .hittableElement:
            try focusElementForTyping(element, settleTime: settleTime, within: nil)
        case .offScreen:
            throw AgentError.actionFailed("Element is not hittable — cannot refocus it")
        }
    }

    /// Tap inside a text input, biased toward the trailing edge so refocusing
    /// during retries keeps the insertion point at the end of the current
    /// value instead of moving it into the middle of existing text, inside
    /// `area` (the element's uncovered part, from `focusTarget`). Without an
    /// area, XCUITest taps the element itself (refused when unhittable).
    private func focusElementForTyping(
        _ element: ElementInfo,
        settleTime: TimeInterval,
        within area: CGRect?
    ) throws {
        if let area {
            let inset = min(12, max(1, area.width / 4))
            let x = max(area.minX + 1, area.maxX - inset)
            actionExecutor.tapCoordinates(x: Int(x.rounded()), y: Int(area.midY.rounded()))
            snapshotFinder.recordFocusedTextInputHint(element)
            waitForKeyboardAppearance(maxWait: settleTime)
            return
        }
        let xcElem = try getXCUIElement(element.elementId)
        guard xcElem.isHittable else {
            throw AgentError.actionFailed("Element is not hittable — cannot type text")
        }
        xcElem.tap()
        snapshotFinder.recordFocusedTextInputHint(element)
        waitForKeyboardAppearance(maxWait: settleTime)
    }

    private func waitForKeyboardAppearance(maxWait: TimeInterval) {
        let deadline = CFAbsoluteTimeGetCurrent() + maxWait
        while CFAbsoluteTimeGetCurrent() < deadline {
            let snap = try? app.snapshot()
            let dict = snap.map { $0.dictionaryRepresentation } ?? [:]
            if hasKeyboardInSnapshot(dict) { return }
            Thread.sleep(forTimeInterval: 0.15)
        }
    }

    /// Type through EventSynthesizer, but don't advance to the next grapheme
    /// until the target field's snapshot reflects the current one. This fixes
    /// slow CI simulators dropping an in-string character (e.g. "test" ->
    /// "tet"), which suffix-only verification cannot repair.
    private func typeTextWithPerGraphemeVerification(
        _ text: String,
        selectorParams: [String: Any],
        initialElement: ElementInfo,
        delayMs: Int
    ) throws {
        let isSecureField = initialElement.className == "XCUIElementTypeSecureTextField"
        var expectedValue = initialElement.text ?? ""
        var expectedLength = expectedValue.count
        let timeoutPerGrapheme = max(1.0, TimeInterval(delayMs) / 1000.0 * 5.0)
        let pollInterval = 0.02
        let maxAttempts = 3

        for grapheme in text {
            let next = String(grapheme)

            // Single-line UITextField treats Return as submit/blur. After that
            // the original field no longer receives trailing input, so preserve
            // the existing iOS behavior tested by locator-regressions.
            if next == "\n" && initialElement.className != "XCUIElementTypeTextView" {
                if !actionExecutor.typeViaEventSynthesizer(next) {
                    throw AgentError.actionFailed("typeText failed to synthesize Return key")
                }
                Thread.sleep(forTimeInterval: max(0.05, TimeInterval(delayMs) / 1000.0))
                return
            }

            let beforeValue = expectedValue
            let beforeLength = expectedLength
            expectedValue += next
            expectedLength += 1

            var delivered = false
            var lastObserved = beforeValue

            for attempt in 1...maxAttempts {
                if !actionExecutor.typeViaEventSynthesizer(next) {
                    NSLog("[typeText] EventSynthesizer returned false for grapheme '\(next)'")
                }

                let deadline = Date(timeIntervalSinceNow: timeoutPerGrapheme)
                while Date() < deadline {
                    let fresh = try resolveElement(selectorParams)
                    let current = fresh.text ?? ""
                    lastObserved = current

                    if isSecureField {
                        if current.count == expectedLength {
                            delivered = true
                            break
                        }
                        if current.count > expectedLength {
                            throw AgentError.actionFailed(
                                "typeText produced extra secure-field input: " +
                                    "expected length \(expectedLength), got \(current.count)"
                            )
                        }
                    } else {
                        if current == expectedValue {
                            delivered = true
                            break
                        }
                        if current != beforeValue && !expectedValue.hasPrefix(current) {
                            throw AgentError.actionFailed(
                                "typeText diverged after grapheme '\(next)': " +
                                    "expected prefix '\(expectedValue)', got '\(current)'"
                            )
                        }
                    }

                    RunLoop.current.run(
                        mode: .default,
                        before: Date(timeIntervalSinceNow: pollInterval)
                    )
                }

                if delivered { break }
                NSLog(
                    "[typeText] Retry \(attempt) for grapheme '\(next)': " +
                        "expected '\(expectedValue)', got '\(lastObserved)'"
                )
                if lastObserved == beforeValue {
                    let refreshed = try resolveElement(selectorParams)
                    do {
                        try refocusForTyping(refreshed, settleTime: 0.25)
                    } catch let error as AgentError {
                        // Part of the text is already in the field: never let
                        // this read as a stale element, which the SDK would
                        // answer by typing the whole text again. The type
                        // alone names the cause without echoing a cover's
                        // label (which could contain anything).
                        // No typed text in the message either: the SDK
                        // spots a stale element by matching "stale" in it.
                        throw AgentError.actionFailed(
                            "typeText could not refocus the field after \(expectedValue.count) character(s) (\(error.type))"
                        )
                    }
                }
            }

            guard delivered else {
                let expectedDescription = isSecureField
                    ? "length \(expectedLength)"
                    : "'\(expectedValue)'"
                let observedDescription = isSecureField
                    ? "length \(lastObserved.count)"
                    : "'\(lastObserved)'"
                throw AgentError.actionFailed(
                    "typeText could not deliver grapheme '\(next)': " +
                        "expected \(expectedDescription), got \(observedDescription) " +
                        "(previous length \(beforeLength))"
                )
            }

            if delayMs > 0 {
                Thread.sleep(forTimeInterval: TimeInterval(delayMs) / 1000.0)
            }
        }
    }

    // MARK: - Dispatch

    private func dispatch(method: String, params: [String: Any]) throws -> [String: Any] {
        switch method {

        // ─── Element Finding ───

        case "findElement":
            let selector = SelectorParser.parse(params)
            let parentId = params["parentId"] as? String
            let timeout = params["timeout"] as? Int64 ?? 10000
            let element: ElementInfo

            // Use snapshot-based finding (fast) for top-level queries.
            // Fall back to wait engine for queries that need polling.
            if parentId == nil {
                element = try findTopLevelElement(selector, timeoutMs: timeout)
            } else {
                element = try elementFinder.findElement(selector, parentId: parentId)
            }
            return element.toDict()

        case "findElements":
            let selector = SelectorParser.parse(params)
            let parentId = params["parentId"] as? String
            // Use snapshot finder for speed
            if parentId == nil {
                let elements = try snapshotFinder.findElements(selector)
                return ["elements": elements.map { $0.toDict() }]
            }
            let elements = try elementFinder.findElements(selector, parentId: parentId)
            return ["elements": elements.map { $0.toDict() }]

        // ─── Tap Actions ───

        case "tap":
            // Coordinates arrive as JSON numbers (NSNumber) and may be
            // fractional logical points (coordinate taps from the SDK /
            // UI-mode mirror), so `as? Int` would fail — go via NSNumber.
            let x = (params["x"] as? NSNumber)?.intValue ?? -1
            let y = (params["y"] as? NSNumber)?.intValue ?? -1
            if x >= 0 && y >= 0 {
                actionExecutor.tapCoordinates(x: x, y: y)
                snapshotFinder.recordFocusedTextInputHint(at: CGPoint(x: CGFloat(x), y: CGFloat(y)))
            } else {
                let element = try resolveElement(params)
                try tapResolvedElement(element, timeoutMs: actionTimeoutMs(params))
                snapshotFinder.recordFocusedTextInputHint(element)
            }
            // Force-flush pending touch events: take a snapshot() which does
            // a round-trip through the XCTest daemon. This acts as a barrier,
            // ensuring all pending XPC events (including the synthesized touch)
            // have been fully processed before we return. Without this, the
            // next command's snapshot IPC can race with touch delivery.
            touchBarrier()
            return ["success": true]

        case "doubleTap":
            let element = try resolveElement(params)
            let intervalMs = params["intervalMs"] as? Int ?? 0
            try doubleTapResolvedElement(element, intervalMs: intervalMs, timeoutMs: actionTimeoutMs(params))
            touchBarrier()
            return ["success": true]

        case "longPress":
            // NSNumber coercion: JSON numbers aren't directly castable to Int/
            // Int64, and coordinates may be fractional logical points.
            let duration = (params["duration"] as? NSNumber)?.int64Value ?? 1000
            let x = (params["x"] as? NSNumber)?.intValue ?? -1
            let y = (params["y"] as? NSNumber)?.intValue ?? -1
            if x >= 0 && y >= 0 {
                actionExecutor.longPressCoordinates(x: x, y: y, durationMs: duration)
            } else {
                let element = try resolveElement(params)
                // The press itself must still fit the daemon's read timeout.
                let coverBudget = max(0, actionTimeoutMs(params) - duration)
                switch try planTouch(element, timeoutMs: coverBudget, preferElementTap: false, reserveMs: duration) {
                case .point(let point, _):
                    actionExecutor.longPressCoordinates(
                        x: Int(point.x.rounded()),
                        y: Int(point.y.rounded()),
                        durationMs: duration
                    )
                case .hittableElement, .offScreen:
                    let xcElem = try getXCUIElement(element.elementId)
                    try actionExecutor.longPress(xcElem, durationMs: duration)
                }
            }
            touchBarrier()
            return ["success": true]

        case "resolveActionPoint":
            // Where an element-addressed touch can land without hitting a
            // cover (PILOT-223), for the daemon's HID-injected gestures, which
            // bypass the agent's own gesture code. Waits out covers like the
            // agent's gestures do; ELEMENT_COVERED when one outlasts the
            // timeout.
            // Resolve like findElement (which this replaces on the HID path):
            // dismiss a blocking system dialog, wait for a missing element.
            // Whatever the wait used comes off the cover-wait budget.
            let started = Date()
            let budget = actionTimeoutMs(params)
            let element: ElementInfo
            if let elementId = params["elementId"] as? String, !elementId.isEmpty {
                element = try resolveElement(params)
            } else {
                element = try findTopLevelElement(SelectorParser.parse(params), timeoutMs: budget)
            }
            let remaining = max(0, budget - Int64(Date().timeIntervalSince(started) * 1000))
            switch try planTouch(element, timeoutMs: remaining, preferElementTap: false) {
            case .point(let point, _):
                return ["x": Double(point.x), "y": Double(point.y)]
            case .hittableElement, .offScreen:
                // No point to hand out (off screen, or hittable with no tree
                // to choose one from): the daemon should use the agent's own
                // gesture, which lets XCUITest pick — or refuses.
                return ["useElement": true]
            }

        // ─── Text Input ───

        case "typeText":
            let text = params["text"] as? String ?? ""
            if text.isEmpty {
                return ["success": true]
            }
            let delayMs = params["typingDelayMs"] as? Int ?? 0
            let selectorKeys = [
                "role", "id", "contentDesc", "className", "testId",
                "hint", "textContains", "elementId", "focused",
                "label", "xpath", "resourceId", "parent", "parentId",
                "enabled", "checked", "selected", "expanded",
            ]
            let hasSelector = selectorKeys.contains { params[$0] != nil }
            let isFocusedOnlySelector = (
                (params["focused"] as? Bool) == true
                && selectorKeys.allSatisfy { $0 == "focused" || params[$0] == nil }
            )
            if hasSelector && !(isFocusedOnlySelector && delayMs == 0) {
                var selectorParams = params
                selectorParams.removeValue(forKey: "text")
                selectorParams.removeValue(forKey: "typingDelayMs")
                if isFocusedOnlySelector {
                    waitForKeyboardAppearance(maxWait: 1.0)
                }
                let element = try resolveElement(selectorParams)
                if !isFocusedOnlySelector {
                    // Half the budget at most for a cover, so the typing
                    // after it still fits the daemon's read timeout.
                    switch try focusTargetUnlessFocused(element, timeoutMs: actionTimeoutMs(params) / 2) {
                    case .area(let area)?:
                        try focusElementForTyping(element, settleTime: 0.5, within: area)
                    case .element?:
                        try focusElementForTyping(element, settleTime: 0.5, within: nil)
                    case nil:
                        break
                    }
                }
                if delayMs > 0 {
                    let focused = isFocusedOnlySelector ? element : try resolveElement(selectorParams)
                    try typeTextWithPerGraphemeVerification(
                        text,
                        selectorParams: selectorParams,
                        initialElement: focused,
                        delayMs: delayMs
                    )
                } else if !actionExecutor.typeViaEventSynthesizer(text, delayMs: delayMs) {
                    throw AgentError.actionFailed("typeText failed to synthesize input")
                }
            } else {
                if !actionExecutor.typeTextWithoutFocus(text, delayMs: delayMs) {
                    throw AgentError.actionFailed("typeText failed to synthesize input")
                }
            }
            return ["success": true]

        case "clearText":
            // The backspace loop re-resolves via `resolveElement(params)`
            // each iteration to get a fresh snapshot-based text value.
            // Reading `XCUIElement.value` directly was tried (cold-10 #1)
            // and reverted (32b0fa7): the cached XCUIElement query uses
            // `descendants(matching: .any).firstMatch` without a type
            // filter, so it can resolve to a non-input sibling (e.g. an
            // "Email" header) instead of the textfield — making the loop
            // think the field is already empty. The snapshot path's
            // role/type filter avoids this.
            let element = try resolveElement(params)
            // Refuse to "clear" non-text elements. The backspace loop below
            // assumes `element.text` reflects the editable value; on a
            // wrapper / button / static text it would compare against the
            // accessibility label, decide there's no progress, and exit
            // having typed up to one batch of backspaces — silently
            // mis-targeting whichever field happens to be focused.
            let textFieldClassNames: Set<String> = [
                "XCUIElementTypeTextField",
                "XCUIElementTypeSecureTextField",
                "XCUIElementTypeTextView",
                "XCUIElementTypeSearchField",
            ]
            guard textFieldClassNames.contains(element.className) else {
                throw AgentError.actionFailed(
                    "clearText only works on text input elements (got className=\(element.className))"
                )
            }
            // No-op fast path: if the snapshot already shows the field
            // empty AND the live `XCUIElement.value` agrees (placeholder-
            // mis-classification disambiguation, mirroring the iter-1
            // guard in the backspace loop below), skip everything —
            // tap-to-focus, Cmd+A, the resolve round-trips, all of it.
            // Test setup commonly calls `clear()` defensively on every
            // field; a no-op clear used to cost ~150ms per call (one tap,
            // 0.1s wait, Cmd+A, 0.05s wait, backspace, 0.05s wait,
            // resolveElement). For a setup that pre-clears a half-dozen
            // fields that adds up to roughly a second per test.
            if (element.text ?? "").isEmpty {
                let xc = try? getXCUIElement(element.elementId)
                if let xc = xc {
                    let live = (xc.value as? String) ?? ""
                    if live.isEmpty || live == (element.hint ?? "") {
                        return ["success": true]
                    }
                }
                // If getXCUIElement failed, don't trust a potentially
                // stale snapshot — fall through and attempt the clear.
            }
            // iOS text fields don't have a reliable "select all" gesture
            // (triple-tap selects a word; Cmd+A often misses on RN-wrapped
            // controls). Focus the field, try Cmd+A+Delete as a fast path,
            // then fall through to per-character backspaces if the field
            // isn't yet empty (common on RN wrappers that intercept Cmd+A).
            // We loop the backspace path because autocorrect / suggestion
            // bar / RN bridge updates can grow or shrink the value between
            // batches, so a single batch sized off the initial snapshot is
            // brittle.
            // Half the budget at most for a cover (see typeText). Every refocus
            // below is planned afresh (refocusForTyping): this first tap can
            // move the field and bring up a keyboard over its old spot.
            let target = try focusTargetUnlessFocused(element, timeoutMs: actionTimeoutMs(params) / 2)
            if target == nil {
                // Already first responder behind a cover: clear it as is.
            } else if case .area(let area)? = target {
                actionExecutor.tapCoordinates(x: Int(area.midX.rounded()), y: Int(area.midY.rounded()))
                Thread.sleep(forTimeInterval: 0.1)
            } else if let xcElem = try? getXCUIElement(element.elementId), xcElem.isHittable {
                xcElem.tap()
                // Match the snapshot path's 0.1s wait so the upcoming
                // Cmd+A / backspace keypress doesn't race the field
                // becoming first-responder.
                Thread.sleep(forTimeInterval: 0.1)
            } else {
                // Neither path could focus the field. Sending backspaces with
                // nothing focused either silently no-ops or mis-targets
                // whichever element happens to be focused — both worse than
                // failing loudly.
                throw AgentError.actionFailed(
                    "clearText could not focus element \(element.elementId): " +
                        "snapshot bounds were off-screen and the XCUIElement is not hittable"
                )
            }

            // Fast path: Cmd+A then a single backspace. Works on native
            // UITextField and on simulators with a hardware-keyboard
            // mapping; silently no-ops on RN-wrapped controls (which
            // typically don't honor Cmd+A) where we fall through to the
            // per-character loop.
            //
            // We deliberately use `\u{8}` (backspace) instead of
            // `XCUIKeyboardKey.delete` because:
            //   - if Cmd+A took, the keyboard backspace deletes the
            //     entire selection — fast clear in one event
            //   - if Cmd+A didn't take, the cursor is at the end and
            //     backspace deletes one trailing character. That's
            //     still progress; the loop below handles the rest.
            // Sending Delete after a failed selection would either
            // forward-delete (data loss past the cursor) or no-op
            // depending on the IME, hence the safer backspace.
            if EventSynthesizer.keyPress(key: "a", modifiers: .command) {
                Thread.sleep(forTimeInterval: 0.1)
                actionExecutor.typeTextWithoutFocus("\u{8}")
                Thread.sleep(forTimeInterval: 0.15)
                let afterSelectAll = (try? resolveElement(params)) ?? element
                if (afterSelectAll.text ?? "").isEmpty {
                    try? refocusForTyping(afterSelectAll, settleTime: 0.1)
                    return ["success": true]
                }
                // Cmd+A didn't take (or deleted only one char). Fall
                // through to the per-character backspace loop, which
                // re-reads the value before each batch.
            }

            // Cap iterations so a misbehaving field can't hang the agent. The
            // per-iteration cap of 256 keystrokes covers any realistic field
            // length; multiple iterations let us mop up post-autocorrect
            // residue.
            //
            // We re-resolve via the snapshot finder rather than reading
            // `XCUIElement.value` directly: the snapshot path applies the
            // selector's role/type filter during its tree walk, so it
            // matches the right textfield. The cached XCUIElement query
            // is built with `descendants(matching: .any).firstMatch` (no
            // type constraint, to support RN's `.other`-typed buttons),
            // and `firstMatch` can resolve to the wrong element when
            // multiple nodes share a label — e.g. an "Email" header label
            // sitting above the email textfield will be picked instead of
            // the textfield, and its missing `.value` then makes the loop
            // think the field is already empty.
            let maxIterations = 16
            let perIterationCap = 256
            var lastLength: Int = .max
            var finalLength: Int = .max
            var iterationsRun = 0
            var stalled = false
            for _ in 0..<maxIterations {
                iterationsRun += 1
                let refreshed = (try? resolveElement(params)) ?? element
                let displayed = refreshed.text ?? ""
                finalLength = displayed.count
                if displayed.isEmpty { break }
                // Exit only if the value isn't *shrinking*. Comparing whole
                // strings would prematurely stop on attributed-string /
                // autocorrect compositions where the visible text changes
                // but length still drops between batches; comparing length
                // tolerates that as progress.
                if displayed.count >= lastLength {
                    try? refocusForTyping(refreshed, settleTime: 0.2)
                    let settled = (try? resolveElement(params)) ?? refreshed
                    let settledText = settled.text ?? ""
                    finalLength = settledText.count
                    if settledText.isEmpty { break }
                    if settledText.count < lastLength {
                        lastLength = settledText.count
                        continue
                    }
                    stalled = true
                    break
                }
                lastLength = displayed.count
                // String.count counts grapheme clusters — matches keyboard
                // backspace granularity for ASCII and composed emoji.
                let count = min(displayed.count, perIterationCap)
                actionExecutor.typeTextWithoutFocus(String(repeating: "\u{8}", count: count))
                // EventSynthesizer returns when events are queued, not when
                // RN has committed the resulting text update. Without a short
                // settle, CI can read the pre-backspace snapshot and report a
                // false stall while the field is already clearing.
                Thread.sleep(forTimeInterval: 0.15)
            }
            // If we didn't fully clear, surface the failure rather than
            // silently returning success with residual text in the field.
            // Distinguish "stalled" (backspaces aren't shrinking the value —
            // the field is rejecting input or the snapshot is stale) from
            // "hit the iteration cap" (the field is genuinely larger than
            // maxIterations × perIterationCap can clear) so the operator
            // knows whether to investigate the field or raise the cap.
            if finalLength > 0 {
                let reason = stalled
                    ? "backspace stopped shrinking the value " +
                        "(field rejected input or snapshot is stale)"
                    : "exhausted the \(maxIterations)-iteration cap " +
                        "(\(maxIterations * perIterationCap) keystrokes); " +
                        "field is larger than expected"
                throw AgentError.actionFailed(
                    "clearText could not empty element \(element.elementId): " +
                        "\(finalLength) grapheme cluster(s) remain after " +
                        "\(iterationsRun) iteration\(iterationsRun == 1 ? "" : "s") — \(reason)"
                )
            }
            try? refocusForTyping(element, settleTime: 0.1)
            return ["success": true]

        // ─── Interactive Mirror Live-Drag (buffered touch path) ───

        case "touchDown":
            let x = (params["x"] as? NSNumber)?.doubleValue ?? 0
            let y = (params["y"] as? NSNumber)?.doubleValue ?? 0
            touchPathLock.lock()
            touchPath = [(CGPoint(x: x, y: y), 0.0)]
            touchPathLock.unlock()
            return ["success": true]

        case "touchMove":
            let x = (params["x"] as? NSNumber)?.doubleValue ?? 0
            let y = (params["y"] as? NSNumber)?.doubleValue ?? 0
            let tMs = (params["t"] as? NSNumber)?.doubleValue ?? 0
            touchPathLock.lock()
            if !touchPath.isEmpty {
                touchPath.append((CGPoint(x: x, y: y), tMs / 1000.0))
            }
            touchPathLock.unlock()
            return ["success": true]

        case "touchUp":
            let x = (params["x"] as? NSNumber)?.doubleValue ?? 0
            let y = (params["y"] as? NSNumber)?.doubleValue ?? 0
            let tMs = (params["t"] as? NSNumber)?.doubleValue ?? 0
            // Copy + clear the path under the lock, then synthesize OUTSIDE the
            // lock (event synthesis is slow and must not block other threads).
            touchPathLock.lock()
            var pathToReplay: [(CGPoint, TimeInterval)] = []
            if !touchPath.isEmpty {
                touchPath.append((CGPoint(x: x, y: y), tMs / 1000.0))
                pathToReplay = touchPath
                touchPath = []
            }
            touchPathLock.unlock()
            if !pathToReplay.isEmpty {
                _ = EventSynthesizer.swipePath(pathToReplay)
            }
            // Settle like the existing swipe path.
            Thread.sleep(forTimeInterval: 0.2)
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
            return ["success": true]

        case "touchCancel":
            touchPathLock.lock()
            touchPath = []
            touchPathLock.unlock()
            return ["success": true]

        // ─── Swipe / Scroll ───

        case "swipe":
            if let fromX = (params["fromX"] as? NSNumber)?.doubleValue,
               let fromY = (params["fromY"] as? NSNumber)?.doubleValue,
               let toX = (params["toX"] as? NSNumber)?.doubleValue,
               let toY = (params["toY"] as? NSNumber)?.doubleValue {
                try actionExecutor.drag(
                    from: CGPoint(x: CGFloat(fromX), y: CGFloat(fromY)),
                    to: CGPoint(x: CGFloat(toX), y: CGFloat(toY))
                )
                // Match the settle used by the direction-based swipe below.
                Thread.sleep(forTimeInterval: 0.2)
                RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
                return ["success": true]
            }
            let direction = params["direction"] as? String ?? "up"
            let speed = params["speed"] as? Int ?? 5000
            let distance = params["distance"] as? Double ?? 0.5
            if let elementId = params["elementId"] as? String {
                let xcElem = try getXCUIElement(elementId)
                try actionExecutor.swipe(xcElem, direction: direction, speed: speed, distance: distance)
            } else if let startElement = params["startElement"] as? [String: Any] {
                let startSel = SelectorParser.parse(startElement)
                let startEl = try waitEngine.waitForElement(
                    startSel,
                    timeoutMs: 10000,
                    elementFinder: elementFinder,
                    snapshotFinder: snapshotFinder
                )
                let xcElem = try getXCUIElement(startEl.elementId)
                try actionExecutor.swipe(xcElem, direction: direction, speed: speed, distance: distance)
            } else {
                // Sync screen size to avoid quiescence-triggering
                // app.windows.firstMatch.frame.size read inside swipeScreen().
                actionExecutor.cachedScreenSize = snapshotFinder.screenSize
                try actionExecutor.swipeScreen(direction: direction, speed: speed, distance: distance)
            }
            // Swipe generates scroll momentum that continues for 500ms+.
            // Use a longer settle than the standard touchBarrier so the
            // next command's snapshot doesn't capture mid-momentum positions.
            Thread.sleep(forTimeInterval: 0.2)
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
            return ["success": true]

        case "scroll":
            let direction = params["direction"] as? String ?? "down"
            let targetSelector: ElementSelector?
            if let scrollTo = params["scrollTo"] as? [String: Any] {
                targetSelector = SelectorParser.parse(scrollTo)
            } else {
                targetSelector = nil
            }
            if let container = params["container"] as? [String: Any] {
                let containerSel = SelectorParser.parse(container)
                let containerEl = try waitEngine.waitForElement(
                    containerSel,
                    timeoutMs: 10000,
                    elementFinder: elementFinder,
                    snapshotFinder: snapshotFinder
                )
                let xcElem = try getXCUIElement(containerEl.elementId)
                try actionExecutor.scroll(xcElem, direction: direction, targetSelector: targetSelector)
            } else if let elementId = params["elementId"] as? String {
                let xcElem = try getXCUIElement(elementId)
                try actionExecutor.scroll(xcElem, direction: direction, targetSelector: targetSelector)
            } else {
                try actionExecutor.scrollScreen(direction: direction, targetSelector: targetSelector)
            }
            return ["success": true]

        // ─── Key Press ───

        case "pressKey":
            let key = params["key"] as? String ?? ""
            try actionExecutor.pressKey(key)
            return ["success": true]

        // ─── Drag and Drop ───

        case "dragAndDrop":
            guard let sourceParams = params["source"] as? [String: Any],
                  let targetParams = params["target"] as? [String: Any]
            else {
                throw AgentError.invalidRequest("dragAndDrop requires 'source' and 'target' params")
            }
            let timeout = params["timeout"] as? Int64 ?? 10000
            // Each end may be a cached elementId (positional/filtered handle) or
            // a selector to resolve.
            let sourceEl = try resolveDragEnd(sourceParams, timeoutMs: timeout)
            let targetEl = try resolveDragEnd(targetParams, timeoutMs: timeout)
            // Use snapshot bounds to avoid XCUIElement .frame IPC which can
            // trigger quiescence waits and hang/crash the XCTest session.
            let sourceFrame = snapshotFinder.getBounds(sourceEl.elementId)
                ?? CGRect(x: CGFloat(sourceEl.bounds.left), y: CGFloat(sourceEl.bounds.top),
                          width: CGFloat(sourceEl.bounds.width), height: CGFloat(sourceEl.bounds.height))
            let targetFrame = snapshotFinder.getBounds(targetEl.elementId)
                ?? CGRect(x: CGFloat(targetEl.bounds.left), y: CGFloat(targetEl.bounds.top),
                          width: CGFloat(targetEl.bounds.width), height: CGFloat(targetEl.bounds.height))
            try actionExecutor.drag(from: sourceFrame, to: targetFrame)
            return ["success": true]

        // ─── Select Option ───

        case "selectOption":
            let element = try resolveElement(params)
            let xcElem = try getXCUIElement(element.elementId)
            if let optionText = params["option"] as? String {
                try actionExecutor.selectOption(xcElem, optionText: optionText)
            } else if let index = params["index"] as? Int, index >= 0 {
                try actionExecutor.selectOptionByIndex(xcElem, index: index)
            } else {
                throw AgentError.invalidSelector("selectOption requires either 'option' (string) or 'index' (int)")
            }
            return ["success": true]

        // ─── Pinch Zoom ───

        case "pinchZoom":
            let scale = Float(params["scale"] as? Double ?? 1.0)
            // Keep iOS pinch best-effort for now. XCUITest pinch APIs and
            // lower-level synthesized multi-touch are still destabilizing the
            // runner on Xcode 26, and the current e2e coverage only asserts
            // that the command completes without crashing the session.
            actionExecutor.pinch(at: .zero, scale: scale)
            return ["success": true]

        // ─── Focus / Blur ───

        case "focus":
            let element = try resolveElement(params)
            let target = try focusTargetUnlessFocused(element, timeoutMs: actionTimeoutMs(params))
            if target == nil {
                // Verified focused behind a cover: nothing to do.
            } else if case .area(let area)? = target {
                actionExecutor.tapCoordinates(x: Int(area.midX.rounded()), y: Int(area.midY.rounded()))
            } else {
                let xcElem = try getXCUIElement(element.elementId)
                try actionExecutor.focus(xcElem)
            }
            snapshotFinder.recordFocusedTextInputHint(element)
            return ["success": true]

        case "blur":
            let element = try resolveElement(params)
            let xcElem = try getXCUIElement(element.elementId)
            // Sync screen size to avoid quiescence-triggering
            // app.windows.firstMatch.frame.size read inside blur().
            actionExecutor.cachedScreenSize = snapshotFinder.screenSize
            try actionExecutor.blur(xcElem)
            snapshotFinder.clearFocusedTextInputHint()
            return ["success": true]

        case "highlight":
            let element = try resolveElement(params)
            let xcElem = try getXCUIElement(element.elementId)
            let duration = params["duration"] as? Int64 ?? 1000
            try actionExecutor.highlight(xcElem, durationMs: duration)
            return ["success": true]

        // ─── Screenshots ───

        case "screenshot":
            let screenshot = XCUIScreen.main.screenshot()
            let pngData = screenshot.pngRepresentation
            let base64 = pngData.base64EncodedString()
            return ["data": base64, "format": "png"]

        case "elementScreenshot":
            let element = try resolveElement(params)
            let xcElem = try getXCUIElement(element.elementId)
            let screenshot = xcElem.screenshot()
            let pngData = screenshot.pngRepresentation
            let base64 = pngData.base64EncodedString()
            return ["data": base64, "format": "png"]

        // ─── UI Hierarchy ───

        case "getUiHierarchy":
            let xml = hierarchyDumper.dump()
            return ["hierarchy": xml]

        case "captureTraceState":
            var result: [String: Any] = ["success": true]
            let wantScreenshot = params["screenshot"] as? Bool ?? false
            let wantHierarchy = params["hierarchy"] as? Bool ?? false
            let hasSelector = SelectorParser.hasSelector(params)

            // Take one shared snapshot for hierarchy + element lookup.
            var snapshot: XCUIElementSnapshot?
            var snapshotError: Error?
            if wantHierarchy || hasSelector {
                do {
                    snapshot = try snapshotFinder.takeSnapshot()
                } catch {
                    snapshotError = error
                }
            }

            if hasSelector, let error = snapshotError, snapshot == nil {
                throw error
            }

            if wantScreenshot {
                let screenshot = XCUIScreen.main.screenshot()
                let pngData = screenshot.pngRepresentation
                result["screenshotData"] = pngData.base64EncodedString()
            }
            if wantHierarchy {
                if let snapshot = snapshot {
                    result["hierarchyXml"] = hierarchyDumper.dump(from: snapshot)
                } else if snapshotError != nil {
                    result["hierarchyXml"] = hierarchyDumper.dumpFallback()
                } else {
                    result["hierarchyXml"] = hierarchyDumper.dump()
                }
            }
            if hasSelector {
                let selector = SelectorParser.parse(params)
                if let snapshot = snapshot,
                   let element = try? snapshotFinder.findElement(selector, fromSnapshot: snapshot) {
                    result["elementFound"] = true
                    result["element"] = element.toDict()
                } else {
                    result["elementFound"] = false
                }
            }
            return result

        // ─── Wait ───

        case "waitForIdle":
            let timeout = params["timeout"] as? Int64 ?? 5000
            waitEngine.waitForIdle(timeoutMs: timeout)
            return ["success": true]

        case "waitForElement":
            let selector = SelectorParser.parse(params)
            let timeout = params["timeout"] as? Int64 ?? 10000
            let element = try waitEngine.waitForElement(
                selector,
                timeoutMs: timeout,
                elementFinder: elementFinder,
                snapshotFinder: snapshotFinder
            )
            return element.toDict()

        // ─── Clipboard ───

        case "setClipboard":
            let text = params["text"] as? String ?? ""
            lastClipboardText = text
            UIPasteboard.general.string = text
            return ["success": true]

        case "getClipboard":
            let text = UIPasteboard.general.string ?? lastClipboardText
            return ["text": text]

        // ─── App Lifecycle ───

        case "launchApp":
            // Reactivate the app via XCUIApplication.activate().
            // If the app was terminated, this launches a fresh process.
            // If running in background, this brings it to foreground.
            let targetApp = rebindApp(bundleId: targetBundleId(fallback: params))
            targetApp.activate()
            Thread.sleep(forTimeInterval: 0.5)
            // Dismiss "Save Password?" dialog from iOS Passwords framework.
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let notNow = springboard.buttons["Not Now"]
            if notNow.exists {
                notNow.tap()
                Thread.sleep(forTimeInterval: 0.1)
            }
            return ["success": true]

        case "terminateApp":
            let bundleId = params["bundleId"] as? String ?? params["package"] as? String
            let targetApp = bundleId.map { XCUIApplication(bundleIdentifier: $0) } ?? app
            // Verify the app actually died instead of trusting terminate()'s
            // return: under CoreSimulator pressure it can silently no-op, and
            // callers act on the result — the daemon's deep-link cold path
            // runs `simctl openurl` next, which against a still-running app
            // foregrounds it WITHOUT delivering a navigation event to the
            // app. Retry once, then report failure so the caller can escalate.
            for attempt in 0..<2 {
                _ = ObjCExceptionCatcher.catchException {
                    targetApp.terminate()
                }
                let deadline = Date(timeIntervalSinceNow: 2.0)
                while Date() < deadline {
                    if safeAppState(targetApp) == .notRunning {
                        return ["success": true]
                    }
                    Thread.sleep(forTimeInterval: 0.1)
                }
                if attempt == 0 {
                    NSLog("[TapsmithAgent] terminateApp: app still running after terminate(); retrying")
                }
            }
            throw AgentError.actionFailed(
                "terminateApp: \(bundleId ?? "target app") is still running after terminate()"
            )

        case "getAppState":
            let bundleId = params["bundleId"] as? String ?? params["package"] as? String ?? ""
            let targetApp = XCUIApplication(bundleIdentifier: bundleId)
            let state: String
            switch targetApp.state {
            case .notRunning: state = "stopped"
            case .runningBackground, .runningBackgroundSuspended: state = "background"
            case .runningForeground: state = "foreground"
            case .unknown: state = "stopped"
            @unknown default: state = "stopped"
            }
            return ["state": state]

        case "currentPackage":
            // On iOS, report the target app's bundle ID
            // XCUIApplication doesn't expose bundleID directly.
            // The target bundle ID is set via environment variable at launch.
            let bundleId = ProcessInfo.processInfo.environment["TAPSMITH_TARGET_BUNDLE_ID"] ?? ""
            return ["package": bundleId]

        case "openDeepLink":
            let urlString = params["url"] as? String ?? ""
            guard !urlString.isEmpty, let url = URL(string: urlString) else {
                throw AgentError.actionFailed("openDeepLink: missing or invalid URL")
            }
            let bundleId = targetBundleId(fallback: params)
            // Physical devices have no host-side `simctl openurl`, so the agent
            // delivers the URL itself. On simulators the daemon first tries the
            // same in-process delivery warm (with `requireUiChange` so a dropped
            // Linking event is reported, not masked); on its cold fallback the
            // daemon runs `simctl openurl` and this command only accepts any
            // remaining prompt and rebinds once the target app is foreground.
            let deliverInProcess = params["deliverInProcess"] as? Bool ?? true
            let requireUiChange = params["requireUiChange"] as? Bool ?? false
            // Declared app resets are acknowledged by the @tapsmith/react-native
            // marker's epoch advancing past this value, instead of the
            // hierarchy-change heuristic (which cannot tell a same-screen reset
            // from a dropped Linking event).
            let ackEpochGreaterThan = (params["ackEpochGreaterThan"] as? NSNumber)?.uint64Value
            // Plain navigation links are acknowledged by the marker's `nav`
            // counter — even a link to the screen already showing advances it,
            // where the hierarchy-change heuristic can only time out.
            let ackNavGreaterThan = (params["ackNavGreaterThan"] as? NSNumber)?.uint64Value
            let ackBootBefore = params["ackBootBefore"] as? String
            let targetApp = XCUIApplication(bundleIdentifier: bundleId)
            _ = safeAppState(targetApp)
            QuiescenceDisabler.disable(for: targetApp)

            if deliverInProcess {
                guard #available(iOS 16.4, *) else {
                    throw AgentError.actionFailed(
                        "openDeepLink requires iOS 16.4 or newer for in-process delivery"
                    )
                }

                // Warm delivery needs the pre-open hierarchy to verify against.
                // If the app isn't running with rendered content, warm delivery
                // isn't applicable — fail fast so the daemon can fall back to
                // its cold path instead of paying activate()'s launch cost here.
                var preOpenHierarchy: String?
                if requireUiChange {
                    var preSnapshot: XCUIElementSnapshot?
                    _ = ObjCExceptionCatcher.catchException {
                        preSnapshot = try? targetApp.snapshot()
                    }
                    guard let pre = preSnapshot, snapshotContainsContent(pre) else {
                        throw AgentError.actionFailed(
                            "openDeepLink: app is not running with rendered content; "
                                + "warm in-process delivery is not applicable"
                        )
                    }
                    preOpenHierarchy = HierarchyDumper(app: targetApp).dump(from: pre)
                }

                _ = ObjCExceptionCatcher.catchException {
                    targetApp.activate()
                    Thread.sleep(forTimeInterval: 0.15)
                    targetApp.open(url)
                }

                if let epochBefore = ackEpochGreaterThan {
                    let outcome = waitForHooksEpoch(targetApp, greaterThan: epochBefore, bootBefore: ackBootBefore, timeout: 8.0)
                    switch outcome {
                    case .acknowledged(let epoch):
                        if displayAppearsBlack() {
                            throw AgentError.actionFailed(
                                "openDeepLink: display is not rendering after warm "
                                    + "in-process delivery of \(urlString)"
                            )
                        }
                        _ = rebindApp(bundleId: bundleId)
                        return ["success": true, "epochAfter": epoch]
                    case .hookError(let message):
                        throw AgentError.actionFailed("openDeepLink: in-app reset reported an error: \(message)")
                    case .timedOut:
                        throw AgentError.actionFailed(
                            "openDeepLink: in-app reset did not acknowledge (epoch > \(epochBefore)) "
                                + "after warm in-process delivery of \(urlString)"
                        )
                    }
                }

                if let navBefore = ackNavGreaterThan {
                    if waitForHooksNav(targetApp, greaterThan: navBefore, bootBefore: ackBootBefore, timeout: 8.0) {
                        if displayAppearsBlack() {
                            throw AgentError.actionFailed(
                                "openDeepLink: display is not rendering after warm "
                                    + "in-process delivery of \(urlString)"
                            )
                        }
                        _ = rebindApp(bundleId: bundleId)
                        return ["success": true]
                    }
                    throw AgentError.actionFailed(
                        "openDeepLink: navigation was not acknowledged (nav > \(navBefore)) "
                            + "after warm in-process delivery of \(urlString)"
                    )
                }

                if let before = preOpenHierarchy {
                    if waitForDeepLinkNavigation(targetApp, before: before, timeout: 5.0) {
                        // The hierarchy check can pass against a display that
                        // has stopped compositing (a11y stays healthy while
                        // the screen shows black); reject so the daemon's
                        // cold fallback recreates the render surface.
                        if displayAppearsBlack() {
                            throw AgentError.actionFailed(
                                "openDeepLink: display is not rendering after warm "
                                    + "in-process delivery of \(urlString)"
                            )
                        }
                        _ = rebindApp(bundleId: bundleId)
                        return ["success": true]
                    }
                    throw AgentError.actionFailed(
                        "openDeepLink: UI did not change after warm in-process "
                            + "delivery of \(urlString)"
                    )
                }
            }

            if waitForDeepLinkDestination(targetApp, timeout: 10.0) {
                // Mirror the warm path's pixel gate: a cold relaunch against a
                // compositor that has stopped rendering "succeeds" by every
                // a11y measure while the screen stays black, and reporting
                // success here carries the dead display into every following
                // test. Reject with a distinguishable error so the daemon can
                // escalate (simulator reboot) instead of trusting the a11y tree.
                if displayAppearsBlack() {
                    throw AgentError.actionFailed(
                        "openDeepLink: display is not rendering after cold "
                            + "delivery of \(urlString)"
                    )
                }
                // A cold-delivered declared reset still has to be acknowledged
                // by the in-app hook — rendered content alone is what the
                // hierarchy heuristic could not trust.
                if let epochBefore = ackEpochGreaterThan {
                    switch waitForHooksEpoch(targetApp, greaterThan: epochBefore, bootBefore: ackBootBefore, timeout: 8.0) {
                    case .acknowledged(let epoch):
                        _ = rebindApp(bundleId: bundleId)
                        return ["success": true, "epochAfter": epoch]
                    case .hookError(let message):
                        throw AgentError.actionFailed("openDeepLink: in-app reset reported an error: \(message)")
                    case .timedOut:
                        throw AgentError.actionFailed(
                            "openDeepLink: in-app reset did not acknowledge (epoch > \(epochBefore)) "
                                + "after cold delivery of \(urlString)"
                        )
                    }
                }
                if let navBefore = ackNavGreaterThan,
                   !waitForHooksNav(targetApp, greaterThan: navBefore, bootBefore: ackBootBefore, timeout: 8.0) {
                    throw AgentError.actionFailed(
                        "openDeepLink: navigation was not acknowledged (nav > \(navBefore)) "
                            + "after cold delivery of \(urlString)"
                    )
                }
                _ = rebindApp(bundleId: bundleId)
                return ["success": true]
            }
            throw AgentError.actionFailed(
                "openDeepLink: app did not reach foreground after opening \(urlString)"
            )

        case "acceptOpenInAppDialog":
            let timeoutMs = params["timeout"] as? Int64 ?? 1000
            let dismissed = acceptOpenInAppDialogIfPresent(
                timeout: TimeInterval(timeoutMs) / 1000.0
            )
            return ["success": true, "dismissed": dismissed]

        case "dismissSystemDialogs":
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            for label in ["Open", "Allow", "OK", "Not Now", "Allow While Using App"] {
                let btn = springboard.buttons[label]
                if btn.waitForExistence(timeout: 0.3) {
                    btn.tap()
                    Thread.sleep(forTimeInterval: 0.1)
                }
            }
            return ["success": true]

        // ─── Orientation ───

        case "setOrientation":
            let orientation = params["orientation"] as? String ?? "portrait"
            let target: UIDeviceOrientation
            switch orientation.lowercased() {
            case "landscape":
                target = .landscapeLeft
            case "portrait":
                target = .portrait
            default:
                throw AgentError.actionFailed("Unknown orientation: \(orientation). Use portrait/landscape.")
            }
            // On simulators XCUIDevice.orientation is a straightforward
            // write. On physical devices iOS re-reads the accelerometer
            // almost immediately after the set and can revert if nothing is
            // driving UI re-layout. Write → settle → re-verify → optionally
            // retry once so the subsequent `getOrientation` observes the
            // requested state. If it still doesn't stick, fall through so
            // the caller sees whatever the device settled on — rotation
            // outside of Tapsmith's control is a valid platform state.
            XCUIDevice.shared.orientation = target
            Thread.sleep(forTimeInterval: 0.4)
            if XCUIDevice.shared.orientation != target {
                XCUIDevice.shared.orientation = target
                Thread.sleep(forTimeInterval: 0.4)
            }
            snapshotFinder.invalidateScreenSize()
            return ["success": true]

        case "getOrientation":
            let orientation: String
            switch XCUIDevice.shared.orientation {
            case .landscapeLeft, .landscapeRight: orientation = "landscape"
            default: orientation = "portrait"
            }
            return ["orientation": orientation]

        // ─── Keyboard ───

        case "isKeyboardShown":
            // Use snapshot to check for keyboard instead of app.keyboards.count
            // which triggers quiescence waiting on Xcode 26.
            let snapshot = try? app.snapshot()
            let dict = snapshot.map { $0.dictionaryRepresentation } ?? [:]
            let shown = hasKeyboardInSnapshot(dict)
            return ["shown": shown]

        case "hideKeyboard":
            // Check if keyboard is actually shown before attempting dismissal.
            // A tree that cannot be read is no evidence either way: refuse
            // rather than report a keyboard gone that may still be up —
            // unless the app is not in front (a defensive call after another
            // app came to the front), which has no keyboard of its own up.
            // `app.state` is only consulted once the tree has failed: it is
            // unreliable for an externally launched app until XCUITest
            // attaches (see `dismissOpenURLDialogAndWaitForContent`).
            guard let kbSnapshot = try? snapshotFinder.takeSnapshot() else {
                let appState = safeAppState(app)
                if appState == .notRunning || appState == .runningBackground
                    || appState == .runningBackgroundSuspended {
                    snapshotFinder.clearFocusedTextInputHint()
                    return ["success": true]
                }
                throw AgentError.actionFailed("hideKeyboard could not read the screen to check for the keyboard")
            }
            guard hasKeyboardInSnapshot(kbSnapshot.dictionaryRepresentation) else {
                snapshotFinder.clearFocusedTextInputHint()
                return ["success": true]
            }

            // Let the keyboard finish appearing before planning around it. A
            // keyboard element with no on-screen area yet may still be sliding
            // in (hideKeyboard right after a focusing tap on a slow runner):
            // wait for it rather than call it "nothing to dismiss".
            let appearDeadline = Date(timeIntervalSinceNow: 1.5)
            while keyboardPresence() == .offScreen, Date() < appearDeadline {
                Thread.sleep(forTimeInterval: 0.15)
            }
            Thread.sleep(forTimeInterval: 0.3)
            do {
                try dismissKeyboard()
            } catch {
                if touchedScreen { snapshotFinder.clearFocusedTextInputHint() }
                throw error
            }
            // Off screen first, out of the tree a moment later: give it that
            // moment on every success path, so isKeyboardShown() (any keyboard
            // element) agrees straight after. Best effort — it is already
            // off the screen.
            let treeDeadline = Date(timeIntervalSinceNow: 1.0)
            while keyboardPresence() == .offScreen, Date() < treeDeadline {
                Thread.sleep(forTimeInterval: 0.1)
            }
            // The keyboard leaving the hierarchy precedes the app's own
            // animated relayout completing — give that a beat to settle.
            Thread.sleep(forTimeInterval: 0.35)
            snapshotFinder.clearFocusedTextInputHint()
            return ["success": true]

        // ─── Color Scheme ───

        case "setColorScheme":
            // Color scheme changes are typically handled by the daemon via xcrun simctl ui
            // The agent cannot directly change the system appearance
            let scheme = params["scheme"] as? String ?? "light"
            NSLog("[TapsmithCommand] setColorScheme '\(scheme)' — handled by daemon via simctl")
            return ["success": true]

        case "getColorScheme":
            let style = UITraitCollection.current.userInterfaceStyle
            let scheme: String
            switch style {
            case .dark: scheme = "dark"
            default: scheme = "light"
            }
            return ["scheme": scheme]

        // ─── Permissions ───

        case "grantPermission", "revokePermission":
            // Permissions are handled by the daemon via xcrun simctl privacy
            NSLog("[TapsmithCommand] \(method) — handled by daemon via simctl")
            return ["success": true]

        // ─── Ping ───

        case "ping":
            return ["pong": true]

        default:
            throw AgentError.actionFailed("Unknown method: \(method)")
        }
    }

    // MARK: - JSON Response Builders

    private func successResponse(id: String?, result: [String: Any]) -> String {
        let response: [String: Any] = [
            "id": id as Any? ?? NSNull(),
            "result": result,
        ]
        return jsonString(response) ?? "{\"id\":null,\"error\":{\"type\":\"INTERNAL_ERROR\",\"message\":\"Failed to serialize response\"}}"
    }

    private func errorResponse(id: String?, type: String, message: String) -> String {
        let response: [String: Any] = [
            "id": id as Any? ?? NSNull(),
            "error": [
                "type": type,
                "message": message,
            ],
        ]
        return jsonString(response) ?? "{\"id\":null,\"error\":{\"type\":\"INTERNAL_ERROR\",\"message\":\"Failed to serialize error response\"}}"
    }

    /// Settle time after synthesized gesture actions.
    ///
    /// Touch events travel: XCTest runner → testmanagerd (XPC) → IOKit →
    /// Simulator → App process → UIKit → React Native gesture handler.
    /// The `_XCT_synthesizeEvent` completion callback only confirms step 1.
    /// The remaining propagation takes ~50-100ms through IOKit and the
    /// simulator. Without this settle, the daemon's next command (typically
    /// `findElement` from assertion polling) can snapshot the app state
    /// before the gesture handler has fired, causing spurious failures.
    ///
    /// 60ms is sufficient on Apple Silicon / Xcode 26 for single and
    /// multi-touch events. The RunLoop pump additionally processes any
    /// pending XPC or GCD callbacks.
    private func touchBarrier() {
        Thread.sleep(forTimeInterval: 0.06)
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
    }

    private func jsonString(_ dict: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    /// Put the software keyboard away the ways a user would, trying each in
    /// turn until it is gone (PILOT-363; see `KeyboardDismissPlanner` for
    /// what each one may touch), or throw naming what was tried. Every
    /// strategy is planned on a fresh snapshot, so a keyboard that finished
    /// leaving during the previous one's wait ends it without another touch.
    private func dismissKeyboard() throws {
        // Whether a strategy touched the app (it may have moved focus: the
        // return key's submit handler focusing the next field). The caller
        // clears the focused-field hint then, even when this throws.
        touchedScreen = false
        var attempts: [(KeyboardDismissPlanner.Strategy, KeyboardDismissPlanner.Outcome)] = []
        for strategy in KeyboardDismissPlanner.Strategy.allCases {
            guard let snapshot = try? snapshotFinder.takeSnapshot() else {
                throw AgentError.actionFailed("hideKeyboard could not read the screen to dismiss the keyboard")
            }
            guard hasKeyboardInSnapshot(snapshot.dictionaryRepresentation) else { return }
            let planner = KeyboardDismissPlanner(snapshot: snapshot, screenSize: snapshotFinder.screenSize)
            // A keyboard element with nothing on screen (zero-sized, off
            // screen, after the appearance wait above) covers nothing: there is
            // nothing to put away, and no reason to touch the app or submit the
            // field. The dismissal checks below use the same notion.
            guard planner.keyboardRegion != nil else {
                NSLog("[TapsmithCommand] hideKeyboard: keyboard element has no on-screen area; nothing to dismiss")
                return
            }
            let outcome = runDismissStrategy(strategy, planner: planner)
            if outcome == .keyboardStayed { touchedScreen = true }
            if outcome == .keyboardStayed, waitForKeyboardDismissed(timeout: dismissWait(for: strategy)) {
                NSLog("[TapsmithCommand] hideKeyboard: dismissed by \(strategy.summary)")
                return
            }
            attempts.append((strategy, outcome))
        }
        // The last wait can end just before the keyboard leaves.
        if keyboardGoneNow() == true { return }
        throw AgentError.actionFailed(KeyboardDismissPlanner.failureMessage(attempts))
    }

    /// Set by `dismissKeyboard`: whether any strategy touched the screen.
    private var touchedScreen = false

    /// How long to wait for the keyboard to leave after a strategy ran.
    private func dismissWait(for strategy: KeyboardDismissPlanner.Strategy) -> TimeInterval {
        // The drag strategy waits after each of its drags itself.
        strategy == .scrollSwipe ? 0 : 1.5
    }

    /// How long to wait for the keyboard to leave after one dismiss drag.
    private static let dragWait: TimeInterval = 2.0

    /// Run one dismiss strategy. `.keyboardStayed` means it touched the screen
    /// (the caller waits to see whether the keyboard left); `.notPossible`
    /// means nothing was touched.
    private func runDismissStrategy(
        _ strategy: KeyboardDismissPlanner.Strategy,
        planner: KeyboardDismissPlanner
    ) -> KeyboardDismissPlanner.Outcome {
        let screen = snapshotFinder.screenSize
        switch strategy {
        case .scrollSwipe:
            let focusedFrame = snapshotFinder.liveFocusedTextInput()?.frame
            guard let start = planner.scrollSwipeStart(focusedFrame: focusedFrame) else {
                return .notPossible("the field is not in a scroll view with room clear of its controls above the keyboard")
            }
            let dy = CGFloat(screen.height) * KeyboardDismissPlanner.swipeFraction
            let dx = CGFloat(screen.width) * KeyboardDismissPlanner.swipeFraction
            guard EventSynthesizer.swipe(
                from: start, to: CGPoint(x: start.x, y: start.y - dy), duration: 0.05
            ) else { return .notPossible("the drag could not be synthesized") }
            // Gone already: the caller's wait after this return sees that at once.
            if waitForKeyboardDismissed(timeout: Self.dragWait) { return .keyboardStayed }
            // A horizontal scroll view drags sideways — planned again, since the
            // first drag may have scrolled a control under the old point.
            guard let snapshot = try? snapshotFinder.takeSnapshot(),
                  hasKeyboardInSnapshot(snapshot.dictionaryRepresentation),
                  let again = KeyboardDismissPlanner(snapshot: snapshot, screenSize: screen)
                      .scrollSwipeStart(focusedFrame: snapshotFinder.liveFocusedTextInput()?.frame)
            else { return .keyboardStayed }
            _ = EventSynthesizer.swipe(
                from: again, to: CGPoint(x: again.x - dx, y: again.y), duration: 0.05
            )
            _ = waitForKeyboardDismissed(timeout: Self.dragWait)
            return .keyboardStayed
        case .dismissKey:
            guard let key = planner.dismissKey() else { return .notPossible("this keyboard has none") }
            guard EventSynthesizer.tap(at: key) else { return .notPossible("the tap could not be synthesized") }
            return .keyboardStayed
        case .blankTap:
            guard let field = snapshotFinder.liveFocusedTextInput() else {
                return .notPossible("no focused text field to tap beside")
            }
            guard let point = planner.blankPoint(focusedFrame: field.frame) else {
                return .notPossible("no blank spot beside the field above the keyboard")
            }
            guard EventSynthesizer.tap(at: point) else { return .notPossible("the tap could not be synthesized") }
            return .keyboardStayed
        case .returnKey:
            switch planner.returnKey(focusedInput: snapshotFinder.liveFocusedTextInput()?.elementType) {
            case .notPossible(let why):
                return .notPossible(why)
            case .press:
                // Typed rather than tapped: a key tap aimed at a keyboard that
                // starts leaving would land on the app behind it.
                guard actionExecutor.typeTextWithoutFocus("\n") else {
                    return .notPossible("the key press could not be synthesized")
                }
                return .keyboardStayed
            }
        }
    }

    /// Poll the snapshot tree until the keyboard disappears or the deadline
    /// passes. Returns true once the keyboard is gone.
    /// Always checks at least once, so a zero timeout is a single check.
    private func waitForKeyboardDismissed(timeout: TimeInterval) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while true {
            if keyboardGoneNow() == true { return true }
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: 0.15)
        }
    }

    /// Whether one snapshot shows no keyboard on screen (none in the tree, or
    /// one left with no on-screen area — the same test the dismiss loop
    /// starts each strategy with): nil when the tree could not be read or
    /// came back empty (mid-transition, a slow runner), which is no evidence
    /// the keyboard left.
    private func keyboardGoneNow() -> Bool? {
        keyboardPresence().map { $0 != .onScreen }
    }

    private enum KeyboardPresence { case absent, offScreen, onScreen }

    /// What one snapshot shows of the keyboard: none in the tree, an element
    /// with no on-screen area, or a keyboard on screen. nil when the tree
    /// could not be read or came back empty.
    private func keyboardPresence() -> KeyboardPresence? {
        guard let snapshot = try? app.snapshot(),
              !snapshot.dictionaryRepresentation.isEmpty else { return nil }
        guard hasKeyboardInSnapshot(snapshot.dictionaryRepresentation) else { return .absent }
        let planner = KeyboardDismissPlanner(snapshot: snapshot, screenSize: snapshotFinder.screenSize)
        return planner.keyboardRegion == nil ? .offScreen : .onScreen
    }

    /// Check if a keyboard is visible in the snapshot tree by looking for
    /// the Keyboard element type (elementType 56 = XCUIElement.ElementType.keyboard).
    private func hasKeyboardInSnapshot(_ dict: [XCUIElement.AttributeName: Any]) -> Bool {
        if let typeRaw = dict[XCUIElement.AttributeName(rawValue: "elementType")] as? UInt,
           typeRaw == XCUIElement.ElementType.keyboard.rawValue {
            return true
        }
        if let children = dict[XCUIElement.AttributeName(rawValue: "children")] as? [[XCUIElement.AttributeName: Any]] {
            for child in children {
                if hasKeyboardInSnapshot(child) { return true }
            }
        }
        return false
    }
}
