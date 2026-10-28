package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Host-side tests for choosing how input is injected on each API level (PILOT-789). */
class InjectModeTest {
    @Test
    fun `before API 30 nothing waits on WindowManager`() {
        for (api in 23..29) {
            assertEquals(InjectMode.NO_WINDOW_SYNC, InjectMode.choose(api, noWaitOverloadFound = false))
        }
    }

    @Test
    fun `API 30 always waits - the no-wait overload does not exist there`() {
        assertEquals(InjectMode.WAITS_FOR_ANIMATIONS, InjectMode.choose(30, noWaitOverloadFound = true))
        assertEquals(InjectMode.WAITS_FOR_ANIMATIONS, InjectMode.choose(30, noWaitOverloadFound = false))
    }

    @Test
    fun `API 31 and later skip the animation wait when the overload is reachable`() {
        for (api in 31..37) {
            assertEquals(InjectMode.NO_ANIMATION_WAIT, InjectMode.choose(api, noWaitOverloadFound = true))
            assertEquals(InjectMode.WAITS_FOR_ANIMATIONS, InjectMode.choose(api, noWaitOverloadFound = false))
        }
    }

    @Test
    fun `a fast inject is not reported`() {
        assertNull(InjectMode.slowInjectWarning(InjectMode.WAITS_FOR_ANIMATIONS, "DOWN", 4499))
    }

    @Test
    fun `a slow inject that could have waited on an animation names the animation`() {
        val warning = InjectMode.slowInjectWarning(InjectMode.WAITS_FOR_ANIMATIONS, "DOWN", 5012)
        assertNotNull(warning)
        assertTrue(warning!!, warning.contains("5012ms"))
        assertTrue(warning, warning.contains("window animation"))
        assertTrue(warning, warning.contains("starting_reveal"))
    }

    @Test
    fun `a slow inject that skipped the wait blames something else`() {
        val warning = InjectMode.slowInjectWarning(InjectMode.NO_ANIMATION_WAIT, "UP", 6000)
        assertNotNull(warning)
        assertTrue(warning!!, !warning.contains("window animation"))
    }
}
