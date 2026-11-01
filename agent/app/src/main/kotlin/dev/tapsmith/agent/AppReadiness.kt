package dev.tapsmith.agent

/**
 * "Has the app drawn real content yet?" — the `waitForAppReady` command
 * (PILOT-976).
 *
 * After a cold launch a React Native app's window exists, and the session's
 * own checks pass, seconds before its JS bundle has rendered anything; a deep
 * link or hooks-marker read sent into that gap is lost. The daemon and the
 * SDK used to answer this by pulling a full hierarchy dump every 250-500 ms,
 * and one dump alone costs 1-3 s on a cold software-GPU emulator. This walks
 * the live window roots instead and stops at the first node of the package
 * that carries text or a content description: the same verdict as the
 * dump-based check (`android_hierarchy_has_rendered_content` in the daemon),
 * which looks for a `package="…"` node with a non-empty `text` or
 * `content-desc`, but without serialising, and polled every
 * [POLL_INTERVAL_MS].
 *
 * Like the dump, it skips a subtree whose root is not visible to the user
 * (UIAutomator's dumper leaves those out), and reads a window root whatever
 * its visibility. The hooks marker is a description, so it counts, as it did.
 *
 * Plain Kotlin over [Node], for the JVM unit tests; [AppReadinessProbe]
 * adapts the accessibility tree.
 */
object AppReadiness {
    /** Pause between checks. A check of a not-yet-rendered app reads a small tree. */
    const val POLL_INTERVAL_MS = 50L

    /** Nodes one check may read before it reports "not yet", so a huge tree
     *  without text cannot turn a check into a long accessibility walk. */
    const val MAX_NODES_PER_CHECK = 5_000

    /** The parts of an accessibility node the check reads. */
    interface Node {
        val packageName: CharSequence?
        val text: CharSequence?
        val contentDescription: CharSequence?
        val isVisibleToUser: Boolean
        val childCount: Int

        fun child(index: Int): Node?
    }

    /** True when a visible node of [packageName] under [roots] carries text or a description. */
    fun hasRenderedContent(
        roots: List<Node>,
        packageName: String,
        maxNodes: Int = MAX_NODES_PER_CHECK,
    ): Boolean {
        val stack = ArrayDeque<Node>()
        for (root in roots.asReversed()) stack.addLast(root)
        var visited = 0
        while (stack.isNotEmpty()) {
            if (visited >= maxNodes) return false
            val node = stack.removeLast()
            visited++
            if (node.packageName?.toString() == packageName &&
                (!node.text.isNullOrEmpty() || !node.contentDescription.isNullOrEmpty())
            ) {
                return true
            }
            for (i in node.childCount - 1 downTo 0) {
                val child = node.child(i) ?: continue
                if (child.isVisibleToUser) stack.addLast(child)
            }
        }
        return false
    }

    /** What [await] found: whether the app became ready, after how long and how many checks. */
    data class Outcome(
        val ready: Boolean,
        val elapsedMs: Long,
        val checks: Int,
    )

    /**
     * Run [check] until it is true or [timeoutMs] has passed, checking at
     * least once. A check that throws (a window that went away mid-read)
     * counts as "not yet"; a [CommandCancelledException] ends the wait.
     * Running out of time is an answer, not an error: an app whose first
     * screen has no text never becomes "ready", and callers then go on.
     */
    fun await(
        timeoutMs: Long,
        clock: () -> Long,
        sleep: (Long) -> Unit,
        check: () -> Boolean,
    ): Outcome {
        val start = clock()
        var checks = 0
        while (true) {
            checks++
            val ready =
                try {
                    check()
                } catch (e: CommandCancelledException) {
                    throw e
                } catch (e: Exception) {
                    false
                }
            val elapsed = clock() - start
            if (ready) return Outcome(true, elapsed, checks)
            if (elapsed >= timeoutMs) return Outcome(false, elapsed, checks)
            sleep(minOf(POLL_INTERVAL_MS, timeoutMs - elapsed))
        }
    }
}
