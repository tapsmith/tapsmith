import type { HierarchyNode, Bounds } from './hierarchy-utils.js';
import { parseBounds, getNodeRole } from './hierarchy-utils.js';
import { FORM_FIELD_ROLES } from './selector-generation.js';

// ─── Selector Parsing ───

export interface ParsedSelector {
  type: string
  value: string
  name?: string
  index?: number | 'first' | 'last'
}

// Matches: device.getByText("value"), device.getByRole("role", { name: "n" }),
// device.getByText("value", { exact: true }) — the options object is captured
// as a blob and parsed by parseGetByOptions. Supports both single and double
// quotes, optional whitespace around args.
// The quoted-string alternation skips escaped characters so values containing
// escaped quotes (getByText("Say \\"hi\\"")) parse fully instead of truncating.
// Groups: 1 = method, 2 = double-quoted value, 3 = single-quoted value, 4 = options blob.
const DEVICE_RE = /^device\.getBy(\w+)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')(?:\s*,\s*\{([^}]*)\})?\s*\)/;
// Matches: webview.getByText("value"), webview.getByRole("role", { name: "n" })
const WEBVIEW_GETBY_RE = /^webview\.getBy(\w+)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')(?:\s*,\s*\{([^}]*)\})?\s*\)/;

/**
 * Undo source-string escaping (\" \' \\ \n) so a parsed name compares
 * against raw node attribute values.
 */
function unescapeSelectorValue(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
}

/** Parse the options-object blob of a getBy* call: `name: "x"` and/or `exact: true`. */
function parseGetByOptions(blob: string | undefined): { name?: string; exact?: boolean } {
  if (!blob) return {};
  // Skip over escaped characters inside the quotes so an escaped quote of
  // the same type (name: "Say \"hi\"") doesn't truncate the capture.
  const nameMatch = blob.match(/name:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/);
  const exactMatch = blob.match(/exact:\s*(true|false)/);
  const rawName = nameMatch ? (nameMatch[1] !== undefined ? nameMatch[1] : nameMatch[2]) : undefined;
  return {
    name: rawName !== undefined ? unescapeSelectorValue(rawName) : undefined,
    exact: exactMatch ? exactMatch[1] === 'true' : undefined,
  };
}
// Matches: webview.locator("css-selector") — groups: 1 = dq value, 2 = sq value
const WEBVIEW_LOCATOR_RE = /^webview\.locator\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\)/;
// Matches: device.locator({ className: "value" }) or device.locator({ id: "value" })
// Groups: 1 = prop, 2 = dq value, 3 = sq value
const DEVICE_LOCATOR_RE = /^device\.locator\(\s*\{\s*(className|id)\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*,?\s*\}\s*\)/;
// Matches: text("value"), contentDesc("value") — legacy/shorthand format
// Groups: 1 = type, 2 = dq value, 3 = sq value
const SHORT_RE = /^(\w+)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\)/;

// Matches trailing .first(), .last(), .nth(N) — N may be negative
// (the runtime's .nth() counts from the end for negative indices)
const CHAIN_RE = /\.(first|last)\(\)$|\.nth\(\s*(-?\d+)\s*\)$/;

function parseChain(input: string): { base: string; index?: number | 'first' | 'last' } {
  const match = input.match(CHAIN_RE);
  if (!match) return { base: input };
  const base = input.slice(0, match.index);
  if (match[1] === 'first') return { base, index: 'first' };
  if (match[1] === 'last') return { base, index: 'last' };
  return { base, index: parseInt(match[2], 10) };
}

