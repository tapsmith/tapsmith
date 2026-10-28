package dev.tapsmith.agent

import android.graphics.Rect
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import org.json.JSONObject
import org.w3c.dom.NodeList
import org.xml.sax.InputSource
import java.io.StringReader
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.regex.Pattern
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.xpath.XPathConstants
import javax.xml.xpath.XPathFactory

/**
 * Selector specification for finding elements.
 */
data class ElementSelector(
    val role: String? = null,
    val name: String? = null,
    /** getByRole `{ exact: true }`: match [name] case-sensitively and whole. */
    val nameExact: Boolean = false,
    /** getByRole `{ name: RegExp }` (PILOT-520); the parser then leaves [name] null. */
    val nameRegex: TextRegex? = null,
    val text: String? = null,
    val textContains: String? = null,
    /** getByText(RegExp) (PILOT-520), tested against the element's own text. */
    val textRegex: TextRegex? = null,
    val contentDesc: String? = null,
    val hint: String? = null,
    val className: String? = null,
    val testId: String? = null,
    val id: String? = null,
    val xpath: String? = null,
    val label: String? = null,
    /** getByLabel(RegExp) (PILOT-520), tested against the label text. */
    val labelRegex: TextRegex? = null,
    val enabled: Boolean? = null,
    val checked: Boolean? = null,
    val focused: Boolean? = null,
    val selected: Boolean? = null,
    val expanded: Boolean? = null,
) {
    /**
     * The selector as not-found errors, wait timeouts and the find-phase log
     * name it, e.g. `role=button, name=Sign in`. Every field the finder
     * filters on belongs here, or a failing locator reports an empty or
     * partial selector (PILOT-606).
     */
    fun describe(): String {
        val parts = mutableListOf<String>()
        role?.let { parts.add("role=$it") }
        name?.let { parts.add("name=$it") }
        if (name != null && nameExact) parts.add("exact=true")
        nameRegex?.let { parts.add("name=$it") }
        text?.let { parts.add("text=$it") }
        textContains?.let { parts.add("textContains=$it") }
        textRegex?.let { parts.add("text=$it") }
        label?.let { parts.add("label=$it") }
        labelRegex?.let { parts.add("label=$it") }
        contentDesc?.let { parts.add("contentDesc=$it") }
        hint?.let { parts.add("hint=$it") }
        className?.let { parts.add("className=$it") }
        testId?.let { parts.add("testId=$it") }
        id?.let { parts.add("id=$it") }
        xpath?.let { parts.add("xpath=$it") }
        enabled?.let { parts.add("enabled=$it") }
        checked?.let { parts.add("checked=$it") }
        focused?.let { parts.add("focused=$it") }
        selected?.let { parts.add("selected=$it") }
        expanded?.let { parts.add("expanded=$it") }
        return parts.joinToString(", ")
    }
}

/**
 * Information about a found UI element.
 */
data class ElementInfo(
    val elementId: String,
    val className: String,
    val text: String?,
    val contentDescription: String?,
    val resourceId: String?,
    val hint: String?,
    val bounds: Rect,
    val isEnabled: Boolean,
    val isChecked: Boolean,
    val isFocused: Boolean,
    val isClickable: Boolean,
    val isFocusable: Boolean,
    val isScrollable: Boolean,
    val isVisible: Boolean,
    val isSelected: Boolean,
    val childCount: Int,
    val role: String,
    val viewportRatio: Float,
) {
    fun toJson(): JSONObject =
        JSONObject().apply {
            put("elementId", elementId)
            put("className", className)
            put("text", text ?: JSONObject.NULL)
            put("contentDescription", contentDescription ?: JSONObject.NULL)
            put("resourceId", resourceId ?: JSONObject.NULL)
            put("hint", hint ?: JSONObject.NULL)
            put(
                "bounds",
                JSONObject().apply {
                    put("left", bounds.left)
                    put("top", bounds.top)
                    put("right", bounds.right)
                    put("bottom", bounds.bottom)
                    put("centerX", bounds.centerX())
                    put("centerY", bounds.centerY())
                    put("width", bounds.width())
                    put("height", bounds.height())
                },
            )
            put("enabled", isEnabled)
            put("checked", isChecked)
            put("focused", isFocused)
            put("clickable", isClickable)
            put("focusable", isFocusable)
            put("scrollable", isScrollable)
            put("visible", isVisible)
            put("selected", isSelected)
            put("childCount", childCount)
            put("role", role)
            put("viewportRatio", viewportRatio.toDouble())
        }
}

/**
 * Finds UI elements using UIAutomator2 selectors.
 *
 * Supports multiple selector strategies: role, text, contentDesc, className,
 * testId, resourceId, xpath, and more. Maintains a cache of found elements
 * so they can be referenced by ID in subsequent commands.
 */
