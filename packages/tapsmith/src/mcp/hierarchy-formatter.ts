import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { getNodeRole } from '../trace-viewer/components/hierarchy-utils.js';
import type { GeneratedSelector } from '../trace-viewer/components/selector-generation.js';
import { escapeJsString } from '../js-string-escape.js';

interface FormattedResult {
  tree: string
  locators: string[]
}

interface RefEntry {
  ref: number
  selector: string
}

function getText(node: HierarchyNode): string {
  return node.attributes.get('text') ?? node.attributes.get('label') ?? '';
}

function getHint(node: HierarchyNode): string {
  return node.attributes.get('hint') ?? node.attributes.get('placeholderValue') ?? '';
}

function isInteractive(node: HierarchyNode): boolean {
  return node.attributes.get('clickable') === 'true'
    || node.attributes.get('focusable') === 'true'
    || node.attributes.get('scrollable') === 'true';
}

function getStates(node: HierarchyNode): string[] {
  const states: string[] = [];
  if (node.attributes.get('enabled') === 'false') states.push('disabled');
  if (node.attributes.get('focused') === 'true') states.push('focused');
  if (node.attributes.get('checked') === 'true') states.push('checked');
  if (node.attributes.get('selected') === 'true') states.push('selected');
  return states;
}

function isSemanticNode(node: HierarchyNode): boolean {
  const role = getNodeRole(node);
  if (role) return true;
  const text = getText(node);
  if (text) return true;
  if (isInteractive(node)) return true;
  return false;
}

function hasSemanticDescendant(node: HierarchyNode): boolean {
  if (isSemanticNode(node)) return true;
  return node.children.some(hasSemanticDescendant);
}

/** Each node's validated suggestions, best first (see agent-suggestions.ts). */
type Suggestions = Map<HierarchyNode, GeneratedSelector[]>;

function formatNode(
  node: HierarchyNode,
  depth: number,
  refs: RefEntry[],
  suggestions: Suggestions,
): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  const role = getNodeRole(node);
  const text = getText(node);
  const hint = getHint(node);
  const states = getStates(node);

  const isSemantic = isSemanticNode(node);

  if (isSemantic) {
    // Only suggestions the device agent resolved to exactly this node reach
    // here (PILOT-848), so a ref never strict-mode-fails or names another
    // element when a test acts on it.
    const best = suggestions.get(node)?.[0];
    let refTag = '';
    if (best) {
      const ref = refs.length + 1;
      refs.push({ ref, selector: best.code });
      refTag = `[${ref}] `;
    }

    const parts: string[] = [`${indent}- ${refTag}`];
    parts.push(role || node.tagName);
    // Values are shown the way a suggested locator spells them (PILOT-658):
    // decoded text, JS-escaped so a newline reads `\n` and the node stays on
    // one tree line. Truncate first so an escape is never cut in half.
    if (text) parts.push(` "${escapeJsString(truncate(text, 60))}"`);
    if (states.length > 0) parts.push(` [${states.join(', ')}]`);
    if (hint) parts.push(` placeholder="${escapeJsString(truncate(hint, 40))}"`);

    lines.push(parts.join(''));
  }

  const childDepth = isSemantic ? depth + 1 : depth;
  for (const child of node.children) {
    if (hasSemanticDescendant(child)) {
      lines.push(...formatNode(child, childDepth, refs, suggestions));
    }
  }

  return lines;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** The nodes the snapshot tree lists, in tree order: the ones that can get a ref. */
export function semanticNodes(roots: HierarchyNode[]): HierarchyNode[] {
  const out: HierarchyNode[] = [];
  const walk = (node: HierarchyNode) => {
    if (isSemanticNode(node)) out.push(node);
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

export function formatHierarchy(roots: HierarchyNode[], suggestions: Suggestions): FormattedResult {
  const refs: RefEntry[] = [];
  const lines: string[] = [];

  for (const root of roots) {
    if (hasSemanticDescendant(root)) {
      lines.push(...formatNode(root, 0, refs, suggestions));
    }
  }

  return {
    tree: lines.join('\n'),
    locators: refs.map(r => `[${r.ref}] ${r.selector}`),
  };
}
