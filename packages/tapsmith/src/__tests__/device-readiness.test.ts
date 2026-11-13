import { describe, expect, it } from 'vitest';
import {
  DeviceReadiness,
  DEFAULT_GRACE_MS,
  INTERACTION_HOLD_MS,
  TARGET_CHANGED_GRACE_MS,
  MAX_PREPARE_ATTEMPTS,
  mcpToolWorkers,
  toWireReadiness,
  type Candidate,
  type ReadinessCommand,
  type ReadinessEnv,
} from '../ui-mode/device-readiness.js';
import type { AppResetPolicy } from '../app-reset.js';

const CLEAR: AppResetPolicy = { mode: 'clear', scope: 'file' };
const RESTART: AppResetPolicy = { mode: 'restart', scope: 'file' };
const AUTH: AppResetPolicy = { mode: 'clear', scope: 'file', appState: '/abs/auth.tar.gz' };

function makeEnv(overrides: Partial<ReadinessEnv> & { candidate?: Candidate | null } = {}) {
  let now = 1_000_000;
  const env: ReadinessEnv & { tick(ms: number): void; candidate: Candidate | null; speculation: boolean; interacted: boolean } = {
    candidate: overrides.candidate === undefined ? { file: '/t/a.test.ts', policy: CLEAR } : overrides.candidate,
    speculation: true,
    interacted: false,
    now: () => now,
    speculationEnabled() { return this.speculation; },
    nextCandidate() { return this.candidate ?? undefined; },
    graceMs: () => DEFAULT_GRACE_MS,
    recentlyInteracted() { return this.interacted; },
    tick(ms: number) { now += ms; },
    ...overrides,
  };
  return env;
}

const types = (cmds: ReadinessCommand[]) => cmds.map((c) => c.type);
const sendPrepare = (cmds: ReadinessCommand[]) => cmds.find((c) => c.type === 'send-prepare') as Extract<ReadinessCommand, { type: 'send-prepare' }> | undefined;
const timer = (cmds: ReadinessCommand[]) => cmds.find((c) => c.type === 'start-timer') as Extract<ReadinessCommand, { type: 'start-timer' }> | undefined;

