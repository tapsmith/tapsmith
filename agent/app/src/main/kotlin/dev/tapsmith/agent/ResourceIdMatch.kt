package dev.tapsmith.agent

import java.util.regex.Pattern

/**
 * How `locator({ id })` matches a view's resource name. A package-qualified
 * id (`com.app:id/submit`) matches that whole name only. An id with no
 * package (no `:`) matches a resource name equal to it, which is what a
 * React Native `testID` becomes, or that entry name under any package — the
 * `R.id` name a native developer writes, whatever package the build gives
 * it (an `applicationIdSuffix` such as `.debug` changes the package, not the
 * entry name). Two packages sharing an entry name both match, and strict
 * mode reports it.
 */
internal object ResourceIdMatch {
    /** The full-match pattern for a resource name, as [androidx.test.uiautomator.BySelector.res] takes it. */
    fun pattern(id: String): Pattern =
        if (id.contains(':')) {
            Pattern.compile(Pattern.quote(id))
        } else {
            Pattern.compile("(?:[^:/]+:id/)?" + Pattern.quote(id))
        }
}
