package dev.tapsmith.agent

import android.graphics.Rect
import android.os.SystemClock
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
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.xpath.XPathConstants
import javax.xml.xpath.XPathFactory

/**
 * Selector specification for finding elements.
 */
data class ElementSelector(
    val role: String? = null,
    val name: String? = null,
    val text: String? = null,
    val textContains: String? = null,
    val contentDesc: String? = null,
    val hint: String? = null,
    val className: String? = null,
    val testId: String? = null,
    val id: String? = null,
    val xpath: String? = null,
    val label: String? = null,
    val enabled: Boolean? = null,
    val checked: Boolean? = null,
    val focused: Boolean? = null,
    val selected: Boolean? = null,
    val expanded: Boolean? = null,
)

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
class ElementFinder(private val device: UiDevice) {
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
     * removes the method doesn't crash every textfield-related assertion
     * via an `ExceptionInInitializerError` on first access. Callers route
     * the null through `extractHint` / `extractRoleDescription` /
     * `isShowingHintText`, all of which already handle null cleanly.
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

    /** Names of reflection sites we've already warned about. */
    private val warnedSites: MutableSet<String> = ConcurrentHashMap.newKeySet()

    companion object {
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
                // RN's accessibilityRole="search" surfaces as a role
                // description of "search"; normalize to the canonical
                // "searchfield" so toHaveRole("searchfield") matches.
                "search" to "searchfield",
            )

        // Roles resolved exclusively via extractRoleDescription(). No
        // entry in roleClassMap — React Native surfaces these through
        // AccessibilityNodeInfoCompat.setRoleDescription().
        val TRAIT_ONLY_ROLES: Set<String> = setOf("alert", "combobox")

