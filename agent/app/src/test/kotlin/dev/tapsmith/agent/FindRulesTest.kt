package dev.tapsmith.agent

import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.uiautomator.UiObject2
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-side tests for the decisions the snapshot-based finder makes
 * (PILOT-539). They pin the matching semantics the finder had when it read
 * every attribute through live UiObject2 getters, so reading the tree-walk
 * snapshot instead changes the cost of a query, not its answer.
 */
class FindRulesTest {
    // ─── Expanded state (PILOT-655) ───

    @Test
    fun `a collapsible element is expanded, an expand-only one collapsed, and one with neither has no state`() {
        assertEquals(true, FindRules.expandedState(canExpand = false, canCollapse = true))
        assertEquals(true, FindRules.expandedState(canExpand = true, canCollapse = true))
        assertEquals(false, FindRules.expandedState(canExpand = true, canCollapse = false))
        assertNull(FindRules.expandedState(canExpand = false, canCollapse = false))
    }

    // ─── Trait / dual-path roles ───

    private val textViewSet = setOf("android.widget.TextView")
    private val imageSet = setOf("android.widget.ImageView", "androidx.appcompat.widget.AppCompatImageView")

    @Test
    fun `a published role description decides the role, whatever the class`() {
        assertTrue(FindRules.matchesTraitRole("heading", "android.view.ViewGroup", setOf("heading", "header"), textViewSet, true))
        assertTrue(FindRules.matchesTraitRole("header", "android.view.ViewGroup", setOf("heading", "header"), textViewSet, true))
        // A role description wins over a matching class: an ImageView an RN
        // app calls a "button" is not an image.
        assertFalse(FindRules.matchesTraitRole("button", "android.widget.ImageView", setOf("image"), imageSet, false))
    }

    @Test
    fun `without a role description, only an unambiguous class set matches by class`() {
        assertTrue(FindRules.matchesTraitRole(null, "android.widget.ImageView", setOf("image"), imageSet, false))
        assertFalse(FindRules.matchesTraitRole(null, "android.widget.Button", setOf("image"), imageSet, false))
        // heading/link share TextView with "text", so a bare TextView is neither.
        assertFalse(FindRules.matchesTraitRole(null, "android.widget.TextView", setOf("heading", "header"), textViewSet, true))
        // Trait-only roles have no class set at all.
        assertFalse(FindRules.matchesTraitRole(null, "android.widget.TextView", setOf("alert"), emptySet(), false))
        assertFalse(FindRules.matchesTraitRole(null, null, setOf("image"), imageSet, false))
    }

    // ─── Role descriptions (PILOT-656) ───

    @Test
    fun `RN and Compose multi-word role descriptions read as the role name`() {
        // React Native's (and Compose's) English role descriptions.
        assertEquals("progressbar", FindRules.canonicalRoleDescription("Progress Bar"))
        assertEquals("toolbar", FindRules.canonicalRoleDescription("Tool Bar"))
        assertEquals("combobox", FindRules.canonicalRoleDescription("Combo Box"))
        assertEquals("tab", FindRules.canonicalRoleDescription("Tab"))
        assertEquals("tablist", FindRules.canonicalRoleDescription("Tab List"))
        assertEquals("menuitem", FindRules.canonicalRoleDescription("Menu Item"))
        assertEquals("menubar", FindRules.canonicalRoleDescription("Menu Bar"))
        assertEquals("radiogroup", FindRules.canonicalRoleDescription("Radio Group"))
        assertEquals("scrollbar", FindRules.canonicalRoleDescription("Scroll Bar"))
        assertEquals("spinbutton", FindRules.canonicalRoleDescription("Spin Button"))
        // RN's accessibilityRole="imagebutton" is an ImageButton: a button.
        assertEquals("button", FindRules.canonicalRoleDescription("Button, Image"))
    }

    @Test
    fun `other role descriptions are only lowercased`() {
        assertEquals("link", FindRules.canonicalRoleDescription("Link"))
        assertEquals("search", FindRules.canonicalRoleDescription("search"))
        assertEquals("shopping cart item", FindRules.canonicalRoleDescription("Shopping Cart Item"))
        assertNull(FindRules.canonicalRoleDescription(null))
        assertNull(FindRules.canonicalRoleDescription(""))
    }

    @Test
    fun `roles RN publishes only as a description resolve through it`() {
        // RN renders these on a generic android.view.View with a role
        // description, so getByRole must read the description (PILOT-656).
        for (role in listOf("progressbar", "toolbar", "heading", "link", "image", "searchfield", "tablist")) {
            assertTrue("$role is dual-path", role in ElementFinder.DUAL_PATH_ROLES)
        }
        assertTrue(FindRules.matchesTraitRole("tab", "android.view.View", setOf("tab"), emptySet(), false))
    }

