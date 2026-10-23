package dev.tapsmith.agent

import android.view.accessibility.AccessibilityWindowInfo

/**
 * What no user locator matches (PILOT-756, PILOT-830): the nodes on screen
 * that are not the app's own content.
 *
 * - The input method's window: the keyboard's keys, so a "Done" button
 *   beside an open keyboard is not ambiguous with its Done key.
 * - System UI's own system windows while they are neither focused nor
 *   active: the status bar (its clock and icons), the navigation bar (its
 *   Back and Home), and a heads-up notification. A pulled-down notification
 *   shade or quick settings panel is focused and active (measured on API
 *   33 and 36), so it stays matchable after `device.openNotifications()`. Only
 *   windows System UI owns: the app's own overlay windows, the system's
 *   error dialogs (package `android`) and every other app's window — a
 *   permission dialog is the permission controller's — stay matchable.
 * - The `@tapsmith/react-native` hooks marker, which exists only for Tapsmith
 *   to read from the hierarchy dump.
 *
 * The one place the agent decides it: [ElementFinder] drops candidates in an
 * excluded window or carrying the marker, and leaves the marker out of a
 * container's aggregated text; [HierarchyDumper] marks excluded windows' root
 * nodes `tapsmith-non-app="true"` so the trace viewer's matcher applies the
 * same rule (packages/tapsmith non-app-nodes.ts). The iOS agent has its own
 * (NonAppElements.swift). Kept free of Android framework calls so the host
 * tests can pin it.
 */
internal object NonAppNodes {
    /** `@tapsmith/react-native`'s marker prefix; pinned to the SDK's HOOKS_MARKER_PREFIX by non-app-nodes.test.ts. */
    const val HOOKS_MARKER_PREFIX = "tapsmith-hooks:"

    /** The package that owns the status bar, navigation bar and notification windows. */
    const val SYSTEM_UI_PACKAGE = "com.android.systemui"

    /** The dump attribute marking an excluded window's root node. */
    const val DUMP_ATTRIBUTE = "tapsmith-non-app"

    /** Whether a node with this text or content description is a hooks marker. */
    fun isHooksMarker(
        text: CharSequence?,
        contentDescription: CharSequence?,
    ): Boolean =
        text?.startsWith(HOOKS_MARKER_PREFIX) == true ||
            contentDescription?.startsWith(HOOKS_MARKER_PREFIX) == true

    /**
     * Whether no locator matches anything in a window of [type]
     * (AccessibilityWindowInfo.TYPE_*) that is or isn't [focused] / [active],
     * whose root node belongs to [packageName] — read only when it decides,
     * as it costs a round-trip.
     */
    fun excludesWindow(
        type: Int,
        focused: Boolean,
        active: Boolean,
        packageName: () -> CharSequence?,
    ): Boolean =
        when (type) {
            AccessibilityWindowInfo.TYPE_INPUT_METHOD -> true
            AccessibilityWindowInfo.TYPE_SYSTEM -> !focused && !active && packageName()?.toString() == SYSTEM_UI_PACKAGE
            else -> false
        }
}
