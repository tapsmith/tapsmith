package dev.tapsmith.agent

/*
 * Every touch and key the agent makes goes through [GestureInjector] (PILOT-789).
 *
 * UiAutomator injects with UiAutomation.injectInputEvent(event, sync), which on
 * API 30+ makes WindowManager wait for every window animation to finish before
 * each DOWN and after each UP (and each key's DOWN and UP), whatever `sync` is.
 * A window animation that never ends (a starting window's reveal stuck on a
 * slow software-GPU emulator) then costs ~5 s per event, ~10 s per tap. The
 * agent cannot change how UiAutomator injects — UiAutomation is final and
 * UiAutomator calls it directly — so it makes the gestures itself, with the
 * same shapes and timing UiAutomator 2.4 uses, through an [InputSink] that
 * injects without that wait where the platform allows it
 * ([UiAutomationInputSink]).
 *
 * Nothing here touches Android, so the JVM tests drive it with a fake sink and
 * clock.
 */

/** A screen position in pixels. */
data class ScreenPoint(
    val x: Int,
    val y: Int,
)

/** The kind of a touch event, as MotionEvent's action without the pointer index. */
enum class TouchAction { DOWN, POINTER_DOWN, MOVE, POINTER_UP, UP, CANCEL }

/** One pointer of a touch event: its id and where it is. */
data class PointerState(
    val id: Int,
    val x: Int,
    val y: Int,
)

/**
 * One touch event to inject. [pointers] are all the pointers down at that
 * moment, in MotionEvent index order; [actionIndex] is the index (into
 * [pointers]) of the pointer a POINTER_DOWN or POINTER_UP is about. [sync]
 * asks the input system to wait until the app has handled the event.
 */
data class TouchEvent(
    val action: TouchAction,
    val downTime: Long,
    val pointers: List<PointerState>,
    val actionIndex: Int = 0,
    val sync: Boolean,
)

/** One key event to inject: a press ([down]) or a release. */
data class KeyPress(
    val keyCode: Int,
    val down: Boolean,
    val metaState: Int,
    val time: Long,
)

/** Where the agent's input events go. True when the input system accepted the event. */
interface InputSink {
    fun touch(event: TouchEvent): Boolean

    fun key(event: KeyPress): Boolean
}

/** The time source and waits a gesture is paced by. */
interface GestureClock {
    fun now(): Long

    fun sleep(ms: Long)

    /** Wait until the next display frame, as UiAutomator's step swipes do. */
    fun waitForNextFrame()
}

/**
 * The path one pointer follows, from touch down to release: a start point,
 * then pauses and straight moves. UiAutomator's PointerGesture, with the
 * same duration and interpolation arithmetic.
 */
class PointerPath(
    start: ScreenPoint,
    /** Time after the gesture starts before this pointer goes down. */
    val delayMs: Long = 0,
) {
    private class Segment(
        val from: ScreenPoint,
        val to: ScreenPoint,
        val durationMs: Long,
    )

    private val segments = mutableListOf(Segment(start, start, 0))

    /** How long the pointer stays down. */
    var durationMs: Long = 0
        private set

    val start: ScreenPoint get() = segments.first().from
    val end: ScreenPoint get() = segments.last().to

    init {
        require(delayMs >= 0) { "delayMs cannot be negative" }
    }

    /** Hold still for [ms]. */
    fun pause(ms: Long): PointerPath {
        require(ms >= 0) { "pause cannot be negative" }
        add(Segment(end, end, ms))
        return this
    }

    /** Move in a straight line to [dest] at [speedPxPerSec]. */
    fun moveTo(
        dest: ScreenPoint,
        speedPxPerSec: Int,
    ): PointerPath {
        require(speedPxPerSec > 0) { "speed must be positive" }
        val dx = (dest.x - end.x).toDouble()
        val dy = (dest.y - end.y).toDouble()
        add(Segment(end, dest, (1000 * Math.sqrt(dx * dx + dy * dy) / speedPxPerSec).toLong()))
        return this
    }

    /**
     * Move in a straight line to [dest] over [durationMs], whatever the
     * distance (a coordinate swipe's `duration`; PILOT-970).
     */
    fun travelTo(
        dest: ScreenPoint,
        durationMs: Long,
    ): PointerPath {
        require(durationMs >= 0) { "duration cannot be negative" }
        add(Segment(end, dest, durationMs))
        return this
    }

    private fun add(segment: Segment) {
        segments += segment
        durationMs += segment.durationMs
    }

    /** Where the pointer is [timeMs] after the gesture started. */
    fun pointAt(timeMs: Long): ScreenPoint {
        var t = timeMs - delayMs
        for (s in segments) {
            if (t < s.durationMs) {
                val f = t.toFloat() / s.durationMs
                return ScreenPoint(s.from.x + (f * (s.to.x - s.from.x)).toInt(), s.from.y + (f * (s.to.y - s.from.y)).toInt())
            }
            t -= s.durationMs
        }
        return end
    }
}

