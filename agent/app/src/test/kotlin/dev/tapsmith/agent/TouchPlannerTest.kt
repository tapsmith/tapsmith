package dev.tapsmith.agent

import dev.tapsmith.agent.OcclusionAnalyzer.CoverKind
import dev.tapsmith.agent.OcclusionAnalyzer.WindowKind
import dev.tapsmith.agent.OcclusionAnalyzer.WindowSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Host-side tests for the covered-element wait loop (PILOT-362): how a touch
 * is planned across passes as covers come and go, when it is refused, and when
 * a focusing tap is skipped. Time is a fake clock that sleeping advances.
 */
class TouchPlannerTest {
    // ─── Fakes ───

    private class FakeClock(
        var nowMs: Long = 0,
    ) : GuardClock {
        val sleeps = mutableListOf<Long>()

        override fun now(): Long = nowMs

        override fun sleep(ms: Long) {
            sleeps.add(ms)
            nowMs += ms
        }
    }

    /** Windows as a function of time, so a cover can come and go. */
    private class FakeScreen(
        private val clock: FakeClock,
    ) : GuardScreen {
        var windowsAt: (Long) -> List<WindowSpec> = { listOf(APP) }
        override val bounds = SCREEN

        override fun windows(): List<WindowSpec> = windowsAt(clock.now())
    }

    /** Records drags, and moves the list's rows by what each one scrolls. */
    private class FakeScroller(
        private val clock: FakeClock,
    ) : GuardScroller {
        val drags = mutableListOf<CoverClearance.Drag>()
        var onDrag: (CoverClearance.Drag) -> Unit = {}
        override val margin = 20
        override val touchSlop = 16
        override val dragMs = 600L

        override fun drag(drag: CoverClearance.Drag) {
            drags.add(drag)
            clock.nowMs += dragMs
            onDrag(drag)
        }
    }

    private class Node(
        override var bounds: Box,
        override val drawingOrder: Int = 0,
        override val takesTouches: Boolean = false,
        private val name: String = "node",
        override val scrollsVertically: Boolean = false,
        override val isProgressIndicator: Boolean = false,
    ) : OcclusionAnalyzer.HitNode {
        override val isVisible = true
        var parentNode: Node? = null
        val children = mutableListOf<Node>()

        override fun parent(): OcclusionAnalyzer.HitNode? = parentNode

        override fun childCount() = children.size

        override fun child(index: Int): OcclusionAnalyzer.HitNode? = children.getOrNull(index)

        override fun sameAs(other: OcclusionAnalyzer.HitNode) = this === other

        override fun describe() = name

        fun add(vararg nodes: Node): Node {
            nodes.forEach {
                it.parentNode = this
                children.add(it)
            }
            return this
        }
    }

    /** A target read on each pass through [readAt] (null = unreadable). */
    private class FakeTarget(
        private val clock: FakeClock,
    ) : GuardTarget {
        var readAt: (Long) -> TargetSnapshot? = { snapshot(BUTTON) }
        var focused = false
        var reads = 0

        override fun read(): TargetSnapshot? {
            reads++
            return readAt(clock.now())
        }

        override fun isFocused() = focused

        override fun isInScrollView() = false
    }

    companion object {
        val SCREEN = Box(0, 0, 1080, 2400)
        val APP = WindowSpec(id = 1, kind = WindowKind.APPLICATION, layer = 0, bounds = SCREEN, title = "App")
        val KEYBOARD = WindowSpec(id = 2, kind = WindowKind.INPUT_METHOD, layer = 5, bounds = Box(0, 1500, 1080, 2400), title = null)
        val DIALOG = WindowSpec(id = 3, kind = WindowKind.APPLICATION, layer = 3, bounds = SCREEN, title = "Loading")

        /** A button low on screen, under the keyboard when it is up. */
        val LOW = Box(40, 2200, 1040, 2340)
        val BUTTON = Box(40, 780, 1040, 930)

        val LABELLED = TargetIdentity("android.widget.Button", null, "Save", null)
        val UNLABELLED = TargetIdentity("android.view.ViewGroup", null, null, null)

        fun snapshot(
            bounds: Box,
            node: OcclusionAnalyzer.HitNode? = null,
            contentDescription: String? = "Save",
            className: String = "android.widget.Button",
            content: String = "",
        ) = TargetSnapshot(
            node = node,
            windowId = 1,
            bounds = bounds,
            className = className,
            resourceId = null,
            contentDescription = contentDescription,
            text = null,
            isEditable = false,
            readContent = { content },
        )
    }

