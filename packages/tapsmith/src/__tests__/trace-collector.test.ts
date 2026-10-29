import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TraceCollector, extractSourceLocation, extractStack, collectReferencedFiles, userStackFrames, isFrameworkFrame } from '../trace/trace-collector.js';
import type { TraceConfig, ActionTraceEvent, AssertionTraceEvent, ConsoleTraceEvent, GroupTraceEvent, AnyTraceEvent } from '../trace/types.js';

describe('TraceCollector', () => {
  let tempDir: string;
  let config: TraceConfig;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-test-'));
    config = {
      mode: 'on',
      screenshots: true,
      snapshots: true,
      sources: true,
      attachments: true, network: false, deviceLogs: false, daemonLogs: false,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts with zero events and action index', () => {
    const collector = new TraceCollector(config, tempDir);
    expect(collector.events).toHaveLength(0);
    expect(collector.currentActionIndex).toBe(0);
  });

  it('records action events with incrementing index', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.addActionEvent({
      category: 'tap',
      action: 'tap',
      duration: 42,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });
    collector.addActionEvent({
      category: 'type',
      action: 'type',
      inputValue: 'hello',
      duration: 100,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });

    expect(collector.events).toHaveLength(2);
    expect(collector.currentActionIndex).toBe(2);

    const ev0 = collector.events[0] as ActionTraceEvent;
    expect(ev0.type).toBe('action');
    expect(ev0.actionIndex).toBe(0);
    expect(ev0.action).toBe('tap');

    const ev1 = collector.events[1] as ActionTraceEvent;
    expect(ev1.actionIndex).toBe(1);
    expect(ev1.action).toBe('type');
    expect(ev1.inputValue).toBe('hello');
  });

  it('records assertion events', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.addAssertionEvent({
      assertion: 'toBeVisible',
      selector: '{"text":"OK"}',
      passed: true,
      soft: false,
      negated: false,
      duration: 50,
      attempts: 1,
    });

    expect(collector.events).toHaveLength(1);
    const ev = collector.events[0];
    expect(ev.type).toBe('assertion');
  });

  it('records wall durations that include time since the previous action', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const collector = new TraceCollector(config, tempDir, 1000);

    vi.setSystemTime(1100);
    collector.addActionEvent({
      category: 'tap',
      action: 'tap',
      duration: 40,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });

    vi.setSystemTime(1300);
    collector.addAssertionEvent({
      assertion: 'toBeVisible',
      passed: true,
      soft: false,
      negated: false,
      duration: 25,
      attempts: 1,
    });

    const first = collector.events[0] as ActionTraceEvent;
    expect(first.duration).toBe(40);
    expect(first.wallDuration).toBe(100);
    expect(first.gapBefore).toBe(60);
    expect(first.startTime).toBe(1060);
    expect(first.endTime).toBe(1100);

    const second = collector.events[1] as AssertionTraceEvent;
    expect(second.duration).toBe(25);
    expect(second.wallDuration).toBe(200);
    expect(second.gapBefore).toBe(175);
    expect(second.startTime).toBe(1275);
    expect(second.endTime).toBe(1300);
  });

  it('allocates trailing trace time to the final action without changing action duration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const collector = new TraceCollector(config, tempDir, 2000);

    vi.setSystemTime(2100);
    collector.addActionEvent({
      category: 'tap',
      action: 'tap',
      duration: 50,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });
    collector.finalizeTimeline(2250);

    const event = collector.events[0] as ActionTraceEvent;
    expect(event.duration).toBe(50);
    expect(event.wallDuration).toBe(250);
    expect(event.trailingTime).toBe(150);
  });

  it('drops empty groups silently', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.startGroup('Login flow');
    collector.endGroup();

    // Empty groups are dropped — group-start is deferred until a child
    // event arrives, and endGroup discards it if nothing flushed.
    expect(collector.events).toHaveLength(0);
  });

  it('records group start/end events when the group has children', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.startGroup('Login flow');
    collector.addActionEvent({
      category: 'device',
      action: 'tap',
      duration: 10,
      success: true,
      log: [],
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });
    collector.endGroup();

    expect(collector.events).toHaveLength(3);
    const start = collector.events[0] as GroupTraceEvent;
    expect(start.type).toBe('group-start');
    expect(start.name).toBe('Login flow');
    expect(collector.events[1].type).toBe('action');
    const end = collector.events[2] as GroupTraceEvent;
    expect(end.type).toBe('group-end');
    expect(end.name).toBe('Login flow');
  });

  it('records error events', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.addError('Something went wrong', 'Error: Something went wrong\n  at test.ts:5');

    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].type).toBe('error');
  });

  it('does not block indefinitely on hung screenshot or hierarchy captures', async () => {
    vi.useFakeTimers();
    const collector = new TraceCollector(config, tempDir);

    const capture = collector.captureBeforeAction(
      () => new Promise<Buffer>(() => {}),
      () => new Promise<string>(() => {}),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(capture).resolves.toEqual({
      actionIndex: 0,
      captures: {},
    });
  });

  it('records logcat entries', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.addLogcatEntry('info', 'App launched');

    expect(collector.events).toHaveLength(1);
    const ev = collector.events[0] as ConsoleTraceEvent;
    expect(ev.type).toBe('console');
    expect(ev.source).toBe('device');
    expect(ev.level).toBe('info');
    expect(ev.message).toBe('App launched');
  });

  it('records daemon log entries as console events with source "daemon"', () => {
    const collector = new TraceCollector(
      {
        mode: 'on',
        screenshots: false,
        snapshots: false,
        sources: false,
        attachments: true,
        network: false,
        deviceLogs: false,
        daemonLogs: true,
      },
      tempDir,
    );
    collector.addDaemonLogEntry('info', 'spawned adb shell input tap');
    const events = collector.events.filter((e) => e.type === 'console');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'console',
      level: 'info',
      source: 'daemon',
      message: 'spawned adb shell input tap',
    });
  });

  it('produces valid NDJSON output', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.addActionEvent({
      category: 'tap',
      action: 'tap',
      duration: 10,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });
    collector.addActionEvent({
      category: 'type',
      action: 'type',
      duration: 20,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });

    const ndjson = collector.toNDJSON();
    const lines = ndjson.trim().split('\n');
    expect(lines).toHaveLength(2);

    // Each line should be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  // ── Pending operation (timeout detection) ──

  it('failPendingOperation emits a failed action event for in-flight action', () => {
    const collector = new TraceCollector(config, tempDir);

    collector.setPendingOperation((error) => {
      collector.addActionEvent({
        category: 'tap',
        action: 'tap',
        selector: '{"text":"Submit"}',
        duration: 5000,
        success: false,
        error,
        hasScreenshotBefore: true,
        hasScreenshotAfter: false,
        hasHierarchyBefore: false,
        hasHierarchyAfter: false,
      });
    });

    collector.failPendingOperation('Test timed out after 10000ms');

    expect(collector.events).toHaveLength(1);
    const ev = collector.events[0] as ActionTraceEvent;
    expect(ev.type).toBe('action');
    expect(ev.action).toBe('tap');
    expect(ev.success).toBe(false);
    expect(ev.error).toBe('Test timed out after 10000ms');
    expect(ev.hasScreenshotBefore).toBe(true);
    expect(ev.hasScreenshotAfter).toBe(false);
  });

  it('failPendingOperation emits a failed assertion event for in-flight assertion', () => {
    const collector = new TraceCollector(config, tempDir);

    collector.setPendingOperation((error) => {
      collector.addAssertionEvent({
        assertion: 'toBeVisible',
        selector: '{"text":"OK"}',
        passed: false,
        soft: false,
        negated: false,
        duration: 5000,
        attempts: 20,
        error,
      });
    });

    collector.failPendingOperation('Test timed out after 10000ms');

    expect(collector.events).toHaveLength(1);
    const ev = collector.events[0] as AssertionTraceEvent;
    expect(ev.type).toBe('assertion');
    expect(ev.assertion).toBe('toBeVisible');
    expect(ev.passed).toBe(false);
    expect(ev.error).toBe('Test timed out after 10000ms');
  });

  // ── Lifecycle started signals (PILOT-200) ──

  it('_emitActionStarted fires the callback with lifecycle=started without recording', () => {
    const collector = new TraceCollector(config, tempDir);
    const seen: Array<{ event: ActionTraceEvent | AssertionTraceEvent | ConsoleTraceEvent | GroupTraceEvent; lifecycle?: 'started' | 'completed' }> = [];
    collector.setEventCallback((event, _captures, lifecycle) => {
      seen.push({ event: event as ActionTraceEvent, lifecycle });
    });

    collector._emitActionStarted({
      category: 'tap',
      action: 'tap',
      selector: '{"text":"Submit"}',
      hasScreenshotBefore: true,
      hasHierarchyBefore: false,
    });

    expect(collector.events).toHaveLength(0);
    expect(collector.currentActionIndex).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].lifecycle).toBe('started');
    const ev = seen[0].event as ActionTraceEvent;
    expect(ev.type).toBe('action');
    expect(ev.action).toBe('tap');
    expect(ev.actionIndex).toBe(0);
    expect(ev.success).toBe(true);
    expect(ev.duration).toBe(0);
  });

  it('started + completed action share the same actionIndex', () => {
    const collector = new TraceCollector(config, tempDir);
    const seen: Array<{ actionIndex: number; lifecycle?: 'started' | 'completed' }> = [];
    collector.setEventCallback((event, _captures, lifecycle) => {
      if (event.type === 'action' || event.type === 'assertion') {
        seen.push({ actionIndex: event.actionIndex, lifecycle });
      }
    });

    collector._emitActionStarted({
      category: 'tap', action: 'tap',
      hasScreenshotBefore: false, hasHierarchyBefore: false,
    });
    collector.addActionEvent({
      category: 'tap', action: 'tap', duration: 42, success: true,
      hasScreenshotBefore: false, hasScreenshotAfter: false,
      hasHierarchyBefore: false, hasHierarchyAfter: false,
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ actionIndex: 0, lifecycle: 'started' });
    expect(seen[1]).toEqual({ actionIndex: 0, lifecycle: 'completed' });
    expect(collector.currentActionIndex).toBe(1);
    expect(collector.events).toHaveLength(1);
  });

  it('_emitAssertionStarted fires the callback with lifecycle=started for assertions', () => {
    const collector = new TraceCollector(config, tempDir);
    const seen: Array<{ event: ActionTraceEvent | AssertionTraceEvent; lifecycle?: 'started' | 'completed' }> = [];
    collector.setEventCallback((event, _captures, lifecycle) => {
      if (event.type === 'action' || event.type === 'assertion') {
        seen.push({ event: event as AssertionTraceEvent, lifecycle });
      }
    });

    collector._emitAssertionStarted({
      assertion: 'toBeVisible',
      selector: '{"text":"OK"}',
      soft: false,
      negated: false,
      hasScreenshotBefore: true,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });

    expect(collector.events).toHaveLength(0);
    expect(collector.currentActionIndex).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].lifecycle).toBe('started');
    const ev = seen[0].event as AssertionTraceEvent;
    expect(ev.type).toBe('assertion');
    expect(ev.assertion).toBe('toBeVisible');
    expect(ev.passed).toBe(true);
    expect(ev.duration).toBe(0);
  });

  it('started signal is a no-op when no event callback is set', () => {
    const collector = new TraceCollector(config, tempDir);
    // No setEventCallback call.
    collector._emitActionStarted({
      category: 'tap', action: 'tap',
      hasScreenshotBefore: false, hasHierarchyBefore: false,
    });
    expect(collector.events).toHaveLength(0);
    expect(collector.currentActionIndex).toBe(0);
  });

  it('completed events pass lifecycle=completed to the callback', () => {
    const collector = new TraceCollector(config, tempDir);
    let seenLifecycle: 'started' | 'completed' | undefined;
    collector.setEventCallback((_event, _captures, lifecycle) => {
      seenLifecycle = lifecycle;
    });
    collector.addActionEvent({
      category: 'tap', action: 'tap', duration: 1, success: true,
      hasScreenshotBefore: false, hasScreenshotAfter: false,
      hasHierarchyBefore: false, hasHierarchyAfter: false,
    });
    expect(seenLifecycle).toBe('completed');
  });

  it('failPendingOperation is a no-op when no pending operation', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.failPendingOperation('Test timed out');
    expect(collector.events).toHaveLength(0);
  });

  it('clearPendingOperation prevents subsequent failPendingOperation from firing', () => {
    const collector = new TraceCollector(config, tempDir);

    collector.setPendingOperation(() => {
      collector.addActionEvent({
        category: 'tap', action: 'tap', duration: 0, success: false,
        error: 'timeout', hasScreenshotBefore: false, hasScreenshotAfter: false,
        hasHierarchyBefore: false, hasHierarchyAfter: false,
      });
    });

    collector.clearPendingOperation();
    collector.failPendingOperation('timeout');
    expect(collector.events).toHaveLength(0);
  });

  it('pendingOperationStack exposes the in-flight operation frames and clears with the registration', () => {
    const collector = new TraceCollector(config, tempDir);
    const stack = [
      { file: '/repo/e2e/login.test.ts', line: 110, column: 35 },
      { file: '/repo/e2e/helpers.ts', line: 12, column: 3 },
    ];

    expect(collector.pendingOperationStack).toBeNull();

    collector.setPendingOperation(() => {}, stack);
    expect(collector.pendingOperationStack).toEqual(stack);

    collector.clearPendingOperation();
    expect(collector.pendingOperationStack).toBeNull();

    collector.setPendingOperation(() => {}, stack);
    collector.failPendingOperation('timeout');
    expect(collector.pendingOperationStack).toBeNull();
  });

  it('failPendingOperation only fires once (idempotent)', () => {
    const collector = new TraceCollector(config, tempDir);

    collector.setPendingOperation((error) => {
      collector.addActionEvent({
        category: 'tap', action: 'tap', duration: 0, success: false,
        error, hasScreenshotBefore: false, hasScreenshotAfter: false,
        hasHierarchyBefore: false, hasHierarchyAfter: false,
      });
    });

    collector.failPendingOperation('first timeout');
    collector.failPendingOperation('second timeout');

    expect(collector.events).toHaveLength(1);
    expect((collector.events[0] as ActionTraceEvent).error).toBe('first timeout');
  });

  it('intercepts and records console output', () => {
    const collector = new TraceCollector(config, tempDir);
    const originalLog = console.log;

    collector.startConsoleCapture();
    // console.log is now intercepted — it still calls the original but also records
    console.log('test message');
    collector.stopConsoleCapture();

    // console should be restored
    expect(console.log).toBe(originalLog);

    // Check that the console output was recorded
    const consoleEvents = collector.events.filter(
      (e) => e.type === 'console',
    ) as ConsoleTraceEvent[];
    expect(consoleEvents).toHaveLength(1);
    expect(consoleEvents[0].message).toBe('test message');
    expect(consoleEvents[0].source).toBe('test');
    expect(consoleEvents[0].level).toBe('log');
  });
});