export function parseSelectorString(input: string): ParsedSelector | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const { base, index } = parseChain(trimmed);

  // Parsed values are UNESCAPED (raw) — they compare directly against raw
  // node attribute values; emitters re-escape when generating code strings.
  const pick = (dq: string | undefined, sq: string | undefined): string =>
    unescapeSelectorValue(dq !== undefined ? dq : (sq ?? ''));

  // WebView locator: webview.locator("#email")
  const locatorMatch = base.match(WEBVIEW_LOCATOR_RE);
  if (locatorMatch) {
    return { type: 'wv-locator', value: pick(locatorMatch[1], locatorMatch[2]), index };
  }

  // WebView getBy*: webview.getByRole("button", { name: "Login" })
  const wvMatch = base.match(WEBVIEW_GETBY_RE);
  if (wvMatch) {
    const method = wvMatch[1];
    const value = pick(wvMatch[2], wvMatch[3]);
    const { name, exact } = parseGetByOptions(wvMatch[4]);
    const sel = mapWebViewMethod(method, value, name, exact);
    if (sel) sel.index = index;
    return sel;
  }

  // Native device.locator({ className/id: "..." })
  const deviceLocatorMatch = base.match(DEVICE_LOCATOR_RE);
  if (deviceLocatorMatch) {
    const prop = deviceLocatorMatch[1];
    const value = pick(deviceLocatorMatch[2], deviceLocatorMatch[3]);
    const type = prop === 'className' ? 'className' : 'id';
    return { type, value, index };
  }

  // Native device getBy*
  const deviceMatch = base.match(DEVICE_RE);
  if (deviceMatch) {
    const method = deviceMatch[1];
    const value = pick(deviceMatch[2], deviceMatch[3]);
    const { name, exact } = parseGetByOptions(deviceMatch[4]);
    const sel = mapDeviceMethod(method, value, name, exact);
    if (sel) sel.index = index;
    return sel;
  }

  const shortMatch = base.match(SHORT_RE);
  if (shortMatch) {
    return { type: shortMatch[1], value: pick(shortMatch[2], shortMatch[3]), index };
  }

  return null;
}

function mapDeviceMethod(method: string, value: string, name?: string, exact?: boolean): ParsedSelector | null {
  switch (method) {
    // Runtime getByText is a SUBSTRING match unless { exact: true } is passed
    // (device.ts getByText → textContains). The playground must agree, or a
    // selector validated here taps a different element at runtime (PILOT-226).
    case 'Text': return exact ? { type: 'text', value } : { type: 'textContains', value };
    case 'Role': return { type: 'role', value, name };
    case 'Description': return { type: 'contentDesc', value };
    case 'Placeholder': return { type: 'hint', value };
    case 'TestId': return { type: 'testId', value };
    case 'Label': return { type: 'label', value };
    default: return null;
  }
}

function mapWebViewMethod(method: string, value: string, name?: string, exact?: boolean): ParsedSelector | null {
  switch (method) {
    // webview.getByText is substring by default too (webview-handle.ts).
    case 'Text': return exact ? { type: 'wv-text', value } : { type: 'wv-text-contains', value };
    case 'Role': return { type: 'wv-role', value, name };
    case 'Label': return { type: 'wv-label', value };
    case 'Placeholder': return { type: 'wv-placeholder', value };
    case 'TestId': return { type: 'wv-testid', value };
    default: return null;
  }
}

// ─── Node Attribute Helpers ───
// Android uses: text, content-desc, resource-id, hint, class
// iOS uses: label, identifier, placeholderValue, type

// iOS runtime text matching also accepts the element's value (and title), so
// fall back to the `value` attribute the iOS agent emits. Remaining fidelity
// gaps vs the on-device matcher (title attribute, auto-concatenated child
// labels, trailing-punctuation tolerance) are accepted here — native selector
// VALIDATION goes through the real runtime via findElements (tapsmith_test_locator);
// this TS matcher only powers the browser-side trace viewer/playground.
function getNodeText(node: HierarchyNode): string {
  return node.attributes.get('text') ?? node.attributes.get('label') ?? node.attributes.get('value') ?? '';
}

function getNodeContentDesc(node: HierarchyNode): string {
  // Android: content-desc. iOS: contentDesc selectors match the accessibility
  // label at runtime (the agent compares against label/title), so fall back
  // to the label attribute for iOS nodes.
  return node.attributes.get('content-desc') ?? node.attributes.get('label') ?? '';
}

