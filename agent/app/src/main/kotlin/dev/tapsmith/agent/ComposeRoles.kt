package dev.tapsmith.agent

/**
 * Jetpack Compose's role nodes (PILOT-828), kept free of Android types so
 * the host tests can pin them.
 *
 * Compose reports a merging node that has children — a Material3 Button, a
 * NavigationBarItem, a `Modifier.toggleable(role = Role.Checkbox)` row —
 * without its role: compose-ui's `SemanticsNode.emitFakeNodes` appends a fake
 * leaf child that carries it instead (class `android.widget.Button`,
 * `CheckBox`, `RadioButton`, `ImageView`, `Spinner`, `NumberPicker`, or the
 * "Tab" / "Switch" role description on a plain View). That leaf has no
 * name, no actions and no children; the clickable node above it holds the
 * name (its children's text) and the state. TalkBack reads the pair as one
 * control, and so does getByRole: the parent takes the carrier's role, and
 * the carrier never matches a role itself.
 *
 * The one rule both [ElementFinder] (matching, the reported role) and
 * [HierarchyDumper] (the `tapsmith-role` it writes, and
 * `tapsmith-role-carrier` on the carrier) apply, so the trace viewer's
 * matcher agrees (packages/tapsmith selector-matching.ts).
 */
internal object ComposeRoles {
    /** The dump attribute marking a carrier, which no getByRole matches. */
    const val CARRIER_DUMP_ATTRIBUTE = "tapsmith-role-carrier"

    /** The class Compose gives a node with no class-mapped role. */
    const val COMPOSE_VIEW_CLASS = "android.view.View"

    /**
     * The roles a carrier can give: the ones Compose's `Role`s read as
     * (`Role.Button` → `android.widget.Button`, `Role.Tab` → the "Tab"
     * description, …). Anything else on an unnamed last leaf — a progress
     * indicator's ProgressBar class, an empty `Text("")` — is that node's
     * own role, not a carried one. `Role.ValuePicker`'s NumberPicker class
     * has no role here yet.
     */
    private val CARRIED_ROLES = setOf("button", "checkbox", "radiobutton", "image", "spinner", "tab", "switch")

    /**
     * What the rule reads of one node. [role] is the role the finder gives
     * the node on its own: its role description, else its class's role
     * (empty or null for none).
     */
    data class NodeShape(
        val className: String?,
        val role: String?,
        val text: CharSequence?,
        val contentDescription: CharSequence?,
        val childCount: Int,
        val clickable: Boolean,
        val longClickable: Boolean,
        val focusable: Boolean,
        val checkable: Boolean,
    )

    /** The role [node] would carry for its parent, or null when it has none to give. */
    fun carriedRole(node: NodeShape): String? = node.role?.takeIf { it in CARRIED_ROLES }

    /**
     * Whether [node] is a Compose role carrier: a role-bearing leaf with no
     * name and no actions, the last child ([isLastChild]) of a role-less
     * Compose node ([parent]) with other children — Compose appends the
     * fake role node after the real children, and puts its other fake node
     * (the content description) first. [parent] and [isLastChild] are read
     * only for a leaf of that shape, as each can cost a round-trip.
     */
    fun isCarrier(
        node: NodeShape,
        parent: () -> NodeShape?,
        isLastChild: () -> Boolean,
    ): Boolean {
        if (carriedRole(node) == null) return false
        if (node.childCount != 0 || node.clickable || node.longClickable || node.focusable || node.checkable) return false
        if (!node.text.isNullOrEmpty() || !node.contentDescription.isNullOrEmpty()) return false
        val p = parent() ?: return false
        return mayBeCarrierParent(p) && isLastChild()
    }

    /**
     * Whether [node] has the shape of a carrier's parent: a role-less
     * Compose control — Compose emits the fake role node only for a node
     * that merges its children, which is a clickable, toggleable or
     * selectable one (a disabled Button is still clickable, a selected tab
     * still focusable) — with at least one child beside the carrier. A
     * layout container is none of these, so its last child keeps its role.
     */
    fun mayBeCarrierParent(node: NodeShape): Boolean =
        node.className == COMPOSE_VIEW_CLASS &&
            node.role.isNullOrEmpty() &&
            node.childCount >= 2 &&
            (node.clickable || node.focusable || node.checkable || node.longClickable)

    /**
     * The match step of a find, in tree order (PILOT-828). Each candidate is
     * [read] (null: it never matches — not the app's), and one that is a
     * Compose role carrier ([carrierParentOf], only for role queries) is
     * replaced by its parent, whose role is read from the carrier: [accepts]
     * gets the element to match and the node its role comes from. An
     * element accepted once ([key]) is not accepted again — a control is
     * reached both as itself and through its carrier, and as itself it has
     * no role. Stops after [limit] matches.
     */
    inline fun <C, T, K> matchInTreeOrder(
        candidates: List<C>,
        limit: Int,
        read: (C) -> T?,
        carrierParentOf: (T) -> T?,
        key: (T) -> K,
        accepts: (target: T, roleSource: T) -> Boolean,
    ): List<T> {
        val matches = mutableListOf<T>()
        val matched = HashSet<K>()
        for (candidate in candidates) {
            if (matches.size >= limit) break
            val node = read(candidate) ?: continue
            val target = carrierParentOf(node) ?: node
            if (key(target) in matched) continue
            if (!accepts(target, node)) continue
            matched.add(key(target))
            matches.add(target)
        }
        return matches
    }
}
