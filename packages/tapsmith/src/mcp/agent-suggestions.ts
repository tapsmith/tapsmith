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
import type { ElementInfo, EvaluateSelectorsResponse, SelectorEvaluation } from '../grpc-client.js';
import { parseSelectorToInternal } from './locator-helper.js';

/** The one RPC this module needs (a TapsmithGrpcClient in production). */
export interface SelectorEvaluator {
  evaluateSelectors(selectors: Selector[]): Promise<EvaluateSelectorsResponse>
}

export interface AgentSuggestions {
  /** Each node's validated suggestions, best first; a node with none is absent. */
  byNode: Map<HierarchyNode, GeneratedSelector[]>
  /** Set when checking stopped early: only what was checked is offered. */
  errorMessage?: string
  /** Which stage stopped: the candidates themselves (some nodes may have no
   *  suggestion), or the variants that pin an ambiguous one (those fall back
   *  to a position, `.nth()`). */
  stoppedAt?: 'candidates' | 'variants'
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

type Box = NonNullable<ReturnType<typeof parseBounds>>;

function sameBounds(a: ElementInfo['bounds'], b: Box): boolean {
  return !!a && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

function within(a: ElementInfo['bounds'], b: Box): boolean {
  return !!a && a.right > a.left && a.bottom > a.top
    && a.left >= b.left && a.top >= b.top && a.right <= b.right && a.bottom <= b.bottom;
}

/** The names a dump node carries: Android text and content-desc, iOS value and label. */
function nodeNames(node: HierarchyNode): string[] {
  return ['text', 'value', 'label', 'content-desc']
    .map((key) => node.attributes.get(key) ?? '')
    .filter(Boolean);
}

/**
 * Where the node is among the agent's matches, or -1 when none is it. A
 * match is the node when it has the node's bounds and either its class or
 * its name — text or accessibility label (the runtime treats same bounds and
 * text as one target, which an iOS parent and its inner text share). Android's dump clips bounds only to the display and the
 * window while finds also clip to the first scrollable ancestor, so a row
 * partly scrolled out of a list is the node too when it lies within the
 * node's bounds with both its class and its name. The closest such match
 * wins; a tie for closest identifies nothing.
 */
function indexOfNode(matches: ElementInfo[], node: HierarchyNode): number {
  const bounds = parseBounds(node.attributes.get('bounds') ?? '');
  if (!bounds || bounds.right - bounds.left <= 0 || bounds.bottom - bounds.top <= 0) return -1;
  const className = node.attributes.get('class') || node.attributes.get('type') || '';
  const names = nodeNames(node);
  let best = -1;
  let bestRank = 0;
  let tied = false;
  for (const [i, m] of matches.entries()) {
    const sameClass = !!className && m.className === className;
    const sameName = names.some((n) => n === m.text || n === m.contentDescription);
    const rank = sameBounds(m.bounds, bounds)
      ? (sameClass ? (sameName ? 4 : 3) : sameName ? 2 : 0)
      : (sameClass && sameName && within(m.bounds, bounds) ? 1 : 0);
    if (rank > bestRank) {
      best = i;
      bestRank = rank;
      tied = false;
    } else if (rank > 0 && rank === bestRank) {
      tied = true;
    }
  }
  // Two equally good candidates (a same-size wrapper and its child, neither
  // named apart): which one is the node can't be told, so neither is.
  return tied ? -1 : best;
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

/** Selectors per evaluateSelectors call: each call is one capture, and a
 *  short one, so a slow device (Android below API 34 re-reads every node per
 *  selector) or a re-rendering screen costs one chunk, not the whole screen. */
const CHUNK_SIZE = 40;
/** Wall-clock budget for checking one screen; later chunks are skipped. */
const CHECK_BUDGET_MS = 20_000;

/**
 * Evaluate `codes` in chunks, in order, stopping at the first failed chunk or
 * once the budget is spent. Returns what was evaluated and why it stopped.
 */
async function evaluateInChunks(
  evaluator: SelectorEvaluator,
  codes: string[],
  selectorOf: Map<string, Selector>,
  results: Map<string, SelectorEvaluation>,
  deadline: number,
): Promise<string | undefined> {
  for (let start = 0; start < codes.length; start += CHUNK_SIZE) {
    if (Date.now() >= deadline) {
      return `checking took longer than ${CHECK_BUDGET_MS / 1000} s; ${codes.length - start} candidate(s) were not checked`;
    }
    const chunk = codes.slice(start, start + CHUNK_SIZE);
    let response: EvaluateSelectorsResponse;
    try {
      response = await evaluator.evaluateSelectors(chunk.map((code) => selectorOf.get(code)!));
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    if (response.errorMessage) return response.errorMessage;
    if (response.results.length !== chunk.length) {
      return `agent returned ${response.results.length} result(s) for ${chunk.length} selector(s)`;
    }
    chunk.forEach((code, i) => results.set(code, response.results[i]));
  }
  return undefined;
}

/**
 * Generate candidates for every node, have the agent evaluate them, and keep,
 * per node, the ones that resolve to exactly that node (sorted best first).
 *
 * Base candidates go first, best-ranked first; the variants that could pin an
 * ambiguous one go second, and only for the candidates the agent found
 * ambiguous. If checking stops early (an agent error, the budget), what was
 * checked is still offered and `errorMessage` says why the rest is not: there
 * is no other matcher to fall back to.
 */
export async function agentValidatedSuggestions(
  evaluator: SelectorEvaluator,
  nodes: HierarchyNode[],
): Promise<AgentSuggestions> {
  const { ladders, codes: selectorOf } = candidateLadders(nodes);
  const results = new Map<string, SelectorEvaluation>();
  const matchesOf = (code: string): ElementInfo[] | null => {
    const result = results.get(code);
    return !result || result.errorMessage ? null : collapseSameTargetDuplicates(result.elements ?? []);
  };
  const deadline = Date.now() + CHECK_BUDGET_MS;

  const all = [...ladders.values()].flat();
  const bases = [...new Set([...all].sort((a, b) => a.base.priority - b.base.priority).map((l) => l.base.code))];
  let errorMessage = await evaluateInChunks(evaluator, bases, selectorOf, results, deadline);
  let stoppedAt: AgentSuggestions['stoppedAt'] = errorMessage ? 'candidates' : undefined;

  if (!errorMessage) {
    const upgrades = new Set<string>();
    for (const [node, nodeLadders] of ladders) {
      for (const ladder of nodeLadders) {
        const matches = matchesOf(ladder.base.code);
        if (!matches || matches.length < 2 || indexOfNode(matches, node) === -1) continue;
        for (const u of ladder.upgrades) if (!results.has(u.code)) upgrades.add(u.code);
      }
    }
    errorMessage = await evaluateInChunks(evaluator, [...upgrades], selectorOf, results, deadline);
    if (errorMessage) stoppedAt = 'variants';
  }

  const byNode = decideAll(ladders, matchesOf);
  return errorMessage ? { byNode, errorMessage, stoppedAt } : { byNode };
}
