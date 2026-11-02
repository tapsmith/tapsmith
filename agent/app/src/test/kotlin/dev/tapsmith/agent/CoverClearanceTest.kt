package dev.tapsmith.agent

import dev.tapsmith.agent.CoverClearance.Drag
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The drag that scrolls a target out from under fixed chrome (PILOT-980). */
class CoverClearanceTest {
    private val screen = Box(0, 0, 1080, 2400)
    private val list = Box(0, 200, 1080, 2400)

    private fun drag(
        target: Box,
        cover: Box,
        list: Box = this.list,
    ) = CoverClearance.drag(target, cover, list, screen, margin = 20, slop = 16)

    @Test
    fun `a target under a sticky footer is dragged up just clear of it`() {
        // Footer 2200..2400; row 2250..2400 under it. Content must move up by
        // 2400 - (2200 - 20) = 220, plus the slop; the drag runs above the footer.
        assertEquals(Drag(540, 2180, 540, 1944), drag(Box(0, 2250, 1080, 2400), Box(0, 2200, 1080, 2400)))
    }

    @Test
    fun `a target under a sticky header is dragged down just clear of it`() {
        // Header 200..350 (top of the list); row 220..370 under it.
        assertEquals(Drag(540, 370, 540, 536), drag(Box(0, 220, 1080, 370), Box(0, 200, 1080, 350)))
    }

    @Test
    fun `a target too tall for the free part is centred in it`() {
        // Free part 200..1000 (800 tall, centre 600); target 300..1300 (centre 800).
        assertEquals(Drag(540, 980, 540, 764), drag(Box(0, 300, 1080, 1300), Box(0, 1000, 1080, 2400)))
    }

    @Test
    fun `a drag is capped at the free part`() {
        // Footer from 400: free part 200..400; the target needs a long move.
        assertEquals(Drag(540, 380, 540, 220), drag(Box(0, 1000, 1080, 1100), Box(0, 400, 1080, 2400)))
    }

    @Test
    fun `a cover that leaves no room gives no drag`() {
        assertNull(drag(Box(0, 300, 1080, 400), Box(0, 250, 1080, 2400)))
    }

    @Test
    fun `a target already clear of the cover gives no drag`() {
        assertNull(drag(Box(0, 1000, 1080, 1100), Box(0, 2200, 1080, 2400)))
    }

    @Test
    fun `a list off screen gives no drag`() {
        assertNull(drag(Box(0, 2500, 1080, 2600), Box(0, 2500, 1080, 2600), list = Box(0, 2450, 1080, 2900)))
    }

    @Test
    fun `the drag stays in the on-screen part of the list`() {
        // List runs past the bottom of the screen; the footer sits at 2200.
        assertEquals(
            Drag(540, 2180, 540, 1944),
            drag(Box(0, 2250, 1080, 2400), Box(0, 2200, 1080, 2400), list = Box(0, 200, 1080, 3000)),
        )
    }
}
