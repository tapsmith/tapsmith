package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * PILOT-828: Jetpack Compose reports a merging node's role (a Button, a
 * NavigationBarItem, a toggleable row) on a fake leaf child it appends
 * (compose-ui `SemanticsNode.emitFakeNodes`), not on the node itself. The
 * shapes below are recorded from a Material3 1.3.2 / compose-ui 1.8.2 dump on
 * API 36.
 */
class ComposeRolesTest {
    private fun shape(
        className: String?,
        role: String? = null,
        text: String? = null,
        contentDescription: String? = null,
        childCount: Int = 0,
        clickable: Boolean = false,
        longClickable: Boolean = false,
        focusable: Boolean = false,
        checkable: Boolean = false,
    ) = ComposeRoles.NodeShape(className, role, text, contentDescription, childCount, clickable, longClickable, focusable, checkable)

    // M3 Button: a clickable View (2 children: Text "Sign in", then the fake Button).
    private val buttonParent = shape("android.view.View", childCount = 2, clickable = true, focusable = true)
    private val buttonCarrier = shape("android.widget.Button", role = "button")

    // NavigationBarItem: the selected item is not clickable; its fake child has the "Tab" description.
    private val selectedTabParent = shape("android.view.View", childCount = 3, focusable = true)
    private val tabCarrier = shape("android.view.View", role = "tab")

    @Test
    fun `a Compose merging node's fake role child is a carrier`() {
        assertTrue(ComposeRoles.isCarrier(buttonCarrier, { buttonParent }, { true }))
        assertTrue(ComposeRoles.isCarrier(tabCarrier, { selectedTabParent }, { true }))
        // A toggleable Row's fake CheckBox, and a Switch description.
        assertTrue(ComposeRoles.isCarrier(shape("android.widget.CheckBox", role = "checkbox"), { buttonParent }, { true }))
        assertTrue(ComposeRoles.isCarrier(shape("android.view.View", role = "switch"), { buttonParent }, { true }))
    }

    @Test
    fun `only the last child carries the role`() {
        // The content-description fake node is inserted first, the role one appended.
        assertFalse(ComposeRoles.isCarrier(buttonCarrier, { buttonParent }, { false }))
    }

    @Test
    fun `a real control is never a carrier`() {
        // A bare M3 Checkbox / Switch is a clickable, checkable leaf with the role itself.
        val checkbox = shape("android.widget.CheckBox", role = "checkbox", clickable = true, focusable = true, checkable = true)
        assertFalse(ComposeRoles.isCarrier(checkbox, { buttonParent }, { true }))
        val focusable = shape("android.widget.Button", role = "button", focusable = true)
        assertFalse(ComposeRoles.isCarrier(focusable, { buttonParent }, { true }))
        val longClickable = shape("android.widget.Button", role = "button", longClickable = true)
        assertFalse(ComposeRoles.isCarrier(longClickable, { buttonParent }, { true }))
        // A node with a name or children of its own.
        val named = shape("android.widget.Button", role = "button", text = "OK")
        assertFalse(ComposeRoles.isCarrier(named, { buttonParent }, { true }))
        val icon = shape("android.widget.ImageView", role = "image", contentDescription = "Back")
        assertFalse(ComposeRoles.isCarrier(icon, { buttonParent }, { true }))
        assertFalse(ComposeRoles.isCarrier(shape("android.widget.Button", role = "button", childCount = 1), { buttonParent }, { true }))
    }

    @Test
    fun `only the roles Compose's Role maps to are carried`() {
        // An empty Text("") at the end of a Button is not the button's role,
        // nor a progress indicator's ProgressBar class (progress semantics, not a Role).
        assertFalse(ComposeRoles.isCarrier(shape("android.widget.TextView", role = "text"), { buttonParent }, { true }))
        assertFalse(ComposeRoles.isCarrier(shape("android.widget.ProgressBar", role = "progressbar"), { buttonParent }, { true }))
        for (role in listOf("button", "checkbox", "radiobutton", "image", "spinner", "tab", "switch")) {
            assertEquals(role, ComposeRoles.carriedRole(shape("android.view.View", role = role)))
        }
        assertFalse(ComposeRoles.isCarrier(shape("android.view.View", role = "heading"), { buttonParent }, { true }))
        assertFalse(ComposeRoles.isCarrier(shape("android.view.View"), { buttonParent }, { true }))
        assertFalse(ComposeRoles.isCarrier(shape("android.view.View", role = ""), { buttonParent }, { true }))
    }

