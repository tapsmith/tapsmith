package dev.tapsmith.agent

/** An integer screen rectangle, [left, right) × [top, bottom). A plain value
 *  type rather than android.graphics.Rect so the analyzer runs in JVM unit
 *  tests. */
data class Box(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
    val isEmpty: Boolean get() = width <= 0 || height <= 0
    val area: Long get() = if (isEmpty) 0 else width.toLong() * height

    fun contains(
        x: Int,
        y: Int,
    ): Boolean = x >= left && x < right && y >= top && y < bottom

    fun intersects(other: Box): Boolean = !intersect(other).isEmpty

    fun contains(other: Box): Boolean = other.left >= left && other.top >= top && other.right <= right && other.bottom <= bottom

    fun intersect(other: Box): Box =
        Box(
            maxOf(left, other.left),
            maxOf(top, other.top),
            minOf(right, other.right),
            minOf(bottom, other.bottom),
        )
}

/**
 * Decides whether an element-addressed touch would land on the element or on
 * something drawn over it (PILOT-362, the Android counterpart of the iOS
 * agent's OcclusionAnalyzer from PILOT-223).
 *
 * The agent injects touches at screen coordinates, and a coordinate touch
 * lands on whatever is on top. What counts as a cover:
 *
 * - **Windows above the target's window**: the software keyboard (the
 *   `TYPE_INPUT_METHOD` window, named "the keyboard"), system bars and other
 *   system windows, and app windows stacked on top (dialogs, popups). They
 *   clip the element: a target partly under one is touched at the center of
 *   what is left visible, the way Playwright clicks the in-viewport part of a
 *   partly scrolled-out element. The keyboard is checked even when the
 *   target's window is unknown, since it is drawn over every app window.
 *   Android hides a view that is *entirely* behind the keyboard from the
 *   accessibility tree, so that case rarely reaches here — the element is
 *   simply not found.
 * - **A touchable node painted after the target in its own window**: a node
 *   that is not the target, its ancestor, or its descendant, drawn later
 *   (drawing order, then child order, at the level where its branch splits
 *   from the target's), visible, containing the touch point, and clickable or
 *   long-clickable. Nodes that take no touches are never named: a
 *   `pointerEvents="none"` overlay looks exactly like any other plain view,
 *   and Android has no accessibility hit test to tell them apart. A plain view
 *   that does swallow touches is a known gap (PILOT-364 on iOS).
 *
 *   One exception (PILOT-932): a Flutter route's modal barrier, the
 *   full-window "Dismiss" node behind a dialog, bottom sheet or menu, is not
 *   a cover of the route's own content. Flutter reports drawing order 0 for
 *   every node and sorts the barrier after the route's content in traversal
 *   order, though it is painted under it, so child order would make it cover
 *   every control in every Flutter dialog. It is recognised as a later
 *   sibling with no children that offers the dismiss action (Flutter's
 *   barrier always does: one that cannot be dismissed is left out of the
 *   tree), with no drawing order to tell the two apart (both 0). A SnackBar
 *   or sheet offers dismiss too, but it is drawn on top, and its controls
 *   are its children. Other siblings without drawing
 *   order still fall back to child order: Compose before 1.9, and every app
 *   below API 24, report 0 for all nodes, and there child order is paint
 *   order.
 * - **A loading overlay** (PILOT-979): a node painted after the target, over
 *   the touch point, that is a progress indicator (a ProgressBar — React
 *   Native's ActivityIndicator is one) or holds a visible one. Apps lay one
 *   over a screen while it loads, often see-through, and it takes the
 *   touches though nothing in it is clickable. This is the one plain view
 *   that is named: a spinner over the point says "wait", whether or not the
 *   overlay passes touches through. Kind [CoverKind.LOADING].
 * - **A sticky list row** (PILOT-979): another row of the vertical list the
 *   target's row is in, at least as wide as the target, over the touch point.
 *   A list's rows do not overlap, except a section header stuck to the top
 *   (or a footer to the bottom) over the rows scrolling under it — and
 *   Android lists order their children by place, so such a header comes
 *   before the row it is drawn over, and it rarely takes touches itself.
 *
 * A cover in the target's own window that the list holding the target can
 * scroll away from (a sticky row, or a control outside the list, such as a
 * sticky footer's button) carries that list's bounds as
 * [Verdict.Covered.scroller], for [TouchPlanner] to drag the target clear
 * (PILOT-980).
 *
 * No Android dependencies — the tree and the windows come in through
 * [HitNode] and [WindowSpec] so the JVM unit tests can build them by hand.
 */
