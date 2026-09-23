package dev.tapsmith.agent

import android.app.Instrumentation
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until

/**
 * Executes UI actions: tap, long press, text input, swipe, scroll, and key presses.
 */
class ActionExecutor(
    private val device: UiDevice,
    private val instrumentation: Instrumentation,
    private val occlusionGuard: OcclusionGuard,
) {
    /** Tracks ASCII control-char code points we've already warned about,
     *  so the log fires once per code point per agent lifetime. */
    private val warnedDroppedControlChars = java.util.concurrent.ConcurrentHashMap.newKeySet<Int>()

    private fun warnDroppedControlChar(code: Int) {
        if (warnedDroppedControlChars.add(code)) {
            android.util.Log.w(
                "ActionExecutor",
                "typeTextWithoutFocus dropping ASCII control char 0x${code.toString(16)} — " +
                    "`input text` would garble it. Only \\n, \\t, \\b are routed as key events.",
            )
        }
    }

    companion object {
        private const val TAG = "TapsmithAction"

        /** Interval between taps for double-tap gesture. */
        private const val DOUBLE_TAP_INTERVAL_MS = 100L

        /** Max time to wait for an element's bounds to stop moving before a tap. */
        private const val STABLE_BOUNDS_TIMEOUT_MS = 1000L

        /** Delay between consecutive bounds reads in the stability check. */
        private const val STABLE_BOUNDS_POLL_MS = 50L

        /** Timeout for waiting for dropdown options to appear. */
        private const val DROPDOWN_WAIT_TIMEOUT_MS = 3000L

        /** Fallback timeout for scrollable container detection. */
        private const val SCROLLABLE_FALLBACK_TIMEOUT_MS = 1000L

        /** Minimum pixel margin for tapping outside an element during blur. */
        private const val BLUR_TAP_MARGIN_PX = 50

        /** Time to wait for idle after focus/blur actions. */
        private const val FOCUS_IDLE_TIMEOUT_MS = 500L
    }

    /**
     * Tap on an element, at the center of the part of it nothing covers.
     *
     * Waits for the element's bounds to stop moving first (Playwright-style
     * actionability): a click computed from mid-animation/mid-layout bounds
     * can land on a non-interactive pixel and silently miss. When the caller
     * passes [resolvedBounds] from a resolve that just completed (WaitEngine
     * has already settle-checked them), the stability wait is skipped —
     * repeating the check would only stack more blocking accessibility
     * round-trips (PILOT-278).
     *
     * A tap lands on whatever is on top, so [OcclusionGuard] picks the point:
     * the visible part of an element the keyboard half covers, and never an
     * element under an overlay — that waits out the cover within [budget],
     * then fails with ELEMENT_COVERED (PILOT-362).
     *
     * The tap itself is injected at coordinates rather than via
     * UiObject2.click(), which would re-fetch the accessibility node — one
     * more round-trip blocking on the app's main looper.
     */
    fun tap(
        element: UiObject2,
        resolvedBounds: Rect?,
        budget: ActionBudget,
        expected: TargetIdentity?,
    ) {
        try {
            val trusted = resolvedBounds?.takeIf { !it.isEmpty }
            val stableStart = SystemClock.uptimeMillis()
            val bounds = trusted ?: waitForStableBounds(element)
            val stableMs = SystemClock.uptimeMillis() - stableStart
            val planStart = SystemClock.uptimeMillis()
            val plan =
                if (bounds.isEmpty) OcclusionGuard.Plan.OffScreen else occlusionGuard.plan(element, bounds, budget, expected)
            val planMs = SystemClock.uptimeMillis() - planStart
            val injectStart = SystemClock.uptimeMillis()
            when (plan) {
                is OcclusionGuard.Plan.Point ->
                    if (!device.click(plan.x, plan.y)) {
                        throw ActionFailedException("Failed to tap element at (${plan.x}, ${plan.y})")
                    }
                // Empty bounds (zero-size or fully clipped element) — fall back
                // to the node click, which targets the element's live center
                // and throws if the element is gone (the pre-PILOT-278
                // behavior).
                OcclusionGuard.Plan.OffScreen -> element.click()
            }
            Log.d(
                TAG,
                "tap phases: stableBounds=${stableMs}ms (resolvedBoundsReused=${trusted != null}) " +
                    "occlusion=${planMs}ms inject=${SystemClock.uptimeMillis() - injectStart}ms",
            )
        } catch (e: StaleObjectException) {
            // Bubble up: CommandHandler maps this to ELEMENT_NOT_FOUND so the
            // SDK re-resolves, rather than failing hard on ACTION_FAILED.
            throw e
        } catch (e: ActionFailedException) {
            throw e
        } catch (e: TouchRefusedException) {
            throw e
        } catch (e: Exception) {
            throw ActionFailedException("Failed to tap element: ${e.message}")
        }
    }

    /**
     * Wait until two consecutive reads of the element's visible bounds agree,
     * or the deadline passes, and return the freshest read. visibleBounds
     * refreshes the underlying accessibility node, so consecutive equal reads
     * mean layout has settled.
     *
     * Each read blocks on the app's main looper (with a multi-second framework
     * ceiling), so the loop is cost-aware: a single read that exceeds the
     * whole stability budget means the app is too busy to poll further, and we
     * bail with the freshest bounds instead of stacking more blocking calls
     * (PILOT-278).
     */
    private fun waitForStableBounds(
        element: UiObject2,
        timeoutMs: Long = STABLE_BOUNDS_TIMEOUT_MS,
    ): Rect {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var prev = element.visibleBounds
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(STABLE_BOUNDS_POLL_MS)
            val readStart = SystemClock.uptimeMillis()
            val current = element.visibleBounds
            val readMs = SystemClock.uptimeMillis() - readStart
            if (current == prev) return current
            prev = current
            if (readMs >= timeoutMs) {
                Log.w(
                    TAG,
                    "waitForStableBounds: single bounds read took ${readMs}ms (budget ${timeoutMs}ms) — " +
                        "app main thread is busy; proceeding with the freshest read",
                )
                break
            }
        }
        // Bounds still moving at the deadline — proceed with the freshest read
        // rather than failing.
        return prev
    }

    /**
     * Tap at specific screen coordinates.
     */
    fun tapCoordinates(
        x: Int,
        y: Int,
    ) {
        if (!device.click(x, y)) {
            throw ActionFailedException("Failed to tap at ($x, $y)")
        }
    }

    /**
     * Long press on an element with configurable duration, at a point nothing
     * covers (see [tap]; PILOT-362).
     *
     * [resolvedBounds] from a just-completed resolve skips the node re-read
     * (a blocking accessibility round-trip; PILOT-278).
     */
    fun longPress(
        element: UiObject2,
        durationMs: Long,
        resolvedBounds: Rect?,
        budget: ActionBudget,
        expected: TargetIdentity?,
    ) {
        try {
            val bounds = resolvedBounds?.takeIf { !it.isEmpty } ?: element.visibleBounds
            val point = planGesturePoint(element, bounds, budget, expected, "long press", reserveMs = durationMs)
            device.swipe(point.x, point.y, point.x, point.y, (durationMs / 5).toInt().coerceAtLeast(1))
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: ActionFailedException) {
            throw e
        } catch (e: TouchRefusedException) {
            throw e
        } catch (e: Exception) {
            throw ActionFailedException("Failed to long press element: ${e.message}")
        }
    }

    /**
     * The uncovered point a coordinate-computed gesture (long press, double
     * tap) must use. Those have no node-level fallback, so an element with no
     * on-screen part fails loudly rather than being pressed at (0, 0).
     */
    private fun planGesturePoint(
        element: UiObject2,
        bounds: Rect,
        budget: ActionBudget,
        expected: TargetIdentity?,
        gesture: String,
        reserveMs: Long = 0,
    ): OcclusionGuard.Plan.Point {
        val plan =
            if (bounds.isEmpty) {
                OcclusionGuard.Plan.OffScreen
            } else {
                occlusionGuard.plan(element, bounds, budget, expected, reserveMs)
            }
        return plan as? OcclusionGuard.Plan.Point
            ?: throw ActionFailedException(
                "Cannot $gesture: element has empty visible bounds (zero-size, fully clipped, or off screen)",
            )
    }

    /**
     * Long press at specific coordinates.
     */
    fun longPressCoordinates(
        x: Int,
        y: Int,
        durationMs: Long = 1000L,
    ) {
        // swipe from point to same point with steps proportional to duration
        device.swipe(x, y, x, y, (durationMs / 5).toInt().coerceAtLeast(1))
    }

    /**
     * Type text into a focused element.
     * First clicks the element to ensure focus, then types the text.
     *
     * [resolvedBounds] from a just-completed resolve lets the focus click be
     * injected at coordinates instead of via UiObject2.click(), skipping a
     * node re-fetch (a blocking accessibility round-trip; PILOT-278).
     */
    fun typeText(
        element: UiObject2,
        text: String,
        resolvedBounds: Rect?,
        budget: ActionBudget,
        expected: TargetIdentity?,
    ) {
        try {
            clickToFocus(element, resolvedBounds, budget, expected)
            element.text = text
            // UiObject2.setText silently logs-and-returns when the framework
            // rejects ACTION_SET_TEXT (e.g. the field is still gaining focus
            // on a loaded emulator) — verify the value landed and re-set once.
            // The read-back can legitimately differ from the input (password
            // masking, input formatters), so the retry is bounded to one
            // idempotent re-set and a persistent mismatch only logs.
            if (element.text != text) {
                device.waitForIdle(500)
                element.text = text
                if (element.text != text) {
                    Log.w(
                        TAG,
                        "typeText verify: field text differs from requested value after " +
                            "re-set (masking/formatter, or ACTION_SET_TEXT rejected twice)",
                    )
                }
            }
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: Exception) {
            // A focusing tap that cannot land (PILOT-362) is final: retrying it
            // through the fallback would only hit the cover.
            rethrowTouchRefusal(e)
            // Fallback: try clicking and using device-level text injection.
            // The refocus is one check, no waiting — the first tap may have
            // moved the field (a keyboard-avoiding view lifting it).
            try {
                clickToFocus(element, null, budget.noWait(), expected)
                device.waitForIdle(1000)
                // Key events route through the IME; injecting while the input
                // session is still restarting after the focus click silently
                // drops the first commits under load. Wait for focus first.
                waitForFocus(element)
                typeTextWithoutFocus(text)
            } catch (e2: StaleObjectException) {
                throw e2
            } catch (e2: Exception) {
                rethrowTouchRefusal(e2)
                throw ActionFailedException(
                    "Failed to type text: ${e.message} (fallback also failed: ${e2.message})",
                )
            }
        }
    }

    /**
     * Wait briefly for the element to hold input focus before key-event
     * injection. A stale element rethrows — blind key events after the
     * target went stale can land in whatever field IS focused, and the
     * SDK's stale-retry re-resolves and re-types correctly instead. Other
     * (transient) read failures keep polling until the deadline; a field
     * that never reports focus falls through so the injection still gets
     * its chance.
     */
    private fun waitForFocus(element: UiObject2) {
        val deadline = SystemClock.uptimeMillis() + 2000
        while (SystemClock.uptimeMillis() < deadline) {
            try {
                if (element.isFocused) return
            } catch (e: StaleObjectException) {
                throw e
            } catch (e: Exception) {
                // Transient read failure (mid-layout, window transition) —
                // keep waiting.
            }
            SystemClock.sleep(100)
        }
    }

    /**
     * Tap an element to focus it, at a point nothing covers (PILOT-362),
     * reusing resolve-time bounds when available. A covered field that
     * already has input focus — typically one behind the keyboard it raised —
     * is not tapped at all: input reaches it anyway, and the tap would land
     * on a key.
     */
    private fun clickToFocus(
        element: UiObject2,
        resolvedBounds: Rect?,
        budget: ActionBudget,
        expected: TargetIdentity?,
    ) {
        val bounds = resolvedBounds?.takeIf { !it.isEmpty } ?: element.visibleBounds
        val plan =
            if (bounds.isEmpty) {
                OcclusionGuard.Plan.OffScreen
            } else {
                occlusionGuard.planFocusTap(element, bounds, budget, expected)
            }
        when (plan) {
            null -> Log.d(TAG, "focusing tap skipped: the field is covered but already focused")
            is OcclusionGuard.Plan.Point ->
                if (!device.click(plan.x, plan.y)) {
                    throw ActionFailedException("Failed to tap element at (${plan.x}, ${plan.y}) to focus it")
                }
            // Nothing of it on screen: the node click targets its live center
            // and throws if the element is gone, so a focus failure is never
            // silent.
            OcclusionGuard.Plan.OffScreen -> element.click()
        }
    }

    /**
     * Rethrow a touch that was refused rather than attempted (covered, changed
     * into another element, too late) so a fallback path does not retry it —
     * or bury its error type in a generic ACTION_FAILED.
     */
    private fun rethrowTouchRefusal(e: Exception) {
        if (e is TouchRefusedException) throw e
    }

    /**
     * Type text without targeting a specific element.
     *
     * Uses `input text` for printable runs and `input keyevent` for control
     * characters (`\n`, `\t`, `\b`, `\r`) so those reach the focused field
     * instead of being silently dropped by the shell-tokenizer.
     *
     * IMPORTANT: do NOT add literal quotes around the text.
     * `UiDevice.executeShellCommand` does NOT route through a shell. The
     * call chain is:
     *   UiDevice.executeShellCommand
     *     → UiAutomation.executeShellCommand
     *     → UiAutomationConnection.executeShellCommand
     *     → Runtime.getRuntime().exec(command)
     * and `Runtime.exec(String)` tokenizes on whitespace via StringTokenizer
     * before calling `execve()` — it never invokes `/bin/sh`. Shell
     * metacharacters (`&`, `;`, `|`, `$`, `` ` ``, `(`, `)`, `\`) therefore
     * survive verbatim and any quote characters we add ourselves become
     * literal input (the original PILOT-133 bug). Spaces inside a printable
     * run are converted to `%s`, which `input text` interprets as a literal
     * space. The locator-regressions.test.ts metachar test locks this in.
     *
     * KNOWN LIMITATION: a literal `%s` substring in `text` is indistinguishable
     * from an encoded space and will type a space instead. Real-world test
     * data rarely includes `%s`, but if you need to type that exact pair,
     * use `pressKey()` or break the input up.
     */
    fun typeTextWithoutFocus(text: String) {
        if (text.isEmpty()) return
        val buffer = StringBuilder()
        // Batch consecutive control chars into a single
        // `input keyevent KEYCODE_X KEYCODE_X ...` call. Each shell
        // invocation spawns a process, so a long backspace string
        // (clearText sends one per character of current value) was
        // previously O(N) process spawns.
        val pendingKeys = mutableListOf<String>()

        fun flushPendingKeys() {
            if (pendingKeys.isEmpty()) return
            device.executeShellCommand("input keyevent ${pendingKeys.joinToString(" ")}")
            pendingKeys.clear()
        }
        for (ch in text) {
            val keyCode =
                when (ch) {
                    '\n' -> "KEYCODE_ENTER"
                    '\t' -> "KEYCODE_TAB"
                    '\b' -> "KEYCODE_DEL" // '\b' is U+0008 (backspace)
                    '\r' -> {
                        warnDroppedControlChar(0x0D)
                        continue
                    }
                    else -> ""
                }
            if (keyCode.isNotEmpty()) {
                if (buffer.isNotEmpty()) {
                    flushPrintableRun(buffer)
                }
                pendingKeys.add(keyCode)
            } else if (ch.code < 0x20) {
                // Drop other ASCII control codes (NUL, BEL, vertical tab, etc.).
                // `input text` would garble them; routing each to a key event
                // is not generally meaningful. Specific cases (\n, \t, \b)
                // are handled above. Log the first occurrence so silent
                // drops surface if a real-world input starts relying on
                // one of these bytes.
                warnDroppedControlChar(ch.code)
                continue
            } else {
                if (pendingKeys.isNotEmpty()) flushPendingKeys()
                buffer.append(ch)
            }
        }
        flushPendingKeys()
        if (buffer.isNotEmpty()) {
            flushPrintableRun(buffer)
        }
    }

    private fun flushPrintableRun(buffer: StringBuilder) {
        if (buffer.isEmpty()) return
        val tokenized = buffer.toString().replace(" ", "%s")
        device.executeShellCommand("input text $tokenized")
        buffer.setLength(0)
    }

    /**
     * Clear text in an element by selecting all and deleting.
     */
    fun clearText(
        element: UiObject2,
        budget: ActionBudget,
        expected: TargetIdentity?,
    ) {
        try {
            clickToFocus(element, null, budget, expected)
            device.waitForIdle(500)
            // Select all (Ctrl+A) then delete
            element.clear()
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: Exception) {
            rethrowTouchRefusal(e)
            // Fallback: triple-click to select all, then press delete
            try {
                clickToFocus(element, null, budget.noWait(), expected)
                device.waitForIdle(200)
                // Use shell to select all and delete
                device.executeShellCommand("input keyevent KEYCODE_MOVE_HOME")
                device.executeShellCommand("input keyevent --longpress KEYCODE_SHIFT_LEFT KEYCODE_MOVE_END")
                device.executeShellCommand("input keyevent KEYCODE_DEL")
            } catch (e2: StaleObjectException) {
                throw e2
            } catch (e2: Exception) {
                rethrowTouchRefusal(e2)
                throw ActionFailedException(
                    "Failed to clear text: ${e.message} (fallback also failed: ${e2.message})",
                )
            }
        }
    }

    /**
     * Swipe on an element in a given direction.
     *
     * @param element The element to swipe on
     * @param direction One of "up", "down", "left", "right"
     * @param speed Swipe speed in pixels per second
     * @param distance Fraction of the element's dimension to swipe (0.0 to 1.0)
     */
    fun swipe(
        element: UiObject2,
        direction: String,
        speed: Int = 5000,
        distance: Double = 0.5,
    ) {
        val dir = parseDirection(direction)
        try {
            element.swipe(dir, distance.toFloat(), speed)
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: Exception) {
            throw ActionFailedException("Failed to swipe $direction on element: ${e.message}")
        }
    }

    /**
     * Swipe on the full screen in a given direction.
     */
    fun swipeScreen(
        direction: String,
        speed: Int = 5000,
        distance: Double = 0.5,
    ) {
        val w = device.displayWidth
        val h = device.displayHeight
        val cx = w / 2
        val cy = h / 2
        val swipeLength: Int

        val steps = (speed / 100).coerceIn(5, 100)

        when (direction.lowercase()) {
            "up" -> {
                swipeLength = (h * distance).toInt()
                device.swipe(cx, cy + swipeLength / 2, cx, cy - swipeLength / 2, steps)
            }
            "down" -> {
                swipeLength = (h * distance).toInt()
                device.swipe(cx, cy - swipeLength / 2, cx, cy + swipeLength / 2, steps)
            }
            "left" -> {
                swipeLength = (w * distance).toInt()
                device.swipe(cx + swipeLength / 2, cy, cx - swipeLength / 2, cy, steps)
            }
            "right" -> {
                swipeLength = (w * distance).toInt()
                device.swipe(cx - swipeLength / 2, cy, cx + swipeLength / 2, cy, steps)
            }
            else -> throw ActionFailedException("Unknown swipe direction: $direction. Use up/down/left/right.")
        }
    }

    /**
     * Swipe between two raw screen coordinates (pixels). Used by the
     * interactive mirror and the SDK coordinate API.
     */
    fun swipeCoordinates(
        x1: Int,
        y1: Int,
        x2: Int,
        y2: Int,
        durationMs: Long = 300,
    ) {
        // UIAutomator swipe is step-based (~5ms/step). Convert duration to steps.
        val steps = (durationMs / 5).coerceIn(5L, 200L).toInt()
        device.swipe(x1, y1, x2, y2, steps)
    }

    // ─── Streamed touch (interactive mirror live-drag) ───
    // @Volatile: touch events arrive on gRPC pool threads; ensure writes are
    // visible across threads.
    @Volatile
    private var touchDownTime = 0L

    @Volatile
    private var touchActive = false

    private fun injectTouch(
        action: Int,
        x: Int,
        y: Int,
        eventTime: Long,
    ) {
        val event = MotionEvent.obtain(touchDownTime, eventTime, action, x.toFloat(), y.toFloat(), 0)
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        try {
            // sync=false: fire-and-forget keeps the move stream low-latency.
            // Use the agent's own Instrumentation (this process is a custom
            // Instrumentation, not registered with InstrumentationRegistry).
            instrumentation.uiAutomation.injectInputEvent(event, false)
        } finally {
            event.recycle()
        }
    }

    fun touchDown(
        x: Int,
        y: Int,
    ) {
        touchDownTime = SystemClock.uptimeMillis()
        touchActive = true
        injectTouch(MotionEvent.ACTION_DOWN, x, y, touchDownTime)
    }

    fun touchMove(
        x: Int,
        y: Int,
    ) {
        if (!touchActive) return
        injectTouch(MotionEvent.ACTION_MOVE, x, y, SystemClock.uptimeMillis())
    }

    fun touchUp(
        x: Int,
        y: Int,
    ) {
        if (!touchActive) return
        injectTouch(MotionEvent.ACTION_UP, x, y, SystemClock.uptimeMillis())
        touchActive = false
    }

    fun touchCancel() {
        if (!touchActive) return
        injectTouch(MotionEvent.ACTION_CANCEL, 0, 0, SystemClock.uptimeMillis())
        touchActive = false
    }

    /**
     * Scroll a container in a direction, optionally until a target element becomes visible.
     */
    fun scroll(
        element: UiObject2,
        direction: String,
        targetSelector: ElementSelector? = null,
    ) {
        val dir = parseDirection(direction)
        if (targetSelector != null) {
            scrollUntilVisible(element, dir, targetSelector)
        } else {
            try {
                element.scroll(dir, 1.0f)
            } catch (e: StaleObjectException) {
                throw e
            } catch (e: Exception) {
                throw ActionFailedException("Failed to scroll $direction: ${e.message}")
            }
        }
    }

    /**
     * Scroll the full screen.
     */
    fun scrollScreen(
        direction: String,
        targetSelector: ElementSelector? = null,
    ) {
        // For full-screen scrolling, use swipe gestures
        swipeScreen(
            // Invert direction: scrolling "down" means swiping "up"
            direction =
                when (direction.lowercase()) {
                    "down" -> "up"
                    "up" -> "down"
                    "left" -> "right"
                    "right" -> "left"
                    else -> direction
                },
            speed = 5000,
            distance = 0.6,
        )
    }

    /**
     * Scroll a container until a target element matching the selector becomes visible.
     */
    private fun scrollUntilVisible(
        container: UiObject2,
        direction: Direction,
        targetSelector: ElementSelector,
        maxScrolls: Int = 20,
    ) {
        for (i in 0 until maxScrolls) {
            // Check if target is already visible
            val targetBy =
                when {
                    targetSelector.text != null -> By.text(targetSelector.text)
                    targetSelector.textContains != null -> By.textContains(targetSelector.textContains)
                    targetSelector.contentDesc != null -> By.desc(targetSelector.contentDesc)
                    targetSelector.id != null -> By.res(targetSelector.id)
                    else -> throw InvalidSelectorException("scrollTo requires text, textContains, contentDesc, or id")
                }

            val found = container.findObject(targetBy)
            if (found != null) return

            val canScroll = container.scroll(direction, 0.8f)
            if (!canScroll) {
                throw ElementNotFoundException(
                    "Could not find target element after scrolling to the end. " +
                        "Selector: ${targetSelector.text ?: targetSelector.textContains
                            ?: targetSelector.contentDesc ?: targetSelector.id}",
                )
            }
            device.waitForIdle(500)
        }
        throw TimeoutException("Could not find target element after $maxScrolls scrolls")
    }

    /**
     * Send a key press event.
     */
    fun pressKey(key: String) {
        val keyCode = resolveKeyCode(key)
        if (!device.pressKeyCode(keyCode)) {
            throw ActionFailedException("Failed to press key: $key")
        }
    }

    private fun parseDirection(direction: String): Direction {
        return when (direction.lowercase()) {
            "up" -> Direction.UP
            "down" -> Direction.DOWN
            "left" -> Direction.LEFT
            "right" -> Direction.RIGHT
            else -> throw ActionFailedException("Unknown direction: $direction. Use up/down/left/right.")
        }
    }

    /**
     * Double-tap on an element, at a point nothing covers (see [tap];
     * PILOT-362).
     *
     * Injects the four motion events directly (down/up, pause, down/up) instead
     * of calling device.click() twice: click() blocks waiting for the device to
     * go idle after each tap, so under load the gap between the two taps can
     * exceed the app's double-tap window and register as two single taps.
     */
    fun doubleTap(
        element: UiObject2,
        intervalMs: Long,
        resolvedBounds: Rect?,
        budget: ActionBudget,
        expected: TargetIdentity?,
    ) {
        try {
            val bounds = resolvedBounds?.takeIf { !it.isEmpty } ?: element.visibleBounds
            val point = planGesturePoint(element, bounds, budget, expected, "double tap")
            doubleTapCoordinates(point.x, point.y, intervalMs)
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: ActionFailedException) {
            throw e
        } catch (e: TouchRefusedException) {
            throw e
        } catch (e: Exception) {
            throw ActionFailedException("Failed to double tap element: ${e.message}")
        }
    }

    /**
     * Double-tap at specific screen coordinates with tightly controlled timing.
     */
    fun doubleTapCoordinates(
        x: Int,
        y: Int,
        intervalMs: Long = DOUBLE_TAP_INTERVAL_MS,
    ) {
        val interval = if (intervalMs > 0) intervalMs else DOUBLE_TAP_INTERVAL_MS
        if (injectTap(x, y)) {
            SystemClock.sleep(interval)
            if (injectTap(x, y)) return
            // First tap already landed — complete the gesture with a UiDevice
            // click rather than leaving a lone single tap behind.
            if (device.click(x, y)) return
            throw ActionFailedException("Failed to double tap at ($x, $y)")
        }
        // Injection unavailable — fall back to UiDevice clicks (waits for idle
        // between taps, so timing is less precise).
        device.click(x, y)
        SystemClock.sleep(interval)
        if (!device.click(x, y)) {
            throw ActionFailedException("Failed to double tap at ($x, $y)")
        }
    }

    /** Inject a full tap (down + up) synchronously without waiting for idle. */
    private fun injectTap(
        x: Int,
        y: Int,
        tapDurationMs: Long = 50L,
    ): Boolean {
        val downTime = SystemClock.uptimeMillis()
        val down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x.toFloat(), y.toFloat(), 0)
        down.source = InputDevice.SOURCE_TOUCHSCREEN
        val downOk =
            try {
                instrumentation.uiAutomation.injectInputEvent(down, true)
            } finally {
                down.recycle()
            }
        if (!downOk) return false
        SystemClock.sleep(tapDurationMs)
        val up = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x.toFloat(), y.toFloat(), 0)
        up.source = InputDevice.SOURCE_TOUCHSCREEN
        val upOk =
            try {
                instrumentation.uiAutomation.injectInputEvent(up, true)
            } finally {
                up.recycle()
            }
        if (!upOk) {
            // Don't leave the pointer down — a dangling contact would turn the
            // caller's fallback click into a long-press/multi-touch gesture.
            val cancel = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_CANCEL, x.toFloat(), y.toFloat(), 0)
            cancel.source = InputDevice.SOURCE_TOUCHSCREEN
            try {
                instrumentation.uiAutomation.injectInputEvent(cancel, true)
            } finally {
                cancel.recycle()
            }
        }
        return upOk
    }

    /**
     * Drag from one element to another.
     */
    fun dragTo(
        source: UiObject2,
        target: UiObject2,
    ) {
        try {
            val tgtBounds = target.visibleBounds
            source.drag(android.graphics.Point(tgtBounds.centerX(), tgtBounds.centerY()))
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: Exception) {
            throw ActionFailedException("Failed to drag element: ${e.message}")
        }
    }

    /**
     * Select an option from a spinner/dropdown by text.
     */
    fun selectOption(
        element: UiObject2,
        optionText: String,
        budget: ActionBudget,
        expected: TargetIdentity?,
    ) {
        try {
            // Tap the spinner to open it
            tap(element, null, budget, expected)
            // Wait for the option to appear then tap it
            val option =
                device.wait(Until.findObject(By.text(optionText)), DROPDOWN_WAIT_TIMEOUT_MS)
                    ?: throw ElementNotFoundException("Option '$optionText' not found in dropdown")
            option.click()
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: ElementNotFoundException) {
            throw e
        } catch (e: TouchRefusedException) {
            throw e
        } catch (e: Exception) {
            throw ActionFailedException("Failed to select option '$optionText': ${e.message}")
        }
    }

    /**
     * Select an option from a spinner/dropdown by index.
     */
    fun selectOptionByIndex(
        element: UiObject2,
        index: Int,
        budget: ActionBudget,
        expected: TargetIdentity?,
    ) {
        try {
            // Tap the spinner to open it
            tap(element, null, budget, expected)
            // Wait for a common dropdown container to appear
            val popupSelector = By.clazz(java.util.regex.Pattern.compile(".*(ListView|RecyclerView|PopupWindow)$"))
            val popup =
                device.wait(Until.findObject(popupSelector), DROPDOWN_WAIT_TIMEOUT_MS)
                    ?: device.wait(Until.findObject(By.scrollable(true)), SCROLLABLE_FALLBACK_TIMEOUT_MS)
                    ?: throw ActionFailedException(
                        "Could not find dropdown popup. " +
                            "The spinner may use a custom popup that is not auto-detected.",
                    )
            val children = popup.children
            if (index < 0 || index >= children.size) {
                throw ActionFailedException("Index $index out of range (0..${children.size - 1})")
            }
            children[index].click()
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: ActionFailedException) {
            throw e
        } catch (e: TouchRefusedException) {
            throw e
        } catch (e: Exception) {
            throw ActionFailedException("Failed to select option at index $index: ${e.message}")
        }
    }

    /**
     * Pinch zoom on an element.
     * Scale > 1.0 zooms in (pinch out), scale < 1.0 zooms out (pinch in).
     */
    fun pinchZoom(
        element: UiObject2,
        scale: Float,
    ) {
        try {
            if (scale > 1.0f) {
                // Pinch out (zoom in) — percentage is how far apart fingers end
                val percent = ((scale - 1.0f) * 100).coerceIn(10f, 100f) / 100f
                element.pinchOpen(percent)
            } else {
                // Pinch in (zoom out) — percentage is how far fingers move inward
                val percent = ((1.0f - scale) * 100).coerceIn(10f, 100f) / 100f
                element.pinchClose(percent)
            }
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: Exception) {
            throw ActionFailedException("Failed to pinch zoom: ${e.message}")
        }
    }

    /**
     * Focus an element (click to focus, typically shows keyboard for text fields).
     */
    fun focus(
        element: UiObject2,
        budget: ActionBudget,
        expected: TargetIdentity?,
    ) {
        try {
            clickToFocus(element, null, budget, expected)
            device.waitForIdle(FOCUS_IDLE_TIMEOUT_MS)
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: Exception) {
            rethrowTouchRefusal(e)
            throw ActionFailedException("Failed to focus element: ${e.message}")
        }
    }

    /**
     * Blur an element by tapping outside its bounds to remove focus.
     * Avoids pressBack() which could navigate away or close dialogs.
     */
    fun blur(element: UiObject2) {
        try {
            val bounds = element.visibleBounds
            val screenWidth = device.displayWidth
            val screenHeight = device.displayHeight

            // Find a safe point outside the element to tap
            val tapX: Int
            val tapY: Int
            if (bounds.top > BLUR_TAP_MARGIN_PX) {
                // Tap above the element
                tapX = bounds.centerX()
                tapY = bounds.top / 2
            } else if (bounds.bottom < screenHeight - BLUR_TAP_MARGIN_PX) {
                // Tap below the element
                tapX = bounds.centerX()
                tapY = (bounds.bottom + screenHeight) / 2
            } else if (bounds.left > BLUR_TAP_MARGIN_PX) {
                // Tap to the left
                tapX = bounds.left / 2
                tapY = bounds.centerY()
            } else if (bounds.right < screenWidth - BLUR_TAP_MARGIN_PX) {
                // Tap to the right
                tapX = (bounds.right + screenWidth) / 2
                tapY = bounds.centerY()
            } else {
                // Element fills the screen — tap top-left corner as last resort
                tapX = 1
                tapY = 1
            }

            device.click(tapX, tapY)
            device.waitForIdle(FOCUS_IDLE_TIMEOUT_MS)
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: Exception) {
            throw ActionFailedException("Failed to blur element: ${e.message}")
        }
    }

    /**
     * Highlight an element for debugging.
     *
     * Currently validates that the element exists and is accessible by reading its
     * bounds. A future version may draw an overlay rectangle on the device screen.
     */
    fun highlight(
        element: UiObject2,
        @Suppress("UNUSED_PARAMETER") durationMs: Long = 1000L,
    ) {
        try {
            // Validate element exists and is accessible by reading its bounds.
            // TODO: Draw an overlay rectangle on the device screen for visual debugging.
            element.visibleBounds
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: Exception) {
            throw ActionFailedException("Failed to highlight element: ${e.message}")
        }
    }

    private fun resolveKeyCode(key: String): Int {
        return when (key.lowercase()) {
            "back" -> KeyEvent.KEYCODE_BACK
            "home" -> KeyEvent.KEYCODE_HOME
            "enter", "return" -> KeyEvent.KEYCODE_ENTER
            "tab" -> KeyEvent.KEYCODE_TAB
            "delete", "backspace" -> KeyEvent.KEYCODE_DEL
            "forward_delete" -> KeyEvent.KEYCODE_FORWARD_DEL
            "escape", "esc" -> KeyEvent.KEYCODE_ESCAPE
            "menu" -> KeyEvent.KEYCODE_MENU
            "search" -> KeyEvent.KEYCODE_SEARCH
            "volume_up" -> KeyEvent.KEYCODE_VOLUME_UP
            "volume_down" -> KeyEvent.KEYCODE_VOLUME_DOWN
            "power" -> KeyEvent.KEYCODE_POWER
            "camera" -> KeyEvent.KEYCODE_CAMERA
            "dpad_up" -> KeyEvent.KEYCODE_DPAD_UP
            "dpad_down" -> KeyEvent.KEYCODE_DPAD_DOWN
            "dpad_left" -> KeyEvent.KEYCODE_DPAD_LEFT
            "dpad_right" -> KeyEvent.KEYCODE_DPAD_RIGHT
            "dpad_center" -> KeyEvent.KEYCODE_DPAD_CENTER
            "space" -> KeyEvent.KEYCODE_SPACE
            "recents", "app_switch" -> KeyEvent.KEYCODE_APP_SWITCH
            else -> {
                // Try parsing as a numeric key code
                key.toIntOrNull()
                    ?: throw ActionFailedException("Unknown key: '$key'. Use named keys (back, home, enter, etc.) or numeric key codes.")
            }
        }
    }
}