/** Where UiAutomator's UiObject2 gestures put their pointers. */
object GestureGeometry {
    /** UiObject2's default gesture margin: 10 % of the bounds on each side. */
    const val MARGIN_FRACTION = 0.1f

    /** The part of [bounds] a UiObject2 gesture uses: the bounds less the margins. */
    fun gestureArea(bounds: Box): Box =
        Box(
            bounds.left + (bounds.width * MARGIN_FRACTION).toInt(),
            bounds.top + (bounds.height * MARGIN_FRACTION).toInt(),
            bounds.right - (bounds.width * MARGIN_FRACTION).toInt(),
            bounds.bottom - (bounds.height * MARGIN_FRACTION).toInt(),
        )

    /** Start and end of a swipe [direction] ("up", "down", "left", "right") over [percent] of [area]. */
    fun swipeRect(
        area: Box,
        direction: String,
        percent: Float,
    ): Pair<ScreenPoint, ScreenPoint> {
        val cx = (area.left + area.right) shr 1
        val cy = (area.top + area.bottom) shr 1
        return when (direction.lowercase()) {
            "left" -> ScreenPoint(area.right, cy) to ScreenPoint(area.right - (area.width * percent).toInt(), cy)
            "right" -> ScreenPoint(area.left, cy) to ScreenPoint(area.left + (area.width * percent).toInt(), cy)
            "up" -> ScreenPoint(cx, area.bottom) to ScreenPoint(cx, area.bottom - (area.height * percent).toInt())
            "down" -> ScreenPoint(cx, area.top) to ScreenPoint(cx, area.top + (area.height * percent).toInt())
            else -> throw IllegalArgumentException("Unknown direction: $direction")
        }
    }

    /**
     * The [pinchPoints] percent for a pinch whose fingers' end distance is
     * [scale] times their start distance (PILOT-825, the iOS agent's meaning):
     * closing (below 1) ends at 1 − percent of the outer distance, opening
     * (above 1) starts there. Kept within 0.1–0.9 so the fingers always move
     * and never start or end on the same point.
     */
    fun pinchPercent(scale: Float): Float {
        val percent = if (scale > 1f) 1f - 1f / scale else 1f - scale
        return percent.coerceIn(0.1f, 0.9f)
    }

    /**
     * The two pointers' outer and inner points for a pinch over [percent] of
     * [area]: bottom-left and top-right corners, and those moved toward the
     * centre. Returned as (bottomLeftOuter, bottomLeftInner, topRightOuter, topRightInner).
     */
    fun pinchPoints(
        area: Box,
        percent: Float,
    ): List<ScreenPoint> {
        val offsetX = (area.width / 2 * percent).toInt()
        val offsetY = (area.height / 2 * percent).toInt()
        val bottomLeft = ScreenPoint(area.left, area.bottom)
        val topRight = ScreenPoint(area.right, area.top)
        return listOf(
            bottomLeft,
            ScreenPoint(bottomLeft.x + offsetX, bottomLeft.y - offsetY),
            topRight,
            ScreenPoint(topRight.x - offsetX, topRight.y + offsetY),
        )
    }

