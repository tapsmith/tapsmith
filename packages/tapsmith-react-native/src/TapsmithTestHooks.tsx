import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Keyboard, Linking, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatMarker, BOOT_TOKEN } from './protocol.js';
import { currentResetEpoch, subscribeResetEpoch } from './epoch.js';
import { claimInitialUrl, handleIncomingUrl, linkState, subscribeLinkState } from './link-state.js';
import { CARRIER_TEXT_COLOR } from './carrier-color.js';
import { hooksEnabledByDefault } from './enabled.js';
import { blurFocusedInput, type KeyboardDeps } from './keyboard.js';
import { registeredHandlers, runResetPipeline, type Clearable, type ResetHandler } from './reset.js';
import { persistedWriteCount, subscribePersistedWrites, trackStoreWrites } from './writes.js';

export interface TapsmithTestHooksProps {
  /**
   * Runs on every reset request, after `clear`. Put your app's own reset here
   * (sign out, drop in-memory caches, reset navigation state).
   */
  onReset?: ResetHandler;
  /**
   * Stores to wipe on reset, e.g. `[AsyncStorage]` or `[storage]` (MMKV).
   * Passed in rather than imported so the package has no dependency on any
   * particular storage library (Metro cannot bundle optional imports).
   */
  clear?: readonly Clearable[];
  /**
   * URL prefix Tapsmith should build reset links from — must route into this
   * app. Expo: `Linking.createURL('/')` from `expo-linking` (handles Expo Go
   * and standalone builds). Bare React Native: `'myapp://'`.
   */
  urlPrefix?: string;
  /**
   * Resets the app while keeping its persisted data: drop in-memory state
   * (caches, navigation) and read it back from storage, as a fresh launch
   * would, refreshing the signed-in session in place rather than signing out
   * (an auth guard that sees a signed-out moment redirects mid-reset). Tapsmith calls it instead of `clear`, `onReset` and
   * `registerTapsmithReset` handlers (none of them run, so reset what they
   * would, and cancel writes the app has scheduled but not made) between tests that restore the same saved app state (`appState`), when
   * the app has written nothing to its stores since the restore — so the
   * data still matches the archive and no restore + relaunch is needed.
   * Requires `track`.
   */
  onReload?: ResetHandler;
  /**
   * Stores whose writes Tapsmith counts, e.g. `[AsyncStorage]` or `[storage]`
   * (MMKV): every store the app persists data in. With `onReload`, the count
   * lets Tapsmith tell whether a test changed the restored data. Report
   * writes these stores cannot show (native modules, SQLite, files, the
   * keychain) with `markTapsmithWrite()`; pass `[]` if that covers all of
   * them. A store that writes through statements or file operations (a
   * SQLite database, a file system) cannot be counted, and passing one turns
   * the count off.
   */
  track?: readonly object[];
  /** Bare React Native shorthand for `urlPrefix={`${scheme}://`}`. */
  scheme?: string;
  /**
   * Whether the hooks are on. Pass
   * `__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === '1'` from the app's
   * own code: Expo inlines `EXPO_PUBLIC_*` only in app code, never inside
   * node_modules, so the package's own fallback (the same check) cannot see
   * the flag in an npm-installed Expo Release build.
   */
  enabled?: boolean;
}

/** React Native's keyboard, for blurring the focused input on reset. */
const keyboardDeps: KeyboardDeps = {
  focusedInput: () => TextInput.State?.currentlyFocusedInput?.() ?? null,
  isVisible: () => Keyboard.isVisible?.() ?? false,
  dismiss: () => Keyboard.dismiss(),
  onDidHide: (cb) => {
    const sub = Keyboard.addListener('keyboardDidHide', cb);
    return () => sub.remove();
  },
};

/**
 * Mount once at the root of the app. Renders an invisible, always-present
 * marker in the accessibility tree that tells Tapsmith the app can be reset
 * in-process (and acknowledges each reset by bumping an epoch), and listens
 * for the reset deep links Tapsmith opens. Tapsmith reads the marker from the
 * hierarchy; no locator matches it.
 *
 * Renders nothing and registers nothing when disabled (production).
 */