    private val clock = FakeClock()
    private val screen = FakeScreen(clock)
    private val target = FakeTarget(clock)
    private val scroller = FakeScroller(clock)
    private val planner = TouchPlanner(screen, clock, scroller)

    /** A 5 s action that arrived at t=0; the daemon waits timeout + 5 s. */
    private fun budget(
        timeoutMs: Long = 5_000,
        readDeadlineMs: Long? = timeoutMs + 5_000,
    ) = ActionBudget(startMs = 0, timeoutMs = timeoutMs, readDeadlineMs = readDeadlineMs, clock = clock)

    private fun keyboardUntil(ms: Long) {
        screen.windowsAt = { now -> if (now < ms) listOf(APP, KEYBOARD) else listOf(APP) }
    }

    private inline fun <reified T : Throwable> assertThrows(block: () -> Unit): T {
        try {
            block()
        } catch (e: Throwable) {
            if (e is T) return e
            throw AssertionError("expected ${T::class.simpleName}, got $e", e)
        }
        fail("expected ${T::class.simpleName}, nothing thrown")
        throw IllegalStateException()
    }

    // ─── plan: covers ───

    @Test
    fun `an uncovered element is touched at once`() {
        val plan = planner.plan(target, BUTTON, budget(), LABELLED)
        assertEquals(TouchPlan.Point(540, 855), plan)
        assertTrue(clock.sleeps.isEmpty())
    }

    @Test
    fun `a cover that clears within the budget is waited out`() {
        target.readAt = { snapshot(LOW) }
        keyboardUntil(600)
        val plan = planner.plan(target, LOW, budget(), LABELLED)
        assertEquals(TouchPlan.Point(540, 2270), plan)
        assertTrue("waited", clock.nowMs >= 600)
        assertTrue("polls at most every ${TouchPlanClock.POLL_MS}ms", clock.sleeps.all { it <= TouchPlanClock.POLL_MS })
    }

    @Test
    fun `a cover that outlasts the budget fails naming it, with how long it was waited out`() {
        target.readAt = { snapshot(LOW) }
        keyboardUntil(Long.MAX_VALUE)
        val e = assertThrows<ElementCoveredException> { planner.plan(target, LOW, budget(timeoutMs = 1_000), LABELLED) }
        assertEquals(CoverKind.KEYBOARD, e.kind)
        assertTrue(e.message, e.message!!.contains("covered by the keyboard"))
        assertTrue(e.message, e.message!!.contains("still covered after waiting 1000ms"))
        assertTrue(e.message, e.message!!.contains("device.hideKeyboard()"))
        assertEquals(1_000, clock.nowMs)
    }

    @Test
    fun `a single check waits for nothing and says so`() {
        target.readAt = { snapshot(LOW) }
        keyboardUntil(Long.MAX_VALUE)
        val e = assertThrows<ElementCoveredException> { planner.plan(target, LOW, budget().noWait(), LABELLED) }
        assertFalse(e.message, e.message!!.contains("after waiting"))
        assertTrue(clock.sleeps.isEmpty())
    }

    @Test
    fun `a same-screen control cover is named as a control`() {
        val covered = Node(BUTTON, drawingOrder = 1, takesTouches = true)
        val overlay = Node(BUTTON, drawingOrder = 2, takesTouches = true, name = "button \"Overlay\"")
        Node(SCREEN).add(covered, overlay)
        target.readAt = { snapshot(BUTTON, node = covered) }
        val e = assertThrows<ElementCoveredException> { planner.plan(target, BUTTON, budget().noWait(), LABELLED) }
        assertEquals(CoverKind.CONTROL, e.kind)
        assertTrue(e.message, e.message!!.contains("button \"Overlay\""))
    }

    // ─── plan: scrolling a target clear of fixed chrome (PILOT-980) ───