object OcclusionAnalyzer {
    /** Smallest visible extent (px, each axis) worth touching: anything
     *  thinner risks the integer touch point landing just outside. */
    const val MIN_VISIBLE_EXTENT = 2

    /** Upper bound on child nodes read when searching the target's window for
     *  a cover — each read can be a blocking accessibility round-trip — so a
     *  pathological tree cannot stall an action. Past it the tree check gives
     *  up and names no cover. */
    const val MAX_NODES_VISITED = 2000

    /** Separate allowance for finding the target's place at each ancestor
     *  level: the cover search must always reach the root (where full-screen
     *  overlays paint), however wide a level the target sits in. */
    const val MAX_PATH_NODES_VISITED = 10_000

    private const val MAX_LABEL_LENGTH = 40

    sealed class Verdict {
        /** Nothing covers ([x], [y]) — touch there. [visible] is the part of
         *  the element the windows above leave uncovered ([x], [y] is its
         *  center), for callers that want a different spot inside it. */
        data class Clear(
            val x: Int,
            val y: Int,
            val visible: Box,
        ) : Verdict()

        /** The element is covered, by the thing [by] names ("the keyboard",
         *  `button "Overlay"`), of [kind]. */
        data class Covered(
            val by: String,
            val kind: CoverKind,
            /** The cover's bounds on screen. */
            val bounds: Box,
            /** The bounds of the vertical list that holds the target but not
             *  the cover — the list to scroll the target clear of it — or null
             *  when there is none, or the cover is not one to scroll away
             *  from (the keyboard, a window, a loading overlay). */
            val scroller: Box? = null,
        ) : Verdict()

        /** No part of the element is on screen. */
        object OffScreen : Verdict() {
            override fun toString() = "OffScreen"
        }
    }

    enum class WindowKind { INPUT_METHOD, SYSTEM, APPLICATION, OTHER }

    /** What a cover is. A focused field under the keyboard or a control on
     *  its own screen still gets the input; under another window it does
     *  not — that window has the input focus. */
    enum class CoverKind { KEYBOARD, WINDOW, CONTROL, LOADING }

    data class WindowSpec(
        val id: Int,
        val kind: WindowKind,
        /** Z-order: higher is drawn on top. */
        val layer: Int,
        val bounds: Box,
        val title: String?,
    )

    /** One accessibility node, as far as hit-testing needs it. */
    interface HitNode {
        /** Bounds on screen (Android clips them to the parent's). */
        val bounds: Box
        val drawingOrder: Int
        val isVisible: Boolean

        /** Clickable or long-clickable: a node that intercepts a touch. */
        val takesTouches: Boolean

        /** Offers the dismiss action (a Flutter modal barrier does). */
        val offersDismiss: Boolean get() = false

        /** A spinner or a progress bar (Android's ProgressBar and its
         *  subclasses, Compose's progress indicators). */
        val isProgressIndicator: Boolean get() = false

        /** A scroll container that scrolls up and down (a vertical list). */
        val scrollsVertically: Boolean get() = false

        fun parent(): HitNode?

        fun childCount(): Int

        fun child(index: Int): HitNode?

        /** Whether this is the same node as [other] (accessibility identity,
         *  not bounds). */
        fun sameAs(other: HitNode): Boolean

        /** How to name this node as a cover, e.g. `button "Overlay"`. */
        fun describe(): String
    }

