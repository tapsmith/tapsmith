package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeoutException

/**
 * Host-side tests for the settle check's bounded idle wait (PILOT-989).
 *
 * [FakeUiAutomation] replays AOSP's `UiAutomation.waitForIdle(idle, global)`
 * loop on a virtual clock: it checks the global timeout, then the quiet time,
 * then sleeps for the remaining *quiet* time, woken early by the next
 * accessibility event. That sleep is not bounded by the global timeout, which
 * is how `UiDevice.waitForIdle(100)` (a 500 ms quiet window) cost ~370–590 ms
 * per settle check on a screen that is never quiet for 500 ms.
 */
class SettleIdleTest {
    /** Virtual-clock replay of android.app.UiAutomation#waitForIdle(long, long). */
    private class FakeUiAutomation(
        /** Uptimes of accessibility events, ascending. */
        private val events: List<Long>,
        var now: Long = 0,
        private var lastEvent: Long = 0,
    ) : IdleWaiter {
        val requests = mutableListOf<Pair<Long, Long>>()

        private fun deliverUpTo(t: Long) {
            events.lastOrNull { it <= t }?.let { lastEvent = maxOf(lastEvent, it) }
        }

        override fun waitForIdle(
            quietMs: Long,
            timeoutMs: Long,
        ) {
            requests += quietMs to timeoutMs
            deliverUpTo(now)
            val start = now
            if (lastEvent <= 0) lastEvent = start
            while (true) {
                if (timeoutMs - (now - start) <= 0) throw TimeoutException("no idle")
                val remainingQuiet = quietMs - (now - lastEvent)
                if (remainingQuiet <= 0) return
                // mLock.wait(remainingQuiet), woken by the next event.
                val wake = now + remainingQuiet
                val next = events.firstOrNull { it in (now + 1)..wake }
                now = next ?: wake
                deliverUpTo(now)
            }
        }
    }

    private fun cost(
        ua: FakeUiAutomation,
        block: () -> Unit,
    ): Long {
        val start = ua.now
        block()
        return ua.now - start
    }

    private fun every(
        periodMs: Long,
        untilMs: Long = 10_000,
    ) = (periodMs..untilMs step periodMs).toList()

    @Test
    fun `the UiDevice-style wait overshoots its timeout on a screen never quiet for 500 ms`() {
        // An event every 400 ms (a ticker): the 500 ms quiet window never
        // closes, and the wait sleeps toward it past its 100 ms timeout.
        val ua = FakeUiAutomation(events = every(400), now = 410)
        val spent =
            cost(ua) {
                try {
                    ua.waitForIdle(500, 100)
                } catch (_: TimeoutException) {
                }
            }
        assertTrue("spent $spent ms", spent > 300)
    }

    @Test
    fun `the settle check stops within twice its window on that screen`() {
        val ua = FakeUiAutomation(events = every(400), now = 410)
        val spent = cost(ua) { SettleIdle.await(ua, capMs = 100) }
        assertTrue("spent $spent ms", spent <= 2 * 100)
    }

    @Test
    fun `the quiet window never exceeds the cap`() {
        val ua = FakeUiAutomation(events = emptyList(), now = 10_000)
        SettleIdle.await(ua, capMs = 100)
        SettleIdle.await(ua, capMs = 37)
        assertEquals(listOf(100L to 100L, 37L to 37L), ua.requests)
    }

    @Test
    fun `a quiet screen returns at once and reports idle`() {
        val ua = FakeUiAutomation(events = listOf(100), now = 5_000)
        var idle = false
        val spent = cost(ua) { idle = SettleIdle.await(ua, capMs = 100) }
        assertEquals(0L, spent)
        assertTrue(idle)
    }

    @Test
    fun `a screen going quiet inside the window returns when it does`() {
        // Last event 30 ms ago and nothing after: quiet at 100 ms past it.
        val ua = FakeUiAutomation(events = listOf(1_000), now = 1_030)
        var idle = false
        val spent = cost(ua) { idle = SettleIdle.await(ua, capMs = 100) }
        assertEquals(70L, spent)
        assertTrue(idle)
    }

    @Test
    fun `an event every frame costs about the cap and reports not idle`() {
        val ua = FakeUiAutomation(events = every(16), now = 1_000)
        var idle = true
        val spent = cost(ua) { idle = SettleIdle.await(ua, capMs = 100) }
        assertFalse(idle)
        assertTrue("spent $spent ms", spent in 100L..116L)
    }

    @Test
    fun `the worst case, an event just before the cap, stays under twice the cap`() {
        // Last event long ago would be idle, so start just after one, with the
        // next one landing 1 ms before the timeout: the final sleep runs a
        // whole quiet window past the timeout.
        val ua = FakeUiAutomation(events = listOf(1_000, 1_099), now = 1_000)
        val spent = cost(ua) { SettleIdle.await(ua, capMs = 100) }
        assertEquals(199L, spent)
        assertTrue(spent < 2 * 100)
    }

    @Test
    fun `a timeout is swallowed, never thrown into the settle loop`() {
        val throwing = IdleWaiter { _, _ -> throw TimeoutException("no idle") }
        assertFalse(SettleIdle.await(throwing, capMs = 100))
    }

    @Test
    fun `no budget left means no wait at all`() {
        val ua = FakeUiAutomation(events = every(16), now = 1_000)
        assertFalse(SettleIdle.await(ua, capMs = 0))
        assertFalse(SettleIdle.await(ua, capMs = -5))
        assertTrue(ua.requests.isEmpty())
    }
}
