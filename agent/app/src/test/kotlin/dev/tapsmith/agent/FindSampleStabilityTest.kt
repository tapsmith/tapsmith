package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Host-side tests for the stability check an id-addressed tap runs against
 * the bounds the find that resolved the id read (Playwright's "same box in
 * two reads two frames apart", with the find as the first read).
 */
class FindSampleStabilityTest {
    private data class Box(
        val left: Int,
        val top: Int,
        val right: Int,
        val bottom: Int,
    ) {
        val isEmpty get() = right <= left || bottom <= top
    }

    /** A virtual clock: sleeping advances it; each read costs [readCostMs]. */
    private class Clock(
        var now: Long,
        private val readCostMs: Long = 0,
    ) {
        val sleeps = mutableListOf<Long>()
        val readsAt = mutableListOf<Long>()

        fun sleep(ms: Long) {
            sleeps += ms
            now += ms
        }

        fun <B> read(value: B): B {
            readsAt += now
            now += readCostMs
            return value
        }
    }

    private val box = Box(10, 100, 210, 148)

    private fun check(
        clock: Clock,
        sample: FindSample<Box>,
        current: Box,
    ) = FindSampleStability.check(sample, { it.isEmpty }, { clock.now }, clock::sleep) { clock.read(current) }

    @Test
    fun `same bounds two frames after the find are stable, read once`() {
        val clock = Clock(now = 1_010)
        val result = check(clock, FindSample(box, readAtMs = 1_000), box)
        assertEquals(SampleCheck.Stable(box), result)
        assertEquals(listOf(1_034L), clock.readsAt)
    }

    @Test
    fun `a tap that comes sooner than two frames after the find waits out the rest`() {
        val clock = Clock(now = 1_005)
        check(clock, FindSample(box, readAtMs = 1_000), box)
        assertEquals(listOf(29L), clock.sleeps)
    }

    @Test
    fun `a tap that comes later than two frames after the find does not wait`() {
        val clock = Clock(now = 1_400)
        val result = check(clock, FindSample(box, readAtMs = 1_000), box)
        assertEquals(SampleCheck.Stable(box), result)
        assertEquals(emptyList<Long>(), clock.sleeps)
        assertEquals(listOf(1_400L), clock.readsAt)
    }

    @Test
    fun `bounds that moved since the find are reported as moved, with the read the caller continues from`() {
        val clock = Clock(now = 1_000)
        val moved = box.copy(top = 130, bottom = 178)
        val result = check(clock, FindSample(box, readAtMs = 1_000), moved)
        assertEquals(SampleCheck.Moved(moved), result)
        assertEquals(1, clock.readsAt.size)
    }

    @Test
    fun `empty bounds are never stable, even when the find read the same`() {
        val empty = Box(0, 0, 0, 0)
        val result = check(Clock(now = 2_000), FindSample(empty, readAtMs = 1_000), empty)
        assertEquals(SampleCheck.Moved(empty), result)
    }
}
