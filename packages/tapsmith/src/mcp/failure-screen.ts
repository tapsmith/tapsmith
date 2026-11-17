/**
 * The screen a failed test left the device on (PILOT-1241).
 *
 * The runner resets the app before a file or test, never after one, and
 * nothing else touches the screen once a run ends: after a run of one test
 * that failed, the device is normally still on the screen where it failed.
 * What can move it is the test's own code after the failure (an `afterEach`
 * or `afterAll` hook, a fixture's teardown) or a later test of the run, and
 * the failure's trace does not record all of those. So the claim is checked
 * against the device itself: its screen now is compared with the one the
 * trace captured at the failed step. A failed assertion is the exception:
 * its capture is from when it started waiting, and the screen may have
 * changed while it waited, so when that capture does not match, nothing in
 * the trace after the assertion is the evidence instead. When the device is
 * held, this module tells the agent so, and lists the elements on that
 * screen closest to the locator that matched nothing, so the agent can try a
 * fix against the live app (tapsmith_test_locator) instead of navigating
 * back there itself.
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

/** A failed run of one test, and what its trace says about the failed step. */
export interface FailureCandidate {
  failure: TestFailureDetail
  /** The screen the trace captured at the failed step (see `FailedStep.hierarchyXml`). */
  failureHierarchyXml?: string
  /**
   * The failed step is an assertion and nothing follows it in the trace: the
   * device is held even when the screen changed while the assertion waited.
   */
  nothingAfterAssertion: boolean
}

/**
 * The failure whose screen the device may still show, or undefined when
 * that cannot be checked: more than one test ran (which failure it would
 * show is unclear), the failure has no trace, its trace has neither a screen
 * at the failed step nor a failed assertion to go by, or a device group ran it.
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
  const step = summary?.failedStep;
  if (!step || summary.multiDevice) return undefined;
  const nothingAfterAssertion = step.kind === 'assertion' && !step.stepsAfter;
  if (!step.hierarchyXml && !nothingAfterAssertion) return undefined;
  return { failure, failureHierarchyXml: step.hierarchyXml, nothingAfterAssertion };
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
 * looked for, each with a locator the agent checked resolves to it alone.
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
 * The lines `tapsmith_run_tests` adds for a failed run of one test: that the
 * device is still on the screen where it failed (checked against the trace),
 * the closest elements there for a locator miss, and the next step; or that
 * the device has moved since. Nothing when the device cannot be read. Never
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
    if (live.errorMessage) return { lines: [], hasNextStep: false };
    liveXml = live.hierarchyXml;
  } catch {
    return { lines: [], hasNextStep: false };
  }
  const matches = candidate.failureHierarchyXml !== undefined && sameScreen(candidate.failureHierarchyXml, liveXml);
  if (!matches && !candidate.nothingAfterAssertion) {
    return {
      lines: [
        `The device's screen differs from the one the trace captured where "${name}" failed, so it may have moved since `
        + '(an afterEach or afterAll hook, a fixture\'s teardown), or the test ran on another device. '
        + 'The failure\'s trace (tapsmith_read_trace) shows the failure screen.',
      ],
      hasNextStep: false,
    };
  }
  const lines: string[] = [
    matches
      ? `DEVICE HELD: the device is still on the screen where "${name}" failed (it was the only test in the run, and the screen matches the one in the failure's trace).`
      : `DEVICE HELD: the device is still where "${name}" failed: it was the only test in the run, and nothing acted on the device after the failed assertion (the screen changed while the assertion waited).`,
    'tapsmith_snapshot and tapsmith_test_locator act on that screen now. The next tapsmith_run_tests resets the app as usual.',
  ];
  if (!missedLocator) return { lines, hasNextStep: false };

  const shown = missedLocator.length > SHOWN_LOCATOR_CHARS ? `${missedLocator.slice(0, SHOWN_LOCATOR_CHARS - 1)}…` : missedLocator;
  let closest: ClosestResult;
  try {
    closest = await closestOnScreen(client, liveXml, missedLocator);
  } catch (err) {
    closest = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  lines.push('');
  if (closest.kind === 'matches' && closest.elements.length > 0) {
    lines.push(`Closest on screen to ${shown}:`);
    for (const e of closest.elements) {
      lines.push(e.locator ? `  - ${e.description}: ${e.locator}` : `  - ${e.description} (no checked locator; tapsmith_snapshot lists it)`);
    }
    if (closest.checkError) lines.push(`(The device agent stopped checking locators for these: ${closest.checkError})`);
  } else if (closest.kind === 'matches') {
    lines.push(`Nothing on screen is close to ${shown}: tapsmith_snapshot shows what is there.`);
  } else if (closest.kind === 'error') {
    lines.push(`(Could not check the elements closest to ${shown}: ${closest.message})`);
  }
  lines.push('');
  lines.push(
    'NEXT STEP: the locator matched nothing on this screen. Check a replacement with tapsmith_test_locator '
    + '(it must count exactly 1), change the test to use it, then run the test again with tapsmith_run_tests.',
  );
  return { lines, hasNextStep: true };
}
