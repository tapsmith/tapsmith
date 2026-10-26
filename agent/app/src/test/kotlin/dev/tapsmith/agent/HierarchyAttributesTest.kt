package dev.tapsmith.agent

import dev.tapsmith.agent.HierarchyAttributes.Box
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The hierarchy dump's attribute injection (`tapsmith-role`,
 * `tapsmith-expanded`): joined to the stock UIAutomator XML by the bounds
 * that XML writes, so the Locator Playground reads the same state the device
 * does (PILOT-655).
 */
class HierarchyAttributesTest {
    @Test
    fun `a node fully on screen keeps its bounds`() {
        val b = HierarchyAttributes.dumpedBounds(Box(10, 100, 500, 200), 1080, 2400, Box(0, 0, 1080, 2400))
        assertEquals("[10,100][500,200]", b.key())
    }

    @Test
    fun `a node partly off screen is keyed by its clipped bounds, as the stock dump writes them`() {
        // Scrolled half above the top of the display.
        assertEquals(
            "[0,0][1080,80]",
            HierarchyAttributes.dumpedBounds(Box(0, -50, 1080, 80), 1080, 2400, Box(0, 0, 1080, 2400)).key(),
        )
        // Past the right edge, then clipped by a window that stops above the nav bar.
        assertEquals(
            "[900,2200][1080,2337]",
            HierarchyAttributes.dumpedBounds(Box(900, 2200, 1300, 2400), 1080, 2400, Box(0, 0, 1080, 2337)).key(),
        )
    }

    @Test
    fun `a box that does not overlap the clip is left unchanged, like Rect intersect`() {
        assertEquals(
            "[0,2500][100,2600]",
            HierarchyAttributes.dumpedBounds(Box(0, 2500, 100, 2600), 1080, 2400, null).key(),
        )
    }

    @Test
    fun `injects each attribute after the bounds of every node with that key`() {
        val xml =
            """<hierarchy><node index="0" class="android.widget.Button" bounds="[0,0][100,50]" />""" +
                """<node index="1" class="android.widget.TextView" bounds="[0,60][100,110]"></node></hierarchy>"""
        val out =
            HierarchyAttributes.inject(
                xml,
                mapOf("[0,0][100,50]" to mapOf("tapsmith-role" to "button", "tapsmith-expanded" to "false")),
            )
        assertEquals(
            """<hierarchy><node index="0" class="android.widget.Button" bounds="[0,0][100,50]" """ +
                """tapsmith-role="button" tapsmith-expanded="false" />""" +
                """<node index="1" class="android.widget.TextView" bounds="[0,60][100,110]"></node></hierarchy>""",
            out,
        )
    }

    @Test
    fun `escapes injected values and leaves the XML alone with nothing to inject`() {
        val xml = """<node bounds="[0,0][1,1]" />"""
        assertEquals(xml, HierarchyAttributes.inject(xml, emptyMap()))
        assertEquals(
            """<node bounds="[0,0][1,1]" tapsmith-role="a&quot;&lt;b" />""",
            HierarchyAttributes.inject(xml, mapOf("[0,0][1,1]" to mapOf("tapsmith-role" to "a\"<b"))),
        )
    }

    // ─── Non-app window roots (PILOT-756) ───

    private val statusBar = HierarchyAttributes.windowRootKey(Box(0, 0, 1080, 63), "com.android.systemui")

    @Test
    fun `an excluded window's root node is marked, and only it`() {
        val xml =
            """<hierarchy rotation="0">""" +
                """<node index="0" package="com.android.systemui" bounds="[0,0][1080,63]">""" +
                """<node index="0" text="10:06" package="com.android.systemui" bounds="[40,10][140,55]" /></node>""" +
                """<node index="0" package="com.example.app" bounds="[0,0][1080,2400]">""" +
                """<node index="0" text="Header" package="com.example.app" bounds="[0,0][1080,63]" /></node>""" +
                """</hierarchy>"""
        val marked = HierarchyAttributes.markWindowRoots(xml, setOf(statusBar), "tapsmith-non-app")
        assertEquals(
            """<hierarchy rotation="0">""" +
                """<node tapsmith-non-app="true" index="0" package="com.android.systemui" bounds="[0,0][1080,63]">""" +
                """<node index="0" text="10:06" package="com.android.systemui" bounds="[40,10][140,55]" /></node>""" +
                """<node index="0" package="com.example.app" bounds="[0,0][1080,2400]">""" +
                """<node index="0" text="Header" package="com.example.app" bounds="[0,0][1080,63]" /></node>""" +
                """</hierarchy>""",
            marked,
        )
    }

    @Test
    fun `a nested node with a window root's bounds and package is not a window root`() {
        // The app's own root and a child of it share bounds and package; only
        // a top-level node is a window's root.
        val app = HierarchyAttributes.windowRootKey(Box(0, 0, 1080, 2400), "com.example.app")
        val xml =
            """<hierarchy><node package="com.other" bounds="[0,0][1080,2400]">""" +
                """<node package="com.example.app" bounds="[0,0][1080,2400]" /></node></hierarchy>"""
        assertEquals(xml, HierarchyAttributes.markWindowRoots(xml, setOf(app), "tapsmith-non-app"))
    }

    @Test
    fun `a self-closing window root keeps the depth right for the next window`() {
        val ime = HierarchyAttributes.windowRootKey(Box(0, 1600, 1080, 2400), "com.google.android.inputmethod.latin")
        val xml =
            """<hierarchy><node package="com.android.systemui" bounds="[0,0][1080,63]" />""" +
                """<node package="com.google.android.inputmethod.latin" bounds="[0,1600][1080,2400]">""" +
                """<node bounds="[0,0][1,1]" /></node></hierarchy>"""
        assertEquals(
            """<hierarchy><node package="com.android.systemui" bounds="[0,0][1080,63]" />""" +
                """<node tapsmith-non-app="true" package="com.google.android.inputmethod.latin" bounds="[0,1600][1080,2400]">""" +
                """<node bounds="[0,0][1,1]" /></node></hierarchy>""",
            HierarchyAttributes.markWindowRoots(xml, setOf(ime), "tapsmith-non-app"),
        )
    }

    @Test
    fun `no excluded windows leaves the dump as it was`() {
        val xml = """<hierarchy><node package="a" bounds="[0,0][1,1]" /></hierarchy>"""
        assertEquals(xml, HierarchyAttributes.markWindowRoots(xml, emptySet(), "tapsmith-non-app"))
    }
}
