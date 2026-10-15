package dev.tapsmith.agent

import java.util.regex.Pattern

/**
 * Whitespace-normalized text matching for `getByText` and accessible-name
 * matching (PILOT-510), the way Playwright matches text: runs of whitespace
 * collapse to one space and the ends are trimmed, on both the element's text
 * and the query, exact or substring. A label rendered with a non-breaking
 * space (`Welcome to&nbsp;Expo`) or a line break then matches a query typed
 * with plain spaces.
 *
 * "Whitespace" is JavaScript's `\s` set, so the agents agree with each other
 * (the iOS agent's TextMatch.swift uses the same set) and with the SDK's
 * trace-viewer matcher. Java's own `\s` is ASCII-only.
 *
 * UIAutomator compares text inside `By.text(Pattern)`, so for those queries
 * this builds a full-match [Pattern] equivalent to comparing normalized
 * strings: the query's words, quoted, joined by one-or-more whitespace. As in
 * Playwright, a substring match ignores case and an exact one doesn't.
 */
object TextMatch {
    /** JavaScript's `\s`: ECMAScript WhiteSpace and LineTerminator code points. */
    private const val WS_CLASS =
        "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"
    private val WS_RUN = Regex("$WS_CLASS+")

    /** Collapse whitespace runs to one space and trim. */
    fun normalize(text: String): String = text.replace(WS_RUN, " ").trim(' ')

    /** Whether [actual] (null = no text) equals [expected] once both are normalized. */
    fun equalsNormalized(
        actual: CharSequence?,
        expected: String,
    ): Boolean = actual != null && normalize(actual.toString()) == normalize(expected)

    /**
     * Whether [actual] (null = no text) matches the accessible-name [query]
     * the way Playwright's getByRole `name` does (PILOT-549): by default a
     * case-insensitive substring match, with [exact] a case-sensitive
     * whole-string match. Whitespace is normalized either way. Case folding
     * uses [String.lowercase], which is locale-independent, so a Turkish
     * device locale doesn't break "LOGIN" vs "login".
     */
    fun nameMatches(
        actual: CharSequence?,
        query: String,
        exact: Boolean,
    ): Boolean {
        if (actual == null) return false
        if (exact) return equalsNormalized(actual, query)
        return normalize(actual.toString()).lowercase().contains(normalize(query).lowercase())
    }

    /**
     * Whether an element's accessible name matches [name]: its content
     * description, its text, or its joined [descendantText] (read lazily —
     * each child read is an accessibility round-trip). When [textIsValue] —
     * an editable field's typed value, not its hint — the text is not part
     * of the accessible name (Playwright; the iOS agent checks label/title
     * only), so it is still compared whole: typing "email me later" into
     * Notes must not make that field match name "Email".
     */
    fun accessibleNameMatches(
        contentDescription: CharSequence?,
        text: CharSequence?,
        textIsValue: Boolean,
        descendantText: () -> CharSequence?,
        name: String,
        exact: Boolean,
    ): Boolean =
        nameMatches(contentDescription, name, exact) ||
            nameMatches(text, name, exact || textIsValue) ||
            nameMatches(descendantText(), name, exact)

    /**
     * [accessibleNameMatches] for a getByRole `{ name: RegExp }` (PILOT-520):
     * the RegExp is tested against each whitespace-normalized name source, as
     * Playwright tests it against the normalized accessible name. A typed
     * EditText value is not a name ([textIsValue]), so it is not tested.
     */
    fun accessibleNameMatches(
        contentDescription: CharSequence?,
        text: CharSequence?,
        textIsValue: Boolean,
        descendantText: () -> CharSequence?,
        regex: TextRegex,
    ): Boolean {
        val test = { value: CharSequence? -> value != null && regex.matches(normalize(value.toString())) }
        return test(contentDescription) || (!textIsValue && test(text)) || test(descendantText())
    }

    /** Full-match pattern: the text equals [query] after normalizing both. */
    fun exactPattern(query: String): Pattern = Pattern.compile("$WS_CLASS*${wordsPattern(query)}$WS_CLASS*")

    /**
     * Full-match pattern: the normalized text contains the normalized
     * [query], ignoring case — Playwright's non-exact getByText (PILOT-522).
     * Unicode-aware and independent of the device locale, so a Turkish
     * locale doesn't break "LOGIN" vs "login". The host tests run on the
     * JVM's engine; on a device the regex engine is ICU, which may fold a
     * few special characters (such as ß) differently.
     */
    fun containsPattern(query: String): Pattern =
        Pattern.compile("(?s).*${wordsPattern(query)}.*", Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE)

    private fun wordsPattern(query: String): String {
        val normalized = normalize(query)
        if (normalized.isEmpty()) return ""
        return normalized.split(' ').joinToString("$WS_CLASS+") { Pattern.quote(it) }
    }
}

/**
 * A getBy* RegExp (PILOT-520), as the daemon forwards it: [pattern] is the
 * SDK's translation of the JavaScript RegExp, written so ICU (the engine
 * behind Android's java.util.regex) reads it with JavaScript's semantics —
 * whitespace, digit and word classes, anchors and `.` are all spelled out —
 * so only [ignoreCase] is left to the engine. [display] is the RegExp as
 * written, for messages.
 */
class TextRegex(
    val pattern: String,
    val ignoreCase: Boolean,
    val display: String,
) {
    private val flags = if (ignoreCase) Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE else 0

    private val compiled: Pattern =
        try {
            Pattern.compile(pattern, flags)
        } catch (e: java.util.regex.PatternSyntaxException) {
            throw InvalidSelectorException("Invalid RegExp $display: ${e.description}")
        }

    /** Whether the RegExp matches anywhere in [text], like `RegExp.prototype.test` (null = no text). */
    fun matches(text: CharSequence?): Boolean = text != null && compiled.matcher(text).find()

    /**
     * The same test as a whole-string match, for UIAutomator's
     * `By.text(Pattern)` (which calls `matches()`): any prefix, the RegExp,
     * any suffix. The wrappers are non-capturing, so backreferences keep
     * their numbers.
     */
    fun fullMatchPattern(): Pattern = Pattern.compile("(?s:.*?)(?:$pattern)(?s:.*)", flags)

    override fun toString(): String = display

    companion object {
        /** Parse the daemon's `{pattern, ignoreCase, display}` object; null when absent. */
        fun fromJson(obj: org.json.JSONObject?): TextRegex? {
            if (obj == null) return null
            val pattern = obj.optString("pattern", "")
            return TextRegex(pattern, obj.optBoolean("ignoreCase", false), obj.optString("display", "/$pattern/"))
        }
    }
}
