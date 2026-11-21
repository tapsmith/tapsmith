package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The name a control with none of its own takes from the row it sits in
 * ([RowName]): an androidx SwitchPreferenceCompat's switch is unnamed, and
 * TalkBack reads its row as "Full black, off, switch".
 */
class RowNameTest {
    private class Node(
        val className: String = "android.widget.LinearLayout",
        val text: String? = null,
        val contentDescription: String? = null,
        val checkable: Boolean = false,
        val clickable: Boolean = false,
        val longClickable: Boolean = false,
        val focusable: Boolean = false,
        val scrollable: Boolean = false,
        val children: MutableList<Node> = mutableListOf(),
    ) {
        var parent: Node? = null

        fun add(vararg kids: Node): Node {
            for (kid in kids) {
                kid.parent = this
                children.add(kid)
            }
            return this
        }
    }

    private fun shape(n: Node) =
        RowName.NodeShape(
            className = n.className,
            text = n.text,
            contentDescription = n.contentDescription,
            checkable = n.checkable,
            clickable = n.clickable,
            longClickable = n.longClickable,
            focusable = n.focusable,
            scrollable = n.scrollable,
        )

    private fun nameOf(control: Node): RowName? =
        RowName.of(
            control,
            shape = ::shape,
            parent = { it.parent },
            textParts = { row ->
                FindRules.descendantTextParts(
                    row,
                    children = { it.children },
                    ownText = { it.text ?: it.contentDescription },
                    maxDepth = 6,
                    skip = { RowName.isActionable(shape(it)) },
                )
            },
        )

    private fun unnamedSwitch() = Node(className = "android.widget.Switch", checkable = true)

    /** androidx Preference's layout: row > (icon, RelativeLayout(title, summary), widget_frame > switch). */
    private fun preferenceRow(
        control: Node,
        title: String = "Full black",
        summary: String? = "Use full black for the dark theme",
        rowDescription: String? = null,
    ): Node {
        val texts = Node(className = "android.widget.RelativeLayout").add(Node(className = "android.widget.TextView", text = title))
        if (summary != null) texts.add(Node(className = "android.widget.TextView", text = summary))
        return Node(clickable = true, focusable = true, contentDescription = rowDescription).add(
            Node(className = "android.widget.FrameLayout").add(Node(className = "android.widget.ImageView")),
            texts,
            Node().add(control),
        )
    }

    @Test
    fun `an unnamed switch in a preference row is named by the row's text and labelled by its title`() {
        val control = unnamedSwitch()
        Node(className = "androidx.recyclerview.widget.RecyclerView", focusable = true, scrollable = true).add(preferenceRow(control))
        assertEquals(RowName("Full black Use full black for the dark theme", "Full black"), nameOf(control))
    }

    @Test
    fun `a row with no summary names the control by its title alone`() {
        val control = Node(className = "android.widget.CheckBox", checkable = true)
        preferenceRow(control, title = "Wi-Fi only", summary = null)
        assertEquals(RowName("Wi-Fi only", "Wi-Fi only"), nameOf(control))
    }

    @Test
    fun `a described row names the control by its description`() {
        val control = unnamedSwitch()
        preferenceRow(control, rowDescription = "Dark mode")
        assertEquals(RowName("Dark mode", "Dark mode"), nameOf(control))
    }

    @Test
    fun `a control with a name of its own keeps it`() {
        val labelled = Node(className = "android.widget.Switch", checkable = true, text = "Wi-Fi")
        preferenceRow(labelled)
        assertNull(nameOf(labelled))
        val described = Node(className = "android.widget.Switch", checkable = true, contentDescription = "Wi-Fi")
        preferenceRow(described)
        assertNull(nameOf(described))
    }

    @Test
    fun `a control TalkBack focuses on its own takes no row name`() {
        for (control in listOf(
            Node(className = "android.widget.Switch", checkable = true, clickable = true),
            Node(className = "android.widget.Switch", checkable = true, focusable = true),
            Node(className = "android.widget.Switch", checkable = true, longClickable = true),
        )) {
            preferenceRow(control)
            assertNull(nameOf(control))
        }
    }

    @Test
    fun `only a checkable control takes a row name`() {
        val image = Node(className = "android.widget.ImageView")
        preferenceRow(image)
        assertNull(nameOf(image))
    }

    @Test
    fun `a list or scrolling container is no row`() {
        val inList = unnamedSwitch()
        Node(className = "androidx.recyclerview.widget.RecyclerView", focusable = true, scrollable = true).add(
            Node().add(Node(className = "android.widget.TextView", text = "Title"), Node().add(inList)),
        )
        assertNull(nameOf(inList))
        val inScroll = unnamedSwitch()
        Node(className = "android.widget.ScrollView").add(Node().add(Node(className = "android.widget.TextView", text = "Title"), inScroll))
        assertNull(nameOf(inScroll))
        val inScrollable = unnamedSwitch()
        Node(
            className = "android.view.ViewGroup",
            scrollable = true,
        ).add(Node(className = "android.widget.TextView", text = "T"), inScrollable)
        assertNull(nameOf(inScrollable))
    }

    @Test
    fun `another checkable control is no row`() {
        val control = unnamedSwitch()
        Node(className = "android.widget.CheckedTextView", checkable = true, clickable = true, text = "Pick").add(control)
        assertNull(nameOf(control))
    }

    @Test
    fun `no actionable ancestor gives no name`() {
        val control = unnamedSwitch()
        Node().add(Node(className = "android.widget.TextView", text = "Title"), Node().add(control))
        assertNull(nameOf(control))
    }

    @Test
    fun `a row too far above the control is not its row`() {
        val control = unnamedSwitch()
        var inner = Node().add(control)
        repeat(RowName.MAX_ROW_DEPTH) { inner = Node().add(inner) }
        Node(clickable = true).add(Node(className = "android.widget.TextView", text = "Far"), inner)
        assertNull(nameOf(control))
    }

    @Test
    fun `a row with no text gives no name`() {
        val control = unnamedSwitch()
        Node(clickable = true).add(Node(className = "android.widget.ImageView"), Node().add(control))
        assertNull(nameOf(control))
    }

    @Test
    fun `the text of another actionable child of the row is not part of the name`() {
        val control = unnamedSwitch()
        Node(clickable = true).add(
            Node(className = "android.widget.TextView", text = "Sync"),
            Node(className = "android.widget.Button", text = "Edit", clickable = true, focusable = true),
            Node().add(control),
        )
        assertEquals(RowName("Sync", "Sync"), nameOf(control))
    }

    @Test
    fun `isActionable is clickable, long-clickable or focusable`() {
        assertTrue(RowName.isActionable(shape(Node(clickable = true))))
        assertTrue(RowName.isActionable(shape(Node(longClickable = true))))
        assertTrue(RowName.isActionable(shape(Node(focusable = true))))
        assertFalse(RowName.isActionable(shape(Node())))
    }
}