describe('extractStack', () => {
  it('returns all user-code frames in order, top first', () => {
    const stack = [
      'Error',
      '    at Object.tap (/proj/node_modules/tapsmith/dist/element-handle.js:10:5)',
      '    at loginHelper (/proj/tests/helpers/login.ts:8:3)',
      '    at /proj/tests/auth.test.ts:42:7',
    ].join('\n');
    const frames = extractStack(stack);
    expect(frames).toEqual([
      { file: '/proj/tests/helpers/login.ts', line: 8, column: 3 },
      { file: '/proj/tests/auth.test.ts', line: 42, column: 7 },
    ]);
  });

  it('filters SDK, node_modules, and node internal frames', () => {
    const stack = [
      'Error',
      '    at /proj/packages/tapsmith/src/device.ts:700:1',
      '    at node:internal/process/task_queues:95:5',
      '    at internal/main/run_main_module:23:47',
      '    at /proj/tests/x.test.ts:3:1',
    ].join('\n');
    expect(extractStack(stack)).toEqual([{ file: '/proj/tests/x.test.ts', line: 3, column: 1 }]);
  });

  it('extractSourceLocation returns the first frame from extractStack', () => {
    const stack = 'Error\n    at /proj/a.ts:1:2\n    at /proj/b.ts:3:4';
    expect(extractSourceLocation(stack)).toEqual(extractStack(stack)[0]);
  });

  it('returns [] for an empty stack', () => {
    expect(extractStack('')).toEqual([]);
  });

  it('normalizes Windows backslash paths to forward slashes', () => {
    const stack = 'Error\n    at loginHelper (C:\\proj\\tests\\helpers\\login.ts:8:3)';
    expect(extractStack(stack)).toEqual([{ file: 'C:/proj/tests/helpers/login.ts', line: 8, column: 3 }]);
  });

  it('normalizes file:// URLs (ESM runner loads tests via import(file://))', () => {
    const stack = 'Error\n    at Object.<anonymous> (file:///Users/me/proj/tests/login.test.ts:12:7)';
    expect(extractStack(stack)).toEqual([{ file: '/Users/me/proj/tests/login.test.ts', line: 12, column: 7 }]);
  });

  it('decodes percent-encoded characters in file:// URLs', () => {
    const stack = 'Error\n    at Object.<anonymous> (file:///Users/me/my%20proj/tests/a.test.ts:1:1)';
    expect(extractStack(stack)).toEqual([{ file: '/Users/me/my proj/tests/a.test.ts', line: 1, column: 1 }]);
  });

  it('strips ?query and #fragment from file:// URLs (loader cache-busting)', () => {
    const stack = 'Error\n    at Object.<anonymous> (file:///Users/me/proj/tests/a.test.ts?t=1700000000000:4:9)';
    expect(extractStack(stack)).toEqual([{ file: '/Users/me/proj/tests/a.test.ts', line: 4, column: 9 }]);
  });
});

