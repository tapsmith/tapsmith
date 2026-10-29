package dev.tapsmith.agent

/**
 * The pure decisions [ElementFinder] makes about one candidate element,
 * kept free of Android types so the host tests can pin them (PILOT-539).
 * The finder supplies each attribute from the node the tree walk captured.
 */
internal object FindRules {
    /**
     * The English role descriptions React Native (and Jetpack Compose) publish
     * for roles whose name is one word, keyed lowercased: `accessibilityRole=
     * "progressbar"` surfaces as "Progress Bar". Mapping them back to the role
     * name keeps the snapshot, `toHaveRole()` and `getByRole()` on one
     * spelling (PILOT-656). RN's image button ("Button, Image") is an
     * ImageButton, so it reads as a button, as the class does.
     */
    private val MULTI_WORD_ROLE_DESCRIPTIONS: Map<String, String> =
        mapOf(
            "progress bar" to "progressbar",
            "tool bar" to "toolbar",
            "combo box" to "combobox",
            "tab list" to "tablist",
            "menu item" to "menuitem",
            "menu bar" to "menubar",
            "radio group" to "radiogroup",
            "scroll bar" to "scrollbar",
            "spin button" to "spinbutton",
            "button, image" to "button",
        )

    /**
     * The role an element's published role description names: lowercased
     * (so `"Header"` meets the case-insensitive role tables) and, for RN's
     * multi-word descriptions, the role's own name. Any other value — an
     * app's custom or localized description — is kept, lowercased. Null for
     * no description.
     */
    fun canonicalRoleDescription(raw: String?): String? {
        val lowered = raw?.takeIf { it.isNotEmpty() }?.lowercase() ?: return null
        return MULTI_WORD_ROLE_DESCRIPTIONS[lowered] ?: lowered
    }

    /**
     * The role an element publishes: "heading" for a heading (React
     * Native's `accessibilityRole="header"` sets the heading flag), else its
     * [canonicalRoleDescription]. getByRole matches with it, and the
     * hierarchy dump writes it as `tapsmith-role`, so the two agree.
     */
    fun publishedRole(
        isHeading: Boolean,
        rawDescription: String?,
    ): String? = if (isHeading) "heading" else canonicalRoleDescription(rawDescription)

    /**
     * An element's expanded state from the accessibility actions it offers:
     * one that can collapse is expanded, one that can only expand is
     * collapsed, and one with neither has no expanded state (null), which
     * neither `expanded: true` nor `expanded: false` matches. Shared by
     * getByRole's filter and the hierarchy dump's `tapsmith-expanded`, so the
     * Locator Playground agrees with the device (PILOT-655).
     */
    fun expandedState(
        canExpand: Boolean,
        canCollapse: Boolean,
    ): Boolean? =
        when {
            canCollapse -> true
            canExpand -> false
            else -> null
        }

    /**
     * The post-filter for trait and dual-path roles (ElementFinder's
     * TRAIT_ONLY_ROLES and DUAL_PATH_ROLES). A role description the app published
     * (React Native's accessibilityRole) decides the role on its own: it must
     * be one of [acceptable]. Without one, the element matches by class only
     * when the role's [classSet] is not [ambiguous] — heading and link share
     * TextView with "text", so a bare TextView is neither.
     */
    fun matchesTraitRole(
        roleDescription: String?,
        className: String?,
        acceptable: Set<String>,
        classSet: Set<String>,
        ambiguous: Boolean,
    ): Boolean =
        when {
            roleDescription != null -> roleDescription in acceptable
            !ambiguous && classSet.isNotEmpty() -> (className ?: "") in classSet
            else -> false
        }

    /**
     * The text a query reports for an element. An element with no text of
     * its own (an RN ReactViewGroup wrapping its label) reports its joined
     * [descendantText]; an EditText showing its placeholder reports none
     * (PILOT-133 — UIAutomator surfaces the hint as the text of an empty
     * field). Each lambda is read only on the branch that needs it.
     */
    fun effectiveText(
        rawText: String?,
        isShowingHint: () -> Boolean,
        descendantText: () -> String,
    ): String? =
        when {
            rawText.isNullOrEmpty() -> descendantText().ifEmpty { null }
            isShowingHint() -> null
            else -> rawText
        }

    /**
     * The text of [node]'s descendants, in tree order: each child gives its
     * [ownText] (text, else content description) or, when it has none, its
     * own descendants' text, down to [maxDepth] levels. [children] lists
     * only the children a query can see (visible to the user). A child
     * [skip] accepts gives nothing, nor do its descendants.
     */
    fun <N> descendantTextParts(
        node: N,
        children: (N) -> List<N>,
        ownText: (N) -> String?,
        maxDepth: Int,
        depth: Int = 0,
        skip: (N) -> Boolean = { false },
    ): List<String> {
        if (depth >= maxDepth) return emptyList()
        val parts = mutableListOf<String>()
        for (child in children(node)) {
            if (skip(child)) continue
            val text = ownText(child)
            if (text != null) {
                parts.add(text)
            } else {
                parts.addAll(descendantTextParts(child, children, ownText, maxDepth, depth + 1, skip))
            }
        }
        return parts
    }
}

/** The pure part of a swipe's settle (PILOT-539), host-testable. */
internal object SwipeSettle {
    /**
     * Whether a TYPE_VIEW_SCROLLED event with these scroll deltas (API 28+)
     * may be the swiped content moving. Only an event that moved purely
     * across the swipe's axis is left out — a sideways carousel scrolling
     * on its own must not hold a vertical swipe's settle open. An event
     * without usable deltas counts: -1 is "not reported", and ListView /
     * GridView report every scroll as (0, 0).
     */
    fun isAlongAxis(
        deltaX: Int,
        deltaY: Int,
        vertical: Boolean,
    ): Boolean {
        val along = if (vertical) deltaY else deltaX
        val across = if (vertical) deltaX else deltaY
        return !(along == 0 && across != 0 && across != UNREPORTED_DELTA)
    }

    /**
     * How much longer a swipe's settle must wait for [quietMs] without a
     * scroll event, at [now]: quiet is counted from the last scroll event's
     * arrival ([lastScrollAt]), or from when the settle [started] if that
     * was later. Zero or less means settled.
     */
    fun remainingQuietMs(
        now: Long,
        started: Long,
        lastScrollAt: Long,
        quietMs: Long,
    ): Long = maxOf(started, lastScrollAt) + quietMs - now

    /** AccessibilityEvent's scroll delta when the view didn't report one. */
    private const val UNREPORTED_DELTA = -1
}
