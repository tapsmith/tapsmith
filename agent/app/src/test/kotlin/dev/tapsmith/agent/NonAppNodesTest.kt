package dev.tapsmith.agent

import android.view.accessibility.AccessibilityWindowInfo
import dev.tapsmith.agent.HierarchyAttributes.Box
import org.junit.Assert.assertEquals
import org.junit.Test

/** What no locator matches on Android (PILOT-756, PILOT-830). */
class NonAppNodesTest {
    private val systemUi = NonAppNodes.SYSTEM_UI_PACKAGE
    private val marker = "tapsmith-hooks:1;epoch=3;nav=2;boot=c0ffee42;url=myapp:///"

    // A 1080 x 2400 portrait display, and windows on it (measured on API 36).
    private val statusBar = Box(0, 0, 1080, 63)
    private val navBar = Box(0, 2274, 1080, 2400)
    private val landscapeNavBar = Box(2274, 0, 2400, 1080)
    private val fullScreen = Box(0, 0, 1080, 2400)
    private val keyboard = Box(0, 1517, 1080, 2400)

    private fun excludes(
        type: Int,
        bounds: Box,
        focused: Boolean = false,
        active: Boolean = false,
        packageName: String? = systemUi,
        displayWidth: Int = 1080,
        displayHeight: Int = 2400,
    ) = NonAppNodes.excludesWindow(type, focused, active, bounds, displayWidth, displayHeight) { packageName }

    @Test
    fun `the input method window never matches, focused or not`() {
        assertEquals(
            true,
            excludes(AccessibilityWindowInfo.TYPE_INPUT_METHOD, keyboard, packageName = "com.google.android.inputmethod.latin"),
        )
        assertEquals(true, excludes(AccessibilityWindowInfo.TYPE_INPUT_METHOD, keyboard, focused = true, active = true))
    }

    @Test
    fun `the status and navigation bars never match`() {
        assertEquals(true, excludes(AccessibilityWindowInfo.TYPE_SYSTEM, statusBar))
        assertEquals(true, excludes(AccessibilityWindowInfo.TYPE_SYSTEM, navBar))
        assertEquals(true, excludes(AccessibilityWindowInfo.TYPE_SYSTEM, landscapeNavBar, displayWidth = 2400, displayHeight = 1080))
    }

    @Test
    fun `a pulled-down notification shade (a focused, active system window) matches`() {
        assertEquals(false, excludes(AccessibilityWindowInfo.TYPE_SYSTEM, fullScreen, focused = true, active = true))
        assertEquals(false, excludes(AccessibilityWindowInfo.TYPE_SYSTEM, fullScreen, active = true))
    }

    @Test
    fun `a heads-up notification (System UI, unfocused, not a bar) matches`() {
        assertEquals(false, excludes(AccessibilityWindowInfo.TYPE_SYSTEM, fullScreen))
        assertEquals(false, excludes(AccessibilityWindowInfo.TYPE_SYSTEM, Box(0, 63, 1080, 700)))
    }

    @Test
    fun `application windows match, the app's own and another package's (a permission dialog)`() {
        assertEquals(false, excludes(AccessibilityWindowInfo.TYPE_APPLICATION, fullScreen, packageName = "com.example.app"))
        assertEquals(false, excludes(AccessibilityWindowInfo.TYPE_APPLICATION, statusBar))
    }

    @Test
    fun `bar-shaped system windows System UI does not own match - the app's overlay, the system's error dialogs`() {
        assertEquals(false, excludes(AccessibilityWindowInfo.TYPE_SYSTEM, statusBar, packageName = "com.example.app"))
        assertEquals(false, excludes(AccessibilityWindowInfo.TYPE_SYSTEM, statusBar, packageName = "android"))
        assertEquals(false, excludes(AccessibilityWindowInfo.TYPE_SYSTEM, statusBar, packageName = null))
    }

    @Test
    fun `a window with no size or an unknown display is not a bar`() {
        assertEquals(false, NonAppNodes.isBar(Box(0, 0, 0, 0), 1080, 2400))
        assertEquals(false, NonAppNodes.isBar(statusBar, 0, 0))
    }

    @Test
    fun `the hooks marker is recognised by its text or content description`() {
        assertEquals(true, NonAppNodes.isHooksMarker(marker, null))
        assertEquals(true, NonAppNodes.isHooksMarker(null, marker))
        assertEquals(false, NonAppNodes.isHooksMarker("Meeting at 10:06", ""))
        assertEquals(false, NonAppNodes.isHooksMarker("see tapsmith-hooks:1", null))
        assertEquals(false, NonAppNodes.isHooksMarker(null, null))
    }
}
