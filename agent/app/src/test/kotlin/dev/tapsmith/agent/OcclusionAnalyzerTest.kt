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
        override val isScrollContainer: Boolean = false,
        override val isNamed: Boolean = false,
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
        plainViewsTakeTouches: Boolean = false,
    ): Verdict =
        OcclusionAnalyzer.analyze(
            target = target,
            targetBounds = bounds,
            targetWindowId = targetWindowId,
            windows = windows,
            screen = screen,
            plainViewsTakeTouches = plainViewsTakeTouches,
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

    // ─── One control split in two: an empty wrapper and its touch surface ───

    /**
     * A React Native header menu button: `testID` on a plain wrapper View
     * around a native menu view that takes the touches itself. The tree
     * reports the two as siblings under a parent with the wrapper's bounds,
     * the wrapper empty and not touchable (copied from a real dump).
     */
    private class SplitControl(
        wrapperTakesTouches: Boolean = false,
        surfaceBounds: Box = Box(952, 89, 1010, 183),
    ) {
        val icon = FakeNode(Box(952, 90, 1010, 148), drawingOrder = 1, name = "an unlabelled TextView")
        val wrapper =
            FakeNode(
                Box(923, 78, 1038, 194),
                drawingOrder = 1,
                takesTouches = wrapperTakesTouches,
                isNamed = true,
                name = "element \"HeaderMenuButton\"",
            )
        val surface = FakeNode(surfaceBounds, drawingOrder = 2, takesTouches = true, name = "an unlabelled ViewGroup").add(icon)
        val shell = FakeNode(Box(923, 78, 1038, 194), drawingOrder = 4).add(wrapper, surface)
        val back = FakeNode(Box(0, 63, 147, 210), drawingOrder = 1, takesTouches = true, name = "button \"Navigate up\"")
        val title = FakeNode(Box(189, 101, 453, 172), drawingOrder = 2, isNamed = true, name = "text \"Add Wallet\"")
        val header = FakeNode(Box(0, 0, 1080, 210), drawingOrder = 1).add(back, title, shell)
    }

    @Test
    fun `an empty wrapper is not covered by its own touch surface laid beside it`() {
        val control = SplitControl()
        root(FakeNode(screen).add(control.header))
        assertClearAt(analyze(control.wrapper), 980, 136)
    }

    @Test
    fun `a touch surface nested in the wrapper's later sibling is its own too`() {
        val surface = FakeNode(Box(952, 89, 1010, 183), drawingOrder = 1, takesTouches = true, name = "surface")
        val holder = FakeNode(Box(952, 89, 1010, 183), drawingOrder = 2).add(surface)
        val wrapper = FakeNode(Box(923, 78, 1038, 194), drawingOrder = 1, isNamed = true)
        root(FakeNode(screen).add(FakeNode(Box(923, 78, 1038, 194), drawingOrder = 4).add(wrapper, holder)))
        assertClearAt(analyze(wrapper), 980, 136)
    }

    @Test
    fun `a touch surface filling the whole wrapper is its own too`() {
        // What clipping makes of a surface laid out as big as its wrapper.
        val control = SplitControl(surfaceBounds = Box(923, 78, 1038, 194))
        root(FakeNode(screen).add(control.header))
        assertClearAt(analyze(control.wrapper), 980, 136)
    }

    @Test
    fun `a touchable target is still covered by a touchable sibling over it`() {
        val control = SplitControl(wrapperTakesTouches = true)
        root(FakeNode(screen).add(control.header))
        assertCoveredBy(analyze(control.wrapper), "an unlabelled ViewGroup")
    }

    @Test
    fun `a sibling reaching beyond the wrapper still covers it`() {
        // Bounds unclipped (as Compose reports them): the sibling is not
        // wholly inside the target. A View's would be clipped to the shell.
        val control = SplitControl(surfaceBounds = Box(900, 60, 1060, 220))
        root(FakeNode(screen).add(control.header))
        assertCoveredBy(analyze(control.wrapper), "an unlabelled ViewGroup")
    }

    @Test
    fun `an overlay in a parent larger than the wrapper still covers it`() {
        val wrapper = FakeNode(Box(923, 78, 1038, 194), drawingOrder = 1, isNamed = true)
        val overlay = FakeNode(Box(940, 80, 1030, 190), drawingOrder = 2, takesTouches = true, name = "button \"Overlay\"")
        root(FakeNode(Box(0, 0, 1080, 210), drawingOrder = 1).add(wrapper, overlay))
        assertCoveredBy(analyze(wrapper), "button \"Overlay\"")
    }

    @Test
    fun `a wrapper with content of its own is still covered by a touchable sibling`() {
        // Not an empty wrapper: a card whose label is drawn, with a button laid over it.
        val label = FakeNode(Box(930, 100, 1030, 170), drawingOrder = 1, isNamed = true)
        val card = FakeNode(Box(923, 78, 1038, 194), drawingOrder = 1).add(label)
        val overlay = FakeNode(Box(952, 89, 1010, 183), drawingOrder = 2, takesTouches = true, name = "button \"Overlay\"")
        root(FakeNode(Box(923, 78, 1038, 194), drawingOrder = 1).add(card, overlay))
        assertCoveredBy(analyze(card), "button \"Overlay\"")
    }

    @Test
    fun `a full-screen modal over the split control still covers it`() {
        val control = SplitControl()
        val modal = FakeNode(screen, drawingOrder = 2, takesTouches = true, name = "scrim")
        root(FakeNode(screen, drawingOrder = 1).add(control.header), modal)
        assertCoveredBy(analyze(control.wrapper), "scrim")
    }

    @Test
    fun `a spinner over the split control is still a loading overlay`() {
        val control = SplitControl()
        val spinner = FakeNode(Box(500, 1100, 580, 1180), isProgressIndicator = true)
        val overlay = FakeNode(screen, drawingOrder = 2, name = "veil").add(spinner)
        root(FakeNode(screen, drawingOrder = 1).add(control.header), overlay)
        assertEquals(OcclusionAnalyzer.CoverKind.LOADING, coverKind(analyze(control.wrapper)))
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

    // ─── Bars laid over a scroll view (PILOT-1424) ───

    // A React Native screen: a status line, a list from y=200 to y=2000, and a
    // checkout bar the screen lays over the list's bottom 160 px.
    private val listBounds = Box(0, 200, 1080, 2000)

    private fun row(
        top: Int,
        height: Int = 120,
    ) = FakeNode(Box(40, top, 1040, top + height), takesTouches = true, isNamed = true, name = "button \"Row\"")

    private fun list(vararg rows: FakeNode) =
        FakeNode(listBounds, isScrollContainer = true, name = "list").add(FakeNode(listBounds).add(*rows))

    private fun checkoutBar(vararg content: FakeNode) =
        FakeNode(Box(0, 1840, 1080, 2000), isNamed = true, name = "element \"checkout-bar\"").add(*content)

    private fun screenOf(vararg children: FakeNode) =
        root(FakeNode(screen).add(FakeNode(Box(0, 63, 1080, 200), isNamed = true, name = "status"), *children))

    @Test
    fun `a row wholly under a bar laid over its list is covered by the bar`() {
        val target = row(1860)
        screenOf(list(target), checkoutBar())
        val verdict = analyze(target, plainViewsTakeTouches = true)
        assertCoveredBy(verdict, "element \"checkout-bar\"")
        assertEquals(OcclusionAnalyzer.CoverKind.BAR, coverKind(verdict))
    }

    @Test
    fun `a row partly under the bar is touched on the part left showing`() {
        val target = row(1780)
        screenOf(list(target), checkoutBar())
        // 1780..1840 shows above the bar.
        assertClearAt(analyze(target, plainViewsTakeTouches = true), 540, 1810)
    }

    @Test
    fun `a row clear of the bar is touched at its center`() {
        val target = row(1000)
        screenOf(list(target), checkoutBar())
        assertClearAt(analyze(target, plainViewsTakeTouches = true), 540, 1060)
    }

    @Test
    fun `in an app where plain views let touches through the bar is no cover`() {
        // Native, Compose and Flutter views that take no touches pass them on.
        val target = row(1860)
        screenOf(list(target), checkoutBar())
        assertClearAt(analyze(target), 540, 1920)
    }

    @Test
    fun `a bar named only by its text is named by what it holds`() {
        val target = row(1860)
        val text = FakeNode(Box(40, 1890, 1040, 1950), isNamed = true, name = "text \"Checkout\"")
        screenOf(list(target), FakeNode(Box(0, 1840, 1080, 2000), name = "an unlabelled ViewGroup").add(text))
        assertCoveredBy(analyze(target, plainViewsTakeTouches = true), "a bar holding text \"Checkout\"")
    }

    @Test
    fun `a nameless view over the list is no cover`() {
        // A pointerEvents="none" fade over the list's foot looks like this.
        val target = row(1860)
        screenOf(list(target), FakeNode(Box(0, 1840, 1080, 2000), name = "fade"))
        assertClearAt(analyze(target, plainViewsTakeTouches = true), 540, 1920)
    }

    @Test
    fun `a view over most of the list is no bar`() {
        // A screen-sized wrapper (a toast host, the test hooks marker's).
        val target = row(1860)
        val toast = FakeNode(Box(100, 300, 980, 400), isNamed = true, name = "toast")
        screenOf(list(target), FakeNode(Box(0, 200, 1080, 2000)).add(toast))
        assertClearAt(analyze(target, plainViewsTakeTouches = true), 540, 1920)
    }

    @Test
    fun `a narrow badge over the list's edge is no bar`() {
        val target = row(1860)
        screenOf(list(target), FakeNode(Box(900, 1840, 1080, 2000), isNamed = true, name = "badge"))
        assertClearAt(analyze(target, plainViewsTakeTouches = true), 540, 1920)
    }

    @Test
    fun `a banner across the middle of the list is no bar`() {
        val target = row(1000)
        screenOf(list(target), FakeNode(Box(0, 960, 1080, 1120), isNamed = true, name = "banner"))
        assertClearAt(analyze(target, plainViewsTakeTouches = true), 540, 1060)
    }

    @Test
    fun `a bar painted before the list is under it`() {
        val target = row(1860)
        screenOf(checkoutBar(), list(target))
        assertClearAt(analyze(target, plainViewsTakeTouches = true), 540, 1920)
    }

    @Test
    fun `a view inside the list's own content is no bar`() {
        // A floating label or a sticky header scrolls with the list.
        val target = row(1860)
        val inside = FakeNode(Box(0, 1840, 1080, 2000), isNamed = true, name = "label")
        val content = FakeNode(listBounds).add(target, inside)
        screenOf(FakeNode(listBounds, isScrollContainer = true).add(content))
        assertClearAt(analyze(target, plainViewsTakeTouches = true), 540, 1920)
    }

    @Test
    fun `a named view over a target in no scroll view is no bar`() {
        val target = row(1860)
        screenOf(FakeNode(listBounds).add(target), checkoutBar())
        assertClearAt(analyze(target, plainViewsTakeTouches = true), 540, 1920)
    }

    @Test
    fun `a bar over the top of the list covers the rows under it`() {
        val target = row(210)
        screenOf(list(target), FakeNode(Box(0, 200, 1080, 360), isNamed = true, name = "header"))
        assertCoveredBy(analyze(target, plainViewsTakeTouches = true), "header")
    }

    @Test
    fun `a mini player stacked on a tab bar covers the rows under it`() {
        val target = row(1700)
        val tabBar = FakeNode(Box(0, 1840, 1080, 2000), isNamed = true, name = "tab bar")
        val player = FakeNode(Box(0, 1680, 1080, 1840), isNamed = true, name = "mini player")
        screenOf(list(target), player, tabBar)
        assertCoveredBy(analyze(target, plainViewsTakeTouches = true), "mini player")
    }

    @Test
    fun `a bar nested in a later full-screen wrapper still covers`() {
        val target = row(1860)
        screenOf(list(target), FakeNode(screen).add(checkoutBar()))
        assertCoveredBy(analyze(target, plainViewsTakeTouches = true), "element \"checkout-bar\"")
    }

    @Test
    fun `a button in the bar over the row is named before the bar`() {
        val target = row(1860)
        val pay = FakeNode(Box(300, 1850, 780, 1990), takesTouches = true, name = "button \"Pay\"")
        screenOf(list(target), checkoutBar(pay))
        assertCoveredBy(analyze(target, plainViewsTakeTouches = true), "button \"Pay\"")
    }

    @Test
    fun `a text inside a row under the bar is covered too`() {
        val label = FakeNode(Box(60, 1880, 600, 1960), isNamed = true, name = "text")
        val target = row(1860).add(label)
        screenOf(list(target), checkoutBar())
        assertCoveredBy(analyze(label, plainViewsTakeTouches = true), "element \"checkout-bar\"")
    }

    @Test
    fun `an invisible bar is no cover`() {
        val target = row(1860)
        screenOf(list(target), FakeNode(Box(0, 1840, 1080, 2000), isVisible = false, isNamed = true, name = "bar"))
        assertClearAt(analyze(target, plainViewsTakeTouches = true), 540, 1920)
    }

    @Test
    fun `a row in a carousel under a bar laid over the feed is covered`() {
        val target = FakeNode(Box(40, 1860, 400, 1980), takesTouches = true, name = "card")
        val carousel = FakeNode(Box(0, 1850, 1080, 1990), isScrollContainer = true).add(FakeNode(Box(0, 1850, 1080, 1990)).add(target))
        screenOf(list(carousel), checkoutBar())
        assertCoveredBy(analyze(target, plainViewsTakeTouches = true), "element \"checkout-bar\"")
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