    /** A list (200..2400) of rows under a sticky footer button (2200..2400)
     *  outside the list; the target row starts at [rowTop]. A drag moves the
     *  rows by its length less the slop, at most by [maxScroll] in all. */
    private fun listUnderFooter(
        rowTop: Int,
        maxScroll: Int = Int.MAX_VALUE,
        footerTakesTouches: Boolean = true,
    ): Node {
        val row = Node(Box(0, rowTop, 1080, rowTop + 150), takesTouches = true, name = "row")
        val content = Node(Box(0, 200, 1080, 2400)).add(row)
        val list = Node(Box(0, 200, 1080, 2400), scrollsVertically = true).add(content)
        val footer = Node(Box(0, 2200, 1080, 2400), drawingOrder = 1, takesTouches = footerTakesTouches, name = "button \"Checkout\"")
        Node(SCREEN).add(list, footer)
        var scrolled = 0
        scroller.onDrag = { d ->
            val by = minOf(maxOf(0, (d.fromY - d.toY) - scroller.touchSlop), maxScroll - scrolled)
            scrolled += by
            row.bounds = Box(row.bounds.left, row.bounds.top - by, row.bounds.right, row.bounds.bottom - by)
        }
        target.readAt = { snapshot(row.bounds, node = row) }
        return row
    }

    @Test
    fun `a target under a sticky footer is dragged clear of it and touched`() {
        val row = listUnderFooter(rowTop = 2250)
        val plan = planner.plan(target, row.bounds, budget(), LABELLED)
        assertEquals(1, scroller.drags.size)
        assertEquals(Box(0, 2030, 1080, 2180), row.bounds)
        assertEquals(TouchPlan.Point(540, 2105), plan)
    }

    @Test
    fun `a list that scrolls less than asked gets a second drag`() {
        val row = listUnderFooter(rowTop = 2250, maxScroll = 100)
        // After two drags the row has moved 100 px: still under the footer.
        assertThrows<ElementCoveredException> { planner.plan(target, row.bounds, budget(timeoutMs = 3_000), LABELLED) }
        assertEquals(TouchPlanner.MAX_CLEAR_DRAGS, scroller.drags.size)
    }

    @Test
    fun `drags that do not move the target stop at the limit and the cover is reported`() {
        val row = listUnderFooter(rowTop = 2250, maxScroll = 0)
        val e = assertThrows<ElementCoveredException> { planner.plan(target, row.bounds, budget(timeoutMs = 3_000), LABELLED) }
        assertEquals(TouchPlanner.MAX_CLEAR_DRAGS, scroller.drags.size)
        assertTrue(e.message, e.message!!.contains("button \"Checkout\""))
    }

    @Test
    fun `an unlabelled row the list rebinds during the drag is not touched`() {
        val row = listUnderFooter(rowTop = 2250)
        // The row shows item 20 until the drag, then the view is rebound to
        // another item (a data update during the drag).
        target.readAt = {
            val item = if (scroller.drags.isEmpty()) "Item 20" else "Item 31"
            snapshot(row.bounds, node = row, contentDescription = null, className = "android.view.ViewGroup", content = item)
        }
        assertThrows<TargetChangedException> { planner.plan(target, row.bounds, budget(), UNLABELLED) }
    }

    @Test
    fun `a dropped first drag leaves the second to clear the target`() {
        val row = listUnderFooter(rowTop = 2250)
        val scrolls = scroller.onDrag
        scroller.onDrag = { d -> if (scroller.drags.size > 1) scrolls(d) }
        val plan = planner.plan(target, row.bounds, budget(), LABELLED)
        assertEquals(2, scroller.drags.size)
        assertEquals(TouchPlan.Point(540, 2105), plan)
    }

    @Test
    fun `a cover that is not a control is never dragged away from`() {
        // The keyboard over a row: the existing advice, no drag.
        val row = listUnderFooter(rowTop = 1600, footerTakesTouches = false)
        keyboardUntil(Long.MAX_VALUE)
        assertThrows<ElementCoveredException> { planner.plan(target, row.bounds, budget(timeoutMs = 1_000), LABELLED) }
        assertTrue(scroller.drags.isEmpty())
    }