describe('DeviceReadiness', () => {
  it('starts initializing and becomes ready with the startup launch policy', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    expect(r.state).toEqual({ kind: 'initializing' });

    const cmds = r.handle({ type: 'worker-ready', initialPolicy: CLEAR });

    expect(r.state.kind).toBe('ready');
    expect(types(cmds)).toEqual(['broadcast']); // candidate wants clear → satisfied, no prepare
    expect(r.preparedFor(CLEAR)).toMatchObject({ policy: CLEAR, source: 'startup launch' });
    expect(r.preparedFor(RESTART)).toBeDefined(); // clear ⊇ restart
    expect(r.preparedFor(AUTH)).toBeUndefined(); // never satisfies a restore
  });

  it('credits the preparation that did the work when a prepare pass found the device already prepared', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready', initialPolicy: CLEAR });
    r.handle({ type: 'dispatch', file: '/t/a.test.ts', want: CLEAR });
    r.handle({ type: 'file-done' });
    r.handle({ type: 'run-ended', stopped: false });
    const prep = sendPrepare(r.handle({ type: 'grace-elapsed', timerId: 'readiness-0' }))!;
    expect(prep).toBeDefined();
    // The worker's executeAppReset saw a prepared device and did nothing.
    r.handle({
      type: 'prepared', prepareId: prep.prepareId, policy: CLEAR, startedAt: env.now(), durationMs: 12,
      satisfiedBy: { policy: CLEAR, preparedAt: 1_000, durationMs: 9_800, source: 'startup launch' },
    });
    expect(r.preparedFor(CLEAR)).toMatchObject({ preparedAt: 1_000, durationMs: 9_800, source: 'startup launch' });
  });

  it('goes stale when the likely-next file wants something the startup launch does not satisfy', () => {
    const env = makeEnv({ candidate: { file: '/t/auth.test.ts', policy: AUTH } });
    const r = new DeviceReadiness(0, env);

    const cmds = r.handle({ type: 'worker-ready', initialPolicy: CLEAR });

    expect(r.state).toMatchObject({ kind: 'stale', reason: 'target-changed', previous: CLEAR });
    expect(timer(cmds)?.ms).toBe(TARGET_CHANGED_GRACE_MS);
    // …and re-arms for the restore once the short grace elapses.
    const armed = r.handle({ type: 'grace-elapsed', timerId: 'readiness-0' });
    expect(sendPrepare(armed)?.target).toEqual(AUTH);
    expect(r.state.kind).toBe('preparing');
  });

  it('dispatch during preparation cancels the prepare and never blocks the run', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready' });
    const armed = r.handle({ type: 'grace-elapsed', timerId: 'readiness-0' });
    void armed;
    // worker-ready without a policy arms immediately (reason: startup → arm)
    expect(r.state.kind).toBe('preparing');
    const id = (r.state as { prepareId: string }).prepareId;

    const cmds = r.handle({ type: 'dispatch', file: '/t/a.test.ts', want: CLEAR });

    expect(types(cmds)).toEqual(['clear-timer', 'send-cancel-prepare', 'broadcast']);
    expect((cmds[1] as { prepareId: string }).prepareId).toBe(id);
    expect(r.state).toEqual({ kind: 'running', file: '/t/a.test.ts' });
    expect(r.preparedFor(CLEAR)).toBeUndefined();
  });

  it('run-ended → grace → arm → prepared → ready', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready', initialPolicy: CLEAR });
    r.handle({ type: 'dispatch', file: '/t/a.test.ts', want: CLEAR });
    expect(r.handle({ type: 'file-done' })).toEqual([]);

    const ended = r.handle({ type: 'run-ended', stopped: false });
    expect(r.state).toEqual({ kind: 'unprepared', reason: 'grace' });
    expect(timer(ended)?.ms).toBe(DEFAULT_GRACE_MS);

    const armed = r.handle({ type: 'grace-elapsed', timerId: 'readiness-0' });
    const prep = sendPrepare(armed)!;
    expect(prep.target).toEqual(CLEAR);
    expect(prep.forFile).toBe('/t/a.test.ts');

    env.tick(9_800);
    r.handle({ type: 'progress', detail: 'Clearing app data (com.foo)' });
    expect(toWireReadiness(r.state)).toMatchObject({ state: 'preparing', detail: 'Clearing app data (com.foo)' });

    const done = r.handle({ type: 'prepared', prepareId: prep.prepareId, policy: CLEAR, startedAt: env.now() - 9_800, durationMs: 9_800 });
    expect(types(done)).toEqual(['broadcast']);
    expect(r.state).toMatchObject({ kind: 'ready', policy: CLEAR, durationMs: 9_800, forFile: '/t/a.test.ts' });
    expect(r.preparedFor(CLEAR)?.durationMs).toBe(9_800);
  });

  it('run-ended leaves a worker that sat the run out ready (the run is broadcast to every worker)', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready', initialPolicy: CLEAR });
    expect(r.state).toMatchObject({ kind: 'ready', policy: CLEAR });

    // Another worker ran the file; this one was never dispatched.
    expect(r.handle({ type: 'run-ended', stopped: false })).toEqual([]);
    expect(r.state).toMatchObject({ kind: 'ready', policy: CLEAR, source: 'startup launch' });
    // Same for a stopped/failed run elsewhere: nothing on this device to inspect.
    expect(r.handle({ type: 'run-ended', stopped: true, failed: true })).toEqual([]);
    expect(r.state).toMatchObject({ kind: 'ready', policy: CLEAR });
  });

  it('run-ended does not interrupt a preparation on a worker that sat the run out', () => {
    const env = makeEnv({ candidate: { file: '/t/a.test.ts', policy: RESTART } });
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready', initialPolicy: CLEAR });
    r.handle({ type: 'grace-elapsed', timerId: 'readiness-0' });
    const prep = sendPrepare(r.handle({ type: 'prepare-now' }))!;
    expect(r.state).toMatchObject({ kind: 'preparing', prepareId: prep.prepareId });

    expect(r.handle({ type: 'run-ended', stopped: false })).toEqual([]);
    expect(r.state).toMatchObject({ kind: 'preparing', prepareId: prep.prepareId });

    // The in-flight prepare still lands — it was never orphaned or redone.
    const done = r.handle({ type: 'prepared', prepareId: prep.prepareId, policy: RESTART, startedAt: env.now(), durationMs: 500 });
    expect(types(done)).toEqual(['broadcast']);
    expect(r.state).toMatchObject({ kind: 'ready', policy: RESTART, prepareId: prep.prepareId });
  });

  it('a stopped run goes stale (run-stopped) with no timer, and re-arms on selection change', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready', initialPolicy: CLEAR });
    r.handle({ type: 'dispatch', file: '/t/a.test.ts', want: CLEAR });

    // The user stopped the run — don't yank the device into a reset.
    const ended = r.handle({ type: 'run-ended', stopped: true });
    expect(types(ended)).toEqual(['clear-timer', 'broadcast']);
    expect(r.state).toMatchObject({ kind: 'stale', reason: 'run-stopped' });
    expect(timer(ended)).toBeUndefined();

    // Picking a new target is the user moving on — preparation re-arms.
    const rearmed = r.handle({ type: 'candidate-changed' });
    expect(sendPrepare(rearmed)).toBeDefined();
    expect(r.state).toMatchObject({ kind: 'preparing' });
  });

  it('a failed run goes stale (run-failed) with no timer, and re-arms on selection change', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready', initialPolicy: CLEAR });
    r.handle({ type: 'dispatch', file: '/t/a.test.ts', want: CLEAR });

    // A test failed on this device — hold its state for the post-mortem.
    const ended = r.handle({ type: 'run-ended', stopped: false, failed: true });
    expect(types(ended)).toEqual(['clear-timer', 'broadcast']);
    expect(r.state).toMatchObject({ kind: 'stale', reason: 'run-failed' });
    expect(timer(ended)).toBeUndefined();

    // Picking a new target is the user moving on — preparation re-arms.
    const rearmed = r.handle({ type: 'candidate-changed' });
    expect(sendPrepare(rearmed)).toBeDefined();
    expect(r.state).toMatchObject({ kind: 'preparing' });
  });

  it('a stop wins over failures for the hold reason', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready', initialPolicy: CLEAR });
    r.handle({ type: 'dispatch', file: '/t/a.test.ts', want: CLEAR });
    r.handle({ type: 'run-ended', stopped: true, failed: true });
    expect(r.state).toMatchObject({ kind: 'stale', reason: 'run-stopped' });
  });

  it('holds arming while the mirror is being interacted with', () => {
    const env = makeEnv();
    env.interacted = true;
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready' });

    expect(r.state).toEqual({ kind: 'unprepared', reason: 'grace' });
    env.interacted = false;
    const cmds = r.handle({ type: 'grace-elapsed', timerId: 'readiness-0' });
    expect(sendPrepare(cmds)).toBeDefined();
  });

  it('interaction-hold uses the short hold timer', () => {
    const env = makeEnv();
    env.interacted = true;
    const r = new DeviceReadiness(0, env);
    const cmds = r.handle({ type: 'worker-ready' });
    expect(timer(cmds)?.ms).toBe(INTERACTION_HOLD_MS);
  });

  it('invalidation while ready goes stale, cancels an in-flight prepare, and re-arms after grace', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready', initialPolicy: CLEAR });

    const cmds = r.handle({ type: 'invalidate', reason: 'mcp-tool' });
    expect(r.state).toMatchObject({ kind: 'stale', reason: 'mcp-tool', previous: CLEAR });
    expect(types(cmds)).toEqual(['broadcast', 'start-timer']);

    r.handle({ type: 'grace-elapsed', timerId: 'readiness-0' });
    expect(r.state.kind).toBe('preparing');
    const id = (r.state as { prepareId: string }).prepareId;
    const inv = r.handle({ type: 'invalidate', reason: 'mirror-gesture' });
    expect(types(inv)).toEqual(['send-cancel-prepare', 'broadcast', 'start-timer']);
    expect((inv[0] as { prepareId: string }).prepareId).toBe(id);
  });

  it('ignores invalidation while running (the run owns the device)', () => {
    const r = new DeviceReadiness(0, makeEnv());
    r.handle({ type: 'worker-ready', initialPolicy: CLEAR });
    r.handle({ type: 'dispatch', file: '/t/a.test.ts', want: CLEAR });
    expect(r.handle({ type: 'invalidate', reason: 'mcp-tool' })).toEqual([]);
    expect(r.state.kind).toBe('running');
  });

  it('ignores a late prepared/prepare-failed for a superseded prepare id', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready' });
    const first = (r.state as { prepareId: string }).prepareId;
    r.handle({ type: 'invalidate', reason: 'manual' });
    r.handle({ type: 'grace-elapsed', timerId: 'readiness-0' });
    expect(r.state.kind).toBe('preparing');

    expect(r.handle({ type: 'prepared', prepareId: first, policy: CLEAR, startedAt: 0, durationMs: 1 })).toEqual([]);
    expect(r.handle({ type: 'prepare-failed', prepareId: first, message: 'x', cancelled: false })).toEqual([]);
    expect(r.state.kind).toBe('preparing');
  });

  it('a failed prepare backs off and stops retrying after the attempt cap', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready' });
    for (let attempt = 1; attempt <= MAX_PREPARE_ATTEMPTS; attempt++) {
      const id = (r.state as { prepareId: string }).prepareId;
      const cmds = r.handle({ type: 'prepare-failed', prepareId: id, message: 'boom', cancelled: false });
      expect(r.state).toMatchObject({ kind: 'error', attempts: attempt });
      if (attempt < MAX_PREPARE_ATTEMPTS) {
        expect(timer(cmds)).toBeDefined();
        r.handle({ type: 'grace-elapsed', timerId: 'readiness-0' });
        expect(r.state.kind).toBe('preparing');
      } else {
        expect(timer(cmds)).toBeUndefined();
      }
    }
    // A manual prepare-now still works after exhaustion.
    expect(sendPrepare(r.handle({ type: 'prepare-now' }))).toBeDefined();
  });

  it('a cancelled prepare ends unprepared without retry', () => {
    const r = new DeviceReadiness(0, makeEnv());
    r.handle({ type: 'worker-ready' });
    const id = (r.state as { prepareId: string }).prepareId;
    const cmds = r.handle({ type: 'prepare-failed', prepareId: id, message: 'aborted', cancelled: true });
    expect(r.state).toEqual({ kind: 'unprepared', reason: 'cancelled' });
    expect(timer(cmds)).toBeUndefined();
  });

  it('turning speculation off cancels a prepare but keeps a valid ready', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready' });
    env.speculation = false;
    const cmds = r.handle({ type: 'preferences-changed' });
    expect(types(cmds)).toEqual(['send-cancel-prepare', 'broadcast']);
    expect(r.state).toEqual({ kind: 'unprepared', reason: 'speculation-off' });

    const r2 = new DeviceReadiness(1, env);
    r2.handle({ type: 'worker-ready', initialPolicy: CLEAR });
    expect(r2.handle({ type: 'preferences-changed' })).toEqual([]);
    expect(r2.state.kind).toBe('ready');
    // …and prepare-now forces a prepare even with speculation off.
    r2.handle({ type: 'invalidate', reason: 'manual' });
    expect(sendPrepare(r2.handle({ type: 'prepare-now' }))).toBeDefined();
  });

  it('no candidate → unprepared(no-candidate); candidate-changed arms it', () => {
    const env = makeEnv({ candidate: null });
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready' });
    expect(r.state).toEqual({ kind: 'unprepared', reason: 'no-candidate' });
    env.candidate = { file: '/t/b.test.ts', policy: RESTART };
    expect(sendPrepare(r.handle({ type: 'candidate-changed' }))?.target).toEqual(RESTART);
  });

  it('candidate-changed keeps ready when satisfied', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready', initialPolicy: CLEAR });
    env.candidate = { file: '/t/b.test.ts', policy: RESTART };
    expect(r.handle({ type: 'candidate-changed' })).toEqual([]);
    expect(r.state.kind).toBe('ready');
  });

  it('retire / respawn / recycle', () => {
    const env = makeEnv();
    const r = new DeviceReadiness(0, env);
    r.handle({ type: 'worker-ready' });
    const cmds = r.handle({ type: 'worker-retired' });
    expect(types(cmds)).toEqual(['clear-timer', 'send-cancel-prepare', 'broadcast']);
    expect(r.state).toEqual({ kind: 'retired' });
    expect(r.handle({ type: 'run-ended', stopped: false })).toEqual([]);
    r.handle({ type: 'worker-respawning' });
    expect(r.state).toEqual({ kind: 'initializing' });
    r.handle({ type: 'worker-ready', initialPolicy: CLEAR });
    expect(r.handle({ type: 'worker-recycled' })).toEqual([]);
    expect(r.state.kind).toBe('ready');
  });
});

