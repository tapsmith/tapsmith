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

/**
 * The time an element action may spend, fixed when its command arrived: the
 * action's `timeout` (shared with resolving the element) and the daemon's
 * `readTimeoutMs`, after which nothing may be touched any more.
 */
class ActionBudget(
    val startMs: Long,
    val timeoutMs: Long,
    /** Uptime at which the daemon stops waiting for the answer; null from an
     *  older daemon that does not send `readTimeoutMs`. */
    val readDeadlineMs: Long?,
) {
    /** The same deadlines with no waiting: a single check, now. */
    fun noWait(): ActionBudget = ActionBudget(SystemClock.uptimeMillis(), 0, readDeadlineMs)

    val remainingMs: Long get() = startMs + timeoutMs - SystemClock.uptimeMillis()

    /** The same deadlines with [ms] less to wait: a gesture that takes [ms]
     *  itself after the wait still fits the timeout. */
    fun shortenedBy(ms: Long): ActionBudget = ActionBudget(startMs, (timeoutMs - ms).coerceAtLeast(0), readDeadlineMs)

    val hasTimeLeft: Boolean get() = remainingMs > 0
}

/**
 * Plans element-addressed touches so they never land on something drawn over
 * the element (PILOT-362): the keyboard, another window, or a touchable view
 * painted on top. A covered element is waited on — up to the action's budget,
 * the way Playwright waits out a click's intercepting element — and then the
 * action fails with ELEMENT_COVERED naming the cover. The geometry lives in
 * [OcclusionAnalyzer]; this class reads the live windows and nodes.
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

    sealed class Plan {
        /** Touch at ([x], [y]), the center of [visible]: the part of the
         *  element nothing covers. */
        data class Point(val x: Int, val y: Int, val visible: Rect) : Plan()

        /** No part of the element is on screen. */
        object OffScreen : Plan()
    }

    /**
     * Where a touch on [element] can land. [initialBounds] are the element's
     * settled bounds for the first check; later checks (after waiting out a
     * cover) read them afresh. [expected] is what identified the element when
     * it was resolved, re-checked on every pass. [reserveMs] is time the
     * gesture needs after it starts (a long press's hold), so it is not
     * started too late to finish.
     *
     * @throws ElementCoveredException when a cover outlasts the budget.
     * @throws TargetChangedException when the node now shows another element
     *   (a StaleObjectException when it went away).
     * @throws TouchTooLateException when the check ran too late to act on.
     */
    fun plan(
        element: UiObject2,
        initialBounds: Rect,
        budget: ActionBudget,
        expected: TargetIdentity?,
        reserveMs: Long = 0,
    ): Plan {
        val clock = TouchPlanClock(budget.startMs, budget.timeoutMs, budget.readDeadlineMs, reserveMs)
        // When a cover was first seen — how long it has been waited out, for
        // the error (a single check waits for nothing).
        var coveredSinceMs: Long? = null
        val bounds = Rect(initialBounds)
        var firstPass = true
        // For a target nothing of its own identifies (an unlabelled
        // container), the text inside it when a cover was first seen: a
        // replacement rendered into the same view while the cover is waited
        // out shows different content.
        var contentWhenCovered: String? = null

        fun armContentCheck(node: AccessibilityNodeInfo?) {
            if (contentWhenCovered == null && node != null && expected?.identifiedOnlyByContent == true) {
                contentWhenCovered = contentOf(node)
            }
        }
        while (true) {
            // Refreshes the node; throws StaleObjectException when it is gone,
            // which the SDK answers by re-resolving.
            val node = nodeInfoOf(element)
            if (node != null) {
                if (expected != null && !matches(expected, node)) throw TargetChangedException()
                if (contentWhenCovered != null && contentOf(node) != contentWhenCovered) throw TargetChangedException()
                if (!firstPass) node.getBoundsInScreen(bounds)
            }
            firstPass = false
            val verdict = analyze(node, bounds)
            val now = SystemClock.uptimeMillis()
            when (verdict) {
                is OcclusionAnalyzer.Verdict.Clear -> {
                    // Only a touch can be too late: a pass that ends past the
                    // point where the touch could still answer the daemon
                    // refuses it. A cover that outlasts the budget is still
                    // reported as the cover, below.
                    if (clock.isTooLateToAct(now)) throw TouchTooLateException()
                    return Plan.Point(
                        verdict.x,
                        verdict.y,
                        Rect(verdict.visible.left, verdict.visible.top, verdict.visible.right, verdict.visible.bottom),
                    )
                }
                // Not on screen, or not visible to the user (mid-fade, a
                // transition): re-check within the budget like a cover — it may
                // be visible in a moment — and only then report it.
                OcclusionAnalyzer.Verdict.OffScreen -> {
                    val sleep = clock.sleepBeforeNextPass(now) ?: return Plan.OffScreen
                    // A view reused for another element during the wait must
                    // be caught here too (see contentWhenCovered).
                    armContentCheck(node)
                    SystemClock.sleep(sleep)
                }
                is OcclusionAnalyzer.Verdict.Covered -> {
                    val sleep =
                        clock.sleepBeforeNextPass(now)
                            ?: throw ElementCoveredException(
                                coveredMessage(verdict.by, coveredSinceMs?.let { now - it } ?: 0),
                                verdict.kind,
                            )
                    if (coveredSinceMs == null) coveredSinceMs = now
                    armContentCheck(node)
                    Log.d(TAG, "element is covered by ${verdict.by}; waiting")
                    SystemClock.sleep(sleep)
                }
            }
        }
    }

    /**
     * [plan] for a focusing tap (type, clear, focus), or null when no tap is
     * needed. One immediate check first; when a tap cannot land because the
     * keyboard or a control on the field's own screen covers it — typically a
     * field behind the keyboard it raised — and the field already has input
     * focus, skip the tap: input goes to it anyway. Under another window (a
     * dialog) the field does not get the input, so that cover is waited out
     * as usual. [reserveMs] is the work the caller does after the tap
     * (setting text, waiting for focus), which must also finish before the
     * daemon gives up.
     */
    fun planFocusTap(
        element: UiObject2,
        initialBounds: Rect,
        budget: ActionBudget,
        expected: TargetIdentity?,
        reserveMs: Long,
    ): Plan? {
        val quick =
            try {
                plan(element, initialBounds, budget.noWait(), expected, reserveMs)
            } catch (e: ElementCoveredException) {
                if (e.kind != OcclusionAnalyzer.CoverKind.WINDOW && isFocused(element)) return null
                if (!budget.hasTimeLeft) throw e
                return plan(element, initialBounds, budget, expected, reserveMs)
            }
        // Not visible for a moment: wait it out within the budget, as a tap
        // does, before giving up on it.
        if (quick == Plan.OffScreen && budget.hasTimeLeft) {
            return plan(element, initialBounds, budget, expected, reserveMs)
        }
        return quick
    }

    /**
     * Refuse (TouchTooLateException) when [reserveMs] of work started now
     * could not finish before the daemon gives up — for work that goes ahead
     * without a touch being planned (a focusing tap skipped), which [plan]'s
     * own check does not cover.
     */
    fun requireTimeFor(
        budget: ActionBudget,
        reserveMs: Long,
    ) {
        val clock = TouchPlanClock(budget.startMs, budget.timeoutMs, budget.readDeadlineMs, reserveMs)
        if (clock.isTooLateToAct(SystemClock.uptimeMillis())) throw TouchTooLateException()
    }

    private fun matches(
        expected: TargetIdentity,
        node: AccessibilityNodeInfo,
    ): Boolean =
        expected.matches(
            className = node.className?.toString(),
            resourceId = node.viewIdResourceName,
            contentDescription = node.contentDescription?.toString(),
            text = node.text?.toString(),
            isEditable = node.isEditable,
        )

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

    private fun isFocused(element: UiObject2): Boolean =
        try {
            nodeInfoOf(element)?.isFocused == true
        } catch (e: Exception) {
            false
        }

    private fun analyze(
        node: AccessibilityNodeInfo?,
        bounds: Rect,
    ): OcclusionAnalyzer.Verdict =
        OcclusionAnalyzer.analyze(
            target = node?.let(::A11yHitNode),
            targetBounds = bounds.toBox(),
            targetWindowId = node?.windowId,
            windows = readWindows(),
            screen = Box(0, 0, device.displayWidth, device.displayHeight),
        )

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

    /** [waitedMs] is how long the cover was actually waited out, not the
     *  action timeout (resolving the element may have used part of it). */
    private fun coveredMessage(
        cover: String,
        waitedMs: Long,
    ): String {
        var message = "Element is covered by $cover, so a touch would land on it instead"
        if (waitedMs > 0) message += " (still covered after waiting ${waitedMs}ms)"
        if (cover == "the keyboard") {
            message += ". Dismiss the keyboard first (device.hideKeyboard()) or scroll the element into view."
        }
        return message
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

/** A touch [OcclusionGuard] refused to make. Action code rethrows these
 *  untouched: a fallback path retrying the touch would only hit the cover,
 *  or bury the error type in a generic ACTION_FAILED. */
sealed class TouchRefusedException(message: String) : RuntimeException(message)

/** A touch on the element would land on something drawn over it, of [kind]. */
class ElementCoveredException(
    message: String,
    val kind: OcclusionAnalyzer.CoverKind,
) : TouchRefusedException(message)

/** The resolved node now shows a different element (React reused its view):
 *  a selector-addressed action re-resolves, an id-addressed one is stale. */
class TargetChangedException :
    TouchRefusedException(
        "Element not found any more — it changed into another element before it could be touched " +
            "(it may have gone stale)",
    )

/** The check ran so late that the daemon would give up before the touch finished. */
class TouchTooLateException :
    TouchRefusedException(
        "Ran out of time checking whether the element is covered: the daemon would give up before " +
            "the touch finished, so not touching it",
    )
