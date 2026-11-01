package dev.tapsmith.agent

import dev.tapsmith.agent.OcclusionAnalyzer.Verdict
import dev.tapsmith.agent.OcclusionAnalyzer.WindowKind
import dev.tapsmith.agent.OcclusionAnalyzer.WindowSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-side tests for the covered-element check (PILOT-362). Geometry is in
 * screen pixels on a 1080x2400 display; the app window is id 1 at layer 0.
 */
class OcclusionAnalyzerTest {
    private val screen = Box(0, 0, 1080, 2400)
    private val appWindow = WindowSpec(id = 1, kind = WindowKind.APPLICATION, layer = 0, bounds = screen, title = "App")
    private val keyboard = WindowSpec(id = 2, kind = WindowKind.INPUT_METHOD, layer = 5, bounds = Box(0, 1500, 1080, 2400), title = null)

    // ─── A fake accessibility tree ───

    private class FakeNode(
        override val bounds: Box,
        override val drawingOrder: Int = 0,
        override val isVisible: Boolean = true,
        override val takesTouches: Boolean = false,
        override val offersDismiss: Boolean = false,
        override val isProgressIndicator: Boolean = false,
        override val scrollsVertically: Boolean = false,
        private val name: String = "node",
        val children: MutableList<FakeNode> = mutableListOf(),
    ) : OcclusionAnalyzer.HitNode {
        var parentNode: FakeNode? = null

        override fun parent(): OcclusionAnalyzer.HitNode? = parentNode

        override fun childCount(): Int = children.size

        override fun child(index: Int): OcclusionAnalyzer.HitNode? {
            childReads++
            return children.getOrNull(index)
        }

        companion object {
            var childReads = 0
        }

        override fun sameAs(other: OcclusionAnalyzer.HitNode): Boolean = this === other

        override fun describe(): String = name

        fun add(vararg nodes: FakeNode): FakeNode {
            for (n in nodes) {
                n.parentNode = this
                children.add(n)
            }
            return this
        }
    }

    private fun root(vararg children: FakeNode) = FakeNode(screen, name = "root").add(*children)

    private fun analyze(
        target: FakeNode?,
        bounds: Box = target!!.bounds,
        windows: List<WindowSpec> = listOf(appWindow),
        targetWindowId: Int? = 1,
    ): Verdict =
        OcclusionAnalyzer.analyze(
            target = target,
            targetBounds = bounds,
            targetWindowId = targetWindowId,
            windows = windows,
            screen = screen,
        )

    private fun assertClearAt(
        verdict: Verdict,
        x: Int,
        y: Int,
    ) {
        assertTrue("expected Clear, got $verdict", verdict is Verdict.Clear)
        verdict as Verdict.Clear
        assertEquals("x", x, verdict.x)
        assertEquals("y", y, verdict.y)
    }

    private fun assertCoveredBy(
        verdict: Verdict,
        cover: String,
    ) {
        assertTrue("expected Covered, got $verdict", verdict is Verdict.Covered)
        assertEquals(cover, (verdict as Verdict.Covered).by)
    }

    private fun coverBounds(verdict: Verdict): Box {
        assertTrue("expected Covered, got $verdict", verdict is Verdict.Covered)
        return (verdict as Verdict.Covered).bounds
    }

    private fun coverKind(verdict: Verdict): OcclusionAnalyzer.CoverKind {
        assertTrue("expected Covered, got $verdict", verdict is Verdict.Covered)
        return (verdict as Verdict.Covered).kind
    }

    // ─── Nothing in the way ───

    @Test
    fun `an uncovered element is touched at its center`() {
        val button = FakeNode(Box(100, 200, 300, 400), takesTouches = true)
        root(button)
        assertClearAt(analyze(button), 200, 300)
    }

    @Test
    fun `an element partly off screen is touched at the center of its on-screen part`() {
        val button = FakeNode(Box(-200, 100, 200, 300), takesTouches = true)
        root(button)
        assertClearAt(analyze(button), 100, 200)
    }

    @Test
    fun `an element with no on-screen part is off screen`() {
        val button = FakeNode(Box(0, 2500, 100, 2600))
        root(button)
        assertEquals(Verdict.OffScreen, analyze(button))
    }

    @Test
    fun `an element with empty bounds is off screen`() {
        val button = FakeNode(Box(100, 100, 100, 100))
        root(button)
        assertEquals(Verdict.OffScreen, analyze(button))
    }

    @Test
    fun `a sliver thinner than the minimum extent is off screen`() {
        val button = FakeNode(Box(100, 2399, 300, 2450))
        root(button)
        assertEquals(Verdict.OffScreen, analyze(button))
    }

    @Test
    fun `no tree node still gets the window checks`() {
        assertCoveredBy(analyze(null, bounds = Box(0, 1600, 1080, 1700), windows = listOf(appWindow, keyboard)), "the keyboard")
        assertClearAt(analyze(null, bounds = Box(0, 100, 1080, 300), windows = listOf(appWindow, keyboard)), 540, 200)
    }

    // ─── The keyboard ───

    @Test
    fun `an element fully behind the keyboard is covered by the keyboard`() {
        val button = FakeNode(Box(40, 2200, 1040, 2340), takesTouches = true)
        root(button)
        assertCoveredBy(analyze(button, windows = listOf(appWindow, keyboard)), "the keyboard")
    }

    @Test
    fun `an element half behind the keyboard is touched on its visible part`() {
        val button = FakeNode(Box(40, 1300, 1040, 2340), takesTouches = true)
        root(button)
        // Visible part: y 1300..1500, so its center is at 1400.
        assertClearAt(analyze(button, windows = listOf(appWindow, keyboard)), 540, 1400)
    }

    @Test
    fun `a sliver left above the keyboard counts as covered`() {
        val button = FakeNode(Box(40, 1499, 1040, 1700), takesTouches = true)
        root(button)
        assertCoveredBy(analyze(button, windows = listOf(appWindow, keyboard)), "the keyboard")
    }

