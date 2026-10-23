/**
 * Locator answers for UI mode's live device (PILOT-848).
 *
 * The Locator tab's match count and highlights, and the picker's suggested
 * locators, come from the device agent — the same SDK locator builder and
 * agent matching a test resolves with (shared with the MCP tools) — not
 * from the TypeScript re-implementation, which is kept for the offline
 * trace playground only.
 */

import type { TapsmithGrpcClient } from '../grpc-client.js';
import type { WebViewHandle } from '../webview-handle.js';
import { getNodeBounds, type Bounds, type HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { generateSelectors } from '../trace-viewer/components/selector-generation.js';
import { agentValidatedSuggestions } from '../mcp/agent-suggestions.js';
import { sdkDeviceFor, withEvaluatedLocator } from '../mcp/sdk-device.js';

/** iOS checks a batch in one XCUI snapshot, so it takes far more per call. */
const IOS_CHUNK_SIZE = 500;

/** One live WebView query's budget: a wedged page must not hold a tab's queue for the device timeout. */
const LIVE_WEBVIEW_TIMEOUT_MS = 5_000;

/** How far (px) a match may sit from the picked element's recorded bounds and still be it. */
const SAME_ELEMENT_TOLERANCE_PX = 2;

export interface LiveLocatorEvaluation {
  /** Matches now (after any position); absent with `error`. */
  count?: number
  /** Matches before a positional index picked one. */
  total?: number
  /** Whether a position (.first()/.nth()/.last()) narrowed the matches. */
  positional?: boolean
  /** Where the matches are on screen (a WebView match: the part inside the WebView, when it was found). */
  bounds: Bounds[]
  /** A webview.* locator, counted in the page. */
  webview?: boolean
  /** Why there is no count: not a locator, no device, the agent failed. */
  error?: string
}

/** How a live query may reach the device's WebView. */
export interface WebViewAccess {
  /** The WebView connection UI mode already holds to this device, if any. */
  webview?: () => Promise<WebViewHandle>
  /** Throws to refuse any WebView connection (e.g. none on screen). */
  beforeConnect?: () => void
}

/** What `locator` matches on the device right now, as a test would resolve it. */
export async function evaluateLiveLocator(
  client: TapsmithGrpcClient,
  serial: string | undefined,
  locator: string,
  access: WebViewAccess = {},
): Promise<LiveLocatorEvaluation> {
  try {
    const device = await sdkDeviceFor(client, serial);
    return await withEvaluatedLocator(device, client, locator, async (evaluated) => {
      if (evaluated.kind === 'webview') {
        const { count, total, matches, viewport } = await evaluated.locator._handle._liveMatches(evaluated.locator, LIVE_WEBVIEW_TIMEOUT_MS);
        return {
          count,
          total,
          positional: evaluated.locator._nthIndex !== undefined,
          // Only what shows: the part of each match inside the WebView.
          bounds: viewport ? matches.flatMap((m) => {
            const shown = m.bounds && clip(m.bounds, viewport);
            return shown ? [shown] : [];
          }) : [],
          webview: true,
        };
      }
      const { matches, total, positional } = await evaluated.handle._currentMatches();
      return {
        count: matches.length,
        total,
        positional,
        bounds: matches.flatMap((m) => (m.bounds ? [m.bounds] : [])),
      };
    }, access);
  } catch (err) {
    return { bounds: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export interface LiveLocatorSuggestions {
  /** Locators the device resolves to exactly the picked element, best first. */
  suggestions: Array<{ code: string; label: string }>
  /** Why the list is short or empty, when there is a reason. */
  note?: string
}

/**
 * The locators that find `node` — picked on the live device's hierarchy —
 * and nothing else, as the device resolves them. A WebView element's
 * candidates are counted in the page; native ones in one agent batch.
 */
export async function suggestLiveLocators(
  client: TapsmithGrpcClient,
  serial: string | undefined,
  node: HierarchyNode,
  options: WebViewAccess & {
    ios: boolean
    /** True once a newer pick replaced this one: stop between candidates. */
    superseded?: () => boolean
  },
): Promise<LiveLocatorSuggestions> {
  if (node.attributes.get('webview') === 'true') {
    const suggestions: LiveLocatorSuggestions['suggestions'] = [];
    let note: string | undefined;
    // Where no candidate finds only this element, a position among a
    // candidate's matches still does (as a native pick's variants do).
    const positional: LiveLocatorSuggestions['suggestions'] = [];
    const pickedPlace = getNodeBounds(node);
    for (const candidate of generateSelectors(node).filter((s) => s.code.startsWith('webview.'))) {
      if (options.superseded?.()) break;
      const result = await webViewMatchesOf(client, serial, candidate.code, options);
      if (result.error) { note = result.error; break; }
      const index = result.matches.findIndex((m) => isPickedWebViewElement(m, node));
      if (index < 0) continue;
      if (result.count === 1) {
        suggestions.push({ code: candidate.code, label: candidate.label });
      } else if (
        pickedPlace && result.matches[index].bounds
        // Two matches that both look like the pick (a same-tag wrapper with
        // the same box) leave its position ambiguous.
        && result.matches.filter((m) => isPickedWebViewElement(m, node)).length === 1
      ) {
        // Only a place tells same-tag matches apart; without one the
        // position could name another of them.
        positional.push({ code: `${candidate.code}.nth(${index})`, label: `${candidate.label} (position)` });
      }
    }
    if (suggestions.length === 0) suggestions.push(...positional);
    if (!note && suggestions.length === 0) {
      note = 'None of the page\'s locators finds only this element. Write one that does, or add .nth(i) to pick it by position.';
    }
    return { suggestions, note };
  }
  const checked = await agentValidatedSuggestions(client, [node], options.ios ? { chunkSize: IOS_CHUNK_SIZE } : {});
  const suggestions = (checked.byNode.get(node) ?? []).map((s) => ({ code: s.code, label: s.label }));
  const note = checked.errorMessage
    ?? (checked.notFound > 0 ? 'The element was no longer on screen when the device checked; pick it again.' : undefined)
    ?? (suggestions.length === 0 ? 'No locator the device checked finds only this element; pick it again, or write one.' : undefined);
  return { suggestions, note };
}

/** The part of `b` inside `view`, or undefined when none of it is (or it has no size). */
function clip(b: Bounds, view: Bounds): Bounds | undefined {
  const shown = {
    left: Math.max(b.left, view.left),
    top: Math.max(b.top, view.top),
    right: Math.min(b.right, view.right),
    bottom: Math.min(b.bottom, view.bottom),
  };
  return shown.right > shown.left && shown.bottom > shown.top ? shown : undefined;
}

type WebViewMatch = Awaited<ReturnType<WebViewHandle['_liveMatches']>>['matches'][number];

/** A `webview.*` locator's matches in the page, in document order. */
async function webViewMatchesOf(
  client: TapsmithGrpcClient,
  serial: string | undefined,
  locator: string,
  access: WebViewAccess,
): Promise<{ count: number; matches: WebViewMatch[]; error?: string }> {
  try {
    const device = await sdkDeviceFor(client, serial);
    return await withEvaluatedLocator(device, client, locator, async (evaluated) => {
      if (evaluated.kind !== 'webview') return { count: 0, matches: [] };
      return evaluated.locator._handle._liveMatches(evaluated.locator, LIVE_WEBVIEW_TIMEOUT_MS);
    }, access);
  } catch (err) {
    return { count: 0, matches: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Whether the page's one match is the element picked in the overlay: a
 * role-only or tag-only candidate can find exactly one element that is a
 * different one (e.g. an `<a>` without href is no link to the page). Where
 * both are known, the match must also sit where the picked element is.
 */
function isPickedWebViewElement(match: WebViewMatch, node: HierarchyNode): boolean {
  const same = (attr: string, value: string) => {
    const expected = node.attributes.get(attr) ?? '';
    return expected === '' || expected === value;
  };
  const picked = getNodeBounds(node);
  const near = (a: number, b: number) => Math.abs(a - b) <= SAME_ELEMENT_TOLERANCE_PX;
  const samePlace = !picked || !match.bounds || (
    near(picked.left, match.bounds.left) && near(picked.top, match.bounds.top)
    && near(picked.right, match.bounds.right) && near(picked.bottom, match.bounds.bottom)
  );
  return match.tag === (node.attributes.get('webview-tag') ?? '').toLowerCase()
    && same('webview-id', match.id)
    && same('webview-testid', match.testId)
    && samePlace;
}

/**
 * The last few live hierarchy captures per device, so a pick made on one
 * can still be resolved after newer captures arrived (PILOT-848).
 */
export class LiveHierarchyCache {
  private readonly _byDevice = new Map<string, Array<{ revision: number; xml: string }>>();
  private _revision = 0;

  constructor(private readonly _kept = 5) {}

  /** Remember a capture of a device; returns its revision. */
  remember(workerId: number, deviceIndex: number, xml: string): number {
    const key = `${workerId}:${deviceIndex}`;
    const revision = ++this._revision;
    this._byDevice.set(key, [...(this._byDevice.get(key) ?? []), { revision, xml }].slice(-this._kept));
    return revision;
  }

  /** The capture of that device with that revision, if still kept. */
  at(workerId: number, deviceIndex: number, revision: number): string | undefined {
    return this._byDevice.get(`${workerId}:${deviceIndex}`)?.find((h) => h.revision === revision)?.xml;
  }

  /** The newest capture of that device, if any. */
  latest(workerId: number, deviceIndex: number): string | undefined {
    return this._byDevice.get(`${workerId}:${deviceIndex}`)?.at(-1)?.xml;
  }

  /** Forget a worker's captures (it retired; its id may be reused by another device). */
  forgetWorker(workerId: number): void {
    for (const key of [...this._byDevice.keys()]) {
      if (key.startsWith(`${workerId}:`)) this._byDevice.delete(key);
    }
  }
}

/**
 * Runs one evaluation per device at a time and, while one runs, keeps only
 * the newest waiting request: the client re-asks with each screen refresh,
 * and evaluations it has already superseded must not queue up on the device.
 */
export class LatestOnlyRunner<R> {
  private readonly _running = new Set<string>();
  private readonly _waiting = new Map<string, { job: () => Promise<R>; done: (result: R) => void }>();

  run(key: string, job: () => Promise<R>, done: (result: R) => void): void {
    if (this._running.has(key)) {
      // A newer request replaces one that was still waiting; its reply is
      // never sent, and the client has moved on from it.
      this._waiting.set(key, { job, done });
      return;
    }
    this._running.add(key);
    void job().then(done, () => {}).finally(() => {
      this._running.delete(key);
      const next = this._waiting.get(key);
      if (next) {
        this._waiting.delete(key);
        this.run(key, next.job, next.done);
      }
    });
  }
}
