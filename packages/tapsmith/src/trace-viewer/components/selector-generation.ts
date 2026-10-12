import type { HierarchyNode } from './hierarchy-utils.js';
import { getNodeRole, isLabelField, webViewAriaLabel, WEBVIEW_TAG_TO_ROLE, ANDROID_CLASS_TO_ROLE, IOS_TYPE_TO_ROLE } from './hierarchy-utils.js';
import { unknownRoleMessage } from '../../roles.js';
import { escapeJsString, hasPrivateUseChar } from '../../js-string-escape.js';
import { cssIdSelector, isCssIdentifier } from '../../css-selector.js';

// ─── Attribute Helpers ───

function isWebViewNode(node: HierarchyNode): boolean {
  return node.attributes.get('webview') === 'true';
}

function getRole(node: HierarchyNode): string | null {
  const role = getNodeRole(node);
  // Never suggest a role getByRole rejects: Android reports any role
  // description an app publishes (a custom "carousel", a localized one) as
  // tapsmith-role (PILOT-556).
  return role && unknownRoleMessage(role) === null ? role : null;
}

function getText(node: HierarchyNode): string {
  return node.attributes.get('text') ?? node.attributes.get('label') ?? '';
}

function getContentDesc(node: HierarchyNode): string {
  return node.attributes.get('content-desc') ?? '';
}

function getLabel(node: HierarchyNode): string {
  return node.attributes.get('label') ?? '';
}

function getHint(node: HierarchyNode): string {
  return node.attributes.get('hint') ?? node.attributes.get('placeholderValue') ?? '';
}

function getResourceId(node: HierarchyNode): string {
  return node.attributes.get('resource-id') ?? node.attributes.get('identifier') ?? '';
}

function isIos(node: HierarchyNode): boolean {
  return node.tagName.startsWith('XCUI') || node.attributes.has('type');
}

// ─── WebView Role Mapping ───

function getWebViewRole(node: HierarchyNode): string | null {
  const explicitRole = node.attributes.get('webview-role');
  if (explicitRole) return explicitRole;

  const tag = node.attributes.get('webview-tag') ?? '';
  const inputType = node.attributes.get('webview-type') ?? '';

  if (tag === 'input') {
    if (inputType === 'checkbox') return 'checkbox';
    if (inputType === 'radio') return 'radio';
    if (inputType === 'range') return 'slider';
    if (inputType === 'button' || inputType === 'submit' || inputType === 'reset') return 'button';
    return 'textfield';
  }

  return WEBVIEW_TAG_TO_ROLE[tag] ?? null;
}

// ─── Selector Generation ───

// Roles that are always generic containers — demote regardless of source.
const ALWAYS_GENERIC_ROLES = new Set(['other', 'none']);

// Roles that the iOS agent derives from explicit accessibility traits (e.g.
// UIAccessibilityTraitHeader → "heading", UIAccessibilityTraitButton →
// "button"). These are trustworthy even on generic XCUIElementTypeOther
// elements because the app explicitly declared them.
const TRUSTED_TRAIT_ROLES = new Set(['heading', 'link', 'searchfield', 'button', 'image', 'seekbar']);

/** Check whether the node's native class/type already maps to a known role
 * (without relying on tapsmith-role). If so, the role is trustworthy. */
function hasNativeRole(node: HierarchyNode): boolean {
  const className = node.attributes.get('class') ?? '';
  if (className && ANDROID_CLASS_TO_ROLE[className]) return true;
  const iosType = node.attributes.get('type') ?? node.tagName;
  if (IOS_TYPE_TO_ROLE[iosType]) return true;
  return false;
}

/**
 * Icon-font glyphs (private-use characters) and the separators that join
 * them to a label, at either end of a name. React Navigation names an icon
 * tab "<glyph>, Library" (PILOT-659).
 */
const EDGE_GLYPHS_RE = /^[\p{Co}\s,;:|·•\-–—]+|[\p{Co}\s,;:|·•\-–—]+$/gu;

