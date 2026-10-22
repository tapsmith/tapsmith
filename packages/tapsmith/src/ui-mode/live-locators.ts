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
  /** Where the matches are (native locators; a WebView locator has none). */
  bounds: Bounds[]
  /** A webview.* locator, counted in the page. */
  webview?: boolean
  /** Why there is no count: not a locator, no device, the agent failed. */
  error?: string
}

/** What `locator` matches on the device right now, as a test would resolve it. */
export async function evaluateLiveLocator(
  client: TapsmithGrpcClient,
  serial: string | undefined,
  locator: string,
  /** The WebView connection UI mode already holds to this device, if any. */
  webview?: () => Promise<WebViewHandle>,
): Promise<LiveLocatorEvaluation> {
  try {
    const device = await sdkDeviceFor(client, serial);
    return await withEvaluatedLocator(device, client, locator, async (evaluated) => {
      if (evaluated.kind === 'webview') {
        const { count, total, matches } = await evaluated.locator._handle._liveMatches(evaluated.locator, LIVE_WEBVIEW_TIMEOUT_MS);
        return {
          count,
          total,
          positional: evaluated.locator._nthIndex !== undefined,
          bounds: matches.flatMap((m) => (m.bounds ? [m.bounds] : [])),
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
    }, { webview });
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
  options: { ios: boolean; webview?: () => Promise<WebViewHandle> },
): Promise<LiveLocatorSuggestions> {
  if (node.attributes.get('webview') === 'true') {
    const suggestions: LiveLocatorSuggestions['suggestions'] = [];
    let note: string | undefined;
    for (const candidate of generateSelectors(node).filter((s) => s.code.startsWith('webview.'))) {
      const result = await webViewOnlyMatch(client, serial, candidate.code, options.webview);
      if (result.error) { note = result.error; break; }
      if (result.only && isPickedWebViewElement(result.only, node)) {
        suggestions.push({ code: candidate.code, label: candidate.label });
      }
    }
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

type WebViewMatch = Awaited<ReturnType<WebViewHandle['_liveMatches']>>['matches'][number];

/** The page's one match for a `webview.*` locator, or none when it matches 0 or several. */
async function webViewOnlyMatch(
  client: TapsmithGrpcClient,
  serial: string | undefined,
  locator: string,
  webview: (() => Promise<WebViewHandle>) | undefined,
): Promise<{ only?: WebViewMatch; error?: string }> {
  try {
    const device = await sdkDeviceFor(client, serial);
    return await withEvaluatedLocator(device, client, locator, async (evaluated) => {
      if (evaluated.kind !== 'webview') return {};
      const { count, matches } = await evaluated.locator._handle._liveMatches(evaluated.locator, LIVE_WEBVIEW_TIMEOUT_MS, 1);
      return count === 1 ? { only: matches[0] } : {};
    }, { webview });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
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
  private readonly byDevice = new Map<string, Array<{ revision: number; xml: string }>>();
  private revision = 0;

  constructor(private readonly kept = 5) {}

  /** Remember a capture of a device; returns its revision. */
  remember(workerId: number, deviceIndex: number, xml: string): number {
    const key = `${workerId}:${deviceIndex}`;
    const revision = ++this.revision;
    this.byDevice.set(key, [...(this.byDevice.get(key) ?? []), { revision, xml }].slice(-this.kept));
    return revision;
  }

  /** The capture of that device with that revision, if still kept. */
  at(workerId: number, deviceIndex: number, revision: number): string | undefined {
    return this.byDevice.get(`${workerId}:${deviceIndex}`)?.find((h) => h.revision === revision)?.xml;
  }

  /** The newest capture of that device, if any. */
  latest(workerId: number, deviceIndex: number): string | undefined {
    return this.byDevice.get(`${workerId}:${deviceIndex}`)?.at(-1)?.xml;
  }

  /** Forget a worker's captures (it retired; its id may be reused by another device). */
  forgetWorker(workerId: number): void {
    for (const key of [...this.byDevice.keys()]) {
      if (key.startsWith(`${workerId}:`)) this.byDevice.delete(key);
    }
  }
}

/**
 * Runs one evaluation per device at a time and, while one runs, keeps only
 * the newest waiting request: the client re-asks with each screen refresh,
 * and evaluations it has already superseded must not queue up on the device.
 */
export class LatestOnlyRunner<R> {
  private readonly running = new Set<string>();
  private readonly waiting = new Map<string, { job: () => Promise<R>; done: (result: R) => void }>();

  run(key: string, job: () => Promise<R>, done: (result: R) => void): void {
    if (this.running.has(key)) {
      // A newer request replaces one that was still waiting; its reply is
      // never sent, and the client has moved on from it.
      this.waiting.set(key, { job, done });
      return;
    }
    this.running.add(key);
    void job().then(done, () => {}).finally(() => {
      this.running.delete(key);
      const next = this.waiting.get(key);
      if (next) {
        this.waiting.delete(key);
        this.run(key, next.job, next.done);
      }
    });
  }
}
