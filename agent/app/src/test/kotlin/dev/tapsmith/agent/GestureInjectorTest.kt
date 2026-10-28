package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-side tests for the agent's own gestures (PILOT-789): every tap, swipe,
 * multi-pointer gesture and key press reaches the [InputSink] as single
 * events with UiAutomator 2.4's shapes and timing, and nothing is left
 * pressed when the input system refuses an event.
 */
class GestureInjectorTest {
    // ─── Fakes ───

    private class FakeClock : GestureClock {
        var nowMs = 1_000L
        var frames = 0

        override fun now(): Long = nowMs

        override fun sleep(ms: Long) {
            nowMs += ms
        }

        override fun waitForNextFrame() {
            frames++
            nowMs += 16
        }
    }

    /** Records every event with the time it was sent; refuses the ones [refuse] picks. */
    private class FakeSink(
        private val clock: FakeClock,
        private val refuse: (TouchEvent) -> Boolean = { false },
        private val refuseKey: (KeyPress) -> Boolean = { false },
    ) : InputSink {
        val touches = mutableListOf<Pair<Long, TouchEvent>>()
        val keys = mutableListOf<KeyPress>()

        override fun touch(event: TouchEvent): Boolean {
            touches += clock.nowMs to event
            return !refuse(event)
        }

        override fun key(event: KeyPress): Boolean {
            keys += event
            return !refuseKey(event)
        }

        fun actions() = touches.map { it.second.action }
    }

    private val clock = FakeClock()

    private fun injector(sink: FakeSink) = GestureInjector(sink, clock) { 8L }

    // ─── click ───

    @Test
    fun `click presses, holds and releases at one point, waiting for the app`() {
        val sink = FakeSink(clock)
        assertTrue(injector(sink).click(10, 20))
        assertEquals(listOf(TouchAction.DOWN, TouchAction.UP), sink.actions())
        val (downAt, down) = sink.touches[0]
        val (upAt, up) = sink.touches[1]
        assertEquals(GestureInjector.CLICK_PRESS_MS, upAt - downAt)
        assertEquals(down.downTime, up.downTime)
        assertEquals(listOf(PointerState(0, 10, 20)), up.pointers)
        assertTrue(down.sync && up.sync)
    }

    @Test
    fun `click holds for the press time it is given`() {
        val sink = FakeSink(clock)
        injector(sink).click(1, 1, pressMs = 50)
        assertEquals(50L, sink.touches[1].first - sink.touches[0].first)
    }

    @Test
    fun `a refused release is cancelled so no pointer stays down`() {
        val sink = FakeSink(clock, refuse = { it.action == TouchAction.UP })
        assertFalse(injector(sink).click(5, 5))
        assertEquals(listOf(TouchAction.DOWN, TouchAction.UP, TouchAction.CANCEL), sink.actions())
    }

    @Test
    fun `a refused press is still released, and the click reports failure`() {
        val sink = FakeSink(clock, refuse = { it.action == TouchAction.DOWN })
        assertFalse(injector(sink).click(5, 5))
        assertEquals(listOf(TouchAction.DOWN, TouchAction.UP), sink.actions())
    }

    // ─── stepSwipe (UiDevice.swipe) ───

    @Test
    fun `step swipe moves along the line one frame apart and releases at the end`() {
        val sink = FakeSink(clock)
        assertTrue(injector(sink).stepSwipe(0, 0, 40, 80, steps = 4))
        assertEquals(
            listOf(TouchAction.DOWN, TouchAction.MOVE, TouchAction.MOVE, TouchAction.MOVE, TouchAction.UP),
            sink.actions(),
        )
        assertEquals(
            listOf(0 to 0, 10 to 20, 20 to 40, 30 to 60, 40 to 80),
            sink.touches.map {
                it.second.pointers
                    .single()
                    .let { p -> p.x to p.y }
            },
        )
        assertEquals(4, clock.frames)
        assertTrue(sink.touches.all { it.second.sync })
        assertEquals(
            1,
            sink.touches
                .map { it.second.downTime }
                .toSet()
                .size,
        )
    }

