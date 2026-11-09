import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TraceCollector } from '../trace/trace-collector.js';
import { tracedAction, captureBeforeState } from '../trace/traced-action.js';
import { TRACE_CAPTURE_TIMEOUT_MS } from '../trace/trace-collector.js';
import { runInAttemptContext } from '../attempt-fence.js';
import type { TraceConfig } from '../trace/types.js';
import type { ActionResponse } from '../grpc-client.js';

// Two devices acting at once (PILOT-310) each capture a before-screenshot and
// then emit their event. The collector hands every capture its own index up
// front and the emit passes it back; without that both captures wrote
// `action-005-before.png` and the second overwrote the first.

function makeConfig(overrides: Partial<TraceConfig> = {}): TraceConfig {
  return {
    mode: 'on', screenshots: true, snapshots: false, sources: false,
    attachments: false, network: false, deviceLogs: false, daemonLogs: false,
    ...overrides,
  };
}

const actionEvent = (action: string, deviceId?: string) => ({
  category: 'tap' as const, action, duration: 1, success: true,
  hasScreenshotBefore: true, hasScreenshotAfter: false, hasHierarchyBefore: false, hasHierarchyAfter: false,
  ...(deviceId ? { deviceId } : {}),
});

describe('TraceCollector action index reservation', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-reserve-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('keeps the classic sequential sequence: capture and emit share one index, the count advances by one', async () => {
    const c = new TraceCollector(makeConfig(), tempDir());
    for (let i = 0; i < 3; i++) {
      const { actionIndex } = await c.captureBeforeAction(async () => Buffer.from(`png-${i}`), async () => undefined);
      expect(actionIndex).toBe(i);
      c.addActionEvent(actionEvent('tap'), actionIndex);
      expect(c.currentActionIndex).toBe(i + 1);
    }
    expect(c.events.map((e) => e.actionIndex)).toEqual([0, 1, 2]);
    expect(c.screenshots.map((s) => s.archivePath)).toEqual([
      'screenshots/action-000-before.png', 'screenshots/action-001-before.png', 'screenshots/action-002-before.png',
    ]);
  });

  it('gives two concurrent captures distinct indices and keeps each screenshot with its own event', async () => {
    const c = new TraceCollector(makeConfig(), tempDir());
    // Both devices capture before either emits — the interleaving a
    // `Promise.all([alice.tap(), bob.tap()])` produces.
    const [alice, bob] = await Promise.all([
      c.captureBeforeAction(async () => Buffer.from('alice-png'), async () => undefined),
      c.captureBeforeAction(async () => Buffer.from('bob-png'), async () => undefined),
    ]);
    expect(alice.actionIndex).toBe(0);
    expect(bob.actionIndex).toBe(1);
    // Bob finishes first.
    c.addActionEvent(actionEvent('tap', 'bob'), bob.actionIndex);
    c.addActionEvent(actionEvent('tap', 'alice'), alice.actionIndex);

    const byDevice = new Map(c.events.map((e) => [(e as { deviceId?: string }).deviceId, e.actionIndex]));
    expect(byDevice.get('alice')).toBe(0);
    expect(byDevice.get('bob')).toBe(1);
    expect(c.currentActionIndex).toBe(2);
    const files = c.screenshots.map((s) => path.basename(s.diskPath)).sort();
    expect(files).toEqual(['action-000-before.png', 'action-001-before.png']);
    expect(fs.readFileSync(c.screenshots.find((s) => s.archivePath.includes('000'))!.diskPath, 'utf-8')).toBe('alice-png');
  });

  it('never hands an index-less emit an index another action reserved', async () => {
    const c = new TraceCollector(makeConfig(), tempDir());
    const alice = await c.captureBeforeAction(async () => Buffer.from('alice'), async () => undefined);
    // A host-side row (an app-reset summary, an API request) lands while
    // alice's action is still in flight.
    c.addActionEvent(actionEvent('appReset'));
    c.addActionEvent(actionEvent('tap', 'alice'), alice.actionIndex);
    expect(c.events.map((e) => [e.actionIndex, (e as { action: string }).action])).toEqual([
      [1, 'appReset'],
      [0, 'tap'],
    ]);
    expect(c.currentActionIndex).toBe(2);
    // The next action continues after everything that was handed out.
    const next = await c.captureBeforeAction(async () => undefined, async () => undefined);
    expect(next.actionIndex).toBe(2);
  });

  it('streams "started" rows at the index the action will complete on', async () => {
    const c = new TraceCollector(makeConfig(), tempDir());
    const seen: Array<{ index: number; lifecycle?: string }> = [];
    c.setEventCallback((event, _captures, lifecycle) => { seen.push({ index: event.actionIndex, lifecycle }); });
    const reserved = c._reserveActionIndex();
    c._emitActionStarted({ category: 'tap', action: 'tap', log: [], hasScreenshotBefore: false, hasHierarchyBefore: false }, reserved);
    // Another device completes an action meanwhile.
    c.addActionEvent(actionEvent('tap', 'bob'));
    c.addActionEvent(actionEvent('tap', 'alice'), reserved);
    expect(seen).toEqual([
      { index: 0, lifecycle: 'started' },
      { index: 1, lifecycle: 'completed' },
      { index: 0, lifecycle: 'completed' },
    ]);
  });

  it('reserves an index for an action that skips its before-capture, so concurrent group resets do not share one', async () => {
    const c = new TraceCollector(makeConfig(), tempDir());
    const seen: Array<{ index: number; device?: string; lifecycle?: string }> = [];
    c.setEventCallback((event, _captures, lifecycle) => {
      seen.push({ index: event.actionIndex, device: event.deviceId, lifecycle });
    });
    const ok = { success: true } as ActionResponse;
    const ctx = (deviceId: string) => ({
      collector: c, deviceId,
      takeScreenshot: async () => undefined,
      captureHierarchy: async () => undefined,
    });
    // The runner's fixture reset: every device of the group resets at once
    // and none of them captures a before-screenshot.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = (deviceId: string) => tracedAction(
      ctx(deviceId), 'resetApp', 'device', undefined,
      async () => { await gate; return ok; }, 'App reset failed', { skipBeforeCapture: true },
    );
    const both = Promise.all([run('alice'), run('bob')]);
    await Promise.resolve();
    release();
    await both;
    const started = seen.filter((e) => e.lifecycle === 'started');
    const completed = seen.filter((e) => e.lifecycle === 'completed');
    expect(started.map((e) => e.index)).toEqual([0, 1]);
    for (const s of started) {
      expect(completed.find((e) => e.device === s.device)?.index).toBe(s.index);
    }
    expect(c.currentActionIndex).toBe(2);
  });

  it('reserves an index even when a batch capture spends the whole budget and nothing is captured', async () => {
    const c = new TraceCollector(makeConfig(), tempDir());
    const realNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(realNow);
    try {
      const before = await captureBeforeState({
        collector: c,
        takeScreenshot: async () => undefined,
        captureHierarchy: async () => undefined,
        // An iOS batch capture that fails only after the capture budget ran out.
        captureTraceState: async () => {
          now.mockReturnValue(realNow + TRACE_CAPTURE_TIMEOUT_MS + 1);
          return { success: false, errorMessage: 'timed out' } as never;
        },
      }, undefined, []);
      expect(before.captures).toEqual({});
      expect(before.actionIndex).toBe(0);
      // Another device's action meanwhile must not take the in-flight row's index.
      expect(c._reserveActionIndex()).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  it('honours setActionIndexOffset for reservations too', async () => {
    const c = new TraceCollector(makeConfig(), tempDir());
    c.setActionIndexOffset(7);
    const { actionIndex } = await c.captureBeforeAction(async () => undefined, async () => undefined);
    expect(actionIndex).toBe(7);
    c.addActionEvent(actionEvent('tap'), actionIndex);
    expect(c.currentActionIndex).toBe(8);
  });

  it('spends the index of an action fenced mid-flight, so terminal frames land where the viewer looks', async () => {
    const c = new TraceCollector(makeConfig(), tempDir());
    const first = await c.captureBeforeAction(async () => undefined, async () => undefined);
    c.addActionEvent(actionEvent('tap'), first.actionIndex);

    // A test times out while its second tap is between capture and emit; the
    // runner closes the attempt token and the emit is fenced.
    const token = { closed: false };
    await runInAttemptContext(token, async () => {
      const inFlight = await c.captureBeforeAction(async () => Buffer.from('zombie'), async () => undefined);
      token.closed = true;
      c.addActionEvent(actionEvent('tap'), inFlight.actionIndex);
      // A stray call issued after the fence closed reserves too.
      const stray = await c.captureBeforeAction(async () => undefined, async () => undefined);
      c.addAssertionEvent({ assertion: 'toBeVisible', passed: true, soft: false, negated: false, duration: 1, attempts: 1 }, stray.actionIndex);
    });
    expect(c.events.filter((e) => e.type !== 'console')).toHaveLength(1);

    // `actionCount` (currentActionIndex) is what the terminal screenshots are
    // reserved from, and what the viewer adds the device ordinal to.
    const terminal = await c.captureBeforeAction(async () => Buffer.from('end'), async () => undefined);
    expect(terminal.actionIndex).toBe(c.currentActionIndex);
  });

  it('tags device and daemon log lines with the device that produced them', () => {
    const c = new TraceCollector(makeConfig(), tempDir());
    c.addLogcatEntry('info', 'hello', 'bob');
    c.addDaemonLogEntry('warn', 'slow', undefined);
    expect(c.events).toMatchObject([
      { type: 'console', source: 'device', deviceId: 'bob' },
      { type: 'console', source: 'daemon' },
    ]);
    expect((c.events[1] as { deviceId?: string }).deviceId).toBeUndefined();
  });
});