    /**
     * @param target the target's accessibility node, or null when it could not
     *   be read (the window checks still run).
     * @param targetBounds where the target is on screen now.
     * @param targetWindowId the id of the window the target lives in, or null
     *   when unknown (then only the keyboard counts among windows).
     */
    fun analyze(
        target: HitNode?,
        targetBounds: Box,
        targetWindowId: Int?,
        windows: List<WindowSpec>,
        screen: Box,
    ): Verdict {
        val onScreen = targetBounds.intersect(screen)
        if (!isTouchable(onScreen)) return Verdict.OffScreen

        val covers = coveringWindows(windows, targetWindowId)

        // The framework calls a view invisible when nothing of it is left to
        // see — for a view on screen, because a window above (the keyboard, a
        // dialog) hides it. Name that window so the cover is waited out: the
        // topmost one that hides all of it, else the topmost that overlaps it
        // (one that only grazes its edge is not what hides it). With none, the
        // view really is not on screen.
        if (target != null && !target.isVisible) {
            val window =
                covers.firstOrNull { it.bounds.contains(onScreen) }
                    ?: covers.firstOrNull { it.bounds.intersects(onScreen) }
            return if (window != null) covered(window) else Verdict.OffScreen
        }

        // Every piece the windows leave uncovered, not just the largest so
        // far: a later window can cover that one and leave a smaller piece
        // untouched.
        var pieces = listOf(onScreen)
        for (window in covers) {
            if (pieces.none { it.intersects(window.bounds) }) continue
            pieces = pieces.flatMap { if (it.intersects(window.bounds)) remainders(it, window.bounds) else listOf(it) }
            if (pieces.isEmpty()) return covered(window)
        }
        val visible = pieces.maxBy { it.area }

        val x = (visible.left + visible.right) / 2
        val y = (visible.top + visible.bottom) / 2
        if (target != null) {
            findCoverInWindow(target, onScreen, x, y)?.let { return it }
        }
        return Verdict.Clear(x, y, visible)
    }

    /**
     * Name a node for a "covered by …" message: its role from the class name
     * and its label (content description, text, or resource id), e.g.
     * `button "Overlay"`.
     */
    fun describeCover(
        className: String?,
        contentDescription: String?,
        text: String?,
        resourceId: String?,
    ): String {
        val simpleName = className?.substringAfterLast('.')?.takeIf { it.isNotEmpty() }
        val label =
            listOf(contentDescription, text, resourceId?.substringAfter(":id/"))
                .firstOrNull { !it.isNullOrBlank() }
                ?.let { if (it.length > MAX_LABEL_LENGTH) it.take(MAX_LABEL_LENGTH) + "…" else it }
        if (label == null) return "an unlabelled ${simpleName ?: "element"}"
        return "${roleOf(simpleName)} \"$label\""
    }

    // ─── Windows ───

    /** Windows that can be drawn over the target, topmost first. */
    private fun coveringWindows(
        windows: List<WindowSpec>,
        targetWindowId: Int?,
    ): List<WindowSpec> {
        val targetLayer = windows.firstOrNull { it.id == targetWindowId }?.layer
        return windows
            .filter { w ->
                w.id != targetWindowId &&
                    !w.bounds.isEmpty &&
                    when (w.kind) {
                        // Drawn over every app window, so it counts even when
                        // the target's window is unknown — but not over a
                        // window stacked above it (a popup that needs the IME).
                        WindowKind.INPUT_METHOD -> targetLayer == null || w.layer > targetLayer
                        WindowKind.SYSTEM, WindowKind.APPLICATION -> targetLayer != null && w.layer > targetLayer
                        WindowKind.OTHER -> false
                    }
            }.sortedByDescending { it.layer }
    }

    private fun covered(window: WindowSpec) =
        Verdict.Covered(
            windowName(window),
            if (window.kind == WindowKind.INPUT_METHOD) CoverKind.KEYBOARD else CoverKind.WINDOW,
            window.bounds,
        )

    private fun windowName(window: WindowSpec): String {
        val title = window.title?.takeIf { it.isNotBlank() }
        return when (window.kind) {
            WindowKind.INPUT_METHOD -> "the keyboard"
            WindowKind.SYSTEM -> if (title != null) "the system window \"$title\"" else "a system bar"
            else -> if (title != null) "the window \"$title\"" else "another window"
        }
    }

    /** The touchable parts of [area] outside [cover]: the strips above,
     *  below, left and right of it (they may overlap each other). */
    private fun remainders(
        area: Box,
        cover: Box,
    ): List<Box> =
        listOf(
            Box(area.left, area.top, area.right, minOf(area.bottom, cover.top)),
            Box(area.left, maxOf(area.top, cover.bottom), area.right, area.bottom),
            Box(area.left, area.top, minOf(area.right, cover.left), area.bottom),
            Box(maxOf(area.left, cover.right), area.top, area.right, area.bottom),
        ).filter(::isTouchable)

    private fun isTouchable(box: Box) = box.width >= MIN_VISIBLE_EXTENT && box.height >= MIN_VISIBLE_EXTENT

    // ─── The target's own window ───

