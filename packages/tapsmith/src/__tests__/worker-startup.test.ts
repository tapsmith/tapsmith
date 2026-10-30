import { describe, it, expect } from 'vitest';
import { WorkerStartupGate } from '../ui-mode/worker-startup.js';

function gate(starting: boolean) {
  const changes: boolean[] = [];
  const g = new WorkerStartupGate(starting, (waiting) => changes.push(waiting));
  return { g, changes };
}

describe('WorkerStartupGate', () => {
  it('lets a run through at once when no startup is in progress', async () => {
    const { g, changes } = gate(false);
    expect(g.starting).toBe(false);
    await expect(g.wait()).resolves.toEqual({ outcome: 'ready', waited: false });
    expect(changes).toEqual([]);
  });

  it('holds a run requested during startup until startup ends', async () => {
    const { g, changes } = gate(true);
    let settled: unknown;
    const pending = g.wait().then((r) => { settled = r; return r; });
    await Promise.resolve();
    expect(settled).toBeUndefined();
    expect(g.waiting).toBe(true);
    expect(changes).toEqual([true]);

    g.finish();
    await expect(pending).resolves.toEqual({ outcome: 'ready', waited: true });
    expect(g.starting).toBe(false);
    expect(g.waiting).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('turns away a second run while one is already waiting', async () => {
    const { g, changes } = gate(true);
    const first = g.wait();
    await expect(g.wait()).resolves.toEqual({ outcome: 'busy', waited: false });
    expect(changes).toEqual([true]);
    g.finish();
    await expect(first).resolves.toEqual({ outcome: 'ready', waited: true });
  });

  it('ends a waiting run as stopped on cancel, and startup carries on', async () => {
    const { g, changes } = gate(true);
    const pending = g.wait();
    expect(g.cancel()).toBe(true);
    await expect(pending).resolves.toEqual({ outcome: 'stopped', waited: true });
    expect(g.starting).toBe(true);
    expect(changes).toEqual([true, false]);

    // A later run waits afresh, and startup ending releases it.
    const again = g.wait();
    g.finish();
    await expect(again).resolves.toEqual({ outcome: 'ready', waited: true });
  });

  it('reports nothing to cancel when no run is waiting', () => {
    const { g, changes } = gate(true);
    expect(g.cancel()).toBe(false);
    g.finish();
    expect(g.cancel()).toBe(false);
    expect(changes).toEqual([]);
  });

  it('is idempotent on finish', async () => {
    const { g, changes } = gate(true);
    const pending = g.wait();
    g.finish();
    g.finish();
    await expect(pending).resolves.toEqual({ outcome: 'ready', waited: true });
    expect(changes).toEqual([true, false]);
  });

  it('keeps a released run pending until it proceeds, and lets Stop end it then', async () => {
    const { g } = gate(true);
    const pending = g.wait();
    g.finish();
    await expect(pending).resolves.toEqual({ outcome: 'ready', waited: true });
    // Released, but not started yet (the workers are still being prepared).
    expect(g.waiting).toBe(false);
    expect(g.pending).toBe(true);
    expect(g.cancel()).toBe(true);
    expect(g.pending).toBe(false);
    expect(g.proceed()).toBe(false);
    // Nothing left to stop or to proceed with.
    expect(g.cancel()).toBe(false);
    expect(g.proceed()).toBe(true);
  });

  it('lets a released run proceed when nobody stopped it', async () => {
    const { g } = gate(true);
    const pending = g.wait();
    g.finish();
    await pending;
    expect(g.proceed()).toBe(true);
    expect(g.pending).toBe(false);
    // Once it has started, Stop is the running run's business.
    expect(g.cancel()).toBe(false);
  });

  it('never holds a run that did not wait as pending', async () => {
    const { g } = gate(false);
    await g.wait();
    expect(g.pending).toBe(false);
    expect(g.cancel()).toBe(false);
  });
});
