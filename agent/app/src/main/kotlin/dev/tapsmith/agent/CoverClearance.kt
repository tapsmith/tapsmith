package dev.tapsmith.agent

/**
 * The drag that scrolls a target out from under fixed chrome in its own
 * window — a sticky header or footer, a bottom bar's button — as a user would
 * before tapping it (PILOT-980). Playwright does the same when an element
 * "intercepts pointer events": it scrolls the target to another alignment and
 * tries again.
 *
 * The drag runs through the part of the list the cover leaves free, so it
 * never starts on the cover, and moves the content just far enough to bring
 * the whole target clear (or, for a target too tall for the free part, its
 * centre to the middle of it). A drag that would be too short to scroll
 * reliably, or a cover that leaves no room, gives null: there is nothing to
 * scroll to, and the cover is waited out as before.
 *
 * Pure geometry, so the JVM unit tests reach it.
 */
object CoverClearance {
    /** A drag from ([fromX], [fromY]) to ([toX], [toY]), screen pixels. */
    data class Drag(
        val fromX: Int,
        val fromY: Int,
        val toX: Int,
        val toY: Int,
    )

    /**
     * @param target where the target is now.
     * @param cover what covers it.
     * @param list the vertical list holding the target but not the cover.
     * @param screen the display.
     * @param margin clearance kept between the target and the cover, and
     *   between the drag and the free part's edges.
     * @param slop how far a finger moves before the list starts scrolling
     *   (the platform's touch slop), added to the drag.
     */
    fun drag(
        target: Box,
        cover: Box,
        list: Box,
        screen: Box,
        margin: Int,
        slop: Int,
    ): Drag? {
        val area = list.intersect(screen)
        if (area.isEmpty) return null
        val targetMid = (target.top + target.bottom) / 2
        // A footer sits in the list's lower half, a header in its upper half
        // (the target may be anywhere under either).
        val coverBelow = (cover.top + cover.bottom) / 2 > (area.top + area.bottom) / 2
        // The part of the list the cover leaves free, along the scroll axis.
        val freeTop = if (coverBelow) area.top else maxOf(area.top, cover.bottom)
        val freeBottom = if (coverBelow) minOf(area.bottom, cover.top) else area.bottom
        val free = freeBottom - freeTop
        if (free < 4 * margin) return null
        val fits = target.height + 2 * margin <= free
        // How far the content must move: up (negative) when the cover is below.
        val move =
            if (coverBelow) {
                if (fits) freeBottom - margin - target.bottom else (freeTop + freeBottom) / 2 - targetMid
            } else {
                if (fits) freeTop + margin - target.top else (freeTop + freeBottom) / 2 - targetMid
            }
        // Already clear, or moving the wrong way (the cover is not over it).
        if (if (coverBelow) move >= 0 else move <= 0) return null
        val x = (area.left + area.right) / 2
        val reach = free - 2 * margin
        val distance = minOf(Math.abs(move) + slop, reach)
        if (distance <= slop + margin) return null
        return if (coverBelow) {
            val from = freeBottom - margin
            Drag(x, from, x, from - distance)
        } else {
            val from = freeTop + margin
            Drag(x, from, x, from + distance)
        }
    }
}
