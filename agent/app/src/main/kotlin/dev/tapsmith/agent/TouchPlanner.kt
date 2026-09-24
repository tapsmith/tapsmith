package dev.tapsmith.agent

/** Uptime in milliseconds, and sleeping — injected so the wait loop runs
 *  in JVM unit tests with a fake clock. */
interface GuardClock {
    fun now(): Long

    fun sleep(ms: Long)
}

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
    private val clock: GuardClock,
) {
    /** The same deadlines with no waiting: a single check, now. */
    fun noWait(): ActionBudget = ActionBudget(clock.now(), 0, readDeadlineMs, clock)

    val remainingMs: Long get() = startMs + timeoutMs - clock.now()

    /** The same deadlines with [ms] less to wait: a gesture that takes [ms]
     *  itself after the wait still fits the timeout. */
    fun shortenedBy(ms: Long): ActionBudget = ActionBudget(startMs, (timeoutMs - ms).coerceAtLeast(0), readDeadlineMs, clock)

    val hasTimeLeft: Boolean get() = remainingMs > 0
}

/** One read of the target, taken afresh on every pass of the wait. */
class TargetSnapshot(
    /** The target's node, for the same-window cover search; null when only
     *  its bounds and identity are known. */
    val node: OcclusionAnalyzer.HitNode?,
    val windowId: Int?,
    /** Where it is on screen now. */
    val bounds: Box,
    val className: String?,
    val resourceId: String?,
    val contentDescription: String?,
    val text: String?,
    val isEditable: Boolean,
    /** The text inside it, read only when an unlabelled target needs it. */
    private val readContent: () -> String,
) {
    val content: String by lazy(readContent)

    fun matches(expected: TargetIdentity): Boolean = expected.matches(className, resourceId, contentDescription, text, isEditable)
}

/** The target of a touch, as the wait loop sees it. */
interface GuardTarget {
    /** Refresh and read the target; null when it cannot be read (the window
     *  checks still run). Throws when it is gone. */
    fun read(): TargetSnapshot?

    /** Whether it has input focus right now. */
    fun isFocused(): Boolean
}

/** The display and the windows on it. */
interface GuardScreen {
    val bounds: Box

    fun windows(): List<OcclusionAnalyzer.WindowSpec>
}

sealed class TouchPlan {
    /** Touch at ([x], [y]): a point nothing covers. */
    data class Point(val x: Int, val y: Int) : TouchPlan()

    /** No part of the element is on screen. */
    object OffScreen : TouchPlan() {
        override fun toString() = "OffScreen"
    }
}

/**
 * Plans element-addressed touches so they never land on something drawn over
 * the element (PILOT-362): the keyboard, another window, or a touchable view
 * painted on top. A covered element is waited on — up to the action's budget,
 * the way Playwright waits out a click's intercepting element — and then the
 * action fails with ELEMENT_COVERED naming the cover. The geometry lives in
 * [OcclusionAnalyzer]; the live reads come in through [GuardTarget] and
 * [GuardScreen], so this runs in JVM unit tests.
 */
