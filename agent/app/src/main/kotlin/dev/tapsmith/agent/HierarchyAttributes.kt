package dev.tapsmith.agent

/**
 * The pure parts of [HierarchyDumper]'s post-processing, kept free of Android
 * types so the host tests can pin them: the bounds a node is written with in
 * the stock UIAutomator XML (the join key), and the injection of Tapsmith's
 * extra attributes into that XML.
 */
internal object HierarchyAttributes {
    /** A rectangle as `left, top, right, bottom`. */
    data class Box(
        val left: Int,
        val top: Int,
        val right: Int,
        val bottom: Int,
    ) {
        /** The `bounds` attribute value the stock dump writes: `[l,t][r,b]`. */
        fun key(): String = "[$left,$top][$right,$bottom]"

        /**
         * This box clipped to [other], or unchanged when they do not overlap —
         * android.graphics.Rect.intersect's rule, which UIAutomator's
         * `intersectOrWarn` relies on.
         */
        fun intersectOrKeep(other: Box): Box {
            if (left >= other.right || other.left >= right || top >= other.bottom || other.top >= bottom) return this
            return Box(maxOf(left, other.left), maxOf(top, other.top), minOf(right, other.right), minOf(bottom, other.bottom))
        }
    }

    /**
     * The bounds UIAutomator's dumper writes for a node: its screen bounds
     * clipped to the display and then to its window
     * (`AccessibilityNodeInfoHelper.getVisibleBoundsInScreen(node, w, h,
     * false)` in uiautomator 2.3). Keying the join on raw screen bounds would
     * miss every node that is partly off screen or outside its window
     * (PILOT-655).
     */
    fun dumpedBounds(
        screen: Box,
        displayWidth: Int,
        displayHeight: Int,
        window: Box?,
    ): Box {
        val onDisplay = screen.intersectOrKeep(Box(0, 0, displayWidth, displayHeight))
        return if (window != null) onDisplay.intersectOrKeep(window) else onDisplay
    }

    private val NODE_BOUNDS = Regex("""(<node\b[^>]*\bbounds="(\[-?\d+,-?\d+]\[-?\d+,-?\d+])")""")

    /**
     * What [inject] writes for Jetpack Compose's role nodes (PILOT-828):
     * each carrier in [carriers] ([nodeKey] → the role it carries) gets
     * `[carrierAttribute]="true"`, and its parent gets the role as
     * `[roleAttribute]`. Joined by tree position, not bounds alone: a
     * carrier is an unnamed leaf that is its parent's last child, and the
     * role goes on that parent — a control can share its bounds and class
     * with its content-description leaf, with a child that fills it, and
     * with a wrapper (a test-tagged Box) around it.
     */
    class ComposeMarks(
        val carriers: Map<String, String>,
        val carrierAttribute: String,
        val roleAttribute: String,
    )

    /**
     * Inject [attributes] (bounds → name → value) into the stock XML: after
     * the `bounds` attribute of every `<node>` whose bounds have an entry,
     * then [compose]'s marks.
     */
    fun inject(
        xml: String,
        attributes: Map<String, Map<String, String>>,
        compose: ComposeMarks? = null,
    ): String {
        val marks = if (compose != null && compose.carriers.isNotEmpty()) composeMarks(xml, compose) else emptyMap()
        if (attributes.isEmpty() && marks.isEmpty()) return xml
        val sb = StringBuilder(xml.length + attributes.size * 30)
        var lastEnd = 0
        for (match in NODE_BOUNDS.findAll(xml)) {
            val end = match.range.last + 1
            sb.append(xml, lastEnd, end)
            val nodeMarks = marks[match.range.first]
            // A control's carried role replaces a role joined by bounds alone
            // (a same-bounds node's), so the node gets one.
            val carriedRole = compose?.roleAttribute?.takeIf { nodeMarks?.containsKey(it) == true }
            attributes[match.groupValues[2]]?.let { appendAttributes(sb, if (carriedRole != null) it - carriedRole else it) }
            nodeMarks?.let { appendAttributes(sb, it) }
            lastEnd = end
        }
        sb.append(xml, lastEnd, xml.length)
        return sb.toString()
    }

    /** The key [ComposeMarks] are joined on: a node's dumped bounds and its class. */
    fun nodeKey(
        bounds: Box,
        className: String?,
    ): String = "${bounds.key()}|${className ?: ""}"

