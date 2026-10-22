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
import type { Bounds, HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { generateSelectors } from '../trace-viewer/components/selector-generation.js';
import { agentValidatedSuggestions } from '../mcp/agent-suggestions.js';
import { sdkDeviceFor, withEvaluatedLocator } from '../mcp/sdk-device.js';

/** iOS checks a batch in one XCUI snapshot, so it takes far more per call. */
const IOS_CHUNK_SIZE = 500;

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
): Promise<LiveLocatorEvaluation> {
  try {
    const device = await sdkDeviceFor(client, serial);
    return await withEvaluatedLocator(device, client, locator, async (evaluated) => {
      if (evaluated.kind === 'webview') {
        const count = await evaluated.locator.count();
        return { count, positional: evaluated.locator._nthIndex !== undefined, bounds: [], webview: true };
      }
      const { matches, total, positional } = await evaluated.handle._currentMatches();
      return {
        count: matches.length,
        total,
        positional,
        bounds: matches.flatMap((m) => (m.bounds ? [m.bounds] : [])),
      };
    });
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
  options: { ios: boolean },
): Promise<LiveLocatorSuggestions> {
  if (node.attributes.get('webview') === 'true') {
    const suggestions: LiveLocatorSuggestions['suggestions'] = [];
    let note: string | undefined;
    for (const candidate of generateSelectors(node).filter((s) => s.code.startsWith('webview.'))) {
      const result = await evaluateLiveLocator(client, serial, candidate.code);
      if (result.error) { note = result.error; break; }
      if (result.count === 1) suggestions.push({ code: candidate.code, label: candidate.label });
    }
    return { suggestions, note };
  }
  const checked = await agentValidatedSuggestions(client, [node], options.ios ? { chunkSize: IOS_CHUNK_SIZE } : {});
  const suggestions = (checked.byNode.get(node) ?? []).map((s) => ({ code: s.code, label: s.label }));
  const note = checked.errorMessage
    ?? (checked.notFound > 0 ? 'The element was no longer on screen when the device checked; pick it again.' : undefined);
  return { suggestions, note };
}