    /**
     * What covers ([x], [y]) in the target's window, or null: a touchable
     * node, a loading overlay or a sticky list row painted over it.
     *
     * Walks up from the target; at each level, every sibling of the target's
     * branch that is painted after it is drawn over the whole branch, so its
     * subtree is searched for a touchable node containing the point, then
     * checked for a progress indicator. At a list's level, its other rows are
     * checked for one stuck over the point. Levels nearer the root are checked
     * first — what they paint is on top.
     */
    private fun findCoverInWindow(
        target: HitNode,
        targetBounds: Box,
        x: Int,
        y: Int,
    ): Verdict.Covered? {
        val reader = BudgetedReader(MAX_NODES_VISITED)
        // The loading-overlay and sticky-row checks walk more widely; their
        // own allowance keeps them from starving the touchable-cover search.
        val extraReader = BudgetedReader(MAX_NODES_VISITED)
        val rowReader = BudgetedReader(MAX_NODES_VISITED)
        val levels = levelsOf(target)

        // The nearest vertical list holding the target below level [depth]
        // (an index into levels): a cover found at that level is outside it.
        fun scrollerBelow(depth: Int): Box? = (0 until depth).map { levels[it].first }.firstOrNull { it.scrollsVertically }?.bounds

        for ((depth, level) in levels.withIndex().reversed()) {
            val (node, branch, branchIndex) = level
            val branchKey = drawKey(branch, branchIndex)
            val later =
                (0 until node.childCount())
                    .filter { it != branchIndex }
                    .mapNotNull { i -> reader.child(node, i)?.let { it to drawKey(it, i) } }
                    .filter { (sibling, key) -> compareKeys(key, branchKey) > 0 && !isModalBarrierBehind(sibling, key, branchKey) }
                    .sortedWith { a, b -> compareKeys(b.second, a.second) }
            for ((sibling, _) in later) {
                searchSubtree(sibling, x, y, reader)?.let {
                    // A control in a loading overlay (its Cancel button) is
                    // waited out with the overlay, never scrolled away from.
                    val list = scrollerBelow(depth)?.takeUnless { isLoadingOverlay(sibling, x, y, extraReader) }
                    // Clear the chrome the control sits in, not just the
                    // control: a bar's label above its button covers too.
                    val bounds = if (list != null) chromeBounds(it, node, list) else it.bounds
                    return Verdict.Covered(it.describe(), CoverKind.CONTROL, bounds, list)
                }
                if (isLoadingOverlay(sibling, x, y, extraReader)) {
                    return Verdict.Covered("a loading overlay (${sibling.describe()})", CoverKind.LOADING, sibling.bounds)
                }
            }
            if (isListContent(node)) {
                stickyRow(node, branch, branchIndex, targetBounds, x, y, rowReader)?.let { row ->
                    val list = if (node.scrollsVertically) node else node.parent()
                    return Verdict.Covered(row.describe(), CoverKind.CONTROL, row.bounds, list?.bounds)
                }
            }
            if (reader.exhausted) return null
        }
        return null
    }

    /** (parent, the target's branch, its index among the parent's children),
     *  from the target's parent up to the root. */
    private fun levelsOf(target: HitNode): List<Triple<HitNode, HitNode, Int>> {
        val pathReader = BudgetedReader(MAX_PATH_NODES_VISITED)
        val levels = mutableListOf<Triple<HitNode, HitNode, Int>>()
        var child = target
        var parent = child.parent()
        while (parent != null) {
            val level = parent
            val index =
                (0 until level.childCount()).firstOrNull { i -> pathReader.child(level, i)?.sameAs(child) == true }
                    ?: break
            levels.add(Triple(level, child, index))
            child = level
            parent = child.parent()
        }
        return levels
    }

