import { describe, it, expect } from 'vitest';
import { mirrorLockState, mirrorRunning, workerRunning } from '../ui-mode/mirror-lock.js';
import type { WorkerInfo } from '../ui-mode/ui-protocol.js';

function worker(workerId: number, status: WorkerInfo['status']): WorkerInfo {
  return { workerId, deviceSerial: `emulator-${5554 + 2 * workerId}`, displayName: `w${workerId}`, status, passed: 0, failed: 0, skipped: 0 };
}

describe('mirrorLockState', () => {
  it('auto locks only while a test runs, and pauses the live picker then', () => {
    expect(mirrorLockState('auto', false)).toEqual({ locked: false, overridden: false, livePaused: false });
    expect(mirrorLockState('auto', true)).toEqual({ locked: true, overridden: false, livePaused: true });
  });

  it('an explicit lock with no run locks gestures but leaves the picker alone', () => {
    expect(mirrorLockState('on', false)).toEqual({ locked: true, overridden: false, livePaused: false });
    expect(mirrorLockState('on', true)).toEqual({ locked: true, overridden: false, livePaused: true });
  });

  it('an unlock during a run opts back in to reading the device', () => {
    expect(mirrorLockState('off', true)).toEqual({ locked: false, overridden: true, livePaused: false });
  });
});

describe('workerRunning / mirrorRunning', () => {
  const workers = [worker(0, 'idle'), worker(1, 'running')];

  it('follows the mirrored worker, not any other', () => {
    expect(workerRunning(workers, 0, true)).toBe(false);
    expect(workerRunning(workers, 1, false)).toBe(true);
    expect(mirrorRunning(workers, { grid: false, workerId: 0 }, true)).toBe(false);
    expect(mirrorRunning(workers, { grid: false, workerId: 1 }, false)).toBe(true);
  });

  it('a worker the server has not described is not running', () => {
    expect(workerRunning(workers, 7, true)).toBe(false);
  });

  it('the grid counts as running while any shown device runs a test', () => {
    expect(mirrorRunning(workers, { grid: true, workerId: 0 }, false)).toBe(true);
    expect(mirrorRunning([worker(0, 'idle'), worker(1, 'done')], { grid: true, workerId: 0 }, true)).toBe(false);
  });

  it('falls back to the session run state before any worker is described', () => {
    expect(workerRunning([], 0, true)).toBe(true);
    expect(mirrorRunning([], { grid: true, workerId: 0 }, false)).toBe(false);
  });
});
