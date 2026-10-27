import XCTest

/// Entry point for the Tapsmith iOS on-device agent.
///
/// This is an XCTestCase subclass that starts a TCP socket server and blocks
/// indefinitely, keeping the XCTest runner alive. The socket server accepts
/// JSON-RPC commands from the host daemon and dispatches them to XCUITest.
///
/// Launched via: xcodebuild test-without-building -xctestrun <path> -destination 'id=<udid>'
///
/// Mirrors the Android agent's TapsmithAgent.kt.
class TapsmithAgentRunner: XCTestCase {

    private static let defaultPort: UInt16 = 18700
    private static let envTargetBundleId = "TAPSMITH_TARGET_BUNDLE_ID"
    private static let envPort = "TAPSMITH_AGENT_PORT"
    private static let envAttachToRunningApp = "TAPSMITH_ATTACH_TO_RUNNING_APP"
    #if os(macOS)
    /// Absolute path to the target `.app` bundle (macOS only).
    private static let envTargetAppPath = "TAPSMITH_TARGET_APP_PATH"
    #endif

    private var socketServer: SocketServer?

    /// The main test method that starts the agent.
    /// This method intentionally never returns — it blocks to keep the XCTest
    /// runner alive so the socket server can continuously accept commands.
    func testRunAgent() {
        let bundleId = ProcessInfo.processInfo.environment[Self.envTargetBundleId] ?? ""
        let port = UInt16(ProcessInfo.processInfo.environment[Self.envPort] ?? "") ?? Self.defaultPort
        let attachToRunningApp = ProcessInfo.processInfo.environment[Self.envAttachToRunningApp] == "1"

        NSLog("[TapsmithAgent] Starting with target bundle: \(bundleId), port: \(port)")

        // Create the XCUIApplication for the target app
        let app: XCUIApplication
        #if os(macOS)
        // On macOS, XCUIApplication(bundleIdentifier:) only finds apps in indexed
        // locations (/Applications, ~/Applications). A build output anywhere else
        // fails with "The app representing <id> could not be found", so launch
        // by file path when the daemon provides one.
        let appPath = ProcessInfo.processInfo.environment[Self.envTargetAppPath] ?? ""
        if !appPath.isEmpty {
            app = XCUIApplication(url: URL(fileURLWithPath: appPath))
        } else if bundleId.isEmpty {
            app = XCUIApplication()
        } else {
            app = XCUIApplication(bundleIdentifier: bundleId)
        }
        #else
        if bundleId.isEmpty {
            app = XCUIApplication()
        } else {
            app = XCUIApplication(bundleIdentifier: bundleId)
        }
        #endif

        // Disable XCUITest's quiescence waiting — this is the single biggest
        // performance win. Without this, every action (tap, type, swipe) blocks
        // for 30+ seconds because XCUITest waits for the app to become "idle".
        // React Native apps are never idle (JS bridge timers always running).
        //
        // Step 0: Verify swizzle targets exist before attempting to disable.
        // Logs warnings if Xcode changed the private APIs we depend on.
        let _ = QuiescenceDisabler.verifySwizzleTargetsExist()
        // Step 1: Runtime swizzle BEFORE activate() — affects the class itself.
        QuiescenceDisabler.disableViaRuntime()
        // Step 2: Nuclear option — swizzle ALL quiescence methods on EVERY
        // XCTest class that might check quiescence. Different code paths
        // (XCUICoordinate.tap vs XCUIElement.tap vs app.activate) call
        // quiescence checks on different classes.
        let classNames = [
            "XCUIApplicationProcess",
            "XCUIApplicationImpl",
            "XCUICoordinate",
            "XCUIElement",
            "XCUIElementQuery",
            "XCUIApplication",
        ]
        for className in classNames {
            if let cls = NSClassFromString(className) {
                QuiescenceDisabler.disableAllQuiescenceMethods(on: cls)
            }
        }
        // Auto-dismiss permission prompts that would otherwise block XCUITest
        // interactions.
        // NOTE: deliberately does not handle the deep-link "Open in <app>?"
        // confirmation. The daemon taps it through acceptOpenInAppDialog while
        // simctl openurl is pending, before XCUITest interactions can race it.
        addUIInterruptionMonitor(withDescription: "System Alert") { alert in
            for title in SystemDialogPolicy.allowButtonLabels {
                let button = alert.buttons[title]
                if button.exists {
                    button.tap()
                    return true
                }
            }
            // Dialogs with no allow-style button — iCloud Keychain's "Save
            // Password?" — are dismissed, per SystemDialogPolicy. Checked
            // only after every allow label has missed, so a permission
            // prompt is never dismissed instead of accepted.
            for title in SystemDialogPolicy.dismissButtonLabels {
                let button = alert.buttons[title]
                if button.exists {
                    button.tap()
                    return true
                }
            }
            return false
        }

        if attachToRunningApp {
            // When the daemon has already relaunched the app via simctl, attach
            // without triggering another runner-mediated launch. This avoids
            // Xcode 26 restoring stale navigation state during restartApp().
            app.activate()
        } else {
            // launch() implicitly terminates a running instance first, and on
            // a busy SpringBoard that terminate+relaunch handshake is the
            // classic "Timed out attempting to launch app" trigger. Terminate
            // explicitly so launch() always starts from a clean slate; a
            // not-running app makes this a fast no-op.
            app.terminate()
            app.launch()
        }
        if LaunchAccessibilityCheck.shouldCheck(attachToRunningApp: attachToRunningApp, bundleId: bundleId) {
            ensureAccessibilityReachable(app, bundleId: bundleId)
        }
        // Step 3: Property-based disable on this instance AFTER launch().
        QuiescenceDisabler.disable(for: app)
        NSLog("[TapsmithAgent] Quiescence disabled")

        // Initialize all components
        let elementFinder = ElementFinder(app: app)
        let snapshotFinder = SnapshotElementFinder(app: app)
        let actionExecutor = ActionExecutor(app: app)
        let waitEngine = WaitEngine(app: app)
        let hierarchyDumper = HierarchyDumper(app: app, bundleId: bundleId)
        let commandHandler = CommandHandler(
            app: app,
            elementFinder: elementFinder,
            snapshotFinder: snapshotFinder,
            actionExecutor: actionExecutor,
            waitEngine: waitEngine,
            hierarchyDumper: hierarchyDumper
        )

        socketServer = SocketServer(port: port, commandHandler: commandHandler)

        NSLog("[TapsmithAgent] Agent started on port \(port)")

        // Block forever — the socket server runs on its own dispatch queue
        // and this test method must not return to keep the XCTest runner alive.
        socketServer?.start()
    }