    @Test
    fun `a hidden keyboard window is ignored`() {
        val button = FakeNode(Box(40, 2200, 1040, 2340), takesTouches = true)
        root(button)
        val hidden = keyboard.copy(bounds = Box(0, 0, 0, 0))
        assertClearAt(analyze(button, windows = listOf(appWindow, hidden)), 540, 2270)
    }

    @Test
    fun `a key in the keyboard's own window is not covered by the keyboard`() {
        val key = FakeNode(Box(0, 1600, 100, 1700), takesTouches = true)
        root(key)
        assertClearAt(analyze(key, windows = listOf(appWindow, keyboard), targetWindowId = 2), 50, 1650)
    }

    @Test
    fun `a window stacked above the keyboard is not covered by it`() {
        // A suggestions popup that needs the IME is placed above it.
        val popup = WindowSpec(id = 8, kind = WindowKind.APPLICATION, layer = 7, bounds = Box(0, 1400, 1080, 1700), title = null)
        val suggestion = FakeNode(Box(0, 1550, 1080, 1650), takesTouches = true)
        root(suggestion)
        assertClearAt(analyze(suggestion, windows = listOf(appWindow, keyboard, popup), targetWindowId = 8), 540, 1600)
    }

    @Test
    fun `the keyboard counts even when the target's window is unknown`() {
        val button = FakeNode(Box(40, 2200, 1040, 2340), takesTouches = true)
        root(button)
        assertCoveredBy(analyze(button, windows = listOf(appWindow, keyboard), targetWindowId = null), "the keyboard")
    }

    @Test
    fun `a target the framework reports invisible behind the keyboard is covered by it`() {
        val button = FakeNode(Box(40, 1300, 1040, 2340), isVisible = false, takesTouches = true)
        root(button)
        assertCoveredBy(analyze(button, windows = listOf(appWindow, keyboard)), "the keyboard")
    }

    @Test
    fun `a target the framework reports invisible under a dialog window is covered by the dialog`() {
        // Android marks a node invisible when a window above hides it, not
        // only the keyboard; that is a cover to wait out, not "off screen".
        val dialog = WindowSpec(id = 4, kind = WindowKind.APPLICATION, layer = 2, bounds = Box(0, 0, 1080, 2400), title = "Loading")
        val button = FakeNode(Box(40, 100, 1040, 300), isVisible = false, takesTouches = true)
        root(button)
        val verdict = analyze(button, windows = listOf(appWindow, dialog))
        assertCoveredBy(verdict, "the window \"Loading\"")
        assertEquals(OcclusionAnalyzer.CoverKind.WINDOW, coverKind(verdict))
    }

    @Test
    fun `an invisible target is attributed to the window that hides all of it`() {
        // Fully behind the keyboard, with its bottom edge reaching into a
        // navigation bar drawn above the keyboard: the keyboard hides it.
        val navBar = WindowSpec(id = 3, kind = WindowKind.SYSTEM, layer = 9, bounds = Box(0, 2300, 1080, 2400), title = "Navigation bar")
        val field = FakeNode(Box(40, 2200, 1040, 2340), isVisible = false, takesTouches = true)
        root(field)
        val verdict = analyze(field, windows = listOf(appWindow, keyboard, navBar))
        assertCoveredBy(verdict, "the keyboard")
        assertEquals(OcclusionAnalyzer.CoverKind.KEYBOARD, coverKind(verdict))
    }

