package dev.tapsmith.agent

/** An integer screen rectangle, [left, right) × [top, bottom). A plain value
 *  type rather than android.graphics.Rect so the analyzer runs in JVM unit
 *  tests. */
data class Box(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
    val isEmpty: Boolean get() = width <= 0 || height <= 0
    val area: Long get() = if (isEmpty) 0 else width.toLong() * height

    fun contains(
        x: Int,
        y: Int,
    ): Boolean = x >= left && x < right && y >= top && y < bottom

    fun intersects(other: Box): Boolean = !intersect(other).isEmpty

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
 * No Android dependencies — the tree and the windows come in through
 * [HitNode] and [WindowSpec] so the JVM unit tests can build them by hand.
 */
object OcclusionAnalyzer {
    /** Smallest visible extent (px, each axis) worth touching: anything
     *  thinner risks the integer touch point landing just outside. */
    const val MIN_VISIBLE_EXTENT = 2

    /** Upper bound on nodes visited when searching the target's window for a
     *  cover, so a pathological tree cannot stall an action. Past it the tree
     *  check gives up and names no cover. */
    const val MAX_NODES_VISITED = 2000

    private const val MAX_LABEL_LENGTH = 40

    sealed class Verdict {
        /** Nothing covers ([x], [y]) — touch there. [visible] is the part of
         *  the element the windows above leave uncovered ([x], [y] is its
         *  center), for callers that want a different spot inside it. */
        data class Clear(val x: Int, val y: Int, val visible: Box) : Verdict()

        /** The element is covered, by the thing [by] names ("the keyboard",
         *  `button "Overlay"`). */
        data class Covered(val by: String) : Verdict()

        /** No part of the element is on screen. */
        object OffScreen : Verdict() {
            override fun toString() = "OffScreen"
        }
    }

    enum class WindowKind { INPUT_METHOD, SYSTEM, APPLICATION, OTHER }

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
        // see — for a view on screen, typically because the keyboard is over
        // it. Name the keyboard when it could be the reason.
        if (target != null && !target.isVisible) {
            val keyboard = covers.firstOrNull { it.kind == WindowKind.INPUT_METHOD && it.bounds.intersects(onScreen) }
            return if (keyboard != null) Verdict.Covered(windowName(keyboard)) else Verdict.OffScreen
        }

        var visible = onScreen
        for (window in covers) {
            if (!window.bounds.intersects(visible)) continue
            visible = largestRemainder(visible, window.bounds) ?: return Verdict.Covered(windowName(window))
        }

        val x = (visible.left + visible.right) / 2
        val y = (visible.top + visible.bottom) / 2
        if (target != null) {
            findCoverInWindow(target, x, y)?.let { return Verdict.Covered(it.describe()) }
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
                        WindowKind.INPUT_METHOD -> true
                        WindowKind.SYSTEM, WindowKind.APPLICATION -> targetLayer != null && w.layer > targetLayer
                        WindowKind.OTHER -> false
                    }
            }
            .sortedByDescending { it.layer }
    }

    private fun windowName(window: WindowSpec): String {
        val title = window.title?.takeIf { it.isNotBlank() }
        return when (window.kind) {
            WindowKind.INPUT_METHOD -> "the keyboard"
            WindowKind.SYSTEM -> if (title != null) "the system window \"$title\"" else "a system bar"
            else -> if (title != null) "the window \"$title\"" else "another window"
        }
    }

    /** The largest touchable part of [area] outside [cover], or null when
     *  nothing touchable is left. */
    private fun largestRemainder(
        area: Box,
        cover: Box,
    ): Box? =
        listOf(
            Box(area.left, area.top, area.right, minOf(area.bottom, cover.top)),
            Box(area.left, maxOf(area.top, cover.bottom), area.right, area.bottom),
            Box(area.left, area.top, minOf(area.right, cover.left), area.bottom),
            Box(maxOf(area.left, cover.right), area.top, area.right, area.bottom),
        ).filter(::isTouchable).maxByOrNull { it.area }

    private fun isTouchable(box: Box) = box.width >= MIN_VISIBLE_EXTENT && box.height >= MIN_VISIBLE_EXTENT

    // ─── The target's own window ───

    /**
     * A touchable node painted over ([x], [y]) in the target's window, or null.
     *
     * Walks up from the target; at each level, every sibling of the target's
     * branch that is painted after it is drawn over the whole branch, so its
     * subtree is searched for a touchable node containing the point. Levels
     * nearer the root are checked first — what they paint is on top.
     */
    private fun findCoverInWindow(
        target: HitNode,
        x: Int,
        y: Int,
    ): HitNode? {
        // (parent, index of the target's branch among its children), from the
        // target's parent up to the root.
        val levels = mutableListOf<Pair<HitNode, Int>>()
        var child = target
        var parent = child.parent()
        while (parent != null) {
            val index = (0 until parent.childCount()).firstOrNull { i -> parent!!.child(i)?.sameAs(child) == true } ?: break
            levels.add(parent to index)
            child = parent
            parent = child.parent()
        }

        var budget = MAX_NODES_VISITED
        for ((node, branchIndex) in levels.asReversed()) {
            val branch = node.child(branchIndex) ?: continue
            val branchKey = drawKey(branch, branchIndex)
            val later =
                (0 until node.childCount())
                    .filter { it != branchIndex }
                    .mapNotNull { i -> node.child(i)?.let { it to drawKey(it, i) } }
                    .filter { (_, key) -> compareKeys(key, branchKey) > 0 }
                    .sortedWith { a, b -> compareKeys(b.second, a.second) }
            for ((sibling, _) in later) {
                val (cover, left) = searchSubtree(sibling, x, y, budget)
                budget = left
                if (cover != null) return cover
                if (budget <= 0) return null
            }
        }
        return null
    }

    /** Depth-first search of [root]'s subtree for a visible touchable node
     *  containing the point, pruned to nodes that contain it (Android clips
     *  a child's bounds to its parent's). Topmost-painted children first. */
    private fun searchSubtree(
        root: HitNode,
        x: Int,
        y: Int,
        budget: Int,
    ): Pair<HitNode?, Int> {
        var left = budget
        val stack = ArrayDeque<HitNode>()
        stack.addLast(root)
        while (stack.isNotEmpty()) {
            if (left-- <= 0) return null to 0
            val node = stack.removeLast()
            if (!node.isVisible || !node.bounds.contains(x, y)) continue
            if (node.takesTouches) return node to left
            val children =
                (0 until node.childCount())
                    .mapNotNull { i -> node.child(i)?.let { it to drawKey(it, i) } }
                    .sortedWith { a, b -> compareKeys(a.second, b.second) }
            // Last pushed is popped first: the topmost-painted child.
            for ((c, _) in children) stack.addLast(c)
        }
        return null to left
    }

    private fun drawKey(
        node: HitNode,
        index: Int,
    ) = node.drawingOrder to index

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
 * replaced the target. An editable field's text is its value, not what the
 * field is, so it is ignored for editable nodes.
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
            (isEditable || same(this.text, text))

    private fun same(
        a: String?,
        b: String?,
    ) = a.orEmpty() == b.orEmpty()
}
