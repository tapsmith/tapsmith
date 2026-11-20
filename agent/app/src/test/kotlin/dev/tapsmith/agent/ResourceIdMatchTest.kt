package dev.tapsmith.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-side tests for how `locator({ id })` reads a view's resource name: a
 * whole name matches itself, and an id with no package also matches that
 * entry under any package (the `R.id` name a native developer writes).
 */
class ResourceIdMatchTest {
    private fun matches(
        id: String,
        resourceName: String,
    ): Boolean = ResourceIdMatch.pattern(id).matcher(resourceName).matches()

    @Test
    fun `a bare entry name matches that id under any package`() {
        assertTrue(matches("titleLabel", "de.danoeh.antennapod:id/titleLabel"))
        // An applicationIdSuffix changes the package, not the entry name.
        assertTrue(matches("titleLabel", "de.danoeh.antennapod.debug:id/titleLabel"))
        // Framework ids in the app's window are ids too: strict mode decides
        // when two packages share the name.
        assertTrue(matches("title", "android:id/title"))
    }

    @Test
    fun `a bare entry name never matches a different entry or a prefix of one`() {
        assertFalse(matches("title", "com.app:id/titleLabel"))
        assertFalse(matches("Label", "com.app:id/titleLabel"))
        assertFalse(matches("titleLabel", "com.app:string/titleLabel"))
        assertFalse(matches("titleLabel", "com.app:id/other/titleLabel"))
    }

    @Test
    fun `a bare id still matches an unprefixed resource id whole, as a React Native testID is`() {
        assertTrue(matches("email-input", "email-input"))
        assertFalse(matches("email", "email-input"))
    }

    @Test
    fun `a package-qualified id matches only that exact resource name`() {
        assertTrue(matches("de.danoeh.antennapod.debug:id/titleLabel", "de.danoeh.antennapod.debug:id/titleLabel"))
        // The R namespace is not the runtime package when a suffix is set.
        assertFalse(matches("de.danoeh.antennapod:id/titleLabel", "de.danoeh.antennapod.debug:id/titleLabel"))
        assertFalse(matches("com.app:id/x", "com.other:id/x"))
    }

    @Test
    fun `regex metacharacters in an id are literal`() {
        assertTrue(matches("a.b", "com.app:id/a.b"))
        assertFalse(matches("a.b", "com.app:id/aXb"))
        assertFalse(matches("com.app:id/a.b", "com.app:id/aXb"))
        assertTrue(matches("x+(y)", "x+(y)"))
    }

    @Test
    fun `an id with a slash but no package is matched whole`() {
        assertFalse(matches("id/titleLabel", "com.app:id/titleLabel"))
        assertTrue(matches("id/titleLabel", "id/titleLabel"))
    }
}
