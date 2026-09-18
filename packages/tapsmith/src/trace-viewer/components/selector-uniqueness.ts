/**
 * Selector uniqueness validation (PILOT-226).
 *
 * Suggested locators must resolve to exactly one element under RUNTIME
 * matching semantics — an ambiguous suggestion now throws a strict mode
 * violation the moment a test acts on it. Shared by the locator playground
 * (trace viewer / UI mode) and the MCP snapshot tool.
 */

import type { HierarchyNode } from './hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes, getNodeBounds } from './selector-matching.js';
import type { GeneratedSelector } from './selector-generation.js';

function escapeQuotes(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Identity check across separately parsed hierarchy trees: reference equality
 * when the trees are shared (snapshot formatter), full attribute equality
 * otherwise (playground re-parses the XML). Truly identical siblings remain
 * ambiguous under attribute equality, but any of them is an equally valid pick.
 */
function nodeText(n: HierarchyNode): string {
  return n.attributes.get('text') ?? n.attributes.get('label') ?? n.attributes.get('value') ?? '';
}

/**
 * Same visual element under the duplicate-collapsing rule (identical text +
 * identical non-degenerate bounds). The iOS tree exposes some elements twice
 * (attribute-carrying parent + inner child); findMatchingNodes collapses
 * them to the first occurrence, so a picked CHILD must still be recognised
 * as its collapsed parent representative — otherwise iOS picks would read
 * as "(may not match)" instead of getting a .first()/.nth() suffix.
 */
function sameVisualElement(a: HierarchyNode, b: HierarchyNode): boolean {
  const ab = a.attributes.get('bounds');
  if (!ab || ab !== b.attributes.get('bounds')) return false;
  const bounds = getNodeBounds(a);
  if (!bounds || bounds.right - bounds.left <= 0 || bounds.bottom - bounds.top <= 0) return false;
  return nodeText(a) === nodeText(b);
}

function nodeIndexIn(matches: HierarchyNode[], node: HierarchyNode): number {
  const byRef = matches.indexOf(node);
  if (byRef !== -1) return byRef;
  const byAttrs = matches.findIndex((m) => {
    if (m.tagName !== node.tagName || m.depth !== node.depth) return false;
    if (m.attributes.size !== node.attributes.size) return false;
    for (const [k, v] of m.attributes) {
      if (node.attributes.get(k) !== v) return false;
    }
    return true;
  });
  if (byAttrs !== -1) return byAttrs;
  return matches.findIndex((m) => sameVisualElement(m, node));
}

/** Does `code` parse and resolve to exactly the picked node? */
function uniquelyMatches(code: string, roots: HierarchyNode[], node: HierarchyNode): boolean {
  const parsed = parseSelectorString(code);
  if (!parsed) return false;
  const matches = findMatchingNodes(roots, parsed);
  return matches.length === 1 && nodeIndexIn(matches, node) === 0;
}

/** (a) Ambiguous substring getByText → try the { exact: true } variant. */
function tryExactTextUpgrade(
  s: GeneratedSelector,
  roots: HierarchyNode[],
  node: HierarchyNode,
): GeneratedSelector | null {
  const parsed = parseSelectorString(s.code);
  if (!parsed) return null;
  let upgraded: string;
  // parseSelectorString returns RAW (unescaped) values — re-escape for the
  // generated code string, whatever quoting the original suggestion used.
  const value = escapeQuotes(parsed.value);
  if (parsed.type === 'textContains') {
    upgraded = `device.getByText("${value}", { exact: true })`;
  } else if (parsed.type === 'wv-text-contains') {
    upgraded = `webview.getByText("${value}", { exact: true })`;
  } else {
    return null;
  }
  if (!uniquelyMatches(upgraded, roots, node)) return null;
  return { ...s, code: upgraded };
}

/** (b) Ambiguous getByRole without a name → try adding the accessible name. */
function tryRoleNameUpgrade(
  s: GeneratedSelector,
  roots: HierarchyNode[],
  node: HierarchyNode,
): GeneratedSelector | null {
  const parsed = parseSelectorString(s.code);
  if (!parsed || parsed.type !== 'role' || parsed.name) return null;
  const accessibleName =
    node.attributes.get('content-desc') || node.attributes.get('label') || node.attributes.get('text') || '';
  if (!accessibleName) return null;
  const upgraded = `device.getByRole("${parsed.value}", { name: "${escapeQuotes(accessibleName)}" })`;
  if (!uniquelyMatches(upgraded, roots, node)) return null;
  return { ...s, code: upgraded, label: 'Role + name' };
}

/**
 * Validate each suggested selector against the hierarchy and rewrite the
 * ambiguous ones so every suggestion resolves to exactly the picked node:
 *
 * 1. Unique already → keep as-is.
 * 2. Doesn't resolve to the picked node → mark "(may not match)" and demote.
 * 3. Ambiguous → upgrade ladder: `{ exact: true }` text variant, then
 *    getByRole `{ name }`, both kept at full priority when they pin the
 *    node uniquely; otherwise append `.first()/.nth(i)/.last()` and demote.
 *
 * Returns suggestions sorted by priority.
 */
export function disambiguateSelectors(
  roots: HierarchyNode[],
  node: HierarchyNode,
  suggestions: GeneratedSelector[],
): GeneratedSelector[] {
  if (roots.length === 0) return suggestions;
  return suggestions.map((s) => {
    const parsed = parseSelectorString(s.code);
    if (!parsed) return s;
    const matches = findMatchingNodes(roots, parsed);
    const idx = nodeIndexIn(matches, node);
    if (idx === -1) {
      // The selector doesn't resolve to the picked node — don't offer it
      // as a top suggestion.
      return { ...s, label: `${s.label} (may not match)`, priority: Math.max(s.priority, 8), mayNotMatch: true };
    }
    if (matches.length <= 1) return s;

    const upgraded = tryExactTextUpgrade(s, roots, node) ?? tryRoleNameUpgrade(s, roots, node);
    if (upgraded) return upgraded;

    const nthSuffix = idx === 0 ? '.first()' : idx === matches.length - 1 ? '.last()' : `.nth(${idx})`;
    return {
      ...s,
      code: `${s.code}${nthSuffix}`,
      label: `${s.label} (${matches.length} matches)`,
      priority: Math.max(s.priority, 8),
    };
  }).sort((a, b) => a.priority - b.priority);
}