/**
 * The name to give getByRole: the accessible name without the icon glyphs at
 * its ends, so the locator reads "Library" rather than pinning an invisible
 * glyph's code point. The result is a substring of the full name, which the
 * runtime's default role-name match (case-insensitive substring, PILOT-549)
 * accepts; a name with no glyph is returned unchanged.
 */
export function roleNameFor(accessibleName: string): string {
  if (!hasPrivateUseChar(accessibleName)) return accessibleName;
  return accessibleName.replace(EDGE_GLYPHS_RE, '');
}

/**
 * A locator whose value still pins an icon glyph works, but breaks when the
 * app changes icon, so it ranks after every glyph-free semantic locator
 * (PILOT-659) — yet below FALLBACK_PRIORITY_THRESHOLD, since it still names
 * this element (a pick must not move to a descendant over it).
 */
const GLYPH_PINNED_PRIORITY = 7.5;

/** `priority`, demoted to {@link GLYPH_PINNED_PRIORITY} when `value` pins an icon glyph. */
export function glyphAware(priority: number, value: string): number {
  return hasPrivateUseChar(value) ? Math.max(priority, GLYPH_PINNED_PRIORITY) : priority;
}

export interface GeneratedSelector {
  code: string
  label: string
  priority: number
  /** Set by disambiguateSelectors when the selector no longer resolves to the
   * picked node in the current hierarchy (e.g. the live screen changed).
   * The playground renders these rows dimmed. */
  mayNotMatch?: boolean
}

export function generateSelectors(node: HierarchyNode): GeneratedSelector[] {
  if (isWebViewNode(node)) {
    return generateWebViewSelectors(node);
  }
  return generateNativeSelectors(node);
}

// Priority follows Testing Library order:
// Role → LabelText → Placeholder → Text → TestID → CSS
function generateWebViewSelectors(node: HierarchyNode): GeneratedSelector[] {
  const selectors: GeneratedSelector[] = [];
  const tag = node.attributes.get('webview-tag') ?? '';
  const id = node.attributes.get('webview-id') ?? '';
  const text = getText(node);
  const ariaLabel = getContentDesc(node);
  const placeholder = getHint(node);
  const testId = node.attributes.get('webview-testid') ?? '';
  const role = getWebViewRole(node);

  // 1. Role + name (highest priority)
  const accessibleName = ariaLabel || text || placeholder;
  if (role && accessibleName) {
    selectors.push({
      code: `webview.getByRole("${escapeJsString(role)}", { name: "${escapeJsString(accessibleName)}" })`,
      label: 'Role + name',
      priority: 1,
    });
  }

  // 2. Role alone
  if (role && !accessibleName) {
    selectors.push({
      code: `webview.getByRole("${escapeJsString(role)}")`,
      label: 'Role',
      priority: 2,
    });
  }

  // 3. Label (aria-label) — Testing Library getByLabelText. webview.getByLabel
  // matches the aria-label attribute only, not a <label> or aria-labelledby.
  const ariaLabelAttr = webViewAriaLabel(node);
  if (ariaLabelAttr) {
    selectors.push({
      code: `webview.getByLabel("${escapeJsString(ariaLabelAttr)}")`,
      label: 'Label',
      priority: 3,
    });
  }

  // 4. Placeholder — Testing Library getByPlaceholderText
  if (placeholder) {
    selectors.push({
      code: `webview.getByPlaceholder("${escapeJsString(placeholder)}")`,
      label: 'Placeholder',
      priority: 4,
    });
  }

  // 5. Text content — Testing Library getByText
  if (text) {
    selectors.push({
      code: `webview.getByText("${escapeJsString(text)}")`,
      label: 'Text',
      priority: 5,
    });
  }

  // 6. Test ID (last resort for semantic selectors)
  if (testId) {
    selectors.push({
      code: `webview.getByTestId("${escapeJsString(testId)}")`,
      label: 'Test ID',
      priority: 6,
    });
  }

  // 7. CSS id selector
  if (id) {
    selectors.push({
      code: `webview.locator("${escapeJsString(cssIdSelector(id))}")`,
      label: 'CSS #id',
      priority: 7,
    });
  }

  // 8. CSS tag selector (fallback)
  if (tag) {
    const cssClass = (node.attributes.get('webview-class') ?? '').split(/\s+/).filter(Boolean)[0];
    if (cssClass && isCssIdentifier(cssClass)) {
      selectors.push({
        code: `webview.locator("${tag}.${escapeJsString(cssClass)}")`,
        label: 'CSS tag.class',
        priority: 8,
      });
    } else {
      selectors.push({
        code: `webview.locator("${escapeJsString(tag)}")`,
        label: 'CSS tag',
        priority: 9,
      });
    }
  }

  const seen = new Set<string>();
  return selectors
    .sort((a, b) => a.priority - b.priority)
    .filter(s => {
      if (seen.has(s.code)) return false;
      seen.add(s.code);
      return true;
    });
}