    /**
     * Whether a drag that starts at ([x], [y]) would press the vertical list
     * at [list] that holds [target] (PILOT-980), and nothing else: no window
     * above the target's lies over the point, and no touchable node painted
     * over the list from outside it does — a dialog's backdrop, a second bar
     * stacked on the cover. A drag that started there would press that
     * instead (a backdrop dismisses its dialog on release). False too when
     * the list is not among the target's ancestors any more.
     */
    fun isDragStartOnList(
        target: HitNode,
        targetWindowId: Int?,
        list: Box,
        x: Int,
        y: Int,
        windows: List<WindowSpec>,
    ): Boolean {
        if (coveringWindows(windows, targetWindowId).any { it.bounds.contains(x, y) }) return false
        val levels = levelsOf(target)
        val listDepth = levels.indexOfFirst { it.first.scrollsVertically && it.first.bounds == list }
        if (listDepth < 0) return false
        val reader = BudgetedReader(MAX_NODES_VISITED)
        for (depth in levels.indices.reversed()) {
            if (depth <= listDepth) break
            val (node, branch, branchIndex) = levels[depth]
            val branchKey = drawKey(branch, branchIndex)
            for (i in 0 until node.childCount()) {
                if (i == branchIndex) continue
                val sibling = reader.child(node, i) ?: continue
                if (compareKeys(drawKey(sibling, i), branchKey) <= 0) continue
                if (searchSubtree(sibling, x, y, reader) != null) return false
            }
            if (reader.exhausted) return false
        }
        return true
    }

    /** Whether [node] holds a vertical list's rows: the list itself (a
     *  RecyclerView) or a scroll view's only child (its content). */
    private fun isListContent(node: HitNode): Boolean {
        if (node.scrollsVertically) return true
        val parent = node.parent() ?: return false
        return parent.scrollsVertically && parent.childCount() == 1
    }

    /** The bounds of the fixed chrome [cover] sits in: its outermost ancestor
     *  below [level] (where its branch splits from the target's) no taller
     *  than half of [list] — a bar, not a full-screen host it is placed in. */
    private fun chromeBounds(
        cover: HitNode,
        level: HitNode,
        list: Box,
    ): Box {
        var node = cover
        while (true) {
            val parent = node.parent() ?: break
            if (parent.sameAs(level) || parent.bounds.height * 2 > list.height) break
            node = parent
        }
        return node.bounds
    }

    /** Another row of [content] than the target's ([branch] at [branchIndex])
     *  stuck over ([x], [y]): visible, containing the point, at least as wide
     *  as the target's visible part (a grid's neighbouring cell is not), and
     *  painted over the target's row — or, with no drawing order to tell (a
     *  list reporting 0 for every child, which orders a sticky header before
     *  the rows it is drawn over), listed before it, row-sized (no taller
     *  than twice the target's row) and not enclosing the target's row. A
     *  background drawn behind the row (a decor view declared first in a
     *  ScrollView's content, an image under a button, even one the button's
     *  own size) is not a cover, and nor is a row scrolled under a target that
     *  is itself the sticky header. Unordered, a header that happens to hide
     *  a whole row is missed too, and the row is touched as before. */
    private fun stickyRow(
        content: HitNode,
        branch: HitNode,
        branchIndex: Int,
        targetBounds: Box,
        x: Int,
        y: Int,
        reader: BudgetedReader,
    ): HitNode? =
        (0 until content.childCount())
            .filter { it != branchIndex }
            .firstNotNullOfOrNull { i ->
                reader.child(content, i)?.takeIf {
                    val drawnOver =
                        if (it.drawingOrder == 0 && branch.drawingOrder == 0) {
                            i < branchIndex &&
                                it.bounds.height <= 2 * branch.bounds.height &&
                                !it.bounds.contains(branch.bounds)
                        } else {
                            compareKeys(drawKey(it, i), drawKey(branch, branchIndex)) > 0
                        }
                    drawnOver &&
                        it.isVisible &&
                        it.bounds.contains(x, y) &&
                        it.bounds.left <= targetBounds.left &&
                        it.bounds.right >= targetBounds.right
                }
            }

    /** Whether [branch], painted over the target, is a loading overlay over
     *  ([x], [y]): visible, containing the point, and a progress indicator
     *  or holding a visible one inside its bounds. */
    private fun isLoadingOverlay(
        branch: HitNode,
        x: Int,
        y: Int,
        reader: BudgetedReader,
    ): Boolean {
        if (!branch.isVisible || !branch.bounds.contains(x, y)) return false
        val stack = ArrayDeque<HitNode>()
        stack.addLast(branch)
        while (stack.isNotEmpty()) {
            val node = stack.removeLast()
            if (!node.isVisible || node.bounds.isEmpty || !node.bounds.intersects(branch.bounds)) continue
            if (node.isProgressIndicator) return true
            if (reader.exhausted) return false
            for (i in 0 until node.childCount()) reader.child(node, i)?.let(stack::addLast)
        }
        return false
    }