    @Test
    fun `step swipe with zero steps is a press and a release`() {
        val sink = FakeSink(clock)
        injector(sink).stepSwipe(0, 0, 100, 0, steps = 0)
        assertEquals(listOf(TouchAction.DOWN, TouchAction.UP), sink.actions())
    }

    @Test
    fun `step swipe from a point to itself holds there for one frame per step - a long press`() {
        val sink = FakeSink(clock)
        injector(sink).stepSwipe(7, 9, 7, 9, steps = 5)
        assertEquals(5, clock.frames)
        assertTrue(sink.touches.all { it.second.pointers.single() == PointerState(0, 7, 9) })
    }

    @Test
    fun `a refused move stops the swipe but still releases`() {
        var moves = 0
        val sink = FakeSink(clock, refuse = { it.action == TouchAction.MOVE && ++moves == 2 })
        assertFalse(injector(sink).stepSwipe(0, 0, 50, 0, steps = 5))
        assertEquals(
            listOf(TouchAction.DOWN, TouchAction.MOVE, TouchAction.MOVE, TouchAction.UP),
            sink.actions(),
        )
    }

    @Test
    fun `a refused press skips the moves but still releases`() {
        val sink = FakeSink(clock, refuse = { it.action == TouchAction.DOWN })
        assertFalse(injector(sink).stepSwipe(0, 0, 50, 0, steps = 5))
        assertEquals(listOf(TouchAction.DOWN, TouchAction.UP), sink.actions())
    }

    // ─── perform (UiObject2 gestures) ───

    @Test
    fun `a timed click presses then releases one tick later without waiting for the app`() {
        val sink = FakeSink(clock)
        injector(sink).perform(PointerPath(ScreenPoint(3, 4)))
        assertEquals(listOf(TouchAction.DOWN, TouchAction.UP), sink.actions())
        assertEquals(8L, sink.touches[1].first - sink.touches[0].first)
        assertTrue(sink.touches.none { it.second.sync })
    }

    @Test
    fun `a timed swipe moves at its speed and ends exactly at its end point`() {
        val sink = FakeSink(clock)
        // 100 px at 1000 px/s = 100 ms.
        injector(sink).perform(PointerPath(ScreenPoint(0, 500)).moveTo(ScreenPoint(0, 400), 1000))
        val events = sink.touches.map { it.second }
        assertEquals(TouchAction.DOWN, events.first().action)
        assertEquals(PointerState(0, 0, 500), events.first().pointers.single())
        assertEquals(TouchAction.UP, events.last().action)
        assertEquals(PointerState(0, 0, 400), events.last().pointers.single())
        val moves = events.filter { it.action == TouchAction.MOVE }.map { it.pointers.single().y }
        assertEquals(moves.sortedDescending(), moves)
        // DOWN at tick 0, moves every 8 ms while the path runs, UP on the first tick past 100 ms.
        assertEquals(104L, sink.touches.last().first - sink.touches.first().first)
        assertEquals(1, events.map { it.downTime }.toSet().size)
    }

    @Test
    fun `a drag holds still before it moves`() {
        val sink = FakeSink(clock)
        injector(sink).perform(PointerPath(ScreenPoint(10, 10)).pause(600).moveTo(ScreenPoint(110, 10), 1000))
        val holding =
            sink.touches.filter { (at, e) -> e.action == TouchAction.MOVE && at - sink.touches.first().first < 600 }
        assertTrue(holding.isNotEmpty())
        assertTrue(holding.all { it.second.pointers.single() == PointerState(0, 10, 10) })
        assertEquals(
            PointerState(0, 110, 10),
            sink.touches
                .last()
                .second.pointers
                .single(),
        )
    }