    @Test
    fun `a loading overlay is waited out, never dragged away from`() {
        val row = Node(Box(0, 800, 1080, 950), takesTouches = true)
        val list = Node(Box(0, 200, 1080, 2400), scrollsVertically = true).add(Node(Box(0, 200, 1080, 2400)).add(row))
        val overlay = Node(Box(0, 700, 1080, 1100), drawingOrder = 1).add(Node(Box(490, 850, 590, 950), isProgressIndicator = true))
        Node(SCREEN).add(list, overlay)
        target.readAt = { snapshot(row.bounds, node = row) }
        val e = assertThrows<ElementCoveredException> { planner.plan(target, row.bounds, budget(timeoutMs = 1_000), LABELLED) }
        assertEquals(CoverKind.LOADING, e.kind)
        assertTrue(scroller.drags.isEmpty())
    }

    @Test
    fun `no drag is made without time left for it`() {
        val row = listUnderFooter(rowTop = 2250)
        assertThrows<ElementCoveredException> { planner.plan(target, row.bounds, budget(timeoutMs = 500), LABELLED) }
        assertTrue(scroller.drags.isEmpty())
    }

    @Test
    fun `a single check never drags`() {
        val row = listUnderFooter(rowTop = 2250)
        assertThrows<ElementCoveredException> { planner.plan(target, row.bounds, budget().noWait(), LABELLED) }
        assertTrue(scroller.drags.isEmpty())
    }

    @Test
    fun `a planner without a scroller waits as before`() {
        val row = listUnderFooter(rowTop = 2250)
        val plain = TouchPlanner(screen, clock, scroller = null)
        assertThrows<ElementCoveredException> { plain.plan(target, row.bounds, budget(timeoutMs = 1_000), LABELLED) }
        assertTrue(scroller.drags.isEmpty())
    }

    // ─── plan: too late ───

    @Test
    fun `a cover that clears too late to answer the daemon is not touched`() {
        // A 1 s hold after a cover that clears at 4.5 s: the daemon gives up
        // at 6 s, and the press plus its answer (1 s margin) would end at 6.5 s.
        target.readAt = { snapshot(LOW) }
        keyboardUntil(4_500)
        assertThrows<TouchTooLateException> {
            planner.plan(target, LOW, budget(timeoutMs = 5_000, readDeadlineMs = 6_000), LABELLED, reserveMs = 1_000)
        }
    }

    @Test
    fun `a cover still there at the deadline is reported as the cover, not as too late`() {
        // TAPSMITH_AGENT_READ_HEADROOM_MS=0: the read deadline is the budget.
        target.readAt = { snapshot(LOW) }
        keyboardUntil(Long.MAX_VALUE)
        assertThrows<ElementCoveredException> {
            planner.plan(target, LOW, budget(timeoutMs = 1_000, readDeadlineMs = 1_000), LABELLED)
        }
    }

    @Test
    fun `a gesture that could not finish in time is not started`() {
        clock.nowMs = 7_500
        assertThrows<TouchTooLateException> {
            planner.plan(target, BUTTON, budget(), LABELLED, reserveMs = 2_000)
        }
    }

    // ─── plan: off screen ───

    @Test
    fun `an element off screen for a moment is waited on, then touched`() {
        target.readAt = { now -> snapshot(if (now < 500) Box(0, 0, 0, 0) else BUTTON) }
        val plan = planner.plan(target, Box(0, 0, 0, 0), budget(), LABELLED)
        assertEquals(TouchPlan.Point(540, 855), plan)
    }

    @Test
    fun `an element that stays off screen is reported so at the deadline`() {
        target.readAt = { snapshot(Box(0, 2500, 100, 2600)) }
        assertEquals(TouchPlan.OffScreen, planner.plan(target, Box(0, 2500, 100, 2600), budget(timeoutMs = 1_000), LABELLED))
        assertEquals(1_000, clock.nowMs)
    }

    @Test
    fun `a single check reports off screen at once`() {
        target.readAt = { snapshot(Box(0, 2500, 100, 2600)) }
        assertEquals(TouchPlan.OffScreen, planner.plan(target, Box(0, 2500, 100, 2600), budget().noWait(), LABELLED))
        assertTrue(clock.sleeps.isEmpty())
    }

    // ─── plan: identity ───

    @Test
    fun `a node already showing another element is not touched`() {
        target.readAt = { snapshot(BUTTON, contentDescription = "Replacement") }
        assertThrows<TargetChangedException> { planner.plan(target, BUTTON, budget(), LABELLED) }
    }

