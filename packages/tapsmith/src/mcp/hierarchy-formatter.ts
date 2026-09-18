import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { getNodeRole } from '../trace-viewer/components/hierarchy-utils.js';
import { generateSelectors } from '../trace-viewer/components/selector-generation.js';
import { disambiguateSelectors } from '../trace-viewer/components/selector-uniqueness.js';

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

function formatNode(
  node: HierarchyNode,
  depth: number,
  refs: RefEntry[],
  roots: HierarchyNode[],
): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  const role = getNodeRole(node);
  const text = getText(node);
  const hint = getHint(node);
  const states = getStates(node);

  const isSemantic = isSemanticNode(node);

  if (isSemantic) {
    // Disambiguate against the full hierarchy (PILOT-226): a suggested
    // locator that matches multiple elements would throw a strict mode
    // violation the moment a test acts on it.
    const selectors = disambiguateSelectors(roots, node, generateSelectors(node));
    let refTag = '';
    if (selectors.length > 0) {
      const ref = refs.length + 1;
      refs.push({ ref, selector: selectors[0].code });
      refTag = `[${ref}] `;
    }

    const parts: string[] = [`${indent}- ${refTag}`];
    parts.push(role || node.tagName);
    if (text) parts.push(` "${truncate(text, 60)}"`);
    if (states.length > 0) parts.push(` [${states.join(', ')}]`);
    if (hint) parts.push(` placeholder="${truncate(hint, 40)}"`);

    lines.push(parts.join(''));
  }

  const childDepth = isSemantic ? depth + 1 : depth;
  for (const child of node.children) {
    if (hasSemanticDescendant(child)) {
      lines.push(...formatNode(child, childDepth, refs, roots));
    }
  }

  return lines;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function formatHierarchy(roots: HierarchyNode[]): FormattedResult {
  const refs: RefEntry[] = [];
  const lines: string[] = [];

  for (const root of roots) {
    if (hasSemanticDescendant(root)) {
      lines.push(...formatNode(root, 0, refs, roots));
    }
  }

  return {
    tree: lines.join('\n'),
    locators: refs.map(r => `[${r.ref}] ${r.selector}`),
  };
}
