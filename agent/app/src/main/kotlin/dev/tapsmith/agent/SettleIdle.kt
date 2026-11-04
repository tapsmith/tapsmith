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
 * This asks for a [QUIET_MS] window instead. AOSP's loop then costs less than
 * [QUIET_MS] + the cap, returns at once on a screen already quiet for the
 * window, and returns as soon as the screen goes quiet.
 *
 * The pause is what makes the settle's bounds comparison mean anything: two
 * samples taken back to back match even mid-animation. A view that keeps
 * changing sends a content-change event at most once per throttle interval
 * (`ViewConfiguration.getSendRecurringAccessibilityEventsInterval`, 100 ms),
 * so its events arrive 100–116 ms apart. A window of one interval would close
 * in every such gap and let the pause shrink to nothing; two intervals cannot
 * close while anything animates, so a busy screen pauses for the full cap
 * (as `device.waitForIdle` did) and only a screen with no event for
 * [QUIET_MS] skips it.
 */
object SettleIdle {
    /** Twice the recurring accessibility-event throttle interval. */
    const val QUIET_MS = 200L

    /** True when the screen was quiet for [QUIET_MS]; false when not, or when [capMs] is spent. */
    fun await(
        idle: IdleWaiter,
        capMs: Long,
    ): Boolean {
        if (capMs <= 0) return false
        return try {
            idle.waitForIdle(QUIET_MS, capMs)
            true
        } catch (_: TimeoutException) {
            false
        }
    }
}