describe('mcpToolWorkers', () => {
  // Each invalidation drops the workers' prepared records (PILOT-1195), so an
  // MCP tool must invalidate the worker it touched, not every worker.
  const workers = [
    { id: 0, bucket: 'android', devices: [{ serial: 'emulator-5554', name: 'alice' }, { serial: 'emulator-5556', name: 'bob' }] },
    { id: 1, bucket: 'android', devices: [{ serial: 'emulator-5558', name: 'alice' }, { serial: 'emulator-5560', name: 'bob' }] },
    { id: 2, bucket: 'ios', devices: [{ serial: 'SIM-1' }] },
  ];
  const buckets = new Map([['android', 'android'], ['ios', 'ios']]);

  it('no device and no project: the session primary, the first live worker', () => {
    expect(mcpToolWorkers({ x: 1 }, workers, buckets)).toEqual([0]);
    expect(mcpToolWorkers(undefined, workers.slice(1), buckets)).toEqual([1]);
  });

  it('a serial picks the worker that holds it, primary or group member', () => {
    expect(mcpToolWorkers({ device: 'emulator-5558' }, workers, buckets)).toEqual([1]);
    expect(mcpToolWorkers({ device: 'emulator-5556' }, workers, buckets)).toEqual([0]);
    expect(mcpToolWorkers({ device: 'SIM-1', project: 'android' }, workers, buckets)).toEqual([2]);
  });

  it('a group name picks every worker with that member', () => {
    expect(mcpToolWorkers({ device: 'bob' }, workers, buckets)).toEqual([0, 1]);
  });

  it('a project picks its bucket\'s workers', () => {
    expect(mcpToolWorkers({ project: 'ios' }, workers, buckets)).toEqual([2]);
    expect(mcpToolWorkers({ project: 'android' }, workers, buckets)).toEqual([0, 1]);
  });

  it('a device or project it cannot place invalidates every worker', () => {
    expect(mcpToolWorkers({ device: 'gone' }, workers, buckets)).toBeUndefined();
    expect(mcpToolWorkers({ project: 'web' }, workers, buckets)).toBeUndefined();
    expect(mcpToolWorkers({}, [], buckets)).toBeUndefined();
  });
});
