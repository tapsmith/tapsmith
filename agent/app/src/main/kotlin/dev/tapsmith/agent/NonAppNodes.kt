package dev.tapsmith.agent

import android.view.accessibility.AccessibilityWindowInfo

/**
 * What no user locator matches (PILOT-756, PILOT-830): the nodes on screen
 * that are not the app's own content.
 *
 * - The input method's window: the keyboard's keys, so a "Done" button
 *   beside an open keyboard is not ambiguous with its Done key.
 * - System UI's bars: the status bar (its clock and icons) and the
 *   navigation bar (its Back and Home) — System UI's own system windows that
 *   are bar-shaped (the display's full width or height, and thin) and
 *   neither focused nor active. Everything else stays matchable: a
 *   pulled-down notification shade or quick settings panel (focused and
 *   active, measured on API 33 and 36, so it matches after
 *   `device.openNotifications()`), a heads-up notification (not a bar), the
 *   app's own overlay windows and the system's error dialogs (not System
 *   UI's), and every other app's window — a permission dialog is the
 *   permission controller's.
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

    /** A bar's thickness, at most, as a fraction of the display's other dimension. */
    private const val BAR_MAX_THICKNESS = 0.25

    /** A bar's length, at least, as a fraction of the display's dimension it spans. */
    private const val BAR_MIN_LENGTH = 0.9

    /**
     * Whether no locator matches anything in a window of [type]
     * (AccessibilityWindowInfo.TYPE_*) that is or isn't [focused] / [active],
     * with [bounds] on a display of [displayWidth] × [displayHeight], whose
     * root node belongs to [packageName] — read only when it decides, as it
     * costs a round-trip.
     */
    fun excludesWindow(
        type: Int,
        focused: Boolean,
        active: Boolean,
        bounds: HierarchyAttributes.Box,
        displayWidth: Int,
        displayHeight: Int,
        packageName: () -> CharSequence?,
    ): Boolean =
        when (type) {
            AccessibilityWindowInfo.TYPE_INPUT_METHOD -> true
            AccessibilityWindowInfo.TYPE_SYSTEM ->
                !focused &&
                    !active &&
                    isBar(bounds, displayWidth, displayHeight) &&
                    packageName()?.toString() == SYSTEM_UI_PACKAGE
            else -> false
        }

    /** Whether [b] spans the display's full width and is thin (a top or bottom bar), or its full height and is narrow (a side bar). */
    fun isBar(
        b: HierarchyAttributes.Box,
        displayWidth: Int,
        displayHeight: Int,
    ): Boolean {
        if (displayWidth <= 0 || displayHeight <= 0) return false
        val width = b.right - b.left
        val height = b.bottom - b.top
        if (width <= 0 || height <= 0) return false
        val horizontal = width >= displayWidth * BAR_MIN_LENGTH && height <= displayHeight * BAR_MAX_THICKNESS
        val vertical = height >= displayHeight * BAR_MIN_LENGTH && width <= displayWidth * BAR_MAX_THICKNESS
        return horizontal || vertical
    }
}