    @Test
    fun `covers say what kind of thing they are`() {
        // The focusing tap of a focused field is skipped under the keyboard or
        // a control on its own screen (input still reaches it), never under
        // another window (which takes the input).
        val kb = FakeNode(Box(40, 2200, 1040, 2340), takesTouches = true)
        root(kb)
        assertEquals(OcclusionAnalyzer.CoverKind.KEYBOARD, coverKind(analyze(kb, windows = listOf(appWindow, keyboard))))

        val dialog = WindowSpec(id = 4, kind = WindowKind.APPLICATION, layer = 2, bounds = Box(0, 0, 1080, 2400), title = null)
        val underDialog = FakeNode(Box(40, 100, 1040, 300), takesTouches = true)
        root(underDialog)
        assertEquals(OcclusionAnalyzer.CoverKind.WINDOW, coverKind(analyze(underDialog, windows = listOf(appWindow, dialog))))

        val covered = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        val overlay = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 2, takesTouches = true)
        root(FakeNode(screen).add(covered, overlay))
        assertEquals(OcclusionAnalyzer.CoverKind.CONTROL, coverKind(analyze(covered)))
    }

    @Test
    fun `an invisible target nowhere near the keyboard is off screen`() {
        val button = FakeNode(Box(40, 100, 1040, 300), isVisible = false, takesTouches = true)
        root(button)
        assertEquals(Verdict.OffScreen, analyze(button, windows = listOf(appWindow, keyboard)))
    }

    // ─── Other windows ───

    @Test
    fun `a system bar over part of the element clips it`() {
        val statusBar = WindowSpec(id = 3, kind = WindowKind.SYSTEM, layer = 1, bounds = Box(0, 0, 1080, 63), title = null)
        val header = FakeNode(Box(0, 0, 1080, 210), takesTouches = true)
        root(header)
        // Visible part: y 63..210.
        assertClearAt(analyze(header, windows = listOf(appWindow, statusBar)), 540, 136)
    }

    @Test
    fun `an element entirely under a system bar is covered by it`() {
        val statusBar = WindowSpec(id = 3, kind = WindowKind.SYSTEM, layer = 1, bounds = Box(0, 0, 1080, 63), title = null)
        val icon = FakeNode(Box(10, 10, 60, 60), takesTouches = true)
        root(icon)
        assertCoveredBy(analyze(icon, windows = listOf(appWindow, statusBar)), "a system bar")
    }

    @Test
    fun `a titled system window is named by its title`() {
        val nav = WindowSpec(id = 3, kind = WindowKind.SYSTEM, layer = 1, bounds = Box(0, 2270, 1080, 2400), title = "Navigation bar")
        val button = FakeNode(Box(40, 2290, 1040, 2380), takesTouches = true)
        root(button)
        assertCoveredBy(analyze(button, windows = listOf(appWindow, nav)), "the system window \"Navigation bar\"")
    }

    @Test
    fun `an app window above the target's window covers it`() {
        val dialog = WindowSpec(id = 4, kind = WindowKind.APPLICATION, layer = 2, bounds = Box(100, 800, 980, 1600), title = "Confirm")
        val button = FakeNode(Box(200, 1000, 800, 1100), takesTouches = true)
        root(button)
        assertCoveredBy(analyze(button, windows = listOf(appWindow, dialog)), "the window \"Confirm\"")
    }

    @Test
    fun `an untitled app window above is named generically`() {
        val popup = WindowSpec(id = 4, kind = WindowKind.APPLICATION, layer = 2, bounds = Box(100, 800, 980, 1600), title = null)
        val button = FakeNode(Box(200, 1000, 800, 1100), takesTouches = true)
        root(button)
        assertCoveredBy(analyze(button, windows = listOf(appWindow, popup)), "another window")
    }

    @Test
    fun `windows below the target's window, and other kinds, are ignored`() {
        val below = WindowSpec(id = 5, kind = WindowKind.APPLICATION, layer = -1, bounds = screen, title = "Behind")
        val overlay = WindowSpec(id = 6, kind = WindowKind.OTHER, layer = 9, bounds = screen, title = "Accessibility overlay")
        val button = FakeNode(Box(200, 1000, 800, 1100), takesTouches = true)
        root(button)
        assertClearAt(analyze(button, windows = listOf(appWindow, below, overlay)), 500, 1050)
    }

    @Test
    fun `layered windows only count above the target's own window`() {
        // The target lives in a dialog (layer 2); the activity window under it
        // (layer 0) must not count as a cover.
        val dialog = WindowSpec(id = 4, kind = WindowKind.APPLICATION, layer = 2, bounds = Box(100, 800, 980, 1600), title = "Confirm")
        val ok = FakeNode(Box(200, 1000, 800, 1100), takesTouches = true)
        root(ok)
        assertClearAt(analyze(ok, windows = listOf(appWindow, dialog), targetWindowId = 4), 500, 1050)
    }

    @Test
    fun `a window over the only visible part left by the keyboard covers it`() {
        val banner = WindowSpec(id = 7, kind = WindowKind.SYSTEM, layer = 6, bounds = Box(0, 1200, 1080, 1500), title = null)
        val button = FakeNode(Box(40, 1300, 1040, 2340), takesTouches = true)
        root(button)
        val verdict = analyze(button, windows = listOf(appWindow, keyboard, banner))
        assertTrue("expected Covered, got $verdict", verdict is Verdict.Covered)
    }

    @Test
    fun `a piece set aside by one window is still used when a later one covers the rest`() {
        // A popup over the middle leaves a small top piece (1300..1450) and a
        // large bottom one (1650..2340); the keyboard then covers the bottom.
        val popup = WindowSpec(id = 4, kind = WindowKind.APPLICATION, layer = 9, bounds = Box(0, 1450, 1080, 1650), title = null)
        val tall = FakeNode(Box(40, 1300, 1040, 2340), takesTouches = true)
        root(tall)
        assertClearAt(analyze(tall, windows = listOf(appWindow, keyboard, popup)), 540, 1375)
    }

    @Test
    fun `the largest part left over is the one touched`() {
        // A cover over the middle of a wide element leaves a left and a right
        // strip; the wider one wins.
        val cover = WindowSpec(id = 4, kind = WindowKind.APPLICATION, layer = 2, bounds = Box(300, 0, 500, 2400), title = null)
        val bar = FakeNode(Box(0, 100, 1000, 200), takesTouches = true)
        root(bar)
        // Left strip 0..300 (300 wide), right strip 500..1000 (500 wide).
        assertClearAt(analyze(bar, windows = listOf(appWindow, cover)), 750, 150)
    }

    // ─── Loading overlays (PILOT-979) ───

    @Test
    fun `a non-touchable overlay holding a spinner covers the target`() {
        // A React Native loading overlay: a plain view (it may be see-through)
        // over the screen, with an ActivityIndicator (a ProgressBar) in it.
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        val spinner = FakeNode(Box(490, 1150, 590, 1250), isProgressIndicator = true, name = "an unlabelled ProgressBar")
        val overlay = FakeNode(Box(0, 0, 1080, 2400), drawingOrder = 2, name = "an unlabelled ViewGroup").add(spinner)
        root(FakeNode(screen).add(button, overlay))
        val verdict = analyze(button)
        assertCoveredBy(verdict, "a loading overlay (an unlabelled ViewGroup)")
        assertEquals(OcclusionAnalyzer.CoverKind.LOADING, coverKind(verdict))
        assertEquals(Box(0, 0, 1080, 2400), coverBounds(verdict))
    }

    @Test
    fun `a spinner drawn right over the touch point covers the target`() {
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        val spinner = FakeNode(Box(440, 805, 640, 905), drawingOrder = 2, isProgressIndicator = true, name = "an unlabelled ProgressBar")
        root(FakeNode(screen).add(button, spinner))
        assertCoveredBy(analyze(button), "a loading overlay (an unlabelled ProgressBar)")
    }

    @Test
    fun `a spinner nested deep in a later branch over the point is found`() {
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        val spinner = FakeNode(Box(490, 1150, 590, 1250), isProgressIndicator = true)
        val card = FakeNode(Box(300, 1000, 780, 1400)).add(FakeNode(Box(300, 1000, 780, 1400)).add(spinner))
        val overlay = FakeNode(screen, drawingOrder = 2, name = "overlay").add(card)
        root(FakeNode(screen).add(button, overlay))
        assertCoveredBy(analyze(button), "a loading overlay (overlay)")
    }

    @Test
    fun `an overlay without a spinner still does not cover the target`() {
        // Indistinguishable from a pointerEvents="none" overlay.
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        val overlay = FakeNode(screen, drawingOrder = 2).add(FakeNode(Box(490, 1150, 590, 1250), name = "text"))
        root(FakeNode(screen).add(button, overlay))
        assertClearAt(analyze(button), 540, 855)
    }

    @Test
    fun `a spinner inside the target is not a cover`() {
        val spinner = FakeNode(Box(940, 820, 1000, 880), isProgressIndicator = true)
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true).add(spinner)
        root(FakeNode(screen).add(button))
        assertClearAt(analyze(button), 540, 855)
    }

    @Test
    fun `a spinner beside the target that misses the touch point is not a cover`() {
        val button = FakeNode(Box(40, 780, 700, 930), drawingOrder = 1, takesTouches = true)
        val spinner = FakeNode(Box(750, 805, 850, 905), drawingOrder = 2, isProgressIndicator = true)
        root(FakeNode(screen).add(button, spinner))
        assertClearAt(analyze(button), 370, 855)
    }

    @Test
    fun `a spinner in a branch painted before the target is not a cover`() {
        val spinner = FakeNode(Box(490, 1150, 590, 1250), isProgressIndicator = true)
        val background = FakeNode(screen, drawingOrder = 1).add(spinner)
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 2, takesTouches = true)
        root(FakeNode(screen).add(background, button))
        assertClearAt(analyze(button), 540, 855)
    }

    @Test
    fun `an invisible spinner does not make an overlay a cover`() {
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        val spinner = FakeNode(Box(490, 1150, 590, 1250), isVisible = false, isProgressIndicator = true)
        val overlay = FakeNode(screen, drawingOrder = 2).add(spinner)
        root(FakeNode(screen).add(button, overlay))
        assertClearAt(analyze(button), 540, 855)
    }

    @Test
    fun `a touchable control over the point is named before a loading overlay`() {
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        val cancel = FakeNode(Box(40, 780, 1040, 930), takesTouches = true, name = "button \"Cancel\"")
        val overlay = FakeNode(screen, drawingOrder = 2).add(cancel, FakeNode(Box(490, 1150, 590, 1250), isProgressIndicator = true))
        root(FakeNode(screen).add(button, overlay))
        val verdict = analyze(button)
        assertCoveredBy(verdict, "button \"Cancel\"")
        assertEquals(OcclusionAnalyzer.CoverKind.CONTROL, coverKind(verdict))
    }

    // ─── Sticky list rows (PILOT-979) ───

    /** A vertical list: scroll view > content > rows, rows 150 px tall from y = 300. */
    private fun list(vararg rows: FakeNode): FakeNode {
        val content = FakeNode(Box(0, 300, 1080, 2100)).add(*rows)
        return FakeNode(Box(0, 300, 1080, 2100), scrollsVertically = true, name = "list").add(content)
    }

    @Test
    fun `a sticky header row stuck over the target's row covers it`() {
        // Android lists order their children by place: the header comes first
        // though it is drawn over the row scrolled under it. It takes no touches.
        val header = FakeNode(Box(0, 300, 1080, 450), name = "text \"Section A\"")
        val row = FakeNode(Box(0, 320, 1080, 470), takesTouches = true, name = "row 5")
        val title = FakeNode(Box(40, 340, 600, 450)).also { row.add(it) }
        root(list(header, row))
        val verdict = analyze(title)
        assertCoveredBy(verdict, "text \"Section A\"")
        assertEquals(OcclusionAnalyzer.CoverKind.CONTROL, coverKind(verdict))
        assertEquals(Box(0, 300, 1080, 450), coverBounds(verdict))
    }

    @Test
    fun `a row directly in a scrolling node (RecyclerView) is covered by a sticky sibling`() {
        val header = FakeNode(Box(0, 300, 1080, 450), name = "header")
        val row = FakeNode(Box(0, 320, 1080, 470), takesTouches = true)
        root(FakeNode(Box(0, 300, 1080, 2100), scrollsVertically = true).add(header, row))
        assertCoveredBy(analyze(row), "header")
    }

    @Test
    fun `rows that only touch edges do not cover each other`() {
        val a = FakeNode(Box(0, 300, 1080, 450), name = "a")
        val b = FakeNode(Box(0, 450, 1080, 600), takesTouches = true)
        val c = FakeNode(Box(0, 600, 1080, 750), name = "c")
        root(list(a, b, c))
        assertClearAt(analyze(b), 540, 525)
    }

    @Test
    fun `a narrower sibling (a grid cell beside it) is not a sticky row`() {
        val left = FakeNode(Box(0, 300, 540, 450), takesTouches = true)
        val badge = FakeNode(Box(500, 330, 600, 420), name = "badge")
        root(list(left, badge))
        assertClearAt(analyze(left), 270, 375)
    }

    @Test
    fun `rows of a horizontal list are not sticky rows`() {
        val a = FakeNode(Box(0, 300, 600, 450), name = "a")
        val b = FakeNode(Box(0, 300, 600, 450), takesTouches = true)
        val content = FakeNode(Box(0, 300, 1080, 450)).add(a, b)
        root(FakeNode(Box(0, 300, 1080, 450), scrollsVertically = false).add(content))
        assertClearAt(analyze(b), 300, 375)
    }

    @Test
    fun `a background drawn behind the target in scroll content is not a sticky row`() {
        // NestedScrollView > ConstraintLayout > [card background declared
        // first, button on top of it]: the background is painted under it.
        val background = FakeNode(Box(0, 300, 1080, 700), drawingOrder = 1, name = "background")
        val button = FakeNode(Box(40, 400, 1040, 550), drawingOrder = 2, takesTouches = true)
        root(list(background, button))
        assertClearAt(analyze(button), 540, 475)
    }

    @Test
    fun `a sticky header drawn on top by z-order covers the row though listed first`() {
        // React Native's stickyHeaderIndices: the header is the first cell,
        // raised above the rows by its zIndex.
        val header = FakeNode(Box(0, 300, 1080, 450), drawingOrder = 3, name = "header")
        val row = FakeNode(Box(0, 320, 1080, 470), drawingOrder = 2, takesTouches = true)
        root(list(header, row))
        assertCoveredBy(analyze(row), "header")
    }

    @Test
    fun `a wide later branch without a spinner does not use up the search for nearer covers`() {
        // A full-screen host over the point holds a long list elsewhere; the
        // loading-overlay check walks all of it, and must not stop the search
        // from reaching the control drawn over the target lower down.
        val far = FakeNode(Box(0, 0, 1080, 100))
        repeat(OcclusionAnalyzer.MAX_NODES_VISITED + 500) { far.add(FakeNode(Box(0, 0, 1080, 100))) }
        val host = FakeNode(screen, drawingOrder = 2).add(far)
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        val undo = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 2, takesTouches = true, name = "button \"Undo\"")
        root(FakeNode(screen, drawingOrder = 1).add(button, undo), host)
        assertCoveredBy(analyze(button), "button \"Undo\"")
    }

    @Test
    fun `a control in a bar over a list is cleared as the whole bar`() {
        // A checkout bar: a "Total" label above its button. Clearing only the
        // button would leave the row under the label.
        val row = FakeNode(Box(0, 2250, 1080, 2400), takesTouches = true)
        val content = FakeNode(Box(0, 200, 1080, 2400)).add(row)
        val list = FakeNode(Box(0, 200, 1080, 2400), scrollsVertically = true).add(content)
        val checkout = FakeNode(Box(0, 2200, 1080, 2400), takesTouches = true, name = "button \"Checkout\"")
        val bar = FakeNode(Box(0, 2000, 1080, 2400), drawingOrder = 1).add(FakeNode(Box(0, 2000, 1080, 2200), name = "total"), checkout)
        root(list, bar)
        val verdict = analyze(row)
        assertCoveredBy(verdict, "button \"Checkout\"")
        assertEquals(Box(0, 2000, 1080, 2400), coverBounds(verdict))
        assertEquals(Box(0, 200, 1080, 2400), (verdict as Verdict.Covered).scroller)
    }

    @Test
    fun `a full-screen host around a bar is not taken for the bar`() {
        val row = FakeNode(Box(0, 2250, 1080, 2400), takesTouches = true)
        val list = FakeNode(Box(0, 200, 1080, 2400), scrollsVertically = true).add(FakeNode(Box(0, 200, 1080, 2400)).add(row))
        val checkout = FakeNode(Box(0, 2200, 1080, 2400), takesTouches = true, name = "checkout")
        val host = FakeNode(screen, drawingOrder = 1).add(FakeNode(Box(0, 2200, 1080, 2400)).add(checkout))
        root(list, host)
        assertEquals(Box(0, 2200, 1080, 2400), coverBounds(analyze(row)))
    }

    @Test
    fun `with no drawing order, an image laid under a button is not a sticky row`() {
        // Compose before 1.9: Box { Image; Button } in a scrolling column,
        // every drawing order 0. The image is listed first but is a backdrop.
        val image = FakeNode(Box(0, 300, 1080, 900), name = "image \"Hero\"")
        val button = FakeNode(Box(40, 700, 1040, 850), takesTouches = true)
        root(list(image, button))
        assertClearAt(analyze(button), 540, 775)
    }

    @Test
    fun `with no drawing order, a row-sized background laid under a button is not a sticky row`() {
        // Compose before 1.9: Box { Image; Button(Modifier.matchParentSize()) },
        // every drawing order 0. The backdrop is the button's own size.
        val image = FakeNode(Box(0, 700, 1080, 850), name = "image \"Banner\"")
        val button = FakeNode(Box(0, 700, 1080, 850), takesTouches = true)
        root(list(image, button))
        assertClearAt(analyze(button), 540, 775)
    }

    @Test
    fun `with no drawing order, a backdrop enclosing a button within twice its height is not a sticky row`() {
        val image = FakeNode(Box(0, 680, 1080, 950), name = "image \"Banner\"")
        val button = FakeNode(Box(40, 700, 1040, 850), takesTouches = true)
        root(list(image, button))
        assertClearAt(analyze(button), 540, 775)
    }

    @Test
    fun `with no drawing order, a sticky header is not covered by the row scrolled under it`() {
        val header = FakeNode(Box(0, 300, 1080, 450), takesTouches = true, name = "header")
        val row = FakeNode(Box(0, 320, 1080, 470), name = "row 5")
        root(list(header, row))
        assertClearAt(analyze(header), 540, 375)
    }

    @Test
    fun `a wide later branch does not use up the sticky-row check either`() {
        val far = FakeNode(Box(0, 0, 1080, 100))
        repeat(OcclusionAnalyzer.MAX_NODES_VISITED + 500) { far.add(FakeNode(Box(0, 0, 1080, 100))) }
        val host = FakeNode(screen, drawingOrder = 2).add(far)
        val header = FakeNode(Box(0, 300, 1080, 450), name = "header")
        val row = FakeNode(Box(0, 320, 1080, 470), takesTouches = true)
        root(FakeNode(screen, drawingOrder = 1).add(list(header, row)), host)
        assertCoveredBy(analyze(row), "header")
    }

    @Test
    fun `a control inside a loading overlay over a list row is never scrolled away from`() {
        val row = FakeNode(Box(0, 2250, 1080, 2400), takesTouches = true)
        val rows = FakeNode(Box(0, 200, 1080, 2400), scrollsVertically = true).add(FakeNode(Box(0, 200, 1080, 2400)).add(row))
        val cancel = FakeNode(Box(0, 2200, 1080, 2400), takesTouches = true, name = "button \"Cancel\"")
        val overlay =
            FakeNode(
                Box(0, 1800, 1080, 2400),
                drawingOrder = 1,
            ).add(FakeNode(Box(490, 1850, 590, 1950), isProgressIndicator = true), cancel)
        root(rows, overlay)
        val verdict = analyze(row)
        assertCoveredBy(verdict, "button \"Cancel\"")
        assertEquals(null, (verdict as Verdict.Covered).scroller)
    }

    @Test
    fun `a drag start on the list itself is on the list`() {
        val row = FakeNode(Box(0, 2250, 1080, 2400), takesTouches = true)
        val list = list(FakeNode(Box(0, 2100, 1080, 2250), takesTouches = true), row)
        val footer = FakeNode(Box(0, 2200, 1080, 2400), drawingOrder = 1, takesTouches = true)
        root(list, footer)
        assertTrue(OcclusionAnalyzer.isDragStartOnList(row, 1, Box(0, 300, 1080, 2100), 540, 2180, listOf(appWindow)))
    }

    @Test
    fun `a drag start on a control laid over the list is not on the list`() {
        val row = FakeNode(Box(0, 2250, 1080, 2400), takesTouches = true)
        val list = list(row)
        val miniPlayer = FakeNode(Box(0, 2050, 1080, 2200), drawingOrder = 1, takesTouches = true)
        root(list, miniPlayer)
        assertFalse(OcclusionAnalyzer.isDragStartOnList(row, 1, Box(0, 300, 1080, 2100), 540, 2180, listOf(appWindow)))
    }

    @Test
    fun `a drag start under another window is not on the list`() {
        val row = FakeNode(Box(0, 2250, 1080, 2400), takesTouches = true)
        root(list(row))
        val dialog = WindowSpec(id = 4, kind = WindowKind.APPLICATION, layer = 2, bounds = screen, title = "Dialog")
        assertFalse(OcclusionAnalyzer.isDragStartOnList(row, 1, Box(0, 300, 1080, 2100), 540, 2180, listOf(appWindow, dialog)))
    }

    // ─── Covers in the target's own window ───

    @Test
    fun `a touchable sibling painted after the target covers it`() {
        val covered = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true, name = "covered")
        val overlay = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 2, takesTouches = true, name = "button \"Overlay\"")
        root(FakeNode(screen).add(covered, overlay))
        assertCoveredBy(analyze(covered), "button \"Overlay\"")
    }

    @Test
    fun `a sibling painted after that takes no touches does not cover it`() {
        // pointerEvents="none" overlays look exactly like this.
        val button = FakeNode(Box(40, 960, 1040, 1110), drawingOrder = 1, takesTouches = true)
        val passThrough = FakeNode(Box(40, 960, 1040, 1110), drawingOrder = 2, takesTouches = false)
        root(FakeNode(screen).add(button, passThrough))
        assertClearAt(analyze(button), 540, 1035)
    }

    @Test
    fun `a touchable sibling painted before the target does not cover it`() {
        val background = FakeNode(screen, drawingOrder = 1, takesTouches = true)
        val button = FakeNode(Box(40, 960, 1040, 1110), drawingOrder = 2, takesTouches = true)
        root(FakeNode(screen).add(background, button))
        assertClearAt(analyze(button), 540, 1035)
    }

    @Test
    fun `drawing order beats child order`() {
        // zIndex: the later child is drawn first, so the earlier one is on top.
        val onTop = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 5, takesTouches = true, name = "on top")
        val underneath = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true, name = "underneath")
        root(FakeNode(screen).add(onTop, underneath))
        assertCoveredBy(analyze(underneath), "on top")
        assertClearAt(analyze(onTop), 540, 855)
    }

    @Test
    fun `equal drawing orders fall back to child order`() {
        // Below API 24, and in Compose before 1.9, every node reports 0, and
        // child order is paint order.
        val first = FakeNode(Box(40, 780, 1040, 930), takesTouches = true, name = "first")
        val second = FakeNode(Box(40, 780, 1040, 930), takesTouches = true, name = "second")
        root(FakeNode(screen).add(first, second))
        assertCoveredBy(analyze(first), "second")
        assertClearAt(analyze(second), 540, 855)
    }

    @Test
    fun `a Flutter modal barrier listed after its dialog does not cover the dialog`() {
        // PILOT-932: every Flutter node reports drawing order 0, and the
        // route sorts its dismissible barrier after the dialog, though it is
        // painted under it.
        val cancel = FakeNode(Box(457, 1258, 634, 1384), takesTouches = true, name = "button \"Cancel\"")
        val logOut = FakeNode(Box(655, 1258, 845, 1384), takesTouches = true, name = "button \"Log out\"")
        val title = FakeNode(Box(236, 1016, 845, 1100))
        val dialog = FakeNode(Box(173, 953, 908, 1447)).add(title, cancel, logOut)
        val content = FakeNode(Box(0, 63, 1080, 2337)).add(dialog)
        val barrier = FakeNode(screen, takesTouches = true, offersDismiss = true, name = "element \"Dismiss\"")
        root(FakeNode(screen).add(content), barrier)
        assertClearAt(analyze(cancel), 545, 1321)
        assertClearAt(analyze(logOut), 750, 1321)
    }

    @Test
    fun `a dismissible sibling with content of its own still covers at drawing order 0`() {
        // A Flutter SnackBar or sheet offers dismiss too, but it is drawn
        // over the body, and its controls are its children.
        val button = FakeNode(Box(40, 2100, 1040, 2250), takesTouches = true)
        val undo = FakeNode(Box(400, 2120, 700, 2230), takesTouches = true, name = "button \"Undo\"")
        val snackBar = FakeNode(Box(0, 2080, 1080, 2270), offersDismiss = true).add(undo)
        root(FakeNode(screen).add(button), snackBar)
        assertCoveredBy(analyze(button), "button \"Undo\"")
    }

    @Test
    fun `a dismissible sibling drawn after the target still covers it`() {
        // Real drawing orders say the dismissible scrim is on top.
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        val scrim = FakeNode(screen, drawingOrder = 2, takesTouches = true, offersDismiss = true, name = "scrim")
        root(FakeNode(screen, drawingOrder = 1).add(button), scrim)
        assertCoveredBy(analyze(button), "scrim")
    }

    @Test
    fun `a first child reporting drawing order 0 is still covered by a later-drawn sibling`() {
        // Compose 1.9+ numbers its children's drawing order from 0, so a 0
        // beside a 1 is a real order.
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 0, takesTouches = true)
        val overlay = FakeNode(screen, drawingOrder = 1, takesTouches = true, offersDismiss = true, name = "scrim")
        root(FakeNode(screen, drawingOrder = 0).add(button), overlay)
        assertCoveredBy(analyze(button), "scrim")
    }

    @Test
    fun `the target's own touchable descendants are not covers`() {
        val label = FakeNode(Box(400, 820, 680, 880), drawingOrder = 1, takesTouches = true)
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true).add(label)
        root(FakeNode(screen).add(button))
        assertClearAt(analyze(button), 540, 855)
    }

    @Test
    fun `a touchable ancestor is not a cover`() {
        val text = FakeNode(Box(400, 820, 680, 880), drawingOrder = 1)
        val row = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true).add(text)
        root(FakeNode(screen).add(row))
        assertClearAt(analyze(text), 540, 850)
    }

    @Test
    fun `a touchable node painted after that misses the touch point is not a cover`() {
        val badge = FakeNode(Box(980, 780, 1040, 820), drawingOrder = 2, takesTouches = true)
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        root(FakeNode(screen).add(button, badge))
        assertClearAt(analyze(button), 540, 855)
    }

    @Test
    fun `a touchable node nested in a later non-touchable container covers the target`() {
        val dismiss = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true, name = "button \"Dismiss\"")
        val sheet = FakeNode(Box(0, 700, 1080, 1000), drawingOrder = 2).add(dismiss)
        val button = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        root(FakeNode(screen).add(button, sheet))
        assertCoveredBy(analyze(button), "button \"Dismiss\"")
    }

    @Test
    fun `a touchable node in an earlier-painted branch is not a cover however deep`() {
        // The target's branch (drawing order 2) is painted over the whole of
        // branch 1, including its deep touchable descendant.
        val deep = FakeNode(Box(40, 780, 1040, 930), takesTouches = true, name = "deep")
        val branch1 = FakeNode(screen, drawingOrder = 1).add(FakeNode(screen).add(deep))
        val target = FakeNode(Box(40, 780, 1040, 930), takesTouches = true)
        val branch2 = FakeNode(screen, drawingOrder = 2).add(FakeNode(screen).add(target))
        root(branch1, branch2)
        assertClearAt(analyze(target), 540, 855)
    }

    @Test
    fun `a cover several levels up is found`() {
        // A modal-style sibling of the target's great-grandparent.
        val target = FakeNode(Box(40, 780, 1040, 930), takesTouches = true)
        val content = FakeNode(screen, drawingOrder = 1).add(FakeNode(screen).add(FakeNode(screen).add(target)))
        val scrim = FakeNode(screen, drawingOrder = 2, takesTouches = true, name = "scrim")
        root(content, scrim)
        assertCoveredBy(analyze(target), "scrim")
    }

    @Test
    fun `an invisible touchable node is not a cover`() {
        val covered = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        val gone = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 2, isVisible = false, takesTouches = true)
        root(FakeNode(screen).add(covered, gone))
        assertClearAt(analyze(covered), 540, 855)
    }

    @Test
    fun `an invisible container hides its touchable children`() {
        val child = FakeNode(Box(40, 780, 1040, 930), takesTouches = true)
        val hidden = FakeNode(screen, drawingOrder = 2, isVisible = false).add(child)
        val covered = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        root(FakeNode(screen).add(covered, hidden))
        assertClearAt(analyze(covered), 540, 855)
    }

    @Test
    fun `the same-window check runs at the point left visible by the keyboard`() {
        // The keyboard moves the touch point up to y=1400; an overlay over
        // just that part covers the target, one over the hidden part does not.
        val tall = FakeNode(Box(40, 1300, 1040, 2340), drawingOrder = 1, takesTouches = true)
        val lowOverlay = FakeNode(Box(40, 1800, 1040, 2000), drawingOrder = 2, takesTouches = true, name = "low")
        root(FakeNode(screen).add(tall, lowOverlay))
        assertClearAt(analyze(tall, windows = listOf(appWindow, keyboard)), 540, 1400)

        val tall2 = FakeNode(Box(40, 1300, 1040, 2340), drawingOrder = 1, takesTouches = true)
        val highOverlay = FakeNode(Box(40, 1350, 1040, 1450), drawingOrder = 2, takesTouches = true, name = "high")
        root(FakeNode(screen).add(tall2, highOverlay))
        assertCoveredBy(analyze(tall2, windows = listOf(appWindow, keyboard)), "high")
    }

    @Test
    fun `wide ancestor levels count against the node budget`() {
        // Thousands of siblings at the target's own level must not be read
        // without limit: each read can be a blocking accessibility round-trip.
        val target = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        val misses = Array(OcclusionAnalyzer.MAX_NODES_VISITED * 3) { FakeNode(Box(0, 0, 10, 10), drawingOrder = 2) }
        root(FakeNode(screen).add(target, *misses))
        FakeNode.childReads = 0
        assertClearAt(analyze(target), 540, 855)
        assertTrue("read ${FakeNode.childReads} children", FakeNode.childReads <= OcclusionAnalyzer.MAX_NODES_VISITED * 2)
    }

    @Test
    fun `a target deep in a very wide level still sees an overlay at the root`() {
        // Finding the target's place among thousands of siblings must not use
        // up the budget the cover search needs for the root, where full-screen
        // overlays paint.
        val misses = Array(OcclusionAnalyzer.MAX_NODES_VISITED + 500) { FakeNode(Box(0, 0, 10, 10)) }
        val target = FakeNode(Box(40, 780, 1040, 930), takesTouches = true)
        val content = FakeNode(screen, drawingOrder = 1).add(*misses, target)
        val scrim = FakeNode(screen, drawingOrder = 2, takesTouches = true, name = "scrim")
        root(content, scrim)
        assertCoveredBy(analyze(target), "scrim")
    }

    @Test
    fun `a walk that runs past its node budget stops without naming a cover`() {
        // A pathological tree (thousands of nodes over the point) must not
        // stall the action: past the budget the check gives up on the tree.
        val target = FakeNode(Box(40, 780, 1040, 930), drawingOrder = 1, takesTouches = true)
        var chain = FakeNode(screen)
        val later = FakeNode(screen, drawingOrder = 2).add(chain)
        repeat(OcclusionAnalyzer.MAX_NODES_VISITED + 10) {
            val next = FakeNode(screen)
            chain.add(next)
            chain = next
        }
        chain.add(FakeNode(Box(40, 780, 1040, 930), takesTouches = true, name = "too deep"))
        root(FakeNode(screen).add(target, later))
        assertClearAt(analyze(target), 540, 855)
    }

    // ─── Naming covers ───

    @Test
    fun `covers are named by role and label`() {
        assertEquals("button \"Overlay\"", OcclusionAnalyzer.describeCover("android.widget.Button", "Overlay", null, null))
        assertEquals("button \"Close\"", OcclusionAnalyzer.describeCover("android.widget.ImageButton", "Close", null, null))
        assertEquals("text field \"Name\"", OcclusionAnalyzer.describeCover("android.widget.EditText", null, "Name", null))
        assertEquals("element \"scrim\"", OcclusionAnalyzer.describeCover("android.view.ViewGroup", null, null, "com.app:id/scrim"))
        assertEquals("element \"scrim\"", OcclusionAnalyzer.describeCover("android.view.ViewGroup", "", "", "scrim"))
        assertEquals("an unlabelled ViewGroup", OcclusionAnalyzer.describeCover("android.view.ViewGroup", null, null, null))
        assertEquals("an unlabelled element", OcclusionAnalyzer.describeCover(null, null, null, null))
    }

    @Test
    fun `long labels are shortened`() {
        val name = OcclusionAnalyzer.describeCover("android.widget.TextView", null, "x".repeat(200), null)
        assertTrue(name, name.length < 80)
        assertTrue(name, name.startsWith("text \"xxx"))
        assertTrue(name, name.endsWith("…\""))
    }
}

