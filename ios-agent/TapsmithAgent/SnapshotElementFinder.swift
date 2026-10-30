import XCTest
import Foundation

/// Move an id to the most-recently-used end of a cache eviction order, so a
/// resolved-then-acted-on element is refreshed rather than aging out between
/// the resolve and the action. Callers must hold their cache's lock.
func promoteToMostRecentlyUsed(_ order: inout [String], _ elementId: String) {
    if let idx = order.firstIndex(of: elementId) {
        order.remove(at: idx)
        order.append(elementId)
    }
}

/// Fast element finder that uses XCUIElement.snapshot() to fetch the entire
/// accessibility tree in a single IPC call, then searches in memory.
///
/// This is the same approach Maestro uses. It avoids per-element XCUITest
/// queries which each take 2-3 seconds due to quiescence waiting and IPC.
///
/// The snapshot approach: one ~50ms IPC call → in-memory search → instant results.
class SnapshotElementFinder {
    private let app: XCUIApplication
    private var elementCache: [String: XCUIElement] = [:]
    /// Bounds from snapshot — used for coordinate-based actions (fast, no quiescence).
    private var boundsCache: [String: CGRect] = [:]
    /// Element type, label, and identifier from the same snapshot, so the
    /// occlusion check can still pick the element out of a fresh tree when
    /// its live query no longer reads (PILOT-223) — bounds alone cannot tell
    /// it from a same-frame cover.
    private var identityCache: [String: CachedIdentity] = [:]
    private var cacheOrder: [String] = []
    private var focusedTextInputHint: FocusedTextInputHint?
    private let lock = NSLock()

    struct CachedIdentity {
        let elementType: XCUIElement.ElementType
        let label: String
        let identifier: String
        /// Whether the element had a `.tabBar` ancestor, so a live re-read
        /// still reports a tab bar's button as a tab (PILOT-514).
        let inTabBar: Bool
        /// Whether the element is a switch holding a switch — a SwiftUI
        /// Toggle and its knob (NonAppElements.isSwitchPart, PILOT-790) — so
        /// a tap on it is delivered to the knob.
        var holdsSwitchPart = false
    }

    /// Maximum number of cached elements before eviction. Prevents unbounded
    /// growth from thousands of stale XCUIElement references accumulating
    /// over a long test run. Entries are lazy query descriptors (no live
    /// element tree references), so a few thousand is cheap — and a small cap
    /// lets broad queries (`getByText` matching many rows) plus the pre-action
    /// trace capture evict ids the SDK is about to act on.
    private let maxCacheSize = 2000

    private struct LiveFocusedTextInput {
        let elementType: XCUIElement.ElementType
        let identifier: String
        let label: String
        let frame: CGRect
    }

    private struct FocusedTextInputHint {
        let identifier: String
        let label: String
        let frame: CGRect
        let point: CGPoint?
    }

    /// Parsed snapshot node from the accessibility tree.
    struct AXNode {
        let elementType: UInt
        let label: String
        let identifier: String
        let value: String
        let placeholderValue: String
        let isEnabled: Bool
        let frame: CGRect
        let children: [AXNode]

        /// The original XCUIElement for actions (tap, type, etc.)
        /// Only populated for matches, not the entire tree.
        weak var element: XCUIElement?
    }

    init(app: XCUIApplication) {
        self.app = app
    }

    // MARK: - Snapshot-based finding

    /// Find a single element matching the selector using snapshot.
    ///
    /// **Cost:** one `app.snapshot()` IPC (~50ms steady state, up to
    /// ~1s on first call before the accessibility connection is warm) +
    /// one O(N) tree walk + one O(N) KVC pass for trait annotation,
    /// where N is total accessibility-tree node count. See
    /// `findElements` for the underlying budget; `findElement` adds no
    /// extra IPC, just a `.first` on the result list.
    func findElement(_ selector: ElementSelector, parentId: String? = nil) throws -> ElementInfo {
        let elements = try findElements(selector, parentId: parentId)
        guard let first = elements.first else {
            throw AgentError.elementNotFound("No element found matching: \(describeSelector(selector))")
        }
        return first
    }

    /// Find a single element from a pre-taken snapshot (avoids an extra IPC).
    func findElement(_ selector: ElementSelector, fromSnapshot snapshot: XCUIElementSnapshot) throws -> ElementInfo {
        let elements = try findElements(selector, fromSnapshot: snapshot)
        guard let first = elements.first else {
            throw AgentError.elementNotFound("No element found matching: \(describeSelector(selector))")
        }
        return first
    }

    /// Find all elements matching the selector using snapshot.
    ///
    /// **Cost:** 1 × `app.snapshot()` IPC (the only IPC on the happy
    /// path; ~50ms steady state, up to 5×0.2s retries before the
    /// accessibility connection is established on cold start) +
    /// 1 × `dictionaryRepresentation` conversion (cheap, no IPC) +
    /// O(N) `KVC traits` reads via `annotateTraits` (each is a
    /// Swift↔ObjC bridge call but stays in-process; no IPC) +
    /// O(N) tree walk for `findMatches`. N is total snapshot-tree
    /// node count. The wrapper-suppression pass is folded into the
    /// walk via the ancestor stack, so it does not add an extra
    /// O(N²) post-pass.
    func findElements(_ selector: ElementSelector, parentId: String? = nil) throws -> [ElementInfo] {
        let resolvedSnapshot = try takeSnapshot()
        return try findElements(selector, fromSnapshot: resolvedSnapshot)
    }

    /// Find all elements from a pre-taken snapshot (avoids an extra IPC).
    func findElements(_ selector: ElementSelector, fromSnapshot resolvedSnapshot: XCUIElementSnapshot) throws -> [ElementInfo] {
        var snapshotDict = matchableDict(of: resolvedSnapshot)
        return try findElements(selector, in: &snapshotDict, register: true)
    }

    /// Evaluate several selectors against one snapshot (PILOT-848), by the
    /// same match walk as `findElements`, so locator suggestions and match
    /// counts are decided by the rules tests run with.
    ///
    /// - One snapshot and one dictionary conversion for the whole batch:
    ///   the counts are consistent with each other.
    /// - Never waits, and never registers a match (no element id, no cache
    ///   entry, no live query), so evaluating a screen's worth of candidates
    ///   can't evict the handles of a test running on the same agent.
    /// - A selector that fails (an invalid RegExp) fails only its own entry.
    func evaluateSelectors(_ selectors: [ElementSelector]) throws -> [Result<[ElementInfo], Error>] {
        let snapshot = try takeSnapshot()
        var snapshotDict = matchableDict(of: snapshot)
        return selectors.map { selector in
            Result { try findElements(selector, in: &snapshotDict, register: false) }
        }
    }

    /// The snapshot as the string-keyed dictionary the match walk reads,
    /// with accessibility traits annotated and unloaded table rows' contents
    /// placed at their rows (`CellFrames`).
    private func matchableDict(of snapshot: XCUIElementSnapshot) -> [String: Any] {
        var snapshotDict = convertKeys(snapshot.dictionaryRepresentation)
        Self.annotateTraits(dict: &snapshotDict, snapshot: snapshot)
        // After annotateTraits, which pairs nodes by their snapshot frames:
        // an unloaded table row's contents report a placeholder frame on
        // screen (PILOT-800).
        CellFrames.placeDetachedNodes(in: &snapshotDict)
        return snapshotDict
    }

