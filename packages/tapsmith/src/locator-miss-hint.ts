/**
 * What a locator miss says about the screen (PILOT-849).
 *
 * A wrong guess at a locator used to cost a whole timeout and say only "not
 * found". At the deadline, the not-found error now asks the device agent —
 * the one matcher tests resolve with — how the same words would match under
 * the other getters (`getByText`, `getByLabel`, `getByPlaceholder`,
 * `getByDescription`, or the same role under a looser name), and lists the
 * ones that find something. Every miss also points at the tools that show
 * what is on screen: UI mode's picker and the MCP `tapsmith_test_locator`.
 *
 * One builder for every native not-found message (actions, readers,
 * `waitFor()`, assertions): see `ElementHandle._locatorMissHelp()`.
 *
 * @internal
 */

import type { EvaluateSelectorsResponse } from './grpc-client.js';
import { collapseSameTargetDuplicates } from './element-handle.js';
import { formatSelector, makeSelector, type RoleSelectorValue, type Selector } from './selectors.js';

/** The sentence every native locator miss ends with. MCP tools replace it with their own. */
export const LOCATOR_PICKER_HINT =
  'To find a locator that matches, pick the element in UI mode (npx tapsmith test --ui) ' +
  'or check one with the MCP tool tapsmith_test_locator.';

/** How long the near-miss check may add to a failure, past the action's own timeout. */
export const NEAR_MISS_BUDGET_MS = 2000;

/** Near misses listed at most. */
const MAX_NEAR_MISSES = 3;

/** The batch RPC the check needs (a TapsmithGrpcClient in production). */
export interface NearMissEvaluator {
  evaluateSelectors?(selectors: Selector[]): Promise<EvaluateSelectorsResponse>;
}

/** A probe: the alternative selector, and whether it is listed only when no other probe matched. */
interface Probe {
  selector: Selector;
  fallback?: boolean;
}

/** The role query without its name filter's strictness or its state filters, or undefined when it has neither. */
function loosenedRole(rv: RoleSelectorValue): RoleSelectorValue | undefined {
  const hasState = rv.checked !== undefined || rv.disabled !== undefined || rv.selected !== undefined ||
    rv.expanded !== undefined;
  if (!rv.exact && !hasState) return undefined;
  return rv.nameRegex
    ? { role: rv.role, name: rv.name, nameRegex: rv.nameRegex }
    : { role: rv.role, name: rv.name };
}

const TRAILING_PUNCTUATION = /[\p{P}\p{S}]+$/u;

/**
 * The getters that read the same words in another attribute, in the order
 * they are recommended. Words ending in punctuation are also checked without
 * it, as text and as a description (PILOT-880): on iOS a React Native
 * touchable's accessibilityLabel "Forgot password" hides the "Forgot
 * password?" text it wraps, and getByText matches text literally.
 */
function wordProbes(needle: string, skip: Selector['kind']['type'][]): Probe[] {
  const kinds = (['textContains', 'label', 'hint', 'contentDesc'] as const).filter((k) => !skip.includes(k));
  const probes: Probe[] = kinds.map((type) => ({ selector: makeSelector({ type, value: needle }) }));
  const bare = needle.trim().replace(TRAILING_PUNCTUATION, '').trim();
  if (bare !== '' && bare !== needle.trim()) {
    probes.push(...(['textContains', 'contentDesc'] as const).map((type) => ({ selector: makeSelector({ type, value: bare }) })));
  }
  return probes;
}

/**
 * The alternative selectors a miss of `selector` is checked against. Empty
 * for a scoped selector (the agent evaluates unscoped selectors only), a
 * RegExp needle under a text getter, and the id-like getters, whose values
 * are not words a user sees.
 */
export function nearMissProbes(selector: Selector): Probe[] {
  if (selector.parent) return [];
  const kind = selector.kind;
  switch (kind.type) {
    case 'role': {
      const rv = kind.value;
      const probes: Probe[] = [];
      const loose = loosenedRole(rv);
      if (loose) probes.push({ selector: makeSelector({ type: 'role', value: loose }) });
      if (!rv.nameRegex && rv.name) probes.push(...wordProbes(rv.name, []));
      // Named or not, the role itself: told only when nothing else matched.
      if (rv.name || rv.nameRegex) {
        probes.push({ selector: makeSelector({ type: 'role', value: { role: rv.role, name: '' } }), fallback: true });
      }
      return probes;
    }
    case 'text':
      return [{ selector: makeSelector({ type: 'textContains', value: kind.value }) }, ...wordProbes(kind.value, ['textContains'])];
    case 'textContains':
    case 'label':
    case 'hint':
    case 'contentDesc':
      return kind.value ? wordProbes(kind.value, [kind.type]) : [];
    default:
      return [];
  }
}

function plural(n: number): string {
  return n === 1 ? '1 element' : `${n} elements`;
}

/**
 * The near-miss sentence for `selector`, from the agent's answer to its
 * probes (one result per probe, in order), or '' when none matched.
 */
export function formatNearMisses(selector: Selector, probes: Probe[], response: EvaluateSelectorsResponse): string {
  if (response.errorMessage || response.results.length !== probes.length) return '';
  const counts = response.results.map((r) => (r.errorMessage ? 0 : collapseSameTargetDuplicates(r.elements).length));
  const hits = probes
    .map((p, i) => ({ probe: p, count: counts[i] }))
    .filter((h) => h.count > 0 && !h.probe.fallback)
    .slice(0, MAX_NEAR_MISSES);
  if (hits.length > 0) {
    const list = hits.map((h) => `${formatSelector(h.probe.selector)} (${plural(h.count)})`).join(', ');
    return `Nothing matches it, but on screen now ${hits.length === 1 ? 'this locator matches' : 'these locators match'}: ${list}.`;
  }
  const fallbackIndex = probes.findIndex((p) => p.fallback);
  if (fallbackIndex >= 0 && counts[fallbackIndex] > 0 && selector.kind.type === 'role') {
    const rv = selector.kind.value;
    const shown = rv.nameRegex ? 'matching that name' : `named ${JSON.stringify(rv.name)}`;
    return `${formatSelector(probes[fallbackIndex].selector)} matches ${plural(counts[fallbackIndex])} on screen now, none ${shown}.`;
  }
  return '';
}

/**
 * Ask the agent about `selector`'s near misses: the sentence, or '' when there
 * are none, the client cannot ask, or the agent does not answer within
 * {@link NEAR_MISS_BUDGET_MS} (or before `signal` aborts). Never throws: a
 * failed check must not replace the not-found error it decorates.
 */
export async function nearMissHint(
  client: NearMissEvaluator,
  selector: Selector,
  signal?: AbortSignal,
  budgetMs = NEAR_MISS_BUDGET_MS,
): Promise<string> {
  const probes = nearMissProbes(selector);
  if (probes.length === 0 || typeof client.evaluateSelectors !== 'function' || signal?.aborted) return '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const giveUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
    timer.unref?.();
    onAbort = () => resolve(undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const response = await Promise.race([
      client.evaluateSelectors(probes.map((p) => p.selector)).catch(() => undefined),
      giveUp,
    ]);
    return response ? formatNearMisses(selector, probes, response) : '';
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