/** The identity a resolved target is re-checked against before it is touched (PILOT-362). */
class TargetIdentityTest {
    private val covered = TargetIdentity("android.widget.Button", null, "Covered action", null)

    @Test
    fun `the same element matches`() {
        assertTrue(covered.matches("android.widget.Button", null, "Covered action", null, isEditable = false))
    }

    @Test
    fun `a reused view showing another element does not match`() {
        // React reuses the native view for whatever renders next in its place.
        assertFalse(covered.matches("android.widget.Button", null, "Replacement action", null, isEditable = false))
        assertFalse(covered.matches("android.widget.TextView", null, "Covered action", null, isEditable = false))
        assertFalse(covered.matches("android.widget.Button", "app:id/other", "Covered action", null, isEditable = false))
    }

    @Test
    fun `a text change on a non-editable view does not match`() {
        val label = TargetIdentity("android.widget.TextView", null, null, "Submit")
        assertFalse(label.matches("android.widget.TextView", null, null, "Cancel", isEditable = false))
    }

    @Test
    fun `an editable field's text is its value, not its identity`() {
        val field = TargetIdentity("android.widget.EditText", "app:id/name", null, "Ada")
        assertTrue(field.matches("android.widget.EditText", "app:id/name", null, "Ada Lovelace", isEditable = true))
    }

