/**
 * The screen a failed test left the device on (PILOT-1241).
 *
 * The runner resets the app before a file or test, never after one, and
 * nothing else touches the screen once a run ends: after a run of one test
 * that failed, the device is still on the screen where it failed. This module
 * tells an agent so, and lists the elements on that screen closest to the
 * locator that matched nothing, so the agent can try a fix against the live
 * app (tapsmith_test_locator) instead of navigating back there itself.
 *
 * It only reads: nothing here holds the device or skips a reset. The next
 * run resets the app as usual.
 */

import { distance } from 'fastest-levenshtein';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import { getNodeRole, parseHierarchyXml, type HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { escapeJsString } from '../js-string-escape.js';
import { agentValidatedSuggestions } from './agent-suggestions.js';
import { semanticNodes } from './hierarchy-formatter.js';
import type { TestFailureDetail, TestRunResult } from './test-dispatcher.js';
import type { TraceSummary } from './tools/trace-utils.js';

/** Elements listed at most. */
const MAX_CLOSEST = 3;
/** Candidates checked per element listed, for the duplicates left out. */
const CANDIDATES_PER_LISTED = 2;
/** The least similarity (0–1) an element needs to be listed as close. */
const MIN_SIMILARITY = 0.5;
/** Selectors per agent call on iOS, where each call costs one capture (as tapsmith_snapshot). */
const IOS_CHUNK_SIZE = 500;
const SHOWN_TEXT_CHARS = 60;

/** How sure the result can be that the device is still on the failure screen. */
export type HeldConfidence =
  /** The trace shows nothing acted on the device after the failed step. */
  | 'confirmed'
  /**
   * No trace to check, but the failure is a locator miss, so the test did
   * reach the device: only its own hooks could have moved it since.
   */
  | 'unchecked';

export interface HeldFailure {
  failure: TestFailureDetail
  confidence: HeldConfidence
}

/**
 * The failure the device is still showing, or undefined when that cannot be
 * said: more than one test ran (a later one moved the screen, or which
 * failure it shows is unclear), a step ran on the device after the failed one
 * (an `afterEach` or `afterAll` hook), or a device group ran it. Without a
 * trace to check, only a locator miss is held (`unchecked`): any other
 * failure may never have reached the device (a file that did not load).
 */
export function heldFailureOf(
  result: Pick<TestRunResult, 'status' | 'passed' | 'failed' | 'failures'>,
  readTrace: (tracePath: string) => TraceSummary | undefined,
  isLocatorMiss: (error: string) => boolean,
): HeldFailure | undefined {
  if (result.status === 'stopped') return undefined;
  if (result.failed !== 1 || result.passed !== 0) return undefined;
  const failure = result.failures?.length === 1 ? result.failures[0] : undefined;
  if (!failure) return undefined;
  const summary = failure.tracePath ? readTrace(failure.tracePath) : undefined;
  if (!summary) return isLocatorMiss(failure.error) ? { failure, confidence: 'unchecked' } : undefined;
  if (summary.multiDevice || !summary.endsOnFailedStep) return undefined;
  return { failure, confidence: 'confirmed' };
}

// ─── Closest elements ───

/** A string literal in locator source, double- or single-quoted. */
const STRING_LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
/** A getByRole's role argument, which names a role rather than words on screen. */
const ROLE_ARGUMENT = /getByRole\(\s*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;

function unescapeLiteral(body: string): string {
  return body.replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[c] ?? c);
}

/**
 * The words a locator looks for: its string literals, without a getByRole's
 * role name. A RegExp needle is not a word and is left out.
 */
export function locatorNeedles(locator: string): string[] {
  const source = locator.replace(ROLE_ARGUMENT, 'getByRole(');
  const needles: string[] = [];
  for (const m of source.matchAll(STRING_LITERAL)) {
    const value = unescapeLiteral(m[1] ?? m[2] ?? '').trim();
    if (value && !needles.includes(value)) needles.push(value);
  }
  return needles;
}

/** What a node shows or is known by: the values the getters match. */
function nodeStrings(node: HierarchyNode): string[] {
  const a = node.attributes;
  const out: string[] = [];
  for (const key of ['text', 'label', 'content-desc', 'hint', 'placeholderValue', 'identifier', 'name']) {
    const v = a.get(key)?.trim();
    if (v) out.push(v);
  }
  // An Android resource id is matched by its entry name (`…:id/submit` → `submit`).
  const resourceId = a.get('resource-id')?.trim();
  if (resourceId) out.push(resourceId.slice(resourceId.lastIndexOf('/') + 1));
  return out;
}

/**
 * How alike two strings are, 0–1, ignoring case: 1 when equal, high when one
 * contains the other, otherwise by edit distance.
 */
export function similarity(a: string, b: string): number {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const shorter = Math.min(x.length, y.length);
  const longer = Math.max(x.length, y.length);
  const byDistance = 1 - distance(x, y) / longer;
  // "Sign in" inside "Sign in to continue": close whatever the length gap,
  // as long as the shorter one is a word rather than a letter or two.
  const contained = shorter >= 3 && (x.includes(y) || y.includes(x)) ? 0.75 + 0.2 * (shorter / longer) : 0;
  return Math.max(byDistance, contained);
}

/** The nodes closest to `needles`, best first, at most `limit`. */
export function closestNodes(nodes: HierarchyNode[], needles: string[], limit = MAX_CLOSEST): HierarchyNode[] {
  if (needles.length === 0) return [];
  const scored = nodes
    .map((node, index) => {
      const strings = nodeStrings(node);
      let score = 0;
      for (const s of strings) for (const n of needles) score = Math.max(score, similarity(s, n));
      return { node, index, score };
    })
    .filter((s) => s.score >= MIN_SIMILARITY);
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.node);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** A node as tapsmith_snapshot's tree shows it: role (or type) and text. */
export function describeNode(node: HierarchyNode): string {
  const role = getNodeRole(node) || node.attributes.get('class') || node.attributes.get('type') || node.tagName;
  const a = node.attributes;
  const text = a.get('text') || a.get('label') || a.get('content-desc') || a.get('hint') || a.get('placeholderValue') || '';
  return text ? `${role} "${escapeJsString(truncate(text, SHOWN_TEXT_CHARS))}"` : role;
}

export interface ClosestElement {
  description: string
  /** A locator the device agent resolved to exactly this element, when one was found. */
  locator?: string
}

export type ClosestResult =
  | { kind: 'matches'; elements: ClosestElement[] }
  /** The locator has no words to compare (a role alone, a RegExp, an id with no string). */
  | { kind: 'no-words' }
  | { kind: 'error'; message: string };

/**
 * The elements on the device's current screen closest to what `locator`
 * looked for, each with a locator the agent checked resolves to it alone.
 */
export async function closestOnScreen(
  client: Pick<TapsmithGrpcClient, 'getUiHierarchy' | 'evaluateSelectors'>,
  locator: string,
): Promise<ClosestResult> {
  const needles = locatorNeedles(locator);
  if (needles.length === 0) return { kind: 'no-words' };
  const { hierarchyXml, errorMessage } = await client.getUiHierarchy();
  if (errorMessage) return { kind: 'error', message: errorMessage };
  // A few spare candidates: one element can be listed twice (an iOS
  // element and the container reporting the same label), and each is shown once.
  const nodes = closestNodes(semanticNodes(parseHierarchyXml(hierarchyXml)), needles, MAX_CLOSEST * CANDIDATES_PER_LISTED);
  if (nodes.length === 0) return { kind: 'matches', elements: [] };
  const ios = hierarchyXml.includes('<XCUIElementType');
  const { byNode } = await agentValidatedSuggestions(client, nodes, ios ? { chunkSize: IOS_CHUNK_SIZE } : {});
  const elements: ClosestElement[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const element = { description: describeNode(node), locator: byNode.get(node)?.[0]?.code };
    const key = element.locator ?? `${element.description}@${node.attributes.get('bounds') ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push(element);
    if (elements.length === MAX_CLOSEST) break;
  }
  return { kind: 'matches', elements };
}

// ─── The result's lines ───

export interface FailureScreenOptions {
  held: HeldFailure
  /** The locator the failure says matched nothing, if it is a locator miss. */
  missedLocator?: string
  /** The client of the device the test ran on; rejects when that is unclear. */
  client: () => Promise<Pick<TapsmithGrpcClient, 'getUiHierarchy' | 'evaluateSelectors'>>
}

/**
 * The lines `tapsmith_run_tests` adds for a failure the device still shows:
 * that it is held there, the closest elements for a locator miss, and the
 * next step. Never throws: a device it cannot read loses only the list.
 */
export async function failureScreenLines(opts: FailureScreenOptions): Promise<string[]> {
  const { held, missedLocator } = opts;
  const lines: string[] = [
    held.confidence === 'confirmed'
      ? `DEVICE HELD: the device is still on the screen where "${held.failure.fullName}" failed: it was the only test in the run, and nothing acted on the device after the failed step.`
      : `DEVICE HELD: the device was left where "${held.failure.fullName}" failed (it was the only test in the run; with no trace to check, an afterEach or afterAll hook that drives the device may have moved it since).`,
    'tapsmith_snapshot and tapsmith_test_locator act on that screen now. The next tapsmith_run_tests resets the app as usual.',
  ];
  if (!missedLocator) return lines;

  let closest: ClosestResult;
  try {
    closest = await closestOnScreen(await opts.client(), missedLocator);
  } catch (err) {
    closest = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  lines.push('');
  if (closest.kind === 'matches' && closest.elements.length > 0) {
    lines.push(`Closest on screen to ${missedLocator}:`);
    for (const e of closest.elements) {
      lines.push(e.locator ? `  - ${e.description}: ${e.locator}` : `  - ${e.description} (no locator finds it alone; tapsmith_snapshot lists it)`);
    }
  } else if (closest.kind === 'matches') {
    lines.push(`Nothing on screen is close to ${missedLocator}: tapsmith_snapshot shows what is there.`);
  } else if (closest.kind === 'error') {
    lines.push(`(Could not read the screen for the elements closest to ${missedLocator}: ${closest.message})`);
  }
  lines.push('');
  lines.push(
    'NEXT STEP: the locator matched nothing on this screen. Check a replacement with tapsmith_test_locator '
    + '(it must count exactly 1), change the test to use it, then run the test again with tapsmith_run_tests.',
  );
  return lines;
}