class TouchPlanner(
    private val screen: GuardScreen,
    private val clock: GuardClock,
    private val log: (String) -> Unit = {},
) {
    /**
     * Where a touch on [target] can land. [initialBounds] are the element's
     * settled bounds for the first check; later checks (after waiting out a
     * cover) read them afresh. [expected] is what identified the element when
     * it was resolved, re-checked on every pass. [reserveMs] is time the
     * gesture needs after it starts (a long press's hold), so it is not
     * started too late to finish.
     *
     * @throws ElementCoveredException when a cover outlasts the budget.
     * @throws TargetChangedException when the node now shows another element
     *   (whatever [GuardTarget.read] throws when it went away).
     * @throws TouchTooLateException when the check ran too late to act on.
     */
    fun plan(
        target: GuardTarget,
        initialBounds: Box,
        budget: ActionBudget,
        expected: TargetIdentity?,
        reserveMs: Long = 0,
    ): TouchPlan {
        val deadlines = TouchPlanClock(budget.startMs, budget.timeoutMs, budget.readDeadlineMs, reserveMs)
        // When a cover was first seen — how long it has been waited out, for
        // the error (a single check waits for nothing).
        var coveredSinceMs: Long? = null
        var bounds = initialBounds
        var firstPass = true
        // For a target nothing of its own identifies (an unlabelled
        // container), the text inside it when a wait began: a replacement
        // rendered into the same view meanwhile shows different content.
        var contentWhenWaiting: String? = null

        fun armContentCheck(snapshot: TargetSnapshot?) {
            if (contentWhenWaiting == null && snapshot != null && expected?.identifiedOnlyByContent == true) {
                contentWhenWaiting = snapshot.content
            }
        }
        while (true) {
            val snapshot = target.read()
            if (snapshot != null) {
                if (expected != null && !snapshot.matches(expected)) throw TargetChangedException()
                if (contentWhenWaiting != null && snapshot.content != contentWhenWaiting) throw TargetChangedException()
                if (!firstPass) bounds = snapshot.bounds
            }
            firstPass = false
            val verdict =
                OcclusionAnalyzer.analyze(
                    target = snapshot?.node,
                    targetBounds = bounds,
                    targetWindowId = snapshot?.windowId,
                    windows = screen.windows(),
                    screen = screen.bounds,
                )
            val now = clock.now()
            when (verdict) {
                is OcclusionAnalyzer.Verdict.Clear -> {
                    // Only a touch can be too late: a pass that ends past the
                    // point where the touch could still answer the daemon
                    // refuses it. A cover that outlasts the budget is still
                    // reported as the cover, below.
                    if (deadlines.isTooLateToAct(now)) throw TouchTooLateException()
                    return TouchPlan.Point(verdict.x, verdict.y)
                }
                // Not on screen, or not visible to the user (mid-fade, a
                // transition): re-check within the budget like a cover — it may
                // be visible in a moment — and only then report it.
                OcclusionAnalyzer.Verdict.OffScreen -> {
                    val sleep = deadlines.sleepBeforeNextPass(now) ?: return TouchPlan.OffScreen
                    armContentCheck(snapshot)
                    clock.sleep(sleep)
                }
                is OcclusionAnalyzer.Verdict.Covered -> {
                    val sleep =
                        deadlines.sleepBeforeNextPass(now)
                            ?: throw ElementCoveredException(
                                coveredMessage(verdict.by, coveredSinceMs?.let { now - it } ?: 0),
                                verdict.kind,
                            )
                    if (coveredSinceMs == null) coveredSinceMs = now
                    armContentCheck(snapshot)
                    log("element is covered by ${verdict.by}; waiting")
                    clock.sleep(sleep)
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
     * daemon gives up — whether the tap is made or skipped.
     */
    fun planFocusTap(
        target: GuardTarget,
        initialBounds: Box,
        budget: ActionBudget,
        expected: TargetIdentity?,
        reserveMs: Long,
    ): TouchPlan? {
        val quick =
            try {
                plan(target, initialBounds, budget.noWait(), expected, reserveMs)
            } catch (e: ElementCoveredException) {
                if (e.kind != OcclusionAnalyzer.CoverKind.WINDOW && isFocused(target)) {
                    // No tap is planned, so plan()'s deadline check did not
                    // run: the work after it must still finish in time.
                    requireTimeFor(budget, reserveMs)
                    return null
                }
                if (!budget.hasTimeLeft) throw e
                return plan(target, initialBounds, budget, expected, reserveMs)
            }
        // Not visible for a moment: wait it out within the budget, as a tap
        // does, before giving up on it.
        if (quick == TouchPlan.OffScreen && budget.hasTimeLeft) {
            return plan(target, initialBounds, budget, expected, reserveMs)
        }
        return quick
    }

    /**
     * Refuse (TouchTooLateException) when [reserveMs] of work started now
     * could not finish before the daemon gives up — for work that goes ahead
     * without a touch being planned, which [plan]'s own check does not cover.
     */
    fun requireTimeFor(
        budget: ActionBudget,
        reserveMs: Long,
    ) {
        val deadlines = TouchPlanClock(budget.startMs, budget.timeoutMs, budget.readDeadlineMs, reserveMs)
        if (deadlines.isTooLateToAct(clock.now())) throw TouchTooLateException()
    }

    private fun isFocused(target: GuardTarget): Boolean =
        try {
            target.isFocused()
        } catch (e: Exception) {
            false
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
}

/** A touch [TouchPlanner] refused to make. Action code rethrows these
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
