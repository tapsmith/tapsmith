package dev.tapsmith.agent

import java.util.regex.Pattern

/**
 * What a find reads of one candidate element to decide whether it matches
 * ([ElementFinder.matchesCandidate]), free of Android types so the host
 * tests replay the SDK's locator conformance fixtures against the agent's
 * own rules (PILOT-707). On a device each read comes from the candidate's
 * AccessibilityNodeInfo; the functions are only called on the branches
 * that need them, since some cost an accessibility round-trip.
 */
internal interface FindCandidate {
    val className: String?
    val text: String?
    val contentDescription: String?

    /** An editable field's hint (API 26+); null when it has none. */
    fun hint(): String?

    /** The role the app published ([FindRules.publishedRole]), or null. */
    fun roleDescription(): String?

    /** The text of the view labelling this one (labeledBy), or null. */
    fun labeledByText(): CharSequence?

    /** The text of the descendants a user can see ([FindRules.descendantTextParts]). */
    fun descendantTextParts(): List<String>
}

/**
 * The class and text criteria of a find's UIAutomator walk
 * ([ElementFinder.walkPatterns]): `By.clazz(Pattern)` and `By.text(Pattern)`,
 * each matched against the whole attribute. The walk's other criteria
 * (content description, resource id, a className selector) are not here.
 */
internal class WalkPatterns(
    val clazz: Pattern?,
    val text: List<Pattern>,
) {
    /**
     * Whether the walk selects an element with this class and text: like
     * UIAutomator's `ByMatcher`, each pattern must match the whole value,
     * and a missing value is read as "".
     */
    fun accepts(
        className: CharSequence?,
        text: CharSequence?,
    ): Boolean =
        (clazz == null || clazz.matcher(className ?: "").matches()) &&
            this.text.all { it.matcher(text ?: "").matches() }
}