class ElementFinder(
    private val device: UiDevice,
    private val instrumentation: android.app.Instrumentation,
) {
    /** Cache of element IDs to UiObject2 instances. */
    private val elementCache = ConcurrentHashMap<String, UiObject2>()

    /** Insertion order tracking for cache eviction (ArrayDeque for O(1) removeFirst). */
    private val elementCacheOrder = ArrayDeque<String>()

    /** [TargetIdentity] of each cached element, evicted with it. */
    private val elementIdentities = ConcurrentHashMap<String, TargetIdentity>()

    /** Maximum number of cached elements before evicting oldest entries.
     *  Kept high so a broad query's own matches cannot evict ids the SDK is
     *  about to act on (`.first()` acts on the oldest-appended id of a batch). */
    private val maxCacheSize = 2000

    /**
     * Lazily-resolved reflective handle for `UiObject2.getAccessibilityNodeInfo`.
     * The method lives on the base class regardless of the runtime subclass
     * `obj.javaClass` reports, so a single lookup is enough.
     *
     * Wrapped in `runCatching` so a future UIAutomator that renames or
     * removes the method doesn't crash the agent via an
     * `ExceptionInInitializerError` on first access; [nodeInfoFor] then
     * returns null.
     */
    private val nodeInfoMethod: java.lang.reflect.Method? by lazy {
        runCatching {
            UiObject2::class.java
                .getDeclaredMethod("getAccessibilityNodeInfo")
                .apply { isAccessible = true }
        }.onFailure { e ->
            warnOnce("nodeInfoMethod-init", e)
        }.getOrNull()
    }

    /**
     * UiObject2's node from the tree walk that found it (PILOT-539), read
     * without the refresh every UiObject2 getter does. Pinned to the
     * bundled UIAutomator by `FindRulesTest`.
     */
    private val cachedNodeField: java.lang.reflect.Field? by lazy {
        runCatching {
            UiObject2::class.java
                .getDeclaredField(CACHED_NODE_FIELD)
                .apply { isAccessible = true }
        }.onFailure { e ->
            warnOnce("cachedNodeField-init", e)
        }.getOrNull()
    }

    /** UiObject2's visible-bounds rule applied to a given node (PILOT-539). */
    private val visibleBoundsMethod: java.lang.reflect.Method? by lazy {
        runCatching {
            UiObject2::class.java
                .getDeclaredMethod(VISIBLE_BOUNDS_METHOD, AccessibilityNodeInfo::class.java)
                .apply { isAccessible = true }
        }.onFailure { e ->
            warnOnce("visibleBoundsMethod-init", e)
        }.getOrNull()
    }

    /** Names of reflection sites we've already warned about. */
    private val warnedSites: MutableSet<String> = ConcurrentHashMap.newKeySet()

    companion object {
        /** Private UiObject2 members the snapshot reader uses (PILOT-539). */
        const val CACHED_NODE_FIELD: String = "mCachedNode"
        const val VISIBLE_BOUNDS_METHOD: String = "getVisibleBounds"

        /** Logcat tag of the per-find phase timings. */
        const val FIND_LOG_TAG: String = "TapsmithFind"

        // Class names that can carry a hint (placeholder) attribute.
        // Used as a candidate filter when only `hint` is supplied; the actual
        // hint match is applied as a post-filter via extractHint().
        val EDIT_TEXT_HINT_CLASS_PATTERN: java.util.regex.Pattern =
            java.util.regex.Pattern.compile(
                "(?:" +
                    listOf(
                        "android.widget.EditText",
                        "android.widget.AutoCompleteTextView",
                        "com.google.android.material.textfield.TextInputEditText",
                        "androidx.appcompat.widget.AppCompatEditText",
                    ).joinToString("|") { Regex.escape(it) } +
                    ")",
            )

        // Bundle key used by AccessibilityNodeInfoCompat#setRoleDescription.
        // Current AndroidX writes the literal
        // `"AccessibilityNodeInfo.roleDescription"`. We also probe the
        // older namespaced variant because some shipped AndroidX versions
        // (pre-1.0) used it; not free to verify them all, so keep the
        // fallback as defensive.
        val ROLE_DESCRIPTION_EXTRA_KEY: String = "AccessibilityNodeInfo.roleDescription"
        val ROLE_DESCRIPTION_LONG_FORM_KEY: String =
            "androidx.view.accessibility.AccessibilityNodeInfoCompat.ROLE_DESCRIPTION_KEY"

        // Bundle key + bitmask used by AccessibilityNodeInfoCompat to flag
        // a heading on API levels < 28 (the framework itself gained
        // setHeading() in API 28). The compat lib packs several boolean
        // properties (heading, screen-reader-focusable, showing-hint, …)
        // into a single int under this extras key. Bit 2 (`0x2`) is
        // `BOOLEAN_PROPERTY_IS_HEADING`. Verified against
        // androidx.core 1.15.0 source.
        const val COMPAT_BOOLEAN_PROPERTY_KEY: String =
            "androidx.view.accessibility.AccessibilityNodeInfoCompat.BOOLEAN_PROPERTY_KEY"
        const val COMPAT_BOOLEAN_PROPERTY_IS_HEADING: Int = 0x2

        // Cap on collectDescendantText recursion. Each level of recursion
        // makes an IPC call (UiObject2.children) — unbounded recursion on a
        // deeply nested matched container becomes O(N) IPC per find. 6 is
        // enough for typical RN compositions (<View><Text/></View> is depth
        // 1; alerts / toasts / list items rarely exceed 4) while bounding
        // worst-case cost for unexpectedly deep matches.
        const val MAX_DESCENDANT_TEXT_DEPTH: Int = 6

        // A re-render mid-traversal (e.g. a React state update right after a
        // tap) invalidates the UiObject2 handles a find is walking, surfacing
        // as StaleObjectException from findObjects() or an attribute read. The
        // snapshot is transient — re-query a settled tree a few times before
        // giving up, rather than failing the command. A bubbling stale would
        // otherwise become an ELEMENT_NOT_FOUND that the SDK's strict
        // pre-action resolve (PILOT-226) reports as a hard "findElements
        // failed" instead of auto-waiting through it.
        const val STALE_RETRY_ATTEMPTS: Int = 4
        const val STALE_RETRY_DELAY_MS: Long = 50L

        // Cross-platform aliases so users can pass either the Tapsmith/Playwright
        // role name ("heading") or the React Native one ("header").
        val ROLE_ALIASES: Map<String, String> =
            mapOf(
                "header" to "heading",
                "slider" to "seekbar",
                // React Native's spelling of the role. RN publishes no role
                // description for accessibilityRole="search" on Android (the
                // field is a plain EditText), so only a native SearchView or
                // an app's own "search" description is a searchfield here.
                "search" to "searchfield",
                // React Native's and ARIA's spelling (PILOT-664).
                "radio" to "radiobutton",
            )

        // Roles resolved exclusively via extractRoleDescription(). No
        // entry in roleClassMap — React Native renders these as a generic
        // android.view.View and names the role only through
        // AccessibilityNodeInfoCompat.setRoleDescription() (PILOT-664 added
        // all but alert, combobox and tab). A tab item has no class of its
        // own either: RN, Material's TabLayout.TabView and
        // NavigationBarItemView, and Compose's Role.Tab all publish the
        // "Tab" description on a generic layout (PILOT-514). The SDK's
        // ANDROID_TRAIT_ONLY_ROLES (roles.ts) is pinned to this list.
        val TRAIT_ONLY_ROLES: Set<String> =
            setOf(
                "alert",
                "combobox",
                "menu",
                "menubar",
                "menuitem",
                "radiogroup",
                "scrollbar",
                "spinbutton",
                "summary",
                "tab",
                "timer",
            )

        // Roles that CAN be resolved by class (they have roleClassMap
        // entries) but also have trait-based variants via RN
        // accessibilityRole. The post-filter accepts both class-matched
        // AND roleDescription-matched elements. React Native (and Compose)
        // render progressbar and toolbar as a generic android.view.View
        // with only a role description, so they must be here too (PILOT-656),
        // and RN's tab list ("Tab List") is a tablist beside the native tab
        // containers (PILOT-514). Compose's Switch is a View with the
        // "Switch" description beside the framework and AppCompat classes
        // (PILOT-828).
        // The SDK's ANDROID_DUAL_PATH_ROLES (roles.ts) is pinned to this list.
        val DUAL_PATH_ROLES: Set<String> =
            setOf("heading", "link", "image", "searchfield", "progressbar", "toolbar", "tablist", "switch")
    }

    /**
     * Role-to-class-name mappings. Each role maps to a list of Android class names
     * that could represent that role (including Material/AppCompat variants).
     * These keys plus TRAIT_ONLY_ROLES are the SDK's `NATIVE_ROLES`
     * (packages/tapsmith/src/roles.ts), which rejects any other role before
     * it reaches the agent; `roles.test.ts` pins them together (PILOT-556).
     */
    private val roleClassMap =
        mapOf(
            // ToggleButton is also React Native's togglebutton role, which
            // iOS reports as a button too, as ARIA does (PILOT-664).
            "button" to
                listOf(
                    "android.widget.Button",
                    "android.widget.ImageButton",
                    "android.widget.ToggleButton",
                    "com.google.android.material.button.MaterialButton",
                    "androidx.appcompat.widget.AppCompatButton",
                ),
            "textfield" to
                listOf(
                    "android.widget.EditText",
                    "android.widget.AutoCompleteTextView",
                    "com.google.android.material.textfield.TextInputEditText",
                    "androidx.appcompat.widget.AppCompatEditText",
                ),
            "checkbox" to
                listOf(
                    "android.widget.CheckBox",
                    "androidx.appcompat.widget.AppCompatCheckBox",
                    "com.google.android.material.checkbox.MaterialCheckBox",
                ),
            "switch" to
                listOf(
                    "android.widget.Switch",
                    "androidx.appcompat.widget.SwitchCompat",
                    "com.google.android.material.switchmaterial.SwitchMaterial",
                ),
            "image" to
                listOf(
                    "android.widget.ImageView",
                    "androidx.appcompat.widget.AppCompatImageView",
                ),
            "text" to
                listOf(
                    "android.widget.TextView",
                    "androidx.appcompat.widget.AppCompatTextView",
                    "com.google.android.material.textview.MaterialTextView",
                ),
            "heading" to
                listOf(
                    "android.widget.TextView",
                ),
            "link" to
                listOf(
                    "android.widget.TextView",
                ),
            "list" to
                listOf(
                    "android.widget.ListView",
                    "android.widget.GridView",
                    "androidx.recyclerview.widget.RecyclerView",
                ),
            "listitem" to
                listOf(
                    "android.widget.LinearLayout",
                    "android.widget.RelativeLayout",
                    "android.widget.FrameLayout",
                ),
            "scrollview" to
                listOf(
                    "android.widget.ScrollView",
                    "android.widget.HorizontalScrollView",
                    "androidx.core.widget.NestedScrollView",
                ),
            "progressbar" to
                listOf(
                    "android.widget.ProgressBar",
                    "com.google.android.material.progressindicator.LinearProgressIndicator",
                    "com.google.android.material.progressindicator.CircularProgressIndicator",
                ),
            "seekbar" to
                listOf(
                    "android.widget.SeekBar",
                    "com.google.android.material.slider.Slider",
                ),
            "radiobutton" to
                listOf(
                    "android.widget.RadioButton",
                    "androidx.appcompat.widget.AppCompatRadioButton",
                    "com.google.android.material.radiobutton.MaterialRadioButton",
                ),
            "spinner" to
                listOf(
                    "android.widget.Spinner",
                    "androidx.appcompat.widget.AppCompatSpinner",
                ),
            "toolbar" to
                listOf(
                    "android.widget.Toolbar",
                    "androidx.appcompat.widget.Toolbar",
                    "com.google.android.material.appbar.MaterialToolbar",
                ),
            // The tab containers. Their items are "tab"s, known only by
            // their role description (TRAIT_ONLY_ROLES, PILOT-514).
            "tablist" to
                listOf(
                    "android.widget.TabWidget",
                    "com.google.android.material.tabs.TabLayout",
                ),
            // Mirrors iOS RoleMapping ("searchfield" -> .searchField).
            // Native SearchView only. RN renders accessibilityRole="search"
            // as a plain EditText with no role description (RN 0.83), so
            // it is a "textfield" here; an app that publishes its own
            // "search" description still matches through the dual-path
            // filter and the "search" → "searchfield" alias.
            "searchfield" to
                listOf(
                    "android.widget.SearchView",
                    "androidx.appcompat.widget.SearchView",
                ),
        )

    /**
     * Reverse mapping from class name to role.
     */
    private val classToRoleMap: Map<String, String> by lazy {
        buildMap {
            for ((role, classNames) in roleClassMap) {
                for (className in classNames) {
                    putIfAbsent(className, role)
                }
            }
        }
    }

    /**
     * Compute what fraction of the element is within the screen viewport.
     * Returns 0.0 if fully off-screen, 1.0 if fully on-screen.
     */
    internal fun computeViewportRatio(bounds: Rect): Float {
        val screenWidth = device.displayWidth
        val screenHeight = device.displayHeight
        val screenRect = Rect(0, 0, screenWidth, screenHeight)

        val elementArea = bounds.width().toLong() * bounds.height().toLong()
        if (elementArea <= 0) return 0f

        val intersection = Rect()
        if (!intersection.setIntersect(bounds, screenRect)) return 0f

        val intersectionArea = intersection.width().toLong() * intersection.height().toLong()
        return (intersectionArea.toFloat() / elementArea.toFloat()).coerceIn(0f, 1f)
    }

    /**
     * Resolve the role for a given class name.
     */
    private fun resolveRole(className: String): String = classToRoleMap[className] ?: ""

    /**
     * For a normalized role, return the set of raw roleDescription values
     * that should match. Bridges the ROLE_ALIASES gap: e.g., for
     * "searchfield", returns {"searchfield", "search"} so an app's own
     * roleDescription="search" is accepted.
     */
    private fun acceptableRoleDescriptions(normalizedRole: String): Set<String> =
        buildSet {
            add(normalizedRole)
            for ((alias, target) in ROLE_ALIASES) {
                if (target == normalizedRole) add(alias)
            }
        }

    /**
     * Find a single element matching the selector: the first match, in tree
     * order. Stops at that match, so a broad selector reads one element's
     * attributes, not every candidate's (PILOT-539).
     * @throws ElementNotFoundException if no element matches
     */
    fun findElement(
        selector: ElementSelector,
        parentId: String? = null,
    ): ElementInfo =
        findWithStaleRetry(selector, parentId, limit = 1).firstOrNull()
            ?: throw ElementNotFoundException("No element found matching: ${selector.describe()}")

    /**
     * Find all elements matching the selector.
     */
    fun findElements(
        selector: ElementSelector,
        parentId: String? = null,
    ): List<ElementInfo> = findWithStaleRetry(selector, parentId, limit = Int.MAX_VALUE)

    /**
     * Retries on a transient StaleObjectException: a re-render during the
     * tree walk (or a scoped find's parent refresh) invalidates the nodes it
     * is walking, and a fresh walk of the (now-settled) tree usually
     * succeeds. See [STALE_RETRY_ATTEMPTS].
     */
    private fun findWithStaleRetry(
        selector: ElementSelector,
        parentId: String?,
        limit: Int,
    ): List<ElementInfo> {
        // Coerce to >= 1 so the loop always runs at least once and the
        // fallback below is unreachable in practice (guards a future edit
        // that sets STALE_RETRY_ATTEMPTS to 0).
        val maxAttempts = STALE_RETRY_ATTEMPTS.coerceAtLeast(1)
        var lastStale: StaleObjectException? = null
        for (attempt in 0 until maxAttempts) {
            try {
                return findElementsOnce(selector, parentId, limit)
            } catch (e: StaleObjectException) {
                lastStale = e
                if (attempt < maxAttempts - 1) {
                    CommandCancellation.sleep(STALE_RETRY_DELAY_MS)
                }
            }
        }
        throw lastStale ?: error("findElements retry loop ran zero attempts")
    }

    /**
     * One find: walk the tree once for the candidates UIAutomator can
     * select natively ([enumerate]), then match and read each candidate from
     * the node that walk captured ([snapshotOf]) until [limit] matches.
     *
     * Reading the walk's snapshot is what keeps a query cheap on a busy app
     * (PILOT-539). Every UiObject2 getter refreshes its node first — an
     * accessibility round-trip that waits for the app's main looper — so
     * reading a dozen attributes of every TextView on an animating screen
     * cost ~100 ms per candidate and seconds per query, while the walk
     * itself (like a hierarchy dump) takes tens of milliseconds. The walk
     * starts from a cleared accessibility cache ([clearAccessibilityCache]),
     * so its nodes are current, and they are the ones UIAutomator just
     * matched `By.text`/`By.clazz` against: every filter sees one consistent
     * snapshot. Actions still refresh: the cached UiObject2 re-reads its
     * node when acted on.
     */
    private fun findElementsOnce(
        selector: ElementSelector,
        parentId: String?,
        limit: Int,
    ): List<ElementInfo> {
        val startedAt = SystemClock.uptimeMillis()
        val fresh = clearAccessibilityCache()

        // XPath-based search uses a different path (a hierarchy dump, which
        // reads through the same cache, so it is cleared first as well).
        if (selector.xpath != null) {
            return findByXPath(selector.xpath).take(limit)
        }

        val parent =
            if (parentId != null) {
                elementCache[parentId]
                    ?: throw ElementNotFoundException("Parent element '$parentId' not found in cache")
            } else {
                null
            }

        val excludedWindows = nonAppWindowIds()
        val candidates = enumerate(selector, parent)
        val enumeratedAt = SystemClock.uptimeMillis()

        var extractMs = 0L
        val (matches, examined) =
            matchCandidates(candidates, selector, fresh, limit, excludedWindows) { obj, node ->
                val extractStart = SystemClock.uptimeMillis()
                cacheAndConvert(obj, node, fresh).also { extractMs += SystemClock.uptimeMillis() - extractStart }
            }
        val doneAt = SystemClock.uptimeMillis()
        android.util.Log.d(
            FIND_LOG_TAG,
            "find phases [${selector.describe()}]: enumerate=${enumeratedAt - startedAt}ms " +
                "(candidates=${candidates.size}) match=${doneAt - enumeratedAt - extractMs}ms " +
                "(examined=$examined) extract=${extractMs}ms (matched=${matches.size}" +
                (if (limit != Int.MAX_VALUE) ", limit=$limit" else "") + ")" +
                (if (fresh) "" else " [cache not cleared: per-node refresh]"),
        )
        return matches
    }

    /**
     * The match step of a find: every candidate the walk enumerated that the
     * selector's non-native parts and state filters accept, in tree order,
     * up to [limit]. Returns the matches and how many candidates were read.
     * A candidate that isn't the app's — in one of [excludedWindows], or the
     * hooks marker — never matches ([NonAppNodes]).
     */
    private inline fun matchCandidates(
        candidates: List<UiObject2>,
        selector: ElementSelector,
        fresh: Boolean,
        limit: Int,
        excludedWindows: Set<Int>,
        refreshed: MutableMap<AccessibilityNodeInfo, AccessibilityNodeInfo>? = null,
        convert: (UiObject2, AccessibilityNodeInfo) -> ElementInfo,
    ): Pair<List<ElementInfo>, Int> {
        var examined = 0
        val matches =
            ComposeRoles.matchInTreeOrder(
                candidates,
                limit,
                read = { candidate ->
                    // Each candidate can cost an accessibility round-trip on a
                    // busy app: stop once the daemon has given up (PILOT-605).
                    CommandCancellation.checkpoint()
                    examined++
                    val node = snapshotOf(candidate, fresh, refreshed)
                    val nonApp = node.windowId in excludedWindows || NonAppNodes.isHooksMarker(node.text, node.contentDescription)
                    if (nonApp) null else Found(node) { candidate }
                },
                // A Compose role carrier stands for its parent, which getByRole
                // matches with the carrier's role ([ComposeRoles]). The
                // parent's UiObject2 — a round-trip — is made only for a match.
                carrierParentOf = { found ->
                    if (selector.role == null) return@matchInTreeOrder null
                    val parentNode = carrierParentNode(found.node, fresh) ?: return@matchInTreeOrder null
                    val carrierObj = found.obj
                    // A parent gone since the walk is a re-render: retry the find.
                    Found(parentNode) { carrierObj.parent ?: throw StaleObjectException() }
                },
                key = { it.node },
                accepts = { target, roleSource ->
                    matchesSelector(target.node, selector, fresh, roleSource.node) && matchesStateFilters(target.node, selector)
                },
            )
        return matches.map { convert(it.obj, it.node) } to examined
    }

    /** A candidate's snapshot [node], and its UiObject2, made when first needed. */
    private class Found(
        val node: AccessibilityNodeInfo,
        objOf: () -> UiObject2,
    ) {
        val obj: UiObject2 by lazy(LazyThreadSafetyMode.NONE, objOf)
    }

    /**
     * Evaluate several selectors against the current UI (PILOT-848), by the
     * same enumerate-and-match steps as [findElements], so locator
     * suggestions and match counts are decided by the rules tests run with.
     *
     * - One accessibility-cache clear for the batch, and each node read at
     *   most once ([refreshed]): below API 34 there is no cache to clear and
     *   every read is a round-trip, while a screen's candidates walk the same
     *   nodes over and over.
     * - Never waits, and never caches a match (the returned ids are empty),
     *   so evaluating a screen's worth of candidates can't evict the handles
     *   of a test running on the same agent.
     * - A selector that fails (an invalid RegExp, a missing criterion, a
     *   tree still re-rendering after every retry) fails only its own entry.
     */
    fun evaluateSelectors(selectors: List<Result<ElementSelector>>): List<Result<List<ElementInfo>>> {
        val startedAt = SystemClock.uptimeMillis()
        var fresh = clearAccessibilityCache()
        // One window list for the batch, re-read with the tree on a retry.
        var excludedWindows = nonAppWindowIds()
        val refreshed = HashMap<AccessibilityNodeInfo, AccessibilityNodeInfo>()
        val maxAttempts = STALE_RETRY_ATTEMPTS.coerceAtLeast(1)
        val results =
            selectors.map { parsed ->
                CommandCancellation.checkpoint()
                val selector = parsed.getOrElse { return@map Result.failure(it) }
                var outcome: Result<List<ElementInfo>> = Result.failure(StaleObjectException())
                for (attempt in 0 until maxAttempts) {
                    try {
                        outcome = Result.success(evaluateOne(selector, fresh, refreshed, excludedWindows))
                        break
                    } catch (e: StaleObjectException) {
                        // Retry this selector against a re-read tree; the
                        // others keep what they found.
                        outcome = Result.failure(e)
                        if (attempt < maxAttempts - 1) {
                            CommandCancellation.sleep(STALE_RETRY_DELAY_MS)
                            fresh = clearAccessibilityCache()
                            excludedWindows = nonAppWindowIds()
                            refreshed.clear()
                        }
                    } catch (e: CommandCancelledException) {
                        throw e
                    } catch (e: Exception) {
                        outcome = Result.failure(e)
                        break
                    }
                }
                outcome
            }
        android.util.Log.d(
            FIND_LOG_TAG,
            "evaluateSelectors: ${selectors.size} selectors in ${SystemClock.uptimeMillis() - startedAt}ms" +
                (if (fresh) "" else " [cache not cleared: ${refreshed.size} nodes refreshed once each]"),
        )
        return results
    }

    private fun evaluateOne(
        selector: ElementSelector,
        fresh: Boolean,
        refreshed: MutableMap<AccessibilityNodeInfo, AccessibilityNodeInfo>,
        excludedWindows: Set<Int>,
    ): List<ElementInfo> {
        if (selector.xpath != null) {
            return findByXPath(selector.xpath).map { it.copy(elementId = "") }
        }
        return matchCandidates(enumerate(selector, null), selector, fresh, Int.MAX_VALUE, excludedWindows, refreshed) { obj, node ->
            toElementInfo(obj, node, "", fresh).first
        }.first
    }

    /**
     * The ids of the windows no locator searches ([NonAppNodes.excludesWindow]):
     * the input method, and System UI's status and navigation bars. Read once per find, from the
     * window list the walk itself searches; empty (nothing excluded) if it
     * can't be read.
     */
    private fun nonAppWindowIds(): Set<Int> =
        try {
            instrumentation.uiAutomation.windows
                .filter { window ->
                    val rect = Rect()
                    window.getBoundsInScreen(rect)
                    NonAppNodes.excludesWindow(
                        window.type,
                        window.isFocused,
                        window.isActive,
                        HierarchyAttributes.Box(rect.left, rect.top, rect.right, rect.bottom),
                        device.displayWidth,
                        device.displayHeight,
                    ) { rootPackageOf(window) }
                }.mapTo(HashSet()) { it.id }
        } catch (e: Exception) {
            warnOnce("nonAppWindowIds", e)
            emptySet()
        }

    /** The package of [window]'s root node, or null when it has none. An accessibility round-trip. */
    @Suppress("DEPRECATION")
    private fun rootPackageOf(window: android.view.accessibility.AccessibilityWindowInfo): CharSequence? {
        val root = window.root ?: return null
        return try {
            root.packageName
        } finally {
            root.recycle()
        }
    }

    /**
     * Get a cached element by its stable ID.
     * @throws ElementNotFoundException if the ID is not in the cache
     */
    fun getElement(elementId: String): UiObject2 {
        val cached =
            elementCache[elementId]
                ?: throw ElementNotFoundException("Element '$elementId' not found. It may have gone stale.")
        // Touch on access: a resolved-then-acted-on id is refreshed in the
        // eviction order rather than aging out between resolve and action.
        synchronized(elementCacheOrder) {
            if (elementCacheOrder.remove(elementId)) {
                elementCacheOrder.add(elementId)
            }
        }
        return cached
    }

    /**
     * Get the bounds of a cached element for action execution — a live
     * (refreshed) read, unlike a find's snapshot.
     */
    fun getElementBounds(elementId: String): Rect {
        val obj = getElement(elementId)
        return obj.visibleBounds
    }

    /** Input classes a label can name (getByLabel). */
    private val labelInputClassPattern: java.util.regex.Pattern by lazy {
        val inputClasses =
            roleClassMap["textfield"].orEmpty() +
                roleClassMap["checkbox"].orEmpty() +
                roleClassMap["switch"].orEmpty() +
                roleClassMap["radiobutton"].orEmpty() +
                roleClassMap["seekbar"].orEmpty() +
                roleClassMap["spinner"].orEmpty()
        java.util.regex.Pattern
            .compile(inputClasses.joinToString("|") { Regex.escape(it) })
    }

    /**
     * The one tree walk of a find: every element the selector's native
     * UIAutomator part ([buildBySelector]) selects, in tree order.
     */
    private fun enumerate(
        selector: ElementSelector,
        parent: UiObject2?,
    ): List<UiObject2> {
        val bySelector =
            if (selector.label != null || selector.labelRegex != null) {
                // Label selector: input elements, filtered by label in
                // matchesSelector — a single walk with a class pattern.
                By.clazz(labelInputClassPattern)
            } else {
                buildBySelector(selector)
                    ?: if (selector.role != null) {
                        // Trait/dual-path role: no class constraint. Broad
                        // match required because BySelector can't express
                        // desc-OR-text. The byName and role post-filters
                        // in matchesSelector handle precise matching.
                        By.clazz(
                            java.util.regex.Pattern
                                .compile(".*"),
                        )
                    } else {
                        throw InvalidSelectorException("No valid selector criteria provided")
                    }
            }
        return (if (parent != null) parent.findObjects(bySelector) else device.findObjects(bySelector))
            ?: emptyList()
    }

    /**
     * The parts of the selector UIAutomator can't express natively, checked
     * against a candidate's snapshot [node]: label, trait-based role, role
     * name and hint. The role is read from [roleNode]: the node itself, or
     * the Compose role carrier that stands for it ([ComposeRoles]).
     */
    private fun matchesSelector(
        node: AccessibilityNodeInfo,
        selector: ElementSelector,
        fresh: Boolean,
        roleNode: AccessibilityNodeInfo = node,
    ): Boolean {
        // Label selector: an input whose contentDescription matches the
        // label text, OR one labeled by a TextView with matching text (via
        // AccessibilityNodeInfo.getLabeledBy).
        if (selector.label != null) {
            return matchesLabel(node, fresh) { TextMatch.equalsNormalized(it, selector.label) }
        }
        if (selector.labelRegex != null) {
            return matchesLabel(node, fresh) { selector.labelRegex.matches(it) }
        }

        // Trait-based and dual-path roles use the broad By.clazz(".*")
        // walk, so the trait decides first, then the name. Matching the
        // name alone on the broad set is unreliable — a View whose
        // AccessibilityNodeInfo text is aggregated from children reports
        // null text.
        if (selector.role != null) {
            val normalized = ROLE_ALIASES[selector.role.lowercase()] ?: selector.role.lowercase()
            if (normalized in TRAIT_ONLY_ROLES || normalized in DUAL_PATH_ROLES) {
                val isRole =
                    FindRules.matchesTraitRole(
                        roleDescription = extractRoleDescription(roleNode),
                        className = roleNode.className?.toString(),
                        acceptable = acceptableRoleDescriptions(normalized),
                        classSet = roleClassMap[normalized]?.toSet() ?: emptySet(),
                        ambiguous = normalized == "heading" || normalized == "link",
                    )
                return isRole && matchesAccessibleName(node, selector, fresh)
            }
        }

        // Role name: match contentDescription, text, or the joined
        // descendant text. Like Playwright, a case-insensitive substring by
        // default and a case-sensitive whole-string match with `exact`
        // (PILOT-549); a RegExp tested against the normalized name
        // (PILOT-520).
        if (selector.role != null && !matchesAccessibleName(node, selector, fresh)) return false

        // Hint — UIAutomator can't query hint directly. `buildBySelector`
        // narrows the walk to EditText variants only when `hint` is the
        // *only* selector; combined with another selector (e.g.
        // `locator({ className: "TextView", hint: "Email" })`) the walk can
        // return arbitrary classes, so require the EditText class here too
        // before accepting the `text == hint` fallback. Without that guard a
        // TextView with the literal visible label "Email" would match a
        // getByPlaceholder("Email") query.
        if (selector.hint != null) {
            val className = node.className?.toString() ?: ""
            if (!EDIT_TEXT_HINT_CLASS_PATTERN.matcher(className).matches()) return false
            return extractHint(node) == selector.hint || node.text?.toString() == selector.hint
        }
        return true
    }

    /** The enabled/checked/focused/selected/expanded state filters. */
    private fun matchesStateFilters(
        node: AccessibilityNodeInfo,
        selector: ElementSelector,
    ): Boolean =
        (selector.enabled == null || node.isEnabled == selector.enabled) &&
            (selector.checked == null || node.isChecked == selector.checked) &&
            (selector.focused == null || node.isFocused == selector.focused) &&
            (selector.selected == null || node.isSelected == selector.selected) &&
            (selector.expanded == null || isExpanded(node) == selector.expanded)

    private fun buildBySelector(selector: ElementSelector): BySelector? {
        // Reject incompatible combinations up front so the failure mode
        // is "loud and obvious" rather than "silent contract drift".
        // `hint` always narrows to the EditText class pattern below via
        // `BySelector.clazz()`, which *replaces* any prior `clazz`
        // constraint — so combining `hint` with `className` or `role`
        // (both of which also set `clazz`) is incoherent. `id` and
        // `testId` use `BySelector.res()` which composes cleanly with
        // `clazz`, so those are allowed.
        if (selector.hint != null) {
            val conflicting = mutableListOf<String>()
            if (selector.className != null) conflicting.add("className")
            if (selector.role != null) conflicting.add("role")
            if (conflicting.isNotEmpty()) {
                throw InvalidSelectorException(
                    "`hint` cannot be combined with [${conflicting.joinToString(", ")}] — " +
                        "both set the BySelector class constraint, and `clazz()` replaces " +
                        "rather than intersects. Drop the conflicting field " +
                        "or use `getByPlaceholder` (hint-only) for placeholder-text matching.",
                )
            }
        }

        var by: BySelector? = null

        // Role-based selection
        if (selector.role != null) {
            val lowered = selector.role.lowercase()
            val normalizedRole = ROLE_ALIASES[lowered] ?: lowered
            val classNames = roleClassMap[normalizedRole]

            if (normalizedRole == "switch" && classNames != null) {
                // A switch is a switch class, or Compose's Switch: a plain
                // View with the "Switch" description (PILOT-828). Walking
                // just those keeps the query as cheap as the class walk it
                // was; the dual-path post-filter decides between them.
                val classes = classNames + ComposeRoles.COMPOSE_VIEW_CLASS
                val pattern = classes.joinToString("|") { Regex.escape(it) }
                by = By.clazz(Pattern.compile(pattern))
            } else if (normalizedRole in DUAL_PATH_ROLES || normalizedRole in TRAIT_ONLY_ROLES) {
                // Trait/dual-path roles: skip class constraint. RN
                // surfaces these via roleDescription on generic views
                // (ReactViewGroup), not via class name. The post-filter
                // in matchesSelector matches by extractRoleDescription()
                // and falls back to class membership for dual-path roles.
            } else if (classNames != null) {
                val pattern = classNames.joinToString("|") { Regex.escape(it) }
                by =
                    By.clazz(
                        java.util.regex.Pattern
                            .compile(pattern),
                    )
            } else {
                val known = (roleClassMap.keys + TRAIT_ONLY_ROLES + DUAL_PATH_ROLES).sorted()
                throw InvalidSelectorException(
                    "Unknown role: '${selector.role}'. Known roles: ${known.joinToString()}",
                )
            }

            // If a name is also given, filter by accessible name (contentDescription
            // or text on the element itself, or text on a descendant). We can't express
            // OR conditions in a single BySelector, so matchesSelector filters by it.
            // Store the name requirement but don't add it to `by` here.
        }

        // Text selectors — whitespace-normalized like Playwright (PILOT-510):
        // a non-breaking space or line break in the element's text matches a
        // plain space in the query.
        if (selector.text != null) {
            val pattern = TextMatch.exactPattern(selector.text)
            by = if (by != null) by.text(pattern) else By.text(pattern)
        }
        if (selector.textContains != null) {
            val pattern = TextMatch.containsPattern(selector.textContains)
            by = if (by != null) by.text(pattern) else By.text(pattern)
        }
        // A RegExp is tested against the raw text, as Playwright tests it
        // against the element's full text (PILOT-520).
        if (selector.textRegex != null) {
            val pattern = selector.textRegex.fullMatchPattern()
            by = if (by != null) by.text(pattern) else By.text(pattern)
        }

        // Content description
        if (selector.contentDesc != null) {
            by = if (by != null) by.desc(selector.contentDesc) else By.desc(selector.contentDesc)
        }

        // Class name
        if (selector.className != null) {
            by = if (by != null) by.clazz(selector.className) else By.clazz(selector.className)
        }

        // Resource ID
        if (selector.id != null) {
            by = if (by != null) by.res(selector.id) else By.res(selector.id)
        }

        // Test ID — React Native's `testID` prop is exposed as `resource-id`
        // in the UIAutomator hierarchy (no package namespace). Treat it as a
        // resource-id lookup.
        if (selector.testId != null) {
            by = if (by != null) by.res(selector.testId) else By.res(selector.testId)
        }

        // Hint text — UIAutomator has no By.hint(), so narrow to EditText
        // candidates here and post-filter on the actual hint value in
        // matchesSelector(). Conflicting combinations (hint + className /
        // role / id / testId) were rejected up front, so by the time
        // we get here `hint` is either the only selector or paired
        // with text/textContains/contentDesc/enabled-style filters
        // that compose cleanly with the EditText class constraint.
        if (selector.hint != null) {
            by =
                if (by != null) {
                    by.clazz(EDIT_TEXT_HINT_CLASS_PATTERN)
                } else {
                    By.clazz(EDIT_TEXT_HINT_CLASS_PATTERN)
                }
        }

        return by
    }

    /**
     * Find elements by evaluating an XPath expression against the UI hierarchy XML.
     */
    private fun findByXPath(xpath: String): List<ElementInfo> {
        val baos = java.io.ByteArrayOutputStream()
        device.dumpWindowHierarchy(baos)
        val xml = baos.toString(Charsets.UTF_8.name())

        val factory = DocumentBuilderFactory.newInstance()
        val builder = factory.newDocumentBuilder()
        val doc = builder.parse(InputSource(StringReader(xml)))

        val xpathFactory = XPathFactory.newInstance()
        val xpathExpr = xpathFactory.newXPath().compile(xpath)
        val nodes = xpathExpr.evaluate(doc, XPathConstants.NODESET) as NodeList

        val results = mutableListOf<ElementInfo>()
        for (i in 0 until nodes.length) {
            val node = nodes.item(i)
            if (node.nodeType != org.w3c.dom.Node.ELEMENT_NODE) continue
            val elem = node as org.w3c.dom.Element

            val boundsStr = elem.getAttribute("bounds")
            val bounds = parseBounds(boundsStr)

            val elementId = UUID.randomUUID().toString()
            val className = elem.getAttribute("class") ?: ""
            results.add(
                ElementInfo(
                    elementId = elementId,
                    className = className,
                    text = elem.getAttribute("text").ifEmpty { null },
                    contentDescription = elem.getAttribute("content-desc").ifEmpty { null },
                    resourceId = elem.getAttribute("resource-id").ifEmpty { null },
                    hint = elem.getAttribute("hint").ifEmpty { null },
                    bounds = bounds,
                    isEnabled = elem.getAttribute("enabled") == "true",
                    isChecked = elem.getAttribute("checked") == "true",
                    isFocused = elem.getAttribute("focused") == "true",
                    isClickable = elem.getAttribute("clickable") == "true",
                    isFocusable = elem.getAttribute("focusable") == "true",
                    isScrollable = elem.getAttribute("scrollable") == "true",
                    isSelected = elem.getAttribute("selected") == "true",
                    childCount = elem.childNodes.length,
                    role = resolveRole(className),
                    viewportRatio = computeViewportRatio(bounds),
                    isVisible = computeViewportRatio(bounds) > 0f,
                ),
            )
            // XPath elements can't be cached as UiObject2 — they're XML-based
        }

        return results
    }

    /**
     * Whether input [node] is named by a label that [labelMatches]:
     * 1. its contentDescription (most common in React Native, where
     *    accessibilityLabel is set directly on the input),
     * 2. the text of the node it is labeled by (AccessibilityNodeInfo's
     *    labeledBy/labelFor relationship — the native Android pattern; one
     *    round-trip, only for inputs strategy 1 rejects), or
     * 3. for a text field, the text of one of its descendants: a Compose
     *    TextField's `label = { Text("Email") }` is a child of the field
     *    (PILOT-828). Not for other inputs: a Spinner's child shows its
     *    selected value, which is no label.
     */
    private fun matchesLabel(
        node: AccessibilityNodeInfo,
        fresh: Boolean,
        labelMatches: (CharSequence?) -> Boolean,
    ): Boolean {
        if (labelMatches(node.contentDescription?.toString())) return true
        val labelNode = node.labeledBy
        if (labelNode != null) {
            try {
                if (labelMatches(labelNode.text)) return true
            } finally {
                @Suppress("DEPRECATION")
                labelNode.recycle()
            }
        }
        if (node.childCount == 0 || !EDIT_TEXT_HINT_CLASS_PATTERN.matcher(node.className?.toString() ?: "").matches()) return false
        return descendantTextParts(node, fresh).any(labelMatches)
    }

    private fun parseBounds(boundsStr: String): Rect {
        // Format: [left,top][right,bottom]
        val regex = """\[(\d+),(\d+)\]\[(\d+),(\d+)\]""".toRegex()
        val match = regex.find(boundsStr) ?: return Rect(0, 0, 0, 0)
        val (left, top, right, bottom) = match.destructured
        return Rect(left.toInt(), top.toInt(), right.toInt(), bottom.toInt())
    }

    /**
     * Clear the accessibility cache so this find's tree walk fetches every
     * node fresh from the app (PILOT-539). UIAutomator's walk reads nodes
     * through that cache, which the app's accessibility events keep only
     * partly current: React Native does not report every state change (a
     * radio button's checked state, a view appearing in a list), and
     * UiObject2's getters used to paper over that with a refresh per
     * attribute read. Clearing once costs a few prefetching round-trips for
     * the whole walk instead of one round-trip per attribute per candidate.
     * `UiAutomation.clearCache()` exists from API 34; below that, returns
     * false and the find refreshes each node it reads instead.
     */
    private fun clearAccessibilityCache(): Boolean {
        if (android.os.Build.VERSION.SDK_INT < 34) return false
        return try {
            instrumentation.uiAutomation.clearCache()
        } catch (e: Exception) {
            warnOnce("clearCache", e)
            false
        }
    }

    /**
     * The node [obj] captured when the tree walk found it. After a [fresh]
     * walk that node is current and is read as is — no round-trip (see
     * [findElementsOnce]). Otherwise it is refreshed once: one round-trip
     * for every attribute this find reads, where UiObject2's getters made
     * one per attribute. Falls back to a refreshed read if the bundled
     * UIAutomator no longer has the field, which `FindRulesTest` pins.
     * With [refreshed] (a batch of finds over one screen), a node refreshed
     * once is reused, keyed by the node the walk captured.
     */
    private fun snapshotOf(
        obj: UiObject2,
        fresh: Boolean,
        refreshed: MutableMap<AccessibilityNodeInfo, AccessibilityNodeInfo>? = null,
    ): AccessibilityNodeInfo {
        val walked = cachedNodeField?.get(obj) as? AccessibilityNodeInfo
        if (fresh && walked != null) return walked
        if (refreshed != null && walked != null) refreshed[walked]?.let { return it }
        val node = nodeInfoFor(obj) ?: throw StaleObjectException()
        if (refreshed != null && walked != null) refreshed[walked] = node
        return node
    }

    /**
     * [obj]'s visible bounds computed from its snapshot [node], by
     * UiObject2's own rule (clipped to the display, its window and its
     * first scrollable ancestor). Falls back to the live read if the
     * reflective helper is unavailable.
     */
    private fun visibleBoundsOf(
        obj: UiObject2,
        node: AccessibilityNodeInfo,
    ): Rect {
        val method = visibleBoundsMethod
        return try {
            if (method != null) {
                method.invoke(obj, node) as? Rect ?: Rect(0, 0, 0, 0)
            } else {
                obj.visibleBounds
            }
        } catch (_: Exception) {
            Rect(0, 0, 0, 0)
        }
    }

    /**
     * Hint text of [node]. getHintText() is available on API 26+; returns
     * null on older devices.
     */
    private fun extractHint(node: AccessibilityNodeInfo): String? {
        if (android.os.Build.VERSION.SDK_INT < 26) return null
        return node.hintText?.toString()
    }

    /**
     * Whether [node] is in the expanded state. Returns null if the expanded
     * state cannot be determined (element doesn't support expand/collapse
     * actions).
     */
    private fun isExpanded(node: AccessibilityNodeInfo): Boolean? {
        val actions = node.actionList ?: return null
        val expandId = AccessibilityNodeInfo.AccessibilityAction.ACTION_EXPAND.id
        val collapseId = AccessibilityNodeInfo.AccessibilityAction.ACTION_COLLAPSE.id
        return FindRules.expandedState(
            canExpand = actions.any { it.id == expandId },
            canCollapse = actions.any { it.id == collapseId },
        )
    }

    /**
     * Read the semantic role published by frameworks like React Native, which
     * surfaces `accessibilityRole` via two channels:
     *   - `AccessibilityNodeInfo.setHeading(true)` for "header"
     *   - `AccessibilityNodeInfoCompat.setRoleDescription(...)` for other roles
     *
     * The role description is returned lowercased, with RN's multi-word
     * descriptions ("Progress Bar") read as the role name
     * ([FindRules.canonicalRoleDescription]), including custom or
     * localized values the SDK doesn't otherwise know about. This lets apps
     * surface their own roles to tests without us maintaining an allowlist.
     * Lowercasing is a deliberate compromise: it lets the SDK's
     * case-insensitive `normalizeRole` + ROLE_ALIASES table match an app
     * that publishes `"Header"` against `toHaveRole("heading")`, at the
     * cost of folding case on truly custom values. An app setting
     * `accessibilityRole="Überschrift"` will surface as `"überschrift"`.
     * The Android `isHeading` check above returns the canonical
     * `"heading"` first to avoid this for the common case.
     *
     * Returns null when no role is published.
     */
    private fun extractRoleDescription(node: AccessibilityNodeInfo): String? {
        try {
            // 1. Heading flag (API 28+) — React Native writes here for
            //    `accessibilityRole="header"`.
            if (android.os.Build.VERSION.SDK_INT >= 28 && node.isHeading) {
                return "heading"
            }

            // 2. Compat-shimmed heading flag for older API levels: read the
            // packed boolean-properties int and test the IS_HEADING bit.
            val extras = node.extras
            if (extras != null) {
                val packed = extras.getInt(COMPAT_BOOLEAN_PROPERTY_KEY, 0)
                if ((packed and COMPAT_BOOLEAN_PROPERTY_IS_HEADING) != 0) {
                    return "heading"
                }
            }

            // 3. Role description set via AccessibilityNodeInfoCompat.
            // Try both the canonical and the older long-form key — older
            // AndroidX shims wrote under the namespaced variant.
            val raw =
                extras?.getCharSequence(ROLE_DESCRIPTION_EXTRA_KEY)?.toString()
                    ?: extras?.getCharSequence(ROLE_DESCRIPTION_LONG_FORM_KEY)?.toString()
            // Lowercase the value so the SDK's case-insensitive
            // normalizeRole + ROLE_ALIASES table can match (an app setting
            // accessibilityRole="Header" would otherwise surface as
            // "Header"), and read RN's multi-word descriptions ("Progress
            // Bar") as the role name.
            return FindRules.canonicalRoleDescription(raw)
        } catch (e: Exception) {
            // A malformed extras bundle must not fail the whole find; log so
            // a regression in every role-from-RN mapping is visible.
            warnOnce("extractRoleDescription", e)
            return null
        }
    }

    /**
     * Whether the field is currently displaying its hint/placeholder rather
     * than user-entered text. AccessibilityNodeInfo.isShowingHintText is
     * available on API 26+. On older devices this returns false.
     */
    private fun isShowingHintText(node: AccessibilityNodeInfo): Boolean {
        if (android.os.Build.VERSION.SDK_INT < 26) return false
        return node.isShowingHintText
    }

    /**
     * Log a reflection failure once per call-site so a future AndroidX /
     * UiAutomator rename surfaces loudly the first time we see it instead
     * of silently degrading every textfield-related assertion.
     */
    private fun warnOnce(
        site: String,
        e: Throwable,
    ) {
        if (warnedSites.add(site)) {
            android.util.Log.w(
                "ElementFinder",
                "Reflection failed at '$site' — assertions depending on it will degrade: ${e.message}",
                e,
            )
        }
    }

    /**
     * The live accessibility node behind [obj], refreshed; null when the
     * reflective accessor is unavailable. Throws StaleObjectException when
     * the node is gone.
     */
    fun nodeInfoFor(obj: UiObject2): AccessibilityNodeInfo? {
        val method = nodeInfoMethod ?: return null
        return try {
            method.invoke(obj) as? AccessibilityNodeInfo
        } catch (e: java.lang.reflect.InvocationTargetException) {
            // Unwrap so a StaleObjectException thrown mid-re-render surfaces as
            // itself instead of an InvocationTargetException with a null
            // message — the stale-retry loop in findElements and the typed
            // ELEMENT_NOT_FOUND mapping in CommandHandler both key on the
            // real exception type.
            throw e.targetException ?: e
        }
    }

    /**
     * Whether [node]'s accessible name matches the selector's role name:
     * its contentDescription, its text, or its joined descendant text (read
     * only when the first two don't match) — or, for an EditText with no
     * other name, its hint (PILOT-834).
     */
    private fun matchesAccessibleName(
        node: AccessibilityNodeInfo,
        selector: ElementSelector,
        fresh: Boolean,
    ): Boolean {
        val regex = selector.nameRegex
        val name = selector.name
        if (regex == null && name == null) return true
        val text = node.text?.toString()
        val contentDescription = node.contentDescription?.toString()
        // An empty EditText reports its hint as its text; that hint is a
        // name, not a typed value. A typed one with no other name is still
        // named by its hint (PILOT-834).
        val isEditText = EDIT_TEXT_HINT_CLASS_PATTERN.matcher(node.className?.toString() ?: "").matches()
        val hint = if (isEditText) extractHint(node) else null
        val textIsValue = text != null && isEditText && text != hint
        if (regex != null) {
            return TextMatch.accessibleNameMatches(
                contentDescription = contentDescription,
                text = text,
                textIsValue = textIsValue,
                descendantText = { collectDescendantText(node, fresh) },
                regex = regex,
                hint = hint,
            )
        }
        return TextMatch.accessibleNameMatches(
            contentDescription = contentDescription,
            text = text,
            textIsValue = textIsValue,
            descendantText = { collectDescendantText(node, fresh) },
            name = name!!,
            exact = selector.nameExact,
            hint = hint,
        )
    }

    /**
     * Concatenate the text or content-description of [node]'s descendants
     * (see [FindRules.descendantTextParts]), so locator assertions like
     * `toContainText` see the visible label of a wrapping View whose own
     * `text` attribute is empty (common with React Native).
     *
     * Per child we take `text` *or* `contentDescription` (preferring text)
     * to avoid duplicating the same string when both attributes carry it,
     * matching the iOS aggregation in SnapshotElementFinder. Only children
     * visible to the user count, as UiObject2.getChildren() lists them.
     *
     * Recursion is capped at MAX_DESCENDANT_TEXT_DEPTH because a child the
     * walk didn't prefetch is an accessibility round-trip; the cap covers
     * the common `<View><Text/></View>` toast / alert pattern (depth 1) and
     * typical RN compositions, while bounding worst-case cost for
     * accidental deep matches.
     */
    private fun collectDescendantText(
        node: AccessibilityNodeInfo,
        fresh: Boolean,
    ): String = descendantTextParts(node, fresh).joinToString(" ")

    /** The parts [collectDescendantText] joins, one per contributing descendant. */
    private fun descendantTextParts(
        node: AccessibilityNodeInfo,
        fresh: Boolean,
    ): List<String> =
        FindRules.descendantTextParts(
            node,
            children = { visibleChildren(it, fresh) },
            ownText = { child ->
                child.text?.toString()?.takeIf { it.isNotEmpty() }
                    ?: child.contentDescription?.toString()?.takeIf { it.isNotEmpty() }
            },
            // The hooks marker is no one's visible text ([NonAppNodes]).
            skip = { child -> NonAppNodes.isHooksMarker(child.text, child.contentDescription) },
            maxDepth = MAX_DESCENDANT_TEXT_DEPTH,
        )

    /**
     * [node]'s children visible to the user. Without a [fresh] walk each
     * child is refreshed first, as UiObject2's getters did, so its text is
     * current.
     */
    private fun visibleChildren(
        node: AccessibilityNodeInfo,
        fresh: Boolean,
    ): List<AccessibilityNodeInfo> =
        (0 until node.childCount).mapNotNull { i ->
            node.getChild(i)?.takeIf { (fresh || it.refresh()) && it.isVisibleToUser }
        }

    /** What [ComposeRoles] reads of [node]: local reads of its snapshot. */
    internal fun composeShapeOf(node: AccessibilityNodeInfo): ComposeRoles.NodeShape {
        val className = node.className?.toString()
        return ComposeRoles.NodeShape(
            className = className,
            role = extractRoleDescription(node) ?: resolveRole(className ?: ""),
            text = node.text,
            contentDescription = node.contentDescription,
            childCount = node.childCount,
            clickable = node.isClickable,
            longClickable = node.isLongClickable,
            focusable = node.isFocusable,
            checkable = node.isCheckable,
        )
    }

    /**
     * When [node] is a Compose role carrier ([ComposeRoles]), its parent's
     * node — the control getByRole matches — read from the walk's snapshot
     * (refreshed when the walk wasn't [fresh]); null for any other node.
     * Only a leaf of the carrier's shape costs a parent read.
     */
    private fun carrierParentNode(
        node: AccessibilityNodeInfo,
        fresh: Boolean,
    ): AccessibilityNodeInfo? {
        var parentNode: AccessibilityNodeInfo? = null
        val carrier =
            ComposeRoles.isCarrier(
                composeShapeOf(node),
                parent = {
                    node.parent?.takeIf { fresh || it.refresh() }?.let {
                        parentNode = it
                        composeShapeOf(it)
                    }
                },
                isLastChild = {
                    val p = parentNode
                    p != null && p.getChild(p.childCount - 1) == node
                },
            )
        return if (carrier) parentNode else null
    }

    /**
     * The role a Compose control [node] takes from its role carrier — its
     * last child ([ComposeRoles]) — or null. One child read, only for a
     * role-less node of Compose's shape.
     */
    private fun carriedRoleOf(
        node: AccessibilityNodeInfo,
        fresh: Boolean,
    ): String? {
        val parent = composeShapeOf(node)
        if (!ComposeRoles.mayBeCarrierParent(parent)) return null
        val last = node.getChild(node.childCount - 1)?.takeIf { fresh || it.refresh() } ?: return null
        val shape = composeShapeOf(last)
        return if (ComposeRoles.isCarrier(shape, { parent }, { true })) ComposeRoles.carriedRole(shape) else null
    }

    /**
     * Read [obj]'s snapshot [node] into an [ElementInfo], plus the
     * [TargetIdentity] actions re-check before touching it.
     */
    private fun toElementInfo(
        obj: UiObject2,
        node: AccessibilityNodeInfo,
        elementId: String,
        fresh: Boolean,
    ): Pair<ElementInfo, TargetIdentity> {
        val bounds = visibleBoundsOf(obj, node)
        val className = node.className?.toString() ?: ""
        val rawText = node.text?.toString()
        val contentDescription = node.contentDescription?.toString()
        val resourceId = node.viewIdResourceName

        // PILOT-133/toBeEmpty: UIAutomator surfaces the placeholder/hint as
        // `text` when an EditText is empty. Strip it so callers see the actual
        // typed value (empty after clear). We gate on
        // AccessibilityNodeInfo.isShowingHintText (API 26+) so an EditText
        // whose user-typed value happens to equal its placeholder isn't
        // mis-reported as empty. An element with no text of its own
        // aggregates its descendants' text so wrapping containers (RN
        // ReactViewGroup, plain ViewGroup, ConstraintLayout, etc.) expose
        // their visible label.
        val effectiveText =
            FindRules.effectiveText(
                rawText,
                isShowingHint = { isShowingHintText(node) },
                descendantText = { collectDescendantText(node, fresh) },
            )

        // Prefer the framework-set RoleDescription (React Native's
        // accessibilityRole) over the className-based mapping when present;
        // a Compose control without either takes its carrier's (PILOT-828).
        val role = (extractRoleDescription(node) ?: resolveRole(className)).ifEmpty { carriedRoleOf(node, fresh) ?: "" }
        val viewportRatio = computeViewportRatio(bounds)

        val info =
            ElementInfo(
                elementId = elementId,
                className = className,
                text = effectiveText,
                contentDescription = contentDescription,
                resourceId = resourceId,
                hint = extractHint(node),
                bounds = bounds,
                isEnabled = node.isEnabled,
                isChecked = node.isChecked,
                isFocused = node.isFocused,
                isClickable = node.isClickable,
                isFocusable = node.isFocusable,
                isScrollable = node.isScrollable,
                isVisible = viewportRatio > 0f,
                isSelected = node.isSelected,
                childCount = node.childCount,
                role = role,
                viewportRatio = viewportRatio,
            )
        return info to TargetIdentity(className, resourceId, contentDescription, rawText)
    }

    private fun cacheElement(
        id: String,
        element: UiObject2,
        identity: TargetIdentity,
    ) {
        synchronized(elementCacheOrder) {
            elementCache[id] = element
            elementIdentities[id] = identity
            elementCacheOrder.add(id)
            if (elementCacheOrder.size > maxCacheSize) {
                val oldest = elementCacheOrder.removeFirst()
                elementCache.remove(oldest)
                elementIdentities.remove(oldest)
            }
        }
    }

    /**
     * What identified a cached element when it was found (PILOT-362), for
     * actions to re-check before touching it; null for an unknown id.
     */
    fun identityOf(elementId: String): TargetIdentity? = elementIdentities[elementId]

    /**
     * Clear the element cache. Called by the daemon between tests or on
     * navigation to release stale UiObject2 references.
     */
    fun clearElementCache() {
        synchronized(elementCacheOrder) {
            elementCache.clear()
            elementIdentities.clear()
            elementCacheOrder.clear()
        }
    }

    private fun cacheAndConvert(
        obj: UiObject2,
        node: AccessibilityNodeInfo,
        fresh: Boolean,
    ): ElementInfo {
        val elementId = UUID.randomUUID().toString()
        val (info, identity) = toElementInfo(obj, node, elementId, fresh)
        cacheElement(elementId, obj, identity)
        return info
    }
}
