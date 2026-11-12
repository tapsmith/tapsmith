/**
 * Persisted-write tracking for resets that keep the app's data.
 *
 * Between tests that restore the same saved app state (`appState`), Tapsmith
 * can skip the restore and relaunch when the app has written nothing to its
 * persisted stores since the restore: the data on the device still matches
 * the archive, so resetting in-memory state (`onReload`) is enough. The
 * hooks count writes to the stores the app passes as `track` and publish the
 * count in the marker (`writes=<n>`); Tapsmith compares it with the count it
 * read right after the restore, in the same process (the `boot` token).
 *
 * The count is per process, like the boot token, and only ever grows.
 * Writes the hooks cannot see (native modules, SQLite, files, the keychain)
 * are reported with {@link markTapsmithWrite}.
 */

let count = 0;
const listeners = new Set<(count: number) => void>();

/** The number of persisted writes counted in this process. */
export function persistedWriteCount(): number {
  return count;
}

/**
 * Tell Tapsmith the app changed persisted data the hooks cannot see — a
 * native module, SQLite, a file, the keychain. The next reset between tests
 * that restore the same `appState` then restores the archive again instead
 * of keeping the data. A no-op cost in production: nothing listens.
 */
export function markTapsmithWrite(): void {
  count += 1;
  for (const l of listeners) l(count);
}

/** Subscribe to the write count; returns the unsubscribe function. */
export function subscribePersistedWrites(listener: (count: number) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Method names that change a store's data: AsyncStorage (`setItem`,
 * `removeItem`, `mergeItem`, `clear`, `multiSet`, `multiRemove`,
 * `multiMerge`), MMKV (`set`, `delete`, `clearAll`, `recrypt`, `trim`,
 * `importAllFrom`), expo-secure-store (`setItemAsync`, `deleteItemAsync`),
 * keychain-style `reset*`, Realm-style `write`/`create`, and the
 * `put`/`save`/`insert`/`update`/`add`/`append`/`move`/`copy`/`rename`/
 * `unlink` families of other stores. Counting a method that turns out not
 * to write only costs a restore; missing one would leak data between tests,
 * so the match is deliberately broad. Listener registration (`addListener`,
 * `addOnValueChangedListener`) changes no data and is left alone: components
 * subscribe while tests run.
 */
const WRITE_METHOD = /^(set|remove|delete|clear|merge|multiSet|multiRemove|multiMerge|recrypt|trim|import|reset|write|create|put|save|insert|update|add|append|move|copy|rename|unlink)/;
const NOT_A_WRITE = /Listener$/;

export interface StoreTracking {
  /**
   * Every store had at least one write method, and each was wrapped. When
   * false, the hooks do not publish a write count: Tapsmith cannot tell
   * whether the data changed, so it restores the archive every time.
   */
  trackable: boolean;
  /** Put the stores' own methods back. */
  untrack: () => void;
}

/** Wrap every write method of `stores` so each call counts as a persisted write. */
export function trackStoreWrites(stores: readonly object[]): StoreTracking {
  const undo: Array<() => void> = [];
  let trackable = true;
  for (const store of stores) {
    const names = writeMethodNames(store);
    if (names.length === 0) trackable = false;
    for (const name of names) {
      const target = store as Record<string, unknown>;
      const hadOwn = Object.prototype.hasOwnProperty.call(store, name);
      const original = target[name] as (...args: unknown[]) => unknown;
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        // Before the call: a write that fails half-way may still have changed
        // something, and a rejected promise is the caller's to handle.
        markTapsmithWrite();
        return original.apply(this, args);
      };
      try {
        target[name] = wrapped;
      } catch {
        trackable = false;
        continue;
      }
      // A frozen or non-writable property ignores the assignment silently
      // outside strict mode.
      if (target[name] !== wrapped) {
        trackable = false;
        continue;
      }
      undo.push(() => {
        try {
          if (hadOwn) target[name] = original;
          else delete target[name];
        } catch { /* best-effort */ }
      });
    }
  }
  return {
    trackable,
    untrack: () => { for (const u of undo.reverse()) u(); },
  };
}

function writeMethodNames(store: object): string[] {
  const names = new Set<string>();
  for (let o: object | null = store; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o) as object | null) {
    for (const name of Object.getOwnPropertyNames(o)) {
      if (name === 'constructor' || !WRITE_METHOD.test(name) || NOT_A_WRITE.test(name)) continue;
      let value: unknown;
      try { value = (store as Record<string, unknown>)[name]; } catch { continue; }
      if (typeof value === 'function') names.add(name);
    }
  }
  return [...names];
}