    @Test
    fun `a tab is a tab item and the tab container is a tablist`() {
        // PILOT-514: TabWidget / TabLayout are the containers, so they are
        // "tablist" classes; a tab item is known only by its "Tab" role
        // description (RN, Material's TabView and NavigationBarItemView,
        // Compose's Role.Tab).
        assertTrue("tab is description-only", "tab" in ElementFinder.TRAIT_ONLY_ROLES)
        assertFalse("tab has no classes", "tab" in ElementFinder.DUAL_PATH_ROLES)
        val listClasses = setOf("android.widget.TabWidget", "com.google.android.material.tabs.TabLayout")
        // Material's TabView publishes "Tab" on a LinearLayout.
        assertTrue(FindRules.matchesTraitRole("tab", "android.widget.LinearLayout", setOf("tab"), emptySet(), false))
        // An undescribed TabWidget is not a tab, but is a tablist by class.
        assertFalse(FindRules.matchesTraitRole(null, "android.widget.TabWidget", setOf("tab"), emptySet(), false))
        assertTrue(FindRules.matchesTraitRole(null, "android.widget.TabWidget", setOf("tablist"), listClasses, false))
        // RN's tab list container is a tablist, not a tab.
        val rnList = FindRules.canonicalRoleDescription("Tab List")
        assertFalse(FindRules.matchesTraitRole(rnList, "android.view.View", setOf("tab"), emptySet(), false))
        assertTrue(FindRules.matchesTraitRole(rnList, "android.view.View", setOf("tablist"), listClasses, false))
        // A tab item inside a TabLayout is not the tablist.
        assertFalse(FindRules.matchesTraitRole("tab", "android.widget.LinearLayout", setOf("tablist"), listClasses, false))
    }

    @Test
    fun `RN's description-only roles resolve through the description alone`() {
        // PILOT-664: RN publishes these only as a role description on a
        // generic View ("Menu Item", "Timer"), so they have no class at all.
        val roles = listOf("menu", "menubar", "menuitem", "radiogroup", "scrollbar", "spinbutton", "summary", "timer")
        for (role in roles) {
            assertTrue("$role is description-only", role in ElementFinder.TRAIT_ONLY_ROLES)
        }
        assertEquals("menu", FindRules.canonicalRoleDescription("Menu"))
        assertEquals("timer", FindRules.canonicalRoleDescription("Timer"))
        assertEquals("summary", FindRules.canonicalRoleDescription("Summary"))
        val menuItem = FindRules.canonicalRoleDescription("Menu Item")
        assertTrue(FindRules.matchesTraitRole(menuItem, "android.view.View", setOf("menuitem"), emptySet(), false))
        // A menu item is not the menu, and an undescribed View is neither.
        assertFalse(FindRules.matchesTraitRole(menuItem, "android.view.View", setOf("menu"), emptySet(), false))
        assertFalse(FindRules.matchesTraitRole(null, "android.view.View", setOf("menuitem"), emptySet(), false))
        // RN's spin button names a class no widget has; the description decides.
        assertTrue(FindRules.matchesTraitRole("spinbutton", "android.widget.SpinButton", setOf("spinbutton"), emptySet(), false))
    }

    @Test
    fun `radio is an alias of radiobutton`() {
        assertEquals("radiobutton", ElementFinder.ROLE_ALIASES["radio"])
    }

    // ─── Effective text ───

    @Test
    fun `own text is the value unless the field is showing its hint`() {
        assertEquals("typed", FindRules.effectiveText("typed", { false }, { "child" }))
        assertNull(FindRules.effectiveText("Email", { true }, { "child" }))
    }

    @Test
    fun `empty own text falls back to descendant text, and never reads the hint flag`() {
        val noHintRead = { throw AssertionError("hint flag read for an element with no own text") }
        assertEquals("Welcome to Expo", FindRules.effectiveText(null, noHintRead, { "Welcome to Expo" }))
        assertEquals("joined", FindRules.effectiveText("", noHintRead, { "joined" }))
        assertNull(FindRules.effectiveText(null, noHintRead, { "" }))
    }

    @Test
    fun `descendant text is only read when own text is empty`() {
        val noDescendants = { throw AssertionError("descendant text read for an element with own text") }
        assertEquals("own", FindRules.effectiveText("own", { false }, noDescendants))
    }

    // ─── Descendant text ───

    private class Node(
        val text: String? = null,
        val desc: String? = null,
        val visible: Boolean = true,
        val children: List<Node> = emptyList(),
    )

    private fun parts(
        root: Node,
        maxDepth: Int = 6,
    ) = FindRules.descendantTextParts(
        root,
        children = { n -> n.children.filter { it.visible } },
        ownText = { n -> n.text?.takeIf { it.isNotEmpty() } ?: n.desc?.takeIf { it.isNotEmpty() } },
        maxDepth = maxDepth,
    )

    @Test
    fun `each child contributes its text, else its description, else its own descendants`() {
        val root =
            Node(
                children =
                    listOf(
                        Node(text = "Hello", desc = "ignored when text is present"),
                        Node(text = "", desc = "Icon"),
                        Node(children = listOf(Node(text = "nested"), Node(desc = "deep desc"))),
                    ),
            )
        assertEquals(listOf("Hello", "Icon", "nested", "deep desc"), parts(root))
    }

