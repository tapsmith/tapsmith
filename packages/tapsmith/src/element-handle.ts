/**
 * ElementHandle — a lazy reference to a UI element found by a Selector.
 *
 * Returned by `device.element(selector)`. Supports chaining with `.element()`
 * and all the same actions as Device (tap, type, …). Also serves as the
 * assertion target for `expect()`.
 */

import {
  type Selector,
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
import type { TapsmithGrpcClient, ElementInfo, ActionResponse } from './grpc-client.js';
import { type TraceCapture, extractStack } from './trace/trace-collector.js';
import type { ActionCategory } from './trace/types.js';
import { tracedAction } from './trace/traced-action.js';
import { sleep, isAbortError } from './abort.js';

// ─── Public types ───

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
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

interface ElementHandleOptions {
  nthIndex?: number;
  filters?: FilterOptions[];
  /** Left operand for and() — the full handle `this` was called on. */
  andSelf?: ElementHandle;
  andHandle?: ElementHandle;
  /** Left operand for or() — the full handle `this` was called on. */
  orSelf?: ElementHandle;
  orHandle?: ElementHandle;
  /**
   * Parent scope for a `getBy*`/`locator()` call made on a *modified* handle
   * (e.g. `dialog.first().getByRole('button')`). The parent's modifiers can't
   * be folded into a nested Selector, so it is resolved to concrete element(s)
   * and the child is scoped to them by geometric containment (see _resolveAll).
   */
  scopeParent?: ElementHandle;
  resolvedElementsPromise?: Promise<ElementInfo[]>;
  /** Trace capture context, propagated from the Device. */
  traceCapture?: TraceCapture;
  /** Default inter-keystroke delay in ms, from config.typingDelay. */
  typingDelay?: number;
  /** Default double-tap interval in ms, from config.doubleTapInterval. */
  doubleTapInterval?: number;
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
/** Budget of the device read that refreshes an all() snapshot (see _refreshSnapshot). */
const SNAPSHOT_REFRESH_BUDGET_MS = POLL_INTERVAL_MS;
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
 * first-match. Disambiguate with `{ exact: true }`, `getByRole(role, { name })`,
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

/** Escape a raw attribute value for embedding in a generated selector string. */
function escapeForSelector(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Best-effort unambiguous locator suggestion for one resolved element. */
function suggestSelectorFor(el: ElementInfo): string | undefined {
  if (el.resourceId) {
    // Android resource ids look like "com.pkg:id/foo"; getByTestId matches the suffix.
    const testId = el.resourceId.includes(':id/') ? el.resourceId.split(':id/').pop()! : el.resourceId;
    return `device.getByTestId("${escapeForSelector(testId)}")`;
  }
  const name = el.contentDescription || el.text;
  // Static text elements read better as getByText; real widgets as getByRole.
  if (el.role && el.role !== 'text' && name) {
    return `device.getByRole("${el.role}", { name: "${escapeForSelector(truncateText(name, 60))}" })`;
  }
  if (el.text) {
    return `device.getByText("${escapeForSelector(truncateText(el.text, 60))}", { exact: true })`;
  }
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
    'Hint: use { exact: true }, getByRole(role, { name }), getByTestId(), or .first()/.nth()/.last() to target a single element.';
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

/**
 * @internal — Whether an action failure means the agent's cached element is no
 * longer usable, so re-resolving to a fresh id and retrying may succeed. Covers
 * both wordings: the cached id was evicted / its snapshot invalidated by an
 * intervening snapshot ("…not found. It may have gone stale.") and a live
 * StaleObjectException where the cached object's view re-rendered ("Element is
 * stale (UI changed): …", Android).
 */
function isStaleElementError(message: string | undefined): boolean {
  return !!message && /stale/i.test(message);
}

/** @internal Brand key for cross-instance type checks (CJS/ESM dual-package). */
export const ELEMENT_HANDLE_BRAND = Symbol.for('tapsmith.ElementHandle');

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
   * Locate a descendant by visible text. Substring match by default; pass
   * `{ exact: true }` for an exact match.
   */
  getByText(text: string, options?: { exact?: boolean }): ElementHandle {
    return this._scoped(options?.exact ? _text(text) : _textContains(text));
  }

  /** Locate a descendant by accessibility role, optionally filtering by name or state. */
  getByRole(role: string, options?: { name?: string; checked?: boolean; disabled?: boolean; selected?: boolean; expanded?: boolean }): ElementHandle {
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
  getByLabel(text: string): ElementHandle {
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

  /** @internal */
  private _scoped(child: Selector): ElementHandle {
    if (this._hasModifiers()) {
      // The parent carries modifiers (.first(), .filter(), .and(), or a prior
      // scope) that can't be expressed as a nested Selector. Defer to runtime
      // geometric scoping: resolve the parent to concrete element(s), then keep
      // only children contained within them (Playwright-style subtree scoping).
      return new ElementHandle(this._client, child, this._timeoutMs, {
        scopeParent: this,
        traceCapture: this._options.traceCapture,
      });
    }
    const scoped = withParent(child, this._selector);
    return new ElementHandle(this._client, scoped, this._timeoutMs, { traceCapture: this._options.traceCapture });
  }

  // ── Positional selection (PILOT-15) ──

  /** Return a new handle targeting the first match. */
  first(): ElementHandle {
    this._assertNoResolvedCache('first');
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      nthIndex: 0,
    });
  }

  /** Return a new handle targeting the last match. */
  last(): ElementHandle {
    this._assertNoResolvedCache('last');
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      nthIndex: -1,
    });
  }

  /** Return a new handle targeting the match at `index` (0-based). Negative indices count from the end. */
  nth(index: number): ElementHandle {
    this._assertNoResolvedCache('nth');
    if (!Number.isInteger(index)) {
      // selectNth would bounds-check a fractional index as in range and index
      // the array at it, yielding [undefined] — a phantom count() match and a
      // TypeError far from the mistake. Refuse it here, at the public entry.
      throw new Error(`nth() requires an integer index, got ${index}`);
    }
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      nthIndex: index,
    });
  }

  /** @internal — Refuse an all() handle as an operand (and/or/has/hasNot): it
   * would be resolved live from its selector, ignoring the element it names. */
  private static _assertOperandNotResolved(method: string, operand: ElementHandle): void {
    if (operand._options.resolvedElementsPromise) {
      throw new Error(
        `${method} cannot combine a handle returned by all(). ` +
          'Handles from all() already reference a specific element; pass the locator you called all() on instead.',
      );
    }
  }

  /** @internal — Prevent re-indexing on handles returned by all(). */
  private _assertNoResolvedCache(method: string): void {
    if (this._options.resolvedElementsPromise) {
      throw new Error(
        `${method}() cannot be called on a handle returned by all(). ` +
          'Handles from all() already reference a specific element.',
      );
    }
  }

  // ── Filtering (PILOT-16) ──

  /** Narrow matches by additional criteria without changing the selector. */
  filter(criteria: FilterOptions): ElementHandle {
    // A handle from all() resolves from its snapshot BEFORE filters apply, so
    // a filter on it would be silently ignored (`rows[0].filter(…)` would still
    // act on rows[0]). Refuse it, as first()/last()/nth() do. The same goes for
    // an all() handle used as `has`/`hasNot`: only its selector is consulted.
    this._assertNoResolvedCache('filter');
    if (criteria.has) ElementHandle._assertOperandNotResolved('filter({ has })', criteria.has);
    if (criteria.hasNot) ElementHandle._assertOperandNotResolved('filter({ hasNot })', criteria.hasNot);
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
    // Both operands resolve through _resolveAll(), which never consults an
    // all() snapshot, so `rows[0].and(x)` / `x.and(rows[0])` would silently
    // intersect ALL rows.
    this._assertNoResolvedCache('and');
    ElementHandle._assertOperandNotResolved('and', other);
    ElementHandle._assertOperandNotXpath('and', this);
    ElementHandle._assertOperandNotXpath('and', other);
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      andSelf: this,
      andHandle: other,
      traceCapture: this._options.traceCapture,
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
    this._assertNoResolvedCache('or');
    ElementHandle._assertOperandNotResolved('or', other);
    ElementHandle._assertOperandNotXpath('or', this);
    ElementHandle._assertOperandNotXpath('or', other);
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      orSelf: this,
      orHandle: other,
      traceCapture: this._options.traceCapture,
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
   * it up front — the same shape as the all()-handle guards.
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
   * selector or a scoped ancestor (`locator({ xpath }).getByText(…)` nests the
   * xpath as the selector's `parent`; a modified parent lives in
   * `scopeParent`), or an operand of a nested and()/or().
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
      // intersects the FIRST a with b — PILOT-347); _resolveAll alone never
      // applies one.
      const [leftEls, rightEls] = await Promise.all([
        left._resolveAll().then((els) => selectNth(els, left._options.nthIndex)),
        right._resolveAll().then((els) => selectNth(els, right._options.nthIndex)),
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
        left._resolveAll().then((els) => selectNth(els, left._options.nthIndex)),
        right._resolveAll().then((els) => selectNth(els, right._options.nthIndex)),
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

    // Base case: no and/or — resolve selector then apply filters
    const res = await this._client.findElements(this._selector, this._timeoutMs);
    if (res.errorMessage) {
      // Daemon-level failure (agent dead, command error) — not "no match".
      // Surface it instead of letting it read as an empty result.
      throw new Error(`findElements failed: ${res.errorMessage}`);
    }
    let elements = collapseSameTargetDuplicates(res.elements ?? []);

    // Scope to a modified parent (getBy*/locator() called on a modified handle):
    // keep only matches geometrically contained within the resolved parent(s).
    if (this._options.scopeParent) {
      elements = await this._scopeToParent(elements, this._options.scopeParent);
    }

    if (this._options.filters) {
      for (const f of this._options.filters) {
        elements = await this._applyFilter(elements, f);
      }
    }

    return elements;
  }

  /**
   * @internal — Restrict `children` to those geometrically contained within the
   * resolved parent handle, the same containment primitive used by
   * `filter({ has })`. The parent's modifiers are honored: a positional parent
   * (`.first()`, `.nth()`, an `all()` handle) resolves to its single selected
   * element; a filter/and/or parent resolves to all of its matches, and a child
   * contained within *any* of them is in scope.
   *
   * Requires bounds: a parent or child without bounds cannot be confirmed
   * contained and is excluded (Add accessibility identifiers / ensure the
   * container reports bounds if scoping returns nothing).
   *
   * A missing or out-of-range positional parent resolves to an empty scope
   * (no children in scope) rather than throwing — so `count()`/`exists()` and
   * absence assertions on a scoped handle report 0/false/empty like
   * Playwright, instead of surfacing the parent's "not found" error.
   */
  private async _scopeToParent(children: ElementInfo[], parent: ElementHandle): Promise<ElementInfo[]> {
    // A parent from all() is resolved live by index here, exactly like
    // `.nth(i)` (and like `expect(items[i])`): re-identifying a captured row
    // in a fresh read has no reliable key — element ids go stale, bounds move
    // with any layout shift, text mutates and testIDs repeat — so every
    // "smarter" match has a silent wrong-row failure. Live-by-index is the
    // documented behaviour; live all() handles are PILOT-346.
    const scopedParents = selectNth(await parent._resolveAll(), parent._options.nthIndex);

    return children.filter((child) =>
      scopedParents.some((p) => boundsContain(p.bounds, child.bounds) === 'contained'),
    );
  }

  /** @internal */
  private async _applyFilter(
    elements: ElementInfo[],
    filter: FilterOptions,
  ): Promise<ElementInfo[]> {
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
    const elements = this._options.resolvedElementsPromise
      ? await this._options.resolvedElementsPromise
      : await this._resolveAll();
    const nthIndex = this._options.nthIndex;

    if (nthIndex !== undefined) {
      const idx = nthIndex < 0 ? elements.length + nthIndex : nthIndex;
      if (idx < 0 || idx >= elements.length) {
        const expectedCount = nthIndex >= 0 ? nthIndex + 1 : -nthIndex;
        throw new Error(
          `nth(${nthIndex}): expected at least ${expectedCount} element(s), but found ${elements.length}`,
        );
      }
      return elements[idx];
    }

    if (elements.length === 0) {
      throw new Error(`Element not found: ${this._describe()}`);
    }
    if (elements.length > 1) {
      throw buildStrictModeViolationError(this._describe(), elements);
    }
    return elements[0];
  }

  /** @internal — Build a human-readable description of this handle for error messages. */
  private _describe(): string {
    const sel = formatSelector(this._selector);
    if (this._options.andHandle) {
      const left = this._options.andSelf?._describe() ?? sel;
      const right = this._options.andHandle._describe();
      let desc = `${left} AND ${right}`;
      if (this._options.filters?.length) desc += `.filter(…×${this._options.filters.length})`;
      return desc;
    }
    if (this._options.orHandle) {
      const left = this._options.orSelf?._describe() ?? sel;
      const right = this._options.orHandle._describe();
      let desc = `${left} OR ${right}`;
      if (this._options.filters?.length) desc += `.filter(…×${this._options.filters.length})`;
      return desc;
    }
    let desc = this._options.scopeParent ? `${this._options.scopeParent._describe()} >> ${sel}` : sel;
    if (this._options.filters?.length) desc += `.filter(…×${this._options.filters.length})`;
    return desc;
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
    const MIN_ACTION_BUDGET_MS = 1000;
    const deadline = Date.now() + timeoutMs;
    let lastTransientErr: Error | undefined;
    // The most recent positional miss (`nth(i): expected at least …`), kept so
    // the deadline error still says WHICH index was short and by how much.
    let lastPositionalMiss: Error | undefined;
    while (true) {
      // An all() handle answers from its capture without a device read, so
      // that answer says nothing about whether the agent is responsive.
      const fromSnapshot = !!this._options.resolvedElementsPromise;
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
        if (!fromSnapshot) lastTransientErr = undefined;
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
        throw new Error(
          `Element ${this._describe()} was not found after waiting ${timeoutMs}ms${positionalMissDetail(lastPositionalMiss)}`,
        );
      }
      // An all() snapshot cannot change on its own: a tick that could not be
      // satisfied from it re-captures by index before the next one, so this
      // is a real wait (like .nth(i)) rather than a busy-wait on a frozen list.
      // A refresh that fails is classified like any tick's read error.
      lastTransientErr = await this._refreshBetweenTicks(lastTransientErr);
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
   *
   * A handle from `all()` answers from its snapshot — no device read to bound
   * — and the clone would drop that cache, so it resolves as-is. Every reader
   * and action on such a handle must describe the same captured element (a
   * check that re-queried while the tap it guards used the snapshot could
   * check one row and tap another); making `all()` live is PILOT-346.
   */
  private _resolveOneWithin(budgetMs: number): Promise<ElementInfo> {
    if (this._options.resolvedElementsPromise) return this._resolveOne();
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
   * chain is bounded by `budgetMs`. A handle from `all()` answers from its
   * snapshot, like every other reader on that handle. A failed read
   * classifies exactly as {@link _classifyTickError} does for the strict tick.
   */
  private async _existsTick(budgetMs: number): Promise<ResolveTick> {
    try {
      const elements = this._options.resolvedElementsPromise
        ? selectNth(await this._options.resolvedElementsPromise, this._options.nthIndex)
        : await this._resolveForAssertion(budgetMs, false);
      return elements.length > 0 ? { kind: 'found', element: elements[0] } : { kind: 'miss' };
    } catch (err) {
      return ElementHandle._classifyTickError(err);
    }
  }

  /**
   * @internal — {@link _resolveTick} against the LIVE tree. A handle from
   * `all()` answers `_resolveTick` from its capture, which is right for the
   * action ladders (a check and the action it guards must describe the same
   * captured element; those loops re-capture *between* ticks). A loop that
   * exists to watch the screen change — `scrollIntoView`'s probe and
   * stabilisation — must instead re-capture by index before every read, or it
   * reads the same frozen answer on every iteration and never converges (a row
   * captured off-screen would "miss" through all its swipes and then fail).
   * The refresh is bounded by `budgetMs` like any tick. A failed refresh is
   * returned as the classified tick (stale / fault / miss) without a read —
   * the handle keeps holding its previous capture for later readers, as
   * `_refreshSnapshot` guarantees. A handle without a capture reads exactly
   * as `_resolveTick`.
   */
  private async _resolveLiveTick(budgetMs: number): Promise<ResolveTick> {
    const refreshErr = await this._refreshSnapshot(budgetMs);
    if (refreshErr) {
      switch (classifyResolutionError(refreshErr)) {
        case 'stale':
          return { kind: 'stale' };
        case 'fault':
          return { kind: 'fault', error: refreshErr };
        case 'miss':
          // Not reachable today — a refresh runs `_resolveAll`, which answers
          // an empty match with `[]` rather than throwing. Spelled out so every
          // class the classifier can return has a home here, and mapped to an
          // unreliable tick rather than a miss: a refresh that failed is not
          // evidence the element is off-screen, and a miss would let the
          // scroll probe swipe on a read that never happened (PILOT-283).
          return { kind: 'stale' };
        default:
          throw refreshErr;
      }
    }
    return this._resolveTick(budgetMs);
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
      // A re-timed clone is a fresh probe: drop any cached resolution from
      // all() so it re-queries with the new timeout instead of serving the
      // stale snapshot (_resolveOne short-circuits on this promise).
      resolvedElementsPromise: undefined,
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
        ...ElementHandle._cloneWithTimeout(this, timeoutMs)._options,
        nthIndex: undefined,
      });
      elements = await probe._resolveAll();
    } else {
      const res = await this._client.findElements(this._selector, timeoutMs);
      if (res.errorMessage) {
        throw new Error(`findElements failed: ${res.errorMessage}`);
      }
      elements = collapseSameTargetDuplicates(res.elements ?? []);
    }

    const nthIndex = this._options.nthIndex;
    if (nthIndex !== undefined) return selectNth(elements, nthIndex);
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
  private async _waitForEnabled(): Promise<{ remainingMs: number; element?: ElementInfo }> {
    const timeoutMs = this._timeoutMs;
    // timeoutMs === 0 means "no polling": behave like the pre-auto-wait code
    // and hand the full zero budget straight to the action.
    if (timeoutMs === 0) return { remainingMs: 0 };
    const MIN_ACTION_BUDGET_MS = 1000;
    const deadline = Date.now() + timeoutMs;
    let lastSeenDisabled = false;
    let lastTransientErr: Error | undefined;
    // The most recent positional miss (`nth(i): expected at least …`), kept so
    // the deadline error still says WHICH index was short and by how much —
    // the same diagnostic _strictResolve gives `type()`, so `nth(5).tap()`
    // does not fail with a worse message than `nth(5).type()`.
    let lastPositionalMiss: Error | undefined;
    while (true) {
      // A capture (all() handle) answers without a device read; only a
      // device read proves the agent responsive (see _strictResolve).
      const fromSnapshot = !!this._options.resolvedElementsPromise;
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
        if (!fromSnapshot) lastTransientErr = undefined;
        // Remember what the LAST counted read saw, so an element that was
        // present (disabled) for a tick and then vanished is reported as not
        // found, not as still disabled. A stale tick carries no count, so it
        // neither refreshes nor discards the last confirmed positional miss.
        if (tick.kind === 'miss') {
          lastPositionalMiss = tick.positionalMiss;
          lastSeenDisabled = false;
        }
        if (tick.kind === 'found') {
          lastPositionalMiss = undefined;
          lastSeenDisabled = !tick.element.enabled;
          if (tick.element.enabled) {
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
        throw new Error(
          lastSeenDisabled
            ? `Element ${desc} is disabled after waiting ${timeoutMs}ms`
            : `Element ${desc} was not found after waiting ${timeoutMs}ms${positionalMissDetail(lastPositionalMiss)}`,
        );
      }
      // A captured (all()) element that is disabled or gone cannot change in
      // the snapshot: re-capture by index before the next tick (see _strictResolve).
      lastTransientErr = await this._refreshBetweenTicks(lastTransientErr);
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
  /**
   * @internal — Re-capture an `all()` handle's snapshot from a fresh device
   * read (by the same index) instead of dropping it: after a cached element
   * id went stale mid-action, or when a wait cannot be satisfied from the
   * capture. Dropping it would silently turn `rows[i]` into a live `.nth(i)`
   * and the first()/nth()/filter()/and()/or() guards would stop firing. A
   * handle that never had a snapshot is left alone.
   *
   * The read is bounded like any poll tick (a re-timed live clone), so a
   * wedged agent cannot hold one tick for the handle timeout plus headroom.
   * The returned promise never rejects: it resolves to the read's error, if
   * any, so a poll loop can classify it (transient vs fatal) within its tick
   * while callers that re-resolve immediately can ignore it. A failed refresh
   * falls back to the previous capture so the handle is never left holding a
   * cached rejection.
   */
  private _refreshSnapshot(budgetMs: number = SNAPSHOT_REFRESH_BUDGET_MS): Promise<Error | undefined> {
    const previous = this._options.resolvedElementsPromise;
    if (!previous) return Promise.resolve(undefined);
    const fresh = ElementHandle._cloneWithTimeout(this, budgetMs)._resolveAll();
    this._options.resolvedElementsPromise = fresh;
    return fresh.then(
      () => undefined,
      (err: unknown) => {
        if (this._options.resolvedElementsPromise === fresh) this._options.resolvedElementsPromise = previous;
        return err instanceof Error ? err : new Error(String(err));
      },
    );
  }

  /**
   * @internal — The between-ticks step the action ladders (`_strictResolve`,
   * `_waitForEnabled`) share for a handle from `all()`: an all() capture
   * cannot change on its own, so a tick that could not be satisfied from it
   * re-captures by index before the next one (a real wait, like `.nth(i)`,
   * rather than a busy-wait on a frozen list). Folds the refresh's outcome
   * into the ladder's remembered transient fault and returns the new value:
   * a failed refresh is classified like a tick's read error (a fault is
   * remembered, a stale or not-found answer changes nothing, anything fatal
   * is thrown); a successful refresh IS this handle's device read — the agent
   * answered, so an earlier fault has cleared, and it must not be reported at
   * the deadline as the cause of a plain "not found". A handle without a
   * capture is left alone.
   */
  private async _refreshBetweenTicks(lastTransientErr: Error | undefined): Promise<Error | undefined> {
    if (!this._options.resolvedElementsPromise) return lastTransientErr;
    const refreshErr = await this._refreshSnapshot();
    if (!refreshErr) return undefined;
    switch (classifyResolutionError(refreshErr)) {
      case 'fault':
        return refreshErr;
      case 'stale':
      case 'miss':
        return lastTransientErr;
      default:
        throw refreshErr;
    }
  }

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
  private async _dispatchTargeted<R extends { success: boolean; errorMessage: string }>(
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
        if (isLast || res.success || !isStaleElementError(res.errorMessage)) return res;
      } catch (err) {
        if (isLast || !isStaleElementError(err instanceof Error ? err.message : String(err))) throw err;
      }
      // Refresh any cached all() snapshot so the re-resolve gets a FRESH id
      // rather than the same stale one, without turning the handle live.
      void this._refreshSnapshot(); // the re-resolve below awaits the refreshed capture
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
   * `.and()`/`.or()`, scoped chains) or not. A handle from `all()` resolves
   * from the snapshot it was created with.
   */
  async find(): Promise<ElementInfo> {
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
        if (!el) throw new Error(`Element not found: ${this._describe()}${detail}`);
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
   * user stop propagates — never swallowed as "doesn't exist". A handle from
   * `all()` answers from its snapshot — as last refreshed by that handle's own
   * actions, never a fresh read — so it says whether the captured row was
   * there, not whether it still is; re-query the list to check that.
   */
  async exists(): Promise<boolean> {
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
   * Return the number of elements the locator matches (PILOT-14). Every
   * modifier applies — filter/and/or/scope and the positional index — so
   * `first().count()` is 1 or 0, like Playwright. Always a LIVE read: on a
   * handle from `all()` it re-queries by index like `expect()`/`toHaveCount()`
   * do (1 while a row is at that index, 0 once the list has shrunk), where
   * `exists()`, `getText()` and `isVisible()` answer from the capture.
   */
  async count(): Promise<number> {
    this._emitQueryStarted('count');
    const start = Date.now();
    try {
      const elements = selectNth(await this._resolveAll(), this._options.nthIndex);
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
   * The resolved elements are cached in the returned handles, so iterating
   * and performing actions will not re-query `findElements` for each handle.
   */
  async all(): Promise<ElementHandle[]> {
    // A handle from all() already names one element; all() on it would be a
    // silent capture→live switch (one handle over a fresh read), the same
    // hazard filter()/first()/and()/or() refuse.
    this._assertNoResolvedCache('all');
    this._emitQueryStarted('all');
    const start = Date.now();
    try {
      // The positional index applies here as it does in count(): a handle
      // from `loc.first().all()` is the one element first() names. The
      // capture stays the FULL match set and that one handle carries the
      // parent's index resolved against it at capture time (`last()` on three
      // rows becomes index 2), because a snapshot refresh re-resolves the full
      // set too — a child indexed 0 over a narrowed capture would re-point at
      // match 0 after its first refresh, and a child keeping `-1` would name
      // whatever is last after the list shrank instead of reporting the
      // captured row gone, like every other all() handle does.
      const parentIndex = this._options.nthIndex;
      const resolvedElementsPromise = this._resolveAll();
      const all = await resolvedElementsPromise;
      const elements = selectNth(all, parentIndex);
      const captureIndex = parentIndex === undefined ? undefined : parentIndex < 0 ? all.length + parentIndex : parentIndex;
      await this._traceQuery('all', `Found ${elements.length} element(s)`, Date.now() - start);
      return elements.map((_, i) =>
        new ElementHandle(this._client, this._selector, this._timeoutMs, {
          ...this._options,
          nthIndex: captureIndex ?? i,
          resolvedElementsPromise,
        }),
      );
    } catch (err) {
      await this._traceQueryFailed('all', err, Date.now() - start);
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
   */
  private async _resolveForWaitTick(findBudget: number): Promise<ElementInfo[] | null> {
    try {
      if (this._hasModifiers()) {
        // Clone with findBudget at every node so an and/or operand's own
        // (long) timeout doesn't stall this poll tick — the waitFor deadline
        // loop owns the overall wait.
        const pollHandle = ElementHandle._cloneWithTimeout(this, findBudget);
        return await pollHandle._resolveAll();
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
    const state = options?.state ?? 'visible';
    const timeoutMs = options?.timeout ?? this._timeoutMs;
    this._emitQueryStarted(`waitFor(${state})`);
    const start = Date.now();

    const FIND_TIMEOUT_MS = 500;
    const deadline = start + timeoutMs;

    const checkState = async (): Promise<boolean> => {
      // Floor at 1ms — the daemon treats a 0 timeout as "use the 30s
      // default", which would stall the final poll tick for 30s.
      const findBudget = Math.min(FIND_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
      const resolved = await this._resolveForWaitTick(findBudget);
      // null = transient stale snapshot: skip this tick and retry rather than
      // treating an unreliable result as a real state.
      if (resolved === null) return false;
      let elements = resolved;

      // Respect nthIndex — target the specific element, not the full set
      const nthIndex = this._options.nthIndex;
      if (nthIndex !== undefined) {
        elements = selectNth(elements, nthIndex);
      } else if ((state === 'visible' || state === 'attached') && elements.length > 1) {
        // Strict mode (PILOT-226): waiting for presence on an ambiguous
        // selector is an error. Absence states ('hidden'/'detached') are
        // exempt — they evaluate over the full match set.
        throw buildStrictModeViolationError(this._describe(), elements);
      }

      const attached = elements.length > 0;
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
          throw new Error(
            `Element ${this._describe()} did not reach state "${state}" after ${timeoutMs}ms`,
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

  async tap(): Promise<void> {
    const { target, remainingMs } = await this._tracedResolve('tap', 'tap', async () => {
      const { remainingMs, element } = await this._waitForEnabled();
      return { target: await this._actionTarget(element), remainingMs };
    });
    return this._tracedAction('tap', 'tap',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.tap(undefined, remainingMs, t.elementId)
        : this._client.tap(t.selector, remainingMs)),
      'Tap failed');
  }

  async longPress(durationMs?: number): Promise<void> {
    const { target, remainingMs } = await this._tracedResolve('longPress', 'tap', async () => {
      const { remainingMs, element } = await this._waitForEnabled();
      return { target: await this._actionTarget(element), remainingMs };
    });
    return this._tracedAction('longPress', 'tap',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.longPress(undefined, durationMs, remainingMs, t.elementId)
        : this._client.longPress(t.selector, durationMs, remainingMs)),
      'Long press failed');
  }

  async type(text: string, options?: { delay?: number }): Promise<void> {
    const { target, remainingMs } = await this._tracedResolve('type', 'type', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    const delay = options?.delay ?? this._options.typingDelay ?? 0;
    return this._tracedAction('type', 'type',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.typeText(undefined, text, remainingMs, delay, t.elementId)
        : this._client.typeText(t.selector, text, remainingMs, delay), 1),
      'Type text failed', { inputValue: text });
  }

  async clearAndType(text: string, options?: { delay?: number }): Promise<void> {
    const { target, remainingMs } = await this._tracedResolve('clearAndType', 'type', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    const delay = options?.delay ?? this._options.typingDelay ?? 0;
    return this._tracedAction('clearAndType', 'type',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.clearAndType(undefined, text, remainingMs, delay, t.elementId)
        : this._client.clearAndType(t.selector, text, remainingMs, delay)),
      'Clear and type failed', { inputValue: text });
  }

  async clear(): Promise<void> {
    const { target, remainingMs } = await this._tracedResolve('clear', 'type', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    return this._tracedAction('clear', 'type',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.clearText(undefined, remainingMs, t.elementId)
        : this._client.clearText(t.selector, remainingMs)),
      'Clear text failed');
  }

  async scroll(direction: string, options?: { distance?: number }): Promise<void> {
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

  async doubleTap(options?: { intervalMs?: number }): Promise<void> {
    const { target, remainingMs } = await this._tracedResolve('doubleTap', 'tap', async () => {
      const { remainingMs, element } = await this._waitForEnabled();
      return { target: await this._actionTarget(element), remainingMs };
    });
    // 0 on the wire = "use agent default (100ms)". User-supplied values
    // must be positive; ≤0 is treated as "use default".
    const intervalMs = Math.max(0, options?.intervalMs ?? this._options.doubleTapInterval ?? 0);
    return this._tracedAction('doubleTap', 'tap',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.doubleTap(undefined, remainingMs, intervalMs, t.elementId)
        : this._client.doubleTap(t.selector, remainingMs, intervalMs)),
      'Double tap failed');
  }

  async dragTo(target: ElementHandle): Promise<void> {
    const { sourceTarget, targetTarget, remainingMs } = await this._tracedResolve('dragTo', 'swipe', async () => {
      const source = await this._strictResolve();
      const targetRes = await target._strictResolve();
      return {
        sourceTarget: await this._actionTarget(source.element),
        targetTarget: await target._actionTarget(targetRes.element),
        remainingMs: source.remainingMs,
      };
    });
    const dispatch = (st: ActionTarget, tt: ActionTarget): Promise<ActionResponse> =>
      this._client.dragAndDrop(
        'elementId' in st ? undefined : st.selector,
        'elementId' in tt ? undefined : tt.selector,
        remainingMs,
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
      // Refresh any cached all() snapshot on BOTH ends so each re-resolves fresh.
      void this._refreshSnapshot(); // both re-resolves below await the refreshed captures
      void target._refreshSnapshot();
      return dispatch(await this._actionTarget(), await target._actionTarget());
    }, 'Drag and drop failed');
  }

  async setChecked(checked: boolean): Promise<void> {
    const timeoutMs = this._timeoutMs;
    const deadline = Date.now() + timeoutMs;

    const { target, remainingMs, alreadySet } = await this._tracedResolve('setChecked', 'tap', async () => {
      const { remainingMs, element } = await this._waitForEnabled();
      // The timeout-0 path skips the wait and returns no element; resolve here.
      const el = element ?? await this._resolveOne();
      return { target: await this._actionTarget(el), remainingMs, alreadySet: el.checked === checked };
    });

    return this._tracedAction('setChecked', 'tap', async () => {
      // No real RPC for the already-in-state / poll-timeout paths — synthesize
      // a minimal ActionResponse so they still flow through trace recording.
      const synthetic = (success: boolean, errorMessage = ''): ActionResponse => ({
        requestId: '', success, errorType: '', errorMessage, screenshot: Buffer.alloc(0),
      });
      if (alreadySet) return synthetic(true); // Already in desired state

      const tapByTarget = (t: ActionTarget): Promise<ActionResponse> =>
        'elementId' in t
          ? this._client.tap(undefined, remainingMs, t.elementId)
          : this._client.tap(t.selector, remainingMs);

      // Tap once — for toggleable elements (checkboxes, switches) a second tap
      // would revert the state, so we must not blindly re-tap. On a stale
      // cached id we re-resolve, but DON'T tap if the element is already in the
      // desired state: the change that staled it may have set it, and tapping
      // would toggle it the wrong way (cf. _dispatchTargeted, which re-taps).
      let tapRes: ActionResponse;
      try {
        tapRes = await tapByTarget(target);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isStaleElementError(msg)) throw err;
        tapRes = synthetic(false, msg);
      }
      if (!tapRes.success && isStaleElementError(tapRes.errorMessage)) {
        void this._refreshSnapshot(); // _resolveOne below awaits the refreshed capture
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
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS, this._client._getAbortSignal?.());
        try {
          // An all() snapshot would never show the change: re-capture by
          // index so the confirmation (and the re-tap gate) reads live state.
          void this._refreshSnapshot(); // _resolveOne below awaits the refreshed capture
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

  async selectOption(option: string | { index: number }): Promise<void> {
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

  async screenshot(): Promise<Buffer> {
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

  async boundingBox(): Promise<BoundingBox | null> {
    const info = await this.find();
    if (!info.bounds) return null;
    return {
      x: info.bounds.left,
      y: info.bounds.top,
      width: info.bounds.right - info.bounds.left,
      height: info.bounds.bottom - info.bounds.top,
    };
  }

  async pinchIn(options?: { scale?: number }): Promise<void> {
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

  async pinchOut(options?: { scale?: number }): Promise<void> {
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

  async focus(): Promise<void> {
    const { target, remainingMs } = await this._tracedResolve('focus', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { target: await this._actionTarget(element), remainingMs };
    });
    return this._tracedAction('focus', 'other',
      () => this._dispatchTargeted(target, (t) => 'elementId' in t
        ? this._client.focus(undefined, remainingMs, t.elementId)
        : this._client.focus(t.selector, remainingMs)),
      'Focus failed');
  }

  async blur(): Promise<void> {
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

  async highlight(options?: { durationMs?: number }): Promise<void> {
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

  async getText(): Promise<string> {
    const info = await this.find();
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
   */
  async isVisible(): Promise<boolean> {
    return this._probeVisibility('isVisible');
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
   */
  async isHidden(): Promise<boolean> {
    return this._probeVisibility('isHidden');
  }

  /**
   * Returns whether the element is enabled (interactive).
   *
   * Like Playwright's `locator.isEnabled()` this waits for the element to be
   * present (up to the handle's timeout) and throws if it never appears —
   * only {@link isVisible}/{@link isHidden}/{@link exists} are non-waiting
   * presence probes.
   */
  async isEnabled(): Promise<boolean> {
    const info = await this.find();
    return info.enabled;
  }

  /**
   * Returns whether this checkbox, switch, or radio button is checked.
   *
   * Waits for the element to be present (up to the handle's timeout) and
   * throws if it never appears, like Playwright's `locator.isChecked()`.
   */
  async isChecked(): Promise<boolean> {
    const info = await this.find();
    return info.checked;
  }

  /**
   * Returns whether the element is an editable input (text field role and
   * enabled).
   *
   * Waits for the element to be present (up to the handle's timeout) and
   * throws if it never appears, like Playwright's `locator.isEditable()`.
   */
  async isEditable(): Promise<boolean> {
    const info = await this.find();
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
   * A handle from `all()` reads its snapshot rather than the device, so a miss
   * is answered without the confirmation (nothing could change) — and no read
   * of it can be stale or faulty.
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
        // A handle from all() answered from its snapshot, which no idle wait
        // or re-read can change — confirming would only cost a device round
        // trip for the same answer.
        if (missConfirmed || this._timeoutMs === 0 || this._options.resolvedElementsPromise) return undefined;
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

  async inputValue(): Promise<string> {
    const info = await this.find();
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
    direction?: string;
    maxScrolls?: number;
    speed?: number;
  }): Promise<void> {
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
      // user stop). A handle from all() is re-captured by index first: the
      // probe watches the screen change, so it must never answer from the
      // capture it was created with.
      const tick = await this._resolveLiveTick(POLL_INTERVAL_MS);
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
                stabilityTick = await this._resolveLiveTick(POLL_INTERVAL_MS);
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
