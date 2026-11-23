/**
 * What a locator miss says about the screen.
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

import type { ElementInfo, EvaluateSelectorsResponse, GetSystemAlertResponse } from './grpc-client.js';
import { collapseSameTargetDuplicates } from './element-handle.js';
import { isIosTextInput } from './ios-text-content.js';
import { normalizeRole } from './roles.js';
import { formatSelector, makeSelector, type RoleSelectorValue, type Selector } from './selectors.js';

/** The sentence every native locator miss ends with. MCP tools replace it with their own. */
export const LOCATOR_PICKER_HINT =
  'To find a locator that matches, pick the element in UI mode (npx tapsmith test --ui) ' +
  'or check one with the MCP tool tapsmith_test_locator.';

/** How long the near-miss check may add to a failure, past the action's own timeout. */
export const NEAR_MISS_BUDGET_MS = 2000;

/** How long the system-alert check may add to a failure (iOS): one
 *  SpringBoard query, tens of milliseconds unless the simulator is loaded. */
export const SYSTEM_ALERT_BUDGET_MS = 1000;

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
  /**
   * The probe looks for a text field holding these words: a hit whose value
   * is the words is told to assert it with toHaveValue(). (A field named by
   * the words, through its label or placeholder, is not.)
   */
  fieldValue?: string;
  /**
   * iOS: the words a text field's typed value must equal. The selector
   * (a role without a name) finds every field, and only an iOS field holding
   * this value counts, listed by its own name.
   */
  iosFieldValue?: string;
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
 * The words as a tab's name. A Flutter tab's description ends in the position
 * Flutter appends to its label ("Contact\nTab 2 of 3"), so neither
 * getByDescription("Contact") nor a role it does not have finds it; the tab
 * role names it "Contact".
 */
function tabProbe(needle: string): Probe {
  return { selector: makeSelector({ type: 'role', value: { role: 'tab', name: needle } }) };
}

/**
 * The words as a text field's typed value. getByText doesn't read what was
 * typed into an Android field, while getByRole's name still
 * matches it whole, so a getByText written for a field's value is told the
 * locator that finds the field.
 */
function fieldValueProbe(needle: string): Probe {
  return { selector: makeSelector({ type: 'role', value: { role: 'textfield', name: needle, exact: true } }), fieldValue: needle };
}

/**
 * The words as an iOS text field's typed value, which getByText doesn't read
 * either. An iOS field is named by its label or placeholder, never its value,
 * so no locator finds it by the words: each text input role is asked for
 * without a name, and a field holding the words is listed by its own name.
 */
function iosFieldValueProbes(needle: string): Probe[] {
  return (['textfield', 'searchfield'] as const).map((role) => ({
    selector: makeSelector({ type: 'role', value: { role, name: '' } }),
    fieldValue: needle,
    iosFieldValue: needle,
  }));
}

/** Collapse whitespace runs to one space and trim, as the agents compare text. */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** The elements of a probe's answer that count as its hits. */
function probeHits(probe: Probe, elements: ElementInfo[]): ElementInfo[] {
  const collapsed = collapseSameTargetDuplicates(elements);
  if (probe.iosFieldValue === undefined) return collapsed;
  const want = normalizeText(probe.iosFieldValue);
  return collapsed.filter((el) => isIosTextInput(el.className, el.role) && normalizeText(el.text) === want);
}

/** Whether one of `elements` holds `value` as its text (a field: its typed value). */
function holdsValue(elements: ElementInfo[], value: string): boolean {
  const want = normalizeText(value);
  return elements.some((el) => normalizeText(el.text) === want);
}

/** How a hit probe is listed: an iOS field-value probe by the field's own name. */
function probeCode(probe: Probe, hits: ElementInfo[]): string {
  if (probe.iosFieldValue === undefined || probe.selector.kind.type !== 'role') return formatSelector(probe.selector);
  // getByRole names an iOS field by its label or title, else its placeholder, never its value.
  const field = hits[0];
  const name = field.contentDescription.trim() ? field.contentDescription : field.hint;
  const role = probe.selector.kind.value.role;
  const code = formatSelector(makeSelector({ type: 'role', value: name ? { role, name, exact: true } : { role, name: '' } }));
  return `${code} (${plural(hits.length)} with the value ${JSON.stringify(probe.iosFieldValue)})`;
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
      if (!rv.nameRegex && rv.name) {
        probes.push(...wordProbes(rv.name, []));
        if (normalizeRole(rv.role) !== 'tab') probes.push(tabProbe(rv.name));
      }
      // Named or not, the role itself: told only when nothing else matched.
      if (rv.name || rv.nameRegex) {
        probes.push({ selector: makeSelector({ type: 'role', value: { role: rv.role, name: '' } }), fallback: true });
      }
      return probes;
    }
    case 'text':
      return [
        { selector: makeSelector({ type: 'textContains', value: kind.value }) },
        fieldValueProbe(kind.value),
        ...iosFieldValueProbes(kind.value),
        ...wordProbes(kind.value, ['textContains']),
        tabProbe(kind.value),
      ];
    case 'textContains':
      return kind.value
        ? [fieldValueProbe(kind.value), ...iosFieldValueProbes(kind.value), ...wordProbes(kind.value, [kind.type]), tabProbe(kind.value)]
        : [];
    case 'contentDesc':
    case 'label':
      return kind.value ? [...wordProbes(kind.value, [kind.type]), tabProbe(kind.value)] : [];
    case 'hint':
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
  const found = response.results.map((r, i) => (r.errorMessage ? [] : probeHits(probes[i], r.elements)));
  const counts = found.map((f) => f.length);
  const hits = probes
    .map((p, i) => ({ probe: p, found: found[i] }))
    .filter((h) => h.found.length > 0 && !h.probe.fallback)
    .slice(0, MAX_NEAR_MISSES);
  if (hits.length > 0) {
    const list = hits.map((h) => h.probe.iosFieldValue !== undefined
      ? probeCode(h.probe, h.found)
      : `${probeCode(h.probe, h.found)} (${plural(h.found.length)})`).join(', ');
    // getByText reads no text field's typed value, as Playwright's doesn't.
    const value = hits.some((h) => h.probe.fieldValue !== undefined && holdsValue(h.found, h.probe.fieldValue))
      ? ' A text field\'s typed value is not text to getByText(): assert it with toHaveValue().'
      : '';
    return `Nothing matches it, but on screen now ${hits.length === 1 ? 'this locator matches' : 'these locators match'}: ${list}.${value}`;
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
  return (await nearMissCheck(client, selector, signal, budgetMs)).hint;
}

