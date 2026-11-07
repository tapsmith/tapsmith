package dev.tapsmith.agent

/*
 * scrollIntoView()'s one-call scroll step (PILOT-998). One `scrollStep`
 * command drags the list, lets it go quiet, finds the element, and says
 * whether the list under the finger scrolled — where the SDK used to make a
 * probe find, a full hierarchy dump and a ~600 ms drag per step.
 *
 * Nothing here touches Android, so the JVM tests drive it with fakes.
 */

/** What a scroll step needs from the device. */
interface ScrollStepDevice<T> {
    fun now(): Long

    /** Wait until no accessibility event has arrived for [quietMs], at most [capMs]. */
    fun waitForQuiet(
        quietMs: Long,
        capMs: Long,
    )

    /** One fresh find of the step's selector. */
    fun find(): List<T>

    /** Make the step's drag; throws when the device refused it. */
    fun dragList()

    /** Arrival (uptime) of the last accessibility event that may mean the screen changed. */
    fun lastChangeAt(): Long

    /** Whether the scroll view under the drag's start scrolled at or after [since]; null: unknown. */
    fun scrolledUnderFingerSince(since: Long): Boolean?
}

/** What one step did. [moved] is null when the device could not tell. */
data class ScrollStepResult<T>(
    val elements: List<T>,
    val swiped: Boolean,
    val moved: Boolean?,
    val refinds: Int,
)

object ScrollStep {
    /**
     * Quiet before a step's find: just over React Native's 100 ms throttle on
     * a view's accessibility events, so a list still mounting the rows the
     * drag uncovered is waited for. 50 ms let every find start mid-mount.
     */
    const val QUIET_MS = 120L

    /** At most this long for that quiet: a screen that never goes quiet is read anyway. */
    const val QUIET_CAP_MS = 500L

    /** A miss is found again at most this many times while the screen changed under it. */
    const val MAX_REFINDS = 2

    /**
     * The first step's confirmation of the first miss (PILOT-283): the wait
     * the SDK's `waitForIdle(300)` made — 500 ms of quiet, at most 300 ms — so
     * a screen that has not started its transition yet still gets the time.
     * A 120 ms window once returned before a list screen had started to show,
     * and the first drag went across the previous screen.
     */
    const val CONFIRM_QUIET_MS = 500L
    const val CONFIRM_CAP_MS = 300L

    fun <T> run(
        device: ScrollStepDevice<T>,
        findFirst: Boolean,
        isVisible: (T) -> Boolean,
    ): ScrollStepResult<T> {
        if (findFirst) {
            device.waitForQuiet(CONFIRM_QUIET_MS, CONFIRM_CAP_MS)
            val first = device.find()
            if (first.any(isVisible)) return ScrollStepResult(first, swiped = false, moved = null, refinds = 0)
        }
        val dragStart = device.now()
        device.dragList()
        device.waitForQuiet(QUIET_MS, QUIET_CAP_MS)
        var findStart = device.now()
        var elements = device.find()
        // A miss counts only when the screen held still through the find: a
        // list still mounting the rows the drag uncovered (React Native
        // renders them a batch at a time, later under load) can hide the row,
        // and the next drag would carry it off unseen.
        var refinds = 0
        while (refinds < MAX_REFINDS && elements.none(isVisible)) {
            device.waitForQuiet(QUIET_MS, QUIET_CAP_MS)
            if (device.lastChangeAt() < findStart) break
            refinds++
            findStart = device.now()
            elements = device.find()
        }
        return ScrollStepResult(elements, swiped = true, moved = device.scrolledUnderFingerSince(dragStart), refinds = refinds)
    }
}

/**
 * The scroll container a step drags in when the SDK has none yet: the SDK's
 * rule (`scroll-container.ts`) for an element whose frame is unknown, on the
 * agent's own reading of the screen, so the first step needs no full
 * hierarchy dump. The largest scrollable shown in the topmost app window
 * (the smallest one that has a scrollable), leaving out one that a later
 * scrollable covers at its centre; clipped to the screen, its window and its
 * scrolling ancestors, less a keyboard or system bar across one of its edges.
 */
