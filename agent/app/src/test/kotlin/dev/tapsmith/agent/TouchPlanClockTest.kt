package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Host-side tests for the covered-element wait's deadline bookkeeping (PILOT-362). */
class TouchPlanClockTest {
    @Test
    fun `polls at the poll interval while time remains`() {
        val clock = TouchPlanClock(startMs = 1_000, timeoutMs = 2_000)
        assertEquals(TouchPlanClock.POLL_MS, clock.sleepBeforeNextPass(nowMs = 1_000))
    }

    @Test
    fun `never sleeps past the deadline`() {
        val clock = TouchPlanClock(startMs = 1_000, timeoutMs = 2_000)
        assertEquals(100L, clock.sleepBeforeNextPass(nowMs = 2_900))
    }

    @Test
    fun `gives up at the deadline`() {
        val clock = TouchPlanClock(startMs = 1_000, timeoutMs = 2_000)
        assertNull(clock.sleepBeforeNextPass(nowMs = 3_000))
        assertNull(clock.sleepBeforeNextPass(nowMs = 9_000))
    }

    @Test
    fun `a zero budget is a single check`() {
        val clock = TouchPlanClock(startMs = 1_000, timeoutMs = 0)
        assertNull(clock.sleepBeforeNextPass(nowMs = 1_000))
    }

    @Test
    fun `a negative budget is treated as zero`() {
        val clock = TouchPlanClock(startMs = 1_000, timeoutMs = -5)
        assertNull(clock.sleepBeforeNextPass(nowMs = 1_000))
    }

    @Test
    fun `too late once the touch could not answer before the daemon's read deadline`() {
        // The daemon waits 7 s; the touch needs the margin to answer.
        val clock = TouchPlanClock(startMs = 0, timeoutMs = 2_000, readDeadlineMs = 7_000)
        assertFalse(clock.isTooLateToAct(nowMs = 7_000 - TouchPlanClock.READ_DEADLINE_MARGIN_MS))
        assertTrue(clock.isTooLateToAct(nowMs = 7_001 - TouchPlanClock.READ_DEADLINE_MARGIN_MS))
    }

    @Test
    fun `the margin never exceeds the headroom the daemon gave`() {
        // TAPSMITH_AGENT_READ_HEADROOM_MS=0: the daemon waits exactly the
        // timeout, so demanding a 1 s margin would refuse every late touch.
        val clock = TouchPlanClock(startMs = 0, timeoutMs = 1_000, readDeadlineMs = 1_000)
        assertFalse(clock.isTooLateToAct(nowMs = 50))
        assertTrue(clock.isTooLateToAct(nowMs = 1_001))
        // Half the usual margin with a 500 ms headroom.
        val half = TouchPlanClock(startMs = 0, timeoutMs = 1_000, readDeadlineMs = 1_500)
        assertFalse(half.isTooLateToAct(nowMs = 1_000))
        assertTrue(half.isTooLateToAct(nowMs = 1_001))
    }

    @Test
    fun `a reserved hold moves the too-late point earlier`() {
        val clock = TouchPlanClock(startMs = 0, timeoutMs = 2_000, readDeadlineMs = 7_000, reserveMs = 3_000)
        assertFalse(clock.isTooLateToAct(nowMs = 4_000 - TouchPlanClock.READ_DEADLINE_MARGIN_MS))
        assertTrue(clock.isTooLateToAct(nowMs = 4_001 - TouchPlanClock.READ_DEADLINE_MARGIN_MS))
    }

    @Test
    fun `without a read deadline a check far past the budget is too late`() {
        // An older daemon that sends no readTimeoutMs still waits its usual
        // timeout + 5 s.
        val clock = TouchPlanClock(startMs = 0, timeoutMs = 2_000)
        assertFalse(clock.isTooLateToAct(nowMs = 2_000 + TouchPlanClock.LATE_WITHOUT_READ_DEADLINE_MS))
        assertTrue(clock.isTooLateToAct(nowMs = 2_001 + TouchPlanClock.LATE_WITHOUT_READ_DEADLINE_MS))
    }

    @Test
    fun `without a read deadline a zero budget is never too late`() {
        val clock = TouchPlanClock(startMs = 0, timeoutMs = 0)
        assertFalse(clock.isTooLateToAct(nowMs = 60_000))
    }
}
