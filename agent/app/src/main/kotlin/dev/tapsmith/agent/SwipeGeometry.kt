package dev.tapsmith.agent

/**
 * Where a direction swipe starts and ends: through the centre of a box, its
 * length `distance` of the box's size along the swipe, half on each side of
 * the centre. The box is the screen for a screen swipe, or the region the SDK
 * sends — the scroll container `scrollIntoView()` picked (PILOT-934), so the
 * swipe cannot land outside a dialog or on a header above the list.
 */
internal object SwipeGeometry {
    data class Points(
        val fromX: Int,
        val fromY: Int,
        val toX: Int,
        val toY: Int,
    )

    fun points(
        box: HierarchyAttributes.Box,
        direction: String,
        distance: Double,
    ): Points {
        if (box.right <= box.left || box.bottom <= box.top) {
            throw ActionFailedException(
                "Cannot swipe in an empty region [${box.left},${box.top}][${box.right},${box.bottom}]",
            )
        }
        val cx = (box.left + box.right) / 2
        val cy = (box.top + box.bottom) / 2
        val vertical = (box.bottom - box.top) * distance
        val horizontal = (box.right - box.left) * distance
        return when (direction.lowercase()) {
            "up" -> (vertical.toInt() / 2).let { Points(cx, cy + it, cx, cy - it) }
            "down" -> (vertical.toInt() / 2).let { Points(cx, cy - it, cx, cy + it) }
            "left" -> (horizontal.toInt() / 2).let { Points(cx + it, cy, cx - it, cy) }
            "right" -> (horizontal.toInt() / 2).let { Points(cx - it, cy, cx + it, cy) }
            else -> throw ActionFailedException("Unknown swipe direction: $direction. Use up/down/left/right.")
        }
    }
}
