package dev.tapsmith.agent

// How element actions recover when a touch was refused or a first attempt
// failed (PILOT-362) — kept free of Android types so the JVM unit tests can
// drive them.

/**
 * Run [act] on [element]. When the resolved node turns out to show another
 * element by the time it is touched (React reuses a native view for what it
 * renders next in the same place), a selector-addressed action resolves its
 * selector again within what is left of [budget], like a Playwright locator,
 * which re-resolves on every attempt. An id-addressed one ([idAddressed])
 * fails as stale, and the SDK re-resolves it.
 */
internal fun <E, T> actWithReresolve(
    element: E,
    idAddressed: Boolean,
    budget: ActionBudget,
    reResolve: (timeoutMs: Long) -> E,
    log: (String) -> Unit = {},
    act: (E) -> T,
): T {
    var current = element
    while (true) {
        try {
            return act(current)
        } catch (e: TargetChangedException) {
            if (idAddressed || budget.remainingMs <= 0) throw e
            log("resolved element changed into another before it was touched; resolving again")
            current =
                try {
                    reResolve(budget.remainingMs)
                } catch (_: TimeoutException) {
                    // Say what happened, not "timed out after <the few ms left>".
                    throw ElementNotFoundException(
                        "Element not found any more — it changed into another element before it could be " +
                            "touched, and nothing matches the locator now",
                    )
                }
        }
    }
}

/**
 * The error for an action whose first attempt failed with [first] and whose
 * fallback then failed with [second]. [changedNote] finishes the message for a
 * target that changed before the retry.
 */
internal fun fallbackFailure(
    action: String,
    first: Exception,
    second: Exception,
    changedNote: String,
): Exception =
    when (second) {
        // No time left to retry is not the failure: the first attempt's is.
        is TouchTooLateException ->
            ActionFailedException("Failed to $action: ${first.message} (no time left to retry before the daemon gives up)")
        // The first attempt already acted on this field: re-resolving would
        // act on another element as well, so this ends the action.
        is TargetChangedException ->
            ActionFailedException(
                "Failed to $action: ${first.message} (the field changed into another element before the retry, $changedNote)",
            )
        // Covered: the retry would only hit the cover; surface it as such.
        is TouchRefusedException -> second
        else -> ActionFailedException("Failed to $action: ${first.message} (fallback also failed: ${second.message})")
    }

/**
 * A fallback's refocus: [refocus] makes one check, no waiting — the first tap
 * may have moved the field. When the keyboard refuses it, the first tap
 * usually did land and raised that keyboard while the field's focus is still
 * arriving: [waitForFocus], and if focus arrives carry on without a tap —
 * once [requireTime] confirms the work after it still fits the deadline.
 * Returns true when the tap was skipped.
 */
internal fun refocusOrAcceptFocus(
    refocus: () -> Unit,
    waitForFocus: () -> Boolean,
    requireTime: () -> Unit,
): Boolean {
    try {
        refocus()
        return false
    } catch (e: ElementCoveredException) {
        if (e.kind != OcclusionAnalyzer.CoverKind.KEYBOARD) throw e
        if (!waitForFocus()) throw e
        requireTime()
        return true
    }
}
