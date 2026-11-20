package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A Flutter tab ([FlutterTab]): Material's NavigationBar, NavigationRail,
 * TabBar and BottomNavigationBar items publish `"<label>\nTab <i> of <n>"`
 * as their content description and no role. Each content description here is
 * one a Flutter 3.50 app published on an API 33 emulator.
 */
class FlutterTabTest {
    @Test
    fun `a navigation destination is named by its label`() {
        assertEquals("Contact", FlutterTab.nameOf("Contact\nTab 2 of 3"))
        assertEquals("Posts", FlutterTab.nameOf("Posts\nTab 1 of 3"))
    }

    @Test
    fun `a multi-line label keeps its line breaks`() {
        assertEquals("Inbox\n3 new", FlutterTab.nameOf("Inbox\n3 new\nTab 1 of 12"))
    }

    @Test
    fun `an item with no label is a tab named nothing`() {
        assertEquals("", FlutterTab.nameOf("Tab 2 of 3"))
    }

    @Test
    fun `other descriptions are no tab`() {
        assertNull(FlutterTab.nameOf(null))
        assertNull(FlutterTab.nameOf(""))
        assertNull(FlutterTab.nameOf("Contact"))
        assertNull(FlutterTab.nameOf("Contact Tab 2 of 3"))
        assertNull(FlutterTab.nameOf("Contact\nTab 2 of 3, double tap to open"))
        assertNull(FlutterTab.nameOf("Contact\ntab 2 of 3"))
        assertNull(FlutterTab.nameOf("Contact\nTab 0 of 3"))
        assertNull(FlutterTab.nameOf("Contact\nTab two of 3"))
        assertNull(FlutterTab.nameOf("Contact\nTab 2 von 3"))
    }

    @Test
    fun `a Flutter tab publishes the tab role`() {
        assertEquals("tab", FindRules.publishedRole(isHeading = false, rawDescription = null, contentDescription = "Contact\nTab 2 of 3"))
        assertEquals("tab", FindRules.publishedRole(isHeading = false, rawDescription = null, contentDescription = "Tab 1 of 2"))
    }

    @Test
    fun `a published role description or heading still decides`() {
        assertEquals(
            "button",
            FindRules.publishedRole(isHeading = false, rawDescription = "Button", contentDescription = "Contact\nTab 2 of 3"),
        )
        assertEquals(
            "heading",
            FindRules.publishedRole(isHeading = true, rawDescription = null, contentDescription = "Contact\nTab 2 of 3"),
        )
        assertNull(FindRules.publishedRole(isHeading = false, rawDescription = null, contentDescription = "Contact"))
    }
}