    /** Reads children while counting them against a shared budget; once it is
     *  spent every read returns null. */
    private class BudgetedReader(
        private var left: Int,
    ) {
        val exhausted: Boolean get() = left <= 0

        fun child(
            node: HitNode,
            index: Int,
        ): HitNode? {
            if (left <= 0) return null
            left--
            return node.child(index)
        }
    }

    /** Depth-first search of [root]'s subtree for a visible touchable node
     *  containing the point, pruned to nodes that contain it (Android clips
     *  a child's bounds to its parent's). Topmost-painted children first. */
    private fun searchSubtree(
        root: HitNode,
        x: Int,
        y: Int,
        reader: BudgetedReader,
    ): HitNode? {
        val stack = ArrayDeque<HitNode>()
        stack.addLast(root)
        while (stack.isNotEmpty()) {
            val node = stack.removeLast()
            if (!node.isVisible || !node.bounds.contains(x, y)) continue
            if (node.takesTouches) return node
            if (reader.exhausted) return null
            val children =
                (0 until node.childCount())
                    .mapNotNull { i -> reader.child(node, i)?.let { it to drawKey(it, i) } }
                    .sortedWith { a, b -> compareKeys(a.second, b.second) }
            // Last pushed is popped first: the topmost-painted child.
            for ((c, _) in children) stack.addLast(c)
        }
        return null
    }

    private fun drawKey(
        node: HitNode,
        index: Int,
    ) = node.drawingOrder to index

    /** Whether [sibling] is a Flutter modal barrier beside the target's
     *  branch: painted under the route content it is listed after (see the
     *  class doc). */
    private fun isModalBarrierBehind(
        sibling: HitNode,
        key: Pair<Int, Int>,
        branchKey: Pair<Int, Int>,
    ): Boolean = key.first == 0 && branchKey.first == 0 && sibling.offersDismiss && sibling.childCount() == 0

    private fun compareKeys(
        a: Pair<Int, Int>,
        b: Pair<Int, Int>,
    ): Int = compareValuesBy(a, b, { it.first }, { it.second })

    private fun roleOf(simpleName: String?): String =
        when (simpleName) {
            "Button", "ImageButton", "AppCompatButton", "AppCompatImageButton", "MaterialButton" -> "button"
            "RadioButton", "AppCompatRadioButton", "MaterialRadioButton" -> "radio button"
            "CheckBox", "AppCompatCheckBox", "MaterialCheckBox" -> "checkbox"
            "Switch", "SwitchCompat", "SwitchMaterial", "MaterialSwitch" -> "switch"
            "TextView", "AppCompatTextView", "MaterialTextView" -> "text"
            "ImageView", "AppCompatImageView" -> "image"
            null -> "element"
            else -> if (simpleName.endsWith("EditText")) "text field" else "element"
        }
}

/**
 * What identified a target when it was resolved, to re-check before it is
 * touched (PILOT-362). React reuses a native view for whatever it renders
 * next in the same place, so the resolved node can be showing a different
 * element by the time the touch is planned — touching it would hit what
 * replaced the target. Text only identifies a node that has neither a
 * content description nor a resource id: on one that does (a stopwatch or
 * countdown button), text is content that may change at any moment. An
 * editable field's text is its value, so it never counts.
 */
data class TargetIdentity(
    val className: String?,
    val resourceId: String?,
    val contentDescription: String?,
    /** The node's own text (not text aggregated from descendants). */
    val text: String?,
) {
    fun matches(
        className: String?,
        resourceId: String?,
        contentDescription: String?,
        text: String?,
        isEditable: Boolean,
    ): Boolean =
        same(this.className, className) &&
            same(this.resourceId, resourceId) &&
            same(this.contentDescription, contentDescription) &&
            (isEditable || isLabelled || same(this.text, text))

    private val isLabelled: Boolean get() = !contentDescription.isNullOrEmpty() || !resourceId.isNullOrEmpty()

    /** Nothing of the node's own identifies it — an unlabelled container
     *  whose visible text lives in its children — so a replacement in its
     *  place matches every field. Callers compare its content instead. */
    val identifiedOnlyByContent: Boolean get() = !isLabelled && text.isNullOrEmpty()

    private fun same(
        a: String?,
        b: String?,
    ) = a.orEmpty() == b.orEmpty()
}