    @Test
    fun `an element identified by label or id may change its own text`() {
        // A stopwatch or countdown button: its text is content, not identity.
        val byId = TargetIdentity("android.widget.Button", "app:id/record", null, "00:03.41")
        assertTrue(byId.matches("android.widget.Button", "app:id/record", null, "00:03.46", isEditable = false))
        val byLabel = TargetIdentity("android.widget.Button", null, "Record", "00:03.41")
        assertTrue(byLabel.matches("android.widget.Button", null, "Record", "00:03.46", isEditable = false))
    }

    @Test
    fun `only an element with no label, id or text of its own needs its content re-checked`() {
        // An unlabelled RN Pressable: its visible text lives in a child view,
        // so the fields above cannot tell it from a replacement in its place.
        assertTrue(TargetIdentity("android.view.ViewGroup", null, null, null).identifiedOnlyByContent)
        assertTrue(TargetIdentity("android.view.ViewGroup", "", "", "").identifiedOnlyByContent)
        assertFalse(TargetIdentity("android.view.ViewGroup", "app:id/save", null, null).identifiedOnlyByContent)
        assertFalse(TargetIdentity("android.widget.Button", null, "Save", null).identifiedOnlyByContent)
        assertFalse(TargetIdentity("android.widget.TextView", null, null, "Save").identifiedOnlyByContent)
    }

    @Test
    fun `null and empty strings are the same`() {
        val node = TargetIdentity("android.view.ViewGroup", "", null, "")
        assertTrue(node.matches("android.view.ViewGroup", null, "", null, isEditable = false))
    }
}
