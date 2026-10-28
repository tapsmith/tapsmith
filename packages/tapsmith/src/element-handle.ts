/**
 * ElementHandle — a lazy reference to a UI element found by a Selector.
 *
 * Returned by `device.element(selector)`. Supports chaining with `.element()`
 * and all the same actions as Device (tap, type, …). Also serves as the
 * assertion target for `expect()`.
 */

import {
  type Selector,
  type RoleLocatorOptions,
  selectorToProto,
  formatSelector,
  withParent,
  _id,
  _text,
  _textContains,
  _contentDesc,
  _hint,
  _testId,
  _role,
  _className,
  _xpath,
  _label,
} from './selectors.js';
import { iosUnnamedRoleMissHint, unknownRoleMessage, type Role } from './roles.js';
import type { SwipeDirection } from './input-names.js';
import type { Platform } from './config.js';
import type { TapsmithGrpcClient, ElementInfo, ActionResponse } from './grpc-client.js';
import { type TraceCapture, extractStack } from './trace/trace-collector.js';
import type { ActionCategory } from './trace/types.js';
import { tracedAction } from './trace/traced-action.js';
import { sleep, isAbortError } from './abort.js';
import { defineRenamedMethods } from './not-supported.js';
import { escapeJsString } from './js-string-escape.js';
import { checkNoArguments, checkOptions, checkSelectOption, checkTimeout, type TimeoutOptions } from './action-options.js';
import { IOS_NAME_ONLY_TYPES, IOS_VALUE_TEXT_TYPES } from './ios-text-content.js';
import { LOCATOR_PICKER_HINT, NEAR_MISS_BUDGET_MS, nearMissHint } from './locator-miss-hint.js';
import { elementAccessibleName } from './accessible-name.js';

// ─── Public types ───

/** An element's position and size on screen, in logical points. */
export interface BoundingBox {
  /** Left edge. */
  x: number;
  /** Top edge. */
  y: number;
  /** Width. */
  width: number;
  /** Height. */
  height: number;
}

/**
 * Cadence of every host-side poll loop in the SDK — action auto-wait,
 * `waitFor`, the presence probes (`isVisible`/`isHidden`/`exists`),
 * `scrollIntoView`'s probe and stabilisation, the WebView locator loops, the MCP selector
 * resolver and the assertion poller in expect.ts (which import it). It is
 * also the budget of each read the action and probe loops issue (see
 * {@link tickBudget}); `waitFor` and the assertion poller keep their own,
 * deliberately longer, 500 ms read budget. One constant, so the cadences
 * cannot drift apart again (PILOT-345 found it hand-copied in seven places).
 * @internal
 */
export const POLL_INTERVAL_MS = 250;

const WAIT_FOR_STATES: readonly string[] = ['visible', 'hidden', 'attached', 'detached'];
/** Settle time after swipe-based scrolling.  On iOS, ScrollView momentum
 *  deceleration takes 300-500ms and the first tap during deceleration is
 *  consumed to stop the scroll rather than being delivered to child views.
 *  500ms is the measured safe minimum for iOS. */
const SCROLL_SETTLE_MS = 500;
/** Idle-wait budget used to confirm a first-tick miss in scrollIntoView()
 *  before committing to the first swipe. Right after navigation or app launch
 *  the accessibility tree can lag the rendered screen (briefly describing the
 *  previous screen without any error), so an element that is plainly visible
 *  can probe as absent; swiping on that phantom miss displaces the visible
 *  element — e.g. under a pinned app bar (PILOT-283). Bounded so screens with
 *  continuous animation can't stall a genuine scroll for long. */
const SCROLL_FIRST_SWIPE_IDLE_TIMEOUT_MS = 1500;
/** Cap for the best-effort screenshot/hierarchy capture taken when an action's
 *  element resolution has *already* failed. Tighter than the normal 5s
 *  TRACE_CAPTURE_TIMEOUT_MS so a slow/unresponsive device can't add seconds of
 *  delay after the failure and obscure the real error behind a runner timeout. */
const FAILURE_TRACE_CAPTURE_TIMEOUT_MS = 1000;

// ─── Locator options (escape hatch for non-accessible queries) ───

/**
 * Options for `device.locator()` and `ElementHandle.locator()`. Use only when
 * an accessible getter (`getByRole`, `getByText`, `getByDescription`,
 * `getByPlaceholder`, `getByTestId`) cannot identify the element. Exactly one
 * field must be set.
 */
export interface LocatorOptions {
  /** Native resource id (e.g. Android `R.id.foo` → `"foo"`). */
  id?: string;
  /** XPath expression. Android-only. Use sparingly. */
  xpath?: string;
  /** Native widget class name (e.g. `"android.widget.Button"`). */
  className?: string;
}

// ─── Filter options for .filter() ───

/** Options for `locator.filter()`: each one narrows the matches further. */
export interface FilterOptions {
  /** Keep elements whose text contains this string or matches this RegExp. */
  hasText?: string | RegExp;
  /** Keep elements that have a descendant matching this locator. */
  has?: ElementHandle;
  /** Exclude elements that have a descendant matching this locator. */
  hasNot?: ElementHandle;
  /** Exclude elements whose text contains this string or matches this RegExp. */
  hasNotText?: string | RegExp;
}

// ─── Internal options for modified handles ───

/**
 * A modifier chained AFTER a positional index. Modifiers compose in call
 * order, as in Playwright: `list.nth(1).filter(f)` is row 1 if it matches f
 * (not the second matching row), `list.first().nth(1)` is nothing, and
 * `list.first().first()` is `list.first()`. Filters chained BEFORE the index
 * live in `filters` and apply to the full match set; the index then picks one
 * element and these steps narrow that one element further (see `_select`).
 */
type PostIndexStep = { readonly nth: number } | { readonly filter: FilterOptions };

interface ElementHandleOptions {
  nthIndex?: number;
  /** Filters applied to the full match set, BEFORE `nthIndex`. */
  filters?: FilterOptions[];
  /** Modifiers chained after `nthIndex`, applied in call order — see {@link PostIndexStep}. */
  post?: PostIndexStep[];
  /** Left operand for and() — the full handle `this` was called on. */
  andSelf?: ElementHandle;
  andHandle?: ElementHandle;
  /** Left operand for or() — the full handle `this` was called on. */
  orSelf?: ElementHandle;
  orHandle?: ElementHandle;
  /**
   * Parent scope for a `getBy*`/`locator()` call made on a handle (e.g.
   * `list.getByText('Row')`, `dialog.first().getByRole('button')`). The
   * parent is resolved to concrete element(s) and the child is kept when its
   * centre lies inside one of them (see inScope, PILOT-850): the agents do
   * not scope by a nested parent Selector.
   */
  scopeParent?: ElementHandle;
  /** Trace capture context, propagated from the Device. */
  traceCapture?: TraceCapture;
  /** Default inter-keystroke delay in ms, from config.typingDelay. */
  typingDelay?: number;
  /** Default double-tap interval in ms, from config.doubleTapInterval. */
  doubleTapInterval?: number;
  /**
   * The device's platform, for failure hints that only hold on one
   * (`iosUnnamedRoleMissHint`, PILOT-718), and for a chained getter's iOS-only
   * parent fallback (scopeToParents, PILOT-850). Absent on handles built
   * outside a Device, which then get neither.
   */
  platform?: Platform;
}

// ─── Helpers ───

/** @internal — Convert public LocatorOptions into the internal Selector. */
export function locatorOptionsToSelector(options: LocatorOptions): Selector {
  const keys = (['id', 'xpath', 'className'] as const).filter((k) => options[k] !== undefined);
  if (keys.length !== 1) {
    throw new Error(
      `locator() expects exactly one of { id, xpath, className }, got ${keys.length === 0 ? 'none' : keys.join(', ')}`,
    );
  }
  const key = keys[0];
  if (key === 'id') return _id(options.id!);
  if (key === 'xpath') return _xpath(options.xpath!);
  return _className(options.className!);
}

/**
 * Result of boundsContain: 'contained' if child is within parent,
 * 'not_contained' if child is outside, 'indeterminate' if either has no bounds.
 */
type ContainmentResult = 'contained' | 'not_contained' | 'indeterminate';

function boundsContain(
  parent?: { left: number; top: number; right: number; bottom: number },
  child?: { left: number; top: number; right: number; bottom: number },
): ContainmentResult {
  if (!parent || !child) return 'indeterminate';
  const contained =
    child.left >= parent.left &&
    child.top >= parent.top &&
    child.right <= parent.right &&
    child.bottom <= parent.bottom;
  return contained ? 'contained' : 'not_contained';
}

/** A positional index as the call that set it: `.first()`, `.last()` or `.nth(n)`. */
function renderNth(n: number): string {
  return n === 0 ? '.first()' : n === -1 ? '.last()' : `.nth(${n})`;
}

/**
 * Whether `child` lies inside a chained getter's resolved `parent`
 * (`parent.getByText(…)`, PILOT-850): its centre is within the parent's
 * bounds, and it is not a larger element enclosing the parent (an ancestor,
 * a full-screen backdrop behind a dialog).
 *
 * Scope is geometric, not the accessibility tree's parent/child links: the
 * trees React Native produces hoist a container's children to be its
 * siblings (a modal's buttons are not children of its `testID` view), so a
 * tree search would find nothing where the user plainly sees the child. The
 * centre, not the whole box, decides, so a row half-scrolled past its list's
 * edge — iOS reports unclipped frames — is still in the list; an element with
 * no area has no centre on screen and never is. An element drawn over the
 * parent from elsewhere is in scope too; that is the price of bounds.
 */
function inScope(parent: ElementInfo, child: ElementInfo): boolean {
  const p = parent.bounds;
  const c = child.bounds;
  if (!p || !c || !hasUsableGeometry(child)) return false;
  const encloses = c.left <= p.left && c.top <= p.top && c.right >= p.right && c.bottom >= p.bottom;
  const sameRect = c.left === p.left && c.top === p.top && c.right === p.right && c.bottom === p.bottom;
  if (encloses && !sameRect) return false;
  const cx = (c.left + c.right) / 2;
  const cy = (c.top + c.bottom) / 2;
  return cx >= p.left && cx <= p.right && cy >= p.top && cy <= p.bottom;
}

/**
 * Whether `child` is `parent` read again (its id differs per read). A
 * same-size wrapper's child differs in its test id or description.
 */
function isSameElement(parent: ElementInfo, child: ElementInfo): boolean {
  return sameTargetKey(child) === sameTargetKey(parent) && child.className === parent.className
    && child.resourceId === parent.resourceId && child.contentDescription === parent.contentDescription;
}

/**
 * The matches in scope of a chained getter's resolved parents, in match
 * order. Within each parent what lies inside it wins; with `parentFallback`
 * the parent itself counts when nothing inside matches — on iOS an
 * accessible React Native container (any Pressable) is one element whose
 * children are not exposed, so `card.getByText("Title")` can only ever match
 * the card. Android exposes the children, so there (and on a handle with no
 * platform) the parent never matches.
 */
function scopeToParents(parents: ElementInfo[], elements: ElementInfo[], parentFallback: boolean): ElementInfo[] {
  const kept = new Set<ElementInfo>();
  for (const p of parents) {
    const inside = elements.filter((c) => inScope(p, c) && !isSameElement(p, c));
    const matches = inside.length > 0 || !parentFallback ? inside : elements.filter((e) => isSameElement(p, e));
    for (const c of matches) kept.add(c);
  }
  return elements.filter((c) => kept.has(c));
}

/**
 * Test whether an error thrown from `_resolveOne` / `_resolveAll` is a
 * "no match yet" signal that auto-wait loops should swallow and retry,
 * vs. a genuine infrastructure failure (gRPC error, daemon crash, etc.)
 * that must propagate so the user sees the real cause.
 *
 * Keeps the list of pollable-error message prefixes in sync with the
 * throw sites in `_resolveOne` and anything `_resolveAll` surfaces for
 * empty/out-of-range matches.
 */
/**
 * Substring the Android agent stamps onto a transient UIAutomator
 * `StaleObjectException` (see `CommandHandler.kt`). It means the hierarchy
 * changed mid-snapshot — e.g. a React re-render right after a tap — which is
 * retryable: the next poll tick queries a settled tree. Treated as a pollable
 * "not yet" so the action poll loops keep waiting within their timeout budget
 * instead of failing the action outright. Without this, PILOT-226's strict
 * pre-action resolution (which uses the non-auto-waiting `findElements` RPC)
 * turns a momentary stale snapshot into a hard failure — the regression that
 * surfaced as flaky `wait-for` E2E tests.
 */
const STALE_SNAPSHOT_SIGNATURE = 'is stale (UI changed)';

/**
 * How long the non-waiting presence probes (`isVisible`/`isHidden`/`exists`)
 * keep re-probing after a momentary agent command *fault* before surfacing it.
 * Measured from the first fault, capped by the handle's own timeout, and
 * short: a real infrastructure error should not be hidden for 30s. (Stale
 * snapshots are NOT bounded by this — see `_probeOnce`.)
 */
const PROBE_FAULT_RETRY_WINDOW_MS = 2000;
/**
 * Idle-wait budget used by the presence probes to confirm a first empty
 * read. Right after navigation or app launch the accessibility tree can lag
 * the rendered screen — briefly describing the previous screen with no error
 * (PILOT-283) — so a presence branch taken on one empty read could skip an
 * element that is plainly visible. Same rationale and bound as
 * {@link SCROLL_FIRST_SWIPE_IDLE_TIMEOUT_MS}: bounded so a screen with
 * continuous animation (idle never arrives) costs an absent answer at most
 * this much extra.
 */
const PROBE_MISS_CONFIRM_IDLE_MS = SCROLL_FIRST_SWIPE_IDLE_TIMEOUT_MS;

/**
 * The parenthetical a deadline / single-shot "not found" error carries for a
 * positional miss (`nth(5): expected at least 6 element(s), but found 3`).
 * Empty for `.first()`/`.last()` (indices 0 / -1): that index is one the user
 * never wrote, and `_describe()` does not render it either. An explicit
 * `nth(5)` keeps its detail even on an empty list — it is the only place the
 * error names the index at all.
 */
function positionalMissDetail(err: Error | undefined): string {
  if (!err || !/^nth\((?!0\)|-1\))/.test(err.message)) return '';
  return ` (${err.message})`;
}
/*
 * What a `findElements` budget actually buys (see agent_comms.rs in the
 * daemon): the on-device agent runs a hierarchy dump to completion IGNORING
 * the client timeout — it is one uninterruptible native call — and the daemon
 * waits `budget + 5s headroom` (TAPSMITH_AGENT_READ_HEADROOM_MS) for the
 * answer. So a 1ms budget is a 5.001s read window and a 30s budget a 35s one;
 * the ceiling on how long a dump may take is the headroom, not the budget.
 * That is why the poll loops in this file can floor a tick's budget at 1ms
 * without manufacturing timeouts, and why no minimum read budget is needed.
 */

/**
 * Budget for one read of a poll loop that ends at `deadline`: one poll
 * interval, or what is left of the deadline if that is shorter. Floored at
 * 1ms — the daemon treats 0 as "use the 30s default", which would stall the
 * final tick for 30s (see the note above on why 1ms is not a real bound).
 */
function tickBudget(deadline: number): number {
  return Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()));
}

function isPollableNotFoundError(err: unknown): boolean {
  // A strict mode violation means the selector DID resolve — to too many
  // elements. Retrying cannot fix ambiguity; it must propagate immediately.
  if (isStrictModeViolation(err)) return false;
  // A user stop (PILOT-222) must propagate — poll loops never retry it.
  if (isAbortError(err)) return false;
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.startsWith('Element not found:') ||
    msg.startsWith('nth(') ||
    // A transient stale snapshot — retry on the next poll tick rather than
    // surfacing the agent error as a fatal "findElements failed".
    isStaleSnapshotError(err)
  );
}

/**
 * True for a transient stale-snapshot error (see {@link STALE_SNAPSHOT_SIGNATURE}).
 * Distinct from a definitive "not found": a stale tick is *unreliable*, so
 * callers that interpret an empty result as a real state — notably `waitFor`'s
 * absence states (`'detached'`/`'hidden'`) — must retry rather than conclude
 * absence, or a single re-render blip would falsely satisfy the wait.
 */
/** @internal — exported for the assertion poll in expect.ts, which retries a stale tick like every ladder here. */
export function isStaleSnapshotError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(STALE_SNAPSHOT_SIGNATURE);
}

/**
 * Substring the daemon stamps onto a read-timeout waiting for the on-device
 * agent to answer (see `agent_comms.rs`). It means the agent process is alive —
 * we opened the socket and wrote the command — but was too slow to respond this
 * tick: e.g. an uninterruptible UIAutomator hierarchy dump on a CPU-starved CI
 * emulator, which the agent runs to completion regardless of the requested
 * timeout. Unlike a dropped socket, this recovers on its own, so action
 * auto-wait loops treat it as a transient "not yet" and retry on the next poll
 * tick within their timeout budget instead of aborting the whole action.
 *
 * Kept SEPARATE from {@link isPollableNotFoundError}: when this persists for the
 * entire action budget the loops surface the timeout unchanged (rather than a
 * generic "not found") so it still matches `RECOVERABLE_INFRASTRUCTURE_PATTERNS`
 * and the session-level recovery fires as a last resort.
 */
const AGENT_TIMEOUT_SIGNATURE = 'Agent command timed out';

/** @internal — see {@link AGENT_TIMEOUT_SIGNATURE}. Exported for the assertion
 * poll loop (expect.ts) so both surfaces classify transient agent slowness
 * identically. */
export function isTransientAgentError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(AGENT_TIMEOUT_SIGNATURE);
}

/**
 * @internal — True for any resolution-tick failure that poll loops should
 * retry within their budget rather than abort on: a transient agent timeout
 * (slow-but-alive agent) or an agent/daemon command failure surfaced through
 * `errorMessage` (`findElement(s) failed: …`). The latter covers momentary
 * agent-side faults during hierarchy churn — e.g. an exception thrown while
 * reading attributes of a node that a re-render just detached — which recover
 * on the next tick. Strict violations and user aborts are never retryable.
 *
 * Callers keep the `lastTransientErr` pattern: when the failure persists for
 * the whole budget, the REAL error surfaces at the deadline (so session-level
 * recovery patterns still match) instead of a generic "not found". Genuine
 * gRPC transport failures are thrown by the client (not returned via
 * `errorMessage`) and don't carry the `find… failed:` prefix, so they still
 * propagate immediately.
 */
export function isRetryableResolutionError(err: unknown): boolean {
  if (isStrictModeViolation(err) || isAbortError(err)) return false;
  if (isTransientAgentError(err)) return true;
  // Stale snapshots have their own dedicated handling (a pollable "not yet",
  // see isPollableNotFoundError) — keep them out of this class so a
  // budget-long stale stall still reports "not found" rather than a raw
  // agent error.
  if (isStaleSnapshotError(err)) return false;
  return err instanceof Error && /^find(Element|Elements) failed:/.test(err.message);
}

/**
 * How one resolution read that threw should be treated by a poll loop. Every
 * ladder in this file — action auto-wait, `waitFor`, the visibility probes,
 * `scrollIntoView` — classifies the same way, in this order:
 *
 * - `'stale'` — the UI changed mid-read ({@link isStaleSnapshotError}). An
 *   *unreliable* tick: the agent answered, so it is responsive, but the read
 *   says nothing about presence. Checked first because the stale signature is
 *   also a pollable not-found.
 * - `'fault'` — a momentary agent fault or agent command timeout
 *   ({@link isRetryableResolutionError}). Also unreliable, but a real
 *   infrastructure error underneath: loops retry it briefly and surface it
 *   unchanged if it persists, so session-level recovery still matches.
 * - `'miss'` — a definitive "nothing matches right now"
 *   ({@link isPollableNotFoundError}): an empty match, a positional index out
 *   of range, a filter that excluded every candidate.
 * - `'fatal'` — everything else: a strict-mode violation, a user stop, a gRPC
 *   transport failure. Never retried; the caller rethrows.
 */