/** What the near-miss check found: its sentence, and whether a hit shows the locator's own words. */
export interface NearMissCheck {
  /** The near-miss sentence ({@link nearMissHint}), or ''. */
  hint: string;
  /**
   * A hit's text or description is the locator's words (in any
   * case, whitespace-normalized; without trailing punctuation too), so the
   * element asked for is on screen under another locator, not off-screen. A
   * hit that only contains the words is another element.
   */
  wordsOnScreen: boolean;
}

/** {@link nearMissHint}, also saying whether a hit shows the locator's own words. */
export async function nearMissCheck(
  client: NearMissEvaluator,
  selector: Selector,
  signal?: AbortSignal,
  budgetMs = NEAR_MISS_BUDGET_MS,
): Promise<NearMissCheck> {
  const none = { hint: '', wordsOnScreen: false };
  const probes = nearMissProbes(selector);
  if (probes.length === 0 || typeof client.evaluateSelectors !== 'function') return none;
  const evaluate = client.evaluateSelectors.bind(client);
  const response = await withinBudget(() => evaluate(probes.map((p) => p.selector)), signal, budgetMs);
  try {
    if (!response) return none;
    const hint = formatNearMisses(selector, probes, response);
    return { hint, wordsOnScreen: hint !== '' && showsWords(selector, probes, response) };
  } catch {
    return none;
  }
}

/** The words a locator looks for, or undefined (a RegExp, an id). */
function locatorWords(selector: Selector): string | undefined {
  const kind = selector.kind;
  switch (kind.type) {
    case 'role': return kind.value.nameRegex ? undefined : kind.value.name || undefined;
    case 'text': case 'textContains': case 'contentDesc': case 'label': case 'hint':
      return typeof kind.value === 'string' ? kind.value : undefined;
    default: return undefined;
  }
}

/** Whether a (non-fallback) hit's text or description is the locator's words ({@link NearMissCheck}). */
function showsWords(selector: Selector, probes: Probe[], response: EvaluateSelectorsResponse): boolean {
  const words = locatorWords(selector);
  if (words === undefined) return false;
  const fold = (s: string) => normalizeText(s).toLowerCase();
  const wanted = new Set([fold(words), fold(words.trim().replace(TRAILING_PUNCTUATION, ''))].filter(Boolean));
  return probes.some((probe, i) => !probe.fallback && !response.results[i].errorMessage &&
    probeHits(probe, response.results[i].elements).some((el) => wanted.has(fold(el.text ?? '')) || wanted.has(fold(el.contentDescription ?? ''))));
}

/** The RPC the system-alert check needs (a TapsmithGrpcClient in production). */
export interface SystemAlertReader {
  getSystemAlert?(deadlineMs?: number): Promise<GetSystemAlertResponse>;
}

/**
 * The sentence a not-found message leads with when a system alert covers the
 * app: on iOS, a SpringBoard alert ("Open in “App”?", a permission prompt)
 * hides every element behind it without appearing in the app's hierarchy, so
 * the miss is the alert's doing, not the locator's. '' when none is up, the
 * device cannot say (an older agent, Android), or it does not answer within
 * `budgetMs`.
 */
export async function systemAlertHint(
  client: SystemAlertReader,
  signal?: AbortSignal,
  budgetMs = NEAR_MISS_BUDGET_MS,
): Promise<string> {
  if (typeof client.getSystemAlert !== 'function') return '';
  const read = client.getSystemAlert.bind(client);
  const alert = await withinBudget(() => read(budgetMs), signal, budgetMs);
  if (!alert?.present) return '';
  const name = alert.title ? `"${alert.title}"` : 'an untitled alert';
  const buttons = alert.buttons?.length ? `buttons: ${alert.buttons.join(', ')}` : 'no buttons';
  return `A system alert is covering the app: ${name} (${buttons}). `
    + 'Locators only see the app under test, so nothing behind the alert can be found, tapped or typed into '
    + 'until it is closed: close it on the device, or tap one of its buttons with device.tapXY().';
}

/** `call`'s result, or undefined when it rejects, `budgetMs` passes first, or `signal` aborts. @internal */
export async function withinBudget<T>(
  call: () => Promise<T>,
  signal: AbortSignal | undefined,
  budgetMs: number,
): Promise<T | undefined> {
  if (signal?.aborted) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const giveUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
    timer.unref?.();
    onAbort = () => resolve(undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([call().catch(() => undefined), giveUp]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
