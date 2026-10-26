package dev.tapsmith.agent

import android.app.Instrumentation
import android.graphics.Rect
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.uiautomator.UiDevice
import java.io.ByteArrayOutputStream

/**
 * Dumps the current UI hierarchy from UIAutomator as an XML string.
 *
 * The hierarchy includes all visible windows and their element trees,
 * with properties such as class, text, content-desc, resource-id, bounds,
 * enabled, checked, focused, clickable, scrollable, and more.
 *
 * Post-processes the stock UIAutomator XML to inject `tapsmith-role`
 * attributes for elements with trait-based roles (heading, alert, link,
 * combobox, etc.) that React Native surfaces via AccessibilityNodeInfo
 * bundle extras but the stock dump doesn't include, and `tapsmith-expanded`
 * for elements with an expanded state (their expand/collapse actions).
 */
class HierarchyDumper(
    private val device: UiDevice,
    private val instrumentation: Instrumentation,
) {
    companion object {
        private const val TAG = "TapsmithHierarchy"

        private const val ROLE_DESCRIPTION_EXTRA_KEY =
            "AccessibilityNodeInfo.roleDescription"
        private const val ROLE_DESCRIPTION_LONG_FORM_KEY =
            "androidx.view.accessibility.AccessibilityNodeInfoCompat.ROLE_DESCRIPTION_KEY"
        private const val COMPAT_BOOLEAN_PROPERTY_KEY =
            "androidx.view.accessibility.AccessibilityNodeInfoCompat.BOOLEAN_PROPERTY_KEY"
        private const val COMPAT_BOOLEAN_PROPERTY_IS_HEADING = 0x2
    }

    /**
     * Dump the full UI hierarchy as an XML string, augmented with
     * `tapsmith-role` attributes for trait-based roles and
     * `tapsmith-expanded` for elements with an expanded state.
     *
     * @return XML string representing the current UI hierarchy
     * @throws ActionFailedException if the hierarchy cannot be dumped
     */
    fun dump(): String =
        try {
            val outputStream = ByteArrayOutputStream()
            device.dumpWindowHierarchy(outputStream)
            val xml = outputStream.toString(Charsets.UTF_8.name())
            if (xml.isBlank()) {
                throw ActionFailedException("UI hierarchy dump returned empty result")
            }
            injectAttributes(xml)
        } catch (e: ActionFailedException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Failed to dump UI hierarchy", e)
            throw ActionFailedException("Failed to dump UI hierarchy: ${e.message}")
        }

    /**
     * Walk the AccessibilityNodeInfo tree to collect what the stock dump
     * leaves out, then inject it into the stock UIAutomator XML:
     * `tapsmith-role` (trait-based roles) and `tapsmith-expanded` (the
     * expanded state getByRole's `expanded` filter reads from the
     * expand/collapse actions, so the Locator Playground can apply it —
     * PILOT-655).
     */
    private fun injectAttributes(xml: String): String {
        val collected = collectAttributeMap()
        return HierarchyAttributes.markWindowRoots(
            HierarchyAttributes.inject(xml, collected.attributes),
            collected.nonAppWindowRoots,
            NonAppNodes.DUMP_ATTRIBUTE,
        )
    }

    /**
     * What [collectAttributeMap] gathers: bounds → attributes to inject, and
     * the [HierarchyAttributes.windowRootKey]s of the windows no locator
     * searches ([NonAppNodes]), whose root nodes the dump marks
     * `tapsmith-non-app="true"` so the trace viewer leaves them out too.
     */
    private class Collected(
        val attributes: Map<String, Map<String, String>>,
        val nonAppWindowRoots: Set<String>,
    )

    /**
     * Walk all accessibility windows and build a map of bounds → the
     * attributes to inject for that element (see [injectAttributes]).
     *
     * Limitation: uses bounds as the join key between the AccessibilityNodeInfo
     * tree and the UIAutomator XML. If two elements share identical bounds
     * (overlapping views, zero-size elements), the attributes land on both
     * and the last one walked wins. This is acceptable in practice since
     * trait-based roles and expandable elements are uncommon, and
     * overlapping elements with *different* ones are rarer still.
     */
    private fun collectAttributeMap(): Collected {
        val attrMap = mutableMapOf<String, MutableMap<String, String>>()
        val nonAppRoots = mutableSetOf<String>()
        try {
            val automation = instrumentation.uiAutomation
            val displayWidth = device.displayWidth
            val displayHeight = device.displayHeight
            for (window in automation.windows) {
                try {
                    val root = window.root ?: continue
                    val windowRect = Rect()
                    window.getBoundsInScreen(windowRect)
                    val windowBox = HierarchyAttributes.Box(windowRect.left, windowRect.top, windowRect.right, windowRect.bottom)
                    val clip = DumpClip(displayWidth, displayHeight, windowBox)
                    if (NonAppNodes.excludesWindow(
                            window.type,
                            window.isFocused,
                            window.isActive,
                            windowBox,
                            displayWidth,
                            displayHeight,
                        ) { root.packageName }
                    ) {
                        val rootRect = Rect()
                        root.getBoundsInScreen(rootRect)
                        val rootBounds =
                            HierarchyAttributes.dumpedBounds(
                                HierarchyAttributes.Box(rootRect.left, rootRect.top, rootRect.right, rootRect.bottom),
                                displayWidth,
                                displayHeight,
                                windowBox,
                            )
                        nonAppRoots.add(HierarchyAttributes.windowRootKey(rootBounds, root.packageName?.toString()))
                    }
                    try {
                        walkNodeInfo(root, clip, attrMap)
                    } finally {
                        @Suppress("DEPRECATION")
                        root.recycle()
                    }
                } finally {
                    @Suppress("DEPRECATION")
                    window.recycle()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to collect attributes from accessibility tree", e)
        }
        return Collected(attrMap, nonAppRoots)
    }

    @Suppress("DEPRECATION")
    private fun walkNodeInfo(
        node: AccessibilityNodeInfo,
        clip: DumpClip,
        attrMap: MutableMap<String, MutableMap<String, String>>,
    ) {
        val role = extractRoleFromNodeInfo(node)
        val expanded = extractExpandedFromNodeInfo(node)
        if (role != null || expanded != null) {
            val rect = Rect()
            node.getBoundsInScreen(rect)
            // Keyed by the bounds the stock dump writes for this node, which
            // are clipped to the display and window.
            val bounds =
                HierarchyAttributes
                    .dumpedBounds(
                        HierarchyAttributes.Box(rect.left, rect.top, rect.right, rect.bottom),
                        clip.displayWidth,
                        clip.displayHeight,
                        clip.window,
                    ).key()
            val attrs = attrMap.getOrPut(bounds) { mutableMapOf() }
            role?.let { attrs["tapsmith-role"] = it }
            expanded?.let { attrs["tapsmith-expanded"] = it.toString() }
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            walkNodeInfo(child, clip, attrMap)
            child.recycle()
        }
    }

    /** The element's expanded state, as ElementFinder's `expanded` filter reads it. */
    private fun extractExpandedFromNodeInfo(node: AccessibilityNodeInfo): Boolean? {
        val actions = node.actionList ?: return null
        return FindRules.expandedState(
            canExpand = actions.any { it.id == AccessibilityNodeInfo.AccessibilityAction.ACTION_EXPAND.id },
            canCollapse = actions.any { it.id == AccessibilityNodeInfo.AccessibilityAction.ACTION_COLLAPSE.id },
        )
    }

    /**
     * Extract a trait-based role from an AccessibilityNodeInfo. Same logic
     * as ElementFinder.extractRoleDescription but operates on the node
     * directly without needing a UiObject2 wrapper.
     */
    private fun extractRoleFromNodeInfo(node: AccessibilityNodeInfo): String? {
        try {
            if (Build.VERSION.SDK_INT >= 28 && node.isHeading) {
                return "heading"
            }
            val extras = node.extras ?: return null
            val packed = extras.getInt(COMPAT_BOOLEAN_PROPERTY_KEY, 0)
            if ((packed and COMPAT_BOOLEAN_PROPERTY_IS_HEADING) != 0) {
                return "heading"
            }
            val raw =
                extras.getCharSequence(ROLE_DESCRIPTION_EXTRA_KEY)?.toString()
                    ?: extras.getCharSequence(ROLE_DESCRIPTION_LONG_FORM_KEY)?.toString()
            return FindRules.canonicalRoleDescription(raw)
        } catch (e: Exception) {
            return null
        }
    }

    /** What the stock dump clips a node's bounds to: the display, then its window. */
    private class DumpClip(
        val displayWidth: Int,
        val displayHeight: Int,
        val window: HierarchyAttributes.Box,
    )
}
