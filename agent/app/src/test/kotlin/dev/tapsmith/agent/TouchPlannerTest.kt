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

    private class FakeClock(var nowMs: Long = 0) : GuardClock {
        val sleeps = mutableListOf<Long>()

        override fun now(): Long = nowMs

        override fun sleep(ms: Long) {
            sleeps.add(ms)
            nowMs += ms
        }
    }

    /** Windows as a function of time, so a cover can come and go. */
    private class FakeScreen(private val clock: FakeClock) : GuardScreen {
        var windowsAt: (Long) -> List<WindowSpec> = { listOf(APP) }
        override val bounds = SCREEN

        override fun windows(): List<WindowSpec> = windowsAt(clock.now())
    }

    private class Node(
        override val bounds: Box,
        override val drawingOrder: Int = 0,
        override val takesTouches: Boolean = false,
        private val name: String = "node",
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
    private class FakeTarget(private val clock: FakeClock) : GuardTarget {
        var readAt: (Long) -> TargetSnapshot? = { snapshot(BUTTON) }
        var focused = false
        var reads = 0

        override fun read(): TargetSnapshot? {
            reads++
            return readAt(clock.now())
        }

        override fun isFocused() = focused
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
    private val planner = TouchPlanner(screen, clock)

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
        val unlabelled = {
                content: String ->
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
}
