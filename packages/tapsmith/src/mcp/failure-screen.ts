/**
 * The screen a failed test left the device on.
 *
 * The runner resets the app before a file or test, never after one, and
 * nothing else touches the screen once a run ends: after a run of one test
 * that failed, the device is normally still on the screen where it failed.
 * What can move it is the test's own code after the failure (an `afterEach`
 * or `afterAll` hook, a fixture's teardown) or a later test of the run, and
 * the failure's trace does not record all of those. So "held" is only said
 * when the device itself shows it: its screen now matches the one the trace
 * captured at the failed step. Nothing else is taken as evidence. When they
 * differ (the step was captured when it started, and the app may have moved
 * on while it waited; or something moved it later; or this is not the device
 * that ran the test), the result says only that, and the agent checks the
 * screen with tapsmith_snapshot. Either way, for a locator that matched
 * nothing, it lists the elements on the device's screen closest to it, so
 * the agent can try a fix against the live app (tapsmith_test_locator)
 * instead of navigating back there itself.
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
/**
 * The share of what the two screens show that must be the same for them to
 * be one screen. Below 1 for what changes on a screen by itself (a clock, a
 * counter, a field the test typed into); two different screens of an app
 * share far less than this.
 */
const SAME_SCREEN_OVERLAP = 0.8;
/** Selectors per agent call on iOS, where each call costs one capture (as tapsmith_snapshot). */
const IOS_CHUNK_SIZE = 500;
const SHOWN_TEXT_CHARS = 60;
const SHOWN_LOCATOR_CHARS = 300;

/** A failed run of one test, and the screen its trace captured at the failed step, if any. */
export interface FailureCandidate {
  failure: TestFailureDetail
  /** See `TraceSummary.failureHierarchyXml`. */
  failureHierarchyXml?: string
}

/**
 * The failure whose screen the device may still show, or undefined when
 * there is none to speak of: more than one test ran (a later one may have
 * moved the screen, and which failure it would show is unclear), the failure
 * has no trace, or a device group ran it.
 */
export function failureCandidateOf(
  result: Pick<TestRunResult, 'status' | 'passed' | 'failed' | 'failures'>,
  readTrace: (tracePath: string) => TraceSummary | undefined,
): FailureCandidate | undefined {
  if (result.status === 'stopped') return undefined;
  if (result.failed !== 1 || result.passed !== 0) return undefined;
  const failure = result.failures?.length === 1 ? result.failures[0] : undefined;
  if (!failure?.tracePath) return undefined;
  const summary = readTrace(failure.tracePath);
  if (!summary || summary.multiDevice) return undefined;
  return { failure, failureHierarchyXml: summary.failureHierarchyXml };
}

/**
 * What a screen shows, as `role "text"` entries of the native nodes a
 * snapshot lists. WebView DOM nodes are left out: a trace captured with a
 * WebView active adds them, and a live hierarchy read has none.
 */
function screenEntries(hierarchyXml: string): Set<string> {
  const entries = new Set<string>();
  for (const node of semanticNodes(parseHierarchyXml(hierarchyXml))) {
    if (node.attributes.get('webview') === 'true') continue;
    const text = nodeStrings(node)[0];
    if (text) entries.add(`${getNodeRole(node) || node.tagName} "${text}"`);
  }
  return entries;
}

/**
 * Whether two hierarchy dumps show the same screen: most of what either
 * shows, the other shows too. A screen with no text to compare is never
 * judged the same.
 */
export function sameScreen(aXml: string, bXml: string): boolean {
  const a = screenEntries(aXml);
  const b = screenEntries(bXml);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const e of a) if (b.has(e)) shared += 1;
  return shared / Math.max(a.size, b.size) >= SAME_SCREEN_OVERLAP;
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
  /** `checkError`: why the device agent stopped checking locators, when it did. */
  | { kind: 'matches'; elements: ClosestElement[]; checkError?: string }
  /** The locator has no words to compare (a role alone, a RegExp, an id with no string). */
  | { kind: 'no-words' }
  | { kind: 'error'; message: string };

/**
 * The elements on the device's current screen closest to what `locator`
 * looked for, each with a locator the agent checked resolves to it alone
 * when it found one.
 */
