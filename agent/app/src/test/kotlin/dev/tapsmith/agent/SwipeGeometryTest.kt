package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** Host-side tests for where a direction swipe starts and ends (PILOT-934). */
class SwipeGeometryTest {
    private val screen = HierarchyAttributes.Box(0, 0, 1080, 2400)

    @Test
    fun `a screen swipe crosses the middle of the screen`() {
        // The same points swipeScreen always used: centre ± half the length.
        assertEquals(SwipeGeometry.Points(540, 1920, 540, 480), SwipeGeometry.points(screen, "up", 0.6))
        assertEquals(SwipeGeometry.Points(540, 480, 540, 1920), SwipeGeometry.points(screen, "down", 0.6))
        assertEquals(SwipeGeometry.Points(864, 1200, 216, 1200), SwipeGeometry.points(screen, "left", 0.6))
        assertEquals(SwipeGeometry.Points(216, 1200, 864, 1200), SwipeGeometry.points(screen, "RIGHT", 0.6))
    }

    @Test
    fun `a region swipe stays inside the region`() {
        // A dialog's scroll content in the middle of the screen.
        val dialog = HierarchyAttributes.Box(100, 800, 980, 1600)
        assertEquals(SwipeGeometry.Points(540, 1440, 540, 960), SwipeGeometry.points(dialog, "up", 0.6))
        assertEquals(SwipeGeometry.Points(540, 960, 540, 1440), SwipeGeometry.points(dialog, "down", 0.6))
        assertEquals(SwipeGeometry.Points(804, 1200, 276, 1200), SwipeGeometry.points(dialog, "left", 0.6))
    }

    @Test
    fun `an unknown direction is refused`() {
        assertThrows(ActionFailedException::class.java) { SwipeGeometry.points(screen, "sideways", 0.6) }
    }

    @Test
    fun `an empty region is refused`() {
        assertThrows(ActionFailedException::class.java) {
            SwipeGeometry.points(HierarchyAttributes.Box(0, 500, 1080, 500), "up", 0.6)
        }
    }
}
