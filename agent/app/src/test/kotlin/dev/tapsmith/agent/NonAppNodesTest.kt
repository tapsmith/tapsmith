package dev.tapsmith.agent

import android.view.accessibility.AccessibilityWindowInfo
import org.junit.Assert.assertEquals
import org.junit.Test

/** What no locator matches on Android (PILOT-756, PILOT-830). */
class NonAppNodesTest {
    private val systemUi = NonAppNodes.SYSTEM_UI_PACKAGE
    private val marker = "tapsmith-hooks:1;epoch=3;nav=2;boot=c0ffee42;url=myapp:///"

    @Test
    fun `the input method window never matches, focused or not`() {
        assertEquals(
            true,
            NonAppNodes.excludesWindow(AccessibilityWindowInfo.TYPE_INPUT_METHOD, focused = false, active = false, packageName = systemUi),
        )
        assertEquals(
            true,
            NonAppNodes.excludesWindow(AccessibilityWindowInfo.TYPE_INPUT_METHOD, focused = true, active = true, packageName = systemUi),
        )
    }

    @Test
    fun `the status and navigation bars (unfocused, inactive system windows) never match`() {
        assertEquals(
            true,
            NonAppNodes.excludesWindow(AccessibilityWindowInfo.TYPE_SYSTEM, focused = false, active = false, packageName = systemUi),
        )
    }

    @Test
    fun `a pulled-down notification shade (a focused, active system window) matches`() {
        assertEquals(
            false,
            NonAppNodes.excludesWindow(AccessibilityWindowInfo.TYPE_SYSTEM, focused = true, active = true, packageName = systemUi),
        )
        assertEquals(
            false,
            NonAppNodes.excludesWindow(AccessibilityWindowInfo.TYPE_SYSTEM, focused = false, active = true, packageName = systemUi),
        )
    }

    @Test
    fun `application windows match, the app's own and another package's (a permission dialog)`() {
        assertEquals(
            false,
            NonAppNodes.excludesWindow(AccessibilityWindowInfo.TYPE_APPLICATION, focused = false, active = false, packageName = systemUi),
        )
        assertEquals(
            false,
            NonAppNodes.excludesWindow(AccessibilityWindowInfo.TYPE_APPLICATION, focused = true, active = true, packageName = systemUi),
        )
    }

    @Test
    fun `system windows System UI does not own match - the app's overlay, the system's error dialogs`() {
        val type = AccessibilityWindowInfo.TYPE_SYSTEM
        assertEquals(false, NonAppNodes.excludesWindow(type, focused = false, active = false, packageName = "com.example.app"))
        assertEquals(false, NonAppNodes.excludesWindow(type, focused = false, active = false, packageName = "android"))
        assertEquals(false, NonAppNodes.excludesWindow(type, focused = false, active = false, packageName = null))
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