    /** Center of [bounds], as Rect.centerX/centerY compute it. */
    fun center(bounds: Box): ScreenPoint = ScreenPoint((bounds.left + bounds.right) shr 1, (bounds.top + bounds.bottom) shr 1)
}

/**
 * Makes taps, swipes, multi-pointer gestures and key presses out of single
 * input events, the way UiAutomator 2.4 does, and sends them to [sink].
 */
class GestureInjector(
    private val sink: InputSink,
    private val clock: GestureClock,
    /** The interval between a timed gesture's events (UiAutomator: half a frame
     *  at the display's highest refresh rate). */
    private val tickMs: () -> Long = { DEFAULT_TICK_MS },
) {
    companion object {
        /** How long a click holds the pointer down (UiAutomator's REGULAR_CLICK_LENGTH). */
        const val CLICK_PRESS_MS = 100L

        /** A timed gesture's event interval when the display's refresh rate is unknown. */
        const val DEFAULT_TICK_MS = 8L

        /** Key codes that set modifier meta state while they are held, as UiAutomator sends them. */
        private val KEY_MODIFIERS =
            mapOf(
                59 to (0x40 or 0x1), // SHIFT_LEFT → META_SHIFT_LEFT_ON | META_SHIFT_ON
                60 to (0x80 or 0x1), // SHIFT_RIGHT
                57 to (0x10 or 0x2), // ALT_LEFT → META_ALT_LEFT_ON | META_ALT_ON
                58 to (0x20 or 0x2), // ALT_RIGHT
                63 to 0x4, // SYM → META_SYM_ON
                119 to 0x8, // FUNCTION → META_FUNCTION_ON
                113 to (0x2000 or 0x1000), // CTRL_LEFT → META_CTRL_LEFT_ON | META_CTRL_ON
                114 to (0x4000 or 0x1000), // CTRL_RIGHT
                117 to 0x20000, // META_LEFT → META_META_LEFT_ON
                118 to 0x40000, // META_RIGHT → META_META_RIGHT_ON
                115 to 0x100000, // CAPS_LOCK → META_CAPS_LOCK_ON
            )
    }

    private fun single(
        action: TouchAction,
        downTime: Long,
        x: Int,
        y: Int,
        sync: Boolean,
    ) = sink.touch(TouchEvent(action, downTime, listOf(PointerState(0, x, y)), sync = sync))

    /**
     * Press and release one pointer at ([x], [y]), held for [pressMs]. The
     * release is sent even when the press was refused (the input system may
     * have delivered it anyway), and a refused release is followed by a cancel,
     * so no pointer is left down. True only when both went through.
     */
    fun click(
        x: Int,
        y: Int,
        pressMs: Long = CLICK_PRESS_MS,
    ): Boolean {
        val downTime = clock.now()
        val downOk = single(TouchAction.DOWN, downTime, x, y, sync = true)
        clock.sleep(pressMs)
        val upOk = single(TouchAction.UP, downTime, x, y, sync = true)
        if (!upOk) single(TouchAction.CANCEL, downTime, x, y, sync = true)
        return downOk && upOk
    }

    /**
     * A long press: press at ([x], [y]), hold for [holdMs] of real time, and
     * release (PILOT-970). Not a step swipe from the point to itself: each
     * step waits for a display frame, so `holdMs / 5` steps held ~3x as long
     * as asked at 60 Hz, and longer still on a slow emulator. Refusals are
     * handled as [click] handles them, so no pointer is left down.
     */
    fun longPress(
        x: Int,
        y: Int,
        holdMs: Long,
    ): Boolean = click(x, y, holdMs)

    /**
     * A swipe from ([x1], [y1]) to ([x2], [y2]) that lasts [durationMs] of real
     * time (PILOT-970): a timed gesture ([perform]), with moves every tick,
     * rather than [stepSwipe]'s one move per display frame.
     */
    fun timedSwipe(
        x1: Int,
        y1: Int,
        x2: Int,
        y2: Int,
        durationMs: Long,
    ) = perform(PointerPath(ScreenPoint(x1, y1)).travelTo(ScreenPoint(x2, y2), durationMs))

    /**
     * UiDevice.swipe: press at the start, [steps] - 1 moves along the line one
     * frame apart, release at the end. A refused event stops the moves, but the
     * pointer is still released. A swipe from a point to itself is a long press.
     */
    fun stepSwipe(
        x1: Int,
        y1: Int,
        x2: Int,
        y2: Int,
        steps: Int,
    ): Boolean {
        val n = steps.coerceAtLeast(1)
        val xStep = (x2 - x1).toDouble() / n
        val yStep = (y2 - y1).toDouble() / n
        val downTime = clock.now()
        var ok = single(TouchAction.DOWN, downTime, x1, y1, sync = true)
        clock.waitForNextFrame()
        for (i in 1 until n) {
            if (!ok) break
            ok = single(TouchAction.MOVE, downTime, x1 + (xStep * i).toInt(), y1 + (yStep * i).toInt(), sync = true)
            clock.waitForNextFrame()
        }
        val upOk = single(TouchAction.UP, downTime, x2, y2, sync = true)
        return ok && upOk
    }

    /**
     * Play one or more pointer paths together, as UiAutomator's
     * GestureController does: on each tick, release the pointers whose path
     * has ended, move the rest, and press the ones whose delay has come.
     * Events are injected without waiting for the app (as there), so a long
     * gesture keeps its speed on a busy device.
     */
    fun perform(vararg paths: PointerPath) {
        require(paths.isNotEmpty()) { "a gesture needs at least one pointer" }
        val ids = paths.withIndex().associate { (i, p) -> p to i }
        val position = paths.associateWith { it.start }.toMutableMap()
        val down = mutableListOf<PointerPath>()
        val pending = paths.sortedBy { it.delayMs }.toMutableList()
        val startTime = clock.now()
        val tick = tickMs().coerceAtLeast(1)

        fun pointers() = down.map { p -> position.getValue(p).let { PointerState(ids.getValue(p), it.x, it.y) } }

        fun inject(
            action: TouchAction,
            index: Int = 0,
        ) = sink.touch(TouchEvent(action, startTime, pointers(), index, sync = false))

        var elapsed = 0L
        while (pending.isNotEmpty() || down.isNotEmpty()) {
            while (true) {
                val done = down.minByOrNull { it.delayMs + it.durationMs } ?: break
                if (elapsed <= done.delayMs + done.durationMs) break
                position[done] = done.end
                for (other in down) if (other !== done) position[other] = other.pointAt(elapsed)
                val index = down.indexOf(done)
                inject(if (down.size > 1) TouchAction.POINTER_UP else TouchAction.UP, index)
                down.removeAt(index)
            }
            for (p in down) position[p] = p.pointAt(elapsed)
            if (down.isNotEmpty()) inject(TouchAction.MOVE)
            while (pending.isNotEmpty() && elapsed >= pending.first().delayMs) {
                val p = pending.removeAt(0)
                down += p
                inject(if (down.size > 1) TouchAction.POINTER_DOWN else TouchAction.DOWN, down.size - 1)
            }
            clock.sleep(tick)
            // Paced by the clock, as UiAutomator's GestureController is: a
            // sleep that overruns, or a slow injection, does not stretch the
            // gesture past its duration (PILOT-970).
            elapsed = clock.now() - startTime
        }
    }

    /**
     * Press and release [keyCode], as UiDevice.pressKeyCode does. A modifier
     * key carries its own meta state while it is down.
     */
    fun pressKey(
        keyCode: Int,
        metaState: Int = 0,
    ): Boolean {
        val time = clock.now()
        val modifier = KEY_MODIFIERS[keyCode] ?: 0
        if (!sink.key(KeyPress(keyCode, down = true, metaState = metaState or modifier, time = time))) return false
        return sink.key(KeyPress(keyCode, down = false, metaState = metaState or modifier, time = time))
    }

    /** One event of a streamed touch (the interactive mirror's live drag), sent without waiting for the app. */
    fun streamTouch(
        action: TouchAction,
        downTime: Long,
        x: Int,
        y: Int,
    ): Boolean = single(action, downTime, x, y, sync = false)
}
