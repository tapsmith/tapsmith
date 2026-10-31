package dev.tapsmith.agent

import android.app.Instrumentation
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.uiautomator.UiDevice

/**
 * The Android side of [SystemDialogAnswerer]: finds system ANR / crash
 * dialogs in the accessibility window list and presses their buttons.
 *
 * A dialog is a `TYPE_SYSTEM` window whose root belongs to `android` and
 * holds an `android:id/aerr_close` or `aerr_wait` button — resource ids, so
 * any display language matches. (Measured on API 36: the ANR window is
 * `TYPE_SYSTEM`, its accessibility title the dialog's title.)
 *
 * **Cost** per check with no dialog: one window-list read and the root of each
 * system window (status bar, navigation bar …), normally served from the
 * accessibility cache. `dumpsys window` runs only once a dialog is found.
 */
class AndroidSystemDialogScreen(
    private val device: UiDevice,
    private val instrumentation: Instrumentation,
) : SystemDialogScreen {
    @Suppress("DEPRECATION")
    override fun errorDialogs(): List<SystemErrorDialog> {
        val windows = instrumentation.uiAutomation.windows
        return windows
            .filter { it.type == AccessibilityWindowInfo.TYPE_SYSTEM }
            .sortedByDescending { it.layer }
            .mapNotNull(::errorDialogIn)
    }

    override fun windowDump(): String? = device.executeShellCommand("dumpsys window windows")

    @Suppress("DEPRECATION")
    override fun appWindowShown(): Boolean =
        instrumentation.uiAutomation.windows.any { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }

    private fun errorDialogIn(window: AccessibilityWindowInfo): SystemErrorDialog? {
        val root = window.root ?: return null
        if (root.packageName?.toString() != "android") return null
        val nodes =
            SystemDialogButton.entries
                .mapNotNull { button ->
                    root.findAccessibilityNodeInfosByViewId(button.resourceId).firstOrNull()?.let { button to it }
                }.toMap()
        if (nodes.isEmpty()) return null
        val title = if (Build.VERSION.SDK_INT >= 24) window.title?.toString() else null
        return SystemErrorDialog(title, nodes.keys) { button ->
            nodes[button]?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
        }
    }
}
