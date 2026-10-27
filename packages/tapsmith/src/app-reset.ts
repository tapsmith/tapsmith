/**
 * App reset policy — the mobile analogue of Playwright's per-test browser
 * context.
 *
 * A policy says *how* the app under test is brought to a known state
 * (`mode`) and *how often* (`scope`). It is resolved once per suite scope from
 * config + `projects[].use` + `test.use()` and then executed by the runner as
 * traced fixture setup (see `session-preflight.ts` `executeAppReset`).
 *
 * This module holds only types and pure functions so it can be shared by the
 * runner, the UI server (tree glyphs, background preparation) and tests.
 */

import * as path from 'node:path';
import type { AppResetMode, AppResetScope, TapsmithConfig } from './config.js';
import { decodeXmlEntities } from './xml-entities.js';
import { HOOKS_MARKER_PREFIX } from './hooks-marker.js';

/** `appReset` with `'auto'` resolved away. */
export type ResolvedAppResetMode = Exclude<AppResetMode, 'auto'>;
/** `appResetScope` with `'auto'` resolved away. */
export type ResolvedAppResetScope = Exclude<AppResetScope, 'auto'>;

export interface AppResetPolicy {
  mode: ResolvedAppResetMode;
  scope: ResolvedAppResetScope;
  /**
   * Saved app state to restore (absolute path). `''` means "clear app data"
   * (an explicit fresh, unauthenticated start); `undefined` means the scope
   * declared no app state and `mode` alone applies.
   */
  appState?: string;
}

/** What the device/session can offer, discovered at runtime. */
export interface ResetCapabilities {
  /** `@tapsmith/react-native` reset hooks were detected in the app's UI hierarchy. */
  hooksDetected?: boolean;
  /** Physical device (not a simulator/emulator). */
  isPhysical?: boolean;
}

/**
 * A reset that already happened, e.g. the startup launch of a freshly
 * installed app or a background preparation in UI mode. The runner compares
 * it against the policy a file/test asks for and skips the inline reset when
 * it is satisfied (recording the fact in the trace).
 */
export interface PreparedState {
  policy: AppResetPolicy;
  /** Wall-clock time the preparation finished. */
  preparedAt: number;
  /** How long the preparation took. */
  durationMs: number;
  /** Human-readable source, e.g. "startup launch" or "background preparation". */
  source: string;
}

/** Where the work behind a recorded reset step happened. */
export type AppResetOrigin = 'inline' | 'prepared' | 'skipped';

export interface AppResetStep {
  name: string;
  durationMs: number;
  ok: boolean;
  detail?: string;
}

export interface AppResetReport {
  /** When `origin` is 'prepared': the earlier preparation that satisfied the policy. */
  satisfiedBy?: PreparedState;
  policy: AppResetPolicy;
  origin: AppResetOrigin;
  /** The mode that actually ran (may differ from `policy.mode` after a fallback). */
  modeUsed: ResolvedAppResetMode | 'restore';
  fellBack: boolean;
  /** Human-readable explanation for a fallback or a skipped reset. */
  reason?: string;
  durationMs: number;
  steps: AppResetStep[];
}

/**
 * Resolve the effective policy for a scope.
 *
 * `scopeOptions.appState` is the scope's own `test.use({ appState })` (not
 * cascaded — a nested describe without `appState` declares none, as before).
 * `appReset` / `appResetScope` are ordinary config keys and arrive already
 * cascaded through `config` (root → project `use` → `test.use()`).
 */
export function resolveAppResetPolicy(
  scopeOptions: { appState?: string } | undefined,
  config: Pick<TapsmithConfig, 'appReset' | 'appResetScope' | 'resetAppDeepLink' | 'rootDir' | 'platform'>,
  caps: ResetCapabilities = {},
): AppResetPolicy {
  const warmAvailable = !!caps.hooksDetected || !!config.resetAppDeepLink;

  const requestedMode = config.appReset ?? 'auto';
  // macOS (experimental) has no warm reset: it always clears (the daemon
  // backs the app's data up for the run and restores it afterwards). An
  // explicit warm is refused at config load.
  const autoMode: ResolvedAppResetMode = config.platform === 'macos'
    ? 'clear'
    : (warmAvailable ? 'warm' : 'clear');
  const mode: ResolvedAppResetMode = requestedMode === 'auto' ? autoMode : requestedMode;

  // `auto` isolation is per-file: one reset at scope entry. Even a warm
  // reset costs ~1-2 s, and most suites navigate to their screen per test
  // anyway, so defaulting to per-test roughly doubled suite time for no
  // isolation the tests asked for. Files that genuinely need a reset before
  // every test opt in with `appResetScope: 'test'` (still warm when the app
  // mounts `@tapsmith/react-native`).
  const appState = scopeOptions?.appState;
  const requestedScope = config.appResetScope ?? 'auto';
  const scope: ResolvedAppResetScope = requestedScope === 'auto' ? 'file' : requestedScope;

  const policy: AppResetPolicy = { mode, scope };
  if (appState !== undefined) {
    policy.appState = appState === ''
      ? ''
      : (path.isAbsolute(appState) ? appState : path.resolve(config.rootDir, appState));
  }
  return policy;
}