    @Test
    fun `the parent must be a role-less Compose node with other children`() {
        // React Native's ViewGroup, and an RN View that has a role of its own.
        assertFalse(ComposeRoles.isCarrier(buttonCarrier, { shape("android.view.ViewGroup", childCount = 2) }, { true }))
        assertFalse(ComposeRoles.isCarrier(buttonCarrier, { shape("android.view.View", role = "tab", childCount = 2) }, { true }))
        // Compose emits the fake node only beside real children.
        assertFalse(ComposeRoles.isCarrier(buttonCarrier, { shape("android.view.View", childCount = 1, clickable = true) }, { true }))
        // A layout container (the screen's root, a Column) is not a merging
        // control, so an unnamed last leaf keeps its own role.
        val container = shape("android.view.View", childCount = 5)
        assertFalse(ComposeRoles.isCarrier(buttonCarrier, { container }, { true }))
        assertFalse(ComposeRoles.mayBeCarrierParent(container))
        // A disabled Button is still clickable; a toggleable row checkable.
        assertTrue(ComposeRoles.mayBeCarrierParent(shape("android.view.View", childCount = 2, clickable = true)))
        assertTrue(ComposeRoles.mayBeCarrierParent(shape("android.view.View", childCount = 2, checkable = true)))
        assertFalse(ComposeRoles.isCarrier(buttonCarrier, { null }, { true }))
    }

    @Test
    fun `the parent is read only for a carrier-shaped leaf`() {
        var reads = 0
        val parent = {
            reads++
            buttonParent
        }
        ComposeRoles.isCarrier(shape("android.widget.Button", role = "button", text = "OK"), parent, { true })
        ComposeRoles.isCarrier(shape("android.widget.TextView", role = "text"), parent, { true })
        assertEquals(0, reads)
    }

    @Test
    fun `the role a carrier gives its parent`() {
        assertEquals("button", ComposeRoles.carriedRole(buttonCarrier))
        assertEquals("tab", ComposeRoles.carriedRole(tabCarrier))
        assertNull(ComposeRoles.carriedRole(shape("android.widget.TextView", role = "text")))
    }

    // ─── The match step (ElementFinder.matchCandidates) ───

    /** A Compose button row: its text, then its role carrier; and a plain button after it. */
    private val parents = mapOf("rowCarrier" to "row")
    private val roles = mapOf("rowCarrier" to "button", "plainButton" to "button")

    private fun match(
        candidates: List<String>,
        limit: Int = Int.MAX_VALUE,
        skip: Set<String> = emptySet(),
    ): List<String> =
        ComposeRoles.matchInTreeOrder(
            candidates,
            limit,
            read = { it.takeUnless { c -> c in skip } },
            carrierParentOf = { parents[it] },
            key = { it },
            accepts = { _, roleSource -> roles[roleSource] == "button" },
        )

    @Test
    fun `a class walk finds the carrier and matches its parent instead`() {
        // getByRole("button") walks By.clazz(Button): the carrier, not the row.
        assertEquals(listOf("row", "plainButton"), match(listOf("rowCarrier", "plainButton")))
    }

    @Test
    fun `a broad walk reaches the parent twice and matches it once`() {
        // getByRole("tab") walks every node: the row as itself (no role of
        // its own) and again through its carrier.
        assertEquals(listOf("row", "plainButton"), match(listOf("screen", "row", "rowText", "rowCarrier", "plainButton")))
    }

    @Test
    fun `a parent that matches as itself is not matched again through its carrier`() {
        val both =
            ComposeRoles.matchInTreeOrder(
                listOf("row", "rowCarrier"),
                Int.MAX_VALUE,
                read = { it },
                carrierParentOf = { parents[it] },
                key = { it },
                accepts = { _, _ -> true },
            )
        assertEquals(listOf("row"), both)
    }

    @Test
    fun `the carrier itself is never offered, and the limit and non-app skips hold`() {
        val offered = mutableListOf<String>()
        ComposeRoles.matchInTreeOrder(
            listOf("rowCarrier"),
            Int.MAX_VALUE,
            read = { it },
            carrierParentOf = { parents[it] },
            key = { it },
            accepts = { target, _ -> offered.add(target) },
        )
        assertEquals(listOf("row"), offered)
        assertEquals(listOf("row"), match(listOf("rowCarrier", "plainButton"), limit = 1))
        assertEquals(listOf("plainButton"), match(listOf("rowCarrier", "plainButton"), skip = setOf("rowCarrier")))
    }

    @Test
    fun `switch is a dual-path role`() {
        // Compose's Switch is a View with the "Switch" description; the
        // framework and AppCompat switches are classes.
        assertTrue("switch" in ElementFinder.DUAL_PATH_ROLES)
        val switchClasses = setOf("android.widget.Switch", "androidx.appcompat.widget.SwitchCompat")
        assertTrue(FindRules.matchesTraitRole("switch", "android.view.View", setOf("switch"), switchClasses, false))
        assertTrue(FindRules.matchesTraitRole(null, "android.widget.Switch", setOf("switch"), switchClasses, false))
    }
}
