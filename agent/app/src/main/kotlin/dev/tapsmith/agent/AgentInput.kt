package dev.tapsmith.agent

import android.app.Instrumentation
import android.content.res.Resources
import android.util.DisplayMetrics
import android.util.Log
import android.view.KeyEvent
import android.view.ViewConfiguration
import android.view.accessibility.AccessibilityEvent
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.concurrent.TimeoutException

/**
 * The agent's input: UiDevice's and UiObject2's gestures and key presses,
 * made by [GestureInjector] so they skip WindowManager's animation wait
 * (PILOT-789). Each method keeps the UiAutomator call it replaces — shape,
 * timing, speeds, margins and return value — so only the wait changes.
 */
class AgentInput(
    private val device: UiDevice,
    private val instrumentation: Instrumentation,
) {
    companion object {
        private const val TAG = "TapsmithAction"

        // UiObject2's default speeds, in dp per second.
        private const val SCROLL_SPEED_DP = 1_500
        private const val DRAG_SPEED_DP = 2_500
        private const val PINCH_SPEED_DP = 1_000

        /** How long UiObject2.scroll waits for the scroll's events. */
        private const val SCROLL_TIMEOUT_MS = 1_000L

        /** UiObject2.scroll's pause before releasing, so the swipe does not fling. */
        private const val SCROLL_RELEASE_PAUSE_MS = 250L

        /** UiObject2.pinchClose's pause before releasing. */
        private const val PINCH_CLOSE_RELEASE_PAUSE_MS = 250L

        /** How long UiDevice.pressBack waits for the screen to change. */
        private const val KEY_PRESS_EVENT_TIMEOUT_MS = 500L
    }

    val gestures =
        GestureInjector(UiAutomationInputSink(instrumentation), AndroidGestureClock(), tickMs = { tick })

    private val tick: Long by lazy { gestureTickMs(instrumentation) }

    private val density: Float
        get() =
            Resources
                .getSystem()
                .displayMetrics.densityDpi
                .toFloat() / DisplayMetrics.DENSITY_DEFAULT

    private fun dpSpeed(dp: Int) = (dp * density).toInt().coerceAtLeast(1)

    /**
     * UiDevice.click: refused (false) for a point past the display's right or
     * bottom edge, otherwise a press held for [pressMs].
     */
    fun click(
        x: Int,
        y: Int,
        pressMs: Long = GestureInjector.CLICK_PRESS_MS,
    ): Boolean {
        if (x >= device.displayWidth || y >= device.displayHeight) {
            Log.w(TAG, "Cannot click ($x, $y): outside the display (${device.displayWidth}, ${device.displayHeight})")
            return false
        }
        return gestures.click(x, y, pressMs)
    }

    /**
     * A long press at ([x], [y]) held for [holdMs] of real time (PILOT-970).
     * Refused (false) for a point past the display's right or bottom edge, as
     * [click] is.
     */
    fun longPress(
        x: Int,
        y: Int,
        holdMs: Long,
    ): Boolean {
        if (x >= device.displayWidth || y >= device.displayHeight) {
            Log.w(TAG, "Cannot long press ($x, $y): outside the display (${device.displayWidth}, ${device.displayHeight})")
            return false
        }
        return gestures.longPress(x, y, holdMs)
    }

    /** A swipe between two screen points that lasts [durationMs] of real time (PILOT-970). */
    fun timedSwipe(
        x1: Int,
        y1: Int,
        x2: Int,
        y2: Int,
        durationMs: Long,
    ) = gestures.timedSwipe(x1, y1, x2, y2, durationMs)

    /** UiDevice.swipe: [steps] moves one frame apart, so it lasts [steps] frames, not a set time. */
    fun swipe(
        x1: Int,
        y1: Int,
        x2: Int,
        y2: Int,
        steps: Int,
    ): Boolean = gestures.stepSwipe(x1, y1, x2, y2, steps)

    /** UiDevice.pressKeyCode. */
    fun pressKey(keyCode: Int): Boolean = gestures.pressKey(keyCode)

    /** UiDevice.pressBack: press BACK and wait briefly for the screen to change. */
    fun pressBack(): Boolean {
        device.waitForIdle()
        var pressed = false
        try {
            instrumentation.uiAutomation.executeAndWaitForEvent(
                { pressed = gestures.pressKey(KeyEvent.KEYCODE_BACK) },
                { it.eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED },
                KEY_PRESS_EVENT_TIMEOUT_MS,
            )
        } catch (_: TimeoutException) {
            // The screen did not change in time; the press itself still went in.
        }
        return pressed
    }

    /** UiObject2.click: a press and an immediate release at the center of its visible bounds. */
    fun click(element: UiObject2) {
        gestures.perform(PointerPath(GestureGeometry.center(element.visibleBounds.toBox())))
    }

    /** UiObject2.swipe: over [percent] of the element less its margins, at [speedPxPerSec]. */
    fun swipe(
        element: UiObject2,
        direction: String,
        percent: Float,
        speedPxPerSec: Int,
    ) {
        require(percent in 0f..1f) { "Percent must be between 0.0f and 1.0f" }
        require(speedPxPerSec > 0) { "Speed must be positive" }
        val (start, end) = GestureGeometry.swipeRect(GestureGeometry.gestureArea(element.visibleBounds.toBox()), direction, percent)
        gestures.perform(PointerPath(start).moveTo(end, speedPxPerSec))
    }

    /**
     * UiObject2.scroll: swipe against [direction] over [percent] of the
     * element (repeated per whole element), waiting after each swipe for the
     * scroll's events. False once a swipe reaches the end (or nothing
     * scrolled); true if it can still scroll that way.
     */
    fun scroll(
        element: UiObject2,
        direction: Direction,
        percent: Float,
    ): Boolean {
        require(percent >= 0f) { "Percent must be greater than 0.0f" }
        val area = GestureGeometry.gestureArea(element.visibleBounds.toBox())
        val swipeDirection = Direction.reverse(direction).name
        var left = percent
        while (left > 0f) {
            val (start, end) = GestureGeometry.swipeRect(area, swipeDirection, minOf(left, 1f))
            val path = PointerPath(start).moveTo(end, dpSpeed(SCROLL_SPEED_DP)).pause(SCROLL_RELEASE_PAUSE_MS)
            val finished = Until.scrollFinished(direction)
            try {
                instrumentation.uiAutomation.executeAndWaitForEvent({ gestures.perform(path) }, finished, SCROLL_TIMEOUT_MS)
            } catch (_: TimeoutException) {
                // Judged by the condition's result below, as UiObject2 does.
            }
            if (finished.result != false) {
                if (finished.result == null) Log.i(TAG, "No scroll event received after scroll.")
                return false
            }
            left -= 1f
        }
        return true
    }

    /** UiObject2.drag: a long press on the element's center, then a move to [dest]. */
    fun drag(
        element: UiObject2,
        dest: ScreenPoint,
    ) {
        val hold = (ViewConfiguration.getLongPressTimeout() * 1.5f).toLong()
        val start = GestureGeometry.center(element.visibleBounds.toBox())
        gestures.perform(PointerPath(start).pause(hold).moveTo(dest, dpSpeed(DRAG_SPEED_DP)))
    }

    /** UiObject2.pinchOpen / pinchClose over [percent] of the element less its margins. */
    fun pinch(
        element: UiObject2,
        open: Boolean,
        percent: Float,
    ) {
        require(percent in 0f..1f) { "Percent must be between 0.0f and 1.0f" }
        val (blOuter, blInner, trOuter, trInner) =
            GestureGeometry.pinchPoints(GestureGeometry.gestureArea(element.visibleBounds.toBox()), percent)
        val speed = dpSpeed(PINCH_SPEED_DP)
        if (open) {
            gestures.perform(PointerPath(blInner).moveTo(blOuter, speed), PointerPath(trInner).moveTo(trOuter, speed))
        } else {
            gestures.perform(
                PointerPath(blOuter).moveTo(blInner, speed).pause(PINCH_CLOSE_RELEASE_PAUSE_MS),
                PointerPath(trOuter).moveTo(trInner, speed).pause(PINCH_CLOSE_RELEASE_PAUSE_MS),
            )
        }
    }
}