// Priority follows Testing Library order:
// Role → Label → Description → Placeholder → Text → TestID
function generateNativeSelectors(node: HierarchyNode): GeneratedSelector[] {
  const selectors: GeneratedSelector[] = [];
  const role = getRole(node);
  const text = getText(node);
  const contentDesc = getContentDesc(node);
  const label = getLabel(node);
  const hint = getHint(node);
  const resourceId = getResourceId(node);
  const ios = isIos(node);

  // The accessible name for role-based selectors: on iOS use label, on
  // Android prefer content-desc, then text — less any icon glyph at its ends.
  // A name that is nothing but glyphs (an icon-only element) stays whole:
  // it is the element's only name.
  const fullName = ios ? label : (contentDesc || text);
  const accessibleName = roleNameFor(fullName) || fullName;
  // getByLabel matches Android's content-desc (or a labelling view, which
  // the dump does not carry) — never the field's own text, which is its
  // typed value or hint — and iOS's label or title.
  const labelName = ios ? (label || (node.attributes.get('title') ?? '')) : contentDesc;

  // Demote role-based selectors when the role is generic OR when it came from
  // the agent's accessibility-trait heuristic (tapsmith-role) on a node whose
  // native type is generic (XCUIElementTypeOther, android.view.ViewGroup). The
  // trait mapping is unreliable on RN apps without accessibilityRole — it cycles
  // through wrong roles (alert, checkbox, radiobutton, combobox). But when the
  // native type itself maps to a real role (XCUIElementTypeTextField → textfield,
  // android.widget.Button → button), the role is trustworthy.
  const genericRole = role != null && (
    ALWAYS_GENERIC_ROLES.has(role)
    || (node.attributes.has('tapsmith-role') && !hasNativeRole(node) && !TRUSTED_TRAIT_ROLES.has(role))
  );

  // 1. Role + name (highest priority — Testing Library getByRole)
  if (role && accessibleName) {
    selectors.push({
      code: `device.getByRole("${escapeJsString(role)}", { name: "${escapeJsString(accessibleName)}" })`,
      label: 'Role + name',
      priority: glyphAware(genericRole ? 7 : 1, accessibleName),
    });
  }

  // 2. Role without name
  if (role && !accessibleName) {
    selectors.push({
      code: `device.getByRole("${escapeJsString(role)}")`,
      label: 'Role',
      priority: genericRole ? 10 : 2,
    });
  }

  // 3. Label — Testing Library getByLabelText, for the inputs the runtime's
  // getByLabel finds (PILOT-666): Android by contentDescription, iOS by
  // accessibilityLabel.
  if (isLabelField(node) && labelName) {
    selectors.push({
      code: `device.getByLabel("${escapeJsString(labelName)}")`,
      label: 'Label',
      priority: glyphAware(3, labelName),
    });
  }

  // 4. Description — generated from Android content-desc only. On iOS,
  // getByDescription does match the accessibility label at runtime, but the
  // label is also the element's visible text, so we generate the equivalent
  // getByText instead of a redundant second selector.
  if (contentDesc) {
    selectors.push({
      code: `device.getByDescription("${escapeJsString(contentDesc)}")`,
      label: 'Description',
      priority: glyphAware(4, contentDesc),
    });
  }

  // 5. Placeholder / hint — Testing Library getByPlaceholderText
  if (hint) {
    selectors.push({
      code: `device.getByPlaceholder("${escapeJsString(hint)}")`,
      label: 'Placeholder',
      priority: glyphAware(5, hint),
    });
  }

  // 6. Text — Testing Library getByText (visible text content)
  if (text) {
    selectors.push({
      code: `device.getByText("${escapeJsString(text)}")`,
      label: 'Text',
      priority: glyphAware(6, text),
    });
  }

  // iOS label as text (when label serves as visible text, no text attr)
  if (ios && label && !text) {
    selectors.push({
      code: `device.getByText("${escapeJsString(label)}")`,
      label: 'Text (label)',
      priority: glyphAware(6, label),
    });
  }

  // 7. Test ID (last resort — Testing Library getByTestId)
  const testIdFromResource = extractTestId(resourceId);
  if (testIdFromResource) {
    selectors.push({
      code: `device.getByTestId("${escapeJsString(testIdFromResource)}")`,
      label: 'Test ID',
      priority: 7,
    });
  }

  // 8. Locator fallbacks for elements with no accessible attributes. A
  // native package-qualified id has no getByTestId (PILOT-659), so its
  // locator({ id }) takes the test-id slot: it still names this element.
  if (resourceId) {
    selectors.push({
      code: `device.locator({ id: "${escapeJsString(resourceId)}" })`,
      label: 'Resource ID',
      priority: testIdFromResource ? 8 : 7,
    });
  }
  const className = node.attributes.get('class') ?? node.attributes.get('type') ?? '';
  if (className) {
    selectors.push({
      code: `device.locator({ className: "${escapeJsString(className)}" })`,
      label: 'Class name',
      priority: 9,
    });
  }

  // Sort by priority, deduplicate by code
  const seen = new Set<string>();
  return selectors
    .sort((a, b) => a.priority - b.priority)
    .filter(s => {
      if (seen.has(s.code)) return false;
      seen.add(s.code);
      return true;
    });
}

