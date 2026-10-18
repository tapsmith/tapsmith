package dev.tapsmith.agent

/** The soft keyboard, as [KeyboardFirst] reads and drives it. */
interface GuardKeyboard {
    /** Whether the input method reports the keyboard shown right now. Slower
     *  than the window list, and authoritative: a keyboard window is still
     *  listed while it animates away. */
    fun isShown(): Boolean

    /** Put the keyboard away without touching the app (Back, which the
     *  keyboard consumes while it is shown). */
    fun dismiss()
}

/**
 * Puts the soft keyboard away before a touch that the keyboard would
 * otherwise eat (PILOT-622).
 *
 * A React Native ScrollView (and FlatList, which is one) with the default
 * `keyboardShouldPersistTaps="never"` spends the first touch after typing on
 * closing the keyboard: the button under the finger never sees it, and the
 * tap would report success. Nothing outside the app can tell that touch apart
 * from one a button handled (a handler that calls `Keyboard.dismiss()` looks
 * the same), so the touch is made only once the keyboard is gone — when the
 * keyboard is up, the target is not a text input (tapping another field just
 * moves the focus, keyboard and all), and the target sits in a scroll view.
 *
 * Back hides the keyboard without taking the focus from the field, and React
 * Native then stops intercepting (it only does while it has seen the keyboard
 * shown). Android before API 30 is the exception: React Native treats its
 * keyboard events as unreliable there and still intercepts while a field has
 * focus.
 */
class KeyboardFirst(
    private val screen: GuardScreen,
    private val keyboard: GuardKeyboard,
    private val clock: GuardClock,
    private val log: (String) -> Unit = {},
) {
    companion object {
        /** Longest wait for the keyboard window to go after Back. */
        const val MAX_WAIT_MS = 2_000L
        const val POLL_MS = 50L

        /** After the window has gone: time for the app to hear that the
         *  keyboard closed and lay itself out again. */
        const val SETTLE_MS = 250L

        /** Class names React Native's ScrollView (and FlatList, which is one)
         *  reports. Native lists, pagers and web views are left out: they do
         *  not eat a touch to close the keyboard, and closing it first would
         *  take away what only shows while it is up (an autocomplete
         *  drop-down closes on BACK). */
        private val SCROLL_CLASSES =
            setOf(
                "android.widget.ScrollView",
                "android.widget.HorizontalScrollView",
            )

        /** Web content handles its own touches, even inside a scroll view. */
        fun isWebView(className: String?): Boolean = className == "android.webkit.WebView"

        /** Whether a view of [className] is a React Native scroll view. */
        fun isScrollContainer(className: String?): Boolean = className != null && className in SCROLL_CLASSES
    }

    /**
     * Put the keyboard away first when a touch on [target] would only close
     * it. Returns true when it pressed Back: the target may have moved, so
     * the caller reads its bounds again. A keyboard that does not go within
     * the wait is left to the touch, as before.
     */
    fun putAwayIfItWouldEatTheTouch(
        target: GuardTarget,
        budget: ActionBudget,
    ): Boolean {
        // Cheap checks first: the window list is read on every touch anyway.
        val keyboardWindow =
            screen.windows().firstOrNull {
                it.kind == OcclusionAnalyzer.WindowKind.INPUT_METHOD && !it.bounds.isEmpty
            } ?: return false
        // The time the touch still has: until the daemon stops waiting for
        // the answer. The action timeout only bounds waiting for an element,
        // and is 0 for a tap that must not wait (MCP).
        val available = budget.readDeadlineMs?.let { it - clock.now() } ?: budget.remainingMs
        if (available <= 0) return false
        val snapshot = target.read() ?: return false
        if (snapshot.isEditable || snapshot.windowId == keyboardWindow.id) return false
        if (!target.isInScrollView()) return false
        if (!keyboard.isShown()) return false

        log("the keyboard is up and the element is in a scroll view: putting the keyboard away first")
        keyboard.dismiss()
        val deadline = clock.now() + minOf(MAX_WAIT_MS, available / 2)
        while (keyboardListed()) {
            if (clock.now() >= deadline) {
                log("the keyboard is still up after Back; touching anyway")
                return true
            }
            clock.sleep(POLL_MS)
        }
        clock.sleep(SETTLE_MS)
        return true
    }

    private fun keyboardListed(): Boolean =
        screen.windows().any { it.kind == OcclusionAnalyzer.WindowKind.INPUT_METHOD && !it.bounds.isEmpty }
}