        // Roles that CAN be resolved by class (they have roleClassMap
        // entries) but also have trait-based variants via RN
        // accessibilityRole. The post-filter accepts both class-matched
        // AND roleDescription-matched elements.
        val DUAL_PATH_ROLES: Set<String> = setOf("heading", "link", "image", "searchfield")
    }

    /**
     * Role-to-class-name mappings. Each role maps to a list of Android class names
     * that could represent that role (including Material/AppCompat variants).
     */
    private val roleClassMap =
        mapOf(
            "button" to
                listOf(
                    "android.widget.Button",
                    "android.widget.ImageButton",
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
            "tab" to
                listOf(
                    "android.widget.TabWidget",
                    "com.google.android.material.tabs.TabLayout",
                ),
            // Mirrors iOS RoleMapping ("searchfield" -> .searchField).
            // Native SearchView only — RN renders accessibilityRole="search"
            // as an EditText with a roleDescription; that path is handled
            // through extractRoleDescription + the "search" → "searchfield"
            // alias rather than the class map, so the reverse map
            // (className → role) doesn't fight with "textfield".
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
    private fun resolveRole(className: String): String {
        return classToRoleMap[className] ?: ""
    }

    /**
     * For a normalized role, return the set of raw roleDescription values
     * that should match. Bridges the ROLE_ALIASES gap: e.g., for
     * "searchfield", returns {"searchfield", "search"} so RN's
     * roleDescription="search" is accepted.
     */
    private fun acceptableRoleDescriptions(normalizedRole: String): Set<String> {
        return buildSet {
            add(normalizedRole)
            for ((alias, target) in ROLE_ALIASES) {
                if (target == normalizedRole) add(alias)
            }
        }
    }

    /**
     * Find a single element matching the selector.
     * @throws ElementNotFoundException if no element matches
     */
    fun findElement(
        selector: ElementSelector,
        parentId: String? = null,
    ): ElementInfo {
        val elements = findElements(selector, parentId)
        if (elements.isEmpty()) {
            throw ElementNotFoundException("No element found matching: ${describeSelector(selector)}")
        }
        return elements.first()
    }

    /**
     * Find all elements matching the selector.
     *
     * Retries on a transient StaleObjectException: a re-render between the
     * tree walk and reading an element's attributes invalidates UiObject2
     * handles, and a fresh snapshot of the (now-settled) tree usually
     * succeeds. See [STALE_RETRY_ATTEMPTS].
     */
    fun findElements(
        selector: ElementSelector,
        parentId: String? = null,
    ): List<ElementInfo> {
        // Coerce to >= 1 so the loop always runs at least once and the
        // fallback below is unreachable in practice (guards a future edit
        // that sets STALE_RETRY_ATTEMPTS to 0).
        val maxAttempts = STALE_RETRY_ATTEMPTS.coerceAtLeast(1)
        var lastStale: StaleObjectException? = null
        for (attempt in 0 until maxAttempts) {
            try {
                return findElementsOnce(selector, parentId)
            } catch (e: StaleObjectException) {
                lastStale = e
                if (attempt < maxAttempts - 1) {
                    SystemClock.sleep(STALE_RETRY_DELAY_MS)
                }
            }
        }
        throw lastStale ?: error("findElements retry loop ran zero attempts")
    }

    private fun findElementsOnce(
        selector: ElementSelector,
        parentId: String? = null,
    ): List<ElementInfo> {
        // XPath-based search uses a different path
        if (selector.xpath != null) {
            return findByXPath(selector.xpath)
        }

        val parent =
            if (parentId != null) {
                elementCache[parentId]
                    ?: throw ElementNotFoundException("Parent element '$parentId' not found in cache")
            } else {
                null
            }

        val objects = findUiObjects(selector, parent)

        // Apply additional attribute filters
        val filtered =
            objects.filter { obj ->
                (selector.enabled == null || obj.isEnabled == selector.enabled) &&
                    (selector.checked == null || obj.isChecked == selector.checked) &&
                    (selector.focused == null || obj.isFocused == selector.focused) &&
                    (selector.selected == null || obj.isSelected == selector.selected) &&
                    (selector.expanded == null || isExpanded(obj) == selector.expanded)
            }

        // Let a StaleObjectException during info extraction bubble to
        // findElements(), which re-snapshots a settled tree. Swallowing it
        // here would silently drop the element and return a partial/empty
        // result, defeating the retry for the very case it exists to handle.
        return filtered.map { obj -> cacheAndConvert(obj) }
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
     * Get the bounds of a cached element for action execution.
     */
    fun getElementBounds(elementId: String): Rect {
        val obj = getElement(elementId)
        return obj.visibleBounds
    }

    private fun findUiObjects(
        selector: ElementSelector,
        parent: UiObject2?,
    ): List<UiObject2> {
        // Label selector: find input elements whose accessible name matches the label text.
        // Strategy: find inputs whose contentDescription matches, OR inputs labeled by a
        // TextView with matching text (via AccessibilityNodeInfo.getLabeledBy).
        if (selector.label != null) {
            return findByLabel(selector.label, parent)
        }

        val bySelector =
            buildBySelector(selector)
                ?: if (selector.role != null) {
                    // Trait/dual-path role: no class constraint. Broad
                    // match required because BySelector can't express
                    // desc-OR-text. The byName and role post-filters
                    // below handle precise matching.
                    By.clazz(java.util.regex.Pattern.compile(".*"))
                } else {
                    throw InvalidSelectorException("No valid selector criteria provided")
                }

        val results =
            if (parent != null) {
                parent.findObjects(bySelector)
            } else {
                device.findObjects(bySelector)
            }
                ?: emptyList()

        // Post-filter for trait-based and dual-path roles. These use a
        // broad By.clazz(".*") initial search, so we filter by trait FIRST
        // to narrow the set before checking names. Running the name filter
        // on the full broad result is unreliable — UiObject2.getText() can
        // return null for View elements whose AccessibilityNodeInfo text
        // is aggregated from children, causing false negatives.
        if (selector.role != null) {
            val normalized = ROLE_ALIASES[selector.role.lowercase()] ?: selector.role.lowercase()
            if (normalized in TRAIT_ONLY_ROLES || normalized in DUAL_PATH_ROLES) {
                val acceptable = acceptableRoleDescriptions(normalized)
                val ambiguousClassSet = normalized == "heading" || normalized == "link"
                val classSet = roleClassMap[normalized]?.toSet() ?: emptySet()
                val byTrait =
                    results.filter { obj ->
                        val roleDesc = extractRoleDescription(obj)
                        if (roleDesc != null) {
                            roleDesc in acceptable
                        } else if (!ambiguousClassSet && classSet.isNotEmpty()) {
                            (obj.className ?: "") in classSet
                        } else {
                            false
                        }
                    }
                return if (selector.name != null) {
                    byTrait.filter { matchesAccessibleName(it, selector.name) }
                } else {
                    byTrait
                }
            }
        }

        // Post-filter by role name: match contentDescription, text, or an
        // exact descendant text segment. We use segment-level equality (not
        // substring `contains`) so "Sign" doesn't false-positive on a
        // container whose descendant reads "Sign out".
        val byName =
            if (selector.role != null && selector.name != null) {
                results.filter { matchesAccessibleName(it, selector.name) }
            } else {
                results
            }

        // Post-filter by hint — UIAutomator can't query hint directly so we
        // filter the candidate set ourselves. `buildBySelector` narrows the
        // initial candidates to EditText variants only when `hint` is the
        // *only* selector; when combined with another selector (e.g.
        // `locator({ className: "TextView", hint: "Email" })`) the initial
        // set can include arbitrary classes, so we require the EditText
        // class here too before accepting the `obj.text == hint` fallback.
        // Without that guard a TextView with the literal visible label
        // "Email" would match a getByPlaceholder("Email") query.
        val byHint =
            if (selector.hint != null) {
                byName.filter { obj ->
                    val className = obj.className ?: ""
                    val isEditText = EDIT_TEXT_HINT_CLASS_PATTERN.matcher(className).matches()
                    if (!isEditText) return@filter false
                    extractHint(obj) == selector.hint || obj.text == selector.hint
                }
            } else {
                byName
            }

        return byHint
    }

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

            if (normalizedRole in DUAL_PATH_ROLES || normalizedRole in TRAIT_ONLY_ROLES) {
                // Trait/dual-path roles: skip class constraint. RN
                // surfaces these via roleDescription on generic views
                // (ReactViewGroup), not via class name. The post-filter
                // in findUiObjects matches by extractRoleDescription()
                // and falls back to class membership for dual-path roles.
            } else if (classNames != null) {
                val pattern = classNames.joinToString("|") { Regex.escape(it) }
                by = By.clazz(java.util.regex.Pattern.compile(pattern))
            } else {
                val known = (roleClassMap.keys + TRAIT_ONLY_ROLES + DUAL_PATH_ROLES).sorted()
                throw InvalidSelectorException(
                    "Unknown role: '${selector.role}'. Known roles: ${known.joinToString()}",
                )
            }

            // If a name is also given, filter by accessible name (contentDescription
            // or text on the element itself, or text on a descendant). We can't express
            // OR conditions in a single BySelector, so we filter in findElements() below.
            // Store the name requirement but don't add it to `by` here.
        }

        // Text selectors
        if (selector.text != null) {
            by = if (by != null) by.text(selector.text) else By.text(selector.text)
        }
        if (selector.textContains != null) {
            by =
                if (by != null) {
                    by.textContains(selector.textContains)
                } else {
                    By.textContains(selector.textContains)
                }
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
        // findUiObjects(). Conflicting combinations (hint + className /
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
     * Find input elements by their associated label text.
     *
     * Resolution strategy:
     * 1. Find inputs whose contentDescription matches the label text (most common
     *    in React Native where accessibilityLabel is set directly on the input).
     * 2. Find inputs that are labeled by a TextView via AccessibilityNodeInfo's
     *    labeledBy/labelFor relationship (native Android labelFor pattern).
     */
    private fun findByLabel(
        labelText: String,
        parent: UiObject2?,
    ): List<UiObject2> {
        val results = mutableListOf<UiObject2>()

        val inputClasses =
            roleClassMap["textfield"].orEmpty() +
                roleClassMap["checkbox"].orEmpty() +
                roleClassMap["switch"].orEmpty() +
                roleClassMap["radiobutton"].orEmpty() +
                roleClassMap["seekbar"].orEmpty() +
                roleClassMap["spinner"].orEmpty()

        // Single IPC call using a regex pattern to find all input-type elements
        val classPattern =
            java.util.regex.Pattern.compile(
                inputClasses.joinToString("|") { Regex.escape(it) },
            )
        val by = By.clazz(classPattern)
        val allInputs =
            (if (parent != null) parent.findObjects(by) else device.findObjects(by))
                ?: emptyList()

        for (input in allInputs) {
            // Strategy 1: contentDescription matches the label text
            if (input.contentDescription == labelText) {
                results.add(input)
                continue
            }
            // Strategy 2: labeledBy relationship points to a node with matching text
            val nodeInfo = nodeInfoFor(input) ?: continue
            try {
                val labelNode = nodeInfo.labeledBy ?: continue
                try {
                    if (labelNode.text?.toString() == labelText) {
                        results.add(input)
                    }
                } finally {
                    labelNode.recycle()
                }
            } finally {
                nodeInfo.recycle()
            }
        }

        return results
    }

    private fun parseBounds(boundsStr: String): Rect {
        // Format: [left,top][right,bottom]
        val regex = """\[(\d+),(\d+)\]\[(\d+),(\d+)\]""".toRegex()
        val match = regex.find(boundsStr) ?: return Rect(0, 0, 0, 0)
        val (left, top, right, bottom) = match.destructured
        return Rect(left.toInt(), top.toInt(), right.toInt(), bottom.toInt())
    }

    /**
     * Extract hint text from a UiObject2 via AccessibilityNodeInfo.
     * getHintText() is available on API 26+; returns null on older devices.
     */
    private fun extractHint(obj: UiObject2): String? {
        if (android.os.Build.VERSION.SDK_INT < 26) return null
        val nodeInfo = nodeInfoFor(obj) ?: return null
        try {
            return nodeInfo.hintText?.toString()
        } catch (e: Exception) {
            android.util.Log.w("ElementFinder", "Failed to extract hint text for ${obj.className}", e)
            return null
        } finally {
            nodeInfo.recycle()
        }
    }

    /**
     * Check if a UiObject2 is in the expanded state via AccessibilityNodeInfo.
     * Returns null if the expanded state cannot be determined (element doesn't
     * support expand/collapse actions).
     */
    private fun isExpanded(obj: UiObject2): Boolean? {
        val nodeInfo = nodeInfoFor(obj) ?: return null
        return try {
            val actions = nodeInfo.actionList ?: return null
            val expandId =
                android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_EXPAND.id
            val collapseId =
                android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_COLLAPSE.id
            val hasExpand = actions.any { it.id == expandId }
            val hasCollapse = actions.any { it.id == collapseId }
            when {
                hasCollapse -> true
                hasExpand -> false
                else -> null
            }
        } finally {
            nodeInfo.recycle()
        }
    }

    /**
     * Read the semantic role published by frameworks like React Native, which
     * surfaces `accessibilityRole` via two channels:
     *   - `AccessibilityNodeInfo.setHeading(true)` for "header"
     *   - `AccessibilityNodeInfoCompat.setRoleDescription(...)` for other roles
     *
     * The role description is returned (lowercased) including custom or
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
    private fun extractRoleDescription(obj: UiObject2): String? {
        val nodeInfo = nodeInfoFor(obj) ?: return null
        try {
            // 1. Heading flag (API 28+) — React Native writes here for
            //    `accessibilityRole="header"`.
            if (android.os.Build.VERSION.SDK_INT >= 28 && nodeInfo.isHeading) {
                return "heading"
            }

            // 2. Compat-shimmed heading flag for older API levels: read the
            // packed boolean-properties int and test the IS_HEADING bit.
            val extras = nodeInfo.extras
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
            // Lowercase the value before returning so the SDK's
            // case-insensitive normalizeRole + ROLE_ALIASES table can
            // match. Without this, an app setting accessibilityRole="Header"
            // (capitalized) would surface as the literal "Header" and
            // toHaveRole("heading") would not match through the alias.
            return raw?.takeIf { it.isNotEmpty() }?.lowercase()
        } catch (e: Exception) {
            // Reflection on UiObject2 is the load-bearing path here; if it
            // breaks (AndroidX rename, restricted API), every role-from-RN
            // mapping silently regresses. Log so the failure is visible.
            warnOnce("extractRoleDescription", e)
            return null
        } finally {
            nodeInfo.recycle()
        }
    }

    /**
     * Whether the field is currently displaying its hint/placeholder rather
     * than user-entered text. AccessibilityNodeInfo.isShowingHintText is
     * available on API 26+. On older devices this returns false.
     */
    private fun isShowingHintText(obj: UiObject2): Boolean {
        if (android.os.Build.VERSION.SDK_INT < 26) return false
        val nodeInfo = nodeInfoFor(obj) ?: return false
        try {
            return nodeInfo.isShowingHintText
        } catch (e: Exception) {
            warnOnce("isShowingHintText", e)
            return false
        } finally {
            nodeInfo.recycle()
        }
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
    fun nodeInfoFor(obj: UiObject2): android.view.accessibility.AccessibilityNodeInfo? {
        val method = nodeInfoMethod ?: return null
        return try {
            method.invoke(obj) as? android.view.accessibility.AccessibilityNodeInfo
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
     * Recursively walk the element subtree and concatenate any text or
     * content-description from descendants. Used so locator assertions like
     * `toContainText` see the visible label of a wrapping View whose own
     * `text` attribute is empty (common with React Native).
     *
     * Per child we take `text` *or* `contentDescription` (preferring text)
     * to avoid duplicating the same string when both attributes carry it,
     * matching the iOS aggregation in SnapshotElementFinder.
     *
     * Recursion is capped at MAX_DESCENDANT_TEXT_DEPTH because each
     * `obj.children` access is an IPC to the accessibility service —
     * unbounded recursion on a deeply nested screen turns into O(N) IPC
     * calls per matched container. The cap covers the common
     * `<View><Text/></View>` toast / alert pattern (depth 1) and typical
     * RN compositions, while bounding worst-case cost for accidental
     * deep matches.
     */
    private fun matchesAccessibleName(
        obj: UiObject2,
        name: String,
    ): Boolean {
        return obj.contentDescription == name ||
            obj.text == name ||
            collectDescendantText(obj) == name
    }

    private fun collectDescendantTextParts(
        obj: UiObject2,
        depth: Int = 0,
    ): List<String> {
        if (depth >= MAX_DESCENDANT_TEXT_DEPTH) return emptyList()
        val parts = mutableListOf<String>()
        for (child in obj.children.orEmpty()) {
            val ownText =
                child.text?.takeIf { it.isNotEmpty() }
                    ?: child.contentDescription?.takeIf { it.isNotEmpty() }
            if (ownText != null) {
                parts.add(ownText)
            } else {
                parts.addAll(collectDescendantTextParts(child, depth + 1))
            }
        }
        return parts
    }

    private fun collectDescendantText(
        obj: UiObject2,
        depth: Int = 0,
    ): String = collectDescendantTextParts(obj, depth).joinToString(" ")

    /**
     * Read [obj] into an [ElementInfo], plus the [TargetIdentity] actions
     * re-check before touching it — built from the same reads, since each
     * UiObject2 property read is an accessibility round-trip.
     */
    private fun toElementInfo(
        obj: UiObject2,
        elementId: String,
    ): Pair<ElementInfo, TargetIdentity> {
        val bounds =
            try {
                obj.visibleBounds
            } catch (_: Exception) {
                Rect(0, 0, 0, 0)
            }
        val className = obj.className ?: ""
        val rawText = obj.text
        val contentDescription = obj.contentDescription
        val resourceId = obj.resourceName
        val hint = extractHint(obj)

        // PILOT-133/toBeEmpty: UIAutomator surfaces the placeholder/hint as
        // `text` when an EditText is empty. Strip it so callers see the actual
        // typed value (empty after clear). We gate on
        // AccessibilityNodeInfo.isShowingHintText (API 26+) so an EditText
        // whose user-typed value happens to equal its placeholder isn't
        // mis-reported as empty. Pre-API-26 we fall back to the equality
        // check, which is wrong for the equal-typed-value edge case but
        // preserves the toBeEmpty behavior most users rely on.
        val effectiveText: String? =
            if (rawText.isNullOrEmpty()) {
                // Aggregate descendant text so wrapping containers (RN
                // ReactViewGroup, plain ViewGroup, ConstraintLayout, etc.)
                // expose their visible label. Earlier this was gated on a
                // small allowlist of class names — that excluded the actual
                // RN class users have on real apps. Aggregation cost is
                // bounded by MAX_DESCENDANT_TEXT_DEPTH so unconditional
                // recursion on empty-own-text elements is safe.
                collectDescendantText(obj).ifEmpty { null }
            } else if (isShowingHintText(obj)) {
                null
            } else {
                rawText
            }

        // Prefer the framework-set RoleDescription (React Native's
        // accessibilityRole) over the className-based mapping when present.
        val role = extractRoleDescription(obj) ?: resolveRole(className)
        val viewportRatio = computeViewportRatio(bounds)

        val info =
            ElementInfo(
                elementId = elementId,
                className = className,
                text = effectiveText,
                contentDescription = contentDescription,
                resourceId = resourceId,
                hint = hint,
                bounds = bounds,
                isEnabled = obj.isEnabled,
                isChecked = obj.isChecked,
                isFocused = obj.isFocused,
                isClickable = obj.isClickable,
                isFocusable = obj.isFocusable,
                isScrollable = obj.isScrollable,
                isVisible = viewportRatio > 0f,
                isSelected = obj.isSelected,
                childCount = obj.childCount,
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

    private fun cacheAndConvert(obj: UiObject2): ElementInfo {
        val elementId = UUID.randomUUID().toString()
        val (info, identity) = toElementInfo(obj, elementId)
        cacheElement(elementId, obj, identity)
        return info
    }

    private fun describeSelector(selector: ElementSelector): String {
        val parts = mutableListOf<String>()
        selector.role?.let { parts.add("role=$it") }
        selector.name?.let { parts.add("name=$it") }
        selector.text?.let { parts.add("text=$it") }
        selector.textContains?.let { parts.add("textContains=$it") }
        selector.contentDesc?.let { parts.add("contentDesc=$it") }
        selector.hint?.let { parts.add("hint=$it") }
        selector.className?.let { parts.add("className=$it") }
        selector.testId?.let { parts.add("testId=$it") }
        selector.id?.let { parts.add("id=$it") }
        selector.xpath?.let { parts.add("xpath=$it") }
        return parts.joinToString(", ")
    }
}
