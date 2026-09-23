package dev.tapsmith.agent

/**
 * Deadline bookkeeping for one covered-element wait (PILOT-362, the Android
 * counterpart of the iOS agent's TouchPlanClock): how long to keep
 * re-checking a covered element, and when a slow check has run too late to
 * act on. Plain millisecond arithmetic with no Android dependencies, so the
 * JVM unit tests can drive it with a fake clock.
 */
class TouchPlanClock(
    startMs: Long,
    private val timeoutMs: Long,
    /** When the daemon gives up on this command (its `readTimeoutMs` counted
     *  from the command's arrival); null from an older daemon. */
    private val readDeadlineMs: Long? = null,
    /** Time the caller still needs once the touch starts (a long press's hold). */
    private val reserveMs: Long = 0,
) {
    companion object {
        /** Re-check interval while something covers the element. */
        const val POLL_MS = 250L

        /** Room left before the daemon's read deadline for the touch itself
         *  and the answer to reach the daemon — capped at the headroom the
         *  daemon gave past the timeout, so a lowered
         *  TAPSMITH_AGENT_READ_HEADROOM_MS does not refuse every late touch. */
        const val READ_DEADLINE_MARGIN_MS = 1000L

        /** Fallback when the daemon did not say how long it waits: past the
         *  budget by more than this, assume its usual timeout + 5 s read
         *  deadline is close. */
        const val LATE_WITHOUT_READ_DEADLINE_MS = 4000L
    }

    private val deadlineMs = startMs + timeoutMs.coerceAtLeast(0)

    /** How long to sleep before the next check of a covered element, or null
     *  once the deadline has passed and the wait should give up. */
    fun sleepBeforeNextPass(nowMs: Long): Long? {
        val remaining = deadlineMs - nowMs
        if (remaining <= 0) return null
        return minOf(POLL_MS, remaining)
    }

    /** Whether a check that ended at [nowMs] finished too late to act on: the
     *  touch (plus any reserved hold) could not answer before the daemon gives
     *  up, and would land in the middle of whatever the test does next. */
    fun isTooLateToAct(nowMs: Long): Boolean {
        if (readDeadlineMs != null) {
            val margin = READ_DEADLINE_MARGIN_MS.coerceAtMost((readDeadlineMs - deadlineMs).coerceAtLeast(0))
            return nowMs + reserveMs.coerceAtLeast(0) + margin > readDeadlineMs
        }
        // Older daemon: a zero budget is a single check on its default deadline.
        return timeoutMs > 0 && nowMs - deadlineMs > LATE_WITHOUT_READ_DEADLINE_MS
    }
}
