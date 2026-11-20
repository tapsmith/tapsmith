package dev.tapsmith.agent

/**
 * The name and label a control with none of its own takes from the row it
 * sits in. An androidx SwitchPreferenceCompat's switch (and a
 * CheckBoxPreference's checkbox) has no text and no content description:
 * the row around it — a clickable layout holding the title and summary —
 * is what TalkBack focuses, reading "Full black, off, switch". TalkBack
 * merges a child that is not actionable on its own into its nearest
 * actionable ancestor; [of] follows that rule, so `getByRole("switch",
 * { name: "Full black" })` and `getByLabel("Full black")` find the switch.
 *
 * [name] is what getByRole's `name` matches: the row's content description,
 * else its text joined in reading order, as a web `<label>` wrapping an
 * input names it with all of its text. [label] is what getByLabel matches:
 * the row's content description, else its first text — the title; the
 * summary under it describes the setting rather than labelling it.
 */
internal data class RowName(
    val name: String,
    val label: String,
) {
    /** What [of] reads of one node. */
    class NodeShape(
        val className: String?,
        val text: CharSequence?,
        val contentDescription: CharSequence?,
        val checkable: Boolean,
        val clickable: Boolean,
        val longClickable: Boolean,
        val focusable: Boolean,
        val scrollable: Boolean,
    )

    companion object {
        /** The hierarchy dump's attribute for [name], on the control. */
        const val NAME_DUMP_ATTRIBUTE = "tapsmith-name"

        /** The hierarchy dump's attribute for [label], on the control. */
        const val LABEL_DUMP_ATTRIBUTE = "tapsmith-label"

        /**
         * How many ancestors up the row may be. A preference's switch is two
         * levels below its row (the row's `widget_frame` between them); the
         * cap bounds the parent reads a nameless control costs.
         */
        const val MAX_ROW_DEPTH = 4

        /**
         * Containers no row is above: a list or scroll view holds rows, it is
         * not one. A RecyclerView is focusable, so without this a nameless
         * switch directly in a list would take the whole list's text.
         */
        private val CONTAINER_CLASSES: Set<String> =
            setOf(
                "android.widget.ListView",
                "android.widget.GridView",
                "android.widget.ExpandableListView",
                "androidx.recyclerview.widget.RecyclerView",
                "android.widget.ScrollView",
                "android.widget.HorizontalScrollView",
                "androidx.core.widget.NestedScrollView",
            )

        /** Whether TalkBack focuses [node] on its own: it is clickable, long-clickable or focusable. */
        fun isActionable(node: NodeShape): Boolean = node.clickable || node.longClickable || node.focusable

        /**
         * Whether [control] may take a row's name: a checkable control that
         * TalkBack does not focus on its own, with no text or content
         * description of its own.
         */
        fun mayTakeRowName(control: NodeShape): Boolean =
            control.checkable &&
                !isActionable(control) &&
                TextMatch.normalize(control.text?.toString() ?: "").isEmpty() &&
                TextMatch.normalize(control.contentDescription?.toString() ?: "").isEmpty()

        /**
         * The name [control] takes from its row, or null: the nearest
         * actionable ancestor within [MAX_ROW_DEPTH] levels, unless a list or
         * scrolling container, or another checkable control, comes first.
         * [textParts] reads a row's text in reading order, leaving out
         * actionable descendants (TalkBack reads those on their own).
         */
        fun <N> of(
            control: N,
            shape: (N) -> NodeShape,
            parent: (N) -> N?,
            textParts: (N) -> List<String>,
        ): RowName? {
            if (!mayTakeRowName(shape(control))) return null
            var node = control
            repeat(MAX_ROW_DEPTH) {
                val ancestor = parent(node) ?: return null
                val ancestorShape = shape(ancestor)
                if (ancestorShape.scrollable || ancestorShape.className in CONTAINER_CLASSES) return null
                if (ancestorShape.checkable) return null
                if (isActionable(ancestorShape)) return rowName(ancestor, ancestorShape, textParts)
                node = ancestor
            }
            return null
        }

        private fun <N> rowName(
            row: N,
            rowShape: NodeShape,
            textParts: (N) -> List<String>,
        ): RowName? {
            val description = rowShape.contentDescription?.toString()
            if (description != null && TextMatch.normalize(description).isNotEmpty()) return RowName(description, description)
            val parts = textParts(row).filter { TextMatch.normalize(it).isNotEmpty() }
            if (parts.isEmpty()) return null
            return RowName(parts.joinToString(" "), parts.first())
        }
    }
}