    /// Before reporting ready, make sure the app just launched can be seen
    /// through accessibility, relaunching it if not (PILOT-462; see
    /// LaunchAccessibilityCheck). A healthy app costs one snapshot (~50 ms);
    /// an unreachable one ~8 s of XCTest retries plus a relaunch, instead of
    /// failing the first command after ~16 s.
    private func ensureAccessibilityReachable(_ app: XCUIApplication, bundleId: String) {
        var attempt = 0
        let outcome = LaunchAccessibilityCheck.run(
            probe: {
                attempt += 1
                let started = Date()
                var probeError: Error?
                // snapshot() reports through a Swift error; anything XCTest
                // raises as an NSException instead is caught too.
                let objcError = ObjCExceptionCatcher.catchException {
                    do {
                        _ = try app.snapshot()
                    } catch {
                        probeError = error
                    }
                }
                let description = probeError.map { "\($0)" } ?? objcError?.localizedDescription
                let elapsed = String(format: "%.2f", Date().timeIntervalSince(started))
                NSLog("[TapsmithAgent] Accessibility probe \(attempt) (\(elapsed)s): \(description ?? "ok")")
                return description
            },
            relaunch: {
                NSLog("[TapsmithAgent] \(bundleId) has no accessibility server after launch; relaunching it")
                app.terminate()
                app.launch()
            })
        switch outcome {
        case .reachable, .otherError:
            break
        case .unreachable:
            NSLog("[TapsmithAgent] \(bundleId) is still not reachable through accessibility after "
                + "\(LaunchAccessibilityCheck.maxRelaunches) relaunches; continuing startup")
        }
    }

    override func tearDown() {
        NSLog("[TapsmithAgent] Shutting down")
        socketServer?.stop()
        super.tearDown()
    }
}
