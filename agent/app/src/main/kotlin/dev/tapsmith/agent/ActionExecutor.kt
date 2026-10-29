package dev.tapsmith.agent

import android.app.Instrumentation
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
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
    /** Every touch and key goes through here, never UiDevice/UiObject2 (PILOT-789). */
    private val input: AgentInput,
) {
    /** Tracks ASCII control-char code points we've already warned about,
     *  so the log fires once per code point per agent lifetime. */
    private val warnedDroppedControlChars =
        java.util.concurrent.ConcurrentHashMap
            .newKeySet<Int>()

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

        /**
         * A swipe's settle ([settleAfterSwipe]) ends once no scroll event has
         * arrived for this long. A moving scroll view reports one at least
         * every 100 ms (the framework's recurring-event interval).
         */
        private const val SWIPE_SETTLE_QUIET_MS = 300L

        /** Upper bound on a swipe's settle, for a scroll view that keeps moving. */
        private const val SWIPE_SETTLE_MAX_MS = 3000L

        /** How long each press of a double tap (and a retried tap) is held. */
        private const val TAP_PRESS_MS = 50L

        /** Time reserved after a focusing tap for the work that follows it
         *  (setting or clearing text and its idle waits), so the tap is not
         *  made when that work could not finish before the daemon gives up. */
        private const val FOCUS_FOLLOW_UP_MS = 1000L

        /** The same for a fallback refocus, which then waits for idle and
         *  focus (up to 3 s) before injecting keys. */
        private const val FALLBACK_FOLLOW_UP_MS = 3500L

        /** Max time to wait for an element's bounds to stop moving before a tap. */
        private const val STABLE_BOUNDS_TIMEOUT_MS = 1000L

        /** Delay between consecutive bounds reads in the stability check. */
        private const val STABLE_BOUNDS_POLL_MS = 50L

        /** Timeout for waiting for dropdown options to appear. */
        private const val DROPDOWN_WAIT_TIMEOUT_MS = 3000L

        /** Time reserved for tapping the option once the dropdown is open. */
        private const val SPINNER_OPTION_TAP_MS = 500L

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
     * A keyboard that would eat the touch (a scroll view closing it on the
     * first tap after typing) is put away first; see [KeyboardFirst]
     * (PILOT-622). Long press and double tap do the same.
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
        followUpMs: Long = 0,
    ) {
        try {
            // Bounds from before the keyboard went away are stale: the screen
            // lays itself out again without it.
            val keyboardPutAway = occlusionGuard.putKeyboardAwayFirst(element, budget)
            val trusted = resolvedBounds?.takeIf { !it.isEmpty && !keyboardPutAway }
            val stableStart = SystemClock.uptimeMillis()
            val bounds = trusted ?: waitForStableBounds(element)
            val stableMs = SystemClock.uptimeMillis() - stableStart
            val planStart = SystemClock.uptimeMillis()
            val point = planTouchPoint(element, bounds, budget, expected, followUpMs)
            val planMs = SystemClock.uptimeMillis() - planStart
            val injectStart = SystemClock.uptimeMillis()
            clickAt(point, "tap element")
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
            CommandCancellation.sleep(STABLE_BOUNDS_POLL_MS)
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
        if (!input.click(x, y)) {
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
            val keyboardPutAway = occlusionGuard.putKeyboardAwayFirst(element, budget)
            val bounds =
                if (keyboardPutAway) {
                    waitForStableBounds(element)
                } else {
                    resolvedBounds?.takeIf { !it.isEmpty } ?: element.visibleBounds
                }
            // The cover wait and the hold together fit the timeout, as on iOS
            // and the daemon's HID route (long_press_resolve_budget).
            val point =
                planGesturePoint(element, bounds, budget.shortenedBy(durationMs), expected, "long press", reserveMs = durationMs)
            input.swipe(point.x, point.y, point.x, point.y, (durationMs / 5).toInt().coerceAtLeast(1))
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
     * The uncovered point a touch on [element] must use (PILOT-362). An
     * element the guard finds not on screen after all — gone invisible since
     * it was resolved, or down to a sliver — is refused rather than handed to
     * the node click, which taps its center whatever covers it.
     */
    private fun planTouchPoint(
        element: UiObject2,
        bounds: Rect,
        budget: ActionBudget,
        expected: TargetIdentity?,
        followUpMs: Long,
    ): TouchPlan.Point =
        occlusionGuard.plan(element, bounds, budget, expected, followUpMs) as? TouchPlan.Point
            ?: throw notOnScreen()

    private fun notOnScreen() =
        ActionFailedException(
            "Element is not visible on screen (scrolled off, hidden, or fully clipped), so it was not touched",
        )

    /**
     * Tap at a planned point. A refused injection (the input dispatcher
     * dropping the event during a window transition on a loaded device) is
     * retried once, with a shorter press, at the same point — never by the
     * node click, which would ignore what covers the element.
     */
    private fun clickAt(
        point: TouchPlan.Point,
        what: String,
    ) {
        if (input.click(point.x, point.y)) return
        Log.w(TAG, "$what: click at (${point.x}, ${point.y}) was refused; retrying once")
        if (!input.click(point.x, point.y, TAP_PRESS_MS)) {
            throw ActionFailedException("Failed to $what at (${point.x}, ${point.y})")
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
    ): TouchPlan.Point {
        // Empty bounds (zero size, or clipped away for a moment) go through the
        // guard too: it re-reads them within the budget, then refuses.
        val plan = occlusionGuard.plan(element, bounds, budget, expected, reserveMs)
        return plan as? TouchPlan.Point
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
        input.swipe(x, y, x, y, (durationMs / 5).toInt().coerceAtLeast(1))
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
            clickToFocus(element, resolvedBounds, budget, expected, FOCUS_FOLLOW_UP_MS)
            // A skipped focusing tap reads the field's focus after the
            // planner's last check (PILOT-605).
            CommandCancellation.checkpoint()
            element.text = text
            // UiObject2.setText silently logs-and-returns when the framework
            // rejects ACTION_SET_TEXT (e.g. the field is still gaining focus
            // on a loaded emulator) — verify the value landed and re-set once.
            // The read-back can legitimately differ from the input (password
            // masking, input formatters), so the retry is bounded to one
            // idempotent re-set and a persistent mismatch only logs.
            if (element.text != text) {
                device.waitForIdle(500)
                CommandCancellation.checkpoint()
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
                refocusForFallback(element, budget, expected)
                device.waitForIdle(1000)
                // Key events route through the IME; injecting while the input
                // session is still restarting after the focus click silently
                // drops the first commits under load. Wait for focus first.
                waitForFocus(element)
                typeTextWithoutFocus(text)
            } catch (e2: StaleObjectException) {
                throw e2
            } catch (e2: Exception) {
                throw fallbackFailure("type text", e, e2, changedNote = "so it was not typed into again")
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
            CommandCancellation.sleep(100)
        }
    }

    /**
     * Tap an element to focus it, at a point nothing covers (PILOT-362),
     * reusing resolve-time bounds when available. A covered field that
     * already has input focus — typically one behind the keyboard it raised —
     * is not tapped at all: input reaches it anyway, and the tap would land
     * on the cover (a key, for the keyboard).
     */
    private fun clickToFocus(
        element: UiObject2,
        resolvedBounds: Rect?,
        budget: ActionBudget,
        expected: TargetIdentity?,
        followUpMs: Long,
    ) {
        val bounds = resolvedBounds?.takeIf { !it.isEmpty } ?: element.visibleBounds
        when (val plan = occlusionGuard.planFocusTap(element, bounds, budget, expected, followUpMs)) {
            // Skipped (covered, but already focused); the planner has checked
            // the work after it still fits the deadline.
            null -> Log.d(TAG, "focusing tap skipped: the field is covered but already focused")
            is TouchPlan.Point -> clickAt(plan, "tap element to focus it")
            // Gone invisible or down to a sliver since it was resolved: see
            // planTouchPoint.
            TouchPlan.OffScreen -> throw notOnScreen()
        }
    }

    /**
     * The fallback's refocus: one check, no waiting — the first tap may have
     * moved the field (a keyboard-avoiding view lifting it). When the keyboard
     * refuses it, the first tap usually did land and raised that keyboard
     * while the field's focus is still arriving: wait for focus (as the
     * fallback always did) and carry on without a tap if it arrives.
     */
    private fun refocusForFallback(
        element: UiObject2,
        budget: ActionBudget,
        expected: TargetIdentity?,
    ) {
        val skipped =
            refocusOrAcceptFocus(
                refocus = { clickToFocus(element, null, budget.noWait(), expected, FALLBACK_FOLLOW_UP_MS) },
                // The caller waits for focus again, which then returns at once.
                waitForFocus = {
                    waitForFocus(element)
                    try {
                        element.isFocused
                    } catch (_: Exception) {
                        false
                    }
                },
                // No tap was planned, so plan()'s deadline check did not run:
                // the keys that follow must still finish in time.
                requireTime = { occlusionGuard.requireTimeFor(budget, FALLBACK_FOLLOW_UP_MS) },
            )
        if (skipped) Log.d(TAG, "fallback refocus skipped: the field got focus under its keyboard")
    }

    /**
     * Rethrow a touch that was refused rather than attempted (covered, changed
     * into another element, too late) so a fallback path does not retry it —
     * or bury its error type in a generic ACTION_FAILED. A command the daemon
     * gave up on (PILOT-605) is not retried either.
     */
    private fun rethrowTouchRefusal(e: Exception) {
        if (e is TouchRefusedException || e is CommandCancelledException) throw e
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
            CommandCancellation.checkpoint() // see flushPrintableRun
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
        // Each run is its own shell command (hundreds of ms on a loaded
        // device), reached after idle and focus waits in the typeText
        // fallback: keys for a command the daemon gave up on would go to
        // whatever field is focused during the next step (PILOT-605).
        CommandCancellation.checkpoint()
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
            clickToFocus(element, null, budget, expected, FOCUS_FOLLOW_UP_MS)
            device.waitForIdle(500)
            // A skipped focusing tap and the idle wait both run after the
            // planner's last check (PILOT-605).
            CommandCancellation.checkpoint()
            // Select all (Ctrl+A) then delete
            element.clear()
        } catch (e: StaleObjectException) {
            throw e
        } catch (e: Exception) {
            rethrowTouchRefusal(e)
            // Fallback: triple-click to select all, then press delete
            try {
                refocusForFallback(element, budget, expected)
                device.waitForIdle(200)
                CommandCancellation.checkpoint()
                // Use shell to select all and delete
                device.executeShellCommand("input keyevent KEYCODE_MOVE_HOME")
                device.executeShellCommand("input keyevent --longpress KEYCODE_SHIFT_LEFT KEYCODE_MOVE_END")
                device.executeShellCommand("input keyevent KEYCODE_DEL")
            } catch (e2: StaleObjectException) {
                throw e2
            } catch (e2: Exception) {
                throw fallbackFailure("clear text", e, e2, changedNote = "so nothing else was cleared")
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
            input.swipe(element, direction, distance.toFloat(), speed)
            settleAfterSwipe(vertical = dir == Direction.UP || dir == Direction.DOWN)
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
                input.swipe(cx, cy + swipeLength / 2, cx, cy - swipeLength / 2, steps)
            }
            "down" -> {
                swipeLength = (h * distance).toInt()
                input.swipe(cx, cy - swipeLength / 2, cx, cy + swipeLength / 2, steps)
            }
            "left" -> {
                swipeLength = (w * distance).toInt()
                input.swipe(cx + swipeLength / 2, cy, cx - swipeLength / 2, cy, steps)
            }
            "right" -> {
                swipeLength = (w * distance).toInt()
                input.swipe(cx - swipeLength / 2, cy, cx + swipeLength / 2, cy, steps)
            }
            else -> throw ActionFailedException("Unknown swipe direction: $direction. Use up/down/left/right.")
        }
        settleAfterSwipe(vertical = direction.lowercase() == "up" || direction.lowercase() == "down")
    }

    /**
     * Arrival time (uptime) of the last TYPE_VIEW_SCROLLED event that may be
     * along each axis, recorded by [onAccessibilityEvent] for
     * [settleAfterSwipe].
     */
    @Volatile private var lastVerticalScrollAt = 0L

    @Volatile private var lastHorizontalScrollAt = 0L

    init {
        // One listener for the agent's lifetime, so the settle measures quiet
        // from when scroll events ARRIVE. UiAutomation.executeAndWaitForEvent
        // drops events stamped before each wait began, so on a slow device
        // (delivery latency over the 100 ms scroll-event interval) a
        // per-event wait loop would miss a fling that is still moving. This
        // replaces UIAutomator's QueryController listener, which tracks only
        // UiDevice.getCurrentActivityName() and the legacy UiObject "last
        // traversed text" — neither of which the agent uses (they return
        // stale values once this is installed).
        try {
            instrumentation.uiAutomation.setOnAccessibilityEventListener(::onAccessibilityEvent)
        } catch (e: Exception) {
            Log.w(TAG, "Could not listen for scroll events; swipes will not wait for flings to settle", e)
        }
    }

    private fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_VIEW_SCROLLED) return
        val now = SystemClock.uptimeMillis()
        val hasDeltas = android.os.Build.VERSION.SDK_INT >= 28
        if (!hasDeltas || SwipeSettle.isAlongAxis(event.scrollDeltaX, event.scrollDeltaY, vertical = true)) {
            lastVerticalScrollAt = now
        }
        if (!hasDeltas || SwipeSettle.isAlongAxis(event.scrollDeltaX, event.scrollDeltaY, vertical = false)) {
            lastHorizontalScrollAt = now
        }
    }

    /**
     * Let the fling a swipe starts come to rest before the swipe returns
     * (PILOT-539). A scroll view that is still moving takes the next touch
     * as "stop scrolling" — React Native's ScrollView captures every touch
     * between its momentum-scroll begin and end events — so a tap made right
     * after a swipe silently does nothing. A moving scroll view emits
     * TYPE_VIEW_SCROLLED events, so wait until none has arrived for
     * [SWIPE_SETTLE_QUIET_MS], bounded by [SWIPE_SETTLE_MAX_MS]. Only scroll
     * events that may be along the swipe's axis count
     * ([SwipeSettle.isAlongAxis]): a screen whose animation emits other
     * events all the time (the never-idle screens PILOT-539 is about), or
     * whose carousel keeps scrolling sideways, settles as soon as the swiped
     * content stops.
     */
    private fun settleAfterSwipe(vertical: Boolean) {
        val start = SystemClock.uptimeMillis()
        val deadline = start + SWIPE_SETTLE_MAX_MS
        while (true) {
            val now = SystemClock.uptimeMillis()
            val lastScroll = if (vertical) lastVerticalScrollAt else lastHorizontalScrollAt
            val wait = SwipeSettle.remainingQuietMs(now, start, lastScroll, SWIPE_SETTLE_QUIET_MS)
            if (wait <= 0 || now >= deadline) break
            CommandCancellation.sleep(wait.coerceAtMost(deadline - now))
        }
        Log.d(TAG, "swipe settle: ${SystemClock.uptimeMillis() - start}ms")
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
        input.swipe(x1, y1, x2, y2, steps)
        settleAfterSwipe(vertical = kotlin.math.abs(y2 - y1) >= kotlin.math.abs(x2 - x1))
    }

    // ─── Streamed touch (interactive mirror live-drag) ───
    // @Volatile: touch events arrive on gRPC pool threads; ensure writes are
    // visible across threads.
    @Volatile
    private var touchDownTime = 0L

    @Volatile
    private var touchActive = false

    private fun injectTouch(
        action: TouchAction,
        x: Int,
        y: Int,
    ) {
        // Sent without waiting for the app: fire-and-forget keeps the move
        // stream low-latency.
        input.gestures.streamTouch(action, touchDownTime, x, y)
    }

    fun touchDown(
        x: Int,
        y: Int,
    ) {
        touchDownTime = SystemClock.uptimeMillis()
        touchActive = true
        injectTouch(TouchAction.DOWN, x, y)
    }

    fun touchMove(
        x: Int,
        y: Int,
    ) {
        if (!touchActive) return
        injectTouch(TouchAction.MOVE, x, y)
    }

    fun touchUp(
        x: Int,
        y: Int,
    ) {
        if (!touchActive) return
        injectTouch(TouchAction.UP, x, y)
        touchActive = false
    }

    fun touchCancel() {
        if (!touchActive) return
        injectTouch(TouchAction.CANCEL, 0, 0)
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
                input.scroll(element, dir, 1.0f)
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
            // Up to 20 scrolls with no deadline of their own: never scroll on
            // after the daemon has given up (PILOT-605).
            CommandCancellation.checkpoint()
            // Check if target is already visible
            val targetBy =
                when {
                    targetSelector.text != null -> By.text(TextMatch.exactPattern(targetSelector.text))
                    targetSelector.textContains != null ->
                        By.text(TextMatch.containsPattern(targetSelector.textContains))
                    targetSelector.textRegex != null -> By.text(targetSelector.textRegex.fullMatchPattern())
                    targetSelector.contentDesc != null -> By.desc(targetSelector.contentDesc)
                    targetSelector.id != null -> By.res(targetSelector.id)
                    else -> throw InvalidSelectorException("scrollTo requires text, textContains, textRegex, contentDesc, or id")
                }

            val found = container.findObject(targetBy)
            if (found != null) return

            CommandCancellation.checkpoint()
            val canScroll = input.scroll(container, direction, 0.8f)
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
        if (!input.pressKey(keyCode)) {
            throw ActionFailedException("Failed to press key: $key")
        }
    }

    private fun parseDirection(direction: String): Direction =
        when (direction.lowercase()) {
            "up" -> Direction.UP
            "down" -> Direction.DOWN
            "left" -> Direction.LEFT
            "right" -> Direction.RIGHT
            else -> throw ActionFailedException("Unknown direction: $direction. Use up/down/left/right.")
        }

    /**
     * Double-tap on an element, at a point nothing covers (see [tap];
     * PILOT-362).
     *
     * Makes the two taps with short presses and a fixed gap, so under load the
     * gap between them stays inside the app's double-tap window rather than
     * registering as two single taps.
     */
    fun doubleTap(
        element: UiObject2,
        intervalMs: Long,
        resolvedBounds: Rect?,
        budget: ActionBudget,
        expected: TargetIdentity?,
    ) {
        try {
            val keyboardPutAway = occlusionGuard.putKeyboardAwayFirst(element, budget)
            val bounds =
                if (keyboardPutAway) {
                    waitForStableBounds(element)
                } else {
                    resolvedBounds?.takeIf { !it.isEmpty } ?: element.visibleBounds
                }
            // Both presses and the gap between them must finish before the
            // daemon gives up, or the second tap lands in the next step.
            val gestureMs = (if (intervalMs > 0) intervalMs else DOUBLE_TAP_INTERVAL_MS) + 2 * TAP_PRESS_MS
            val point = planGesturePoint(element, bounds, budget, expected, "double tap", reserveMs = gestureMs)
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
        if (input.click(x, y, TAP_PRESS_MS)) {
            SystemClock.sleep(interval)
            if (input.click(x, y, TAP_PRESS_MS)) return
            // First tap already landed — complete the gesture with one more
            // try rather than leaving a lone single tap behind.
            if (input.click(x, y)) return
            throw ActionFailedException("Failed to double tap at ($x, $y)")
        }
        // The first tap was refused: try the pair once more.
        input.click(x, y)
        SystemClock.sleep(interval)
        if (!input.click(x, y)) {
            throw ActionFailedException("Failed to double tap at ($x, $y)")
        }
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
            // The bounds read can be slow on a busy app (PILOT-605).
            CommandCancellation.checkpoint()
            input.drag(source, ScreenPoint(tgtBounds.centerX(), tgtBounds.centerY()))
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
            // Tap the spinner to open it — only if the dropdown wait and the
            // option tap after it can still finish before the daemon gives up.
            tap(element, null, budget, expected, followUpMs = DROPDOWN_WAIT_TIMEOUT_MS + SPINNER_OPTION_TAP_MS)
            // Wait for the option to appear then tap it
            val option =
                device.wait(Until.findObject(By.text(optionText)), DROPDOWN_WAIT_TIMEOUT_MS)
                    ?: throw ElementNotFoundException("Option '$optionText' not found in dropdown")
            // The dropdown wait cannot be cut short (PILOT-605).
            CommandCancellation.checkpoint()
            input.click(option)
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
            // Tap the spinner to open it (see selectOption).
            tap(element, null, budget, expected, followUpMs = DROPDOWN_WAIT_TIMEOUT_MS + SPINNER_OPTION_TAP_MS)
            // Wait for a common dropdown container to appear
            val popupSelector =
                By.clazz(
                    java.util.regex.Pattern
                        .compile(".*(ListView|RecyclerView|PopupWindow)$"),
                )
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
            // The popup wait cannot be cut short (PILOT-605).
            CommandCancellation.checkpoint()
            input.click(children[index])
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
            input.pinch(element, open = scale > 1.0f, GestureGeometry.pinchPercent(scale))
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
            clickToFocus(element, null, budget, expected, FOCUS_IDLE_TIMEOUT_MS)
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

            // The bounds read can be slow on a busy app (PILOT-605).
            CommandCancellation.checkpoint()
            input.click(tapX, tapY)
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

    private fun resolveKeyCode(key: String): Int =
        when (key.lowercase()) {
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
