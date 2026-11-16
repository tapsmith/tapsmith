package dev.tapsmith.agent

import android.app.Instrumentation
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo

/**
 * [AppReadiness] over the live accessibility windows: the `waitForAppReady`
 * command (PILOT-976).
 */
class AppReadinessProbe(
    private val instrumentation: Instrumentation,
) {
    companion object {
        private const val TAG = "TapsmithReady"
    }

    private class LiveNode(
        private val node: AccessibilityNodeInfo,
    ) : AppReadiness.Node {
        override val packageName: CharSequence? get() = node.packageName
        override val text: CharSequence? get() = node.text
        override val contentDescription: CharSequence? get() = node.contentDescription
        override val isVisibleToUser: Boolean get() = node.isVisibleToUser
        override val childCount: Int get() = node.childCount

        override fun child(index: Int): AppReadiness.Node? = node.getChild(index)?.let { LiveNode(it) }
    }

    /**
     * Wait up to [timeoutMs] for [packageName] to show text or a description
     * in one of its windows (see [AppReadiness]).
     */
    fun await(
        packageName: String,
        timeoutMs: Long,
    ): AppReadiness.Outcome {
        val outcome =
            AppReadiness.await(
                timeoutMs = timeoutMs,
                clock = SystemClock::uptimeMillis,
                sleep = CommandCancellation::sleep,
            ) { check(packageName) }
        Log.d(TAG, "waitForAppReady $packageName ready=${outcome.ready} in ${outcome.elapsedMs}ms (${outcome.checks} checks)")
        return outcome
    }

    private fun check(packageName: String): Boolean {
        CommandCancellation.checkpoint()
        val automation = instrumentation.uiAutomation
        // The accessibility cache is not invalidated for every React Native
        // change (PILOT-539), so a cached tree could keep reporting the
        // splash. Clearing it (API 34+) makes each check read the app; below
        // 34 the window-content events that a first render sends do update it.
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                automation.clearCache()
            } catch (e: Exception) {
                Log.w(TAG, "clearCache failed: ${e.message}")
            }
        }
        val roots = automation.windows.mapNotNull { window -> window.root?.let { LiveNode(it) } }
        return AppReadiness.hasRenderedContent(roots, packageName)
    }
}
