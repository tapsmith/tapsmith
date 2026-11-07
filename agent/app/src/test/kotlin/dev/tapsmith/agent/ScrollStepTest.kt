package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** scrollIntoView()'s one-call scroll step (PILOT-998). */
class ScrollStepTest {
    /** A device whose finds return [finds] in turn; records what was done. */
    private class FakeDevice(
        finds: List<List<String>>,
        /** Events "arrive" at these times. */
        private val changes: List<Long> = emptyList(),
        private val scrolled: Boolean? = true,
    ) : ScrollStepDevice<String> {
        var nowMs = 0L
        val log = mutableListOf<String>()
        private val pending = finds.toMutableList()

        override fun now() = nowMs

        override fun waitForQuiet(
            quietMs: Long,
            capMs: Long,
        ) {
            log += "quiet $quietMs/$capMs"
            nowMs += 50
        }

        override fun find(): List<String> {
            log += "find"
            nowMs += 30
            return if (pending.size > 1) pending.removeAt(0) else pending.single()
        }

        override fun dragList() {
            log += "drag"
            nowMs += 100
        }

        override fun lastChangeAt() = changes.lastOrNull { it <= nowMs } ?: -1L

        override fun scrolledUnderFingerSince(since: Long) = scrolled
    }

    private val visible = { s: String -> s.startsWith("visible") }

    @Test
    fun `a step drags, waits for quiet, then finds`() {
        val d = FakeDevice(listOf(listOf("visible row")))
        val r = ScrollStep.run(d, findFirst = false, isVisible = visible)
        assertEquals(listOf("drag", "quiet 120/500", "find"), d.log)
        assertTrue(r.swiped)
        assertEquals(true, r.moved)
        assertEquals(listOf("visible row"), r.elements)
    }

    @Test
    fun `the first step confirms the first miss and does not drag for an element on screen`() {
        val d = FakeDevice(listOf(listOf("visible row")))
        val r = ScrollStep.run(d, findFirst = true, isVisible = visible)
        assertEquals(listOf("quiet 500/300", "find"), d.log)
        assertFalse(r.swiped)
        assertNull(r.moved)
    }

    @Test
    fun `the first step drags once its confirming find misses`() {
        val d = FakeDevice(listOf(emptyList(), listOf("visible row")))
        val r = ScrollStep.run(d, findFirst = true, isVisible = visible)
        assertEquals(listOf("quiet 500/300", "find", "drag", "quiet 120/500", "find"), d.log)
        assertTrue(r.swiped)
    }

    @Test
    fun `an element in the tree but off screen does not stop the first step's drag`() {
        val d = FakeDevice(listOf(listOf("hidden row"), listOf("visible row")))
        val r = ScrollStep.run(d, findFirst = true, isVisible = visible)
        assertTrue(r.swiped)
        assertEquals(listOf("visible row"), r.elements)
    }

    @Test
    fun `a miss on a quiet screen is trusted`() {
        val d = FakeDevice(listOf(emptyList()))
        val r = ScrollStep.run(d, findFirst = false, isVisible = visible)
        assertEquals(listOf("drag", "quiet 120/500", "find", "quiet 120/500"), d.log)
        assertEquals(0, r.refinds)
        assertTrue(r.elements.isEmpty())
    }

    @Test
    fun `a miss while the screen changed is found again, at most twice`() {
        // The find starts at 150 and 230; events keep arriving after each.
        val d = FakeDevice(listOf(emptyList()), changes = listOf(200L, 300L, 400L))
        val r = ScrollStep.run(d, findFirst = false, isVisible = visible)
        assertEquals(ScrollStep.MAX_REFINDS, r.refinds)
        assertEquals(1 + ScrollStep.MAX_REFINDS, d.log.count { it == "find" })
    }

