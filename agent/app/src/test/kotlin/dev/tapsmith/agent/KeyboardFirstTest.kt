package dev.tapsmith.agent

import dev.tapsmith.agent.OcclusionAnalyzer.WindowKind
import dev.tapsmith.agent.OcclusionAnalyzer.WindowSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-side tests for the keyboard-first step (PILOT-622): when a touch on an
 * element puts the soft keyboard away before it lands, and how long it waits
 * for the keyboard to go. Time is a fake clock that sleeping advances.
 */
class KeyboardFirstTest {
    // ─── Fakes ───

    private class FakeClock(var nowMs: Long = 0) : GuardClock {
        override fun now(): Long = nowMs

        override fun sleep(ms: Long) {
            nowMs += ms
        }
    }

    /** The keyboard window is listed while [keyboardUp] says so. */
    private class FakeScreen(private val keyboard: FakeKeyboard) : GuardScreen {
        var windowReads = 0
        override val bounds = SCREEN

        override fun windows(): List<WindowSpec> {
            windowReads++
            return if (keyboard.windowListed()) listOf(APP, KEYBOARD) else listOf(APP)
        }
    }

    /** A keyboard that leaves [leavesAfterMs] after Back (null: never). */
    private class FakeKeyboard(private val clock: FakeClock) : GuardKeyboard {
        var up = true
        var reportsShown = true
        var leavesAfterMs: Long? = 120
        var dismissals = 0
        var shownChecks = 0
        private var dismissedAt: Long? = null

        fun windowListed(): Boolean {
            val at = dismissedAt
            val leave = leavesAfterMs
            if (at != null && leave != null && clock.now() - at >= leave) up = false
            return up
        }

        override fun isShown(): Boolean {
            shownChecks++
            return reportsShown && windowListed()
        }

        override fun dismiss() {
            dismissals++
            dismissedAt = clock.now()
        }
    }

    private class FakeTarget(
        var snapshot: TargetSnapshot? = snapshot(),
        var inScrollView: Boolean = true,
    ) : GuardTarget {
        var scrollChecks = 0

        override fun read(): TargetSnapshot? = snapshot

        override fun isFocused() = false

        override fun isInScrollView(): Boolean {
            scrollChecks++
            return inScrollView
        }
    }

    companion object {
        val SCREEN = Box(0, 0, 1080, 2400)
        val APP = WindowSpec(id = 1, kind = WindowKind.APPLICATION, layer = 0, bounds = SCREEN, title = "App")
        val KEYBOARD = WindowSpec(id = 2, kind = WindowKind.INPUT_METHOD, layer = 5, bounds = Box(0, 1500, 1080, 2400), title = null)

        fun snapshot(
            isEditable: Boolean = false,
            windowId: Int = 1,
        ) = TargetSnapshot(
            node = null,
            windowId = windowId,
            bounds = Box(40, 780, 1040, 930),
            className = if (isEditable) "android.widget.EditText" else "android.view.ViewGroup",
            resourceId = null,
            contentDescription = "Sign in",
            text = null,
            isEditable = isEditable,
            readContent = { "" },
        )
    }

    private val clock = FakeClock()
    private val keyboard = FakeKeyboard(clock)
    private val screen = FakeScreen(keyboard)
    private val target = FakeTarget()
    private val step = KeyboardFirst(screen, keyboard, clock)

    private fun budget(timeoutMs: Long = 5_000) = ActionBudget(clock.now(), timeoutMs, clock.now() + timeoutMs + 5_000, clock)

    // ─── When it applies ───

    @Test
    fun `puts the keyboard away before touching a button in a scroll view`() {
        assertTrue(step.putAwayIfItWouldEatTheTouch(target, budget()))
        assertEquals(1, keyboard.dismissals)
        assertFalse("keyboard gone", keyboard.up)
    }

    @Test
    fun `waits for the keyboard window to go, then lets the app settle`() {
        keyboard.leavesAfterMs = 300
        step.putAwayIfItWouldEatTheTouch(target, budget())
        // Gone at 300 ms (polled), then the settle.
        assertTrue(clock.nowMs >= 300 + KeyboardFirst.SETTLE_MS)
        assertTrue(clock.nowMs < 300 + KeyboardFirst.POLL_MS + KeyboardFirst.SETTLE_MS + 1)
    }