    /**
     * [compose]'s marks by the offset of the `<node` tag they go on: each
     * carrier — an unnamed leaf of a [ComposeMarks.carriers] key whose next
     * tag closes its parent (the last child) — and that parent.
     */
    private fun composeMarks(
        xml: String,
        compose: ComposeMarks,
    ): Map<Int, Map<String, String>> {
        val marks = HashMap<Int, Map<String, String>>()
        val open = ArrayDeque<Int>()
        // A carrier-shaped leaf just seen: its offset and role, confirmed
        // when the next tag closes its parent.
        var pending: Pair<Int, String>? = null
        for (match in NODE_TAG.findAll(xml)) {
            val closing = match.groupValues[1] == "/"
            val seen = pending
            pending = null
            if (closing) {
                val parent = open.removeLastOrNull()
                if (seen != null && parent != null) {
                    marks[seen.first] = mapOf(compose.carrierAttribute to "true")
                    marks[parent] = mapOf(compose.roleAttribute to seen.second)
                }
                continue
            }
            val attrs = match.groupValues[2]
            if (match.groupValues[3] == "/") {
                val bounds = BOUNDS_ATTR.find(attrs)?.groupValues?.get(1)
                val unnamed = attrValue(TEXT_ATTR, attrs).isEmpty() && attrValue(CONTENT_DESC_ATTR, attrs).isEmpty()
                val role = if (bounds != null && unnamed) compose.carriers["$bounds|${attrValue(CLASS_ATTR, attrs)}"] else null
                if (role != null) pending = match.range.first to role
            } else {
                open.addLast(match.range.first)
            }
        }
        return marks
    }

    private fun appendAttributes(
        sb: StringBuilder,
        attributes: Map<String, String>,
    ) {
        attributes.forEach { (name, value) ->
            sb
                .append(' ')
                .append(name)
                .append("=\"")
                .append(escapeXmlAttr(value))
                .append('"')
        }
    }

    private fun attrValue(
        attr: Regex,
        tag: String,
    ): String {
        val match = attr.find(tag) ?: return ""
        return match.groupValues[1]
    }

    private val NODE_TAG = Regex("""<(/?)node\b([^>]*?)(/?)>""")
    private val BOUNDS_ATTR = Regex("""\bbounds="([^"]*)"""")
    private val PACKAGE_ATTR = Regex("""\bpackage="([^"]*)"""")
    private val CLASS_ATTR = Regex("""\sclass="([^"]*)"""")
    private val TEXT_ATTR = Regex("""\stext="([^"]*)"""")
    private val CONTENT_DESC_ATTR = Regex("""\scontent-desc="([^"]*)"""")

    /** The key [markWindowRoots] joins a window's root node on: its dumped bounds and package. */
    fun windowRootKey(
        bounds: Box,
        packageName: String?,
    ): String = "${bounds.key()}|${packageName ?: ""}"

    /**
     * Add `[attribute]="true"` to every window root — a top-level `<node>`,
     * one per window in the stock dump — whose [windowRootKey] is in [roots].
     * Only window roots: a node deeper in another window can have the same
     * bounds and package (an app header exactly where the status bar is).
     */
    fun markWindowRoots(
        xml: String,
        roots: Set<String>,
        attribute: String,
    ): String {
        if (roots.isEmpty()) return xml
        val sb = StringBuilder(xml.length + roots.size * (attribute.length + 10))
        var lastEnd = 0
        var depth = 0
        for (match in NODE_TAG.findAll(xml)) {
            if (match.groupValues[1] == "/") {
                depth--
                continue
            }
            if (depth == 0) {
                val attrs = match.groupValues[2]
                val bounds = BOUNDS_ATTR.find(attrs)?.groupValues?.get(1)
                val pkg = PACKAGE_ATTR.find(attrs)?.groupValues?.get(1) ?: ""
                if (bounds != null && "$bounds|$pkg" in roots) {
                    val afterName = match.range.first + "<node".length
                    sb
                        .append(xml, lastEnd, afterName)
                        .append(' ')
                        .append(attribute)
                        .append("=\"true\"")
                    lastEnd = afterName
                }
            }
            if (match.groupValues[3] != "/") depth++
        }
        sb.append(xml, lastEnd, xml.length)
        return sb.toString()
    }

    private fun escapeXmlAttr(s: String): String =
        s
            .replace("&", "&amp;")
            .replace("\"", "&quot;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
}
