package dev.tapsmith.agent

/**
 * A Flutter tab: a destination of a Material `NavigationBar`,
 * `NavigationRail`, `NavigationDrawer`, `TabBar` or `BottomNavigationBar`.
 * Flutter's Android embedding publishes none of them with a role (the
 * NavigationBar and BottomNavigationBar items are Buttons, the others plain
 * Views); what marks them is the position Flutter appends to the item's
 * label for TalkBack — MaterialLocalizations.tabLabel, merged into the
 * content description after a line break: `"Contact\nTab 2 of 3"`.
 *
 * Such an element is a `tab` ([FindRules.publishedRole]), and its name is
 * the label without that suffix (`"Contact"`), so
 * `getByRole("tab", { name: "Contact" })` finds it whichever of those
 * widgets draws it, and `exact` compares the label alone.
 *
 * Flutter's default English localization only: an app that localizes its
 * Material strings (GlobalMaterialLocalizations) publishes the suffix in its
 * own language ("Tab 2 von 3"), which is not read.
 */
internal object FlutterTab {
    /** `<label>\nTab <i> of <n>`, or the bare suffix for an item with no label. */
    private val SUFFIXED = Regex("""^(?:([\s\S]*)\n)?Tab [1-9]\d* of [1-9]\d*$""")

    /** The hierarchy dump's attribute for [nameOf], on the tab. */
    const val NAME_DUMP_ATTRIBUTE = RowName.NAME_DUMP_ATTRIBUTE

    /**
     * The tab's name — its label, without Flutter's position suffix — when
     * [contentDescription] is a Flutter tab's, else null. An item with no
     * label of its own (an icon with no semantic label) is named "".
     */
    fun nameOf(contentDescription: CharSequence?): String? {
        if (contentDescription.isNullOrEmpty()) return null
        val match = SUFFIXED.matchEntire(contentDescription) ?: return null
        return match.groupValues[1]
    }
}