export function TapsmithTestHooks({ onReset, onReload, track, clear = [], urlPrefix, scheme, enabled }: TapsmithTestHooksProps) {
  const active = enabled ?? hooksEnabledByDefault();
  // Per process, not per mount (see link-state.ts): a remount keeps them.
  const epoch = useSyncExternalStore(subscribeResetEpoch, currentResetEpoch);
  const { nav, error } = useSyncExternalStore(subscribeLinkState, linkState);
  const [writes, setWrites] = useState(persistedWriteCount);
  // Undefined until the stores are wrapped (an effect, after the first
  // commit). The count is published from the first render on: Tapsmith may
  // read the marker before the effect runs, and a marker without a count
  // there would read as "this app reports no writes".
  const [trackable, setTrackable] = useState<boolean | undefined>(undefined);
  const latest = useRef({ onReset, onReload, clear });
  latest.current = { onReset, onReload, clear };
  // `track={[AsyncStorage]}` is a new array on every render: re-wrap only
  // when the stores themselves change.
  const trackedStores = useRef<readonly object[] | undefined>(undefined);
  if (!sameStores(trackedStores.current, track)) trackedStores.current = track;
  const stores = trackedStores.current;

  useEffect(() => {
    if (!active || !stores) {
      setTrackable(false);
      return undefined;
    }
    const tracking = trackStoreWrites(stores);
    setTrackable(tracking.trackable);
    const unsubscribe = subscribePersistedWrites(setWrites);
    setWrites(persistedWriteCount());
    return () => {
      unsubscribe();
      tracking.untrack();
    };
  }, [active, stores]);

  const prefix = normalisePrefix(urlPrefix ?? (scheme ? `${scheme}://` : ''));

  useEffect(() => {
    if (!active) return;
    let disposed = false;

    // `initial`: the cold-launch URL. It is read once per process (see below)
    // but resolves asynchronously — under StrictMode (and any `enabled`
    // toggle) this effect's first pass is already disposed by then, so that
    // URL must be honoured regardless of `disposed` or a cold-delivered reset
    // is silently dropped.
    const handle = (url: string | null | undefined, initial = false) => handleIncomingUrl(url, {
      initial,
      isDisposed: () => disposed,
      // A fresh app has no focused input. A reset that lands on the screen
      // already showing keeps it mounted, and with it whatever input had
      // focus and the keyboard over it, which the next test would start
      // under. Blur it alongside the clear (see runResetPipeline for the order).
      run: (request) => {
        const handlers: ResetHandler[] = [...(latest.current.onReset ? [latest.current.onReset] : []), ...registeredHandlers()];
        return runResetPipeline(request, latest.current.clear, handlers, () => blurFocusedInput(keyboardDeps), latest.current.onReload);
      },
    });

    const sub = Linking.addEventListener('url', ({ url }) => { void handle(url); });
    // A cold launch delivers the URL before any listener exists. Count it
    // once per process: a re-run of this effect (`enabled` toggled) or a
    // remount re-reads the same initial URL, which must not bump `nav` or run
    // its reset again.
    if (claimInitialUrl()) {
      Linking.getInitialURL().then((url) => { void handle(url, true); }, () => { /* ignore */ });
    }
    return () => {
      disposed = true;
      sub.remove();
    };
  }, [active]);

  if (!active) return null;

  // The write count is published only when Tapsmith can act on it: the app
  // can reset while keeping its data, and every tracked store is counted.
  const reportsWrites = !!onReload && !!stores && trackable !== false;
  const marker = formatMarker({ epoch, nav, boot: BOOT_TOKEN, urlPrefix: prefix, error, ...(reportsWrites ? { writes } : {}) });

  // The marker. Deliberately screen-sized rather than tucked into a corner: a
  // platform's own UI can sit on top of a corner — Android's three-button
  // navigation bar covers the bottom-right outright on an edge-to-edge app —
  // and UIAutomator omits occluded nodes from its dump entirely (every node in
  // a dump carries visible-to-user="true"). A corner marker therefore just
  // vanishes, Tapsmith concludes the app has no hooks, and `appReset: 'auto'`
  // silently resolves to clear instead of warm: ~5-10s per reset against ~1s,
  // with a green suite and no warning.
  //
  // Something screen-sized always has a visible region left over whatever the
  // system draws on top, so this node survives the dump. The text is
  // invisible (CARRIER_TEXT_COLOR: not 'transparent', which Android draws
  // black), so nothing about the app's appearance changes, and the wrapper is
  // pointerEvents="none" so it swallows no touches.
  //
  // There is no visible copy: earlier versions also drew the string in small
  // grey text in the bottom-right corner, which showed in every screenshot
  // (PILOT-830). Tapsmith reads the marker from the hierarchy dump, and its
  // locators never match it, so nothing on screen needs it.
  return (
    <View pointerEvents="none" style={styles.carrier} importantForAccessibility="yes">
      <Text testID="tapsmith-hooks" style={styles.carrierText}>
        {marker}
      </Text>
    </View>
  );
}

function sameStores(a: readonly object[] | undefined, b: readonly object[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((store, i) => store === b[i]);
}

function normalisePrefix(prefix: string): string {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

const styles = StyleSheet.create({
  // Screen-sized so no system bar, notch or inset can occlude it away.
  carrier: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  // Fills the carrier, so the *text node itself* — the one the hierarchy dump
  // reports — is screen-sized too, not just its parent. Invisible, so the
  // marker changes nothing on screen.
  carrierText: {
    bottom: 0,
    color: CARRIER_TEXT_COLOR,
    fontSize: 8,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
});
