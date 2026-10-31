package dev.tapsmith.agent

/**
 * How long [WaitEngine]'s find loop waits between reads of the accessibility
 * tree while an element has not appeared yet (PILOT-972).
 *
 * The loop used to sleep a flat 200 ms. The first read usually misses right
 * after a navigation, and the next would mostly have succeeded far sooner, so
 * the loop re-reads at once and then ramps up, as Playwright's action retries
 * do (`[0, 20, 100, 100, 500]`). The ramp stops at the old 200 ms instead of
 * 500 ms: a read here costs tens of milliseconds, and a long wait should not
 * poll less often than it used to.
 */
object FindRetrySchedule {
    private val DELAYS_MS = longArrayOf(0L, 20L, 100L, 100L, 200L)

    /**
     * The sleep before re-read number [retry] (0 = the first re-read after
     * the initial miss), never more than [remainingMs] and never negative.
     */
    fun delayMs(
        retry: Int,
        remainingMs: Long,
    ): Long {
        val step = DELAYS_MS[retry.coerceIn(0, DELAYS_MS.size - 1)]
        return step.coerceAtMost(remainingMs).coerceAtLeast(0L)
    }
}