    @Test
    fun `a node that turns into another element while its cover is waited out is not touched`() {
        target.readAt = { now -> snapshot(LOW, contentDescription = if (now < 300) "Save" else "Replacement") }
        keyboardUntil(1_000)
        assertThrows<TargetChangedException> { planner.plan(target, LOW, budget(), LABELLED) }
    }

    @Test
    fun `an unlabelled container whose content changes during a cover wait is not touched`() {
        val unlabelled = { content: String ->
            snapshot(LOW, contentDescription = null, className = "android.view.ViewGroup", content = content)
        }
        target.readAt = { now -> unlabelled(if (now < 300) "Covered action" else "Replacement action") }
        keyboardUntil(1_000)
        assertThrows<TargetChangedException> { planner.plan(target, LOW, budget(), UNLABELLED) }
    }

    @Test
    fun `an unlabelled container whose content stays the same is touched once uncovered`() {
        target.readAt = { snapshot(LOW, contentDescription = null, className = "android.view.ViewGroup", content = "Covered action") }
        keyboardUntil(600)
        assertEquals(TouchPlan.Point(540, 2270), planner.plan(target, LOW, budget(), UNLABELLED))
    }

    @Test
    fun `an unlabelled container reused while it is off screen is not touched`() {
        target.readAt = { now ->
            snapshot(
                if (now < 500) Box(0, 0, 0, 0) else BUTTON,
                contentDescription = null,
                className = "android.view.ViewGroup",
                content = if (now < 300) "Covered action" else "Replacement action",
            )
        }
        assertThrows<TargetChangedException> { planner.plan(target, Box(0, 0, 0, 0), budget(), UNLABELLED) }
    }

    // ─── plan: bounds ───

    @Test
    fun `the first pass uses the resolved bounds and later passes read them live`() {
        // Resolved under the keyboard; a keyboard-avoiding view then lifts it.
        target.readAt = { now -> snapshot(if (now == 0L) Box(0, 0, 10, 10) else Box(40, 1300, 1040, 1400)) }
        keyboardUntil(Long.MAX_VALUE)
        assertEquals(TouchPlan.Point(540, 1350), planner.plan(target, LOW, budget(), LABELLED))
    }

    @Test
    fun `an unreadable target still gets the window checks, at its resolved bounds`() {
        target.readAt = { null }
        keyboardUntil(600)
        assertEquals(TouchPlan.Point(540, 2270), planner.plan(target, LOW, budget(), LABELLED))
    }

    // ─── planFocusTap ───

    @Test
    fun `a focused field under its own keyboard is not tapped`() {
        target.readAt = { snapshot(LOW) }
        target.focused = true
        keyboardUntil(Long.MAX_VALUE)
        assertNull(planner.planFocusTap(target, LOW, budget(), LABELLED, reserveMs = 1_000))
        assertTrue("no waiting", clock.sleeps.isEmpty())
    }

    @Test
    fun `a focused field under a control on its own screen is not tapped`() {
        val field = Node(BUTTON, drawingOrder = 1, takesTouches = true)
        Node(SCREEN).add(field, Node(BUTTON, drawingOrder = 2, takesTouches = true))
        target.readAt = { snapshot(BUTTON, node = field) }
        target.focused = true
        assertNull(planner.planFocusTap(target, BUTTON, budget(), LABELLED, reserveMs = 1_000))
    }

    @Test
    fun `a focused field under a dialog window is waited out like any cover`() {
        // The dialog takes the input, so skipping the tap would type into
        // nothing the user could reach.
        target.readAt = { snapshot(BUTTON) }
        target.focused = true
        screen.windowsAt = { listOf(APP, DIALOG) }
        val e =
            assertThrows<ElementCoveredException> {
                planner.planFocusTap(target, BUTTON, budget(timeoutMs = 1_000), LABELLED, reserveMs = 0)
            }
        assertEquals(CoverKind.WINDOW, e.kind)
        assertEquals(1_000, clock.nowMs)
    }

    @Test
    fun `an unfocused covered field waits for its cover, then is tapped`() {
        target.readAt = { snapshot(LOW) }
        keyboardUntil(600)
        assertEquals(TouchPlan.Point(540, 2270), planner.planFocusTap(target, LOW, budget(), LABELLED, reserveMs = 1_000))
    }

