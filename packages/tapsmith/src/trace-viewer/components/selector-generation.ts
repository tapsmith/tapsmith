import type { HierarchyNode } from './hierarchy-utils.js';
import { getNodeRole, WEBVIEW_TAG_TO_ROLE, ANDROID_CLASS_TO_ROLE, IOS_TYPE_TO_ROLE } from './hierarchy-utils.js';

function escapeQuotes(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ─── Attribute Helpers ───

function isWebViewNode(node: HierarchyNode): boolean {
  return node.attributes.get('webview') === 'true';
}

function getRole(node: HierarchyNode): string | null {
  return getNodeRole(node) || null;
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

export const FORM_FIELD_ROLES = new Set([
  'textfield', 'checkbox', 'switch', 'searchfield', 'seekbar', 'radiobutton', 'spinner',
]);

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
      code: `webview.getByRole("${escapeQuotes(role)}", { name: "${escapeQuotes(accessibleName)}" })`,
      label: 'Role + name',
      priority: 1,
    });
  }

  // 2. Role alone
  if (role && !accessibleName) {
    selectors.push({
      code: `webview.getByRole("${escapeQuotes(role)}")`,
      label: 'Role',
      priority: 2,
    });
  }

  // 3. Label (aria-label) — Testing Library getByLabelText
  if (ariaLabel) {
    selectors.push({
      code: `webview.getByLabel("${escapeQuotes(ariaLabel)}")`,
      label: 'Label',
      priority: 3,
    });
  }

  // 4. Placeholder — Testing Library getByPlaceholderText
  if (placeholder) {
    selectors.push({
      code: `webview.getByPlaceholder("${escapeQuotes(placeholder)}")`,
      label: 'Placeholder',
      priority: 4,
    });
  }

  // 5. Text content — Testing Library getByText
  if (text) {
    selectors.push({
      code: `webview.getByText("${escapeQuotes(text)}")`,
      label: 'Text',
      priority: 5,
    });
  }

  // 6. Test ID (last resort for semantic selectors)
  if (testId) {
    selectors.push({
      code: `webview.getByTestId("${escapeQuotes(testId)}")`,
      label: 'Test ID',
      priority: 6,
    });
  }

  // 7. CSS id selector
  if (id) {
    selectors.push({
      code: `webview.locator("#${escapeQuotes(id)}")`,
      label: 'CSS #id',
      priority: 7,
    });
  }

  // 8. CSS tag selector (fallback)
  if (tag) {
    const cssClass = (node.attributes.get('webview-class') ?? '').split(/\s+/).filter(Boolean)[0];
    if (cssClass) {
      selectors.push({
        code: `webview.locator("${tag}.${escapeQuotes(cssClass)}")`,
        label: 'CSS tag.class',
        priority: 8,
      });
    } else {
      selectors.push({
        code: `webview.locator("${escapeQuotes(tag)}")`,
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
  // Android prefer content-desc, then text.
  const accessibleName = ios ? label : (contentDesc || text);

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
      code: `device.getByRole("${escapeQuotes(role)}", { name: "${escapeQuotes(accessibleName)}" })`,
      label: 'Role + name',
      priority: genericRole ? 7 : 1,
    });
  }

  // 2. Role without name
  if (role && !accessibleName) {
    selectors.push({
      code: `device.getByRole("${escapeQuotes(role)}")`,
      label: 'Role',
      priority: genericRole ? 10 : 2,
    });
  }

  // 3. Label — Testing Library getByLabelText (form fields only)
  // Android: getByLabel matches inputs by contentDescription
  // iOS: getByLabel matches inputs by accessibilityLabel
  if (role && FORM_FIELD_ROLES.has(role) && accessibleName) {
    selectors.push({
      code: `device.getByLabel("${escapeQuotes(accessibleName)}")`,
      label: 'Label',
      priority: 3,
    });
  }

  // 4. Description — generated from Android content-desc only. On iOS,
  // getByDescription does match the accessibility label at runtime, but the
  // label is also the element's visible text, so we generate the equivalent
  // getByText instead of a redundant second selector.
  if (contentDesc) {
    selectors.push({
      code: `device.getByDescription("${escapeQuotes(contentDesc)}")`,
      label: 'Description',
      priority: 4,
    });
  }

  // 5. Placeholder / hint — Testing Library getByPlaceholderText
  if (hint) {
    selectors.push({
      code: `device.getByPlaceholder("${escapeQuotes(hint)}")`,
      label: 'Placeholder',
      priority: 5,
    });
  }

  // 6. Text — Testing Library getByText (visible text content)
  if (text) {
    selectors.push({
      code: `device.getByText("${escapeQuotes(text)}")`,
      label: 'Text',
      priority: 6,
    });
  }

  // iOS label as text (when label serves as visible text, no text attr)
  if (ios && label && !text) {
    selectors.push({
      code: `device.getByText("${escapeQuotes(label)}")`,
      label: 'Text (label)',
      priority: 6,
    });
  }

  // 7. Test ID (last resort — Testing Library getByTestId)
  const testIdFromResource = extractTestId(resourceId);
  if (testIdFromResource) {
    selectors.push({
      code: `device.getByTestId("${escapeQuotes(testIdFromResource)}")`,
      label: 'Test ID',
      priority: 7,
    });
  }

  // 8. Locator fallbacks for elements with no accessible attributes
  if (resourceId) {
    selectors.push({
      code: `device.locator({ id: "${escapeQuotes(resourceId)}" })`,
      label: 'Resource ID',
      priority: 8,
    });
  }
  const className = node.attributes.get('class') ?? node.attributes.get('type') ?? '';
  if (className) {
    selectors.push({
      code: `device.locator({ className: "${escapeQuotes(className)}" })`,
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

function extractTestId(resourceId: string): string | null {
  if (!resourceId) return null;
  const colonIdx = resourceId.indexOf(':id/');
  if (colonIdx !== -1) return resourceId.slice(colonIdx + 4);
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
