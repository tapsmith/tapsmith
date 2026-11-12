import type { ResetRequest } from './protocol.js';

/** Anything with a `clear()` (AsyncStorage) or `clearAll()` (MMKV) method. */
export type Clearable =
  | { clear: () => Promise<unknown> | unknown }
  | { clearAll: () => Promise<unknown> | unknown };

export type ResetHandler = (request: ResetRequest) => void | Promise<void>;

const handlers = new Set<ResetHandler>();

/**
 * Register a reset handler imperatively (an alternative to the `onReset`
 * prop, useful from non-React code). Returns an unsubscribe function.
 */
export function registerTapsmithReset(handler: ResetHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

export function registeredHandlers(): readonly ResetHandler[] {
  return [...handlers];
}

/**
 * Clear every store, then run every handler, in order. Throws the first
 * failure.
 *
 * A request to keep the app's data (`keepData`, between tests that restore
 * the same `appState`) clears nothing and runs no reset handler: it runs only
 * `reload`, which drops in-memory state and reads it back from storage. With
 * no `reload` it fails without touching anything, and Tapsmith restores the
 * saved state instead.
 *
 * `settle` (the keyboard dismissal) runs alongside the clear, which still
 * starts first: a screen the reset link mounts reads cleared storage. When
 * `settle` reports that a focused input was blurred, the stores are cleared
 * again once it is done, so an `onBlur` that saved a draft cannot leave it
 * behind. A failing `settle` never fails the reset.
 */
export async function runResetPipeline(
  request: ResetRequest,
  clear: readonly Clearable[],
  handlers: readonly ResetHandler[],
  settle?: () => Promise<boolean>,
  reload?: ResetHandler,
): Promise<void> {
  if (request.keepData) {
    if (!reload) {
      throw new Error('Tapsmith asked for a reset that keeps the app\'s data, but <TapsmithTestHooks> has no onReload');
    }
    if (settle) await settle().catch(() => false);
    await reload(request);
    return;
  }
  const cleared = clearStores(clear);
  const settled = settle ? settle().catch(() => false) : Promise.resolve(false);
  const [, blurred] = await Promise.all([cleared, settled]);
  if (blurred) await clearStores(clear);
  for (const handler of handlers) {
    await handler(request);
  }
}

async function clearStores(clear: readonly Clearable[]): Promise<void> {
  for (const store of clear) {
    if ('clearAll' in store && typeof store.clearAll === 'function') await store.clearAll();
    else if ('clear' in store && typeof store.clear === 'function') await store.clear();
  }
}
