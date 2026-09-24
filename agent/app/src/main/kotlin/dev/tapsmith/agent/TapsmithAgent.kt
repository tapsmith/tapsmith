package dev.tapsmith.agent

import android.app.Instrumentation
import android.os.Bundle
import android.util.Log
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import kotlinx.coroutines.runBlocking

/**
 * Entry point for the Tapsmith on-device agent.
 *
 * Launched via `adb shell am instrument -w dev.tapsmith.agent/.TapsmithAgent`.
 * Initializes UIAutomator's UiDevice and starts the TCP socket server
 * that accepts commands from the host daemon.
 */
class TapsmithAgent : Instrumentation() {
    companion object {
        private const val TAG = "TapsmithAgent"
        private const val DEFAULT_PORT = 18700
        private const val ARG_PORT = "port"

        @Volatile
        lateinit var device: UiDevice
            private set
    }

    private var socketServer: SocketServer? = null

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        Log.i(TAG, "TapsmithAgent starting")

        // Initialize UiDevice — must pass the Instrumentation instance
        device = UiDevice.getInstance(this)

        // Disable UIAutomator's implicit "wait for idle" entirely.
        //
        // Every UiDevice.findObjects() call and UiObject2 property read
        // (getText, getVisibleBounds, isEnabled, …) implicitly blocks on
        // UiDevice.waitForIdle() up to this timeout before returning. On
        // perpetually-animated screens (React Native Reanimated loops,
        // indeterminate progress spinners) the accessibility-event stream
        // never quiets, so each of those implicit waits burns its full
        // budget — and they accumulate across every candidate and attribute
        // in a single findElements, easily exceeding the daemon's
        // per-command deadline ("Agent command timed out after 5.5s") even
        // though the target element is fully visible.
        //
        // Element queries must therefore snapshot the current tree and match
        // immediately, never gating on global idle. Setting this to 0 makes
        // findObjects/property reads return against the live tree at once.
        // Bounded idle-waiting is still available via the explicit
        // `waitForIdle` command, which passes its own timeout to
        // UiDevice.waitForIdle(timeout) and is unaffected by this default.
        // Positional stability / settling is handled in WaitEngine and the
        // SDK's poll loop, not by this implicit gate.
        Configurator.getInstance().apply {
            waitForIdleTimeout = 0L
            waitForSelectorTimeout = 500L
        }

        val port = arguments?.getString(ARG_PORT)?.toIntOrNull() ?: DEFAULT_PORT

        val elementFinder = ElementFinder(device)
        val occlusionGuard = OcclusionGuard(device, this, elementFinder::nodeInfoFor)
        val actionExecutor = ActionExecutor(device, this, occlusionGuard)
        val waitEngine = WaitEngine(device)
        val hierarchyDumper = HierarchyDumper(device, this)
        val commandHandler =
            CommandHandler(
                context = targetContext,
                device = device,
                elementFinder = elementFinder,
                actionExecutor = actionExecutor,
                waitEngine = waitEngine,
                hierarchyDumper = hierarchyDumper,
            )

        socketServer = SocketServer(port, commandHandler)

        Log.i(TAG, "TapsmithAgent started on port $port")

        // Keep instrumentation alive — do not call finish().
        start()
    }

    override fun onStart() {
        super.onStart()
        // Run the socket server on this thread (the instrumentation thread).
        // UIAutomator2 requires calls from a thread with proper context,
        // and the instrumentation thread provides that.
        runBlocking {
            socketServer?.start()
        }
    }

    override fun onDestroy() {
        Log.i(TAG, "TapsmithAgent shutting down")
        socketServer?.stop()
        super.onDestroy()
    }
}
