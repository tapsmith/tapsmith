package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Test

/** Host-side tests for the find loop's retry ramp (PILOT-972). */
class FindRetryScheduleTest {
    @Test
    fun `re-reads at once, then ramps up to the old 200 ms poll and stays there`() {
        val delays = (0 until 8).map { FindRetrySchedule.delayMs(retry = it, remainingMs = 10_000) }
        assertEquals(listOf(0L, 20L, 100L, 100L, 200L, 200L, 200L, 200L), delays)
    }

    @Test
    fun `never sleeps past the deadline`() {
        assertEquals(30L, FindRetrySchedule.delayMs(retry = 6, remainingMs = 30))
        assertEquals(0L, FindRetrySchedule.delayMs(retry = 2, remainingMs = 0))
        assertEquals(0L, FindRetrySchedule.delayMs(retry = 2, remainingMs = -5))
    }

    @Test
    fun `a negative retry index is the first step`() {
        assertEquals(0L, FindRetrySchedule.delayMs(retry = -1, remainingMs = 10_000))
    }
}