    @Test
    fun `a pinch presses both pointers, moves them together and lifts the first to finish first`() {
        val sink = FakeSink(clock)
        val a = PointerPath(ScreenPoint(0, 100)).moveTo(ScreenPoint(40, 60), 1000).pause(250)
        val b = PointerPath(ScreenPoint(100, 0)).moveTo(ScreenPoint(60, 40), 1000)
        injector(sink).perform(a, b)
        val events = sink.touches.map { it.second }
        assertEquals(TouchAction.DOWN, events[0].action)
        assertEquals(1, events[0].pointers.size)
        assertEquals(TouchAction.POINTER_DOWN, events[1].action)
        assertEquals(1, events[1].actionIndex)
        assertEquals(listOf(0, 1), events[1].pointers.map { it.id })
        // b (no pause) ends first: lifted as pointer index 1 at its end point.
        val lift = events.first { it.action == TouchAction.POINTER_UP }
        assertEquals(1, lift.actionIndex)
        assertEquals(PointerState(1, 60, 40), lift.pointers[1])
        val last = events.last()
        assertEquals(TouchAction.UP, last.action)
        assertEquals(listOf(PointerState(0, 40, 60)), last.pointers)
    }

    @Test
    fun `a pointer with a delay goes down later`() {
        val sink = FakeSink(clock)
        injector(sink).perform(PointerPath(ScreenPoint(0, 0)).pause(100), PointerPath(ScreenPoint(50, 50), delayMs = 40))
        val second = sink.touches.first { it.second.action == TouchAction.POINTER_DOWN }
        assertEquals(40L, second.first - sink.touches.first().first)
    }

    // ─── keys ───

    @Test
    fun `a key press is a down then an up at one time`() {
        val sink = FakeSink(clock)
        assertTrue(injector(sink).pressKey(66))
        assertEquals(listOf(true, false), sink.keys.map { it.down })
        assertEquals(listOf(66, 66), sink.keys.map { it.keyCode })
        assertEquals(
            1,
            sink.keys
                .map { it.time }
                .toSet()
                .size,
        )
        assertEquals(listOf(0, 0), sink.keys.map { it.metaState })
    }

    @Test
    fun `a modifier key carries its own meta state`() {
        val sink = FakeSink(clock)
        injector(sink).pressKey(59) // SHIFT_LEFT
        assertEquals(listOf(0x41, 0x41), sink.keys.map { it.metaState })
    }

    @Test
    fun `a refused key press sends no release`() {
        val sink = FakeSink(clock, refuseKey = { it.down })
        assertFalse(injector(sink).pressKey(4))
        assertEquals(1, sink.keys.size)
    }

    @Test
    fun `a streamed touch is sent without waiting for the app`() {
        val sink = FakeSink(clock)
        injector(sink).streamTouch(TouchAction.MOVE, 77, 1, 2)
        val e = sink.touches.single().second
        assertFalse(e.sync)
        assertEquals(77L, e.downTime)
    }

    // ─── geometry (UiObject2's) ───

    @Test
    fun `gesture area is the bounds less ten percent on each side`() {
        assertEquals(Box(110, 220, 190, 380), GestureGeometry.gestureArea(Box(100, 200, 200, 400)))
    }

    @Test
    fun `swipe rect starts at the edge it swipes from`() {
        val area = Box(0, 0, 100, 200)
        assertEquals(ScreenPoint(50, 200) to ScreenPoint(50, 100), GestureGeometry.swipeRect(area, "up", 0.5f))
        assertEquals(ScreenPoint(50, 0) to ScreenPoint(50, 100), GestureGeometry.swipeRect(area, "down", 0.5f))
        assertEquals(ScreenPoint(100, 100) to ScreenPoint(25, 100), GestureGeometry.swipeRect(area, "left", 0.75f))
        assertEquals(ScreenPoint(0, 100) to ScreenPoint(100, 100), GestureGeometry.swipeRect(area, "right", 1f))
    }

    @Test
    fun `pinch points run from the corners toward the centre`() {
        assertEquals(
            listOf(ScreenPoint(0, 200), ScreenPoint(25, 150), ScreenPoint(100, 0), ScreenPoint(75, 50)),
            GestureGeometry.pinchPoints(Box(0, 0, 100, 200), 0.5f),
        )
    }
}
