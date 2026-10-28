package dev.tapsmith.agent

/**
 * How UiAutomation injections relate to window animations on this device
 * (PILOT-789). Plain logic with no Android dependencies, for the JVM tests.
 */
enum class InjectMode(
    /** Short form for the agent's startup log. */
    val description: String,
) {
    /** API 26–29: injection goes straight to the input system; nothing waits on WindowManager. */
    NO_WINDOW_SYNC("direct (no WindowManager sync before API 30)"),

    /** API 31+ with UiAutomation's 3-argument injectInputEvent reachable: events skip the animation wait. */
    NO_ANIMATION_WAIT("without waiting for window animations"),

    /**
     * API 30, or the 3-argument overload not reachable: WindowManager waits up
     * to ~5 s for window animations around every press and release.
     */
    WAITS_FOR_ANIMATIONS("waiting for window animations (no way to skip them on this device)"),
    ;

    companion object {
        /** The first API level where WindowManager syncs (and waits on animations) around injected input. */
        const val FIRST_WINDOW_SYNC_API = 30

        /** The first API level with injectInputEvent(event, sync, waitForAnimations). */
        const val FIRST_NO_WAIT_API = 31

        /**
         * An inject slower than this has almost certainly sat in WindowManager's
         * animation wait, whose timeout is 5 s.
         */
        const val SLOW_INJECT_MS = 4500L

        fun choose(
            sdkInt: Int,
            noWaitOverloadFound: Boolean,
        ): InjectMode =
            when {
                sdkInt < FIRST_WINDOW_SYNC_API -> NO_WINDOW_SYNC
                sdkInt >= FIRST_NO_WAIT_API && noWaitOverloadFound -> NO_ANIMATION_WAIT
                else -> WAITS_FOR_ANIMATIONS
            }

        /**
         * The warning to log for an inject of [what] that took [elapsedMs] in
         * [mode], or null when it was not slow enough to matter. Without the
         * no-wait overload the likely cause is a window animation that never
         * finishes — say so, rather than leave a mystery timeout.
         */
        fun slowInjectWarning(
            mode: InjectMode,
            what: String,
            elapsedMs: Long,
        ): String? {
            if (elapsedMs < SLOW_INJECT_MS) return null
            return if (mode == WAITS_FOR_ANIMATIONS) {
                "inject of $what took ${elapsedMs}ms: it waited on a window animation " +
                    "(a stuck starting_reveal? see WindowManager's \"Timed out waiting for animations\" in logcat). " +
                    "This device cannot inject without that wait."
            } else {
                "inject of $what took ${elapsedMs}ms: the input system or the app was slow to take it"
            }
        }
    }
}