    /// The match walk over a converted snapshot. With `register`, each match
    /// gets an element id, cache entries and a lazily built live query for
    /// later actions; without it (evaluating), matches are only described
    /// and `snapshotDict` is left as it was.
    private func findElements(
        _ selector: ElementSelector,
        in snapshotDict: inout [String: Any],
        register: Bool
    ) throws -> [ElementInfo] {
        if let regexError = selector.regexError {
            throw AgentError.invalidSelector(regexError)
        }

        // Check once if keyboard is visible (for focus detection).
        // Keyboard = elementType 19 (XCUIElement.ElementType.keyboard).
        let keyboardVisibleInSnapshot = hasKeyboardInTree(snapshotDict)

        // Number the app's descendants in pre-order (XCUIElementQuery order)
        // so a role+name, RegExp or substring-text match can be re-resolved
        // by its index within the live query that finds it again
        // (cacheQueryElement, PILOT-549, PILOT-520, PILOT-522).
        // Whether the tree holds a SwiftUI Toggle's knob, which a live switch
        // query returns out of tree order (cacheQueryElement).
        let treeHasSwitchPart = register && selector.roleOnlySwitch
            && SnapshotElementFinder.containsSwitchPart(snapshotDict, insideSwitch: false)
        var queryNodes: [QueryNode] = []
        if register && (selector.reResolvesByLabel || selector.roleOnlyReResolvesByLabel
            || selector.roleOnlySwitch) {
            SnapshotElementFinder.numberDescendants(of: &snapshotDict, into: &queryNodes)
        }
        var liveFocusedTextInputFetched = false
        var cachedLiveFocusedTextInput: LiveFocusedTextInput?
        let liveFocusedTextInput = { [weak self] () -> LiveFocusedTextInput? in
            guard keyboardVisibleInSnapshot, let self else { return nil }
            if !liveFocusedTextInputFetched {
                cachedLiveFocusedTextInput = self.findLiveFocusedTextInput()
                liveFocusedTextInputFetched = true
            }
            return cachedLiveFocusedTextInput
        }
        let focusedHint = keyboardVisibleInSnapshot ? currentFocusedTextInputHint() : nil

        // Flatten and search (pre-order — `.first()` callers depend on it).
        // Wrapper suppression happens inline via an ancestor stack so the
        // whole walk is O(N + wrapperMatches) rather than O(matches²).
        var matches: [([String: Any], CGRect)] = []
        var matchedAncestors: [WrapperAncestor] = []
        var suppressed = Set<Int>()
        var keyboardMatches: [UInt] = []
        var keyboardTop: CGFloat?
        findMatches(
            in: snapshotDict,
            inTabBar: false,
            containerLabel: "",
            selector: selector,
            results: &matches,
            matchedAncestors: &matchedAncestors,
            suppressed: &suppressed,
            keyboardMatches: &keyboardMatches,
            keyboardTop: &keyboardTop,
            keyboardVisibleInSnapshot: keyboardVisibleInSnapshot,
            liveFocusedTextInput: liveFocusedTextInput,
            focusedHint: focusedHint
        )
        if !suppressed.isEmpty {
            matches = matches.enumerated()
                .compactMap { (i, m) in suppressed.contains(i) ? nil : m }
        }

        let screenSize = self.screenSize

        // For each match, its index AMONG matches sharing the same identifier
        // (document order). Used to resolve same-identifier elements positionally
        // — `firstMatch` would ignore the position when an id isn't unique.
        var idSeen: [String: Int] = [:]
        let idIndices: [Int] = matches.map { (nodeDict, _) in
            let id = nodeDict["identifier"] as? String ?? ""
            let n = idSeen[id, default: 0]
            idSeen[id] = n + 1
            return n
        }
        // A label-less getByText match (substring or exact) is re-resolved by
        // the selector's own query: which numbered nodes that query returns,
        // computed once and only when such a match exists.
        var substringMatched: [Bool]?
        let hasLabelLessMatch = matches.contains(where: { (nodeDict, _) in
            guard let ordinal = nodeDict[SnapshotElementFinder.ordinalKey] as? Int,
                  ordinal < queryNodes.count else { return false }
            return queryNodes[ordinal].label.isEmpty
        })
        if hasLabelLessMatch, let textContains = selector.textContains {
            substringMatched = QueryIndex.substringMatches(in: queryNodes, query: textContains)
        } else if hasLabelLessMatch, let text = selector.text {
            substringMatched = QueryIndex.exactMatches(in: queryNodes, query: text)
        }
        // Each role+name match's index within the live query that
        // cacheQueryElement re-resolves it with (nil: no numbered node).
        let labelIndices: [Int?] = matches.map { (nodeDict, _) in
            guard let ordinal = nodeDict[SnapshotElementFinder.ordinalKey] as? Int,
                  ordinal < queryNodes.count else { return nil }
            let raw = queryNodes[ordinal].typeRaw
            let type = XCUIElement.ElementType(rawValue: raw)
            let specific = type != nil && type != .other && type != .any
            // A getByText match with no label is found again by the
            // selector's own query (cacheQueryElement), so index it there.
            if let substringMatched, queryNodes[ordinal].label.isEmpty {
                // Matched in a way that query can't return (a joined title
                // child): no index, no live element.
                guard substringMatched[ordinal] else { return nil }
                return QueryIndex.substringLiveIndex(
                    of: ordinal, in: queryNodes, scopeTypeRaw: specific ? raw : nil, matched: substringMatched
                )
            }
            // A role+name match named by its placeholder (RoleName) is found
            // again by that placeholder, so index it there.
            if selector.role != nil, selector.hasNameFilter, let type,
               SnapshotElementFinder.placeholderNamed(queryNodes[ordinal], type: type) {
                return QueryIndex.placeholderLiveIndex(of: ordinal, in: queryNodes, scopeTypeRaw: specific ? raw : nil)
            }
            return QueryIndex.liveIndex(of: ordinal, in: queryNodes, scopeTypeRaw: specific ? raw : nil)
        }

        let results = matches.enumerated().map { (matchIndex, match) in
            let (nodeDict, frame) = match
            let bounds = ElementBounds(
                left: Int(frame.origin.x),
                top: Int(frame.origin.y),
                right: Int(frame.origin.x + frame.width),
                bottom: Int(frame.origin.y + frame.height)
            )

            let elementId = register ? UUID().uuidString : ""
            let label = nodeDict["label"] as? String ?? ""
            let title = nodeDict["title"] as? String ?? ""
            let identifier = nodeDict["identifier"] as? String ?? ""
            let elTypeRaw = nodeDict["elementType"] as? UInt ?? 0
            let elType = XCUIElement.ElementType(rawValue: elTypeRaw) ?? .other
            let className = RoleMapping.typeName(for: elType)
            // XCTest's snapshot dictionaryRepresentation doesn't always include
            // accessibility traits. Try several keys and fall back to 0. Traits
            // are needed for React Native roles like "header" that map to a
            // trait bit rather than a dedicated element type.
            let traits = SnapshotElementFinder.extractTraits(from: nodeDict)
            let inTabBar = nodeDict[SnapshotElementFinder.inTabBarKey] as? Bool ?? false
            let role = RoleMapping.resolveRole(for: elType, traits: traits, inTabBar: inTabBar)
            let isEnabled = nodeDict["enabled"] as? Bool ?? true
            let value = nodeDict["value"] as? String
            let isSelected = nodeDict["selected"] as? Bool ?? false
            let isChecked = checkedState(
                for: elType,
                value: value,
                selected: isSelected
            )
            if register {
                // Cache the snapshot bounds for fast coordinate-based actions.
                lock.lock()
                boundsCache[elementId] = frame
                identityCache[elementId] = CachedIdentity(
                    elementType: elType, label: label, identifier: identifier, inTabBar: inTabBar,
                    holdsSwitchPart: NonAppElements.isSwitch(elType) && Self.holdsSwitch(nodeDict)
                )
                // Every minted id takes part in eviction, with or without a live
                // query — ids that get none (placeholder, className, …) would
                // otherwise stay in the bounds and identity caches for the whole
                // session.
                cacheOrder.append(elementId)
                lock.unlock()

                // Lazily build an XCUIElement query for actions that need it (typeText, etc.).
                // This is deferred — the query object is created but not evaluated until
                // a property (like .isHittable) is accessed. Pass the snapshot node so the
                // query can use element type + identifier for more precise matching.
                cacheQueryElement(elementId: elementId, selector: selector, matchIndex: matchIndex, idIndex: idIndices[matchIndex],
                    labelIndex: labelIndices[matchIndex], snapshotNode: nodeDict,
                    treeHasSwitchPart: treeHasSwitchPart
                )
            }
            // The snapshot's hasFocus is unreliable on Xcode 26 — it can
            // report false even when the text input is the first responder.
            // Use the snapshot when it reports true; otherwise fall back to
            // the one live text input whose hasFocus is true.
            let resolvedFocus = resolvedSnapshotFocus(
                nodeDict,
                elementType: elType,
                keyboardVisibleInSnapshot: keyboardVisibleInSnapshot,
                liveFocusedTextInput: liveFocusedTextInput,
                focusedHint: focusedHint
            )

            // For text fields, prefer the "value" property (typed text) over "label"
            // (accessibility label). React Native TextInput has label="Email" and
            // value="test@example.com" — we want the value for toHaveText assertions.
            // After clear() the value is empty; falling back to label/title would
            // surface the field name (e.g. "Email") and break toBeEmpty().
            let placeholderValue = nodeDict["placeholderValue"] as? String
            let displayText: String?
            if isTextFieldType(elType) {
                let v = value ?? ""
                // Empty textfields sometimes surface their placeholder as
                // `value` (older iOS, certain RN TextInput configs). Strip
                // that so toBeEmpty()/toHaveValue("") behave the same way
                // they do on Android (where isShowingHintText covers this).
                //
                // KNOWN TRADE-OFF: a user who literally typed the
                // placeholder string and then queried `toHaveValue` against
                // that exact value will see the value mis-reported as
                // empty. iOS doesn't expose `isShowingPlaceholder` in
                // XCUIElementSnapshot, so we can't distinguish. Mirrors the
                // Android API < 26 limitation called out in
                // docs/api-reference.md.
                if v.isEmpty || v == placeholderValue {
                    displayText = nil
                } else {
                    displayText = v
                }
            } else if let value = value, !value.isEmpty {
                displayText = value
            } else if !title.isEmpty {
                displayText = title
            } else if !label.isEmpty {
                displayText = label
            } else if elType == .other {
                // Wrapping containers (e.g. RN `<View accessibilityRole="alert">`)
                // carry their visible text in descendant nodes. Aggregate so
                // assertions like toContainText see the visible string.
                // Restricted to `.other` so we don't change behavior for typed
                // elements that legitimately have no label (e.g. an empty
                // ScrollView that wraps content).
                let descendant = SnapshotElementFinder.collectDescendantText(nodeDict)
                displayText = descendant.isEmpty ? nil : descendant
            } else {
                displayText = nil
            }

            let viewportRatio = computeViewportRatio(bounds, screenSize: screenSize)

            return ElementInfo(
                elementId: elementId,
                className: className,
                text: displayText,
                contentDescription: label.isEmpty ? (title.isEmpty ? nil : title) : label,
                resourceId: identifier.isEmpty ? nil : identifier,
                hint: (placeholderValue?.isEmpty == false) ? placeholderValue : nil,
                bounds: bounds,
                isEnabled: isEnabled,
                isChecked: isChecked,
                isFocused: resolvedFocus,
                isClickable: frame.width > 0 && frame.height > 0,
                isFocusable: true,
                isScrollable: elType == .scrollView || elType == .table || elType == .collectionView,
                isVisible: viewportRatio > 0,
                isSelected: isSelected,
                childCount: (nodeDict["children"] as? [[String: Any]])?.count ?? 0,
                role: role,
                viewportRatio: viewportRatio
            )
        }

        // Evict stale entries if caches have grown too large — but never ids
        // from the batch we are about to return, or a large match set would
        // evict its own first elements before the SDK can act on them
        // (`.first()` acts on the oldest-appended id of the batch).
        guard register else { return results }
        let currentBatch = Set(results.map { $0.elementId })
        lock.lock()
        pruneCacheLocked(protecting: currentBatch)
        lock.unlock()

        return results
    }

