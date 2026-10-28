package dev.tapsmith.agent

import android.app.Instrumentation
import android.app.UiAutomation
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
import android.view.Display
import android.view.InputDevice
import android.view.InputEvent
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.test.uiautomator.Configurator
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Injects the agent's input events through UiAutomation without waiting for
 * window animations where the platform allows it (PILOT-789; see
 * GestureInjector.kt for why).
 *
 * API 31 added `UiAutomation.injectInputEvent(event, sync, waitForAnimations)`
 * as a @TestApi. Instrumentation started by `am instrument` may call test APIs
 * by default, so it is looked up by reflection once; the public two-argument
 * overload (which always waits) is the fallback. Either way a press, release
 * or key that takes longer than WindowManager's animation timeout is logged
 * with the likely cause.
 */
class UiAutomationInputSink(
    private val instrumentation: Instrumentation,
) : InputSink {
    companion object {
        private const val TAG = "TapsmithAction"

        private fun findNoWaitOverload(): Method? {
            if (Build.VERSION.SDK_INT < InjectMode.FIRST_NO_WAIT_API) return null
            return try {
                UiAutomation::class.java.getMethod(
                    "injectInputEvent",
                    InputEvent::class.java,
                    Boolean::class.javaPrimitiveType,
                    Boolean::class.javaPrimitiveType,
                )
            } catch (e: Exception) {
                // NoSuchMethodException when the hidden-API policy hides it.
                Log.w(TAG, "UiAutomation.injectInputEvent(event, sync, waitForAnimations) is not reachable", e)
                null
            }
        }
    }

    @Volatile private var noWaitOverload: Method? = findNoWaitOverload()

    @Volatile var mode: InjectMode = InjectMode.choose(Build.VERSION.SDK_INT, noWaitOverload != null)
        private set

    init {
        Log.i(TAG, "input injection: ${mode.description} (API ${Build.VERSION.SDK_INT})")
    }

    override fun touch(event: TouchEvent): Boolean {
        val properties =
            Array(event.pointers.size) { i ->
                MotionEvent.PointerProperties().apply {
                    id = event.pointers[i].id
                    toolType = Configurator.getInstance().toolType
                }
            }
        val coords =
            Array(event.pointers.size) { i ->
                MotionEvent.PointerCoords().apply {
                    x = event.pointers[i].x.toFloat()
                    y = event.pointers[i].y.toFloat()
                    pressure = 1f
                    size = 1f
                }
            }
        val action =
            when (event.action) {
                TouchAction.DOWN -> MotionEvent.ACTION_DOWN
                TouchAction.MOVE -> MotionEvent.ACTION_MOVE
                TouchAction.UP -> MotionEvent.ACTION_UP
                TouchAction.CANCEL -> MotionEvent.ACTION_CANCEL
                TouchAction.POINTER_DOWN ->
                    MotionEvent.ACTION_POINTER_DOWN or (event.actionIndex shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
                TouchAction.POINTER_UP ->
                    MotionEvent.ACTION_POINTER_UP or (event.actionIndex shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
            }
        val motion =
            MotionEvent.obtain(
                event.downTime,
                SystemClock.uptimeMillis(),
                action,
                properties.size,
                properties,
                coords,
                0,
                0,
                1f,
                1f,
                0,
                0,
                InputDevice.SOURCE_TOUCHSCREEN,
                0,
            )
        return try {
            inject(motion, event.sync, event.action.name)
        } finally {
            motion.recycle()
        }
    }

    override fun key(event: KeyPress): Boolean {
        val key =
            KeyEvent(
                event.time,
                event.time,
                if (event.down) KeyEvent.ACTION_DOWN else KeyEvent.ACTION_UP,
                event.keyCode,
                0,
                event.metaState,
                KeyCharacterMap.VIRTUAL_KEYBOARD,
                0,
                0,
                InputDevice.SOURCE_KEYBOARD,
            )
        return inject(key, sync = true, what = "key ${KeyEvent.keyCodeToString(event.keyCode)} ${if (event.down) "down" else "up"}")
    }

    private fun inject(
        event: InputEvent,
        sync: Boolean,
        what: String,
    ): Boolean {
        val uiAutomation = instrumentation.uiAutomation
        val start = SystemClock.uptimeMillis()
        val overload = noWaitOverload
        val ok =
            if (overload != null) {
                try {
                    overload.invoke(uiAutomation, event, sync, false) as Boolean
                } catch (e: InvocationTargetException) {
                    // The injection itself threw; the two-argument call would too.
                    throw e.cause ?: e
                } catch (e: Exception) {
                    // Refused by reflection after all: inject the public way from now on.
                    Log.w(TAG, "Cannot inject without waiting for window animations; falling back", e)
                    noWaitOverload = null
                    mode = InjectMode.WAITS_FOR_ANIMATIONS
                    uiAutomation.injectInputEvent(event, sync)
                }
            } else {
                uiAutomation.injectInputEvent(event, sync)
            }
        InjectMode.slowInjectWarning(mode, what, SystemClock.uptimeMillis() - start)?.let { Log.w(TAG, it) }
        return ok
    }
}

/** The real clock: uptime, sleeps that a cancelled command cuts short, and display frames. */
class AndroidGestureClock : GestureClock {
    override fun now(): Long = SystemClock.uptimeMillis()

    override fun sleep(ms: Long) {
        if (ms > 0) SystemClock.sleep(ms)
    }

    /** UiAutomator's waitForNextFrame: a Choreographer frame on the main looper, at most 5 s. */
    override fun waitForNextFrame() {
        val latch = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post {
            Choreographer.getInstance().postFrameCallback { latch.countDown() }
        }
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) Log.w("TapsmithAction", "Timed out waiting for a display frame")
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }
}

/** UiAutomator's timed-gesture event interval: half a frame at the display's highest refresh rate. */
fun gestureTickMs(instrumentation: Instrumentation): Long =
    try {
        val display =
            instrumentation.context
                .getSystemService(DisplayManager::class.java)
                .getDisplay(Display.DEFAULT_DISPLAY)
        val maxRate = display.supportedRefreshRates.maxOrNull() ?: 0f
        if (maxRate > 0f) (500 / maxRate).toLong().coerceAtLeast(1) else GestureInjector.DEFAULT_TICK_MS
    } catch (e: Exception) {
        GestureInjector.DEFAULT_TICK_MS
    }