describe('userStackFrames (PILOT-841)', () => {
  // The frames an npm install really produced for a failed toBeVisible: the
  // SDK's own frames are source-mapped to node_modules/tapsmith/src/*.ts, the
  // runner's stay node_modules/tapsmith/dist/*.js.
  const npmAssertion = [
    '    at fail (/proj/node_modules/tapsmith/src/expect.ts:548:17)',
    '    at Object.toBeVisible (/proj/node_modules/tapsmith/src/expect.ts:632:9)',
    '    at async Object.toBeVisible (/proj/node_modules/tapsmith/src/expect.ts:475:7)',
    '    at async Object.fn (/proj/tests/tabs.tapsmith.ts:6:5)',
    '    at async testFn (/proj/node_modules/tapsmith/dist/runner.js:2167:33)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)',
  ];

  it('drops Tapsmith-internal and node-internal frames from an npm install', () => {
    expect(userStackFrames(npmAssertion)).toEqual(['    at async Object.fn (/proj/tests/tabs.tapsmith.ts:6:5)']);
  });

  it('drops the monorepo SDK (packages/tapsmith/src|dist) and pnpm layouts', () => {
    expect(userStackFrames([
      '    at ElementHandle.tap (/repo/packages/tapsmith/src/element-handle.ts:1884:15)',
      '    at testFn (/repo/packages/tapsmith/dist/runner.js:10:1)',
      '    at x (/proj/node_modules/.pnpm/tapsmith@0.7.1/node_modules/tapsmith/dist/expect.js:331:9)',
      '    at internal/main/run_main_module:23:47',
      '    at /proj/tests/x.test.ts:3:1',
    ])).toEqual(['    at /proj/tests/x.test.ts:3:1']);
  });

  it('keeps every user frame in order, and third-party node_modules frames (as Playwright does)', () => {
    expect(userStackFrames([
      '    at Object.tap (/proj/node_modules/tapsmith/dist/element-handle.js:10:5)',
      '    at retry (/proj/node_modules/p-retry/index.js:4:2)',
      '    at loginHelper (/proj/tests/helpers/login.ts:8:3)',
      '    at /proj/tests/auth.test.ts:42:7',
    ])).toEqual([
      '    at retry (/proj/node_modules/p-retry/index.js:4:2)',
      '    at loginHelper (/proj/tests/helpers/login.ts:8:3)',
      '    at /proj/tests/auth.test.ts:42:7',
    ]);
  });

  it('keeps a user project whose own path is named tapsmith', () => {
    const frame = '    at async Object.fn (/Users/me/tapsmith/tests/a.test.ts:1:1)';
    expect(userStackFrames([frame])).toEqual([frame]);
  });

  it('classifies file:// URL and Windows frames like plain paths', () => {
    expect(userStackFrames([
      '    at fail (file:///proj/node_modules/tapsmith/dist/expect.js:5:5)',
      '    at fail (C:\\proj\\node_modules\\tapsmith\\dist\\expect.js:5:5)',
      '    at Object.fn (file:///proj/tests/a.test.ts?t=1:4:9)',
    ])).toEqual(['    at Object.fn (file:///proj/tests/a.test.ts?t=1:4:9)']);
  });

  it('drops frames with no file location (new Promise (<anonymous>))', () => {
    expect(userStackFrames([
      '    at new Promise (<anonymous>)',
      '    at /proj/tests/a.test.ts:1:1',
    ])).toEqual(['    at /proj/tests/a.test.ts:1:1']);
  });

  it('keeps lines that are not frames (a "Caused by:" line)', () => {
    expect(userStackFrames([
      '    at /proj/tests/a.test.ts:1:1',
      'Caused by: Error: boom',
      '    at /proj/node_modules/tapsmith/dist/config.js:1:1',
    ])).toEqual(['    at /proj/tests/a.test.ts:1:1', 'Caused by: Error: boom']);
  });

  it('falls back to the raw frames when no user frame is left (a runner timeout)', () => {
    const raw = [
      '    at Timeout.check (/proj/node_modules/tapsmith/dist/runner.js:1701:115)',
      '    at listOnTimeout (node:internal/timers:585:17)',
    ];
    expect(userStackFrames(raw)).toEqual(raw);
  });

  it('returns [] for no lines', () => {
    expect(userStackFrames([])).toEqual([]);
  });

  it('isFrameworkFrame classifies one line the same way (expect() moves the others to the top)', () => {
    expect(isFrameworkFrame(npmAssertion[0])).toBe(true);
    expect(isFrameworkFrame(npmAssertion[4])).toBe(true);
    expect(isFrameworkFrame(npmAssertion[5])).toBe(true);
    expect(isFrameworkFrame('    at fail (/repo/packages/tapsmith/src/expect.ts:1:1)')).toBe(true);
    expect(isFrameworkFrame(npmAssertion[3])).toBe(false);
    expect(isFrameworkFrame('    at retry (/proj/node_modules/p-retry/index.js:4:2)')).toBe(false);
    expect(isFrameworkFrame('    at new Promise (<anonymous>)')).toBe(false);
  });
});

