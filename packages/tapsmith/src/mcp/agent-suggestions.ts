/**
 * Locator suggestions validated by the device agent (PILOT-848).
 *
 * Candidates are still generated here from the hierarchy dump, but whether a
 * candidate matches, and how many times, is decided by the agent's own
 * matching — the code a test resolves locators with — through one
 * evaluateSelectors batch per screen. A candidate is offered only when the
 * agent resolves it to the node it is attached to, so a suggestion can't
 * drift from runtime the way the TypeScript re-implementation did
 * (PILOT-833).
 */

import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { parseBounds } from '../trace-viewer/components/hierarchy-utils.js';
import type { GeneratedSelector } from '../trace-viewer/components/selector-generation.js';
import { generateSelectors, glyphAware, roleNameFor } from '../trace-viewer/components/selector-generation.js';
import { parseSelectorString } from '../trace-viewer/components/selector-matching.js';
import { escapeJsString } from '../js-string-escape.js';
import type { Selector } from '../selectors.js';
import { collapseSameTargetDuplicates } from '../element-handle.js';
import type { ElementInfo, EvaluateSelectorsResponse } from '../grpc-client.js';
import { parseSelectorToInternal } from './locator-helper.js';

/** The one RPC this module needs (a TapsmithGrpcClient in production). */
export interface SelectorEvaluator {
  evaluateSelectors(selectors: Selector[]): Promise<EvaluateSelectorsResponse>
}

export interface AgentSuggestions {
  /** Each node's validated suggestions, best first; a node with none is absent. */
  byNode: Map<HierarchyNode, GeneratedSelector[]>
  /** Set when the agent could not evaluate the batch: nothing is offered. */
  errorMessage?: string
}

/** Demoted priority of a suggestion pinned by position (`.nth()`), as before. */
const POSITIONAL_PRIORITY = 8;

// ─── Candidates ───

/** A base candidate and the variants that may pin it when it is ambiguous. */
interface CandidateLadder {
  base: GeneratedSelector
  /** In preference order; each replaces the base when the agent resolves it uniquely. */
  upgrades: GeneratedSelector[]
}

/** The node's whole accessible name, as role-name matching reads it first. */
function fullAccessibleName(node: HierarchyNode): string {
  return node.attributes.get('content-desc') || node.attributes.get('label') || node.attributes.get('text') || '';
}

/**
 * The variants that can pin an ambiguous candidate to this node: an exact
 * text match, an exact role name (the glyph-free name, then the full name),
 * or a name added to a nameless role.
 */
function upgradesFor(s: GeneratedSelector, node: HierarchyNode): GeneratedSelector[] {
  const parsed = parseSelectorString(s.code);
  if (!parsed) return [];
  if (parsed.type === 'textContains') {
    return [{ ...s, code: `device.getByText("${escapeJsString(parsed.value)}", { exact: true })` }];
  }
  if (parsed.type !== 'role' || parsed.nameRegex) return [];
  const role = escapeJsString(parsed.value);
  if (parsed.name && !parsed.exact) {
    const names = [parsed.name, fullAccessibleName(node)].filter((n, i, all) => n && all.indexOf(n) === i);
    return names.map((name) => ({
      ...s,
      code: `device.getByRole("${role}", { name: "${escapeJsString(name)}", exact: true })`,
      // The full name may pin a glyph: rank it like any glyph-pinned locator.
      priority: glyphAware(s.priority, name),
    }));
  }
  if (parsed.name) return [];
  const fullName = fullAccessibleName(node);
  const accessibleName = roleNameFor(fullName) || fullName;
  if (!accessibleName) return [];
  return ['', ', exact: true'].map((exact) => ({
    ...s,
    code: `device.getByRole("${role}", { name: "${escapeJsString(accessibleName)}"${exact} })`,
    label: 'Role + name',
    priority: glyphAware(s.priority, accessibleName),
  }));
}

/** The selector a candidate's code builds, or null when it can't be evaluated natively. */
function selectorFor(code: string): Selector | null {
  try {
    const { selector, index } = parseSelectorToInternal(code);
    // Generated candidates carry no position; one that did would be
    // evaluated without it.
    return index === undefined ? selector : null;
  } catch {
    // WebView (`webview.*`) candidates have no native selector.
    return null;
  }
}

// ─── Node identity ───

