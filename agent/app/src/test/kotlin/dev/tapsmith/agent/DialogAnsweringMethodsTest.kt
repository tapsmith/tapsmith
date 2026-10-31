package dev.tapsmith.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which agent commands answer a system ANR / crash dialog before they run
 * (PILOT-977): element lookups and input do; reads that report the screen
 * must not, so a trace, an MCP snapshot or a UI-mode pick still shows the
 * dialog instead of closing it as a side effect.
 */
class DialogAnsweringMethodsTest {
    private val answering = CommandHandler.DIALOG_ANSWERING_METHODS

    @Test
    fun `element lookups and input answer dialogs`() {
        listOf("findElement", "findElements", "waitForElement", "tap", "typeText", "swipe", "pressKey").forEach {
            assertTrue("$it should answer", it in answering)
        }
    }

    @Test
    fun `reads that report the screen never answer dialogs`() {
        listOf(
            "getUiHierarchy",
            "screenshot",
            "elementScreenshot",
            "evaluateSelectors",
            "highlight",
            "waitForIdle",
            "ping",
            "takeSystemDialogEvents",
        ).forEach { assertFalse("$it must not answer", it in answering) }
    }
}