    @Test
    fun `a refind that sees the row ends the step`() {
        val d = FakeDevice(listOf(emptyList(), listOf("visible row")), changes = listOf(200L))
        val r = ScrollStep.run(d, findFirst = false, isVisible = visible)
        assertEquals(1, r.refinds)
        assertEquals(listOf("visible row"), r.elements)
    }

    @Test
    fun `whether the list moved comes from the device, and may be unknown`() {
        assertEquals(false, ScrollStep.run(FakeDevice(listOf(emptyList()), scrolled = false), false, visible).moved)
        assertNull(ScrollStep.run(FakeDevice(listOf(emptyList()), scrolled = null), false, visible).moved)
    }

    // ─── ScrollContainerPick ───

    private fun box(
        l: Int,
        t: Int,
        r: Int,
        b: Int,
    ) = HierarchyAttributes.Box(l, t, r, b)

    private val screen = box(0, 0, 1080, 2400)

    private fun cand(
        window: Int,
        b: HierarchyAttributes.Box,
        order: Int,
        ancestors: Set<Int> = emptySet(),
    ) = ScrollContainerPick.Candidate(window, b, order, ancestors)

    @Test
    fun `picks the largest scrollable on screen`() {
        val r =
            ScrollContainerPick.pick(
                screen,
                listOf(screen),
                listOf(cand(0, box(0, 300, 1080, 500), 1), cand(0, box(0, 600, 1080, 2200), 2)),
                emptyList(),
            )
        assertEquals(box(0, 600, 1080, 2200), r)
    }

    @Test
    fun `nothing scrolls, so nothing is picked`() {
        assertNull(ScrollContainerPick.pick(screen, listOf(screen), emptyList(), emptyList()))
        // Too small to drag in.
        assertNull(ScrollContainerPick.pick(screen, listOf(screen), listOf(cand(0, box(0, 0, 40, 2000), 1)), emptyList()))
    }

    @Test
    fun `a dialog's list wins over the screen's behind it`() {
        val dialog = box(100, 800, 980, 1600)
        val r =
            ScrollContainerPick.pick(
                screen,
                listOf(screen, dialog),
                listOf(cand(0, box(0, 200, 1080, 2400), 1), cand(1, box(100, 900, 980, 1500), 5)),
                emptyList(),
            )
        assertEquals(box(100, 900, 980, 1500), r)
    }

    @Test
    fun `a scrollable another covers at its centre is passed over, unless it is that one's ancestor`() {
        val behind = cand(0, box(0, 0, 1080, 2400), 1)
        val over = cand(0, box(0, 1000, 1080, 1400), 7)
        assertEquals(box(0, 1000, 1080, 1400), ScrollContainerPick.pick(screen, listOf(screen), listOf(behind, over), emptyList()))
        val nested = cand(0, box(0, 1000, 1080, 1400), 7, ancestors = setOf(1))
        assertEquals(box(0, 0, 1080, 2400), ScrollContainerPick.pick(screen, listOf(screen), listOf(behind, nested), emptyList()))
    }

    @Test
    fun `a keyboard or bar across an edge is trimmed off`() {
        val r =
            ScrollContainerPick.pick(
                screen,
                listOf(screen),
                listOf(cand(0, box(0, 0, 1080, 2400), 1)),
                listOf(box(0, 0, 1080, 80), box(0, 1500, 1080, 2400)),
            )
        assertEquals(box(0, 80, 1080, 1500), r)
    }

    @Test
    fun `a cover that crosses only part of an edge is not trimmed`() {
        assertEquals(
            box(0, 0, 1080, 2400),
            ScrollContainerPick.trimEdge(box(0, 0, 1080, 2400), box(100, 2000, 500, 2400)),
        )
    }

    @Test
    fun `the region is clipped to the screen and its window`() {
        val window = box(0, 100, 1080, 2300)
        val r = ScrollContainerPick.pick(screen, listOf(window), listOf(cand(0, box(-50, 0, 1200, 3000), 1)), emptyList())
        assertEquals(box(0, 100, 1080, 2300), r)
    }
}
