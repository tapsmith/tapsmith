package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The `waitForAppReady` check (PILOT-976): the same verdict the dump-based check gave. */
class AppReadinessTest {
    private val pkg = "com.example.app"

    private class FakeNode(
        override val packageName: CharSequence? = "com.example.app",
        override val text: CharSequence? = null,
        override val contentDescription: CharSequence? = null,
        override val isVisibleToUser: Boolean = true,
        val children: List<FakeNode> = emptyList(),
    ) : AppReadiness.Node {
        var reads = 0

        override val childCount: Int get() = children.size

        override fun child(index: Int): AppReadiness.Node? {
            reads++
            return children[index]
        }
    }

    @Test
    fun `a bare window of the package is not content`() {
        val splash = FakeNode(children = listOf(FakeNode(children = listOf(FakeNode()))))
        assertFalse(AppReadiness.hasRenderedContent(listOf(splash), pkg))
    }

    @Test
    fun `a text node of the package is content`() {
        val root = FakeNode(children = listOf(FakeNode(), FakeNode(text = "Welcome")))
        assertTrue(AppReadiness.hasRenderedContent(listOf(root), pkg))
    }

    @Test
    fun `a description-only node counts, which includes the hooks marker`() {
        val root = FakeNode(children = listOf(FakeNode(contentDescription = "tapsmith-hooks:1;epoch=0")))
        assertTrue(AppReadiness.hasRenderedContent(listOf(root), pkg))
    }

    @Test
    fun `text in another package's window does not count`() {
        val launcher =
            FakeNode(
                packageName = "com.android.launcher3",
                children = listOf(FakeNode(packageName = "com.android.launcher3", text = "Phone")),
            )
        val splash = FakeNode()
        assertFalse(AppReadiness.hasRenderedContent(listOf(launcher, splash), pkg))
    }

    @Test
    fun `an invisible subtree is skipped, as the hierarchy dump skips it`() {
        val hidden = FakeNode(isVisibleToUser = false, text = "Offscreen", children = listOf(FakeNode(text = "Below")))
        assertFalse(AppReadiness.hasRenderedContent(listOf(FakeNode(children = listOf(hidden))), pkg))
    }

    @Test
    fun `a window root is read whatever its visibility, as the dump writes it`() {
        val root = FakeNode(isVisibleToUser = false, text = "Root text")
        assertTrue(AppReadiness.hasRenderedContent(listOf(root), pkg))
    }

    @Test
    fun `empty text and description are not content`() {
        val root = FakeNode(children = listOf(FakeNode(text = "", contentDescription = "")))
        assertFalse(AppReadiness.hasRenderedContent(listOf(root), pkg))
    }

    @Test
    fun `the walk stops at the first match`() {
        val later = FakeNode(children = listOf(FakeNode(text = "x"), FakeNode(text = "y")))
        val root = FakeNode(children = listOf(FakeNode(text = "first"), later))
        assertTrue(AppReadiness.hasRenderedContent(listOf(root), pkg))
        assertEquals(0, later.reads)
    }

    @Test
    fun `the walk is bounded`() {
        val wide = FakeNode(children = List(50) { FakeNode() } + FakeNode(text = "late"))
        assertFalse(AppReadiness.hasRenderedContent(listOf(wide), pkg, maxNodes = 10))
        assertTrue(AppReadiness.hasRenderedContent(listOf(wide), pkg, maxNodes = 100))
    }

    @Test
    fun `await returns on the first ready check`() {
        var now = 0L
        var checks = 0
        val outcome =
            AppReadiness.await(timeoutMs = 10_000, clock = { now }, sleep = { now += it }) {
                checks++
                checks == 3
            }
        assertTrue(outcome.ready)
        assertEquals(3, outcome.checks)
        assertEquals(2 * AppReadiness.POLL_INTERVAL_MS, outcome.elapsedMs)
    }

    @Test
    fun `await gives up at its budget without overshooting it`() {
        var now = 0L
        val outcome = AppReadiness.await(timeoutMs = 120, clock = { now }, sleep = { now += it }) { false }
        assertFalse(outcome.ready)
        assertEquals(120L, outcome.elapsedMs)
    }

    @Test
    fun `a check that throws counts as not ready and keeps polling`() {
        var now = 0L
        var checks = 0
        val outcome =
            AppReadiness.await(timeoutMs = 1_000, clock = { now }, sleep = { now += it }) {
                checks++
                if (checks == 1) throw IllegalStateException("window gone")
                true
            }
        assertTrue(outcome.ready)
        assertEquals(2, outcome.checks)
    }

    @Test(expected = CommandCancelledException::class)
    fun `a cancelled command stops the wait`() {
        var now = 0L
        AppReadiness.await(timeoutMs = 1_000, clock = { now }, sleep = { now += it }) {
            throw CommandCancelledException("Command abandoned: connection closed")
        }
    }

    @Test
    fun `a zero budget still checks once`() {
        var now = 0L
        val outcome = AppReadiness.await(timeoutMs = 0, clock = { now }, sleep = { now += it }) { true }
        assertTrue(outcome.ready)
    }
}
