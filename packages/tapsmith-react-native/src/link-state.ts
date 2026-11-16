import { currentResetEpoch, publishResetEpoch } from './epoch.js';
import { parseResetRequest, resetDedupeKey, type ResetRequest } from './protocol.js';

/**
 * What `<TapsmithTestHooks>` has done with incoming links, kept per process
 * like the marker's `boot` token rather than in the component: an app can
 * remount the component (an `onReload` that resets the navigation root
 * remounts the layout that renders it), and Tapsmith compares the marker's
 * counts across that. Component state would restart them at 0, so a reset
 * that ran would read as one that never advanced the epoch, and a remount
 * would re-handle the cold-launch link and run its reset again.
 */
interface LinkState {
  /** Links received: the ack for plain navigation deep links. */
  nav: number;
  /** The last reset's error, if its handlers threw. */
  error: string | undefined;
}

let state: LinkState = { nav: 0, error: undefined };
let seenResets = new Set<string>();
let initialUrlClaimed = false;
const listeners = new Set<() => void>();

/** @internal */
export function linkState(): LinkState {
  return state;
}

/** @internal — subscribe to changes (useSyncExternalStore); returns the unsubscribe function. */
export function subscribeLinkState(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * @internal — true the first time it is called in this process. A cold launch
 * delivers its URL before any listener exists, and only the first mount may
 * handle it.
 */
export function claimInitialUrl(): boolean {
  if (initialUrlClaimed) return false;
  initialUrlClaimed = true;
  return true;
}

function update(next: Partial<LinkState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export interface HandleUrlOptions {
  /** The cold-launch URL: handled even when the mount that read it is gone. */
  initial: boolean;
  /** The listening component unmounted. */
  isDisposed: () => boolean;
  /** Run the reset the link asks for. */
  run: (request: ResetRequest) => Promise<void>;
}

/**
 * @internal — handle one incoming link: count it, and run the reset it asks
 * for, once per nonce. A reset that started is acknowledged (the epoch
 * advances, with any error) even if the component unmounted while it ran:
 * the reset happened, and a remounted marker shows the result.
 */
export async function handleIncomingUrl(url: string | null | undefined, options: HandleUrlOptions): Promise<void> {
  if (!url || (options.isDisposed() && !options.initial)) return;
  update({ nav: state.nav + 1 });
  const request = parseResetRequest(url);
  if (!request) return;
  // A dropped-and-refired intent must not reset twice. Bounded: only recent
  // entries matter for redelivery.
  const key = resetDedupeKey(request, url);
  if (seenResets.has(key)) return;
  seenResets.add(key);
  while (seenResets.size > 64) seenResets.delete(seenResets.values().next().value as string);
  let error: string | undefined;
  try {
    await options.run(request);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  // Always advance the epoch so Tapsmith never waits on a failed reset; the
  // error rides along in the marker. Error first: the epoch's listeners
  // re-render the marker.
  update({ error });
  publishResetEpoch(currentResetEpoch() + 1);
}

/** @internal — tests only. */
export function _resetLinkStateForTests(): void {
  state = { nav: 0, error: undefined };
  seenResets = new Set();
  initialUrlClaimed = false;
}
