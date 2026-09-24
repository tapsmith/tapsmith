package dev.tapsmith.agent

import android.app.Instrumentation
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2

/** The real clock: uptime, and a thread sleep. */
object SystemGuardClock : GuardClock {
    override fun now(): Long = SystemClock.uptimeMillis()

    override fun sleep(ms: Long) = SystemClock.sleep(ms)
}

/**
 * The Android side of [TouchPlanner] (PILOT-362): reads the target's live
 * accessibility node and the window list, and hands them to the planner,
 * which decides where — and whether — a touch may land.
 *
 * **Cost** per check: one node refresh for the target, one window-list read,
 * and a walk of the target's ancestors and their later-painted siblings over
 * the touch point (normally served from the accessibility cache).
 */
class OcclusionGuard(
    private val device: UiDevice,
    private val instrumentation: Instrumentation,
    private val nodeInfoOf: (UiObject2) -> AccessibilityNodeInfo?,
) {
    companion object {
        private const val TAG = "TapsmithOcclusion"

        /** Bounds on reading an unlabelled target's content (see [contentOf]). */
        private const val CONTENT_NODES_READ = 64
        private const val CONTENT_DEPTH = 4
    }

    private val screen =
        object : GuardScreen {
            override val bounds: Box get() = Box(0, 0, device.displayWidth, device.displayHeight)

            override fun windows() = readWindows()
        }

    private val planner = TouchPlanner(screen, SystemGuardClock) { Log.d(TAG, it) }

    /** See [TouchPlanner.plan]. */
    fun plan(
        element: UiObject2,
        initialBounds: Rect,
        budget: ActionBudget,
        expected: TargetIdentity?,
        reserveMs: Long = 0,
    ): TouchPlan = planner.plan(targetOf(element), initialBounds.toBox(), budget, expected, reserveMs)

    /** See [TouchPlanner.planFocusTap]. */
    fun planFocusTap(
        element: UiObject2,
        initialBounds: Rect,
        budget: ActionBudget,
        expected: TargetIdentity?,
        reserveMs: Long,
    ): TouchPlan? = planner.planFocusTap(targetOf(element), initialBounds.toBox(), budget, expected, reserveMs)

    /** See [TouchPlanner.requireTimeFor]. */
    fun requireTimeFor(
        budget: ActionBudget,
        reserveMs: Long,
    ) = planner.requireTimeFor(budget, reserveMs)

    /** [element] as the planner reads it. [nodeInfoOf] refreshes the node on
     *  every read and throws StaleObjectException when it is gone, which the
     *  SDK answers by re-resolving. */
    private fun targetOf(element: UiObject2): GuardTarget =
        object : GuardTarget {
            override fun read(): TargetSnapshot? {
                val node = nodeInfoOf(element) ?: return null
                return TargetSnapshot(
                    node = A11yHitNode(node),
                    windowId = node.windowId,
                    bounds = Rect().also(node::getBoundsInScreen).toBox(),
                    className = node.className?.toString(),
                    resourceId = node.viewIdResourceName,
                    contentDescription = node.contentDescription?.toString(),
                    text = node.text?.toString(),
                    isEditable = node.isEditable,
                    readContent = { contentOf(node) },
                )
            }

            override fun isFocused(): Boolean = nodeInfoOf(element)?.isFocused == true
        }

    /** The text and content descriptions inside [node], in tree order —
     *  bounded, since each read can be an accessibility round-trip. */
    private fun contentOf(node: AccessibilityNodeInfo): String {
        val parts = mutableListOf<String>()
        var budget = CONTENT_NODES_READ

        fun walk(
            n: AccessibilityNodeInfo,
            depth: Int,
        ) {
            if (budget-- <= 0) return
            (n.text ?: n.contentDescription)?.toString()?.takeIf { it.isNotEmpty() }?.let(parts::add)
            if (depth >= CONTENT_DEPTH) return
            for (i in 0 until n.childCount) {
                if (budget <= 0) return
                val child = n.getChild(i) ?: continue
                walk(child, depth + 1)
            }
        }
        walk(node, 0)
        return parts.joinToString("\u0000")
    }

    @Suppress("DEPRECATION")
    private fun readWindows(): List<OcclusionAnalyzer.WindowSpec> {
        val windows =
            try {
                instrumentation.uiAutomation.windows
            } catch (e: Exception) {
                Log.w(TAG, "Could not read the window list; checking the element's own window only", e)
                return emptyList()
            }
        return windows.map { w ->
            try {
                val rect = Rect()
                w.getBoundsInScreen(rect)
                OcclusionAnalyzer.WindowSpec(
                    id = w.id,
                    kind =
                        when (w.type) {
                            AccessibilityWindowInfo.TYPE_INPUT_METHOD -> OcclusionAnalyzer.WindowKind.INPUT_METHOD
                            AccessibilityWindowInfo.TYPE_SYSTEM -> OcclusionAnalyzer.WindowKind.SYSTEM
                            AccessibilityWindowInfo.TYPE_APPLICATION -> OcclusionAnalyzer.WindowKind.APPLICATION
                            else -> OcclusionAnalyzer.WindowKind.OTHER
                        },
                    layer = w.layer,
                    bounds = rect.toBox(),
                    title = if (Build.VERSION.SDK_INT >= 24) w.title?.toString() else null,
                )
            } finally {
                w.recycle()
            }
        }
    }

    /** [OcclusionAnalyzer.HitNode] over a live accessibility node, with its
     *  children read at most once per check. */
    private class A11yHitNode(val node: AccessibilityNodeInfo) : OcclusionAnalyzer.HitNode {
        override val bounds: Box by lazy { Rect().also(node::getBoundsInScreen).toBox() }
        override val drawingOrder: Int by lazy { if (Build.VERSION.SDK_INT >= 24) node.drawingOrder else 0 }
        override val isVisible: Boolean by lazy { node.isVisibleToUser }
        override val takesTouches: Boolean by lazy { node.isClickable || node.isLongClickable }
        private val childCount: Int by lazy { node.childCount }
        private val children = HashMap<Int, A11yHitNode?>()

        override fun parent(): OcclusionAnalyzer.HitNode? = node.parent?.let(::A11yHitNode)

        override fun childCount(): Int = childCount

        override fun child(index: Int): OcclusionAnalyzer.HitNode? = children.getOrPut(index) { node.getChild(index)?.let(::A11yHitNode) }

        override fun sameAs(other: OcclusionAnalyzer.HitNode): Boolean = other is A11yHitNode && other.node == node

        override fun describe(): String =
            OcclusionAnalyzer.describeCover(
                node.className?.toString(),
                node.contentDescription?.toString(),
                node.text?.toString(),
                node.viewIdResourceName,
            )
    }
}

private fun Rect.toBox() = Box(left, top, right, bottom)