/**
 * The getByTestId value for a resource id, if it has one. The Android agent
 * matches getByTestId against the whole resource-id: a React Native testID
 * ("email-input") matches, a native package-qualified id ("com.app:id/x")
 * does not — that one is addressed by locator({ id }) (PILOT-659).
 */
function extractTestId(resourceId: string): string | null {
  if (!resourceId || resourceId.includes(':id/')) return null;
  return resourceId;
}

// Priorities at or above this threshold are low-quality fallbacks (className,
// resource ID, demoted role-only). When the picked node only produces these,
// try its descendants for a better selector.
const FALLBACK_PRIORITY_THRESHOLD = 8;

export function hasGoodSelectors(node: HierarchyNode): boolean {
  const selectors = generateSelectors(node);
  return selectors.length > 0 && selectors[0].priority < FALLBACK_PRIORITY_THRESHOLD;
}

/**
 * When a node only produces low-quality fallback selectors, find the first
 * descendant with a meaningful selector (e.g. a textfield with a placeholder
 * inside a generic container View). Returns the descendant node, or null.
 */
export function findBetterDescendant(node: HierarchyNode): HierarchyNode | null {
  if (hasGoodSelectors(node)) return null;
  // BFS to find the shallowest descendant with good selectors.
  const queue: HierarchyNode[] = [...node.children];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (hasGoodSelectors(current)) return current;
    queue.push(...current.children);
  }
  return null;
}

export function generateBestSelector(node: HierarchyNode): string {
  const selectors = generateSelectors(node);
  if (selectors.length > 0 && selectors[0].priority < FALLBACK_PRIORITY_THRESHOLD) {
    return selectors[0].code;
  }
  const descendant = findBetterDescendant(node);
  if (descendant) {
    const descSelectors = generateSelectors(descendant);
    if (descSelectors.length > 0) return descSelectors[0].code;
  }
  return selectors.length > 0 ? selectors[0].code : `// No locator available`;
}