type ResolutionErrorClass = 'stale' | 'fault' | 'miss' | 'fatal';

function classifyResolutionError(err: unknown): ResolutionErrorClass {
  if (isStaleSnapshotError(err)) return 'stale';
  if (isRetryableResolutionError(err)) return 'fault';
  if (isPollableNotFoundError(err)) return 'miss';
  return 'fatal';
}

/**
 * The outcome of one bounded, modifier-aware read of a handle (see
 * `ElementHandle._resolveTick` for the strict single-target read and
 * `_existsTick` for the non-strict presence read). `found` and `miss` are
 * answers; `stale` and `fault` are unreliable ticks that carry no information
 * about presence (see {@link classifyResolutionError} for the split).
 */
type ResolveTick =
  | { readonly kind: 'found'; readonly element: ElementInfo }
  | { readonly kind: 'miss'; readonly positionalMiss?: Error }
  | { readonly kind: 'stale' }
  | { readonly kind: 'fault'; readonly error: Error };

/**
 * Apply a positional modifier (`first()` = 0, `last()` = -1, `nth(i)`) to a
 * match list: the selected element as a one-item list, or `[]` when the index
 * is out of range. Without a modifier the list is returned as-is.
 */
function selectNth(elements: ElementInfo[], nthIndex: number | undefined): ElementInfo[] {
  if (nthIndex === undefined) return elements;
  const idx = nthIndex < 0 ? elements.length + nthIndex : nthIndex;
  return idx >= 0 && idx < elements.length ? [elements[idx]] : [];
}

// ─── Strict mode (PILOT-226) ───

/** @internal Brand key for cross-instance type checks (CJS/ESM dual-package). */
export const STRICT_MODE_VIOLATION_BRAND = Symbol.for('tapsmith.StrictModeViolationError');

/**
 * Thrown when a locator used for an action, single-element query, or
 * assertion resolves to more than one element. Mirrors Playwright's strict
 * mode: acting on an ambiguous selector is an error, never a silent
 * first-match. Disambiguate with `{ exact: true }`, `getByRole(role, { name, exact: true })`,
 * `getByTestId()`, or `.first()/.nth()/.last()`.
 */
export class StrictModeViolationError extends Error {
  /** @internal */
  readonly [STRICT_MODE_VIOLATION_BRAND] = true;
  /** The elements the selector resolved to, in document order. May be a
   * truncated sample (WebView locators cap it at {@link STRICT_ERROR_MAX_ELEMENTS});
   * `totalCount` always holds the full match count. */
  readonly elements: ElementInfo[];
  /** Total number of elements the selector resolved to. */
  readonly totalCount: number;

  constructor(message: string, elements: ElementInfo[], totalCount?: number) {
    super(message);
    this.name = 'StrictModeViolationError';
    this.elements = elements;
    this.totalCount = totalCount ?? elements.length;
  }
}

/** Returns true if `err` is a {@link StrictModeViolationError} (brand-based, safe across CJS/ESM copies). */
export function isStrictModeViolation(err: unknown): err is StrictModeViolationError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[STRICT_MODE_VIOLATION_BRAND] === true
  );
}

/** Max elements listed in a strict mode violation message before truncating.
 * Also caps the DOM sample WebView locators collect (webview-handle.ts). */
export const STRICT_ERROR_MAX_ELEMENTS = 10;

/** @internal — Shared by the native and WebView strict violation formatters. */
export function truncateText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Best-effort unambiguous locator suggestion for one resolved element. */
function suggestSelectorFor(el: ElementInfo): string | undefined {
  // getByTestId matches the whole resource-id — an RN testID. A native
  // package-qualified id ("com.pkg:id/foo") is often shared by every row of a
  // list, so it is the last resort, as locator({ id }) (PILOT-659).
  const nativeId = el.resourceId?.includes(':id/') ? el.resourceId : undefined;
  if (el.resourceId && !nativeId) {
    return `device.getByTestId("${escapeJsString(el.resourceId)}")`;
  }
  // A text field's text is its typed value, not its name: an unlabelled
  // field is named by its placeholder (PILOT-834).
  const name = elementAccessibleName(el);
  // Static text elements read better as getByText; real widgets as getByRole.
  // Only a role getByRole accepts: Android reports any role description an
  // app publishes (a custom "carousel", a localized one) as the role (PILOT-556).
  if (el.role && el.role !== 'text' && name && unknownRoleMessage(el.role) === null) {
    // Role names match by substring unless exact (PILOT-549): pin a short
    // name whole; a long one is suggested as its leading part (no ellipsis,
    // which the name doesn't contain), still a valid substring locator.
    const exact = name.length <= 60;
    const shown = exact ? name : name.slice(0, 60);
    return `device.getByRole("${el.role}", { name: "${escapeJsString(shown)}"${exact ? ', exact: true' : ''} })`;
  }
  // iOS: a control's name is a getByLabel field's name, never getByText's
  // text; the value of anything but text is not text either (PILOT-794).
  const isIos = el.className.startsWith('XCUIElementType');
  if (isIos && IOS_NAME_ONLY_TYPES.has(el.className)) {
    return el.contentDescription ? `device.getByLabel("${escapeJsString(el.contentDescription)}")` : undefined;
  }
  const text = isIos && !IOS_VALUE_TEXT_TYPES.has(el.className) && el.text !== el.contentDescription
    ? el.contentDescription
    : el.text;
  if (text) {
    // Like the role name above: an exact match needs the whole text, so a
    // long one is suggested as its leading part, matched as a substring.
    const exact = text.length <= 60;
    const shown = exact ? text : text.slice(0, 60);
    return `device.getByText("${escapeJsString(shown)}"${exact ? ', { exact: true }' : ''})`;
  }
  if (nativeId) return `device.locator({ id: "${escapeJsString(nativeId)}" })`;
  return undefined;
}

/** @internal — Build the Playwright-style strict mode violation error.
 *
 * `options` lets non-native surfaces (WebView locators, PILOT-227) reuse the
 * same message format: `totalCount` when `elements` is a truncated sample of
 * a larger match set, and `suggest` to override the per-element unambiguous
 * locator suggestion (the default suggests native `device.getBy*` locators).
 */
export function buildStrictModeViolationError(
  selectorDescription: string,
  elements: ElementInfo[],
  options?: {
    totalCount?: number;
    suggest?: (el: ElementInfo, index: number) => string | undefined;
  },
): StrictModeViolationError {
  const totalCount = options?.totalCount ?? elements.length;
  const suggest = options?.suggest ?? suggestSelectorFor;
  const shown = elements.slice(0, STRICT_ERROR_MAX_ELEMENTS);
  const lines = shown.map((el, i) => {
    const kind = el.role || el.className || 'element';
    let line = `    ${i + 1}) ${kind}`;
    if (el.text) line += ` "${truncateText(el.text, 60)}"`;
    if (el.bounds) line += ` [${el.bounds.left},${el.bounds.top}][${el.bounds.right},${el.bounds.bottom}]`;
    const aka = suggest(el, i);
    if (aka) line += ` aka ${aka}`;
    return line;
  });
  if (totalCount > shown.length) {
    lines.push(`    … and ${totalCount - shown.length} more`);
  }
  const message =
    `strict mode violation: ${selectorDescription} resolved to ${totalCount} elements:\n` +
    `${lines.join('\n')}\n` +
    'Hint: use { exact: true }, getByRole(role, { name, exact: true }), getByTestId(), or .first()/.nth()/.last() to target a single element.';
  return new StrictModeViolationError(message, elements, totalCount);
}

/**
 * Collapse accessibility-tree duplicates that target the same visual element.
 *
 * The iOS tree often exposes a text element twice: a parent StaticText
 * carrying the accessibility attributes (testID, traits) and an inner
 * StaticText child with the same label and pixel-identical bounds. Acting on
 * either taps the same point, so treating them as distinct matches would
 * raise false strict-mode violations (PILOT-226). Only elements with
 * identical text AND identical non-degenerate bounds are collapsed —
 * distinct elements that merely overlap keep their own entries. Keeps the
 * first occurrence (document order — the attribute-carrying parent).
 *
 * @internal
 */
export function collapseSameTargetDuplicates(elements: ElementInfo[]): ElementInfo[] {
  if (elements.length < 2) return elements;
  const seen = new Set<string>();
  const result: ElementInfo[] = [];
  for (const el of elements) {
    // Zero-size / bounds-less entries have no positional identity and are
    // never collapsed (sameTargetKey keys them by id for the same reason).
    const b = el.bounds;
    if (!b || b.right - b.left <= 0 || b.bottom - b.top <= 0) {
      result.push(el);
      continue;
    }
    const key = sameTargetKey(el);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(el);
  }
  return result;
}

/** @internal — bounds present and non-degenerate: the element can be placed on screen. */
function hasUsableGeometry(el: ElementInfo): boolean {
  const b = el.bounds;
  return !!b && b.right - b.left > 0 && b.bottom - b.top > 0;
}

/**
 * Identity of an element across two reads of the same hierarchy.
 *
 * `elementId` is NOT that identity: both agents mint a fresh id on every
 * `findElements` (Android `ElementFinder.cacheAndConvert`, iOS
 * `ElementFinder`/`SnapshotElementFinder`), so the same element read twice
 * never shares an id. Anything that combines two reads — `and()` intersects
 * its operands, `or()` de-duplicates their union — has to key on what IS
 * stable within one hierarchy: the element's bounds and text, the same "same
 * visual target" notion `collapseSameTargetDuplicates` uses (PILOT-349).
 *
 * An element without usable geometry — no bounds, or a zero-size rect — has
 * no cross-read identity and keys by its per-read id, so it only ever matches
 * itself within one read. This matters more than it looks: Android reports
 * every element scrolled fully out of the viewport at `0,0,0,0`
 * (`UiObject2.visibleBounds` of a clipped view), so keying zero-size rects
 * by position would make all clipped same-text elements — icon buttons with
 * empty text, say — one element: false `and()` intersections and `or()`
 * unions that lose members. A clipped element has nothing to lose by being
 * unmatchable across reads: `toBeVisible` is false either way,
 * `scrollIntoView` treats a miss as "keep scrolling", and a tap cannot land
 * on it. Same rule as the collapser (PILOT-226), for the same reason.
 *
 * @internal
 */
export function sameTargetKey(el: ElementInfo): string {
  const b = el.bounds;
  if (!b || b.right - b.left <= 0 || b.bottom - b.top <= 0) return `id:${el.elementId || anonymousIdentity(el)}`;
  return `${b.left},${b.top},${b.right},${b.bottom}|${el.text}`;
}

/**
 * A per-object identity for an element the agent reported WITHOUT an id (a
 * proto3 default the agents never actually emit, but `_actionTarget` hedges
 * against it too). Two such elements must not share the key `id:` — that
 * would make and() intersect them and or() drop one.
 */
const anonymousIdentities = new WeakMap<ElementInfo, number>();
let nextAnonymousIdentity = 0;
function anonymousIdentity(el: ElementInfo): string {
  let n = anonymousIdentities.get(el);
  if (n === undefined) {
    n = ++nextAnonymousIdentity;
    anonymousIdentities.set(el, n);
  }
  return `anon-${n}`;
}

/**
 * @internal — How an action should be dispatched against a resolved element:
 * by a property selector (the agent re-finds it — used for unmodified handles),
 * or by the agent-cached `elementId` of the exact element a positional/filtered
 * handle resolved (so the action can't fall on an earlier match that shares an
 * accessibility property).
 */
type ActionTarget = { selector: Selector } | { elementId: string };

// ─── Off-screen targets of tap-family actions (PILOT-716) ───

/** The actions that wait for an enabled target before touching it. */
type TapFamilyAction = 'tap' | 'doubleTap' | 'longPress' | 'setChecked';

/**
 * Whether the platform reports `el` in the tree with no part of it on screen
 * (iOS: viewport ratio 0; Android's tree holds on-screen nodes only). An
 * element without bounds or with a zero-size frame is invisible for another
 * reason and is left to the action, as before.
 */
function isOffScreen(el: ElementInfo): boolean {
  const b = el.bounds;
  return !el.visible && !!b && b.right > b.left && b.bottom > b.top;
}

/**
 * The advice both platforms give when a tap-family action cannot reach its
 * element because it may be off-screen. Tapsmith's taps do not scroll, unlike
 * a Playwright click: Android cannot see an off-screen row to scroll to, so
 * neither platform does, and scrolling stays the caller's explicit step.
 */
function scrollFirstAdvice(action: TapFamilyAction, how: string): string {
  return `${action}() does not scroll, so scroll it into view first with ${how}, then ${action}() it.`;
}

/** The not-found hint: the element may be off-screen in a scrollable list (Android never lists such rows). */
function offScreenHint(action: TapFamilyAction): string {
  return 'It may be off-screen in a scrollable list: ' +
    scrollFirstAdvice(action, 'await locator.scrollIntoView() (scrollIntoView({ direction: "down" }) for one above the screen)');
}

/**
 * The hint a getByTestId() miss carries on Android (PILOT-828): Compose
 * exposes a `Modifier.testTag()` as the resource-id getByTestId matches only
 * under `testTagsAsResourceId`, which applies to the node it is set on and
 * its descendants.
 */
const ANDROID_TEST_TAG_HINT = ' On Android, a Jetpack Compose Modifier.testTag() is a test id only where the app sets ' +
  'Modifier.semantics { testTagsAsResourceId = true } on it or an ancestor — on the root of setContent, for the whole screen.';

/** How often a refused tap-family dispatch is retried. */
const NOT_HITTABLE_RETRY_MS = 1000;
/** The error type of the advice a still-refused dispatch ends with. */
const NOT_HITTABLE_ERROR_TYPE = 'ELEMENT_NOT_HITTABLE';

/**
 * The agents' refusals of a touch on an element they cannot hit at all: off
 * the screen, or clipped by its list (behind a header) — iOS still calls a
 * clipped row "visible", so the auto-wait cannot see it coming. The iOS
 * agent words tap()'s refusal with the reason, doubleTap()'s and
 * longPress()'s without.
 */
function isNotHittableRefusal(message: string | undefined): boolean {
  return message === 'Element is not hittable (may be off-screen or hidden)' || message === 'Element is not hittable' ||
    // Android's agent, for a fully clipped node (one its list hides), after
    // waiting out the budget: tap() in one wording, doubleTap()/longPress() in
    // another. The same advice applies.
    !!message?.includes('is not visible on screen (scrolled off, hidden, or fully clipped)') ||
    !!message?.includes('element has empty visible bounds (zero-size, fully clipped, or off screen)');
}

/**
 * The deadline error for an element found in the tree but entirely
 * off-screen (iOS reports such nodes): definite, with the way to scroll to
 * it that the element's position tells.
 */
function offScreenError(desc: string, timeoutMs: number, action: TapFamilyAction, bounds: ElementInfo['bounds']): Error {
  // Above or left of the screen is certain from the frame; below and right of
  // it look alike without the screen's width, so that advice covers both.
  const how = bounds && bounds.bottom <= 0
    ? 'await locator.scrollIntoView({ direction: "down" })'
    : bounds && bounds.right <= 0
      ? 'scroll("left") on the horizontal list that holds it'
      : 'await locator.scrollIntoView() (or scroll("right") on the horizontal list that holds it, if it is off to the side)';
  return new Error(
    `Element ${desc} is off-screen: it was found, but no part of it was on screen after waiting ${timeoutMs}ms. ` +
      scrollFirstAdvice(action, how),
  );
}

/**
 * @internal — Whether an action failure means the agent's cached element is no
 * longer usable, so re-resolving to a fresh id and retrying may succeed. Covers
 * both wordings: the cached id was evicted / its snapshot invalidated by an
 * intervening snapshot ("…not found. It may have gone stale.") and a live
 * StaleObjectException where the cached object's view re-rendered ("Element is
 * stale (UI changed): …", Android).
 */
/**
 * The least an action dispatch is given: an element that became enabled right
 * at the deadline, or a stale retry late in the budget, still gets time to act.
 */
const MIN_ACTION_BUDGET_MS = 1000;

/**
 * @internal — The time budget for each dispatch of one action, pinned to a
 * deadline that starts at the first dispatch (not when the action is set up:
 * a traced action captures the screen in between). The agent can spend a
 * dispatch's whole budget waiting out a covered target (PILOT-223,
 * PILOT-362), so a stale-element retry — or setChecked's re-tap — must get
 * what is left, not the full budget again. A zero budget (the explicit
 * no-wait timeout) stays zero; a late retry is floored at
 * `MIN_ACTION_BUDGET_MS`.
 */
export function actionBudget(remainingMs: number): () => number {
  if (remainingMs <= 0) return () => 0;
  // A late retry still gets a usable budget — the daemon waits it + 5 s for
  // the agent — but never more than the action started with.
  const floor = Math.min(remainingMs, MIN_ACTION_BUDGET_MS);
  let deadline: number | undefined;
  return () => {
    deadline ??= Date.now() + remainingMs;
    return Math.max(floor, deadline - Date.now());
  };
}

function isStaleElementError(message: string | undefined): boolean {
  return !!message && /stale/i.test(message);
}

/** @internal Brand key for cross-instance type checks (CJS/ESM dual-package). */
export const ELEMENT_HANDLE_BRAND = Symbol.for('tapsmith.ElementHandle');

/**
 * A locator: a lazy query for an element, as in Playwright. Building one
 * looks nothing up; each action or assertion resolves it afresh, auto-waits
 * for the element (and, for actions, for it to be enabled and uncovered)
 * up to the timeout, and throws on more than one match (strict mode).
 */
export class ElementHandle {
  /** @internal */
  readonly [ELEMENT_HANDLE_BRAND] = true;
  /** @internal */
  readonly _client: TapsmithGrpcClient;
  /** @internal */
  readonly _selector: Selector;
  /** @internal */
  readonly _timeoutMs: number;
  /** @internal */
  private readonly _options: ElementHandleOptions;

  /** @internal — Side-channel for assertion functions to report expected/actual. */
  _assertionResult: { expected: string | undefined; actual: string | undefined } = { expected: undefined, actual: undefined };

  /** @internal — Trace capture context from the Device, if tracing is active. */
  get _traceCapture(): TraceCapture | undefined {
    return this._options.traceCapture;
  }

  constructor(
    client: TapsmithGrpcClient,
    selector: Selector,
    timeoutMs: number,
    options?: ElementHandleOptions,
  ) {
    this._client = client;
    this._selector = selector;
    this._timeoutMs = timeoutMs;
    this._options = options ?? {};
  }

  // ── Scoping (Playwright-style getBy* methods) ──

  /**
   * Locate a descendant by visible text. Case-insensitive substring match by
   * default, as in Playwright (PILOT-522); pass `{ exact: true }` for a
   * case-sensitive, whole-text match, or a RegExp to test the element's
   * text with (PILOT-520).
   */
  getByText(text: string | RegExp, options?: { exact?: boolean }): ElementHandle {
    return this._scoped(options?.exact ? _text(text) : _textContains(text));
  }

  /**
   * Locate a descendant by accessibility role, optionally filtering by name or
   * state. Takes the same role names as `device.getByRole()`; lazy, like
   * every locator.
   */
  getByRole(role: Role | (string & {}), options?: RoleLocatorOptions): ElementHandle {
    return this._scoped(_role(role, options));
  }

  /**
   * Locate a descendant by its accessibility description (Android
   * `contentDescription`, iOS `accessibilityLabel`).
   */
  getByDescription(text: string): ElementHandle {
    return this._scoped(_contentDesc(text));
  }

  /** Locate a descendant by placeholder text (Android hint, iOS placeholder). */
  getByPlaceholder(text: string): ElementHandle {
    return this._scoped(_hint(text));
  }

  /** Locate a descendant by its test ID. */
  getByTestId(testId: string): ElementHandle {
    return this._scoped(_testId(testId));
  }

