package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Host-side tests for how element actions recover from a changed target and
 * a failed first attempt (PILOT-362).
 */
class ActionRetryTest {
    private class FakeClock(var nowMs: Long = 0) : GuardClock {
        override fun now() = nowMs

        override fun sleep(ms: Long) {
            nowMs += ms
        }
    }

    private val clock = FakeClock()

    private fun budget(timeoutMs: Long = 5_000) = ActionBudget(0, timeoutMs, timeoutMs + 5_000, clock)

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

    // ─── actWithReresolve ───

    @Test
    fun `an action that works is run once`() {
        var resolves = 0
        val result =
            actWithReresolve("a", idAddressed = false, budget(), reResolve = {
                resolves++
                "b"
            }) { "acted on $it" }
        assertEquals("acted on a", result)
        assertEquals(0, resolves)
    }

    @Test
    fun `a selector-addressed target that changed is resolved again and acted on`() {
        val acted = mutableListOf<String>()
        clock.nowMs = 1_000
        var resolvedWith = -1L
        val result =
            actWithReresolve("old", idAddressed = false, budget(), reResolve = { timeout ->
                resolvedWith = timeout
                "new"
            }) { element ->
                acted.add(element)
                if (element == "old") throw TargetChangedException()
                "done"
            }
        assertEquals("done", result)
        assertEquals(listOf("old", "new"), acted)
        assertEquals("re-resolves within what is left of the budget", 4_000, resolvedWith)
    }

    @Test
    fun `an id-addressed target that changed is reported stale for the SDK to re-resolve`() {
        var resolves = 0
        val e =
            assertThrows<TargetChangedException> {
                actWithReresolve("a", idAddressed = true, budget(), reResolve = {
                    resolves++
                    "b"
                }) { throw TargetChangedException() }
            }
        assertTrue(e.message, e.message!!.contains("stale"))
        assertEquals(0, resolves)
    }

    @Test
    fun `a changed target with no budget left is not resolved again`() {
        clock.nowMs = 5_000
        var resolves = 0
        assertThrows<TargetChangedException> {
            actWithReresolve("a", idAddressed = false, budget(), reResolve = {
                resolves++
                "b"
            }) { throw TargetChangedException() }
        }
        assertEquals(0, resolves)
    }

    @Test
    fun `a changed target that no longer resolves says what happened`() {
        val e =
            assertThrows<ElementNotFoundException> {
                actWithReresolve("a", idAddressed = false, budget(), reResolve = {
                    throw TimeoutException("Timed out after 212ms: element not found after waiting.")
                }) { throw TargetChangedException() }
            }
        assertTrue(e.message, e.message!!.contains("changed into another element"))
        assertTrue(e.message, e.message!!.contains("nothing matches the locator now"))
        assertFalse(e.message, e.message!!.contains("212ms"))
    }

    // ─── fallbackFailure ───

    private val first = IllegalStateException("setText rejected")

    @Test
    fun `a fallback with no time left reports the first attempt's failure`() {
        val e = fallbackFailure("type text", first, TouchTooLateException(), changedNote = "not typed into again")
        assertTrue(e is ActionFailedException)
        assertTrue(e.message, e.message!!.contains("setText rejected"))
        assertTrue(e.message, e.message!!.contains("no time left to retry"))
    }

    @Test
    fun `a fallback whose target changed fails instead of retrying elsewhere`() {
        val e = fallbackFailure("type text", first, TargetChangedException(), changedNote = "so it was not typed into again")
        assertTrue("not a TargetChanged, which would re-resolve", e is ActionFailedException)
        assertTrue(e.message, e.message!!.contains("setText rejected"))
        assertTrue(e.message, e.message!!.contains("so it was not typed into again"))
    }

    @Test
    fun `a covered fallback surfaces as covered`() {
        val covered = ElementCoveredException("Element is covered by the keyboard", OcclusionAnalyzer.CoverKind.KEYBOARD)
        assertSame(covered, fallbackFailure("type text", first, covered, changedNote = ""))
    }

    @Test
    fun `any other fallback failure reports both`() {
        val e = fallbackFailure("clear text", first, IllegalStateException("shell failed"), changedNote = "")
        assertTrue(e is ActionFailedException)
        assertEquals("Failed to clear text: setText rejected (fallback also failed: shell failed)", e.message)
    }

    // ─── refocusOrAcceptFocus ───

    private fun covered(kind: OcclusionAnalyzer.CoverKind) = ElementCoveredException("covered", kind)

    @Test
    fun `a refocus that lands is used`() {
        var waited = false
        val skipped =
            refocusOrAcceptFocus(refocus = {}, waitForFocus = {
                waited = true
                true
            }, requireTime = {})
        assertFalse(skipped)
        assertFalse(waited)
    }

    @Test
    fun `under the keyboard, focus that arrives is accepted without a tap once time is checked`() {
        var timeChecked = false
        val skipped =
            refocusOrAcceptFocus(
                refocus = { throw covered(OcclusionAnalyzer.CoverKind.KEYBOARD) },
                waitForFocus = { true },
                requireTime = { timeChecked = true },
            )
        assertTrue(skipped)
        assertTrue(timeChecked)
    }

    @Test
    fun `under the keyboard, focus that never arrives stays covered`() {
        assertThrows<ElementCoveredException> {
            refocusOrAcceptFocus(
                refocus = { throw covered(OcclusionAnalyzer.CoverKind.KEYBOARD) },
                waitForFocus = { false },
                requireTime = {},
            )
        }
    }

    @Test
    fun `under another window, the refocus fails without waiting for focus`() {
        var waited = false
        assertThrows<ElementCoveredException> {
            refocusOrAcceptFocus(
                refocus = { throw covered(OcclusionAnalyzer.CoverKind.WINDOW) },
                waitForFocus = {
                    waited = true
                    true
                },
                requireTime = {},
            )
        }
        assertFalse(waited)
    }

    @Test
    fun `focus that arrives too late is refused`() {
        assertThrows<TouchTooLateException> {
            refocusOrAcceptFocus(
                refocus = { throw covered(OcclusionAnalyzer.CoverKind.KEYBOARD) },
                waitForFocus = { true },
                requireTime = { throw TouchTooLateException() },
            )
        }
    }
}