function sameBounds(a: ElementInfo['bounds'], b: ReturnType<typeof parseBounds>): boolean {
  return !!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/**
 * Where the node is among the agent's matches: the match at the node's
 * (non-degenerate) bounds, preferring one of the node's own class when two
 * share them (a same-size wrapper and its child). -1 when none is the node.
 */
function indexOfNode(matches: ElementInfo[], node: HierarchyNode): number {
  const bounds = parseBounds(node.attributes.get('bounds') ?? '');
  if (!bounds || bounds.right - bounds.left <= 0 || bounds.bottom - bounds.top <= 0) return -1;
  const className = node.attributes.get('class') ?? node.attributes.get('type') ?? '';
  let first = -1;
  for (const [i, m] of matches.entries()) {
    if (!sameBounds(m.bounds, bounds)) continue;
    if (className && m.className === className) return i;
    if (first === -1) first = i;
  }
  return first;
}

// ─── Decision ───

/**
 * Decide one ladder from the agent's results: unique and the node → the
 * base; the node among several → the first upgrade the agent resolves to
 * exactly the node, else the base pinned by the node's position in the
 * agent's own match order (the order `.nth()` resolves by); not the node →
 * nothing.
 */
function decide(
  ladder: CandidateLadder,
  node: HierarchyNode,
  matchesOf: (code: string) => ElementInfo[] | null,
): GeneratedSelector | null {
  const matches = matchesOf(ladder.base.code);
  if (!matches) return null;
  const idx = indexOfNode(matches, node);
  if (idx === -1) return null;
  if (matches.length === 1) return ladder.base;

  for (const upgrade of ladder.upgrades) {
    const upgraded = matchesOf(upgrade.code);
    if (upgraded?.length === 1 && indexOfNode(upgraded, node) === 0) return upgrade;
  }

  const suffix = idx === 0 ? '.first()' : idx === matches.length - 1 ? '.last()' : `.nth(${idx})`;
  return {
    ...ladder.base,
    code: `${ladder.base.code}${suffix}`,
    label: `${ladder.base.label} (${matches.length} matches)`,
    priority: Math.max(ladder.base.priority, POSITIONAL_PRIORITY),
  };
}

/**
 * Every node's candidate ladders, and each distinct candidate code once, in
 * the order they were generated. WebView candidates (no native selector) are
 * left out.
 */
function candidateLadders(nodes: HierarchyNode[]): { ladders: Map<HierarchyNode, CandidateLadder[]>; codes: Map<string, Selector> } {
  const ladders = new Map<HierarchyNode, CandidateLadder[]>();
  const codes = new Map<string, Selector>();
  const enqueue = (code: string): boolean => {
    if (codes.has(code)) return true;
    const selector = selectorFor(code);
    if (!selector) return false;
    codes.set(code, selector);
    return true;
  };
  for (const node of nodes) {
    if (ladders.has(node)) continue;
    const nodeLadders: CandidateLadder[] = [];
    for (const base of generateSelectors(node)) {
      if (!enqueue(base.code)) continue;
      nodeLadders.push({ base, upgrades: upgradesFor(base, node).filter((u) => enqueue(u.code)) });
    }
    ladders.set(node, nodeLadders);
  }
  return { ladders, codes };
}

/**
 * Each node's suggestions, best first, decided by `matchesOf` — what a
 * candidate's code resolves to, in match order (null: it failed). The agent
 * answers it in production ({@link agentValidatedSuggestions}); tests of
 * candidate generation can answer it from a fixture.
 */
export function suggestionsFromMatches(
  nodes: HierarchyNode[],
  matchesOf: (code: string) => ElementInfo[] | null,
): Map<HierarchyNode, GeneratedSelector[]> {
  return decideAll(candidateLadders(nodes).ladders, matchesOf);
}

function decideAll(
  ladders: Map<HierarchyNode, CandidateLadder[]>,
  matchesOf: (code: string) => ElementInfo[] | null,
): Map<HierarchyNode, GeneratedSelector[]> {
  // The runtime collapses an element listed twice (iOS parent + inner
  // child) before counting; so does every decision here.
  const collapsed = (code: string) => {
    const matches = matchesOf(code);
    return matches ? collapseSameTargetDuplicates(matches) : null;
  };
  const byNode = new Map<HierarchyNode, GeneratedSelector[]>();
  for (const [node, nodeLadders] of ladders) {
    const suggestions = nodeLadders
      .map((ladder) => decide(ladder, node, collapsed))
      .filter((s): s is GeneratedSelector => s !== null)
      .sort((a, b) => a.priority - b.priority);
    if (suggestions.length > 0) byNode.set(node, suggestions);
  }
  return byNode;
}

/**
 * Generate candidates for every node, have the agent evaluate all of them in
 * one batch, and keep, per node, the ones that resolve to exactly that node
 * (sorted best first). On a failed batch nothing is offered: there is no
 * other matcher to fall back to.
 */
export async function agentValidatedSuggestions(
  evaluator: SelectorEvaluator,
  nodes: HierarchyNode[],
): Promise<AgentSuggestions> {
  const { ladders, codes } = candidateLadders(nodes);
  if (codes.size === 0) return { byNode: new Map() };

  const selectors = [...codes.values()];
  let response: EvaluateSelectorsResponse;
  try {
    response = await evaluator.evaluateSelectors(selectors);
  } catch (err) {
    return { byNode: new Map(), errorMessage: err instanceof Error ? err.message : String(err) };
  }
  if (response.errorMessage) return { byNode: new Map(), errorMessage: response.errorMessage };
  if (response.results.length !== selectors.length) {
    return {
      byNode: new Map(),
      errorMessage: `agent returned ${response.results.length} result(s) for ${selectors.length} selector(s)`,
    };
  }

  const resultByCode = new Map([...codes.keys()].map((code, i) => [code, response.results[i]]));
  return {
    byNode: decideAll(ladders, (code) => {
      const result = resultByCode.get(code);
      return !result || result.errorMessage ? null : (result.elements ?? []);
    }),
  };
}