describe('addActionEvent preserves stack', () => {
  it('keeps the stack array on the emitted event', () => {
    const c = new TraceCollector(
      { mode: 'on', screenshots: false, snapshots: false, sources: true, attachments: true, network: false, deviceLogs: false, daemonLogs: false },
      '/tmp/ts-test-' + process.pid,
    );
    c.addActionEvent({
      category: 'tap', action: 'tap', duration: 1, success: true,
      hasScreenshotBefore: false, hasScreenshotAfter: false,
      hasHierarchyBefore: false, hasHierarchyAfter: false,
      sourceLocation: { file: '/p/a.ts', line: 1 },
      stack: [{ file: '/p/a.ts', line: 1 }, { file: '/p/b.ts', line: 2 }],
    });
    const ev = c.events.find((e) => e.type === 'action') as ActionTraceEvent;
    expect(ev.stack).toEqual([{ file: '/p/a.ts', line: 1 }, { file: '/p/b.ts', line: 2 }]);
  });
});

describe('extractSourceLocation', () => {
  it('extracts file, line, column from a stack trace', () => {
    const stack = `Error: test
    at Object.<anonymous> (/Users/test/project/e2e/login.test.ts:15:3)
    at Module._compile (internal/modules/cjs/loader.js:1068:30)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toEqual({
      file: '/Users/test/project/e2e/login.test.ts',
      line: 15,
      column: 3,
    });
  });

  it('skips internal tapsmith frames', () => {
    const stack = `Error: test
    at Device.tap (/Users/test/node_modules/tapsmith/src/device.ts:50:10)
    at Object.<anonymous> (/Users/test/project/tests/app.test.ts:20:5)
    at Module._compile (internal/modules/cjs/loader.js:1068:30)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toEqual({
      file: '/Users/test/project/tests/app.test.ts',
      line: 20,
      column: 5,
    });
  });

  it('returns undefined for stack with only internal frames', () => {
    const stack = `Error: test
    at Device.tap (/Users/test/node_modules/tapsmith/src/device.ts:50:10)
    at someInternalFn (node:internal/process:123:4)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toBeUndefined();
  });
});

describe('collectReferencedFiles', () => {
  it('returns the unique set of files across action and assertion stacks', () => {
    const events = [
      { type: 'action', stack: [{ file: '/p/a.ts', line: 1 }, { file: '/p/h.ts', line: 2 }] },
      { type: 'assertion', stack: [{ file: '/p/h.ts', line: 9 }] },
      { type: 'console' },
      { type: 'action' },
    ] as unknown as AnyTraceEvent[];
    expect(collectReferencedFiles(events).sort()).toEqual(['/p/a.ts', '/p/h.ts']);
  });
});

describe('ingestReplayedEvent', () => {
  let tempDir: string;
  let config: TraceConfig;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-test-'));
    config = {
      mode: 'on',
      screenshots: true,
      snapshots: true,
      sources: true,
      attachments: true, network: false, deviceLogs: false, daemonLogs: false,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeActionEvent(actionIndex: number): AnyTraceEvent {
    return {
      type: 'action',
      actionIndex,
      timestamp: 1000 + actionIndex,
      category: 'device',
      action: 'openDeepLink',
      duration: 42,
      success: true,
      log: [],
      hasScreenshotBefore: true,
      hasScreenshotAfter: false,
      hasHierarchyBefore: true,
      hasHierarchyAfter: false,
    } as unknown as AnyTraceEvent;
  }

  it('records the event without touching the action index or event callback', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.setActionIndexOffset(3);
    const streamed: AnyTraceEvent[] = [];
    collector.setEventCallback((event) => { streamed.push(event); });

    collector.ingestReplayedEvent(makeActionEvent(0));

    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].actionIndex).toBe(0);
    expect(collector.currentActionIndex).toBe(3);
    // Streaming replayed events is the caller's decision, not the ingest path's.
    expect(streamed).toHaveLength(0);
  });

  it('registers screenshot and hierarchy captures for packaging', () => {
    const collector = new TraceCollector(config, tempDir);
    const shotPath = path.join(tempDir, 'ba-action-000-before.png');
    fs.writeFileSync(shotPath, Buffer.from('png-bytes'));

    collector.ingestReplayedEvent(makeActionEvent(0), {
      screenshotBefore: shotPath,
      hierarchyBefore: '<hierarchy/>',
    });

    // `external` marks the file as owned by the hook collector so packaging
    // this collector doesn't delete it out from under later tests' replays.
    expect(collector.screenshots).toEqual([
      { archivePath: 'screenshots/action-000-before.png', diskPath: shotPath, external: true },
    ]);
    expect(collector.hierarchies).toContainEqual(
      { archivePath: 'hierarchy/action-000-before.xml', xml: '<hierarchy/>' },
    );
  });

  it('stores a copy so timeline mutation in one collector cannot corrupt the shared saved event', () => {
    const collector = new TraceCollector(config, tempDir);
    const original = makeActionEvent(0);

    collector.ingestReplayedEvent(original);

    expect(collector.events[0]).not.toBe(original);
    expect(collector.events[0]).toEqual(original);
    (collector.events[0] as { duration?: number }).duration = 999;
    expect((original as { duration?: number }).duration).toBe(42);
  });

  it('records group events verbatim without capture registration', () => {
    const collector = new TraceCollector(config, tempDir);
    const group = {
      type: 'group-start', name: 'beforeAll Hooks', actionIndex: 0, timestamp: 1000,
    } as unknown as AnyTraceEvent;

    collector.ingestReplayedEvent(group);

    expect(collector.events).toEqual([group]);
    expect(collector.screenshots).toHaveLength(0);
    expect(collector.hierarchies).toHaveLength(0);
  });
});