    @Test
    fun `a skipped focusing tap still needs time for the work after it`() {
        target.readAt = { snapshot(LOW) }
        target.focused = true
        keyboardUntil(Long.MAX_VALUE)
        clock.nowMs = 8_500
        assertThrows<TouchTooLateException> { planner.planFocusTap(target, LOW, budget(), LABELLED, reserveMs = 1_000) }
    }

    @Test
    fun `a focusing tap on a field off screen for a moment waits for it`() {
        target.readAt = { now -> snapshot(if (now < 500) Box(0, 0, 0, 0) else BUTTON) }
        assertEquals(TouchPlan.Point(540, 855), planner.planFocusTap(target, Box(0, 0, 0, 0), budget(), LABELLED, reserveMs = 1_000))
    }

    @Test
    fun `a focusing tap with no time left is a single check`() {
        target.readAt = { snapshot(LOW) }
        keyboardUntil(Long.MAX_VALUE)
        clock.nowMs = 5_000
        assertThrows<ElementCoveredException> { planner.planFocusTap(target, LOW, budget(), LABELLED, reserveMs = 0) }
        assertTrue(clock.sleeps.isEmpty())
    }

    // ─── requireTimeFor / ActionBudget ───

    @Test
    fun `work is refused once it could not finish before the daemon gives up`() {
        clock.nowMs = 3_000
        planner.requireTimeFor(budget(), reserveMs = 3_500)
        clock.nowMs = 6_000
        assertThrows<TouchTooLateException> { planner.requireTimeFor(budget(), reserveMs = 3_500) }
    }

    @Test
    fun `a budget counts from the command's arrival`() {
        val b = budget(timeoutMs = 5_000)
        clock.nowMs = 2_000
        assertEquals(3_000, b.remainingMs)
        assertTrue(b.hasTimeLeft)
        clock.nowMs = 5_000
        assertFalse(b.hasTimeLeft)
    }

    @Test
    fun `a no-wait budget keeps the read deadline and waits for nothing`() {
        clock.nowMs = 2_000
        val b = budget().noWait()
        assertEquals(0, b.timeoutMs)
        assertEquals(2_000, b.startMs)
        assertEquals(10_000L, b.readDeadlineMs)
    }

    @Test
    fun `a shortened budget leaves room for a gesture after the wait`() {
        assertEquals(3_000, budget(timeoutMs = 5_000).shortenedBy(2_000).timeoutMs)
        assertEquals(0, budget(timeoutMs = 1_000).shortenedBy(5_000).timeoutMs)
    }

    // ─── plan: abandoned command (PILOT-605) ───

    @Test
    fun `an abandoned command does not touch an uncovered element`() {
        val token = CommandCancellation()
        token.cancel("the daemon closed the connection")
        assertThrows<CommandCancelledException> {
            CommandCancellation.runWith(token) { planner.plan(target, BUTTON, budget(), LABELLED) }
        }
        assertEquals("nothing is read for a command nobody waits for", 0, target.reads)
    }

    @Test
    fun `a command abandoned while a cover is waited out stops waiting and does not touch`() {
        target.readAt = { snapshot(LOW) }
        keyboardUntil(600)
        val token = CommandCancellation()
        // The daemon gives up during the wait, before the cover clears.
        val cancellingClock =
            object : GuardClock {
                override fun now() = clock.now()

                override fun sleep(ms: Long) {
                    clock.sleep(ms)
                    token.cancel("the daemon closed the connection")
                }
            }
        val cancellingPlanner = TouchPlanner(screen, cancellingClock, scroller = null)
        assertThrows<CommandCancelledException> {
            CommandCancellation.runWith(token) { cancellingPlanner.plan(target, LOW, budget(), LABELLED) }
        }
        assertTrue("stopped at the first pass after the cancel", clock.nowMs < 600)
    }

    @Test
    fun `a command abandoned during the last pass's reads does not touch`() {
        val token = CommandCancellation()
        // The element is clear, but the daemon gives up while it is read.
        target.readAt = {
            token.cancel("the daemon closed the connection")
            snapshot(BUTTON)
        }
        assertThrows<CommandCancelledException> {
            CommandCancellation.runWith(token) { planner.plan(target, BUTTON, budget(), LABELLED) }
        }
        assertEquals(1, target.reads)
    }
}
