package dev.tapsmith.agent

/**
 * The bounds a find read for an element, and when it read them (uptime ms,
 * stamped after the read, so the gap measured from it is never too short).
 */
data class FindSample<B>(
    val bounds: B,
    val readAtMs: Long,
)

/** What a second read of a found element's bounds showed. */
sealed interface SampleCheck<out B> {
    /** The same, non-empty bounds as the find read: the element held still. */
    data class Stable<B>(
        val bounds: B,
    ) : SampleCheck<B>

    /** Different (or empty) bounds; [current] is the read the caller can continue from. */
    data class Moved<B>(
        val current: B,
    ) : SampleCheck<B>
}

/**
 * Playwright's "stable" check for a tap on an element a find just resolved:
 * the same box in two reads at least two frames apart, with the find's own
 * read as the first. A tap by element id costs one bounds read instead of a
 * second find and a quiet-screen wait.
 *
 * Plain arithmetic over an injected clock, sleep and read, so the JVM unit
 * tests drive it without a device.
 */
object FindSampleStability {
    /** Two frames at 60 Hz: the gap Playwright's stability check leaves between its two reads. */
    const val STABLE_GAP_MS = 34L

    fun <B> check(
        sample: FindSample<B>,
        isEmpty: (B) -> Boolean,
        now: () -> Long,
        sleep: (Long) -> Unit,
        read: () -> B,
    ): SampleCheck<B> {
        val wait = sample.readAtMs + STABLE_GAP_MS - now()
        if (wait > 0) sleep(wait)
        val current = read()
        return if (current == sample.bounds && !isEmpty(current)) SampleCheck.Stable(current) else SampleCheck.Moved(current)
    }
}
