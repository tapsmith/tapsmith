/**
 * The live mirror's lock, worked out per mirrored device.
 *
 * The lock and everything that reads the live device from the mirror (the
 * element picker, the Locator tab's live polling) follow the device the
 * mirror shows, not the worker selected elsewhere in the UI: with several
 * workers those can be different devices.
 */

import type { WorkerInfo } from './ui-protocol.js';

/**
 * The lock preference:
 *   'auto' — locked only while a test runs on the mirrored device (default)
 *   'on'   — locked by the user; stays locked after the run ends
 *   'off'  — unlocked by the user during a run; back to 'auto' when it ends
 */
export type MirrorLockPref = 'auto' | 'on' | 'off';

export interface MirrorLockState {
  /** Gestures on the mirror are not sent to the device. */
  locked: boolean
  /**
   * A test runs on the device and the user unlocked the mirror anyway: the
   * live picker and Locator tab may read the device mid-run.
   */
  overridden: boolean
  /**
   * A test runs on the device and the mirror is locked: the picker and the
   * Locator tab's live polling leave the device alone until the run ends.
   */
  livePaused: boolean
}

export function mirrorLockState(pref: MirrorLockPref, running: boolean): MirrorLockState {
  const locked = pref === 'on' ? true : pref === 'off' ? false : running;
  return { locked, overridden: running && !locked, livePaused: running && locked };
}

/**
 * Whether a test is running on worker `workerId`'s device. Before the server
 * has described any worker (an old server, or the first moments of a
 * session) the session-wide run state stands in for it.
 */
export function workerRunning(workers: readonly WorkerInfo[], workerId: number, sessionRunning: boolean): boolean {
  if (workers.length === 0) return sessionRunning;
  return workers.find((w) => w.workerId === workerId)?.status === 'running';
}

/**
 * Whether a test is running on a device the mirror shows: the mirrored
 * worker's in the single view, any worker's in the "All" grid.
 */
export function mirrorRunning(
  workers: readonly WorkerInfo[],
  view: { grid: boolean, workerId: number },
  sessionRunning: boolean,
): boolean {
  if (!view.grid) return workerRunning(workers, view.workerId, sessionRunning);
  if (workers.length === 0) return sessionRunning;
  return workers.some((w) => w.status === 'running');
}