    @Test
    fun `a child with text does not contribute its descendants`() {
        val root = Node(children = listOf(Node(text = "Row", children = listOf(Node(text = "inner")))))
        assertEquals(listOf("Row"), parts(root))
    }

    @Test
    fun `invisible children are skipped with their whole subtree`() {
        val root =
            Node(
                children =
                    listOf(
                        Node(text = "shown"),
                        Node(visible = false, text = "hidden"),
                        Node(visible = false, children = listOf(Node(text = "hidden child"))),
                    ),
            )
        assertEquals(listOf("shown"), parts(root))
    }

    @Test
    fun `recursion stops at the depth cap`() {
        // root -> d1 -> d2 -> leaf(text): the leaf is read while expanding
        // d2, at depth 2, so a cap of 3 reaches it and a cap of 2 does not.
        val root = Node(children = listOf(Node(children = listOf(Node(children = listOf(Node(text = "leaf")))))))
        assertEquals(listOf("leaf"), parts(root, maxDepth = 3))
        assertEquals(emptyList<String>(), parts(root, maxDepth = 2))
    }

    // ─── Reflection contract ───

    /**
     * The finder reads UiObject2's tree-walk node without refreshing it and
     * clips its bounds with UiObject2's own visible-bounds rule. Both are
     * private members of the uiautomator version this APK bundles; this test
     * fails the build when a uiautomator bump renames them, instead of every
     * query silently falling back to (or failing on) live reads.
     */
    @Test
    fun `the bundled uiautomator exposes the members the snapshot reader uses`() {
        val field = UiObject2::class.java.getDeclaredField(ElementFinder.CACHED_NODE_FIELD)
        assertEquals(AccessibilityNodeInfo::class.java, field.type)
        val method =
            UiObject2::class.java.getDeclaredMethod(
                ElementFinder.VISIBLE_BOUNDS_METHOD,
                AccessibilityNodeInfo::class.java,
            )
        assertEquals(android.graphics.Rect::class.java, method.returnType)
        // The refreshed read every find falls back to below API 34.
        val refreshed = UiObject2::class.java.getDeclaredMethod("getAccessibilityNodeInfo")
        assertEquals(AccessibilityNodeInfo::class.java, refreshed.returnType)
    }
}

/** Host-side tests for the swipe settle's scroll-event filter (PILOT-539). */
class SwipeSettleTest {
    @Test
    fun `a vertical swipe settles on vertical scrolling only`() {
        assertTrue(SwipeSettle.isAlongAxis(deltaX = 0, deltaY = 42, vertical = true))
        assertTrue(SwipeSettle.isAlongAxis(deltaX = 0, deltaY = -42, vertical = true))
        // A carousel scrolling sideways on its own does not hold it open.
        assertFalse(SwipeSettle.isAlongAxis(deltaX = 300, deltaY = 0, vertical = true))
    }

    @Test
    fun `a horizontal swipe settles on horizontal scrolling only`() {
        assertTrue(SwipeSettle.isAlongAxis(deltaX = 120, deltaY = 0, vertical = false))
        assertFalse(SwipeSettle.isAlongAxis(deltaX = 0, deltaY = 80, vertical = false))
    }

    @Test
    fun `an unreported delta still counts as scrolling`() {
        assertTrue(SwipeSettle.isAlongAxis(deltaX = -1, deltaY = -1, vertical = true))
        assertTrue(SwipeSettle.isAlongAxis(deltaX = -1, deltaY = -1, vertical = false))
        assertTrue(SwipeSettle.isAlongAxis(deltaX = -1, deltaY = 0, vertical = true))
    }

    @Test
    fun `a ListView's zero-delta scroll events count as scrolling`() {
        // AbsListView reports every scroll through onScrollChanged(0, 0, 0, 0).
        assertTrue(SwipeSettle.isAlongAxis(deltaX = 0, deltaY = 0, vertical = true))
        assertTrue(SwipeSettle.isAlongAxis(deltaX = 0, deltaY = 0, vertical = false))
    }
}

/** Host-side tests for the swipe settle's quiet-window arithmetic (PILOT-539). */
class SwipeSettleQuietTest {
    @Test
    fun `quiet is counted from the settle start when no scroll event came after it`() {
        assertEquals(300L, SwipeSettle.remainingQuietMs(now = 1000, started = 1000, lastScrollAt = 0, quietMs = 300))
        assertEquals(0L, SwipeSettle.remainingQuietMs(now = 1300, started = 1000, lastScrollAt = 900, quietMs = 300))
    }

    @Test
    fun `a scroll event that arrived during the settle restarts the quiet window`() {
        assertEquals(250L, SwipeSettle.remainingQuietMs(now = 1100, started = 1000, lastScrollAt = 1050, quietMs = 300))
        assertTrue(SwipeSettle.remainingQuietMs(now = 1400, started = 1000, lastScrollAt = 1050, quietMs = 300) < 0)
    }
}