    // ─── When it does not ───

    @Test
    fun `no keyboard window - nothing pressed, no slow checks`() {
        keyboard.up = false
        assertFalse(step.putAwayIfItWouldEatTheTouch(target, budget()))
        assertEquals(0, keyboard.dismissals)
        assertEquals(0, keyboard.shownChecks)
        assertEquals(0, target.scrollChecks)
    }

    @Test
    fun `a text input keeps the keyboard - focus moves to it`() {
        target.snapshot = snapshot(isEditable = true)
        assertFalse(step.putAwayIfItWouldEatTheTouch(target, budget()))
        assertEquals(0, keyboard.dismissals)
    }

    @Test
    fun `an element outside any scroll view is touched with the keyboard up`() {
        target.inScrollView = false
        assertFalse(step.putAwayIfItWouldEatTheTouch(target, budget()))
        assertEquals(0, keyboard.dismissals)
    }

    @Test
    fun `an element in the keyboard's own window is not a reason to dismiss it`() {
        target.snapshot = snapshot(windowId = KEYBOARD.id)
        assertFalse(step.putAwayIfItWouldEatTheTouch(target, budget()))
        assertEquals(0, keyboard.dismissals)
    }

    @Test
    fun `an unreadable target is touched as before`() {
        target.snapshot = null
        assertFalse(step.putAwayIfItWouldEatTheTouch(target, budget()))
        assertEquals(0, keyboard.dismissals)
    }

    @Test
    fun `never presses Back unless the input method says the keyboard is shown`() {
        // The window is still listed while the keyboard animates away, and
        // Back with no keyboard up would navigate the app back.
        keyboard.reportsShown = false
        assertFalse(step.putAwayIfItWouldEatTheTouch(target, budget()))
        assertEquals(0, keyboard.dismissals)
    }

    @Test
    fun `no time left before the daemon gives up - touched as before`() {
        val spent = budget(1_000)
        clock.nowMs = 6_000
        assertFalse(step.putAwayIfItWouldEatTheTouch(target, spent))
        assertEquals(0, keyboard.dismissals)
    }

    @Test
    fun `a tap that may not wait for its element (timeout 0, as MCP sends) still puts the keyboard away`() {
        assertTrue(step.putAwayIfItWouldEatTheTouch(target, budget(0)))
        assertEquals(1, keyboard.dismissals)
    }

    @Test
    fun `only React Native's scroll views count - native lists, pagers and web views do not`() {
        assertTrue(KeyboardFirst.isScrollContainer("android.widget.ScrollView"))
        assertTrue(KeyboardFirst.isScrollContainer("android.widget.HorizontalScrollView"))
        for (name in listOf(
            "android.widget.ListView",
            "androidx.recyclerview.widget.RecyclerView",
            "android.webkit.WebView",
            "androidx.viewpager.widget.ViewPager",
            null,
        )) {
            assertFalse(name ?: "null", KeyboardFirst.isScrollContainer(name))
        }
    }

    // ─── A keyboard that will not go ───

    @Test
    fun `a keyboard that stays is waited on within a bound, once`() {
        keyboard.leavesAfterMs = null
        val start = clock.nowMs
        // Still reports true: bounds moved or not, the caller re-reads them.
        assertTrue(step.putAwayIfItWouldEatTheTouch(target, budget()))
        assertEquals(1, keyboard.dismissals)
        assertTrue(clock.nowMs - start <= KeyboardFirst.MAX_WAIT_MS + KeyboardFirst.POLL_MS + KeyboardFirst.SETTLE_MS)
    }

    @Test
    fun `the wait leaves at least half the daemon's remaining time for the touch`() {
        keyboard.leavesAfterMs = null
        val start = clock.nowMs
        // Read deadline 1 s away: wait at most 500 ms.
        step.putAwayIfItWouldEatTheTouch(target, ActionBudget(clock.now(), 0, clock.now() + 1_000, clock))
        assertTrue(clock.nowMs - start <= 500 + KeyboardFirst.POLL_MS)
    }
}
