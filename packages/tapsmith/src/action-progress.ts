/**
 * Lightweight progress channel for long-running device actions.
 *
 * Long device-level operations (save/restore app state, clear app data,
 * restart/launch, session preflight) can take 5–60s+ with no output. Trace
 * recording can't surface them: between test files there is no active trace
 * collector, and headless runs may have tracing disabled entirely. This
 * channel is independent of tracing — Device emits start/end events around
 * the slow set, and each surface (CLI printer, worker IPC forwarder, UI mode)
 * subscribes with its own renderer.
 */

import { isAbortError } from './abort.js';

// ─── Event types ───

export type SlowActionName =
  | 'saveAppState'
  | 'restoreAppState'
  | 'clearAppData'
  | 'restartApp'
  | 'launchApp'
  | 'terminateApp'
  | 'startAgent'
  | 'openDeepLink'
  | 'resetApp'
  | 'sessionReady';

export interface ActionProgressEvent {
  kind: 'start' | 'end'
  /** Monotonic per-process id pairing a start event with its end event. */
  id: number
  action: SlowActionName
  /** Human-readable target, e.g. 'com.example' or 'com.example → state.tar.gz'. */
  target?: string
  /** Wall-clock duration. End events only. */
  durationMs?: number
  /** End events only. */
  success?: boolean
  /** True when the action was cancelled by a user stop. End events only. */
  aborted?: boolean
  /** Error message. End events with success=false only. */
  error?: string
  /**
   * Short annotation set by the action body via {@link ActionProgressHandle},
   * e.g. `'foreground probe 9.1s'`. Renderers append it to the end line so a
   * slow sub-step is attributable without reading the whole duration as one
   * opaque number. End events only.
   */
  detail?: string
}

/**
 * Handle passed to a {@link withActionProgress} body so it can annotate its
 * own end event. Bodies that have nothing to add simply ignore it.
 */
export interface ActionProgressHandle {
  /** Pass `undefined` to clear a detail set earlier in the same action — a body
   *  that retries must not let an earlier attempt's annotation describe a later
   *  attempt's outcome. */
  setDetail(detail: string | undefined): void
}

export type ActionProgressListener = (ev: ActionProgressEvent) => void;

// ─── Labels ───

export interface ActionProgressLabels {
  /** Present continuous, e.g. 'Saving app state'. */
  active: string
  /** Past tense, e.g. 'Saved app state'. */
  done: string
  /** Failure label, e.g. 'Save app state failed'. */
  failed: string
}

export const ACTION_PROGRESS_LABELS: Record<SlowActionName, ActionProgressLabels> = {
  saveAppState: { active: 'Saving app state', done: 'Saved app state', failed: 'Save app state failed' },
  restoreAppState: { active: 'Restoring app state', done: 'Restored app state', failed: 'Restore app state failed' },
  clearAppData: { active: 'Clearing app data', done: 'Cleared app data', failed: 'Clear app data failed' },
  restartApp: { active: 'Restarting app', done: 'Restarted app', failed: 'Restart app failed' },
  launchApp: { active: 'Launching app', done: 'Launched app', failed: 'Launch app failed' },
  terminateApp: { active: 'Stopping app', done: 'Stopped app', failed: 'Stop app failed' },
  startAgent: { active: 'Starting automation agent', done: 'Automation agent started', failed: 'Automation agent start failed' },
  openDeepLink: { active: 'Opening deep link', done: 'Opened deep link', failed: 'Open deep link failed' },
  resetApp: { active: 'Resetting app', done: 'Reset app', failed: 'App reset failed' },
  sessionReady: { active: 'Waiting for app to be ready', done: 'App ready', failed: 'App readiness check failed' },
};

// ─── Channel ───

const listeners = new Set<ActionProgressListener>();
let nextId = 0;

/** Subscribe to action progress events. Returns an unsubscribe function. */
export function onActionProgress(listener: ActionProgressListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitActionProgress(ev: ActionProgressEvent): void {
  for (const listener of listeners) {
    try {
      listener(ev);
    } catch {
      // A broken renderer must never fail the device action it observes.
    }
  }
}

/**
 * Run `fn` bracketed by paired start/end progress events. With no listeners
 * subscribed (library usage), this is a zero-overhead passthrough.
 */
export async function withActionProgress<T>(
  action: SlowActionName,
  target: string | undefined,
  fn: (progress: ActionProgressHandle) => Promise<T>,
): Promise<T> {
  let detail: string | undefined;
  const handle: ActionProgressHandle = { setDetail: (d) => { detail = d; } };

  if (listeners.size === 0) return fn(handle);

  const id = nextId++;
  emitActionProgress({ kind: 'start', id, action, target });
  const start = Date.now();
  try {
    const result = await fn(handle);
    emitActionProgress({
      kind: 'end', id, action, target,
      durationMs: Date.now() - start, success: true, detail,
    });
    return result;
  } catch (err) {
    emitActionProgress({
      kind: 'end', id, action, target,
      durationMs: Date.now() - start, success: false,
      aborted: isAbortError(err),
      error: err instanceof Error ? err.message : String(err),
      detail,
    });
    throw err;
  }
}