  /**
   * Locate a descendant input element by its associated label text. Finds
   * form controls whose accessible name is derived from a nearby label.
   */
  getByLabel(text: string | RegExp): ElementHandle {
    return this._scoped(_label(text));
  }

  /**
   * Escape hatch: locate a descendant by native id, xpath, or class name.
   * Prefer accessible getters (`getByRole`, `getByText`, `getByDescription`)
   * when possible.
   */
  locator(options: LocatorOptions): ElementHandle {
    return this._scoped(locatorOptionsToSelector(options));
  }

  /**
   * @internal — A child scoped to this handle: the parent is resolved to its
   * concrete element(s) and only children inside them are kept (see
   * {@link inScope}). Every parent goes this
   * way, modified or not: the agents scope a find only by a resolved element,
   * never by a nested parent selector, so a plain parent sent as one was
   * silently ignored and the child matched across the whole screen
   * (PILOT-850).
   */
  private _scoped(child: Selector): ElementHandle {
    return new ElementHandle(this._client, child, this._timeoutMs, {
      scopeParent: this,
      traceCapture: this._options.traceCapture,
      platform: this._options.platform,
      typingDelay: this._options.typingDelay,
      doubleTapInterval: this._options.doubleTapInterval,
    });
  }

  // ── Positional selection (PILOT-15) ──

  /** Return a new handle targeting the first match. */
  first(): ElementHandle {
    return this.nth(0);
  }

  /** Return a new handle targeting the last match. */
  last(): ElementHandle {
    return this.nth(-1);
  }

