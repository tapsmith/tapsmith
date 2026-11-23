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
 *
 *   Another exception (PILOT-1447): one control the tree splits in two, an
 *   empty wrapper and its touch surface. React Native puts a `testID` on a
 *   plain View wrapped around a native view that takes the touches itself (a
 *   header menu button built on react-native-context-menu-view), and the
 *   tree can report the two as siblings rather than parent and child. So
 *   when the target takes no touches, has no children, and has its parent's
 *   bounds, a touchable node found under the point in a later sibling at
 *   that level (the sibling itself or one of its descendants) is not a cover
 *   if it lies wholly inside the target's bounds: it is what a finger on the
 *   target touches. Only that level is exempt: anything painted over the
 *   parent (a dialog, a full-screen modal, a loading overlay) still covers,
 *   and so does a later sibling of a target that takes touches itself, has
 *   content of its own, or is smaller than its parent. The cost: an empty,
 *   untouchable view with a touchable sibling laid over its middle in a
 *   same-sized container is taken for one control too.
 * - **A loading overlay** (PILOT-979): a node painted after the target, over
 *   the touch point, that is a progress indicator (a ProgressBar — React
 *   Native's ActivityIndicator is one) or holds a visible one. Apps lay one
 *   over a screen while it loads, often see-through, and it takes the
 *   touches though nothing in it is clickable. This is the one plain view
 *   that is named: a spinner over the point says "wait", whether or not the
 *   overlay passes touches through. Kind [CoverKind.LOADING].
 * - **A bar laid over a scroll view** (PILOT-1424), in an app whose plain
 *   views take touches ([analyze]'s `plainViewsTakeTouches`: React Native,
 *   where every view the JS hit test lands on is the touch's target unless
 *   it is `pointerEvents="none"`). A checkout bar, mini player or tab bar
 *   the screen lays over the bottom (or top) of a list: painted after the
 *   scroll view the target is in, outside it, across its bottom or top
 *   edge, at least half its width, at most a third of its height, with
 *   something named in it (text, a description or an id) — the same shape
 *   the SDK's scrollIntoView() trims off a list's view (PILOT-1370). Such a
 *   bar clips the target like a window does: a row partly under it is
 *   touched on the part left showing, one wholly under it is covered by it.
 *   A nameless view over the list (a pointerEvents="none" fade) is still not
 *   a cover, nor is anything inside the scroll view's own content, nor a
 *   plain view in a native, Compose or Flutter app, where a touch passes
 *   through a view that takes none. Kind [CoverKind.BAR].
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

    /** Least height (px) of a scroll view's view that a bar may leave; a
     *  "bar" that would leave less is the list's content, not over it. The
     *  SDK's scrollIntoView() trims with the same bound (MIN_REGION). */
    const val MIN_VIEW = 48

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
    enum class CoverKind { KEYBOARD, WINDOW, CONTROL, LOADING, BAR }

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

        /** A scroll view: content scrolls inside it, and bars are laid over it. */
        val isScrollContainer: Boolean get() = false

        /** Has text, a content description or a resource id of its own (not
         *  the test hooks marker): something drawn, not an empty wrapper. */
        val isNamed: Boolean get() = false

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
        plainViewsTakeTouches: Boolean = false,
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
        val path = target?.let(::pathOf).orEmpty()

        // Bars laid over the target's list clip it like a window (PILOT-1424).
        // Every scroll view on the way up: a carousel row can sit under a bar
        // laid over the feed that holds the carousel.
        if (target != null && plainViewsTakeTouches) {
            for (clip in path.indices.filter { path[it].branch.isScrollContainer }.mapNotNull { barsOver(path, it) }) {
                val left = pieces.map { it.intersect(clip.view) }.filter(::isTouchable)
                if (left.isEmpty()) {
                    // A control in the bar over the point is named before the bar.
                    val whole = pieces.maxBy { it.area }
                    findCoverInWindow(path, center(whole).first, center(whole).second)?.let { return it }
                    return Verdict.Covered(clip.nameOver(onScreen), CoverKind.BAR)
                }
                pieces = left
            }
        }
        val visible = pieces.maxBy { it.area }

        val (x, y) = center(visible)
        if (target != null) {
            findCoverInWindow(path, x, y)?.let { return it }
        }
        return Verdict.Clear(x, y, visible)
    }

    private fun center(box: Box) = (box.left + box.right) / 2 to (box.top + box.bottom) / 2

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
     * node or a loading overlay painted over it.
     *
     * Walks up from the target; at each level, every sibling of the target's
     * branch that is painted after it is drawn over the whole branch, so its
     * subtree is searched for a touchable node containing the point, then
     * checked for a progress indicator. Levels nearer the root are checked
     * first — what they paint is on top.
     */
    private fun findCoverInWindow(
        levels: List<Level>,
        x: Int,
        y: Int,
    ): Verdict.Covered? {
        val reader = BudgetedReader(MAX_NODES_VISITED)
        // The loading-overlay check walks more widely; its own allowance
        // keeps it from starving the touchable-cover search.
        val loadingReader = BudgetedReader(MAX_NODES_VISITED)

        val ownLevel = levels.firstOrNull()?.takeIf(::isSplitControl)
        for (level in levels.asReversed()) {
            for (sibling in paintedOver(level, reader)) {
                // A control in a loading overlay (its Cancel button) is named
                // as the cover; the overlay is named when nothing in it is.
                val cover = searchSubtree(sibling, x, y, reader)
                if (cover != null && !(level === ownLevel && level.branch.bounds.contains(cover.bounds))) {
                    return Verdict.Covered(cover.describe(), CoverKind.CONTROL)
                }
                if (isLoadingOverlay(sibling, x, y, loadingReader)) {
                    return Verdict.Covered("a loading overlay (${sibling.describe()})", CoverKind.LOADING)
                }
            }
            if (reader.exhausted) return null
        }
        return null
    }

    /** Whether [level], the target's own, splits one control in two (see the
     *  class doc): the target ([Level.branch]) is an empty node that takes no
     *  touches, with the bounds of its parent. */
    private fun isSplitControl(level: Level): Boolean {
        val target = level.branch
        return !target.takesTouches && target.childCount() == 0 && level.parent.bounds == target.bounds
    }

    /** One step of the target's path to the root: [parent], the child of it
     *  that holds the target ([branch]), and that child's index. */
    private class Level(
        val parent: HitNode,
        val branch: HitNode,
        val index: Int,
    )

    /** The target's ancestors with its branch at each, from its parent up to
     *  the root (or as far as the branch can be placed). */
    private fun pathOf(target: HitNode): List<Level> {
        val pathReader = BudgetedReader(MAX_PATH_NODES_VISITED)
        val levels = mutableListOf<Level>()
        var child = target
        var parent = child.parent()
        while (parent != null) {
            val level = parent
            val index =
                (0 until level.childCount()).firstOrNull { i -> pathReader.child(level, i)?.sameAs(child) == true }
                    ?: break
            levels.add(Level(level, child, index))
            child = level
            parent = child.parent()
        }
        return levels
    }

    /** [level]'s children painted after the target's branch, topmost first. */
    private fun paintedOver(
        level: Level,
        reader: BudgetedReader,
    ): List<HitNode> {
        val branchKey = drawKey(level.branch, level.index)
        return (0 until level.parent.childCount())
            .filter { it != level.index }
            .mapNotNull { i -> reader.child(level.parent, i)?.let { it to drawKey(it, i) } }
            .filter { (sibling, key) -> compareKeys(key, branchKey) > 0 && !isModalBarrierBehind(sibling, key, branchKey) }
            .sortedWith { a, b -> compareKeys(b.second, a.second) }
            .map { it.first }
    }

    // ─── Bars laid over the target's scroll view (PILOT-1424) ───

    /** The part of the target's scroll view no bar covers ([view]), and the
     *  bars that were cut off it. */
    private class BarClip(
        val view: Box,
        val bars: List<HitNode>,
        val nameOf: (HitNode) -> String,
    ) {
        /** The bar over most of [target]. */
        fun nameOver(target: Box): String = nameOf(bars.maxBy { it.bounds.intersect(target).area })
    }

    /**
     * The bars laid over the scroll view `path[at].branch`, cut off its
     * bounds the way the SDK's scrollIntoView() trims them (PILOT-1370), or
     * null when nothing is cut.
     */
    private fun barsOver(
        path: List<Level>,
        at: Int,
    ): BarClip? {
        val list = path[at].branch.bounds
        if (list.isEmpty) return null
        val reader = BudgetedReader(MAX_NODES_VISITED)
        val named = HashMap<HitNode, HitNode?>()
        val candidates = mutableListOf<HitNode>()
        // Painted over the scroll view: later siblings of it or of an ancestor.
        for (level in path.subList(at, path.size)) {
            for (sibling in paintedOver(level, reader)) collectBars(sibling, list, reader, candidates, named)
        }
        if (candidates.isEmpty()) return null

        // Trimmed until nothing more trims it: a bar stacked on another (a
        // mini player above a tab bar) reaches the edge only once the outer
        // one is cut off.
        val middle = list.top + list.height / 2
        var r = list
        val cut = mutableListOf<HitNode>()
        for (pass in 0..candidates.size) {
            val before = r
            for (bar in candidates) {
                val b = bar.bounds
                val across = b.intersect(r)
                if (across.isEmpty || across.width * 2 < list.width) continue
                val h = b.height
                if (b.top > middle && b.bottom >= r.bottom - h) {
                    if (b.top - r.top >= MIN_VIEW && b.top < r.bottom) {
                        r = Box(r.left, r.top, r.right, b.top)
                        cut.add(bar)
                    }
                } else if (b.bottom < middle && b.top <= r.top + h) {
                    if (r.bottom - b.bottom >= MIN_VIEW && b.bottom > r.top) {
                        r = Box(r.left, b.bottom, r.right, r.bottom)
                        cut.add(bar)
                    }
                }
            }
            if (r == before) break
        }
        if (cut.isEmpty()) return null
        return BarClip(r, cut) { bar ->
            val label = named[bar]
            when {
                label == null || label === bar -> bar.describe()
                else -> "a bar holding ${label.describe()}"
            }
        }
    }

    /**
     * Every node in [root]'s subtree shaped like a bar over [list] (see the
     * class doc), into [into]; [named] records, for each node visited, the
     * first named node in its subtree (itself first), or null.
     */
    private fun collectBars(
        root: HitNode,
        list: Box,
        reader: BudgetedReader,
        into: MutableList<HitNode>,
        named: MutableMap<HitNode, HitNode?>,
    ): HitNode? {
        // Invisible, or nowhere over the list (Android clips a child's bounds
        // to its parent's, so nothing inside it is either).
        if (!root.isVisible || !root.bounds.intersects(list)) return null
        var label: HitNode? = if (root.isNamed) root else null
        for (i in 0 until root.childCount()) {
            val child = reader.child(root, i) ?: continue
            val inChild = collectBars(child, list, reader, into, named)
            if (label == null) label = inChild
        }
        named[root] = label
        val b = root.bounds
        if (label != null && b.height * 3 <= list.height && b.intersect(list).width * 2 >= list.width) into.add(root)
        return label
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