internal object ScrollContainerPick {
    /** The smallest region worth dragging in, either way. */
    const val MIN_REGION = 48

    /**
     * One scrollable node, in drawing order ([order]: a later one is drawn
     * over an earlier one). [bounds] are already clipped to its scrolling
     * ancestors, whose orders are [ancestors].
     */
    data class Candidate(
        val window: Int,
        val bounds: HierarchyAttributes.Box,
        val order: Int,
        val ancestors: Set<Int>,
    )

    fun pick(
        screen: HierarchyAttributes.Box,
        windows: List<HierarchyAttributes.Box>,
        candidates: List<Candidate>,
        covers: List<HierarchyAttributes.Box>,
    ): HierarchyAttributes.Box? {
        data class Shown(
            val c: Candidate,
            val r: HierarchyAttributes.Box,
        )
        val shown =
            candidates.mapNotNull { c ->
                val onScreen = intersect(c.bounds, screen) ?: return@mapNotNull null
                val w = windows.getOrNull(c.window)
                var box = (if (w != null) intersect(onScreen, w) else onScreen) ?: return@mapNotNull null
                for (cover in covers) box = trimEdge(box, cover)
                if (box.right - box.left >= MIN_REGION && box.bottom - box.top >= MIN_REGION) Shown(c, box) else null
            }
        if (shown.isEmpty()) return null

        fun windowArea(s: Shown): Long =
            windows.getOrNull(s.c.window)?.let { w -> intersect(w, screen)?.let { area(it) } } ?: Long.MAX_VALUE
        val top = shown.minOf { windowArea(it) }
        val inTop = shown.filter { windowArea(it) == top }
        val uncovered =
            inTop.filter { s ->
                inTop.none { d ->
                    d.c.order > s.c.order && s.c.order !in d.c.ancestors && containsCentre(d.r, s.r)
                }
            }
        return (uncovered.ifEmpty { inTop }).maxBy { area(it.r) }.r
    }

    internal fun intersect(
        a: HierarchyAttributes.Box,
        b: HierarchyAttributes.Box,
    ): HierarchyAttributes.Box? {
        val r =
            HierarchyAttributes.Box(
                maxOf(a.left, b.left),
                maxOf(a.top, b.top),
                minOf(a.right, b.right),
                minOf(a.bottom, b.bottom),
            )
        return if (r.right > r.left && r.bottom > r.top) r else null
    }

    private fun area(r: HierarchyAttributes.Box): Long = (r.right - r.left).toLong() * (r.bottom - r.top)

    private fun containsCentre(
        r: HierarchyAttributes.Box,
        of: HierarchyAttributes.Box,
    ): Boolean {
        // Doubled, so an odd size's centre is not rounded onto an edge.
        val cx2 = of.left + of.right
        val cy2 = of.top + of.bottom
        return cx2 >= 2 * r.left && cx2 < 2 * r.right && cy2 >= 2 * r.top && cy2 < 2 * r.bottom
    }

    /** [r] less [c] when [c] covers one whole edge of it; unchanged otherwise. */
    internal fun trimEdge(
        r: HierarchyAttributes.Box,
        c: HierarchyAttributes.Box,
    ): HierarchyAttributes.Box {
        if (intersect(r, c) == null) return r
        if (c.left <= r.left && c.right >= r.right) {
            if (c.top <= r.top) return r.copy(top = minOf(r.bottom, maxOf(r.top, c.bottom)))
            if (c.bottom >= r.bottom) return r.copy(bottom = maxOf(r.top, minOf(r.bottom, c.top)))
        }
        if (c.top <= r.top && c.bottom >= r.bottom) {
            if (c.left <= r.left) return r.copy(left = minOf(r.right, maxOf(r.left, c.right)))
            if (c.right >= r.right) return r.copy(right = maxOf(r.left, minOf(r.right, c.left)))
        }
        return r
    }
}