/**
 * The concrete action a policy implies. `appState` takes precedence over
 * `mode`: a non-empty archive means "restore", an empty string means "clear".
 */
export type AppResetAction =
  | { kind: 'restore'; archive: string }
  | { kind: 'clear' }
  | { kind: 'restart' }
  | { kind: 'warm' }
  | { kind: 'none' };

export function appResetAction(policy: AppResetPolicy): AppResetAction {
  if (policy.appState !== undefined) {
    return policy.appState === '' ? { kind: 'clear' } : { kind: 'restore', archive: policy.appState };
  }
  return { kind: policy.mode };
}

/**
 * Whether a device already in state `have` satisfies what `want` asks for.
 *
 * Lattice: `clear` (fresh install state) satisfies every mode-only policy;
 * `restart` and `warm` satisfy themselves and `none`; `none` satisfies only
 * `none`. A restored archive satisfies only the identical archive — and a
 * plain `clear` never satisfies a restore (the restore owns that state).
 */
export function satisfies(have: AppResetPolicy, want: AppResetPolicy): boolean {
  const h = appResetAction(have);
  const w = appResetAction(want);
  if (w.kind === 'restore') return h.kind === 'restore' && h.archive === w.archive;
  if (h.kind === 'restore') return w.kind === 'none';
  if (w.kind === 'none') return true;
  if (h.kind === 'clear') return true;
  return h.kind === w.kind;
}

export function appResetPolicyEquals(a: AppResetPolicy | undefined, b: AppResetPolicy | undefined): boolean {
  if (!a || !b) return a === b;
  return a.mode === b.mode && a.scope === b.scope && a.appState === b.appState;
}

/** Trace-friendly action label: "App reset (clear)". */
export function describeAction(policy: AppResetPolicy): string {
  const action = appResetAction(policy);
  return action.kind === 'restore'
    ? `App reset (restore ${path.basename(action.archive)})`
    : `App reset (${action.kind})`;
}

// ─── @tapsmith/react-native hooks marker ───

export interface HooksMarker {
  version: number;
  epoch: number;
  /** Counts every URL the process received (navigation ack). */
  nav?: number;
  /** URL prefix the module builds reset links from; empty when it could not determine one. */
  urlPrefix: string;
  error?: string;
}

/**
 * Find the in-app reset hooks marker in a UI hierarchy dump (Android
 * `text="…"`, iOS `label="…"`/`name="…"`). Mirrors `app_reset::parse_hooks_marker`
 * in the daemon; the SDK uses it to resolve `appReset: 'auto'`.
 */
export function parseHooksMarker(hierarchyXml: string): HooksMarker | undefined {
  const start = hierarchyXml.indexOf(HOOKS_MARKER_PREFIX);
  if (start < 0) return undefined;
  const rest = hierarchyXml.slice(start + HOOKS_MARKER_PREFIX.length);
  const end = rest.search(/["'<\n]/);
  const raw = decodeXmlEntities(end < 0 ? rest : rest.slice(0, end));
  const [versionRaw, ...fields] = raw.split(';');
  const version = Number.parseInt(versionRaw, 10);
  // Only protocol version 1 is understood. A future version may change field
  // semantics, so treat it as "no marker" — detection degrades to cold resets
  // instead of misreading acks.
  if (version !== 1) return undefined;
  let epoch: number | undefined;
  let nav: number | undefined;
  let urlPrefix = '';
  let error: string | undefined;
  for (const field of fields) {
    const eq = field.indexOf('=');
    if (eq < 0) continue;
    const key = field.slice(0, eq).trim();
    const value = field.slice(eq + 1).trim();
    if (key === 'epoch') epoch = Number.parseInt(value, 10);
    else if (key === 'nav') nav = Number.parseInt(value, 10);
    else if (key === 'url') urlPrefix = value;
    else if (key === 'err' && value) {
      try { error = decodeURIComponent(value); } catch { error = value; }
    }
  }
  if (epoch === undefined || !Number.isFinite(epoch)) return undefined;
  return {
    version, epoch, urlPrefix,
    ...(nav !== undefined && Number.isFinite(nav) ? { nav } : {}),
    ...(error ? { error } : {}),
  };
}