function getNodeAccessibleName(node: HierarchyNode): string {
  return node.attributes.get('content-desc') || node.attributes.get('label') || node.attributes.get('text') || '';
}

function getNodeId(node: HierarchyNode): string {
  return node.attributes.get('resource-id') ?? node.attributes.get('identifier') ?? '';
}

function getNodeHint(node: HierarchyNode): string {
  return node.attributes.get('hint') ?? node.attributes.get('placeholderValue') ?? '';
}

function getNodeClassName(node: HierarchyNode): string {
  return node.attributes.get('class') ?? node.attributes.get('type') ?? node.tagName;
}

// ─── Node Matching ───

function isWebViewNode(node: HierarchyNode): boolean {
  return node.attributes.get('webview') === 'true';
}

function nodeMatchesSelector(node: HierarchyNode, selector: ParsedSelector): boolean {
  // WebView selector types only match WebView nodes
  if (selector.type.startsWith('wv-')) {
    if (!isWebViewNode(node)) return false;
    return webViewNodeMatchesSelector(node, selector);
  }

  // Native selector types match native nodes
  switch (selector.type) {
    case 'text':
      return getNodeText(node) === selector.value;
    case 'textContains':
      return getNodeText(node).includes(selector.value);
    case 'contentDesc':
      return getNodeContentDesc(node) === selector.value;
    case 'id': {
      const rid = getNodeId(node);
      return rid === selector.value;
    }
    case 'className':
      return getNodeClassName(node) === selector.value;
    case 'hint':
      return getNodeHint(node) === selector.value;
    case 'label': {
      const role = getNodeRole(node);
      if (!FORM_FIELD_ROLES.has(role)) return false;
      return getNodeAccessibleName(node) === selector.value;
    }
    case 'testId': {
      const rid = getNodeId(node);
      return rid === selector.value || rid.endsWith(`:id/${selector.value}`);
    }
    case 'role': {
      const role = getNodeRole(node);
      if (role !== selector.value) return false;
      if (selector.name) {
        return getNodeAccessibleName(node) === selector.name;
      }
      return true;
    }
    default:
      return false;
  }
}

function webViewNodeMatchesSelector(node: HierarchyNode, selector: ParsedSelector): boolean {
  const tag = node.attributes.get('webview-tag') ?? '';
  const id = node.attributes.get('webview-id') ?? '';
  const text = node.attributes.get('text') ?? '';
  const ariaLabel = node.attributes.get('content-desc') ?? '';
  const placeholder = node.attributes.get('hint') ?? '';
  const testId = node.attributes.get('webview-testid') ?? '';
  const cssClass = node.attributes.get('webview-class') ?? '';

  switch (selector.type) {
    case 'wv-text':
      return text === selector.value;
    case 'wv-text-contains':
      return text.includes(selector.value);
    case 'wv-role': {
      const role = getNodeRole(node);
      if (role !== selector.value) return false;
      if (selector.name) {
        return (ariaLabel || text || placeholder) === selector.name;
      }
      return true;
    }
    case 'wv-label':
      return ariaLabel === selector.value;
    case 'wv-placeholder':
      return placeholder === selector.value;
    case 'wv-testid':
      return testId === selector.value;
    case 'wv-locator':
      return matchCssSelector(selector.value, tag, id, cssClass);
    default:
      return false;
  }
}

