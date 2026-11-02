package dev.tapsmith.agent

import android.os.SystemClock
import android.util.Log
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice

/**
 * Element-resolution / waiting engine.
 *
 * Element queries snapshot the current accessibility tree (via [ElementFinder])
 * and match immediately — they are NOT gated on global UI idle. This is
 * essential on perpetually-animated screens (React Native Reanimated loops,
 * indeterminate progress spinners, etc.) where the accessibility-event stream
 * never quiets: an idle-gated wait (UiDevice.waitForIdle / Until.hasObject)
 * would block for its full timeout even when the target element is already
 * present, wedging the agent's single command thread and tripping the daemon's
 * per-command deadline.
 *
 * Bounded idle-waiting is reserved for the explicit [waitForIdle] settle command.
 */
class WaitEngine(
    private val device: UiDevice,
) {
    companion object {
        private const val TAG = "TapsmithWait"

        /** Window between settle re-checks, and the default explicit-idle timeout. */
        private const val STABILITY_WINDOW_MS = 100L
        private const val DEFAULT_IDLE_TIMEOUT_MS = 5000L
        private const val DEFAULT_ELEMENT_TIMEOUT_MS = 10000L

        /**
         * Max positional-stability re-checks before falling back to the current
         * match. Caps the settle phase so a never-settling (animated) screen
         * still makes forward progress instead of blocking.
         */
        private const val SETTLE_MAX_CHECKS = 3

        /**
         * A settle-phase bounds read costing at least this much means the app's
         * main thread is too busy to service accessibility calls promptly —
         * each read blocks on the app's main looper with a multi-second
         * framework ceiling, so further polling only stacks more blocking
         * round-trips (PILOT-278). Bail and proceed with the freshest bounds.
         */
        private const val SETTLE_SLOW_READ_BAIL_MS = 1000L
    }

    /**
     * Wait until the UI is idle — no pending accessibility events.
     *
     * This is an EXPLICIT settle primitive (the `waitForIdle` command). On a
     * screen that never goes idle it will block for the full [timeoutMs]; that
     * is by design — callers ask for it deliberately. Element queries must NOT
     * route through here; they use [waitForElement] instead.
     */
    fun waitForIdle(timeoutMs: Long = DEFAULT_IDLE_TIMEOUT_MS) {
        val startTime = SystemClock.uptimeMillis()
        device.waitForIdle(timeoutMs)
        val elapsed = SystemClock.uptimeMillis() - startTime
        Log.d(TAG, "waitForIdle completed in ${elapsed}ms")
    }

    /**
     * Wait until an element matching the selector exists, then (best-effort)
     * until it is enabled and positionally stable.
     *
     * Resolution polls [ElementFinder.findElement] — which reads a live snapshot
     * of the accessibility tree and does the precise match — sleeping between
     * attempts rather than blocking on global idle. The settle phase is bounded
     * and idle-free: if the screen never stabilizes, it returns the current
     * match instead of waiting forever.
     *
     * @param selector The element selector to wait for
     * @param timeoutMs Maximum time to wait for the element to exist
     * @param elementFinder The element finder used to match
     * @return ElementInfo for the matched element
     * @throws TimeoutException if no matching element appears within the timeout
     */
    fun waitForElement(
        selector: ElementSelector,
        timeoutMs: Long = DEFAULT_ELEMENT_TIMEOUT_MS,
        elementFinder: ElementFinder,
    ): ElementInfo {
        val startTime = SystemClock.uptimeMillis()
        val deadline = startTime + timeoutMs

        // Phase 1: wait for the element to be present (idle-free snapshot poll).
        var match = findOrThrow(selector, elementFinder, deadline, timeoutMs)
        val findMs = SystemClock.uptimeMillis() - startTime

        // Phase 2: best-effort settle — prefer an enabled, positionally-stable
        // match. The per-check wait is a BOUNDED idle wait (capped at
        // STABILITY_WINDOW_MS): it returns immediately on an already-quiet
        // screen (0ms fast-path for the common case) and caps at the window on
        // a perpetually-animating screen, where we then fall back to the
        // current match so it still makes progress.
        //
        // Each stability check re-reads ONLY the matched element's bounds (one
        // accessibility round-trip) rather than re-running the full find, which
        // re-extracts every attribute of every candidate — each read blocking
        // on the app's main looper, stacking to seconds on a busy app
        // (PILOT-278). Two selector kinds keep the full re-find: one that
        // explicitly requires an enabled element (the find filter is what
        // enforces enabled=true, so re-finding is what waits for it to enable;
        // null/false targets are ready once positionally stable — the SDK owns
        // enabled-waiting for actions like tap()), and xpath (its matches are
        // XML-snapshot-based and never cached as UiObject2, so there is no
        // cheap bounds read to make).
        val settleStart = SystemClock.uptimeMillis()
        var checks = 0
        var slowestReadMs = 0L
        while (checks < SETTLE_MAX_CHECKS) {
            CommandCancellation.checkpoint()
            val remaining = deadline - SystemClock.uptimeMillis()
            if (remaining <= 0) break

            device.waitForIdle(STABILITY_WINDOW_MS.coerceAtMost(remaining))

            if (selector.enabled == true || selector.xpath != null) {
                val prevBounds = match.bounds
                try {
                    match = elementFinder.findElement(selector)
                } catch (_: ElementNotFoundException) {
                    // Element went away (or is disabled) during the settle
                    // window; re-acquire (or time out) and give the new element
                    // its own stability window next iteration rather than
                    // comparing it against the old element's bounds.
                    match = findOrThrow(selector, elementFinder, deadline, timeoutMs)
                    checks++
                    continue
                } catch (_: StaleObjectException) {
                    // A re-render outlasted findElements' internal stale
                    // retries; re-acquire against a fresh snapshot rather than
                    // failing the whole wait — mirrors the bounds-read branch.
                    match = findOrThrow(selector, elementFinder, deadline, timeoutMs)
                    checks++
                    continue
                }
                checks++
                val isReady = selector.enabled != true || match.isEnabled
                if (match.bounds == prevBounds && isReady) break
            } else {
                val readStart = SystemClock.uptimeMillis()
                val currentBounds =
                    try {
                        elementFinder.getElementBounds(match.elementId)
                    } catch (_: ElementNotFoundException) {
                        null
                    } catch (_: StaleObjectException) {
                        null
                    }
                val readMs = SystemClock.uptimeMillis() - readStart
                if (readMs > slowestReadMs) slowestReadMs = readMs
                checks++
                if (currentBounds == null) {
                    // Stale or evicted during the settle window; re-acquire (or
                    // time out) and give the new element its own stability
                    // window next iteration.
                    match = findOrThrow(selector, elementFinder, deadline, timeoutMs)
                    continue
                }
                if (currentBounds == match.bounds) break
                val ratio = elementFinder.computeViewportRatio(currentBounds)
                match = match.copy(bounds = currentBounds, viewportRatio = ratio, isVisible = ratio > 0f)
                if (readMs >= SETTLE_SLOW_READ_BAIL_MS) {
                    Log.w(
                        TAG,
                        "waitForElement settle: single bounds read took ${readMs}ms — " +
                            "app main thread is busy; proceeding with the freshest bounds",
                    )
                    break
                }
            }
        }
        val settleMs = SystemClock.uptimeMillis() - settleStart
        Log.d(
            TAG,
            "waitForElement phases: find=${findMs}ms settle=${settleMs}ms " +
                "(checks=$checks, slowestBoundsRead=${slowestReadMs}ms)",
        )

        // The settle reads can be slow: callers act on the match next (a
        // swipe, a scroll, a drag), so not for a command the daemon gave up
        // on meanwhile (PILOT-605).
        CommandCancellation.checkpoint()
        return match
    }

    /**
     * Poll [ElementFinder.findElement] until a match exists or [deadline] passes.
     * Sleeps (never calls device.waitForIdle) between attempts, so it makes
     * forward progress on screens that never go idle. The first attempt happens
     * before any sleep, so a visible element returns on the first snapshot; the
     * sleeps between later attempts ramp up ([FindRetrySchedule]).
     */
    private fun findOrThrow(
        selector: ElementSelector,
        elementFinder: ElementFinder,
        deadline: Long,
        timeoutMs: Long,
    ): ElementInfo {
        var retry = 0
        while (true) {
            CommandCancellation.checkpoint()
            try {
                return elementFinder.findElement(selector)
            } catch (_: ElementNotFoundException) {
                val remaining = deadline - SystemClock.uptimeMillis()
                if (remaining <= 0) {
                    throw TimeoutException(
                        "Timed out after ${timeoutMs}ms: element not found after waiting. " +
                            "Selector: ${selector.describe()}",
                    )
                }
                CommandCancellation.sleep(FindRetrySchedule.delayMs(retry++, remaining))
            }
        }
    }
}
