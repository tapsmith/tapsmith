package dev.tapsmith.agent

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The SDK's locator conformance fixtures, replayed against the agent's own
 * matching code (PILOT-707). Each fixture case is one element and one
 * getBy* query with the agent's answer; the offline trace playground
 * (packages/tapsmith `*-conformance.test.ts`) and the iOS agent's host tests
 * replay the same files, so a rule changed on one side and not the others
 * fails here instead of drifting.
 *
 * A case is matched the way a find decides one candidate: the UIAutomator
 * walk's class and text criteria ([ElementFinder.walkPatterns]), then the
 * post-filter ([ElementFinder.matchesCandidate]) over the case's attributes.
 * Tree rules — Compose role carriers, non-app nodes — are not part of one
 * case; ComposeRolesTest and NonAppNodesTest cover them.
 *
 * The host JVM's regex engine is not ICU, which the device's is; the RegExp
 * cases only use constructs the two read alike (TextRegexTest).
 */
class LocatorConformanceTest {
    private fun fixture(name: String): JSONArray {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, "packages/tapsmith/src/__tests__/fixtures/$name")
            if (candidate.isFile) return JSONObject(candidate.readText()).getJSONArray("cases")
            dir = dir.parentFile
        }
        error("$name not found above ${System.getProperty("user.dir")}")
    }

    private fun androidCases(name: String): List<JSONObject> {
        val cases = fixture(name)
        return (0 until cases.length()).map { cases.getJSONObject(it) }.filter { it.optString("platform") == "android" }
    }

    /** A case's element, with the attributes a find reads of it. */
    private class Candidate(
        c: JSONObject,
    ) : FindCandidate {
        override val className: String? = c.optStringOrNull("type")
        override val text: String? = c.optStringOrNull("text")
        override val contentDescription: String? = c.optStringOrNull("contentDesc")
        private val hint = c.optStringOrNull("placeholder")
        private val role = FindRules.publishedRole(c.optBoolean("heading", false), c.optStringOrNull("roleDescription"))
        private val labeledBy = c.optStringOrNull("labeledBy")
        private val childTexts =
            c.optJSONArray("childTexts")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()

        override fun hint(): String? = hint

        override fun roleDescription(): String? = role

        override fun labeledByText(): CharSequence? = labeledBy

        override fun descendantTextParts(): List<String> = childTexts
    }

    private fun regexOf(q: JSONObject): TextRegex =
        TextRegex(q.getString("pattern"), q.optBoolean("ignoreCase", false), "/${q.optString("source")}/${q.optString("flags")}")

    /** Whether a find with [selector] returns the case's element. */
    private fun finds(
        selector: ElementSelector,
        c: JSONObject,
    ): Boolean {
        val candidate = Candidate(c)
        return ElementFinder.walkPatterns(selector).accepts(candidate.className, candidate.text) &&
            ElementFinder.matchesCandidate(candidate, selector)
    }

    private fun replay(
        cases: List<JSONObject>,
        selectorOf: (JSONObject) -> ElementSelector,
    ): List<String> =
        cases.mapNotNull { c ->
            val want = c.getBoolean("matches")
            val got = finds(selectorOf(c), c)
            if (got == want) null else "${c.getString("why")}: expected ${if (want) "a match" else "no match"}"
        }

    @Test
    fun `getByLabel cases (label-conformance json)`() {
        val cases = androidCases("label-conformance.json")
        assertTrue(cases.size >= 15)
        val failures =
            replay(cases) { c ->
                val q = c.opt("query")
                if (q is JSONObject) ElementSelector(labelRegex = regexOf(q)) else ElementSelector(label = q as String)
            }
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun `getByRole cases (role-conformance json)`() {
        val cases = androidCases("role-conformance.json")
        assertTrue(cases.size >= 10)
        val failures =
            replay(cases) { c ->
                val name = c.opt("name")
                when (name) {
                    is JSONObject -> ElementSelector(role = c.getString("role"), nameRegex = regexOf(name))
                    is String -> ElementSelector(role = c.getString("role"), name = name, nameExact = c.optBoolean("exact", false))
                    else -> ElementSelector(role = c.getString("role"))
                }
            }
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun `the role a case reports is the one the hierarchy dump writes`() {
        // The playground reads an element's role from the dump's
        // tapsmith-role, which the dump takes from FindRules.publishedRole.
        val failures =
            androidCases("role-conformance.json").mapNotNull { c ->
                val role = FindRules.publishedRole(c.optBoolean("heading", false), c.optStringOrNull("roleDescription"))
                val reported = c.optStringOrNull("reportedRole")
                if (role == reported) null else "${c.getString("why")}: reports $role, the fixture says $reported"
            }
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun `getByText cases (text-content-conformance json)`() {
        val cases = androidCases("text-content-conformance.json")
        assertTrue(cases.size >= 15)
        val failures =
            replay(cases) { c ->
                val q = c.getJSONObject("query")
                when {
                    q.has("exact") -> ElementSelector(text = q.getString("exact"))
                    q.has("substring") -> ElementSelector(textContains = q.getString("substring"))
                    else -> ElementSelector(textRegex = regexOf(q))
                }
            }
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun `the walk reads a missing text as empty, as UIAutomator's By does`() {
        val walk = ElementFinder.walkPatterns(ElementSelector(textRegex = TextRegex("^$", false, "/^$/")))
        assertTrue(walk.accepts("android.view.View", null))
    }

    private companion object {
        fun JSONObject.optStringOrNull(key: String): String? = if (has(key) && !isNull(key)) getString(key) else null
    }
}
