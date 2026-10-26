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
     * Inject [attributes] (bounds → name → value) into the stock XML: after
     * the `bounds` attribute of every `<node>` whose bounds have an entry.
     *
     * [carriers] ([carrierKey]s) mark Compose role carriers
     * `[carrierAttribute]="true"` (PILOT-828): only a node of that class and
     * bounds that has no children, text or content-desc, as bounds alone
     * would also mark the control a carrier can share them with, and the
     * content-description leaf Compose can give the same control.
     */
    fun inject(
        xml: String,
        attributes: Map<String, Map<String, String>>,
        carriers: Set<String> = emptySet(),
        carrierAttribute: String = "",
    ): String {
        if (attributes.isEmpty() && carriers.isEmpty()) return xml
        val sb = StringBuilder(xml.length + (attributes.size + carriers.size) * 30)
        var lastEnd = 0
        for (match in NODE_BOUNDS.findAll(xml)) {
            val end = match.range.last + 1
            sb.append(xml, lastEnd, end)
            val bounds = match.groupValues[2]
            attributes[bounds]?.let { appendAttributes(sb, it) }
            if (carriers.isNotEmpty() && isUnnamedLeafIn(xml, match.range.first, end, bounds, carriers)) {
                appendAttributes(sb, mapOf(carrierAttribute to "true"))
            }
            lastEnd = end
        }
        sb.append(xml, lastEnd, xml.length)
        return sb.toString()
    }

    /** The key [inject] marks a carrier by: its dumped bounds and its class. */
    fun carrierKey(
        bounds: Box,
        className: String?,
    ): String = "${bounds.key()}|${className ?: ""}"

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

    /**
     * Whether the `<node>` tag starting at [start] (its `bounds` ending at
     * [boundsEnd]) closes itself — a node without children — has no text
     * or content-desc, and has a [carrierKey] in [carriers].
     */
    private fun isUnnamedLeafIn(
        xml: String,
        start: Int,
        boundsEnd: Int,
        bounds: String,
        carriers: Set<String>,
    ): Boolean {
        val close = xml.indexOf('>', boundsEnd)
        if (close <= 0 || xml[close - 1] != '/') return false
        val tag = xml.substring(start, close)
        if ("$bounds|${attrValue(CLASS_ATTR, tag)}" !in carriers) return false
        return attrValue(TEXT_ATTR, tag).isEmpty() && attrValue(CONTENT_DESC_ATTR, tag).isEmpty()
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