    /// Take a validated snapshot with retries for cold-start.
    func takeSnapshot() throws -> XCUIElementSnapshot {
        var lastError: Error?
        for _ in 0..<5 {
            do {
                let s = try app.snapshot()
                if !s.dictionaryRepresentation.isEmpty {
                    return s
                }
            } catch {
                lastError = error
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        let msg = lastError.map { "Snapshot failed after retries: \($0)" }
            ?? "Snapshot returned empty tree after retries"
        NSLog("[TapsmithSnapshot] \(msg)")
        throw AgentError.elementNotFound(msg)
    }

    /// Clear all caches (call after app relaunch).
    func clearCaches() {
        lock.lock()
        elementCache.removeAll()
        boundsCache.removeAll()
        identityCache.removeAll()
        cacheOrder.removeAll()
        focusedTextInputHint = nil
        lock.unlock()
    }

    func recordFocusedTextInputHint(_ element: ElementInfo) {
        let frame = CGRect(
            x: CGFloat(element.bounds.left),
            y: CGFloat(element.bounds.top),
            width: CGFloat(element.bounds.width),
            height: CGFloat(element.bounds.height)
        )
        let point = CGPoint(x: CGFloat(element.bounds.centerX), y: CGFloat(element.bounds.centerY))
        lock.lock()
        focusedTextInputHint = FocusedTextInputHint(
            identifier: element.resourceId ?? "",
            label: element.contentDescription ?? "",
            frame: frame,
            point: point
        )
        lock.unlock()
    }

    func recordFocusedTextInputHint(at point: CGPoint) {
        lock.lock()
        focusedTextInputHint = FocusedTextInputHint(
            identifier: "",
            label: "",
            frame: .zero,
            point: point
        )
        lock.unlock()
    }

    func clearFocusedTextInputHint() {
        lock.lock()
        focusedTextInputHint = nil
        lock.unlock()
    }

    /// Evict oldest entries when the cache exceeds `maxCacheSize`, skipping
    /// any ids in `protected` (a batch just returned to the caller).
    /// Must be called while `lock` is held.
    private func pruneCacheLocked(protecting protected: Set<String> = []) {
        var overflow = cacheOrder.count - maxCacheSize
        guard overflow > 0 else { return }
        var index = 0
        while overflow > 0 && index < cacheOrder.count {
            let candidate = cacheOrder[index]
            if protected.contains(candidate) {
                index += 1
                continue
            }
            cacheOrder.remove(at: index)
            elementCache.removeValue(forKey: candidate)
            boundsCache.removeValue(forKey: candidate)
            identityCache.removeValue(forKey: candidate)
            overflow -= 1
        }
    }

    /// Must be called while `lock` is held.
    private func touchLocked(_ elementId: String) {
        promoteToMostRecentlyUsed(&cacheOrder, elementId)
    }

    /// Get a cached XCUIElement by its stable ID (for actions like tap).
    func getElement(_ elementId: String) throws -> XCUIElement {
        lock.lock()
        let cached = elementCache[elementId]
        if cached != nil {
            touchLocked(elementId)
        }
        lock.unlock()

        if let elem = cached {
            return elem
        }
        lock.lock()
        let cacheSize = elementCache.count
        let boundsSize = boundsCache.count
        lock.unlock()
        NSLog("[TapsmithSnapshot] getElement miss for \(elementId) (elementCache=\(cacheSize), boundsCache=\(boundsSize))")
        throw AgentError.elementNotFound("Element '\(elementId)' not found. It may have gone stale.")
    }

    /// Get cached snapshot bounds for an element (for coordinate-based actions).
    ///
    /// **Cost:** O(1) dictionary lookup, no IPC. Bounds were captured
    /// during the original `findElements` snapshot walk and frozen at
    /// that time — do NOT use this for "is the element still on
    /// screen?" checks, take a fresh snapshot for that.
    func getBounds(_ elementId: String) -> CGRect? {
        lock.lock()
        let bounds = boundsCache[elementId]
        if bounds != nil {
            touchLocked(elementId)
        }
        lock.unlock()
        return bounds
    }

    /// The find-time type/label/identifier of a cached element (no IPC).
    func getIdentity(_ elementId: String) -> CachedIdentity? {
        lock.lock()
        defer { lock.unlock() }
        return identityCache[elementId]
    }

    /// Get the ElementInfo for a cached element.
    ///
    /// **Cost:** several live `XCUIElement` property reads (label,
    /// identifier, value, isEnabled, hasFocus, isSelected, frame),
    /// each one an IPC. Order of magnitude ~6–10 IPC per call.
    /// Strictly more expensive than re-running `findElement` for a
    /// fresh snapshot if you need >1 attribute read; only useful when
    /// the snapshot is known stale and you have an elementId you want
    /// to re-resolve.
    func getElementInfo(_ elementId: String) throws -> ElementInfo {
        let elem = try getElement(elementId)
        return toElementInfo(elem, elementId: elementId)
    }

    /// Cache `element`, the part of the element `info` describes that an
    /// action is delivered to in its place — a SwiftUI Toggle's knob
    /// (NonAppElements.isSwitchPart, PILOT-790) — at `frame`. It reports the
    /// whole element's state, so nothing more is read from the device.
    func cachePart(
        _ element: XCUIElement, of info: ElementInfo, frame: CGRect, elementType: XCUIElement.ElementType
    ) -> ElementInfo {
        let elementId = UUID().uuidString
        let bounds = ElementBounds(
            left: Int(frame.origin.x), top: Int(frame.origin.y),
            right: Int(frame.origin.x + frame.width), bottom: Int(frame.origin.y + frame.height)
        )
        lock.lock()
        elementCache[elementId] = element
        boundsCache[elementId] = frame
        identityCache[elementId] = CachedIdentity(elementType: elementType, label: "", identifier: "", inTabBar: false)
        cacheOrder.append(elementId)
        pruneCacheLocked()
        lock.unlock()
        return ElementInfo(
            elementId: elementId,
            className: info.className,
            text: info.text,
            contentDescription: info.contentDescription,
            resourceId: info.resourceId,
            hint: info.hint,
            bounds: bounds,
            isEnabled: info.isEnabled,
            isChecked: info.isChecked,
            isFocused: info.isFocused,
            isClickable: info.isClickable,
            isFocusable: info.isFocusable,
            isScrollable: info.isScrollable,
            isVisible: info.isVisible,
            isSelected: info.isSelected,
            childCount: 0,
            role: info.role,
            viewportRatio: computeViewportRatio(bounds, screenSize: screenSize)
        )
    }

    /// Cache an XCUIElement and return its ElementInfo.
    func cacheElement(_ element: XCUIElement) -> ElementInfo {
        let elementId = UUID().uuidString
        lock.lock()
        elementCache[elementId] = element
        cacheOrder.append(elementId)
        pruneCacheLocked()
        lock.unlock()
        return toElementInfo(element, elementId: elementId)
    }

    // MARK: - Concatenated label matching

    /// Check if `childText` appears as a child's text within an iOS auto-concatenated label.
    ///
    /// iOS joins child text with ", " to form the parent's label. For example:
    ///   children ["Login Form", "Text inputs, buttons"] → "Login Form, Text inputs, buttons"
    ///
    /// We check if the label starts with `childText + ", "` (first child),
    /// ends with `", " + childText` (last child), or equals it (only child).
    /// This avoids false positives from arbitrary substring matching.
    private func containsChildText(_ label: String, childText: String) -> Bool {
        if label == childText { return true }
        if label.hasPrefix(childText + ", ") { return true }
        if label.hasSuffix(", " + childText) { return true }
        if label.contains(", " + childText + ", ") { return true }
        return false
    }

    /// Check if a keyboard is present in the snapshot tree.
    private func hasKeyboardInTree(_ node: [String: Any]) -> Bool {
        let elTypeRaw = parseUInt(node["elementType"]) ?? 0
        if elTypeRaw == XCUIElement.ElementType.keyboard.rawValue { return true }
        guard let children = node["children"] as? [[String: Any]] else { return false }
        for child in children {
            if hasKeyboardInTree(child) { return true }
        }
        return false
    }

    /// Check if an element type is a text input that can receive keyboard focus.
    private func isTextFieldType(_ elType: XCUIElement.ElementType) -> Bool {
        elType == .textField || elType == .secureTextField
            || elType == .textView || elType == .searchField
    }

    /// Frame of the text input that has keyboard focus right now, from a
    /// live query, or nil when none does. Unlike an element's `isFocused`,
    /// this cannot come from a stale focus hint. It queries
    /// `hasKeyboardFocus`: on iOS 26 a `hasFocus == true` query (what
    /// `findLiveFocusedTextInput` uses) matches nothing even while a field is
    /// first responder, measured 23 Sep 2026.
    func liveFocusedTextInputFrame() -> CGRect? {
        liveFocusedTextInput()?.frame
    }

    /// Type and frame of the text input that has keyboard focus right now,
    /// from the same live query as `liveFocusedTextInputFrame`.
    func liveFocusedTextInput() -> (elementType: XCUIElement.ElementType, frame: CGRect)? {
        let textInputTypes: Set<XCUIElement.ElementType> = [
            .textField, .secureTextField, .textView, .searchField,
        ]
        let element = app.descendants(matching: .any)
            .matching(NSPredicate(format: "hasKeyboardFocus == true"))
            .firstMatch
        guard element.exists else { return nil }
        let type = element.elementType
        guard textInputTypes.contains(type) else { return nil }
        return (type, element.frame)
    }

    /// The text input that has keyboard focus right now, as the typing
    /// focus check compares it (PILOT-829), from the same live query as
    /// `liveFocusedTextInputFrame`. One snapshot of the match reads every
    /// attribute at once; `exists` first, because a snapshot of no match
    /// fails only after XCUITest's wait for one (seconds per call).
    func liveFocusedTypingInput() -> TypingFocus.Input? {
        let element = app.descendants(matching: .any)
            .matching(NSPredicate(format: "hasKeyboardFocus == true"))
            .firstMatch
        guard element.exists, let snap = try? element.snapshot() else { return nil }
        let classNames: [XCUIElement.ElementType: String] = [
            .textField: "XCUIElementTypeTextField",
            .secureTextField: "XCUIElementTypeSecureTextField",
            .textView: "XCUIElementTypeTextView",
            .searchField: "XCUIElementTypeSearchField",
        ]
        guard let className = classNames[snap.elementType] else { return nil }
        return TypingFocus.Input(
            frame: snap.frame,
            className: className,
            identifier: snap.identifier,
            placeholder: snap.placeholderValue ?? ""
        )
    }

    private func findLiveFocusedTextInput() -> LiveFocusedTextInput? {
        let textInputTypes: Set<XCUIElement.ElementType> = [
            .textField, .secureTextField, .textView, .searchField,
        ]
        let element = app.descendants(matching: .any)
            .matching(NSPredicate(format: "hasFocus == true"))
            .firstMatch
        guard element.exists else { return nil }

        let type = element.elementType
        guard textInputTypes.contains(type) else { return nil }

        return LiveFocusedTextInput(
            elementType: type,
            identifier: element.identifier,
            label: element.label,
            frame: element.frame
        )
    }

    private func currentFocusedTextInputHint() -> FocusedTextInputHint? {
        lock.lock()
        let hint = focusedTextInputHint
        lock.unlock()
        return hint
    }

    private func resolvedSnapshotFocus(
        _ node: [String: Any],
        elementType: XCUIElement.ElementType,
        keyboardVisibleInSnapshot: Bool,
        liveFocusedTextInput: () -> LiveFocusedTextInput?,
        focusedHint: FocusedTextInputHint?
    ) -> Bool {
        let snapshotFocused = (node["hasFocus"] as? Bool)
            ?? (node["hasKeyboardFocus"] as? Bool)
        if snapshotFocused == true { return true }
        guard keyboardVisibleInSnapshot, isTextFieldType(elementType) else { return false }
        if matchesFocusedTextInputHint(
                node,
                elementType: elementType,
                focusedHint: focusedHint
           ) {
            return true
        }
        return matchesLiveFocusedTextInput(
            node,
            elementType: elementType,
            liveFocusedTextInput: liveFocusedTextInput()
        )
    }

    private func matchesLiveFocusedTextInput(
        _ node: [String: Any],
        elementType: XCUIElement.ElementType,
        liveFocusedTextInput: LiveFocusedTextInput?
    ) -> Bool {
        guard let live = liveFocusedTextInput else { return false }
        guard isTextFieldType(elementType), elementType == live.elementType else { return false }

        let identifier = node["identifier"] as? String ?? ""
        let label = node["label"] as? String ?? ""
        let title = node["title"] as? String ?? ""
        let frame = parseFrame(node)

        if !identifier.isEmpty || !live.identifier.isEmpty {
            guard identifier == live.identifier else { return false }
            if framesApproximatelyEqual(frame, live.frame) { return true }
            return !live.label.isEmpty && (label == live.label || title == live.label)
        }

        guard framesApproximatelyEqual(frame, live.frame) else { return false }
        return live.label.isEmpty || label == live.label || title == live.label
    }

    private func matchesFocusedTextInputHint(
        _ node: [String: Any],
        elementType: XCUIElement.ElementType,
        focusedHint: FocusedTextInputHint?
    ) -> Bool {
        guard let hint = focusedHint else { return false }
        guard isTextFieldType(elementType) else { return false }

        let frame = parseFrame(node)
        if let point = hint.point,
           frame.insetBy(dx: -2, dy: -2).contains(point) {
            return true
        }

        let identifier = node["identifier"] as? String ?? ""
        let label = node["label"] as? String ?? ""
        let title = node["title"] as? String ?? ""

        if !hint.identifier.isEmpty || !identifier.isEmpty {
            guard identifier == hint.identifier else { return false }
            return framesApproximatelyEqual(frame, hint.frame)
                || (!hint.label.isEmpty && (label == hint.label || title == hint.label))
        }

        guard framesApproximatelyEqual(frame, hint.frame) else { return false }
        return hint.label.isEmpty || label == hint.label || title == hint.label
    }

    private func framesApproximatelyEqual(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        let tolerance: CGFloat = 1
        return abs(lhs.origin.x - rhs.origin.x) <= tolerance
            && abs(lhs.origin.y - rhs.origin.y) <= tolerance
            && abs(lhs.width - rhs.width) <= tolerance
            && abs(lhs.height - rhs.height) <= tolerance
    }

    private static let kvcMissLogger = OneShotLogger()
    private static let childMismatchLogger = OneShotLogger()

    private static func logKvcMissOnce() {
        kvcMissLogger.log(
            "[TapsmithSnapshot] KVC `traits` returned nil on a non-empty snapshot. " +
                "Trait-derived roles (heading/searchfield/link via traits) will not resolve. " +
                "Likely cause: Xcode renamed/restricted the XCElementSnapshot.traits property."
        )
    }

    /// Read the UIAccessibilityTraits bitmask out of an annotated snapshot
    /// dictionary. `annotateTraits()` splices the value in via KVC on the
    /// underlying XCElementSnapshot, so we only need to read the canonical
    /// key here.
    static func extractTraits(from node: [String: Any]) -> UInt64 {
        guard let raw = node["traits"] else { return 0 }
        switch raw {
        case let v as UInt64: return v
        case let v as UInt: return UInt64(v)
        case let v as Int:
            // Reinterpret the bit pattern instead of doing `UInt64(v)` —
            // the latter traps when `v` is negative. `Int` is 64-bit on
            // every Apple platform we ship to, so when ObjC hands us a
            // trait value with bit 63 set (a private/future Apple trait
            // beyond the documented 0..<21 range, or a misencoded value),
            // bridging surfaces it as a negative `Int`. Preserving the
            // raw bits keeps the high-order flags intact instead of
            // crashing the agent on an unexpected snapshot.
            return UInt64(bitPattern: Int64(v))
        case let v as NSNumber: return v.uint64Value
        default: return 0
        }
    }

    /// Splice accessibility trait bits back onto each node of the converted
    /// snapshot dict. dictionaryRepresentation on Xcode 26 omits traits, but
    /// the underlying XCElementSnapshot exposes them via KVC. Walking the
    /// snapshot tree in parallel with the dict lets us annotate every node.
    ///
    /// Children are matched by stable attributes (identifier first, then
    /// elementType + frame) rather than positional index, because
    /// dictionaryRepresentation can filter or reorder children differently
    /// from `snapshot.children` (e.g. empty cells, accessibility-hidden
    /// nodes). Positional alignment would silently mis-attribute traits to
    /// the wrong nodes whenever the two sequences diverge.
    ///
    /// Cost: O(N) KVC lookups per snapshot — each `value(forKey: "traits")`
    /// crosses the Swift↔ObjC bridge. For typical screens (a few hundred
    /// nodes) this is negligible; for pathologically deep hierarchies it
    /// could become noticeable. KVC has no Method-cache equivalent in Swift,
    /// so the cost is intrinsic until iOS exposes traits in
    /// dictionaryRepresentation directly.
    /// Key under which numberDescendants stores a node's pre-order ordinal.
    static let ordinalKey = "tapsmithQueryOrdinal"

    /// Whether a numbered node is named by its placeholder (RoleName, PILOT-834).
    static func placeholderNamed(_ node: QueryNode, type: XCUIElement.ElementType) -> Bool {
        RoleName.placeholderName(
            elementType: type, label: node.label, title: node.title, placeholder: node.placeholder
        ) != nil
    }

    /// Whether `node` or a descendant is part of a switch
    /// (NonAppElements.isSwitchPart); `insideSwitch`: whether `node` has a
    /// switch ancestor.
    static func containsSwitchPart(_ node: [String: Any], insideSwitch: Bool) -> Bool {
        let type = XCUIElement.ElementType(rawValue: parseUInt(node["elementType"]) ?? 0) ?? .other
        if NonAppElements.isSwitchPart(elementType: type, insideSwitch: insideSwitch) { return true }
        let childInsideSwitch = insideSwitch || NonAppElements.isSwitch(type)
        return (node["children"] as? [[String: Any]] ?? []).contains {
            containsSwitchPart($0, insideSwitch: childInsideSwitch)
        }
    }

    /// Whether a descendant of `node` is a switch: the knob of a SwiftUI
    /// Toggle when `node` is itself one (NonAppElements.isSwitchPart).
    static func holdsSwitch(_ node: [String: Any]) -> Bool {
        for child in node["children"] as? [[String: Any]] ?? [] {
            let type = XCUIElement.ElementType(rawValue: parseUInt(child["elementType"]) ?? 0) ?? .other
            if NonAppElements.isSwitch(type) || holdsSwitch(child) { return true }
        }
        return false
    }

    /// Number every descendant of `dict` (not `dict` itself — XCUIElement
    /// `descendants` queries exclude the root) in pre-order, storing the
    /// ordinal under `ordinalKey` and the node's query fields in `nodes`.
    static func numberDescendants(of dict: inout [String: Any], into nodes: inout [QueryNode]) {
        guard var children = dict["children"] as? [[String: Any]] else { return }
        for i in children.indices {
            children[i][ordinalKey] = nodes.count
            nodes.append(QueryNode(
                typeRaw: parseUInt(children[i]["elementType"]) ?? 0,
                label: children[i]["label"] as? String ?? "",
                identifier: children[i]["identifier"] as? String ?? "",
                title: children[i]["title"] as? String ?? "",
                value: children[i]["value"] as? String ?? "",
                placeholder: children[i]["placeholderValue"] as? String ?? ""
            ))
            numberDescendants(of: &children[i], into: &nodes)
        }
        dict["children"] = children
    }

    static func annotateTraits(dict: inout [String: Any], snapshot: XCUIElementSnapshot) {
        // Bare `value(forKey:)` on an NSObject that doesn't have the key
        // throws an Objective-C NSUnknownKeyException, which is *not*
        // catchable from Swift and crashes the agent. Check
        // `responds(to:)` first; if the property went away on a future
        // Xcode, fall through cleanly and log once instead of crashing.
        let raw: Any?
        if let nsSnap = snapshot as? NSObject,
           nsSnap.responds(to: NSSelectorFromString("traits")) {
            raw = nsSnap.value(forKey: "traits")
        } else {
            raw = nil
        }
        let traits: UInt64 = {
            if let v = raw as? UInt64 { return v }
            if let v = raw as? NSNumber { return v.uint64Value }
            return 0
        }()
        if traits != 0 {
            dict["traits"] = traits
        } else if raw == nil && !kvcMissLogger.hasFired {
            // KVC returned nil (or the property was missing entirely) —
            // Xcode may have renamed or restricted the private property.
            // All trait-derived role detection silently degrades to 0, so
            // log the first occurrence loudly. Skip the `.children`
            // access (which is itself an IPC) once we've already logged
            // — the per-snapshot probe was burning O(N) IPC calls for a
            // log line we'd already emitted.
            if !snapshot.children.isEmpty {
                logKvcMissOnce()
            }
        }
        guard var children = dict["children"] as? [[String: Any]] else { return }
        let snapChildren = snapshot.children
        if children.count != snapChildren.count {
            // Route through the same one-shot logger as the KVC-miss
            // warning so we don't spam the log per snapshot. The
            // mismatch is non-fatal (we still match what we can by
            // stable key) but worth a single visible note.
            childMismatchLogger.log(
                "[TapsmithSnapshot] annotateTraits child count differs between dict and snapshot " +
                    "(dict=\(children.count) snapshot=\(snapChildren.count)). " +
                    "Trait data for unmatched nodes will not be spliced in."
            )
        }
        // Build a quick index of snapshot children keyed by (identifier,
        // elementType, full frame). Multiple children can share the same
        // key (anonymous siblings with identical bounds); track which
        // slots are still unclaimed. Including width/height in the key
        // (rather than origin only) reduces collisions when RN mounts
        // sibling hidden-a11y views that start at the same origin but
        // differ in size.
        //
        // Tie-break invariant: when two snapshot children share a key,
        // we pop slots in first-found order. This is only safe because
        // identical (identifier, type, frame) siblings produce identical
        // accessibility traits in practice — they're either both
        // hidden-a11y wrappers or both null-identifier `.other`
        // containers. Splicing the wrong one's traits onto the other
        // is therefore a no-op. If a future change makes traits depend
        // on something *other* than these key components (e.g. a
        // semantic element type that varies across siblings with
        // identical frames), this assumption breaks and the matching
        // needs a more discriminating key.
        struct ChildKey: Hashable {
            let identifier: String
            let elementType: UInt
            let originX: Int
            let originY: Int
            let width: Int
            let height: Int
        }
        // Round (rather than truncate) frame coords when keying. Sub-pixel
        // layouts (RN sometimes produces frames at e.g. y=12.333 vs 12.0)
        // would otherwise hash both into the same `Int(...)` slot
        // (Int truncates toward zero) and mis-attribute traits between
        // siblings. Rounding yields a stable Int boundary at the nearest
        // whole pixel, so two siblings only collide when they're truly
        // pixel-aligned at the same position.
        func keyOf(identifier: String, elementType: UInt, frame: CGRect) -> ChildKey {
            ChildKey(
                identifier: identifier,
                elementType: elementType,
                originX: Int(frame.origin.x.rounded()),
                originY: Int(frame.origin.y.rounded()),
                width: Int(frame.size.width.rounded()),
                height: Int(frame.size.height.rounded())
            )
        }
        var available: [ChildKey: (indices: [Int], nextSlot: Int)] = [:]
        for (idx, snap) in snapChildren.enumerated() {
            let key = keyOf(
                identifier: snap.identifier,
                elementType: UInt(snap.elementType.rawValue),
                frame: snap.frame
            )
            if var entry = available[key] {
                entry.indices.append(idx)
                available[key] = entry
            } else {
                available[key] = (indices: [idx], nextSlot: 0)
            }
        }
        for (i, child) in children.enumerated() {
            let frame = SnapshotElementFinder.parseFrame(child)
            let key = keyOf(
                identifier: child["identifier"] as? String ?? "",
                elementType: SnapshotElementFinder.parseUInt(child["elementType"]) ?? 0,
                frame: frame
            )
            guard var entry = available[key], entry.nextSlot < entry.indices.count else { continue }
            let snapIdx = entry.indices[entry.nextSlot]
            entry.nextSlot += 1
            available[key] = entry
            var mutableChild = child
            annotateTraits(dict: &mutableChild, snapshot: snapChildren[snapIdx])
            children[i] = mutableChild
        }
        dict["children"] = children
    }

    /// Maximum recursion depth for `collectDescendantText`. Mirrors
    /// Android's `MAX_DESCENDANT_TEXT_DEPTH` so both platforms bound
    /// worst-case aggregation cost identically.
    static let maxDescendantTextDepth = 6

    /// Walk a snapshot subtree and concatenate descendant labels/values so a
    /// wrapping container (e.g. RN `<View accessibilityRole="alert">`)
    /// reports its visible text content. Mirrors Android's
    /// `collectDescendantText`.
    ///
    /// Bounded by `maxDescendantTextDepth` so a misconfigured deeply
    /// nested match doesn't drag the snapshot walk into pathological
    /// behavior.
    static func collectDescendantText(_ node: [String: Any], depth: Int = 0) -> String {
        if depth >= maxDescendantTextDepth { return "" }
        var parts: [String] = []
        if let children = node["children"] as? [[String: Any]] {
            for child in children {
                // The hooks marker is no one's visible text (NonAppElements).
                if NonAppElements.isHooksMarker(
                    label: child["label"] as? String ?? "",
                    title: child["title"] as? String ?? "",
                    value: child["value"] as? String ?? ""
                ) { continue }
                let ownText: String?
                if let v = child["value"] as? String, !v.isEmpty {
                    ownText = v
                } else if let t = child["title"] as? String, !t.isEmpty {
                    ownText = t
                } else if let l = child["label"] as? String, !l.isEmpty {
                    ownText = l
                } else {
                    ownText = nil
                }
                if let own = ownText {
                    // Child labels its own visible content; iOS accessibility
                    // typically auto-concatenates descendant text into the
                    // parent label already, so recursing further would
                    // duplicate ("Hello Hello").
                    parts.append(own)
                } else {
                    let nested = collectDescendantText(child, depth: depth + 1)
                    if !nested.isEmpty { parts.append(nested) }
                }
            }
        }
        return parts.joined(separator: " ")
    }

    // MARK: - Key conversion

    /// Convert XCUIElement.AttributeName-keyed dicts to String-keyed dicts recursively.
    private func convertKeys(_ raw: [XCUIElement.AttributeName: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in raw {
            if let children = value as? [[XCUIElement.AttributeName: Any]] {
                result[key.rawValue] = children.map { convertKeys($0) }
            } else if let child = value as? [XCUIElement.AttributeName: Any] {
                result[key.rawValue] = convertKeys(child)
            } else {
                result[key.rawValue] = value
            }
        }
        return result
    }

    // MARK: - Snapshot parsing and matching

    /// A match on the path to the node `findMatches` is at, that a matching
    /// descendant can suppress: a generic `.other` wrapper whose identifier
    /// or label a real native descendant shadows, or any getByText match
    /// with a matching descendant (innermost, TextContent). Maintaining an
    /// ancestor stack keeps suppression linear in the match count, instead
    /// of the O(N²) post-pass the earlier implementation used.
    private struct WrapperAncestor {
        let identifier: String
        let label: String
        let elementType: XCUIElement.ElementType
        let frame: CGRect
        let resultIndex: Int
    }

    /// Key under which `findMatches` marks a matched node that has a
    /// `.tabBar` ancestor (RoleMapping.isTabBarItem, PILOT-514).
    static let inTabBarKey = "tapsmithInTabBar"

    /// Key under which `findMatches` records, on a match after the keyboard
    /// in tree order, the element types of the keyboard's nodes that match
    /// the selector: a live query re-resolving the match by position returns
    /// those of its own type (or all, unscoped) too.
    static let keyboardMatchesKey = "tapsmithKeyboardMatches"

    /// The element types of the nodes of the subtree at `nodeDict` (itself
    /// included) that match the selector, ignoring NonAppElements — the
    /// keyboard's, which the live queries see.
    private func matchingTypes(
        in nodeDict: [String: Any],
        containerLabel: String,
        selector: ElementSelector,
        keyboardVisibleInSnapshot: Bool,
        liveFocusedTextInput: () -> LiveFocusedTextInput?,
        focusedHint: FocusedTextInputHint?
    ) -> [UInt] {
        var types: [UInt] = []
        if matchesSelector(
            nodeDict,
            inTabBar: false,
            inAlert: false,
            containerLabel: containerLabel,
            selector: selector,
            keyboardVisibleInSnapshot: keyboardVisibleInSnapshot,
            liveFocusedTextInput: liveFocusedTextInput,
            focusedHint: focusedHint
        ) {
            types.append(parseUInt(nodeDict["elementType"]) ?? 0)
        }
        let ownLabel = nodeDict["label"] as? String ?? ""
        let childContainerLabel = ownLabel.isEmpty ? containerLabel : ownLabel
        for child in nodeDict["children"] as? [[String: Any]] ?? [] {
            types += matchingTypes(
                in: child,
                containerLabel: childContainerLabel,
                selector: selector,
                keyboardVisibleInSnapshot: keyboardVisibleInSnapshot,
                liveFocusedTextInput: liveFocusedTextInput,
                focusedHint: focusedHint
            )
        }
        return types
    }

    private func findMatches(
        in nodeDict: [String: Any],
        inTabBar: Bool,
        insideSwitch: Bool = false,
        inAlert: Bool = false,
        containerLabel: String,
        selector: ElementSelector,
        results: inout [([String: Any], CGRect)],
        matchedAncestors: inout [WrapperAncestor],
        suppressed: inout Set<Int>,
        keyboardMatches: inout [UInt],
        keyboardTop: inout CGFloat?,
        keyboardVisibleInSnapshot: Bool,
        liveFocusedTextInput: () -> LiveFocusedTextInput?,
        focusedHint: FocusedTextInputHint?
    ) {
        // Pre-order: parent first, then descendants. Callers (e.g.
        // `.first()`) rely on document/snapshot order, so we must NOT
        // reorder here. We use an ancestor stack to suppress RN-style
        // `.other` wrappers whose identifier/label matches a native
        // descendant in one linear pass.
        //
        // What isn't the app's never matches (NonAppElements): the keyboard
        // and everything in it, the application element itself, the hooks
        // marker. Only matching skips them — numberDescendants still counts
        // them, as the live queries that re-resolve a match see them too.
        let nodeType = XCUIElement.ElementType(rawValue: parseUInt(nodeDict["elementType"]) ?? 0) ?? .other
        if NonAppElements.excludesSubtree(
            elementType: nodeType,
            identifier: nodeDict["identifier"] as? String ?? "",
            frame: parseFrame(nodeDict),
            keyboardTop: keyboardTop
        ) {
            if nodeType == .keyboard { keyboardTop = parseFrame(nodeDict).minY }
            // Not matches, but counted: a live query re-resolving a later
            // match by its position sees the keyboard's nodes that match too.
            keyboardMatches += matchingTypes(
                in: nodeDict,
                containerLabel: containerLabel,
                selector: selector,
                keyboardVisibleInSnapshot: keyboardVisibleInSnapshot,
                liveFocusedTextInput: liveFocusedTextInput,
                focusedHint: focusedHint
            )
            return
        }
        let isAppNode = !NonAppElements.excludesNode(
            elementType: nodeType,
            label: nodeDict["label"] as? String ?? "",
            title: nodeDict["title"] as? String ?? "",
            value: nodeDict["value"] as? String ?? ""
        )
        // A SwiftUI Toggle's knob is part of the switch it sits in, not a
        // match of its own (NonAppElements.isSwitchPart, PILOT-790). A live
        // switch query still returns it, and not in tree order (after every
        // outer switch, measured on iOS 26), so a role-only switch match is
        // found again by its own label (cacheQueryElement).
        let isSwitchPart = NonAppElements.isSwitchPart(elementType: nodeType, insideSwitch: insideSwitch)
        var pushedAncestor = false
        if isAppNode, !isSwitchPart, matchesSelector(
            nodeDict,
            inTabBar: inTabBar,
            inAlert: inAlert,
            containerLabel: containerLabel,
            selector: selector,
            keyboardVisibleInSnapshot: keyboardVisibleInSnapshot,
            liveFocusedTextInput: liveFocusedTextInput,
            focusedHint: focusedHint
        ) {
            let myId = nodeDict["identifier"] as? String ?? ""
            let myLabel = nodeDict["label"] as? String ?? ""
            let raw = parseUInt(nodeDict["elementType"]) ?? 0
            let elType = XCUIElement.ElementType(rawValue: raw) ?? .other

            // If an in-scope `.other` ancestor shares our identifier (or
            // label when identifier is empty), mark it for suppression —
            // we're the "real" inner control. Gate on this node being
            // *non-`.other`* so a `.other` ancestor isn't suppressed by
            // another matching `.other` descendant: when both ends are
            // generic wrappers we can't tell which one the caller wants
            // and the safer default is to keep both. Today this only
            // matters in theory (RN/SwiftUI don't typically nest `.other`
            // wrappers with matching labels), but a future `alert` /
            // `dialog` role that lands on `.other` would otherwise lose
            // its outer container.
            //
            // getByText goes further, like Playwright's text engine: every
            // matching ancestor gives way to this match, whatever the types
            // (TextContent, PILOT-794) — a Toggle row, a NavigationLink or
            // an alert to the static text it holds.
            //
            // Except a same-target duplicate — one target iOS exposes twice,
            // with the same label and (whole-point) bounds, such as a static
            // text's attribute-carrying copy (PILOT-226) or a button and the
            // text filling it: the outer one carries the traits, state and
            // identifier, and the SDK's collapse keeps it
            // (collapseSameTargetDuplicates). A generic `.other` wrapper of a
            // native control still gives way to it, as above.
            let innermostOnly = selector.matchesInnermostOnly
            let myFrame = parseFrame(nodeDict)
            if innermostOnly {
                for anc in matchedAncestors
                where !(Self.sameTarget(anc.frame, myFrame) && TextMatch.equals(anc.label, myLabel)
                    && (anc.elementType != .other || elType == .other)) {
                    suppressed.insert(anc.resultIndex)
                }
            } else if elType != .other {
                for anc in matchedAncestors {
                    if !anc.identifier.isEmpty && anc.identifier == myId {
                        suppressed.insert(anc.resultIndex)
                    } else if anc.identifier.isEmpty && !anc.label.isEmpty && anc.label == myLabel {
                        suppressed.insert(anc.resultIndex)
                    }
                }
            }

            let frame = parseFrame(nodeDict)
            var matched = nodeDict
            if inTabBar { matched[SnapshotElementFinder.inTabBarKey] = true }
            if !keyboardMatches.isEmpty { matched[SnapshotElementFinder.keyboardMatchesKey] = keyboardMatches }
            results.append((matched, frame))
            let myIndex = results.count - 1

            // Push this node onto the ancestor stack if it's a generic
            // wrapper — any matching non-`.other` descendant will suppress
            // us — or a getByText match, which any matching descendant does.
            if elType == .other || innermostOnly {
                matchedAncestors.append(
                    WrapperAncestor(
                        identifier: myId, label: myLabel, elementType: elType, frame: myFrame, resultIndex: myIndex
                    )
                )
                pushedAncestor = true
            }
        }

        if let children = nodeDict["children"] as? [[String: Any]] {
            let childrenInTabBar = inTabBar
                || parseUInt(nodeDict["elementType"]) == XCUIElement.ElementType.tabBar.rawValue
            // A keyboard's top edge only applies within its own window.
            let outerKeyboardTop = keyboardTop
            if nodeType == .window { keyboardTop = nil }
            defer { if nodeType == .window { keyboardTop = outerKeyboardTop } }
            // The nearest labelled app node is the children's container
            // (TextContent.ownLabel); the application's name is not.
            let ownLabel = nodeDict["label"] as? String ?? ""
            let childContainerLabel = ownLabel.isEmpty || !isAppNode ? containerLabel : ownLabel
            for child in children {
                findMatches(
                    in: child,
                    inTabBar: childrenInTabBar,
                    insideSwitch: insideSwitch || NonAppElements.isSwitch(nodeType),
                    // Inside a native alert only the alert is an alert
                    // (RoleMapping.matches, PILOT-919).
                    inAlert: inAlert || nodeType == .alert,
                    containerLabel: childContainerLabel,
                    selector: selector,
                    results: &results,
                    matchedAncestors: &matchedAncestors,
                    suppressed: &suppressed,
                    keyboardMatches: &keyboardMatches,
                    keyboardTop: &keyboardTop,
                    keyboardVisibleInSnapshot: keyboardVisibleInSnapshot,
                    liveFocusedTextInput: liveFocusedTextInput,
                    focusedHint: focusedHint
                )
            }
        }

        if pushedAncestor {
            matchedAncestors.removeLast()
        }
    }

    private func matchesSelector(
        _ node: [String: Any],
        inTabBar: Bool,
        inAlert: Bool,
        containerLabel: String,
        selector: ElementSelector,
        keyboardVisibleInSnapshot: Bool,
        liveFocusedTextInput: () -> LiveFocusedTextInput?,
        focusedHint: FocusedTextInputHint?
    ) -> Bool {
        let label = node["label"] as? String ?? ""
        let title = node["title"] as? String ?? ""
        let identifier = node["identifier"] as? String ?? ""
        let value = node["value"] as? String ?? ""
        let placeholderValue = node["placeholderValue"] as? String ?? ""
        let elTypeRaw = parseUInt(node["elementType"]) ?? 0
        let elType = XCUIElement.ElementType(rawValue: elTypeRaw) ?? .other
        let isEnabled = node["enabled"] as? Bool ?? true
        let isSelected = node["selected"] as? Bool ?? false

        // getByText — exact, substring or RegExp — compares the node's text
        // content: TextContent decides which of its label, title and value
        // count (PILOT-794), and how a string matches. Whitespace is
        // normalized like Playwright (PILOT-510).
        if selector.text != nil || selector.textContains != nil || selector.textRegex != nil {
            let texts = TextContent.texts(
                elementType: elType, label: label, title: title, value: value, containerLabel: containerLabel
            )
            if let text = selector.text, !TextContent.matchesExact(texts, text) { return false }
            if let textRegex = selector.textRegex, !TextContent.matchesRegex(texts, textRegex) { return false }
            if let textContains = selector.textContains, !TextContent.matchesSubstring(texts, textContains) {
                return false
            }
        }

        // ContentDesc selector (maps to label on iOS)
        if let contentDesc = selector.contentDesc {
            let exactMatch = label == contentDesc || title == contentDesc
            let containsAsChild = !exactMatch
                && (containsChildText(label, childText: contentDesc)
                    || containsChildText(title, childText: contentDesc))
            if !exactMatch && !containsAsChild { return false }
        }

        // TestId selector (maps to identifier on iOS)
        if let testId = selector.testId {
            if identifier != testId { return false }
        }

        // ResourceId / id selector
        if let id = selector.id {
            if identifier != id { return false }
        }

        // Hint selector
        if let hint = selector.hint {
            if placeholderValue != hint { return false }
        }

        // Role selector — match by element type, accessibility traits or (for
        // React Native's generic views) role description: RN's
        // Pressable/TouchableOpacity with accessibilityRole="button" sets the
        // button trait but the element type stays .other. A heading needs the
        // header trait, and a generic view isn't a checkbox, radio, alert or
        // combobox without more to go on (RoleMapping.matches, PILOT-608).
        if let role = selector.role {
            let traits = parseUInt64(node["traits"]) ?? 0
            if !RoleMapping.matches(
                role: role,
                elementType: elType,
                traits: traits,
                value: value,
                hasNameFilter: selector.hasNameFilter,
                inTabBar: inTabBar,
                inAlert: inAlert
            ) {
                return false
            }

            // Filter by name if provided: the label or title, or a label-less
            // text input's placeholder (RoleName, PILOT-834).
            // Like Playwright: a case-insensitive substring by default, a
            // case-sensitive whole-string match with `exact` (PILOT-549).
            if let name = selector.name {
                if !RoleName.matches(
                    elementType: elType, label: label, title: title, placeholder: placeholderValue,
                    name: name, exact: selector.nameExact
                ) {
                    return false
                }
            } else if let nameRegex = selector.nameRegex {
                // A RegExp tests the whitespace-normalized name (PILOT-520).
                if !RoleName.matches(
                    elementType: elType, label: label, title: title, placeholder: placeholderValue, regex: nameRegex
                ) {
                    return false
                }
            }
        }

        // ClassName selector
        if let className = selector.className {
            let typeName = RoleMapping.typeName(for: elType)
            if typeName != className { return false }
        }

        // Enabled filter
        if let wantEnabled = selector.enabled {
            if isEnabled != wantEnabled { return false }
        }

        if let wantChecked = selector.checked {
            let isChecked = checkedState(
                for: elType,
                value: value,
                selected: isSelected
            )
            if isChecked != wantChecked { return false }
        }

        // Focus filter
        if let wantFocused = selector.focused {
            let isFocused = resolvedSnapshotFocus(
                node,
                elementType: elType,
                keyboardVisibleInSnapshot: keyboardVisibleInSnapshot,
                liveFocusedTextInput: liveFocusedTextInput,
                focusedHint: focusedHint
            )
            if isFocused != wantFocused { return false }
        }

        // Selected filter
        if let wantSelected = selector.selected {
            if isSelected != wantSelected { return false }
        }

        // Expanded filter — React Native surfaces expanded state as "expanded"
        // in the accessibilityValue string (e.g. "expanded" or "expanded, busy").
        // Only "expanded" is added (no "collapsed"), so absence means collapsed.
        if let wantExpanded = selector.expanded {
            let isExpanded = value.lowercased().contains("expanded")
            if isExpanded != wantExpanded { return false }
        }

        // Label selector: an input named by its label or title (LabelMatch,
        // PILOT-666); a RegExp tests the raw text (PILOT-520).
        if let labelSelector = selector.label,
           !LabelMatch.matches(elementType: elType, label: label, title: title, query: labelSelector) {
            return false
        }
        if let labelRegex = selector.labelRegex,
           !LabelMatch.matches(elementType: elType, label: label, title: title, regex: labelRegex) {
            return false
        }

        // Must have at least one positive match criterion
        let hasAnySelector = selector.text != nil || selector.textContains != nil
            || selector.textRegex != nil || selector.labelRegex != nil
            || selector.contentDesc != nil || selector.testId != nil
            || selector.id != nil || selector.hint != nil
            || selector.role != nil || selector.className != nil
            || selector.label != nil || selector.focused == true
        if !hasAnySelector { return false }

        return true
    }

    /// Whether two frames are one target as the SDK's same-target collapse
    /// keys it: equal once truncated to whole points, like ElementBounds.
    static func sameTarget(_ a: CGRect, _ b: CGRect) -> Bool {
        func bounds(_ r: CGRect) -> [Int] {
            [Int(r.origin.x), Int(r.origin.y), Int(r.origin.x + r.width), Int(r.origin.y + r.height)]
        }
        return a.width > 0 && a.height > 0 && bounds(a) == bounds(b)
    }

    private func parseFrame(_ node: [String: Any]) -> CGRect {
        SnapshotElementFinder.parseFrame(node)
    }

    static func parseFrame(_ node: [String: Any]) -> CGRect {
        // The snapshot dictionary stores frame as a sub-dictionary
        if let frameDict = node["frame"] as? [String: Any] {
            let x = (frameDict["X"] as? Double) ?? (frameDict["x"] as? Double) ?? 0
            let y = (frameDict["Y"] as? Double) ?? (frameDict["y"] as? Double) ?? 0
            let w = (frameDict["Width"] as? Double) ?? (frameDict["width"] as? Double) ?? 0
            let h = (frameDict["Height"] as? Double) ?? (frameDict["height"] as? Double) ?? 0
            return CGRect(x: x, y: y, width: w, height: h)
        }
        return .zero
    }

    private func parseUInt(_ raw: Any?) -> UInt? {
        SnapshotElementFinder.parseUInt(raw)
    }

    static func parseUInt(_ raw: Any?) -> UInt? {
        guard let raw else { return nil }
        switch raw {
        case let value as UInt:
            return value
        case let value as UInt64:
            return UInt(value)
        case let value as Int:
            return value >= 0 ? UInt(value) : nil
        case let value as NSNumber:
            return UInt(value.uint64Value)
        case let value as String:
            return UInt(value)
        default:
            return nil
        }
    }

    private func parseUInt64(_ raw: Any?) -> UInt64? {
        guard let raw else { return nil }
        switch raw {
        case let value as UInt64:
            return value
        case let value as UInt:
            return UInt64(value)
        case let value as Int:
            return value >= 0 ? UInt64(value) : nil
        case let value as NSNumber:
            return value.uint64Value
        case let value as String:
            return UInt64(value)
        default:
            return nil
        }
    }

    private func parseNode(_ dict: [String: Any]) -> AXNode {
        let children = (dict["children"] as? [[String: Any]] ?? []).map { parseNode($0) }
        return AXNode(
            elementType: parseUInt(dict["elementType"]) ?? 0,
            label: (dict["label"] as? String) ?? (dict["title"] as? String ?? ""),
            identifier: dict["identifier"] as? String ?? "",
            value: (dict["value"] as? String) ?? "",
            placeholderValue: dict["placeholderValue"] as? String ?? "",
            isEnabled: dict["enabled"] as? Bool ?? true,
            frame: parseFrame(dict),
            children: children
        )
    }

    // MARK: - XCUIElement caching for actions

    /// Lazily cache an XCUIElement for the given selector so it can be used for actions.
    ///
    /// Builds an XCUIElement query that is as specific as possible to avoid
    /// matching a DIFFERENT element when multiple elements share the same label.
    /// Uses element type + identifier + label when available, falling back to
    /// broader queries only when the selector doesn't carry enough info.
    private func cacheQueryElement(
        elementId: String,
        selector: ElementSelector,
        matchIndex: Int,
        idIndex: Int,
        labelIndex: Int?,
        snapshotNode: [String: Any]? = nil,
        treeHasSwitchPart: Bool = false
    ) {
        // Build a query that matches this element
        let element: XCUIElement?

        // Extract snapshot metadata for more precise queries when available.
        let nodeElTypeRaw = snapshotNode.flatMap { parseUInt($0["elementType"]) } ?? 0
        let nodeElType = XCUIElement.ElementType(rawValue: nodeElTypeRaw)
        let nodeIdentifier = snapshotNode?["identifier"] as? String ?? ""

        // Resolve a query to the SPECIFIC match: when the element carries a
        // unique snapshot identifier, narrow by it (firstMatch then suffices);
        // otherwise resolve by its positional index in the match set, so
        // `.last()/.nth()` on same-label, no-id elements resolve to the right
        // one instead of always the first. `matchIndex` is the element's index
        // in this `findElements` result (post wrapper-suppression), so it aligns
        // with the SDK's positional pick.
        //
        // KNOWN LIMITATION: `boundBy(matchIndex)` indexes the XCUIElementQuery,
        // which does NOT apply our wrapper-suppression. If a suppressed wrapper
        // also matches the query, the query and the snapshot match set diverge
        // and a non-first index can land on the wrong element. We mitigate this
        // by scoping the query to the snapshot element's type when it is
        // specific (`labelQuery`) — wrappers are usually `.other` and so fall
        // out — and `matchIndex 0` (`.first()`) is always correct. The
        // identifier path (above) is unaffected. Fully eliminating it would need
        // frame-based resolution, which XCUIElement predicates can't express.
        //
        // The match set leaves out what isn't the app's (NonAppElements), so
        // the query does too: it never counts the hooks marker. It can't leave
        // out the keyboard, so a match after the keyboard in tree order (an
        // accessory toolbar, a later window) is indexed past the keyboard's
        // nodes that match the selector (`keyboardMatchesKey`).
        let keyboardTypes = snapshotNode?[SnapshotElementFinder.keyboardMatchesKey] as? [UInt] ?? []
        let scopedToType = nodeElType.map { $0 != .other && $0 != .any } ?? false
        // `resolve` re-finds by a query on the match's type when it is specific
        // (`labelQuery`); the testId/id queries below are on any type.
        let keyboardOffsetInScope = scopedToType
            ? keyboardTypes.filter { $0 == nodeElTypeRaw }.count
            : keyboardTypes.count
        let keyboardOffset = keyboardTypes.count
        func resolve(_ query: XCUIElementQuery) -> XCUIElement? {
            let base = query.excludingHooksMarker()
            if !nodeIdentifier.isEmpty {
                // Narrow to the identifier, then index WITHIN that id group so a
                // non-unique identifier still resolves positionally. For a unique
                // id, idIndex == 0, i.e. equivalent to firstMatch.
                return base.matching(NSPredicate(format: "identifier == %@", nodeIdentifier))
                    .element(boundBy: idIndex)
            }
            return base.element(boundBy: matchIndex + keyboardOffsetInScope)
        }
        // A label predicate scoped to the snapshot element's type when it is
        // specific (RN buttons surface as `.other`, so fall back to any type).
        func labelQuery(_ predicate: NSPredicate) -> XCUIElementQuery {
            if let elType = nodeElType, elType != .other, elType != .any {
                return app.descendants(matching: elType).matching(predicate)
            }
            return app.descendants(matching: .any).matching(predicate)
        }

        // The matched node found again by its own label (and identifier), at
        // its index among the nodes that query returns (QueryIndex.liveIndex).
        func byOwnLabel(_ nodeLabel: String, at labelIndex: Int) -> XCUIElement {
            var predicates = [NSPredicate(format: "label == %@", nodeLabel)]
            if !nodeIdentifier.isEmpty {
                predicates.append(NSPredicate(format: "identifier == %@", nodeIdentifier))
            }
            return labelQuery(NSCompoundPredicate(andPredicateWithSubpredicates: predicates))
                .element(boundBy: labelIndex)
        }

        if let testId = selector.testId {
            element = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier == %@", testId))
                .excludingHooksMarker()
                .element(boundBy: matchIndex + keyboardOffset)
        } else if let id = selector.id {
            element = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier == %@", id))
                .excludingHooksMarker()
                .element(boundBy: matchIndex + keyboardOffset)
        } else if let text = selector.text {
            // The label query also returns what the walk left out — a match's
            // ancestors, a switch named like the text (TextContent) — so
            // re-resolve by the node's own label at its index among the nodes
            // that query returns, as a substring match does.
            let nodeLabel = snapshotNode?["label"] as? String ?? ""
            if !nodeLabel.isEmpty, let labelIndex {
                element = byOwnLabel(nodeLabel, at: labelIndex)
            } else {
                // Matched through its title or value: the selector's own
                // exact query (label/title/value), at the node's index among
                // the nodes that query returns (QueryIndex.exactMatches).
                let pattern = TextMatch.exactPattern(text)
                let predicate = NSPredicate(
                    format: "label MATCHES %@ OR title MATCHES %@ OR value MATCHES %@",
                    pattern, pattern, pattern
                )
                if let labelIndex {
                    element = nodeIdentifier.isEmpty
                        ? labelQuery(predicate).element(boundBy: labelIndex)
                        : resolve(labelQuery(predicate))
                } else {
                    // The query can't return this node (labelIndices):
                    // cache nothing, so live-element actions fail loudly.
                    element = nil
                }
            }
        } else if let textContains = selector.textContains {
            // A case-insensitive substring (PILOT-522) also matches other
            // elements, of any type, whose label holds the text; the
            // type-scoped query below wouldn't return those, so matchIndex
            // would shift. Re-resolve by the node's own label at its index
            // in that query, as a role name does.
            let nodeLabel = snapshotNode?["label"] as? String ?? ""
            if !nodeLabel.isEmpty, let labelIndex {
                element = byOwnLabel(nodeLabel, at: labelIndex)
            } else {
                // Matched through its title or value: the selector's own
                // substring query (label/title/value), at the node's index
                // among the nodes that query returns.
                let pattern = TextMatch.containsPattern(textContains)
                let predicate = NSPredicate(
                    format: "label MATCHES %@ OR title MATCHES %@ OR value MATCHES %@",
                    pattern, pattern, pattern
                )
                if nodeIdentifier.isEmpty, let labelIndex {
                    element = labelQuery(predicate).element(boundBy: labelIndex)
                } else {
                    element = resolve(labelQuery(predicate))
                }
            }
        } else if let contentDesc = selector.contentDesc {
            element = resolve(labelQuery(concatenatedLabelPredicate(contentDesc)))
        } else if selector.reResolvesByLabel {
            // Role + name, e.g. role("button", "Sign in"), or a RegExp locator.
            // The name is a case-insensitive substring by default (PILOT-549),
            // and a RegExp (PILOT-520) matches whatever it matches, so a query
            // built from the selector would also match unrelated earlier
            // labels (a header above the button) and shift the positional
            // index. Re-resolve by the matched node's own label
            // (and identifier), at its index among every node of the tree
            // this query returns (QueryIndex.liveIndex).
            let nodeLabel = snapshotNode?["label"] as? String ?? ""
            let nodePlaceholder = snapshotNode.flatMap { node -> String? in
                guard selector.role != nil, let type = nodeElType else { return nil }
                return RoleName.placeholderName(
                    elementType: type,
                    label: nodeLabel,
                    title: node["title"] as? String ?? "",
                    placeholder: node["placeholderValue"] as? String ?? ""
                )
            }
            if let nodePlaceholder, let labelIndex {
                // Named by its placeholder (a SwiftUI TextField, PILOT-834):
                // find it by that placeholder, at its index among the nodes
                // that query returns (QueryIndex.placeholderLiveIndex).
                var predicates = [NSPredicate(format: "placeholderValue == %@", nodePlaceholder)]
                if !nodeIdentifier.isEmpty {
                    predicates.append(NSPredicate(format: "identifier == %@", nodeIdentifier))
                }
                element = labelQuery(NSCompoundPredicate(andPredicateWithSubpredicates: predicates))
                    .element(boundBy: labelIndex)
            } else if !nodeLabel.isEmpty, let labelIndex {
                element = byOwnLabel(nodeLabel, at: labelIndex)
            } else {
                // Matched through its title with an empty label: no label
                // query can find this node, and a name query would bind some
                // other control whose label contains the name. Cache nothing,
                // so live-element actions fail loudly instead.
                element = nil
            }
        } else if let role = selector.role {
            let nodeLabel = snapshotNode?["label"] as? String ?? ""
            if selector.roleOnlyReResolvesByLabel {
                // Role-only heading / RN checkbox, radio, alert, combobox: a
                // type query can't tell them apart from other static texts or
                // generic views, so find the node by its own label, as
                // role + name does above — and like it, cache nothing for an
                // empty label rather than bind some other element (PILOT-608).
                if !nodeLabel.isEmpty, let labelIndex {
                    element = byOwnLabel(nodeLabel, at: labelIndex)
                } else {
                    element = nil
                }
            } else if selector.roleOnlySwitch, !nodeLabel.isEmpty, let labelIndex {
                // A live switch query also returns SwiftUI Toggle knobs, which
                // the match set leaves out (NonAppElements.isSwitchPart), and
                // after the switches that hold them rather than in tree order,
                // so no index into it can be trusted: find a named switch by
                // its own label, which a knob doesn't have (PILOT-790).
                element = byOwnLabel(nodeLabel, at: labelIndex)
            } else if selector.roleOnlySwitch, treeHasSwitchPart {
                // An unnamed switch beside SwiftUI Toggles: nothing but a
                // position in that query could find it again, so cache
                // nothing, as for the roles above — a tap goes to its bounds
                // (or, for a Toggle, its knob by frame).
                element = nil
            } else if let types = try? RoleMapping.elementTypes(for: role), let firstType = types.first {
                // Role-only: match by type — every type the role lists, so
                // a progressbar that is an activity indicator (PILOT-797) or
                // a list that is a collection view is indexed among all of
                // the role's types, not looked for among the first type's.
                // (A trait-matched `.other` is in no type query.)
                if types.count == 1 {
                    element = resolve(app.descendants(matching: firstType))
                } else {
                    let rawValues = types.map { NSNumber(value: $0.rawValue) }
                    let query = app.descendants(matching: .any)
                        .matching(NSPredicate(format: "elementType IN %@", rawValues))
                    if nodeIdentifier.isEmpty {
                        let rawTypes = Set(types.map(\.rawValue))
                        let offset = keyboardTypes.filter { rawTypes.contains($0) }.count
                        element = query.excludingHooksMarker().element(boundBy: matchIndex + offset)
                    } else {
                        element = resolve(query)
                    }
                }
            } else {
                element = nil
            }
        } else {
            element = nil
        }

        if let element = element {
            lock.lock()
            elementCache[elementId] = element
            lock.unlock()
        }
    }

    /// Build an NSPredicate that matches a label value accounting for iOS's
    /// auto-concatenated accessibility labels (child texts joined by ", ").
    private func concatenatedLabelPredicate(_ value: String) -> NSPredicate {
        NSCompoundPredicate(orPredicateWithSubpredicates: [
            NSPredicate(format: "label == %@", value),
            NSPredicate(format: "label BEGINSWITH %@", value + ", "),
            NSPredicate(format: "label ENDSWITH %@", ", " + value),
            NSPredicate(format: "label CONTAINS %@", ", " + value + ", "),
        ])
    }

    // MARK: - Helpers

    private var _screenSize: CGSize?

    var screenSize: CGSize {
        lock.lock()
        if let cached = _screenSize {
            lock.unlock()
            return cached
        }
        lock.unlock()

        // Get actual screen size from the app's main window frame.
        // On iOS the main window is always full-screen.
        let frame = app.windows.firstMatch.frame
        let size: CGSize
        if frame.width > 0 && frame.height > 0 {
            size = frame.size
        } else {
            NSLog("[TapsmithSnapshot] WARNING: Could not determine screen size from window frame (\(frame)), using fallback 393x852")
            size = CGSize(width: 393, height: 852)
        }

        lock.lock()
        _screenSize = size
        lock.unlock()
        return size
    }

    /// Invalidate the cached screen size. Call after orientation changes
    /// so the next access re-reads from the window frame.
    func invalidateScreenSize() {
        lock.lock()
        _screenSize = nil
        lock.unlock()
    }

    private func computeViewportRatio(_ bounds: ElementBounds, screenSize: CGSize) -> Float {
        let screenRect = CGRect(x: 0, y: 0, width: screenSize.width, height: screenSize.height)
        let elemRect = CGRect(
            x: CGFloat(bounds.left), y: CGFloat(bounds.top),
            width: CGFloat(bounds.width), height: CGFloat(bounds.height)
        )
        let area = elemRect.width * elemRect.height
        guard area > 0 else { return 0 }
        let intersection = screenRect.intersection(elemRect)
        guard !intersection.isNull else { return 0 }
        return Float(min(max(intersection.width * intersection.height / area, 0), 1))
    }

    private func toElementInfo(_ element: XCUIElement, elementId: String) -> ElementInfo {
        let frame = element.frame
        let bounds = ElementBounds(
            left: Int(frame.origin.x), top: Int(frame.origin.y),
            right: Int(frame.origin.x + frame.size.width),
            bottom: Int(frame.origin.y + frame.size.height)
        )
        let viewportRatio = computeViewportRatio(bounds, screenSize: screenSize)
        // Delegated to the shared factory in ElementInfo.swift so the
        // sibling ElementFinder.swift path can't drift on text /
        // checked / role / hint derivation.
        return ElementInfo.makeFromXCUIElement(
            element,
            elementId: elementId,
            bounds: bounds,
            viewportRatio: viewportRatio,
            inTabBar: getIdentity(elementId)?.inTabBar ?? false
        )
    }

    private func describeSelector(_ selector: ElementSelector) -> String {
        var parts: [String] = []
        if let v = selector.role { parts.append("role=\(v)") }
        if let v = selector.name { parts.append("name=\(v)") }
        if selector.name != nil && selector.nameExact { parts.append("exact=true") }
        if let v = selector.nameRegex { parts.append("name=\(v.display)") }
        if let v = selector.text { parts.append("text=\(v)") }
        if let v = selector.textContains { parts.append("textContains=\(v)") }
        if let v = selector.textRegex { parts.append("text=\(v.display)") }
        if let v = selector.labelRegex { parts.append("label=\(v.display)") }
        if let v = selector.contentDesc { parts.append("contentDesc=\(v)") }
        if let v = selector.hint { parts.append("hint=\(v)") }
        if let v = selector.className { parts.append("className=\(v)") }
        if let v = selector.testId { parts.append("testId=\(v)") }
        if let v = selector.id { parts.append("id=\(v)") }
        if let v = selector.label { parts.append("label=\(v)") }
        return parts.joined(separator: ", ")
    }

    /// Thin delegate to the shared canonical implementation.
    private func checkedState(
        for elementType: XCUIElement.ElementType,
        value: String?,
        selected: Bool
    ) -> Bool {
        ElementInfo.deriveCheckedState(
            elementType: elementType,
            value: value,
            selected: selected
        )
    }
}
