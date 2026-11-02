package dev.tapsmith.agent

import java.util.concurrent.TimeoutException

/**
 * `android.app.UiAutomation.waitForIdle(quietMs, timeoutMs)`: returns once no
 * accessibility event has arrived for [quietMs], or throws [TimeoutException].
 * An interface so the settle wait's bound is testable on the JVM.
 */
fun interface IdleWaiter {
    @Throws(TimeoutException::class)
    fun waitForIdle(
        quietMs: Long,
        timeoutMs: Long,
    )
}

/**
 * The settle check's pause between two bounds reads (PILOT-989).
 *
 * `UiDevice.waitForIdle(t)` is `UiAutomation.waitForIdle(500, t)`: it asks for
 * 500 ms without accessibility events, and AOSP's loop sleeps for the
 * remaining *quiet* time before it re-checks `t`. On a screen that is never
 * quiet for 500 ms (a ticker, a spinner, React Native re-renders) a "100 ms"
 * wait therefore cost up to 600 ms: ~370 ms median per find.
 *
 * This asks for a quiet window equal to the cap instead. The same loop then
 * costs at most twice the cap (an event just before the cap restarts one last
 * quiet window), returns at once on a screen already quiet for the window, and
 * returns as soon as the screen goes quiet within it.
 *
 * Why the window is not shorter than the cap: the settle loop's default cap
 * is 100 ms, the accessibility framework's throttle for recurring
 * content-change events (`ViewConfiguration.getSendRecurringAccessibilityEventsInterval`).
 * A view that keeps changing sends an event about that often, so a 100 ms
 * window keeps it from looking quiet; a shorter one would close between its
 * events, and the two bounds samples the settle compares would be taken back
 * to back.
 */
object SettleIdle {
    /** True when the screen was quiet for [capMs]; false when not, or when [capMs] is spent. */
    fun await(
        idle: IdleWaiter,
        capMs: Long,
    ): Boolean {
        if (capMs <= 0) return false
        return try {
            idle.waitForIdle(capMs, capMs)
            true
        } catch (_: TimeoutException) {
            false
        }
    }
}