export async function closestOnScreen(
  client: Pick<TapsmithGrpcClient, 'evaluateSelectors'>,
  hierarchyXml: string,
  locator: string,
): Promise<ClosestResult> {
  const needles = locatorNeedles(locator);
  if (needles.length === 0) return { kind: 'no-words' };
  // A few spare candidates: one element can be listed twice (an iOS
  // element and the container reporting the same label), and each is shown once.
  const nodes = closestNodes(semanticNodes(parseHierarchyXml(hierarchyXml)), needles, MAX_CLOSEST * CANDIDATES_PER_LISTED);
  if (nodes.length === 0) return { kind: 'matches', elements: [] };
  const ios = hierarchyXml.includes('<XCUIElementType');
  const { byNode, errorMessage } = await agentValidatedSuggestions(client, nodes, ios ? { chunkSize: IOS_CHUNK_SIZE } : {});
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
  return { kind: 'matches', elements, ...(errorMessage ? { checkError: errorMessage } : {}) };
}

// ─── The result's lines ───

export interface FailureScreenOptions {
  candidate: FailureCandidate
  /** The locator the failure says matched nothing, if it is a locator miss. */
  missedLocator?: string
  /** The client of the device the test ran on; rejects when that is unclear. */
  client: () => Promise<Pick<TapsmithGrpcClient, 'getUiHierarchy' | 'evaluateSelectors'>>
}

export interface FailureScreenReport {
  lines: string[]
  /** Whether `lines` end with the next step, in place of the run's usual one. */
  hasNextStep: boolean
}

/**
 * The lines `tapsmith_run_tests` adds for a failed run of one test: whether
 * the device's screen is the one the trace captured where it failed, and for
 * a locator miss the closest elements on the device's screen and the next
 * step. Nothing when the device cannot be read or shows nothing. Never
 * throws.
 */
export async function failureScreenReport(opts: FailureScreenOptions): Promise<FailureScreenReport> {
  const { candidate, missedLocator } = opts;
  const name = candidate.failure.fullName;
  let client: Awaited<ReturnType<FailureScreenOptions['client']>>;
  let liveXml: string;
  try {
    client = await opts.client();
    const live = await client.getUiHierarchy();
    if (live.errorMessage || screenEntries(live.hierarchyXml).size === 0) return { lines: [], hasNextStep: false };
    liveXml = live.hierarchyXml;
  } catch {
    return { lines: [], hasNextStep: false };
  }
  const held = candidate.failureHierarchyXml !== undefined && sameScreen(candidate.failureHierarchyXml, liveXml);
  const lines: string[] = held
    ? [
      `DEVICE HELD: the device is still on the screen where "${name}" failed: its screen matches the one the failure's trace captured at the failed step.`,
      'tapsmith_snapshot and tapsmith_test_locator act on that screen now. The next tapsmith_run_tests resets the app as usual.',
    ]
    : [
      candidate.failureHierarchyXml === undefined
        ? `The failure's trace has no screen captured at the step where "${name}" failed (no traced step has the error it stopped on), so the device's screen could not be checked against it.`
        : `The device's screen differs from the one the failure's trace captured when the step where "${name}" failed started. `
          + 'The app may have moved on while that step waited, something may have moved it after the failure '
          + '(an afterEach or afterAll hook, a fixture\'s teardown), or another device ran the test.',
      'Check with tapsmith_snapshot what the device shows now, and tapsmith_read_trace for the failure screen.',
    ];
  if (!missedLocator) return { lines, hasNextStep: false };

  const shown = missedLocator.length > SHOWN_LOCATOR_CHARS ? `${missedLocator.slice(0, SHOWN_LOCATOR_CHARS - 1)}…` : missedLocator;
  let closest: ClosestResult;
  try {
    closest = await closestOnScreen(client, liveXml, missedLocator);
  } catch (err) {
    closest = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  const where = held ? 'on screen' : 'on the device\'s screen now';
  if (closest.kind === 'matches' && closest.elements.length > 0) {
    lines.push('', `Closest ${where} to ${shown}:`);
    for (const e of closest.elements) {
      lines.push(e.locator ? `  - ${e.description}: ${e.locator}` : `  - ${e.description} (no checked locator; tapsmith_snapshot lists it)`);
    }
    if (closest.checkError) lines.push(`(The device agent stopped checking locators for these: ${closest.checkError})`);
  } else if (closest.kind === 'matches') {
    lines.push('', `Nothing ${where} is close to ${shown}: tapsmith_snapshot shows what is there.`);
  } else if (closest.kind === 'error') {
    lines.push('', `(Could not check the elements closest to ${shown}: ${closest.message})`);
  }
  lines.push('');
  lines.push(held
    ? 'NEXT STEP: the locator matched nothing on this screen. Check a replacement with tapsmith_test_locator '
      + '(it must count exactly 1), change the test to use it, then run the test again with tapsmith_run_tests.'
    : 'NEXT STEP: the locator matched nothing. Once tapsmith_snapshot shows the screen the test failed on, check a '
      + 'replacement with tapsmith_test_locator (it must count exactly 1), change the test to use it, then run the test again.');
  return { lines, hasNextStep: true };
}