  /**
   * Return a new handle targeting the match at `index` (0-based). Negative
   * indices count from the end.
   *
   * On a handle that already carries a positional index — `list.first()`, or
   * a handle from `all()` — the new index narrows THAT one element rather
   * than re-indexing the original match set (Playwright semantics, and the
   * same rule as `WebViewLocator`): `first()`/`last()`/`nth(0)`/`nth(-1)` of
   * one element are itself, any other index is nothing.
   */
  nth(index: number): ElementHandle {
    if (!Number.isInteger(index)) {
      // selectNth would bounds-check a fractional index as in range and index
      // the array at it, yielding [undefined] — a phantom count() match and a
      // TypeError far from the mistake. Refuse it here, at the public entry.
      throw new Error(`nth() requires an integer index, got ${index}`);
    }
    if (this._options.nthIndex !== undefined) {
      return new ElementHandle(this._client, this._selector, this._timeoutMs, {
        ...this._options,
        post: [...(this._options.post ?? []), { nth: index }],
      });
    }
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      nthIndex: index,
    });
  }

  // ── Filtering (PILOT-16) ──

  /**
   * Narrow matches by additional criteria without changing the selector.
   *
   * Modifiers compose in call order: a filter chained AFTER a positional
   * index (`list.nth(1).filter(f)`, `rows[i].filter(f)` on a handle from
   * `all()`) keeps that one element if it matches and nothing otherwise, as
   * in Playwright — it does not become "the second matching row".
   */
  filter(criteria: FilterOptions): ElementHandle {
    if (this._options.nthIndex !== undefined) {
      return new ElementHandle(this._client, this._selector, this._timeoutMs, {
        ...this._options,
        post: [...(this._options.post ?? []), { filter: criteria }],
      });
    }
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      filters: [...(this._options.filters ?? []), criteria],
    });
  }

  // ── Combining selectors (PILOT-17) ──

  /**
   * Return a handle matching elements that satisfy both this and the other handle's selector.
   * `this` (with all its modifiers) becomes the left operand, preserving call order.
   */
  and(other: ElementHandle): ElementHandle {
    ElementHandle._assertOperandNotXpath('and', this);
    ElementHandle._assertOperandNotXpath('and', other);
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      andSelf: this,
      andHandle: other,
      traceCapture: this._options.traceCapture,
      platform: this._options.platform,
      // Deliberately NOT ...this._options: the receiver's modifiers live in
      // andSelf and must not double-apply on the combined handle. Only the
      // config-derived action knobs carry over.
      typingDelay: this._options.typingDelay,
      doubleTapInterval: this._options.doubleTapInterval,
    });
  }

  /**
   * Return a handle matching elements that satisfy either this or the other handle's selector.
   * `this` (with all its modifiers) becomes the left operand, preserving call order.
   */
  or(other: ElementHandle): ElementHandle {
    ElementHandle._assertOperandNotXpath('or', this);
    ElementHandle._assertOperandNotXpath('or', other);
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      orSelf: this,
      orHandle: other,
      traceCapture: this._options.traceCapture,
      platform: this._options.platform,
      // As in and(): only the config-derived action knobs carry over.
      typingDelay: this._options.typingDelay,
      doubleTapInterval: this._options.doubleTapInterval,
    });
  }

  /**
   * @internal — and()/or() combine two reads by bounds + text, and the Android
   * agent's xpath path reports both from a different read (the node's OWN
   * text, the XML dump's bounds) than every other selector, so an xpath
   * operand can never key equal to the other side: the combination would
   * resolve to a plausible-looking empty (and) or doubled (or) result. Refuse
   * it up front.
   */
  private static _assertOperandNotXpath(method: string, operand: ElementHandle): void {
    const offending = ElementHandle._findXpath(operand);
    if (offending) {
      throw new Error(
        `${method}() cannot combine an xpath locator (${formatSelector(offending)}). ` +
          'xpath locators are Android-only and for use on their own — see docs/selectors.md.',
      );
    }
  }

  /**
   * @internal — The xpath selector anywhere in this handle's shape: its own
   * selector (or a nested `parent`, as filter({ has }) builds), a scoped
   * ancestor (`locator({ xpath }).getByText(…)` keeps it in `scopeParent`),
   * or an operand of a nested and()/or().
   */
  private static _findXpath(handle: ElementHandle): Selector | undefined {
    for (let sel: Selector | undefined = handle._selector; sel; sel = sel.parent) {
      if (sel.kind.type === 'xpath') return sel;
    }
    const o = handle._options;
    for (const nested of [o.scopeParent, o.andSelf, o.andHandle, o.orSelf, o.orHandle]) {
      if (!nested) continue;
      const found = ElementHandle._findXpath(nested);
      if (found) return found;
    }
    return undefined;
  }

  // ── Internal resolution helpers ──

  /**
   * @internal — Whether this handle's own Selector misnames it: chained off a
   * parent (`parent.getBy*()`), or an and()/or() combination, whose Selector
   * is only one operand's.
   */
  _isComposed(): boolean {
    const o = this._options;
    return o.scopeParent !== undefined || o.andHandle !== undefined || o.orHandle !== undefined;
  }

  /** @internal */
  private _hasModifiers(): boolean {
    return (
      this._options.nthIndex !== undefined ||
      (this._options.filters !== undefined && this._options.filters.length > 0) ||
      this._options.andHandle !== undefined ||
      this._options.orHandle !== undefined ||
      this._options.scopeParent !== undefined
    );
  }

  /** @internal — Resolve all matching elements. Recursively resolves operands for and/or, then applies filters. */
  async _resolveAll(): Promise<ElementInfo[]> {
    if (this._options.andHandle) {
      const left = this._options.andSelf!;
      const right = this._options.andHandle;

      // Each operand keeps its own positional index (`a.first().and(b)`
      // intersects the FIRST a with b — PILOT-347) and anything chained after
      // it; _resolveAll alone never applies them.
      const [leftEls, rightEls] = await Promise.all([
        left._resolveAll().then((els) => left._select(els)),
        right._resolveAll().then((els) => right._select(els)),
      ]);

      // Each operand is its own hierarchy read, and the agents mint a fresh
      // elementId per read, so intersect by the element's stable identity
      // (bounds + text), not by id (PILOT-349). The left operand's entries
      // are kept, preserving call order.
      const rightKeys = new Set(rightEls.map(sameTargetKey));
      let elements = leftEls.filter((e) => rightKeys.has(sameTargetKey(e)));

      // Apply post-combination filters (from .and(b).filter(F))
      if (this._options.filters) {
        for (const f of this._options.filters) {
          elements = await this._applyFilter(elements, f);
        }
      }
      return elements;
    }

    if (this._options.orHandle) {
      const left = this._options.orSelf!;
      const right = this._options.orHandle;

      // Each operand keeps its own positional index (PILOT-347), as in and().
      const [leftEls, rightEls] = await Promise.all([
        left._resolveAll().then((els) => left._select(els)),
        right._resolveAll().then((els) => right._select(els)),
      ]);

      // De-duplicate ACROSS the operands by stable identity, not by the
      // per-read elementId (PILOT-349): an element both operands match would
      // otherwise appear twice and turn every single-element use into a
      // strict-mode violation. Only right entries the left read already has
      // are dropped — every operand's own entries all SURVIVE (the collapser's
      // exemptions are respected; the sort below only reorders), so a union is
      // never smaller than one operand alone. An element with no usable
      // geometry (clipped: 0,0,0,0) has no cross-read identity and is kept
      // once per operand — see sameTargetKey.
      // The union is then put in SCREEN order (top, then left) so that
      // `first()`/`nth()` on it pick by position, as Playwright's DOM-ordered
      // or() does — the operands are two independent reads, so position is
      // the only shared order they have. Geometry-less entries keep their
      // operand order after the positioned ones (the sort is stable).
      const leftKeys = new Set(leftEls.map(sameTargetKey));
      let elements = [...leftEls, ...rightEls.filter((e) => !leftKeys.has(sameTargetKey(e)))]
        .sort((a, b) => {
          const ga = hasUsableGeometry(a);
          const gb = hasUsableGeometry(b);
          if (ga && gb) return a.bounds!.top - b.bounds!.top || a.bounds!.left - b.bounds!.left;
          if (ga !== gb) return ga ? -1 : 1;
          return 0;
        });

      // Apply post-combination filters (from .or(b).filter(F))
      if (this._options.filters) {
        for (const f of this._options.filters) {
          elements = await this._applyFilter(elements, f);
        }
      }
      return elements;
    }

    // Base case: no and/or — resolve selector then apply filters. A scoped
    // child's parent is read at the same time, not after (PILOT-850).
    const scopeParent = this._options.scopeParent;
    const [res, parents] = await Promise.all([
      this._client.findElements(this._selector, this._timeoutMs),
      scopeParent ? ElementHandle._resolveScope(scopeParent) : Promise.resolve(undefined),
    ]);
    if (res.errorMessage) {
      // Daemon-level failure (agent dead, command error) — not "no match".
      // Surface it instead of letting it read as an empty result.
      throw new Error(`findElements failed: ${res.errorMessage}`);
    }
    let elements = res.elements ?? [];
    // Scope first: a same-size child keys like its parent to the duplicate
    // collapse (bounds + text) but not to scoping (id, class, description),
    // so collapsing first could keep the parent and drop the child.
    if (parents) {
      elements = scopeToParents(parents, elements, this._options.platform === 'ios');
    }
    elements = collapseSameTargetDuplicates(elements);

    if (this._options.filters) {
      for (const f of this._options.filters) {
        elements = await this._applyFilter(elements, f);
      }
    }

    return elements;
  }

  /**
   * @internal — The element(s) a scoped child is searched within (see
   * {@link inScope}). The parent's modifiers are honored: a positional parent
   * (`.first()`, `.nth()`, an `all()` handle) resolves to its single selected
   * element; a plain, filter or and/or parent resolves to all of its matches,
   * and a child inside *any* of them is in scope.
   *
   * A positional parent is resolved live by index, like every reader on it:
   * re-identifying a previously seen row in a fresh read has no reliable key —
   * element ids go stale, bounds move with any layout shift, text mutates and
   * testIDs repeat — so every "smarter" match has a silent wrong-row failure
   * (PILOT-346). A missing or out-of-range parent resolves to an empty scope
   * (no children in scope) rather than throwing — so `count()`/`exists()` and
   * absence assertions on a scoped handle report 0/false/empty like
   * Playwright, instead of surfacing the parent's "not found" error.
   */
  private static async _resolveScope(parent: ElementHandle): Promise<ElementInfo[]> {
    return parent._select(await parent._resolveAll());
  }

  /** @internal */
  private async _applyFilter(
    elements: ElementInfo[],
    filter: FilterOptions,
  ): Promise<ElementInfo[]> {
    // Nothing to filter: answer without the `has`/`hasNot` child read. An
    // empty match set (or an out-of-range index ahead of a post-index filter)
    // would otherwise cost a hierarchy dump per poll tick and expose a
    // definite "no match" to a momentary fault on a read that decides nothing.
    if (elements.length === 0) return elements;
    let result = elements;

    if (filter.hasText !== undefined) {
      result = result.filter((el) => {
        if (filter.hasText instanceof RegExp) return filter.hasText.test(el.text);
        return el.text.includes(filter.hasText as string);
      });
    }

    if (filter.hasNotText !== undefined) {
      result = result.filter((el) => {
        if (filter.hasNotText instanceof RegExp) return !filter.hasNotText.test(el.text);
        return !el.text.includes(filter.hasNotText as string);
      });
    }

    if (filter.has !== undefined) {
      const childSelector = withParent(filter.has._selector, this._selector);
      const childRes = await this._client.findElements(childSelector, this._timeoutMs);
      if (childRes.errorMessage) {
        // Don't silently mis-filter on a child-resolution failure: surface it
        // so a transient stale snapshot retries and a real daemon error fails
        // fast (via isPollableNotFoundError), as elsewhere.
        throw new Error(`findElements failed: ${childRes.errorMessage}`);
      }
      const childElements = childRes.elements ?? [];
      result = result.filter((parent) => {
        // If parent has no bounds, we can't determine geometric containment — skip it
        if (!parent.bounds) return false;
        const results = childElements.map((child) => boundsContain(parent.bounds, child.bounds));
        const hasContained = results.some((r) => r === 'contained');
        if (hasContained) return true;
        // Fallback: if all results are indeterminate (child bounds undefined)
        // but the daemon returned children scoped to our selector, trust the
        // daemon's scoping and consider it a match.
        const allIndeterminate = results.length > 0 && results.every((r) => r === 'indeterminate');
        return allIndeterminate;
      });
    }

    if (filter.hasNot !== undefined) {
      const childSelector = withParent(filter.hasNot._selector, this._selector);
      const childRes = await this._client.findElements(childSelector, this._timeoutMs);
      if (childRes.errorMessage) {
        throw new Error(`findElements failed: ${childRes.errorMessage}`);
      }
      const childElements = childRes.elements ?? [];
      result = result.filter((parent) => {
        if (!parent.bounds) return true;
        const results = childElements.map((child) => boundsContain(parent.bounds, child.bounds));
        // Exclude if any child is definitively contained
        if (results.some((r) => r === 'contained')) return false;
        // Mirror the `has` logic: if all results are indeterminate (child
        // bounds undefined) but the daemon returned children, trust the
        // daemon's scoping — the child IS present, so exclude the parent.
        const allIndeterminate = results.length > 0 && results.every((r) => r === 'indeterminate');
        if (allIndeterminate) return false;
        return true;
      });
    }

    return result;
  }

  /**
   * @internal — Resolve to a single target element, respecting nth index.
   *
   * Strict mode (PILOT-226): without a positional modifier, resolving to
   * more than one element is an error — never a silent first-match.
   */
  private async _resolveOne(): Promise<ElementInfo> {
    const elements = await this._resolveAll();
    const nthIndex = this._options.nthIndex;

    if (nthIndex !== undefined) {
      // The same walk as `_select`, with a diagnostic per step: a positional
      // miss names the index and how many elements there were to pick from
      // (so `first().nth(5)` reports "found 1", as `nth(5)` reports the list
      // size), and a filter that empties the one element is a plain not-found.
      let selected = elements;
      for (const step of [{ nth: nthIndex }, ...(this._options.post ?? [])]) {
        const found = selected.length;
        selected = await this._applyStep(selected, step);
        if (selected.length === 0) {
          if ('nth' in step) {
            const expectedCount = step.nth >= 0 ? step.nth + 1 : -step.nth;
            throw new Error(`nth(${step.nth}): expected at least ${expectedCount} element(s), but found ${found}`);
          }
          throw new Error(`Element not found: ${this._describe()}`);
        }
      }
      return selected[0];
    }

    if (elements.length === 0) {
      throw new Error(`Element not found: ${this._describe()}`);
    }
    if (elements.length > 1) {
      throw buildStrictModeViolationError(this._describe(), elements);
    }
    return elements[0];
  }

  /**
   * @internal — The Selector this locator sends the agent as it is, or
   * undefined when it carries anything a Selector cannot hold (a position,
   * filter, and/or, or a parent scope). MCP snapshot suggestions are checked
   * by sending such selectors in one batch (PILOT-848).
   */
  _plainSelector(): Selector | undefined {
    const o = this._options;
    const modified = o.nthIndex !== undefined || !!o.filters?.length || !!o.post?.length
      || !!o.andHandle || !!o.orHandle || !!o.scopeParent;
    return modified ? undefined : this._selector;
  }

  /**
   * @internal — What this locator matches right now, without waiting for a
   * match, read the way `count()` reads it (a stale snapshot is re-read) (MCP `tapsmith_test_locator`,
   * PILOT-848). `total` is the matches before a positional index narrowed
   * them (equal to `matches.length` without one); `positional` says whether
   * one did — such a locator is exempt from strict mode.
   */
  async _currentMatches(): Promise<{ matches: ElementInfo[]; total: number; positional: boolean }> {
    const { all, matches } = await this._readMatchSet();
    return { matches, total: all.length, positional: this._options.nthIndex !== undefined };
  }

  /**
   * @internal — Apply this handle's positional index and every modifier
   * chained after it, in call order, to its resolved matches (see
   * {@link PostIndexStep}). Filters chained before the index are applied by
   * `_resolveAll`; this is the one place the index and what follows it are
   * applied, so `count()`, `all()`, actions, assertions, waits, and/or
   * operands and scope parents cannot disagree about which element a
   * positional handle names. At most one element once an index has applied.
   */
  private async _select(elements: ElementInfo[]): Promise<ElementInfo[]> {
    // `post` only has meaning after an index (nth()/filter() gate on it);
    // without one every read path ignores it, this one included, so a
    // malformed shape can never make two readers disagree.
    if (this._options.nthIndex === undefined) return elements;
    let result = selectNth(elements, this._options.nthIndex);
    for (const step of this._options.post ?? []) {
      result = await this._applyStep(result, step);
    }
    return result;
  }

  /** @internal — Apply one positional-chain step (see {@link PostIndexStep}). */
  private _applyStep(elements: ElementInfo[], step: PostIndexStep): Promise<ElementInfo[]> {
    return 'nth' in step ? Promise.resolve(selectNth(elements, step.nth)) : this._applyFilter(elements, step.filter);
  }

  /**
   * @internal — The modifiers chained after the positional index, for
   * `_describe()`. Rendered only when there are any (`.nth(1).filter(…×1)`,
   * `.first().nth(1)`); a bare index is not rendered, as before, so existing
   * error messages keep their shape.
   */
  private _describePostIndex(): string {
    const post = this._options.post;
    if (!post?.length) return '';
    // `post` only exists alongside an index (nth()/filter() gate on it); if
    // that ever changes, render the steps alone rather than "undefined".
    let desc = this._options.nthIndex === undefined ? '' : renderNth(this._options.nthIndex);
    let filters = 0;
    const flushFilters = (): void => {
      if (filters) desc += `.filter(…×${filters})`;
      filters = 0;
    };
    for (const step of post) {
      if ('nth' in step) {
        flushFilters();
        desc += renderNth(step.nth);
      } else {
        filters++;
      }
    }
    flushFilters();
    return desc;
  }

  /**
   * @internal — The platform hint a miss carries, as ". On iOS …" to append
   * to the failure message, or '': on iOS for an unnamed `getByRole()` of a
   * role React Native publishes nothing for there (PILOT-718), on Android
   * for a `getByTestId()`, which a Jetpack Compose testTag reaches only with
   * testTagsAsResourceId (PILOT-828). Not for and()/or(): the miss may be the
   * other operand's. Not after a `positionalDetail` either: the locator did
   * match, only not at that index.
   */
  _missHint(positionalDetail = ''): string {
    const hint = this._missHintSentence(positionalDetail);
    // A sentence of its own after the message it follows.
    return hint && `.${hint}`;
  }

  /**
   * @internal — Everything a not-found message says after its first
   * sentence, as ". …" to append to it (PILOT-849): the locators that do
   * match the same words on screen now (asked of the device agent, for an
   * unmodified native locator), then `hints` (by default the platform hint,
   * {@link _missHint}), then where to find a locator that matches.
   *
   * '' after a `positionalDetail`, or for an `nth(i)` past the first or last
   * (which every reader reports as a positional miss, matched or not): the
   * locator may well match, only not at that index. The device is asked for
   * near misses for no longer than the caller waited (`waitedMs`), and not at
   * all after a no-wait (`timeout: 0`) read, which stays a single read.
   */
  async _locatorMissHelp(options: { waitedMs: number; positionalDetail?: string; hints?: string }): Promise<string> {
    const positionalDetail = options.positionalDetail ?? '';
    const nth = this._options.nthIndex;
    if (positionalDetail || (nth !== undefined && nth !== 0 && nth !== -1)) return '';
    const hints = options.hints ?? this._missHintSentence(positionalDetail);
    const budgetMs = Math.min(NEAR_MISS_BUDGET_MS, options.waitedMs);
    const near = this._hasModifiers() || budgetMs <= 0
      ? ''
      : await nearMissHint(this._client, this._selector, this._client._getAbortSignal?.(), budgetMs);
    return `. ${[near, hints.trim(), LOCATOR_PICKER_HINT].filter(Boolean).join(' ')}`;
  }

  /** {@link _missHint} as a bare sentence (with its leading space), to follow one that ends in a full stop. */
  private _missHintSentence(positionalDetail = ''): string {
    if (positionalDetail || this._options.andHandle || this._options.orHandle) return '';
    const kind = this._selector.kind;
    if (kind.type === 'role') return iosUnnamedRoleMissHint(kind.value, this._options.platform);
    return kind.type === 'testId' && this._options.platform === 'android' ? ANDROID_TEST_TAG_HINT : '';
  }

  /** @internal — The locator as the code that built it, for error and assertion messages. */
  _describe(): string {
    const sel = formatSelector(this._selector);
    if (this._options.andHandle) {
      const left = this._options.andSelf?._describe() ?? sel;
      const right = this._options.andHandle._describe();
      let desc = `${left} AND ${right}`;
      if (this._options.filters?.length) desc += `.filter(…×${this._options.filters.length})`;
      return desc + this._describePostIndex();
    }
    if (this._options.orHandle) {
      const left = this._options.orSelf?._describe() ?? sel;
      const right = this._options.orHandle._describe();
      let desc = `${left} OR ${right}`;
      if (this._options.filters?.length) desc += `.filter(…×${this._options.filters.length})`;
      return desc + this._describePostIndex();
    }
    // A scoped child reads as the chain that built it, e.g.
    // getByRole("list").first().getByText("Row") — copy-pasteable code.
    let desc = sel;
    if (this._options.scopeParent) {
      const parent = this._options.scopeParent;
      // A bare index is not rendered on its own (_describePostIndex), but as
      // a scope it is what tells this row's child from every row's.
      const { nthIndex, post } = parent._options;
      const bareIndex = nthIndex !== undefined && !post?.length ? renderNth(nthIndex) : '';
      const parentDesc = parent._describe() + bareIndex;
      // An and/or parent is bracketed, so the child reads as scoping the
      // whole combination, not its right operand.
      const combined = parent._options.andHandle !== undefined || parent._options.orHandle !== undefined;
      desc = `${combined ? `(${parentDesc})` : parentDesc}.${sel}`;
    }
    if (this._options.filters?.length) desc += `.filter(…×${this._options.filters.length})`;
    return desc + this._describePostIndex();
  }

  /**
   * @internal — Build a selector to target a specific resolved element.
   *
   * Uses the resolved element's identifying property (resourceId,
   * contentDescription, or text) to build a simple selector. Such a selector
   * addresses the agent's FIRST match in document order, so it is only a
   * defensive fallback in `_actionTarget` for the (unexpected) case of a
   * resolved element with no cached id — normally a modified handle dispatches
   * by `elementId`, which targets the exact element.
   *
   * @param info - The resolved ElementInfo to target.
   */
  private _selectorForElement(info: ElementInfo): Selector {
    if (info.resourceId) return _id(info.resourceId);
    if (info.contentDescription) return _contentDesc(info.contentDescription);
    if (info.text) return _text(info.text);
    throw new Error(
      'Cannot target element for action: element has no resourceId, contentDescription, or text. ' +
        'Add accessibility identifiers to your app to use positional/filtered actions.',
    );
  }

  /**
   * @internal — Single-tick strict resolution for an unmodified handle.
   *
   * Fetches ALL matches via findElements (the agent does not auto-wait on
   * this RPC — callers poll). Throws a StrictModeViolationError when the
   * selector resolves to more than one element; returns the single match or
   * undefined when there is none yet.
   */
  private async _findOneStrict(timeoutMs: number): Promise<ElementInfo | undefined> {
    const res = await this._client.findElements(this._selector, timeoutMs);
    if (res.errorMessage) {
      // Daemon-level failure (agent dead, command error) — not "no match".
      // Must not look like a pollable not-found, so the real cause surfaces.
      throw new Error(`findElements failed: ${res.errorMessage}`);
    }
    const elements = collapseSameTargetDuplicates(res.elements ?? []);
    if (elements.length > 1) {
      throw buildStrictModeViolationError(this._describe(), elements);
    }
    return elements[0];
  }

  /**
   * @internal — Strict pre-action resolution for actions that don't require
   * the enabled state (type, scroll, focus, …). Polls until the locator
   * resolves (Playwright-style auto-wait).
   *
   * Modified handles resolve through `_resolveOne()` (strict for ambiguous
   * filter/and/or chains, exempt for positional ones). Unmodified handles
   * poll `findElements` so ambiguity is detected BEFORE the raw selector is
   * handed to the agent, which would otherwise act on the first match.
   * (A race between this check and the agent-side find is accepted — both
   * see elements in document order.)
   *
   * Returns the action's remaining timeout budget plus the resolved element
   * for modified handles (so `_actionTarget` can address it by id without
   * re-resolving). `timeoutMs === 0` skips polling entirely, preserving the
   * explicit opt-out behavior of `_waitForEnabled`.
   */
  private async _strictResolve(): Promise<{ remainingMs: number; element?: ElementInfo }> {
    const timeoutMs = this._timeoutMs;
    if (timeoutMs === 0) return { remainingMs: 0 };
    const deadline = Date.now() + timeoutMs;
    let lastTransientErr: Error | undefined;
    // The most recent positional miss (`nth(i): expected at least …`), kept so
    // the deadline error still says WHICH index was short and by how much.
    let lastPositionalMiss: Error | undefined;
    while (true) {
      const tick = await this._resolveTick(tickBudget(deadline));
      if (tick.kind === 'fault') {
        // A transient agent-command timeout (slow-but-alive agent) or a
        // momentary agent command failure is retried within the budget rather
        // than aborting the action; remember only the MOST RECENT one so a
        // budget-long stall surfaces the real infra error (not "not found"),
        // while an agent that recovered doesn't.
        lastTransientErr = tick.error;
      } else {
        // The agent answered (a match, an empty result, or a stale snapshot),
        // so it is currently responsive — clear any earlier transient timeout
        // so a genuine "not found" isn't misreported as an infra error at the
        // end. Strict violations and infra errors have already propagated.
        lastTransientErr = undefined;
        // Keep the diagnostic honest: the most recent tick that CARRIED a
        // count. A stale tick says nothing about how many matched, so it
        // neither refreshes nor discards the last confirmed count.
        if (tick.kind === 'miss') lastPositionalMiss = tick.positionalMiss;
        if (tick.kind === 'found') {
          lastPositionalMiss = undefined;
          const remaining = Math.max(0, deadline - Date.now());
          return {
            remainingMs: Math.min(timeoutMs, Math.max(remaining, MIN_ACTION_BUDGET_MS)),
            element: tick.element,
          };
        }
      }
      if (Date.now() >= deadline) {
        if (lastTransientErr) throw lastTransientErr;
        const detail = positionalMissDetail(lastPositionalMiss);
        throw new Error(
          `Element ${this._describe()} was not found after waiting ${timeoutMs}ms${detail}${await this._locatorMissHelp({ waitedMs: timeoutMs, positionalDetail: detail })}`,
        );
      }
      const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
      if (sleepMs > 0) await sleep(sleepMs, this._client._getAbortSignal?.());
    }
  }

  /**
   * @internal — One `_resolveOne()` read for the poll loops and the probe,
   * bounded by `budgetMs` on every modified handle shape.
   *
   * `_resolveOne` reads with the handle's own timeout (and an and/or operand's
   * own, often long, one), so a tick issued in a 30s wait would, on a wedged
   * agent, hold the call for 30s + headroom per read of the chain. Re-time the
   * tree to the tick budget first, exactly as `_resolveForWaitTick` does; a
   * scope parent or `filter({ has })` child query inherits it too. The budget
   * does not bound a healthy dump — the daemon's headroom does (see the note
   * by {@link POLL_INTERVAL_MS}) — so the usual 250ms tick costs nothing.
   */
  private _resolveOneWithin(budgetMs: number): Promise<ElementInfo> {
    return ElementHandle._cloneWithTimeout(this, budgetMs)._resolveOne();
  }

  /**
   * @internal — One bounded, modifier-aware read of this handle's single
   * target, classified for a poll loop. THE resolution primitive every ladder
   * in this file reads through — action auto-wait (`_strictResolve`,
   * `_waitForEnabled`), the visibility probes (`_probeOnce`) and
   * `scrollIntoView`'s probe and stabilisation — so they cannot disagree
   * about what a tick meant. (PILOT-345: the scroll probe read the raw
   * selector and ignored filter/and/or/scope, so it judged the scroll against
   * the wrong element.)
   *
   * Modified handles resolve through {@link _resolveOneWithin} (filters,
   * and/or, scope and the positional index all apply; strict for ambiguous
   * chains, exempt for positional ones); unmodified handles read
   * `findElements` once and apply strict mode host-side
   * ({@link _findOneStrict}). Either way one read, bounded by `budgetMs`.
   *
   * Never throws for a retryable outcome — a stale snapshot, a momentary
   * agent fault, or a genuine miss come back as ticks (a positional miss keeps
   * its `nth(i): expected …` error so a deadline message can name the index).
   * Fatal errors — strict violations, user aborts, transport failures — are
   * rethrown for the caller to propagate.
   */
  private async _resolveTick(budgetMs: number): Promise<ResolveTick> {
    try {
      const element = this._hasModifiers()
        ? await this._resolveOneWithin(budgetMs)
        : await this._findOneStrict(budgetMs);
      return element ? { kind: 'found', element } : { kind: 'miss' };
    } catch (err) {
      return ElementHandle._classifyTickError(err);
    }
  }

  /**
   * @internal — The tick a failed read amounts to, for {@link _resolveTick}
   * and {@link _existsTick}: a stale snapshot, a momentary agent fault or a
   * genuine miss come back as ticks (a positional miss keeps its
   * `nth(i): expected …` error so a deadline message can name the index).
   * Fatal errors — strict violations, user aborts, transport failures — are
   * rethrown for the caller to propagate.

   */
  private static _classifyTickError(err: unknown): ResolveTick {
    switch (classifyResolutionError(err)) {
      case 'stale':
        return { kind: 'stale' };
      case 'fault':
        return { kind: 'fault', error: err as Error };
      case 'miss':
        return {
          kind: 'miss',
          positionalMiss: err instanceof Error && err.message.startsWith('nth(') ? err : undefined,
        };
      default:
        throw err;
    }
  }

  /**
   * @internal — One bounded, modifier-aware, NON-STRICT read of this handle's
   * current matches, classified for a poll loop: the presence primitive behind
   * `exists()` (PILOT-344). Where {@link _resolveTick} resolves the single
   * target and throws on an ambiguous selector, this resolves every match
   * (after the positional modifier) and answers `found` when there is at
   * least one — `exists()` is a multi-element query like `count()` and
   * `all()`, exempt from strict mode.
   *
   * Filters, and/or, scope and the positional index all apply, through the
   * same re-timed resolution the assertion poller uses
   * ({@link _resolveForAssertion} with `strict: false`), so every read of a
   * chain is bounded by `budgetMs`. A failed read classifies exactly as
   * {@link _classifyTickError} does for the strict tick.
   */
  private async _existsTick(budgetMs: number): Promise<ResolveTick> {
    try {
      const elements = await this._resolveForAssertion(budgetMs, false);
      return elements.length > 0 ? { kind: 'found', element: elements[0] } : { kind: 'miss' };
    } catch (err) {
      return ElementHandle._classifyTickError(err);
    }
  }

  /** @internal — This locator with another timeout (MCP actions, PILOT-848). */
  _withTimeout(timeoutMs: number): ElementHandle {
    return ElementHandle._cloneWithTimeout(this, timeoutMs);
  }

  /**
   * @internal — Check a public method's options (PILOT-840) and return the
   * handle the call should run on: `this`, or a copy re-timed to the options'
   * `timeout` when one was given. A method that gets a copy back calls itself
   * on it without the options, so the per-call timeout bounds every wait the
   * call makes, and/or operands and scope parents included.
   */
  private _forCall<T extends object>(
    method: string,
    options: T | undefined,
    allowed: readonly (keyof T & string)[],
  ): ElementHandle {
    const checked = checkOptions(method, options, allowed) as { timeout?: unknown } | undefined;
    const timeout = checkTimeout(method, checked?.timeout);
    return timeout === undefined ? this : this._withTimeout(timeout);
  }

  /**
   * @internal — Deep-clone a handle tree, overriding the timeout at every
   * node (and/or operands carry their own, often long, timeouts). Used by
   * assertion and waitFor poll ticks so a single tick is bounded by the short
   * per-tick budget instead of an operand's full timeout (e.g. 30s); the outer
   * poll loop owns the overall deadline.
   */
  private static _cloneWithTimeout(h: ElementHandle, timeoutMs: number): ElementHandle {
    return new ElementHandle(h._client, h._selector, timeoutMs, {
      ...h._options,
      andSelf: h._options.andSelf ? ElementHandle._cloneWithTimeout(h._options.andSelf, timeoutMs) : undefined,
      andHandle: h._options.andHandle ? ElementHandle._cloneWithTimeout(h._options.andHandle, timeoutMs) : undefined,
      orSelf: h._options.orSelf ? ElementHandle._cloneWithTimeout(h._options.orSelf, timeoutMs) : undefined,
      orHandle: h._options.orHandle ? ElementHandle._cloneWithTimeout(h._options.orHandle, timeoutMs) : undefined,
      // Re-time the scope parent too, else resolving it during a poll tick
      // could block for the parent's full (e.g. 30s) timeout when not found.
      scopeParent: h._options.scopeParent ? ElementHandle._cloneWithTimeout(h._options.scopeParent, timeoutMs) : undefined,
    });
  }

  /**
   * @internal — Single-tick, modifier-aware resolution for assertions
   * (expect.ts). Returns the matching elements after applying any positional
   * modifier (so `.first()`/`.nth()` yield at most one element — fixing
   * assertions previously ignoring modifiers entirely).
   *
   * When `strict` is true and the handle has no positional modifier,
   * resolving to more than one element throws a StrictModeViolationError.
   * Absence-style checks (toBeHidden, negated visibility/existence) pass
   * `strict: false` and evaluate their condition over the full match set.
   */
  async _resolveForAssertion(timeoutMs: number, strict: boolean): Promise<ElementInfo[]> {
    // The re-timed tree is used for BOTH reads of a tick: the match set below
    // and, in `_select`, any `has`/`hasNot` filter chained after the
    // positional index (its child read uses the handle's timeout otherwise).
    const timed = ElementHandle._cloneWithTimeout(this, timeoutMs);
    let elements: ElementInfo[];
    if (
      this._options.filters?.length ||
      this._options.andHandle ||
      this._options.orHandle ||
      this._options.scopeParent !== undefined
    ) {
      // Filter/and/or/scope chains need client-side resolution; clone the whole
      // handle tree with a short timeout so a single assertion poll tick
      // stays fast — and/or operands carry their own (long) timeouts and
      // would otherwise cap each sub-query at e.g. 30s.
      const probe = new ElementHandle(this._client, this._selector, timeoutMs, {
        ...timed._options,
        nthIndex: undefined,
        post: undefined,
      });
      elements = await probe._resolveAll();
    } else {
      const res = await this._client.findElements(this._selector, timeoutMs);
      if (res.errorMessage) {
        throw new Error(`findElements failed: ${res.errorMessage}`);
      }
      elements = collapseSameTargetDuplicates(res.elements ?? []);
    }

    if (this._options.nthIndex !== undefined) return timed._select(elements);
    if (strict && elements.length > 1) {
      throw buildStrictModeViolationError(this._describe(), elements);
    }
    return elements;
  }

  /**
   * @internal — Poll until the target element is enabled, matching Playwright's
   * behavior of auto-waiting before actionable operations (tap, longPress).
   *
   * Returns `{ remainingMs, element }` where `remainingMs` is the action
   * timeout budget and `element` is the resolved ElementInfo. This avoids a
   * redundant gRPC round-trip in `_actionTarget` (eliminates a TOCTOU window).
   *
   * The goal is to share the original user timeout across "wait for enabled" +
   * "execute action" instead of doubling it, BUT with a `MIN_ACTION_BUDGET_MS`
   * floor: if the element becomes enabled right at the deadline, we still hand
   * the action at least 1 s so it has time to run.
   *
   * When `this._timeoutMs === 0` the method skips polling entirely and
   * returns 0, preserving the pre-auto-wait behavior for callers that
   * explicitly opt out of the wait.
   *
   * Throws if the element is not found or still disabled after the timeout.
   */
  private async _waitForEnabled(
    action: TapFamilyAction,
    options?: {
      offScreenOk?: (el: ElementInfo) => boolean;
      /** Wait until this time instead of a fresh timeout (a retried dispatch, see `_untilHittable`). */
      deadline?: number;
    },
  ): Promise<{ remainingMs: number; element?: ElementInfo }> {
    const timeoutMs = this._timeoutMs;
    // timeoutMs === 0 means "no polling": behave like the pre-auto-wait code
    // and hand the full zero budget straight to the action.
    if (timeoutMs === 0) return { remainingMs: 0 };
    const deadline = options?.deadline ?? Date.now() + timeoutMs;
    let lastSeenDisabled = false;
    let lastTransientErr: Error | undefined;
    // The most recent positional miss (`nth(i): expected at least …`), kept so
    // the deadline error still says WHICH index was short and by how much —
    // the same diagnostic _strictResolve gives `type()`, so `nth(5).tap()`
    // does not fail with a worse message than `nth(5).type()`.
    let lastPositionalMiss: Error | undefined;
    // An element found but entirely off-screen (iOS) is waited on like a
    // disabled one — it may scroll or animate into view — and reported as
    // off-screen at the deadline, instead of being handed to the agent, which
    // refused it at once as "not hittable" (PILOT-716).
    let lastSeenOffScreen: ElementInfo['bounds'];
    while (true) {
      const tick = await this._resolveTick(tickBudget(deadline));
      if (tick.kind === 'fault') {
        // A transient agent-command timeout (slow-but-alive agent, e.g. a
        // hierarchy dump on a loaded CI emulator) or a momentary agent command
        // failure is retried within the action budget instead of aborting;
        // remember only the MOST RECENT one so a budget-long stall surfaces
        // the real infra error (→ session recovery) rather than a misleading
        // "not found".
        lastTransientErr = tick.error;
      } else {
        // The agent answered (match, empty, or stale) → responsive; drop any
        // earlier transient timeout so a genuine "not found"/"disabled" isn't
        // reported as an infra error at the deadline. Anything fatal (a
        // crashed daemon, a strict violation) has already propagated.
        lastTransientErr = undefined;
        // Remember what the LAST counted read saw, so an element that was
        // present (disabled) for a tick and then vanished is reported as not
        // found, not as still disabled. A stale tick carries no count, so it
        // neither refreshes nor discards the last confirmed positional miss.
        if (tick.kind === 'miss') {
          lastPositionalMiss = tick.positionalMiss;
          lastSeenDisabled = false;
          lastSeenOffScreen = undefined;
        }
        if (tick.kind === 'found') {
          lastPositionalMiss = undefined;
          lastSeenDisabled = !tick.element.enabled;
          // setChecked() on an element already in the requested state does
          // not touch it, so it need not be on screen.
          lastSeenOffScreen = tick.element.enabled && isOffScreen(tick.element) && !options?.offScreenOk?.(tick.element)
            ? tick.element.bounds
            : undefined;
          if (tick.element.enabled && !lastSeenOffScreen) {
            const remaining = Math.max(0, deadline - Date.now());
            return {
              remainingMs: Math.min(timeoutMs, Math.max(remaining, MIN_ACTION_BUDGET_MS)),
              element: tick.element,
            };
          }
        }
      }
      if (Date.now() >= deadline) {
        if (lastTransientErr) throw lastTransientErr;
        const desc = this._describe();
        if (lastSeenOffScreen) throw offScreenError(desc, timeoutMs, action, lastSeenOffScreen);
        const detail = positionalMissDetail(lastPositionalMiss);
        throw new Error(
          lastSeenDisabled
            ? `Element ${desc} is disabled after waiting ${timeoutMs}ms`
            // A known cause (an unnamed role iOS cannot see, PILOT-718) is told
            // instead of the generic off-screen hint; a possible one (a
            // Compose testTag, PILOT-828) after it. A positional miss keeps
            // the off-screen hint alone, as before.
            : `Element ${desc} was not found after waiting ${timeoutMs}ms${detail}` +
              (detail
                ? `. ${offScreenHint(action)}`
                : await this._locatorMissHelp({
                  waitedMs: timeoutMs,
                  hints: this._selector.kind.type === 'role' && this._missHint(detail)
                    ? this._missHintSentence(detail)
                    : `${offScreenHint(action)}${this._missHintSentence(detail)}`,
                })),
        );
      }
      const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
      if (sleepMs > 0) await sleep(sleepMs, this._client._getAbortSignal?.());
    }
  }

  /**
   * @internal — Decide how to dispatch an action against the resolved element.
   *
   * Unmodified handles dispatch by their selector (the agent auto-waits +
   * finds). A modified handle (.first()/.last()/.nth()/.filter()/.and()/.or()/
   * scope) has already resolved to a SPECIFIC element host-side, so it
   * addresses that element by its agent-cached `elementId` — the agent acts on
   * that exact cached element, so the action can't land on an earlier match
   * that shares an accessibility property (the silent-mis-tap bug). Used by all
   * single-element actions (tap, longPress, doubleTap, type, clear, setChecked,
   * selectOption, focus, blur, highlight, screenshot).
   *
   * @param preResolved - Resolved ElementInfo from the auto-wait step (avoids a
   *   redundant resolution round-trip).
   */
  private async _actionTarget(preResolved?: ElementInfo): Promise<ActionTarget> {
    if (!this._hasModifiers()) return { selector: this._selector };
    const el = preResolved ?? await this._resolveOne();
    if (el.elementId) return { elementId: el.elementId };
    // Agent-resolved matches always carry an id; if one is somehow missing,
    // fall back to a derived property selector (first-match semantics).
    return { selector: this._selectorForElement(el) };
  }

  /**
   * @internal — Dispatch an element-id-targeted action, re-resolving if the
   * cached id went stale.
   *
   * The id only lives in the agent's element cache; an intervening snapshot
   * between resolve and dispatch (notably the trace capture, hence CI-only) can
   * invalidate it, so the action fails with "…gone stale". Re-resolving runs the
   * positional/filter logic again to a FRESH id (correct for .last()/.nth() too)
   * and re-dispatches immediately — no capture in between, so the fresh id
   * survives. Retries are bounded rather than single-shot so sustained cache
   * pressure (or Android's re-render StaleObjectException) is absorbed too.
   * Selector targets (unmodified handles) need no retry.
   *
   * Non-idempotent actions (append-semantics type()) pass maxStaleRetries: 1
   * — stale errors are raised at agent-side resolution, before the action
   * runs, but a repeated partial execution would duplicate input rather than
   * merely re-tap, so those keep the conservative single retry.
   */
  private async _dispatchTargeted<R extends { success: boolean; errorMessage: string; errorType?: string }>(
    target: ActionTarget,
    call: (t: ActionTarget) => Promise<R>,
    maxStaleRetries = 3,
  ): Promise<R> {
    if (!('elementId' in target)) return call(target);
    let currentTarget: ActionTarget = target;
    for (let attempt = 0; ; attempt++) {
      const isLast = attempt === maxStaleRetries;
      try {
        const res = await call(currentTarget);
        // A covered target (PILOT-223) is never stale, whatever the cover's
        // label says — its name is embedded in the message.
        if (isLast || res.success || res.errorType === 'ELEMENT_COVERED' || !isStaleElementError(res.errorMessage)) {
          return res;
        }
      } catch (err) {
        if (isLast || !isStaleElementError(err instanceof Error ? err.message : String(err))) throw err;
      }
      try {
        currentTarget = await this._actionTarget();
      } catch (err) {
        if (!isPollableNotFoundError(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Element ${this._describe()} changed while being acted on and could not be found again: ${msg}`,
        );
      }
    }
  }

  // ── Queries ──

  /**
   * Resolve this handle to an ElementInfo. Waits for the element to be
   * present (up to the handle's timeout) and throws if it never appears —
   * on every handle shape, modified (`.first()`, `.nth()`, `.filter()`,
   * `.and()`/`.or()`, scoped chains) or not.
   *
   * @param options.timeout - Maximum time in milliseconds to wait for the
   *   element. Defaults to the device timeout.
   */
  async find(options?: TimeoutOptions): Promise<ElementInfo> {
    const call = this._forCall('find()', options, ['timeout']);
    if (call !== this) return call.find();
    this._emitQueryStarted('find');
    const start = Date.now();
    try {
      let result: ElementInfo;
      if (this._timeoutMs === 0) {
        // Explicit single-shot opt-out, as in _strictResolve: one read of the
        // current hierarchy, no polling. (Unmodified handles used to fall
        // through to _strictResolve, which returns early at 0 for actions —
        // they pass the raw selector to the agent — so find() threw "not
        // found" without ever querying the device.)
        let el: ElementInfo | undefined;
        let detail = '';
        try {
          el = this._hasModifiers() ? await this._resolveOne() : await this._findOneStrict(0);
        } catch (err) {
          // Same error shape as the unmodified branch for a plain miss, with
          // the positional diagnostic kept as the non-zero path keeps it; a
          // stale snapshot or a strict violation propagates as itself.
          if (!isPollableNotFoundError(err) || isStaleSnapshotError(err)) throw err;
          detail = positionalMissDetail(err instanceof Error ? err : undefined);
          el = undefined;
        }
        if (!el) throw new Error(`Element not found: ${this._describe()}${detail}${await this._locatorMissHelp({ waitedMs: 0, positionalDetail: detail })}`);
        result = el;
      } else {
        // Strict resolution (PILOT-226): poll so multiple matches throw
        // instead of silently returning the first. _strictResolve polls
        // _resolveOne() for modified handles (the same auto-wait actions get —
        // review follow-up on PILOT-287: readers on `.first()` etc. used to be
        // single-shot and failed instantly mid-transition) and findElements
        // for unmodified ones.
        const { element } = await this._strictResolve();
        if (!element) {
          // Unreachable: with a non-zero timeout _strictResolve either returns
          // an element or throws at its deadline (`was not found after
          // waiting`). The optional type exists for its timeout-0 early
          // return, handled above. Kept as a narrowing guard only.
          throw new Error(`Element not found: ${this._describe()}`);
        }
        result = element;
      }
      await this._traceQuery('find', `Found: ${result.text || result.className}`, Date.now() - start, result.bounds);
      return result;
    } catch (err) {
      await this._traceQueryFailed('find', err, Date.now() - start);
      throw err;
    }
  }

  /**
   * Returns whether the element exists in the UI hierarchy **right now** —
   * attached, visible or not.
   *
   * Does **not** wait for the element to appear (PILOT-344): like a Playwright
   * presence check (Playwright has no `exists()`; `locator.count() > 0` is the
   * idiom), it reads the current hierarchy and answers `false` without
   * waiting for the element when nothing matches, so it is safe to branch on presence
   * (`if (await banner.exists()) …`). To wait for an element use
   * `expect(locator).toExist()` or `waitFor({ state: 'attached' })` — both
   * are strict, so narrow a locator that may match several elements with
   * `.first()` first, or wait on `expect(locator).toHaveCount(n)`.
   *
   * Exempt from strict mode, like `count()` and `all()`: an ambiguous selector
   * answers `true`. Contrast {@link isVisible}, which also checks visibility
   * and is strict.
   *
   * Same reliability contract as {@link isVisible}: a first empty read is
   * confirmed once after a short idle wait, a stale mid-re-render snapshot is
   * re-read, a momentary agent fault is retried briefly and then thrown, and a
   * user stop propagates — never swallowed as "doesn't exist".
   */
  exists(): Promise<boolean>;
  // The arguments are only checked (PILOT-840): under tsx an option passed
  // here would otherwise be dropped without a word.
  async exists(...args: unknown[]): Promise<boolean> {
    checkNoArguments('exists()', args, "It answers at once without waiting; to wait for the element, use waitFor({ state: 'attached', timeout }) or expect(locator).toExist({ timeout }).");
    this._emitQueryStarted('exists');
    const start = Date.now();
    try {
      const info = await this._probeOnce(
        (budgetMs) => this._existsTick(budgetMs),
        "expect(locator).toExist() / .not.toExist() or waitFor({ state: 'attached' }) " +
          '(toExist() and waitFor() are strict: narrow a locator that may match several elements with .first() first)',
      );
      // No bounds on the trace row: like count(), a true answer may cover
      // several elements, and highlighting the first would misname it.
      const found = info !== undefined;
      await this._traceQuery('exists', `Exists: ${found}`, Date.now() - start);
      return found;
    } catch (err) {
      await this._traceQueryFailed('exists', err, Date.now() - start);
      throw err;
    }
  }

  /**
   * @internal — The read behind the one-shot multi-element readers
   * (`count()`, `all()`, `allTextContents()`): this handle's current matches
   * with every modifier applied. "One-shot" means no waiting for the
   * ELEMENT: an empty screen is `[]` at once. A read that lands mid-re-render
   * (stale snapshot) is not an answer at all — the screen was busy, not empty
   * — so it is re-read until one lands between frames, for up to the
   * handle's timeout, exactly as the presence probes do; only then does the
   * stale error surface. `timeout: 0` is the single-shot opt-out (one read on
   * the daemon's default deadline). Any other error propagates as it is.
   *
   * Every read is re-timed to the tick budget (see {@link tickBudget}) like
   * every other poll loop here, so a wedged agent cannot spend the whole
   * window on one read; the loop owns the deadline. Faults are classified
   * as the probes classify them: a slow-but-alive agent (agent command
   * timeout on a loaded emulator) is re-read to the deadline; a momentary
   * agent command failure (`findElements failed: …` during hierarchy churn)
   * is re-read for a short grace window ({@link PROBE_FAULT_RETRY_WINDOW_MS})
   * and then surfaced, so a real infrastructure error is not hidden for the
   * whole timeout; anything else propagates at once.
   */
  private async _readMatches(): Promise<ElementInfo[]> {
    return (await this._readMatchSet()).matches;
  }

  /** {@link _readMatches}, also returning the matches before the positional index. */
  private async _readMatchSet(): Promise<{ all: ElementInfo[]; matches: ElementInfo[] }> {
    const read = async (h: ElementHandle) => {
      const all = await h._resolveAll();
      return { all, matches: await h._select(all) };
    };
    if (this._timeoutMs === 0) return read(this);
    const deadline = Date.now() + this._timeoutMs;
    let faultDeadline: number | undefined;
    while (true) {
      try {
        return await read(ElementHandle._cloneWithTimeout(this, tickBudget(deadline)));
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        if (isStaleSnapshotError(err) || isTransientAgentError(err)) {
          // Both classes get the whole window, for different reasons: a stale
          // snapshot is a definitive answer from the agent (it is alive; the
          // screen was mid-frame), so any earlier fault has cleared; an agent
          // command timeout means the agent is alive but slow, which the
          // probes also re-read to the deadline rather than a short window.
          faultDeadline = undefined;
        } else if (isRetryableResolutionError(err)) {
          faultDeadline ??= Date.now() + Math.min(PROBE_FAULT_RETRY_WINDOW_MS, this._timeoutMs);
          if (Date.now() >= faultDeadline) throw err;
        } else {
          throw err;
        }
      }
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), this._client._getAbortSignal?.());
    }
  }

  /**
   * Return the number of elements the locator matches (PILOT-14). Every
   * modifier applies — filter/and/or/scope and the positional index — so
   * `first().count()` is 1 or 0, like Playwright. Always a live read: on a
   * handle from `all()` (a plain `nth(i)` locator) it is 1 while a row is at
   * that index and 0 once the list has shrunk. Does not wait for matches: to
   * wait for a number of them, use `expect(locator).toHaveCount(n)`.
   */
  count(): Promise<number>;
  // The arguments are only checked (PILOT-840): under tsx an option passed
  // here would otherwise be dropped without a word.
  async count(...args: unknown[]): Promise<number> {
    checkNoArguments('count()', args, 'It reads the screen as it is now; to wait for the matches, use expect(locator).toHaveCount(n, { timeout }).');
    this._emitQueryStarted('count');
    const start = Date.now();
    try {
      const elements = await this._readMatches();
      await this._traceQuery('count', `Count: ${elements.length}`, Date.now() - start);
      return elements.length;
    } catch (err) {
      await this._traceQueryFailed('count', err, Date.now() - start);
      throw err;
    }
  }

  /**
   * Return an array of ElementHandles, one for each matching element (PILOT-13).
   *
   * Each handle is a plain `nth(i)` locator with nothing cached, as in
   * Playwright: every reader and action on it resolves live, so a check and
   * the action it guards always describe the same element — whatever is at
   * index `i` when each runs (PILOT-346). Every modifier applies, as for
   * `count()`: `list.first().all()` (or `.nth(i)`/`.last()`) is that one
   * positional locator, or an empty array. Like `count()`, it reads the
   * screen as it is now and does not wait for matches.
   */
  all(): Promise<ElementHandle[]>;
  // The arguments are only checked (PILOT-840): under tsx an option passed
  // here would otherwise be dropped without a word.
  async all(...args: unknown[]): Promise<ElementHandle[]> {
    checkNoArguments('all()', args, 'It reads the screen as it is now; to wait for the matches, use expect(locator).toHaveCount(n, { timeout }).');
    this._emitQueryStarted('all');
    const start = Date.now();
    try {
      const elements = await this._readMatches();
      await this._traceQuery('all', `Found ${elements.length} element(s)`, Date.now() - start);
      if (this._options.nthIndex !== undefined) {
        // Already narrowed to one element: the locator is its own single
        // entry (as WebViewLocator.all() does), or there is nothing.
        return elements.length > 0
          ? [new ElementHandle(this._client, this._selector, this._timeoutMs, { ...this._options })]
          : [];
      }
      return elements.map((_, i) =>
        new ElementHandle(this._client, this._selector, this._timeoutMs, {
          ...this._options,
          nthIndex: i,
        }),
      );
    } catch (err) {
      await this._traceQueryFailed('all', err, Date.now() - start);
      throw err;
    }
  }

  /**
   * Return the text of every element the locator matches, in match order,
   * from ONE hierarchy read — Playwright's `allTextContents()`. Every
   * modifier applies, as for `count()` and `all()`, and like them it does not
   * wait and is exempt from strict mode: no match is `[]`.
   *
   * Prefer it to `for (const row of await rows.all()) await row.getText()`
   * for a batch read: each handle from `all()` is a live locator, so that
   * loop is one hierarchy read per row (PILOT-346).
   */
  allTextContents(): Promise<string[]>;
  // The arguments are only checked (PILOT-840): under tsx an option passed
  // here would otherwise be dropped without a word.
  async allTextContents(...args: unknown[]): Promise<string[]> {
    checkNoArguments('allTextContents()', args, 'It reads the screen as it is now; to wait for the matches, use expect(locator).toHaveCount(n, { timeout }).');
    this._emitQueryStarted('allTextContents');
    const start = Date.now();
    try {
      const elements = await this._readMatches();
      await this._traceQuery('allTextContents', `Found ${elements.length} element(s)`, Date.now() - start);
      return elements.map((el) => el.text);
    } catch (err) {
      await this._traceQueryFailed('allTextContents', err, Date.now() - start);
      throw err;
    }
  }

  // ── Waiting ──

  /**
   * @internal — Resolve matches for a single `waitFor` poll tick.
   *
   * Returns `null` to signal "retry this tick": a transient stale snapshot is
   * an *unreliable* result, not a confirmed empty set, so the caller must not
   * interpret it as a reached state (this is what keeps `'detached'`/`'hidden'`
   * from falsely resolving on a re-render blip). A genuine not-found resolves
   * to `[]`; daemon-level failures propagate so the wait fails fast.
   *
   * The positional index and anything chained after it are applied HERE, on
   * the re-timed clone, so a `has`/`hasNot` filter after the index reads its
   * children within the tick budget and a stale or faulty child read is
   * classified like the match read — not thrown past the caller's
   * stale-vs-fault handling.
   */
  private async _resolveForWaitTick(findBudget: number): Promise<ElementInfo[] | null> {
    try {
      if (this._hasModifiers()) {
        // Clone with findBudget at every node so an and/or operand's own
        // (long) timeout doesn't stall this poll tick — the waitFor deadline
        // loop owns the overall wait.
        const pollHandle = ElementHandle._cloneWithTimeout(this, findBudget);
        const elements = await pollHandle._resolveAll();
        // Awaited here so a failing child read is classified by this catch.
        return this._options.nthIndex !== undefined ? await pollHandle._select(elements) : elements;
      }
      const res = await this._client.findElements(this._selector, findBudget);
      if (res.errorMessage) {
        // Surface daemon-level failures (agent dead, command error) so a real
        // fault fails fast instead of being swallowed as "no match" and timing
        // out with a generic "did not reach state" message.
        throw new Error(`findElements failed: ${res.errorMessage}`);
      }
      return collapseSameTargetDuplicates(res.elements ?? []);
    } catch (err) {
      switch (classifyResolutionError(err)) {
        case 'stale':
          // Unreliable tick → retry. Covers both this path and the
          // modified-handle path (_resolveAll throws the same signature).
          return null;
        case 'miss':
          return [];
        default:
          // A momentary fault is retried by waitFor's outer loop (which keeps
          // the most recent one to surface at the deadline); a fatal error
          // fails the wait fast.
          throw err;
      }
    }
  }

  /**
   * Wait until this element reaches the specified state.
   *
   * - `'visible'` (default): element exists in the hierarchy AND is visible.
   * - `'hidden'`: element either doesn't exist OR exists with `visible === false`.
   * - `'attached'`: element exists in the hierarchy (regardless of visibility).
   * - `'detached'`: element does not exist in the hierarchy.
   */
  async waitFor(options?: {
    state?: 'visible' | 'hidden' | 'attached' | 'detached';
    timeout?: number;
  }): Promise<void> {
    checkOptions('waitFor()', options, ['state', 'timeout']);
    const state = options?.state ?? 'visible';
    if (!WAIT_FOR_STATES.includes(state)) {
      throw new TypeError(
        `waitFor(): unknown state ${JSON.stringify(state)}. Use one of: ${WAIT_FOR_STATES.map((st) => `'${st}'`).join(', ')}.`,
      );
    }
    // 0 keeps its meaning here (one check, no waiting), and so does anything
    // under 1 ms, as before: a budget computed as `deadline - Date.now()` (or
    // from performance.now(), fractional) that has run out must fail as a
    // timeout, not as a TypeError on a slow run.
    const raw = options?.timeout;
    const timeoutMs = typeof raw === 'number' && raw < 1 ? 0 : checkTimeout('waitFor()', raw) ?? this._timeoutMs;
    this._emitQueryStarted(`waitFor(${state})`);
    const start = Date.now();

    const FIND_TIMEOUT_MS = 500;
    const deadline = start + timeoutMs;

    // Whether the last answered tick found anything: a timeout with nothing
    // found gets the unnamed-role hint, one with a hidden match doesn't.
    let lastAttached = false;
    const checkState = async (): Promise<boolean> => {
      // Floor at 1ms — the daemon treats a 0 timeout as "use the 30s
      // default", which would stall the final poll tick for 30s.
      const findBudget = Math.min(FIND_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
      const resolved = await this._resolveForWaitTick(findBudget);
      // null = transient stale snapshot: skip this tick and retry rather than
      // treating an unreliable result as a real state.
      if (resolved === null) return false;
      const elements = resolved;

      // A positional handle was narrowed to its element (and whatever is
      // chained after the index) inside the tick read above; only an
      // unindexed handle can be ambiguous here.
      if (this._options.nthIndex === undefined && (state === 'visible' || state === 'attached') && elements.length > 1) {
        // Strict mode (PILOT-226): waiting for presence on an ambiguous
        // selector is an error. Absence states ('hidden'/'detached') are
        // exempt — they evaluate over the full match set.
        throw buildStrictModeViolationError(this._describe(), elements);
      }

      const attached = elements.length > 0;
      lastAttached = attached;
      const visible = attached && elements.some((el) => el.visible);

      switch (state) {
        case 'visible': return visible;
        case 'hidden': return !visible;
        case 'attached': return attached;
        case 'detached': return !attached;
      }
    };

    try {
      let lastTransientErr: Error | undefined;
      while (true) {
        try {
          if (await checkState()) {
            await this._traceQuery(`waitFor(${state})`, `State reached: ${state}`, Date.now() - start);
            return;
          }
          // checkState returned (state not yet reached) → the agent answered, so
          // drop any earlier transient timeout: a subsequent "did not reach
          // state" is genuine, not an infra stall.
          lastTransientErr = undefined;
        } catch (err) {
          // A transient agent-command timeout (slow-but-alive agent) or a
          // momentary agent command failure is retried within the wait budget;
          // remember only the MOST RECENT one so a budget-long stall surfaces
          // the infra error (→ session recovery) rather than a generic "did
          // not reach state". All other errors propagate to the outer
          // trace/catch. An error tick never yields a state, so absence
          // states ('detached'/'hidden') cannot falsely resolve off one.
          if (!isRetryableResolutionError(err)) throw err;
          lastTransientErr = err as Error;
        }
        if (Date.now() >= deadline) {
          if (lastTransientErr) throw lastTransientErr;
          // A miss of an unnamed iOS role query explains itself (PILOT-718).
          const missed = (state === 'visible' || state === 'attached') && !lastAttached;
          const hint = missed ? await this._locatorMissHelp({ waitedMs: timeoutMs }) : '';
          throw new Error(
            `Element ${this._describe()} did not reach state "${state}" after ${timeoutMs}ms${hint}`,
          );
        }
        const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
        if (sleepMs > 0) await sleep(sleepMs, this._client._getAbortSignal?.());
      }
    } catch (err) {
      await this._traceQueryFailed(`waitFor(${state})`, err, Date.now() - start);
      throw err;
    }
  }

  // ── Actions ──

  /**
   * @internal — Emit a "started" lifecycle signal for a query/scroll method
   * that doesn't go through tracedAction. Call this before the slow part of
   * the operation so UI mode shows an in-flight row with a spinner; the
   * matching _traceQuery at completion fires the 'completed' signal.
   */
  private _emitQueryStarted(action: string): void {
    const trace = this._traceCapture;
    if (!trace) return;
    const stack = extractStack(new Error().stack ?? '');
    const sourceLocation = stack[0];
    trace.collector._emitActionStarted({
      category: 'other',
      action,
      selector: JSON.stringify(selectorToProto(this._selector)),
      sourceLocation,
      stack,
      deviceId: trace.deviceId,
      log: [],
      hasScreenshotBefore: false,
      hasHierarchyBefore: false,
    });
  }

  /**
   * @internal — Emit a trace event for a read-only query with a single
   * screenshot capture (the "after" shot showing current device state).
   */
  private async _traceQuery(action: string, result: string, durationMs: number, bounds?: ElementInfo['bounds']): Promise<void> {
    const trace = this._traceCapture;
    if (!trace) return;
    const stack = extractStack(new Error().stack ?? '');
    const sourceLocation = stack[0];
    const { actionIndex, captures: beforeCaptures } = await trace.collector.captureBeforeAction(
      trace.takeScreenshot, trace.captureHierarchy,
    );
    trace.collector.addActionEvent({
      category: 'other',
      action,
      selector: JSON.stringify(selectorToProto(this._selector)),
      duration: durationMs,
      success: true,
      bounds,
      sourceLocation,
      stack,
      deviceId: trace.deviceId,
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: false,
      log: [result],
    }, actionIndex);
  }

  /**
   * @internal — Emit a failed completion event for a query/scroll method
   * that threw. Pairs with _emitQueryStarted at the same actionIndex so the
   * UI mode in-flight slot clears even if user code catches the throw and
   * keeps running.
   */
  private async _traceQueryFailed(action: string, err: unknown, durationMs: number): Promise<void> {
    const trace = this._traceCapture;
    if (!trace) return;
    const stack = extractStack(new Error().stack ?? '');
    const sourceLocation = stack[0];
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    const { actionIndex, captures: beforeCaptures } = await trace.collector.captureBeforeAction(
      trace.takeScreenshot, trace.captureHierarchy,
    );
    trace.collector.addActionEvent({
      category: 'other',
      action,
      selector: JSON.stringify(selectorToProto(this._selector)),
      duration: durationMs,
      success: false,
      error: errMsg,
      errorStack: errStack,
      sourceLocation,
      stack,
      deviceId: trace.deviceId,
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: false,
      log: [`${action} failed: ${errMsg}`],
    }, actionIndex);
  }

  /**
   * @internal — Action index `_tracedResolve` reserved for the action that
   * follows it, so the in-flight row it streamed completes in place even when
   * another device's action lands in between. Consumed by `_tracedAction`.
   */
  private _resolvedActionIndex: number | undefined;

  /**
   * @internal — Run a tap-family dispatch, retrying while the agent refuses
   * the element as not hittable (PILOT-716): a row its list clips behind a
   * header is still "visible" to the auto-wait, so the agent is the one to
   * refuse it — and the refusal is waited out until the action's deadline,
   * like an off-screen element, not returned at once. A refusal means nothing
   * was touched. Before each retry the whole auto-wait runs again, to the same
   * deadline — strict mode, enabled, on screen, a fresh target — so a retry
   * never taps another match, a disabled control or a stale id, and a target
   * that vanished, turned disabled or went off-screen fails as exactly that.
   * Still refused at the deadline, the response carries the same
   * scrollIntoView() advice as the off-screen error, under its own type.
   */
  private async _untilHittable(
    action: TapFamilyAction,
    remainingMs: number,
    first: ActionTarget,
    dispatch: (target: ActionTarget, element?: ElementInfo) => Promise<ActionResponse>,
    options?: { offScreenOk?: (el: ElementInfo) => boolean },
  ): Promise<ActionResponse> {
    const deadline = Date.now() + remainingMs;
    const refusedAtDeadline = (res: ActionResponse): ActionResponse => ({
      ...res,
      // Its own type: the message embeds the locator, whose text must not be
      // read as the agent's (setChecked() looks for "stale" in it).
      errorType: NOT_HITTABLE_ERROR_TYPE,
      errorMessage:
        `Element ${this._describe()} was still not hittable by the end of the ${this._timeoutMs}ms timeout: ` +
        'it may be clipped by its list (for example behind a header). ' +
        // scrollIntoView() would not help: a clipped row counts as visible, so
        // it returns at once. The list itself has to move.
        scrollFirstAdvice(action, 'scroll("up") on the list that holds it (scroll("down") if it is clipped at the bottom)'),
    });
    let res = await dispatch(first);
    for (;;) {
      // timeout 0 keeps its no-wait behaviour: the agent's refusal as it is.
      if (res.success || remainingMs <= 0 || !isNotHittableRefusal(res.errorMessage)) return res;
      if (Date.now() >= deadline) return refusedAtDeadline(res);
      // Each refusal costs the daemon an error screenshot: retry at a slower
      // pace than the read-only auto-wait.
      await sleep(Math.min(NOT_HITTABLE_RETRY_MS, Math.max(0, deadline - Date.now())), this._client._getAbortSignal?.());
      // No retry is started at the deadline: its one read could misreport the
      // element, and its touch would land after the timeout.
      if (Date.now() >= deadline) return refusedAtDeadline(res);
      const { element } = await this._waitForEnabled(action, { ...options, deadline });
      res = await dispatch(await this._actionTarget(element), element);
    }
  }

  /** @internal — Wrap an action with trace recording. */
  private async _tracedAction(
    action: string,
    category: ActionCategory,
    fn: () => Promise<ActionResponse>,
    fallbackMsg: string,
    extra?: { inputValue?: string },
  ): Promise<void> {
    const trace = this._traceCapture;
    const reservedActionIndex = this._resolvedActionIndex;
    this._resolvedActionIndex = undefined;
    const ctx = trace ? {
      collector: trace.collector,
      deviceId: trace.deviceId,
      takeScreenshot: trace.takeScreenshot,
      captureHierarchy: trace.captureHierarchy,
      findElement: (sel: Selector, timeout: number) => this._client.findElement(sel, timeout),
      captureTraceState: trace.captureTraceState,
    } : undefined;
    return tracedAction(ctx, action, category, this._selector, fn, fallbackMsg, { ...extra, reservedActionIndex });
  }

  /**
   * @internal — Run an action's pre-flight element resolution (auto-wait +
   * selector build) inside trace recording.
   *
   * Emits a `started` lifecycle event UP-FRONT (before the wait) so UI mode
   * shows the action in-flight with a spinner during the auto-wait, not only
   * after the element is found. On success: returns the resolved value and the
   * caller's _tracedAction owns the rest of the lifecycle (it re-emits
   * `started` with bounds at the same actionIndex — a harmless single-slot
   * refresh — then `completed`). On a resolution timeout the throw would
   * otherwise escape untraced: emit the matching failed completion so the
   * timed-out action lands in the current lifecycle group with its real wait
   * duration, instead of finalizeTimeline dumping the tail onto the previous
   * (e.g. beforeAll) action.
   */
  private async _tracedResolve<T>(
    action: string,
    category: ActionCategory,
    resolve: () => Promise<T>,
  ): Promise<T> {
    const trace = this._traceCapture;
    if (!trace) return resolve();
    const start = Date.now();
    const stack = extractStack(new Error().stack ?? '');
    const sourceLocation = stack[0];
    const selector = JSON.stringify(selectorToProto(this._selector));
    // Reserve the index now: the row streams before the auto-wait, and a
    // concurrent action on another device must not take the slot meanwhile.
    const actionIndex = trace.collector._reserveActionIndex();
    this._resolvedActionIndex = undefined;
    trace.collector._emitActionStarted({
      category, action, selector, sourceLocation, stack, log: [], deviceId: trace.deviceId,
      hasScreenshotBefore: false, hasHierarchyBefore: false,
    }, actionIndex);
    try {
      const value = await resolve();
      this._resolvedActionIndex = actionIndex;
      return value;
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      // Best-effort trace emission — a failure here (disk full, tracing
      // teardown, a throwing _onEvent listener) must never mask the real
      // resolution error the user needs to see.
      //
      // The capture is guarded SEPARATELY from addActionEvent: an unresponsive
      // device is exactly when both the resolution AND the screenshot capture
      // fail, and the whole point of this path is to still record the failed
      // action — so a capture failure must not skip the event emission.
      let captures: { screenshotBefore?: unknown; hierarchyBefore?: unknown } = {};
      try {
        const res = await trace.collector.captureBeforeAction(
          trace.takeScreenshot, trace.captureHierarchy, FAILURE_TRACE_CAPTURE_TIMEOUT_MS, actionIndex,
        );
        captures = res.captures;
      } catch {
        // Capture is best-effort; still record the failed action below.
      }
      try {
        trace.collector.addActionEvent({
          category, action, selector,
          duration: durationMs, success: false, error: errMsg, errorStack: errStack,
          waitTime: durationMs, sourceLocation, stack, deviceId: trace.deviceId,
          hasScreenshotBefore: !!captures.screenshotBefore, hasScreenshotAfter: false,
          hasHierarchyBefore: !!captures.hierarchyBefore, hasHierarchyAfter: false,
          log: [`${action} failed: ${errMsg}`],
        }, actionIndex);
      } catch {
        // Swallow tracing errors; the original resolution error is rethrown below.
      }
      throw err;
    }
  }

  /**
   * Tap this element, once it is enabled and nothing covers it (auto-waits).
   *
   * @param options.timeout - Maximum time in milliseconds for the whole tap,
   *   auto-wait included. Defaults to the device timeout.
   */
  async tap(options?: TimeoutOptions): Promise<void> {
    const call = this._forCall('tap()', options, ['timeout']);
    if (call !== this) return call.tap();
    const { target, remainingMs } = await this._tracedResolve('tap', 'tap', async () => {
      const { remainingMs, element } = await this._waitForEnabled('tap');
      return { target: await this._actionTarget(element), remainingMs };
    });
    const budget = actionBudget(remainingMs);
    return this._tracedAction('tap', 'tap',
      () => this._untilHittable('tap', remainingMs, target, (to) => this._dispatchTargeted(to, (t) => 'elementId' in t
        ? this._client.tap(undefined, budget(), t.elementId)
        : this._client.tap(t.selector, budget()))),
      'Tap failed');
  }

  /**
   * Long-press this element, once it is enabled and nothing covers it.
   *
   * Takes either `(duration?, { timeout }?)` — `longPress(2000)`,
   * `longPress(2000, { timeout: 5000 })` — or one options object,
   * `longPress({ duration: 2000, timeout: 5000 })`. `duration` is how long to
   * hold, in milliseconds (the agent's default when omitted); `timeout` bounds
   * the whole call (defaults to the device timeout).
   */
  longPress(duration?: number, options?: TimeoutOptions): Promise<void>;
  /**
   * Long-press this element, once it is enabled and nothing covers it, for
   * `duration` milliseconds (the agent's default when omitted). `timeout`
   * bounds the whole call, auto-wait included (default: the device timeout).
   */
  longPress(options: TimeoutOptions & { duration?: number }): Promise<void>;
  async longPress(
    options?: number | (TimeoutOptions & { duration?: number }),
    timeoutOptions?: TimeoutOptions,
  ): Promise<void> {
    if (typeof options === 'number' || (options === undefined && timeoutOptions !== undefined)) {
      const timeout = checkOptions('longPress()', timeoutOptions, ['timeout'])?.timeout;
      return this.longPress({ duration: options, timeout });
    }
    if (timeoutOptions !== undefined) {
      throw new TypeError(
        'longPress(): a second argument goes only after a duration given as a number, as in longPress(2000, { timeout: 5000 }). ' +
        'With an options object, put the timeout in it: longPress({ duration: 2000, timeout: 5000 }).',
      );
    }
    const call = this._forCall('longPress()', options, ['duration', 'timeout']);
    if (call !== this) return call.longPress({ duration: options?.duration });
    const durationMs = options?.duration;
    const { target, remainingMs } = await this._tracedResolve('longPress', 'tap', async () => {
      const { remainingMs, element } = await this._waitForEnabled('longPress');
      return { target: await this._actionTarget(element), remainingMs };
    });
    const budget = actionBudget(remainingMs);
    return this._tracedAction('longPress', 'tap',
      () => this._untilHittable('longPress', remainingMs, target, (to) => this._dispatchTargeted(to, (t) => 'elementId' in t
        ? this._client.longPress(undefined, durationMs, budget(), t.elementId)
        : this._client.longPress(t.selector, durationMs, budget()))),
      'Long press failed');
  }

  /**
   * Type `text` into this element.
   *
   * @param options.delay - Milliseconds between keystrokes; overrides the
   *   config's `typingDelay` for this call.
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the device timeout.
   */
  async type(text: string, options?: TimeoutOptions & { delay?: number }): Promise<void> {
    const call = this._forCall('type()', options, ['delay', 'timeout']);
    if (call !== this) return call.type(text, { delay: options?.delay });
    const { target, remainingMs } = await this._tracedResolve('type', 'type', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    const delay = options?.delay ?? this._options.typingDelay ?? 0;
    const budget = actionBudget(remainingMs);
    return this._tracedAction('type', 'type',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.typeText(undefined, text, budget(), delay, t.elementId)
        : this._client.typeText(t.selector, text, budget(), delay), 1),
      'Type text failed', { inputValue: text });
  }

  /**
   * Replace this field's text with `text`.
   *
   * @param options.delay - Milliseconds between keystrokes; overrides the
   *   config's `typingDelay` for this call.
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the device timeout.
   */
  async clearAndType(text: string, options?: TimeoutOptions & { delay?: number }): Promise<void> {
    const call = this._forCall('clearAndType()', options, ['delay', 'timeout']);
    if (call !== this) return call.clearAndType(text, { delay: options?.delay });
    const { target, remainingMs } = await this._tracedResolve('clearAndType', 'type', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    const delay = options?.delay ?? this._options.typingDelay ?? 0;
    const budget = actionBudget(remainingMs);
    return this._tracedAction('clearAndType', 'type',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.clearAndType(undefined, text, budget(), delay, t.elementId)
        : this._client.clearAndType(t.selector, text, budget(), delay)),
      'Clear and type failed', { inputValue: text });
  }

  /**
   * Clear this field's text.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the device timeout.
   */
  async clear(options?: TimeoutOptions): Promise<void> {
    const call = this._forCall('clear()', options, ['timeout']);
    if (call !== this) return call.clear();
    const { target, remainingMs } = await this._tracedResolve('clear', 'type', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    const budget = actionBudget(remainingMs);
    return this._tracedAction('clear', 'type',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.clearText(undefined, budget(), t.elementId)
        : this._client.clearText(t.selector, budget())),
      'Clear text failed');
  }

  /**
   * Scroll inside this element in `direction`.
   *
   * @param options.distance - Fraction of the element to scroll across.
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the device timeout.
   */
  async scroll(direction: SwipeDirection | (string & {}), options?: TimeoutOptions & { distance?: number }): Promise<void> {
    const call = this._forCall('scroll()', options, ['distance', 'timeout']);
    if (call !== this) return call.scroll(direction, { distance: options?.distance });
    const { target, remainingMs } = await this._tracedResolve('scroll', 'scroll', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    return this._tracedAction('scroll', 'scroll',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.scroll(undefined, direction, { distance: options?.distance, timeoutMs: remainingMs, elementId: t.elementId })
        : this._client.scroll(t.selector, direction, { distance: options?.distance, timeoutMs: remainingMs })),
      'Scroll failed');
  }

  // ── Element Actions (PILOT-2) ──

  /**
   * Double-tap this element, once it is enabled and nothing covers it.
   *
   * @param options.intervalMs - Milliseconds between the two taps; overrides
   *   the config's `doubleTapInterval` for this call.
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the device timeout.
   */
  async doubleTap(options?: TimeoutOptions & { intervalMs?: number }): Promise<void> {
    const call = this._forCall('doubleTap()', options, ['intervalMs', 'timeout']);
    if (call !== this) return call.doubleTap({ intervalMs: options?.intervalMs });
    const { target, remainingMs } = await this._tracedResolve('doubleTap', 'tap', async () => {
      const { remainingMs, element } = await this._waitForEnabled('doubleTap');
      return { target: await this._actionTarget(element), remainingMs };
    });
    // 0 on the wire = "use agent default (100ms)". User-supplied values
    // must be positive; ≤0 is treated as "use default".
    const intervalMs = Math.max(0, options?.intervalMs ?? this._options.doubleTapInterval ?? 0);
    const budget = actionBudget(remainingMs);
    return this._tracedAction('doubleTap', 'tap',
      () => this._untilHittable('doubleTap', remainingMs, target, (to) => this._dispatchTargeted(to, (t) => 'elementId' in t
        ? this._client.doubleTap(undefined, budget(), intervalMs, t.elementId)
        : this._client.doubleTap(t.selector, budget(), intervalMs))),
      'Double tap failed');
  }

  /**
   * Drag this element onto `target`.
   *
   * @param options.timeout - Time in milliseconds shared by the wait for both
   *   elements and the drag; each step that starts with under a second left
   *   still gets up to a second. Without it, each element waits for its own
   *   locator's timeout.
   */
  async dragTo(target: ElementHandle, options?: TimeoutOptions): Promise<void> {
    const timeout = checkTimeout('dragTo()', checkOptions('dragTo()', options, ['timeout'])?.timeout);
    if (timeout !== undefined) return this._withTimeout(timeout)._dragTo(target, true);
    return this._dragTo(target, false);
  }

  /**
   * @internal — dragTo's body. With `shareBudget` (a per-call timeout) the
   * waits for both ends and the drag itself share this handle's timeout, so
   * the whole call ends within it; without, each end waits its own timeout.
   */
  private async _dragTo(target: ElementHandle, shareBudget: boolean): Promise<void> {
    const { sourceTarget, targetTarget, remainingMs, dest } = await this._tracedResolve('dragTo', 'swipe', async () => {
      const deadline = Date.now() + this._timeoutMs;
      // What is left of the shared budget, floored as every action's budget
      // is (see _strictResolve), so a late find still gets a usable wait and drag.
      const left = () => Math.min(this._timeoutMs, Math.max(deadline - Date.now(), MIN_ACTION_BUDGET_MS));
      const source = await this._strictResolve();
      const dest = shareBudget ? target._withTimeout(left()) : target;
      const targetRes = await dest._strictResolve();
      return {
        sourceTarget: await this._actionTarget(source.element),
        targetTarget: await dest._actionTarget(targetRes.element),
        remainingMs: shareBudget ? left() : source.remainingMs,
        dest,
      };
    });
    // A stale-id retry gets what is left of the budget, not all of it again.
    const budget = actionBudget(remainingMs);
    const dispatch = (st: ActionTarget, tt: ActionTarget): Promise<ActionResponse> =>
      this._client.dragAndDrop(
        'elementId' in st ? undefined : st.selector,
        'elementId' in tt ? undefined : tt.selector,
        budget(),
        {
          sourceElementId: 'elementId' in st ? st.elementId : undefined,
          targetElementId: 'elementId' in tt ? tt.elementId : undefined,
        },
      );
    return this._tracedAction('dragTo', 'swipe', async () => {
      const byId = 'elementId' in sourceTarget || 'elementId' in targetTarget;
      if (!byId) return dispatch(sourceTarget, targetTarget);
      // Either end's cached id can go stale between resolve and dispatch
      // (see _dispatchTargeted) — re-resolve both ends and retry once.
      try {
        const res = await dispatch(sourceTarget, targetTarget);
        if (res.success || !isStaleElementError(res.errorMessage)) return res;
      } catch (err) {
        if (!isStaleElementError(err instanceof Error ? err.message : String(err))) throw err;
      }
      return dispatch(await this._actionTarget(), await dest._actionTarget());
    }, 'Drag and drop failed');
  }

  /**
   * Tap this checkbox, switch or radio button if it is not already in the
   * `checked` state, then wait for the state to change.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait and state check included. Defaults to the device timeout.
   */
  async setChecked(checked: boolean, options?: TimeoutOptions): Promise<void> {
    const call = this._forCall('setChecked()', options, ['timeout']);
    if (call !== this) return call.setChecked(checked);
    const timeoutMs = this._timeoutMs;
    const deadline = Date.now() + timeoutMs;

    const { target, remainingMs, alreadySet } = await this._tracedResolve('setChecked', 'tap', async () => {
      const { remainingMs, element } = await this._waitForEnabled('setChecked', {
        offScreenOk: (el) => el.checked === checked,
      });
      // The timeout-0 path skips the wait and returns no element; resolve here.
      const el = element ?? await this._resolveOne();
      return { target: await this._actionTarget(el), remainingMs, alreadySet: el.checked === checked };
    });

    const budget = actionBudget(remainingMs);
    return this._tracedAction('setChecked', 'tap', async () => {
      // No real RPC for the already-in-state / poll-timeout paths — synthesize
      // a minimal ActionResponse so they still flow through trace recording.
      const synthetic = (success: boolean, errorMessage = ''): ActionResponse => ({
        requestId: '', success, errorType: '', errorMessage, screenshot: Buffer.alloc(0),
      });
      if (alreadySet) return synthetic(true); // Already in desired state

      const tapByTarget = (t: ActionTarget): Promise<ActionResponse> =>
        'elementId' in t
          ? this._client.tap(undefined, budget(), t.elementId)
          : this._client.tap(t.selector, budget());

      // Tap once — for toggleable elements (checkboxes, switches) a second tap
      // would revert the state, so we must not blindly re-tap. On a stale
      // cached id we re-resolve, but DON'T tap if the element is already in the
      // desired state: the change that staled it may have set it, and tapping
      // would toggle it the wrong way (cf. _dispatchTargeted, which re-taps).
      // A refused tap touched nothing; before trying again, the retry re-reads
      // the switch — the app may have set it meanwhile, and tapping would
      // toggle it the wrong way. Only the tap's own stale error is caught here:
      // what the retry's auto-wait throws (not found, disabled, off-screen)
      // quotes the locator and must propagate as itself.
      const tapRes0 = (to: ActionTarget): Promise<ActionResponse> => tapByTarget(to).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isStaleElementError(msg)) throw err;
        return synthetic(false, msg);
      });
      let tapRes = await this._untilHittable('setChecked', remainingMs, target, async (to, fresh) =>
        fresh?.checked === checked ? synthetic(true) : tapRes0(to),
      { offScreenOk: (el) => el.checked === checked });
      // A covered target (PILOT-223) is never stale, whatever its cover's
      // label says (see _dispatchTargeted).
      if (
        !tapRes.success && tapRes.errorType !== 'ELEMENT_COVERED' && tapRes.errorType !== NOT_HITTABLE_ERROR_TYPE &&
        isStaleElementError(tapRes.errorMessage)
      ) {
        const fresh = await this._resolveOne();
        if (fresh.checked === checked) return synthetic(true); // already set after the change
        tapRes = await tapByTarget(await this._actionTarget(fresh));
      }
      if (!tapRes.success) return tapRes;

      // Poll for the state change until the full deadline — animations
      // and state propagation can take several frames.
      //
      // If the state PROVABLY hasn't moved after a settle window, re-tap:
      // CI simulators intermittently swallow a synthesized touch (XCUITest
      // acks the tap but the app never receives it), and without a re-tap a
      // single dropped touch burns the whole budget. The blanket "never
      // re-tap a toggle" rule above only forbids BLIND re-taps — each re-tap
      // here is gated on a fresh resolution still showing the ORIGINAL
      // state, so it cannot double-toggle.
      const RETAP_INTERVAL_MS = 3000;
      const MAX_RETAPS = 3;
      let retaps = 0;
      let lastTapAt = Date.now();
      let lastTransientErr: Error | undefined;
      // A tap that landed at or past the deadline (one the agent refused as
      // not hittable until then) still gets the action floor to see its change
      // land, so a toggle that worked is not reported as unchanged.
      const verifyUntil = Math.max(deadline, lastTapAt + MIN_ACTION_BUDGET_MS);
      while (Date.now() < verifyUntil) {
        await sleep(POLL_INTERVAL_MS, this._client._getAbortSignal?.());
        try {
          const after = await this._resolveOne();
          // The agent answered → responsive; drop any earlier transient timeout
          // so a state that simply never changes fails as such, not as infra.
          lastTransientErr = undefined;
          if (after.checked === checked) return tapRes; // State changed successfully
          if (
            after.checked === !checked &&
            retaps < MAX_RETAPS &&
            Date.now() - lastTapAt >= RETAP_INTERVAL_MS
          ) {
            retaps++;
            lastTapAt = Date.now();
            try {
              const retapRes = await tapByTarget(await this._actionTarget(after));
              if (retapRes.success) tapRes = retapRes;
            } catch (retapErr) {
              // A stale id / transient failure on the re-tap is not fatal —
              // the next poll tick re-resolves and the gate re-evaluates.
              if (
                !isStaleElementError(retapErr instanceof Error ? retapErr.message : String(retapErr)) &&
                !isRetryableResolutionError(retapErr)
              ) {
                throw retapErr;
              }
            }
          }
        } catch (err) {
          // A transient agent-command timeout (slow-but-alive agent) or a
          // momentary agent command failure just means this confirmation tick
          // was unreliable — keep polling for the state change within the
          // budget rather than failing the whole action. Remember only the
          // MOST RECENT one so a budget-long stall surfaces the infra error
          // (→ session recovery) instead of "did not change".
          if (isRetryableResolutionError(err)) {
            lastTransientErr = err as Error;
          } else {
            lastTransientErr = undefined;
            if (!isPollableNotFoundError(err)) throw err;
          }
        }
      }

      if (lastTransientErr) throw lastTransientErr;
      return synthetic(
        false,
        `setChecked(${checked}): element ${this._describe()} checked state did not change after tap (still ${!checked})`,
      );
    }, 'setChecked failed');
  }

  /**
   * Select `option` (by its text, or `{ index }`) in this picker.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the device timeout.
   */
  async selectOption(option: string | { index: number }, options?: TimeoutOptions): Promise<void> {
    checkSelectOption(option);
    const call = this._forCall('selectOption()', options, ['timeout']);
    if (call !== this) return call.selectOption(option);
    const { target, remainingMs } = await this._tracedResolve('selectOption', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    return this._tracedAction('selectOption', 'other',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.selectOption(undefined, option, remainingMs, t.elementId)
        : this._client.selectOption(t.selector, option, remainingMs)),
      'Select option failed');
  }

  /**
   * Capture a PNG screenshot of this element.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the device timeout.
   */
  async screenshot(options?: TimeoutOptions): Promise<Buffer> {
    const call = this._forCall('screenshot()', options, ['timeout']);
    if (call !== this) return call.screenshot();
    const { remainingMs, element } = await this._strictResolve();
    const target = await this._actionTarget(element);
    const res = await this._dispatchTargeted(target, (t) => 'elementId' in t
      ? this._client.takeElementScreenshot(undefined, remainingMs, t.elementId)
      : this._client.takeElementScreenshot(t.selector, remainingMs));
    if (!res.success) {
      throw new Error(res.errorMessage || 'Element screenshot failed');
    }
    return res.data;
  }

  /**
   * This element's bounds in screen points, or `null` when it reports none.
   * Waits for the element like {@link find}.
   *
   * @param options.timeout - Maximum time in milliseconds to wait for the
   *   element. Defaults to the device timeout.
   */
  async boundingBox(options?: TimeoutOptions): Promise<BoundingBox | null> {
    const call = this._forCall('boundingBox()', options, ['timeout']);
    if (call !== this) return call.boundingBox();
    const info = await this.find();
    if (!info.bounds) return null;
    return {
      x: info.bounds.left,
      y: info.bounds.top,
      width: info.bounds.right - info.bounds.left,
      height: info.bounds.bottom - info.bounds.top,
    };
  }

  /**
   * Pinch in on (zoom out of) this element.
   *
   * @param options.scale - Pinch scale factor. Defaults to `0.5`.
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the device timeout.
   */
  async pinchIn(options?: TimeoutOptions & { scale?: number }): Promise<void> {
    const call = this._forCall('pinchIn()', options, ['scale', 'timeout']);
    if (call !== this) return call.pinchIn({ scale: options?.scale });
    const { target, remainingMs } = await this._tracedResolve('pinchIn', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    const scale = options?.scale ?? 0.5;
    return this._tracedAction('pinchIn', 'other',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.pinchZoom(undefined, scale, remainingMs, t.elementId)
        : this._client.pinchZoom(t.selector, scale, remainingMs)),
      'Pinch in failed');
  }

  /**
   * Pinch out on (zoom into) this element.
   *
   * @param options.scale - Pinch scale factor. Defaults to `2`.
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the device timeout.
   */
  async pinchOut(options?: TimeoutOptions & { scale?: number }): Promise<void> {
    const call = this._forCall('pinchOut()', options, ['scale', 'timeout']);
    if (call !== this) return call.pinchOut({ scale: options?.scale });
    const { target, remainingMs } = await this._tracedResolve('pinchOut', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    const scale = options?.scale ?? 2;
    return this._tracedAction('pinchOut', 'other',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.pinchZoom(undefined, scale, remainingMs, t.elementId)
        : this._client.pinchZoom(t.selector, scale, remainingMs)),
      'Pinch out failed');
  }

  /**
   * Give this element input focus.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the device timeout.
   */
  async focus(options?: TimeoutOptions): Promise<void> {
    const call = this._forCall('focus()', options, ['timeout']);
    if (call !== this) return call.focus();
    const { target, remainingMs } = await this._tracedResolve('focus', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    const budget = actionBudget(remainingMs);
    return this._tracedAction('focus', 'other',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.focus(undefined, budget(), t.elementId)
        : this._client.focus(t.selector, budget())),
      'Focus failed');
  }

  /**
   * Remove input focus from this element.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the device timeout.
   */
  async blur(options?: TimeoutOptions): Promise<void> {
    const call = this._forCall('blur()', options, ['timeout']);
    if (call !== this) return call.blur();
    const { target, remainingMs } = await this._tracedResolve('blur', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    return this._tracedAction('blur', 'other',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.blur(undefined, remainingMs, t.elementId)
        : this._client.blur(t.selector, remainingMs)),
      'Blur failed');
  }

  /**
   * Draw a highlight over this element on the device (a debugging aid),
   * once it is present (waits up to the device timeout).
   *
   * @param options.durationMs - How long the highlight stays, in milliseconds.
   */
  async highlight(options?: { durationMs?: number }): Promise<void> {
    checkOptions('highlight()', options, ['durationMs']);
    const { target, remainingMs } = await this._tracedResolve('highlight', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    return this._tracedAction('highlight', 'other',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.highlight(undefined, options?.durationMs, remainingMs, t.elementId)
        : this._client.highlight(t.selector, options?.durationMs, remainingMs)),
      'Highlight failed');
  }

  // ── Info accessors (convenience) ──

  /**
   * This element's text. Waits for the element like {@link find}.
   *
   * @param options.timeout - Maximum time in milliseconds to wait for the
   *   element. Defaults to the device timeout.
   */
  async getText(options?: TimeoutOptions): Promise<string> {
    const info = await this._forCall('getText()', options, ['timeout']).find();
    return info.text;
  }

  /**
   * Returns whether the element is currently visible on screen.
   *
   * Does **not** wait for the element to appear (PILOT-287): reads the state
   * right now, and reports `false` when no element matches — like
   * Playwright's `locator.isVisible()`, so it can be used as a presence
   * branch (`if (!(await x.isVisible())) …`). To wait for visibility use
   * `expect(locator).toBeVisible()` or `waitFor()`.
   *
   * Still throws on a strict mode violation (the selector matched more than
   * one element) and on a persistent device/agent fault.
   *
   * "Does not wait" means no waiting for the element: a call costs one
   * hierarchy read on a settled screen. A read that lands mid-re-render
   * (stale snapshot) is re-read, for up to the handle's timeout, until one
   * lands between frames — so on a screen that never stops changing (a
   * permanent spinner) a call can take the full timeout and then throws a
   * descriptive error instead of guessing. Use the polling forms there.
   *
   * @param options.timeout - Replaces the device timeout for this call's
   *   retries: re-reads of a screen caught mid-re-render, retries of a slow or
   *   faulty agent, and the short settle wait before an absent answer (capped
   *   at the timeout, so a very short one can answer before a lagging tree
   *   catches up). It never makes the call wait for the element.
   */
  async isVisible(options?: TimeoutOptions): Promise<boolean> {
    return this._forCall('isVisible()', options, ['timeout'])._probeVisibility('isVisible');
  }

  /**
   * Returns whether the element is currently hidden — the opposite of
   * {@link isVisible}: `true` when no element matches or the match is not
   * visible.
   *
   * Does not wait for the element to appear or disappear. To wait for an
   * element to go away use `expect(locator).not.toBeVisible()` or
   * `waitFor({ state: 'hidden' })`.
   *
   * Same caveats as {@link isVisible}: strict mode applies, a persistent
   * device fault throws, and a screen that never stops re-rendering costs the
   * handle's timeout and then throws rather than answering `true`.
   *
   * @param options.timeout - Replaces the device timeout for this call's
   *   retries: re-reads of a screen caught mid-re-render, retries of a slow or
   *   faulty agent, and the short settle wait before an absent answer (capped
   *   at the timeout, so a very short one can answer before a lagging tree
   *   catches up). It never makes the call wait for the element.
   */
  async isHidden(options?: TimeoutOptions): Promise<boolean> {
    return this._forCall('isHidden()', options, ['timeout'])._probeVisibility('isHidden');
  }

  /**
   * Returns whether the element is enabled (interactive).
   *
   * Like Playwright's `locator.isEnabled()` this waits for the element to be
   * present (up to the handle's timeout) and throws if it never appears —
   * only {@link isVisible}/{@link isHidden}/{@link exists} are non-waiting
   * presence probes.
   *
   * @param options.timeout - Maximum time in milliseconds to wait for the
   *   element. Defaults to the device timeout.
   */
  async isEnabled(options?: TimeoutOptions): Promise<boolean> {
    const info = await this._forCall('isEnabled()', options, ['timeout']).find();
    return info.enabled;
  }

  /**
   * Returns whether this checkbox, switch, or radio button is checked.
   *
   * Waits for the element to be present (up to the handle's timeout) and
   * throws if it never appears, like Playwright's `locator.isChecked()`.
   *
   * @param options.timeout - Maximum time in milliseconds to wait for the
   *   element. Defaults to the device timeout.
   */
  async isChecked(options?: TimeoutOptions): Promise<boolean> {
    const info = await this._forCall('isChecked()', options, ['timeout']).find();
    return info.checked;
  }

  /**
   * Returns whether the element is an editable input (text field role and
   * enabled).
   *
   * Waits for the element to be present (up to the handle's timeout) and
   * throws if it never appears, like Playwright's `locator.isEditable()`.
   *
   * @param options.timeout - Maximum time in milliseconds to wait for the
   *   element. Defaults to the device timeout.
   */
  async isEditable(options?: TimeoutOptions): Promise<boolean> {
    const info = await this._forCall('isEditable()', options, ['timeout']).find();
    return info.role === 'textfield' && info.enabled;
  }

  /**
   * @internal — Shared implementation of the non-waiting visibility probes
   * `isVisible`/`isHidden` (PILOT-287).
   *
   * Unlike `find()` these must never wait for the element to appear: callers
   * use them to branch on presence, and absence has a definite answer — an
   * absent element is not visible, so isVisible → `false` and isHidden (its
   * exact negation) → `true`. The element is resolved once; a
   * genuine miss answers at once instead of costing the full timeout and
   * throwing.
   *
   * The other state readers (`isEnabled`/`isChecked`/`isEditable`,
   * `getText`/`inputValue`) keep Playwright's find-then-read contract: they
   * wait for the element and throw when it never appears, so a negative
   * result always describes a real element rather than a missing one.
   *
   * Traced under the probe's own name so a trace shows e.g. `isVisible →
   * Visible: false` rather than a failed `find`.
   */
  private async _probeVisibility(probe: 'isVisible' | 'isHidden'): Promise<boolean> {
    this._emitQueryStarted(probe);
    const start = Date.now();
    try {
      const info = await this._probeOnce(
        (budgetMs) => this._resolveTick(budgetMs),
        'expect(locator).toBeVisible() / .not.toBeVisible() or waitFor()',
      );
      const visible = info !== undefined && info.visible; // absent ⇒ not visible
      const result = probe === 'isHidden' ? !visible : visible;
      await this._traceQuery(probe, `${probe === 'isHidden' ? 'Hidden' : 'Visible'}: ${result}`, Date.now() - start, info?.bounds);
      return result;
    } catch (err) {
      await this._traceQueryFailed(probe, err, Date.now() - start);
      throw err;
    }
  }

  /**
   * @internal — Resolve the element's CURRENT state without waiting for it to
   * appear: `undefined` when nothing matches right now. The shared ladder of
   * the presence probes: `isVisible`/`isHidden` read through
   * {@link _resolveTick} (strict, single target) and `exists()` through
   * {@link _existsTick} (non-strict, any match) — `tick` is that read, and
   * `waitingForms` names the polling APIs the stall error points the user at.
   *
   * Both agents answer `findElements` in a single shot (no on-device wait),
   * and `_resolveOne()` is likewise a single-tick resolution, so one call is
   * the non-waiting probe. Whether strict mode applies is the tick's call.
   *
   * Every read is issued with one poll interval of budget — the same tick
   * budget the waiting loops use — on every handle shape (modified handles
   * are re-timed through {@link _resolveOneWithin}, so a filter/scope chain's
   * sequential reads carry it too). The budget does not bound a healthy dump;
   * the daemon's fixed headroom does (see the note by
   * {@link POLL_INTERVAL_MS}), so on a healthy device a call costs one
   * read, and on a wedged agent no single read can hold the call for the
   * whole timeout plus headroom. An agent command timeout means the agent is
   * alive but slow — a CPU-starved CI emulator's hierarchy dump — so, as the
   * action ladders do, it is re-probed until the handle deadline rather than
   * for the short fault window below, and a persistent one surfaces unchanged
   * at the deadline, so session recovery fires. The probe still never waits
   * for the *element*: it waits for a readable answer.
   *
   * Two kinds of *unreliable tick* — a read that carries no information about
   * presence — are re-probed, on different budgets:
   *
   * - A **stale snapshot** (the UI changed mid-read) means the screen is busy,
   *   which is normal: an animating spinner or a re-rendering list. It is
   *   re-probed until the handle timeout, as `find()`/`waitFor`/assertions do,
   *   so an element that IS there gets read once a tick lands between frames.
   *   That does not break the probe's promise — it never waits for the
   *   element to *appear*, only for a readable snapshot to answer from. If the
   *   hierarchy never settles, a descriptive error (reads attempted, time
   *   elapsed, and the polling forms to use instead) is thrown rather than an
   *   answer: a silent "hidden" would take the ready branch on exactly the
   *   screen that produces stale snapshots.
   * - A **momentary agent command fault** (`findElements failed: …`) is a real
   *   infrastructure error, so it is re-probed only briefly
   *   ({@link PROBE_FAULT_RETRY_WINDOW_MS} from the first fault, capped by the
   *   handle timeout) and then surfaced unchanged, so session-level recovery
   *   patterns still match. (An agent command *timeout* is the exception, see
   *   above: the agent is responsive, so it gets the handle deadline.) As in `_strictResolve`, a later definitive answer
   *   from the agent — including a stale tick — clears the remembered fault,
   *   so a long-recovered blip is never reported as the cause of a stall.
   *
   * An **empty read** is an answer, not an unreliable tick — but the first one
   * is confirmed before it is trusted: the accessibility tree can lag a
   * just-rendered screen with no error (PILOT-283), so the probe waits for the
   * UI to settle (best effort, bounded by {@link PROBE_MISS_CONFIRM_IDLE_MS})
   * and reads once more, exactly as `scrollIntoView` confirms its first miss.
   * A present element still answers from one read; an absent one costs two.
   * The confirmation is itself best effort: if the re-read only produces stale
   * snapshots (a spinner keeps the tree churning), it is retried for the same
   * short window as a fault and then the first answer stands — an absent
   * element must never cost the whole timeout or be reported as an error
   * because the screen was busy. Only an infrastructure fault (agent timeout,
   * disconnect) that does not clear within its window is still thrown, as
   * everywhere else in the probe. As with any definitive tick, an empty read
   * clears a remembered fault.
   *
   * `timeout: 0` is the explicit single-shot opt-out: one read, no retries and
   * no confirmation. That read is issued with a 0 deadline, which the daemon
   * maps to its default command deadline — the same as `count()` at timeout 0.
   */
  private async _probeOnce(
    tick: (budgetMs: number) => Promise<ResolveTick>,
    waitingForms: string,
  ): Promise<ElementInfo | undefined> {
    const start = Date.now();
    const deadline = start + this._timeoutMs;
    const faultWindowMs = Math.min(PROBE_FAULT_RETRY_WINDOW_MS, this._timeoutMs);
    // Opened by a fault, closed (with lastFault) by the next definitive tick,
    // so EVERY blip gets the same short grace — not just the first one.
    let faultDeadline: number | undefined;
    let lastFault: Error | undefined;
    let staleReads = 0;
    let faultReads = 0;
    let missConfirmed = false;
    // Set once the first empty read has been idle-waited: stale re-reads past
    // it fall back to that answer instead of churning to the handle timeout.
    let confirmDeadline: number | undefined;
    while (true) {
      // A 0 budget is right only for the explicit timeout-0 opt-out (the
      // daemon maps it to its default deadline).
      const read = await tick(this._timeoutMs === 0 ? 0 : tickBudget(deadline));
      let miss = false;
      switch (read.kind) {
        case 'found':
          return read.element;
        case 'miss':
          miss = true;
          break;
        case 'stale':
          // A definitive (if unusable) answer from the agent: the earlier
          // fault, if any, has recovered.
          staleReads++;
          lastFault = undefined;
          faultDeadline = undefined;
          break;
        case 'fault':
          faultReads++;
          lastFault = read.error;
          if (isTransientAgentError(read.error)) {
            // Agent alive but slow: no short window — re-probe to the handle
            // deadline, as the action ladders do (a starved CI emulator must
            // not turn a presence branch into a thrown timeout after 2 s).
            faultDeadline = undefined;
          } else if (faultDeadline === undefined) {
            // Momentary agent fault: a short grace, then surface it.
            faultDeadline = Date.now() + faultWindowMs;
          }
          break;
      }
      if (miss) {
        if (missConfirmed || this._timeoutMs === 0) return undefined;
        // A definitive answer: any earlier fault has recovered.
        lastFault = undefined;
        faultDeadline = undefined;
        // First empty read: let a lagging accessibility tree catch up, then
        // read again before answering "absent".
        missConfirmed = true;
        try {
          await this._client.waitForIdle(Math.min(PROBE_MISS_CONFIRM_IDLE_MS, this._timeoutMs));
        } catch (err) {
          // A user stop must propagate immediately (PILOT-222); anything else
          // is a best-effort idle wait that must not block the answer.
          if (isAbortError(err)) throw err;
        }
        confirmDeadline = Date.now() + faultWindowMs;
        continue;
      }
      const now = Date.now();
      // While a fault window is open it is the nearer deadline (a blip keeps
      // its full grace even mid-confirmation); a slow-agent timeout has no
      // window and is bounded by the handle deadline alone, even
      // mid-confirmation (a timed-out confirming read is not a confirmation);
      // otherwise, once a first empty read is being confirmed, the
      // confirmation window is.
      let nearestDeadline = deadline;
      if (lastFault && faultDeadline !== undefined) nearestDeadline = Math.min(nearestDeadline, faultDeadline);
      else if (confirmDeadline !== undefined && !lastFault) nearestDeadline = Math.min(nearestDeadline, confirmDeadline);
      const remaining = nearestDeadline - now;
      // Stop once another poll gap no longer fits before the nearest deadline
      // (so a short handle timeout still gets its second tick, as find() does).
      if (remaining < POLL_INTERVAL_MS) {
        if (lastFault) throw lastFault;
        // The confirming re-read never produced a usable snapshot; the first
        // empty read is still the answer.
        if (confirmDeadline !== undefined) return undefined;
        const left = Math.max(0, deadline - now);
        const reads = staleReads + faultReads;
        const faults = faultReads
          ? ` (plus ${faultReads} momentary agent fault${faultReads === 1 ? '' : 's'} that cleared)`
          : '';
        let detail: string;
        if (reads === 1) {
          // One stale read and no room for another. Say WHY there is no room:
          // either the caller opted out (timeout 0) or the read itself used
          // the budget up — not "the timeout is too short".
          const why = this._timeoutMs === 0
            ? 'timeout is 0 (single-shot), so it was not retried'
            : `it took ${now - start}ms, and the ${left}ms left of the ${this._timeoutMs}ms timeout ` +
              `is not enough for another read (a re-read needs at least ${POLL_INTERVAL_MS}ms)`;
          detail = `a single read returned a stale snapshot (the UI changed mid-read); ${why}`;
        } else {
          detail =
            `the UI hierarchy kept changing (stale snapshot) across ${staleReads} read${staleReads === 1 ? '' : 's'} ` +
            `over ${now - start}ms${faults}`;
        }
        throw new Error(
          `Could not read the state of ${this._describe()}: ${detail}. ` +
            `Use ${waitingForms}, which poll until the screen settles.`,
        );
      }
      await sleep(POLL_INTERVAL_MS, this._client._getAbortSignal?.());
    }
  }

  /**
   * This field's current value (its text). Waits for the element like
   * {@link find}.
   *
   * @param options.timeout - Maximum time in milliseconds to wait for the
   *   element. Defaults to the device timeout.
   */
  async inputValue(options?: TimeoutOptions): Promise<string> {
    const info = await this._forCall('inputValue()', options, ['timeout']).find();
    return info.text;
  }

  // ── Scrolling ──

  /**
   * Scroll the viewport until this element is visible on screen.
   *
   * Repeatedly swipes in the given direction, checking visibility between
   * each attempt. Useful for reaching elements that are off-screen in a
   * scrollable container (e.g. a long list of navigation cards).
   *
   * @param options.direction - Swipe direction: `"up"` (scroll down), `"down"` (scroll up). Default `"up"`.
   * @param options.maxScrolls - Maximum number of swipe attempts before throwing. Default `5`.
   * @param options.speed - Swipe speed in pixels/second. Default `2000`.
   */
  async scrollIntoView(options?: {
    direction?: SwipeDirection | (string & {});
    maxScrolls?: number;
    speed?: number;
  }): Promise<void> {
    checkOptions('scrollIntoView()', options, ['direction', 'maxScrolls', 'speed']);
    const direction = options?.direction ?? 'up';
    const maxScrolls = options?.maxScrolls ?? 5;
    const speed = options?.speed ?? 2000;

    this._emitQueryStarted('scrollIntoView');
    const start = Date.now();

    let lastTransientErr: Error | undefined;

    // One visibility probe against the CURRENT tree (findElements does not
    // auto-wait). A 'miss' is affirmative — the tree reports the element
    // absent or off-screen, so scrolling is warranted. An 'unreliable' tick
    // (transient agent timeout, stale mid-update snapshot) told us nothing
    // about where the element is, so swiping on it would be a blind gesture
    // that can displace an already-visible target — e.g. shift it under a
    // pinned app bar so the follow-up tap silently misses (PILOT-283).
    const probe = async (): Promise<
      | { outcome: 'visible'; el: ElementInfo }
      | { outcome: 'miss' }
      | { outcome: 'unreliable' }
    > => {
      // One modifier-aware read: filter/and/or/scope and the positional index
      // all apply, so the scroll is judged against the element the handle
      // actually denotes — not the raw selector's first match (PILOT-345).
      // Strict mode (PILOT-226) applies too: scrolling toward an ambiguous
      // selector is an error — which match should end up on screen? — and
      // propagates, as does any other fatal error (gRPC transport failure,
      // user stop).
      const tick = await this._resolveTick(POLL_INTERVAL_MS);
      switch (tick.kind) {
        case 'fault':
          // A momentary agent fault or agent command timeout is retried by
          // re-probing rather than aborting the scroll; remember it so a
          // budget-long stall surfaces the infra error (→ session recovery)
          // instead of the generic "not visible after N scroll(s)".
          lastTransientErr = tick.error;
          return { outcome: 'unreliable' };
        case 'stale':
          // The agent answered → responsive, so drop any earlier transient
          // fault; but a stale mid-update snapshot is a tick with no
          // information — distinct from an affirmative "not in the tree" miss.
          lastTransientErr = undefined;
          return { outcome: 'unreliable' };
        case 'miss':
          lastTransientErr = undefined;
          return { outcome: 'miss' };
        case 'found':
          lastTransientErr = undefined;
          return tick.element.visible ? { outcome: 'visible', el: tick.element } : { outcome: 'miss' };
      }
    };

    try {
      let swipes = 0;
      // Unreliable ticks perform no swipe, so they must not consume the
      // caller's swipe budget (maxScrolls unreliable ticks would otherwise
      // mean zero actual scrolls). They get their own bound instead, so a
      // persistently sick agent still terminates the loop.
      let unreliableTicks = 0;
      // The pre-swipe miss confirmation runs at most once: without the flag,
      // an unreliable tick landing after the confirmation (while swipes is
      // still 0) would re-trigger the idle wait on the next miss, stacking
      // redundant multi-second delays.
      let confirmedFirstMiss = false;
      for (;;) {
        let result = await probe();

        // Right after navigation or app launch the accessibility tree can lag
        // the rendered screen — it may briefly describe the PREVIOUS screen
        // without any error — so a miss before any scrolling has happened is
        // not yet trustworthy evidence that the element is off-screen.
        // Confirm it: wait for the UI to settle (best effort), then probe
        // once more before committing to the first swipe. Gated on swipes
        // (not the loop index) so an unreliable tick 0 doesn't let the first
        // affirmative miss swipe unconfirmed.
        if (swipes === 0 && result.outcome === 'miss' && !confirmedFirstMiss) {
          confirmedFirstMiss = true;
          try {
            await this._client.waitForIdle(SCROLL_FIRST_SWIPE_IDLE_TIMEOUT_MS);
          } catch (err) {
            // A user stop must propagate immediately (PILOT-222), never be
            // swallowed as a failed best-effort idle wait.
            if (isAbortError(err)) throw err;
            // Best effort — a slow or unsupported idle wait must not block scrolling.
          }
          result = await probe();
        }

        if (result.outcome === 'visible') {
          const el = result.el;
          // Wait for scroll momentum to fully stop.  On iOS, momentum
          // deceleration continues after a swipe, and the first tap during
          // deceleration is consumed by the ScrollView (stops the scroll)
          // rather than being delivered to the child view.  Poll until the
          // element's position is stable for two consecutive checks.
          // The last clean read of the settle loop, so the trace shows where
          // the row ended up rather than where the probe saw it mid-motion.
          let settled: ElementInfo = el;
          if (swipes > 0) {
            // Settled = the position has held for two consecutive ticks (three
            // equal reads, ~200ms of observed stillness on top of
            // SCROLL_SETTLE_MS). The reads below are single live snapshots, so
            // one matching pair could be a momentary velocity null or a
            // stalled frame mid-deceleration; the `findElement` read this
            // replaced settled agent-side on Android (WaitEngine, three
            // positional re-checks) before it answered, so a lone match used
            // to carry that margin already. An unreadable tick (miss, stale,
            // ambiguous, bounds missing) clears both the count AND the last
            // position, so the three equal reads are always adjacent — a
            // post-gap read never counts against a pre-gap one.
            const trackable = el.bounds?.top !== undefined;
            let lastY = el.bounds?.top;
            let stableTicks = 0;
            for (let s = 0; s < 10; s++) {
              await sleep(100, this._client._getAbortSignal?.());
              // The same modifier-aware, live read as the probe, so a filtered
              // or scoped handle tracks ITS element's position, not the raw
              // selector's first match. Transport errors and a user abort
              // propagate. The target was already found visible, so nothing
              // here may fail the scroll or fall through to another swipe
              // (which could scroll it back off-screen); the tick just decides
              // how to keep waiting for the position to settle:
              // - a slow agent (`fault`: command timeout / momentary fault)
              //   stops stabilizing — each further read could cost the daemon's
              //   ~5s headroom, and the old single-probe loop stopped here too;
              // - a momentary miss, a stale snapshot or an ambiguous read
              //   (a cell dropping out of the tree or a same-text row passing
              //   through mid-deceleration) is waited out: the old read let the
              //   agent wait 500ms for the element, so a one-tick flicker must
              //   not end stabilization early and hand a moving list to the
              //   next tap. Bounded by the tick cap above.
              let stabilityTick: ResolveTick;
              try {
                stabilityTick = await this._resolveTick(POLL_INTERVAL_MS);
              } catch (err) {
                if (!isStrictModeViolation(err)) throw err;
                // An ambiguous read is an unreadable tick like any other.
                stableTicks = 0;
                lastY = undefined;
                continue;
              }
              if (stabilityTick.kind === 'fault') break;
              if (stabilityTick.kind !== 'found') {
                stableTicks = 0;
                lastY = undefined;
                continue;
              }
              const curY = stabilityTick.element.bounds?.top;
              if (curY === undefined) {
                // An element the probe already saw without bounds has no
                // position to track — nothing to stabilize, and waiting out
                // all 10 ticks would only add dead time (a full chain read
                // each) after a successful scroll. Bounds that were there at
                // the probe and are missing THIS tick are a momentary gap
                // (a cell mid-recycle): an unreadable tick, like a miss.
                if (!trackable) break;
                stableTicks = 0;
                lastY = undefined;
                continue;
              }
              settled = stabilityTick.element;
              if (curY === lastY) {
                if (++stableTicks >= 2) break;
              } else {
                stableTicks = 0;
                lastY = curY;
              }
            }
          }
          await this._traceQuery(
            'scrollIntoView',
            `Visible after ${swipes} scroll(s)`,
            Date.now() - start,
            settled.bounds,
          );
          return;
        }

        if (result.outcome === 'unreliable') {
          // This tick told us nothing — wait out the blip and re-probe
          // instead of swiping blind (PILOT-283).
          if (++unreliableTicks > maxScrolls) break;
          await sleep(SCROLL_SETTLE_MS, this._client._getAbortSignal?.());
          continue;
        }
        // Affirmative miss with the swipe budget spent — give up.
        if (swipes >= maxScrolls) break;
        const swipeRes = await this._client.swipe(direction, { speed, distance: 0.6 });
        if (!swipeRes.success) {
          throw new Error(swipeRes.errorMessage || 'Swipe failed during scrollIntoView');
        }
        swipes++;
        await sleep(SCROLL_SETTLE_MS, this._client._getAbortSignal?.());
      }

      if (lastTransientErr) throw lastTransientErr;
      throw new Error(
        `scrollIntoView: ${this._describe()} was not visible after ${swipes} scroll(s) in direction "${direction}"`,
      );
    } catch (err) {
      await this._traceQueryFailed('scrollIntoView', err, Date.now() - start);
      throw err;
    }
  }
}

// Playwright locator methods that Tapsmith names differently: a clear
// pointer instead of "handle.click is not a function" (PILOT-544).
defineRenamedMethods(ElementHandle.prototype, {
  click: 'tap',
  dblclick: 'doubleTap',
  fill: 'clearAndType',
  textContent: 'getText',
  innerText: 'getText',
});