function matchCssSelector(css: string, tag: string, id: string, cssClass: string): boolean {
  // Simple CSS selector matching for the playground
  // Supports: #id, .class, tag, tag.class, tag#id
  const trimmed = css.trim();

  if (trimmed.startsWith('#')) {
    return id === trimmed.slice(1);
  }
  if (trimmed.startsWith('.')) {
    return cssClass.split(/\s+/).includes(trimmed.slice(1));
  }

  // tag#id
  const tagIdMatch = trimmed.match(/^(\w+)#(\S+)$/);
  if (tagIdMatch) {
    return tag === tagIdMatch[1] && id === tagIdMatch[2];
  }

  // tag.class
  const tagClassMatch = trimmed.match(/^(\w+)\.(\S+)$/);
  if (tagClassMatch) {
    return tag === tagClassMatch[1] && cssClass.split(/\s+/).includes(tagClassMatch[2]);
  }

  // tag only
  return tag === trimmed;
}

/**
 * Collapse accessibility-tree duplicates targeting the same visual element —
 * the TS-matcher mirror of the SDK's collapseSameTargetDuplicates (the iOS
 * tree exposes some text elements twice: an attribute-carrying parent and an
 * inner child with identical text and pixel-identical bounds). Keeping them
 * distinct would make playground counts and .nth() suffixes disagree with
 * runtime resolution (PILOT-226).
 */
function collapseSameTargetNodes(nodes: HierarchyNode[]): HierarchyNode[] {
  if (nodes.length < 2) return nodes;
  const seen = new Set<string>();
  const result: HierarchyNode[] = [];
  for (const node of nodes) {
    const bounds = getNodeBounds(node);
    if (!bounds || bounds.right - bounds.left <= 0 || bounds.bottom - bounds.top <= 0) {
      result.push(node);
      continue;
    }
    const key = `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}|${getNodeText(node)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(node);
  }
  return result;
}

/**
 * Resolve a positional chain (.first()/.last()/.nth(n), negative n counting
 * from the end) to a concrete index. May be out of range — callers decide
 * whether that means "empty result" or an error.
 */
export function resolvePositionalIndex(count: number, index: number | 'first' | 'last'): number {
  if (index === 'first') return 0;
  if (index === 'last') return count - 1;
  return index < 0 ? count + index : index;
}

/** Apply a parsed positional chain to a match list (out of range → empty). */
export function applyPositionalIndex<T>(items: T[], index: ParsedSelector['index']): T[] {
  if (index === undefined) return items;
  const idx = resolvePositionalIndex(items.length, index);
  return idx >= 0 && idx < items.length ? [items[idx]] : [];
}

export function findMatchingNodes(roots: HierarchyNode[], selector: ParsedSelector): HierarchyNode[] {
  const raw: HierarchyNode[] = [];

  function walk(node: HierarchyNode) {
    if (nodeMatchesSelector(node, selector)) {
      raw.push(node);
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  for (const root of roots) {
    walk(root);
  }

  return applyPositionalIndex(collapseSameTargetNodes(raw), selector.index);
}

export function getNodeBounds(node: HierarchyNode): Bounds | null {
  const boundsStr = node.attributes.get('bounds');
  if (!boundsStr) return null;
  return parseBounds(boundsStr);
}

// ─── Hit Testing ───

function boundsContains(bounds: Bounds, x: number, y: number): boolean {
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function boundsArea(bounds: Bounds): number {
  return (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
}

export function hitTest(roots: HierarchyNode[], x: number, y: number): HierarchyNode | null {
  let best: HierarchyNode | null = null;
  let bestArea = Infinity;
  let bestIsWebView = false;

  function walk(node: HierarchyNode) {
    const bounds = getNodeBounds(node);
    if (bounds && boundsContains(bounds, x, y)) {
      const area = boundsArea(bounds);
      const isWv = node.attributes.get('webview') === 'true';
      // Prefer WebView DOM nodes over native nodes at similar coordinates —
      // UIAutomator2/XCUITest also expose web content as native elements,
      // but the WebView DOM nodes produce better selectors (CSS-based).
      const shouldReplace = isWv && !bestIsWebView
        ? area <= bestArea * 1.5   // WebView node wins unless much larger
        : !isWv && bestIsWebView
          ? false                   // Never replace a WebView node with native
          : area <= bestArea;        // Same category: smallest wins (equal picks deeper node)
      if (shouldReplace) {
        best = node;
        bestArea = area;
        bestIsWebView = isWv;
      }
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  for (const root of roots) {
    walk(root);
  }
  return best;
}
