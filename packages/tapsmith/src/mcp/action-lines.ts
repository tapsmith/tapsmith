/**
 * Checking the locator of an action tool's test line.
 *
 * The check is the action's own resolution, on the screen the action starts
 * from. A tap or type waits for its element through the device agent — the
 * matching a test resolves locators with — and, for a locator without a
 * position, refuses anything but exactly one match (strict mode, collapsed
 * the way `count()` collapses). So once the action has resolved, the locator
 * is known to match exactly the element it is about to act on, with no
 * further round trip, and before the action can navigate away.
 *
 * A locator that picks its element by position (`.first()`, `.last()`,
 * `.nth()`) is exempt from strict mode. For one of those, the agent is asked,
 * still before the action, for a locator that matches that element alone:
 * the snapshot's candidates for it, each kept only if the agent resolves it
 * to exactly that element (agent-suggestions.ts).
 */

import { sameTargetKey, type ElementHandle } from '../element-handle.js';
import type { ElementInfo, TapsmithGrpcClient } from '../grpc-client.js';
import { parseHierarchyXml } from '../trace-viewer/components/hierarchy-utils.js';
import { agentValidatedSuggestions, IOS_CHUNK_SIZE, isNodeElement } from './agent-suggestions.js';
import { semanticNodes } from './hierarchy-formatter.js';
import type { LineCheck } from './test-lines.js';

/** What finding a position-free locator needs from the daemon. */
export interface AlternativeClient {
  getUiHierarchy(deadlineMs?: number): ReturnType<TapsmithGrpcClient['getUiHierarchy']>
  evaluateSelectors(...args: Parameters<TapsmithGrpcClient['evaluateSelectors']>): ReturnType<TapsmithGrpcClient['evaluateSelectors']>
}

/**
 * How long the agent may take to check a position-free locator for a
 * positional one: the screen read and the candidate checks together, each
 * call bounded by what is left of it. The action waits for it, so it is kept
 * short; a check that runs out leaves the line unverified, not the action
 * undone.
 */
export const ALTERNATIVE_BUDGET_MS = 5_000;

/** A suggestion that is itself pinned by position. */
const POSITIONAL_SUFFIX_RE = /\.(?:first|last)\(\)$|\.nth\(-?\d+\)$/;

type Alternative = { locator: string } | { none: string } | { error: string };

/**
 * A locator the agent resolves to `element` alone, on the screen as it is
 * now: candidates are generated from the dump node(s) that are the element,
 * and kept only when the agent resolves them to exactly that node.
 */
export async function findPositionFreeLocator(
  client: AlternativeClient,
  element: ElementInfo,
  budgetMs = ALTERNATIVE_BUDGET_MS,
): Promise<Alternative> {
  const deadline = Date.now() + budgetMs;
  const left = () => deadline - Date.now();
  const outOfTime = { error: `checking took longer than ${budgetMs / 1000} s` };
  if (left() <= 0) return outOfTime;
  const { hierarchyXml, errorMessage } = await client.getUiHierarchy(left());
  if (errorMessage) return { error: errorMessage };
  if (left() <= 0) return outOfTime;
  const nodes = semanticNodes(parseHierarchyXml(hierarchyXml)).filter((node) => isNodeElement(element, node));
  if (nodes.length === 0) return { none: 'the element is not in the screen\'s accessibility tree, so no other locator could be checked for it' };
  const ios = hierarchyXml.includes('<XCUIElementType');
  // Every agent call gets what is left of the budget as its deadline: the
  // check's own budget is only looked at between calls.
  const bounded = { evaluateSelectors: (selectors: Parameters<TapsmithGrpcClient['evaluateSelectors']>[0]) => client.evaluateSelectors(selectors, Math.max(1, left())) };
  const checked = await agentValidatedSuggestions(bounded, nodes, { chunkSize: ios ? IOS_CHUNK_SIZE : undefined, budgetMs: left() });
  const best = nodes
    .flatMap((node) => checked.byNode.get(node) ?? [])
    .filter((s) => !POSITIONAL_SUFFIX_RE.test(s.code))
    .sort((a, b) => a.priority - b.priority)[0];
  if (best) return { locator: best.code };
  if (checked.errorMessage) return { error: checked.errorMessage };
  return { none: 'no locator the device agent checked matches this element alone' };
}

/**
 * `handle`, set up to check `locator` (the string it was built from) as it
 * resolves. Act through `handle`, then read `check()` once the action has
 * succeeded.
 */
export function checkingLine(
  handle: ElementHandle,
  locator: string,
  client: AlternativeClient,
): { handle: ElementHandle; check: () => LineCheck } {
  const positional = handle._isPositional();
  let resolved: ElementInfo | undefined;
  let alternative: Alternative | undefined;
  /** Set when a retry's position picked another element than the one checked. */
  let moved = false;
  const hooked = handle._onResolved(async (element, again) => {
    if (again) {
      // A retry re-resolved the position (a stale id, a refusal); if the
      // screen shifted meanwhile it is another element, and the line
      // checked for the first one would not repeat the action.
      if (positional && resolved && sameTargetKey(element) !== sameTargetKey(resolved)) moved = true;
      return;
    }
    resolved = element;
    if (!positional) return;
    // Never fails the action: a check that cannot finish leaves only the line unverified.
    alternative = await findPositionFreeLocator(client, element)
      .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
  });
  return {
    handle: hooked,
    check: (): LineCheck => {
      if (!resolved) return { status: 'unverified', reason: 'the action did not report which element it resolved' };
      if (!positional) return { status: 'verified', locator };
      if (moved) {
        return {
          status: 'unverified',
          reason: 'the locator picks its element by position, and the action had to find it again, when the position picked a different element from the one checked',
        };
      }
      if (!alternative || 'error' in alternative) {
        return {
          status: 'unverified',
          reason: `the locator picks its element by position, and checking for one that matches it alone failed: ${alternative?.error ?? 'no answer'}`,
        };
      }
      if ('locator' in alternative) return { status: 'verified', locator: alternative.locator, replaced: locator };
      return {
        status: 'positional',
        locator,
        detail: `(The line picks its element by position, so it breaks if elements are added or reordered: ${alternative.none}.)`,
      };
    },
  };
}

/**
 * The check for a `webview.` locator: the page resolves it (strict for a
 * locator without a position), which is the matching a test's WebView
 * locators use. No position-free alternative is looked for.
 */
export function webViewLineCheck(locator: string, positional: boolean): LineCheck {
  return positional
    ? {
      status: 'positional',
      locator,
      detail: '(The line picks its element by position, so it breaks if elements are added or reordered; check a locator that matches it alone with tapsmith_test_locator.)',
    }
    : { status: 'verified', locator };
}
