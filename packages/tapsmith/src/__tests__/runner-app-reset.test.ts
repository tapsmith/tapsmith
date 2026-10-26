import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import {
  test as tapsmithTest,
  describe as tapsmithDescribe,
  beforeAll as tapsmithBeforeAll,
  beforeEach as tapsmithBeforeEach,
  afterAll as tapsmithAfterAll,
  collectResults,
  _internal,
  type RunOptions,
} from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import type { SessionPreflightContext } from '../session-preflight.js';
import type { PreparedState } from '../app-reset.js';
import { Tracing } from '../trace/tracing.js';
import { getActiveTraceCollector, screenshotFileName, screenshotArchivePath } from '../trace/trace-collector.js';

const { pushContext, popContext, runSuiteContext } = _internal;

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'never',
    testMatch: [],
    daemonAddress: 'localhost:50051',
    rootDir: '/proj',
    outputDir: 'out',
    workers: 1,
    launchEmulators: false,
    package: 'com.example.app',
    platform: 'android',
    ...overrides,
  };
}

/**
 * A device double that satisfies both the runner (waitForIdle, tracing) and
 * the session-preflight context (restart/clear/launch/… + client ping).
 * Android: ensureSessionReady = waitForIdle → getUiHierarchy → currentPackage.
 */
function makeDevice() {
  const calls: string[] = [];
  const record = (name: string) => vi.fn(async (..._args: unknown[]) => { calls.push(name); });
  const device = {
    tracing: new Tracing(async () => undefined, async () => undefined),
    waitForIdle: vi.fn(async () => {}),
    startAgent: record('startAgent'),
    terminateApp: record('terminateApp'),
    launchApp: record('launchApp'),
    restartApp: record('restartApp'),
    clearAppData: record('clearAppData'),
    restoreAppState: record('restoreAppState'),
    openDeepLink: record('openDeepLink'),
    _resetApp: vi.fn(async (_pkg: string, opts: { mode?: 'warm' | 'restart' | 'clear'; forceCold?: boolean }) => {
      const mode = opts.mode ?? 'warm';
      calls.push(`resetApp:${mode}`);
      return {
        modeRequested: mode, modeUsed: mode, fellBack: false, coldLaunch: mode !== 'warm',
        durationMs: 5, hooksDetected: false, steps: [{ name: mode, durationMs: 5, ok: true }],
      };
    }),
    currentPackage: vi.fn(async () => 'com.example.app'),
    getByText: vi.fn(() => ({ tap: vi.fn(async () => undefined) })),
    pressBack: vi.fn(async () => {}),
    getAppState: vi.fn(async () => 'foreground' as const),
    _stopDeviceLogStream: vi.fn(),
    _startDeviceLogStream: vi.fn(),
    _startDaemonLogStream: vi.fn(),
    _stopDaemonLogStream: vi.fn(),
    _setForceColdDeepLinks: vi.fn(),
    _appResetColdEvery: 10,
    _getAppResetColdEvery() { return this._appResetColdEvery; },
    _setAppResetColdEvery(n: number) { this._appResetColdEvery = n; },
  };
  const client = {
    ping: vi.fn(async () => ({ version: '0.1.0', agentConnected: true })),
    getUiHierarchy: vi.fn(async () => ({
      requestId: '1',
      hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>',
      errorMessage: '',
    })),
  };
  return { device, client, calls };
}

function makeOpts(d: ReturnType<typeof makeDevice>, config: TapsmithConfig, extra: Partial<RunOptions> = {}): RunOptions {
  const sessionContext: SessionPreflightContext = {
    label: 'test',
    config,
    device: d.device as unknown as SessionPreflightContext['device'],
    client: d.client as unknown as SessionPreflightContext['client'],
    notices: [],
  };
  return {
    config,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner double
    devices: [{ name: 'device-1', device: d.device as any, sessionContext }],
    resetCapabilities: {},
    runMode: 'test',
    // runTestFile creates this per file; these tests drive runSuiteContext directly.
    _applied: {},
    ...extra,
  };
}

/** Mimic the real Device recording a lifecycle call into the active collector. */
function recordAction(action: string): void {
  getActiveTraceCollector()?.addActionEvent({
    category: 'device', action, duration: 1, success: true,
    hasScreenshotBefore: false, hasScreenshotAfter: false, hasHierarchyBefore: false, hasHierarchyAfter: false,
  });
}

/** Device-level reset calls only (drop readiness-check noise). */
function resetCalls(d: ReturnType<typeof makeDevice>): string[] {
  return d.calls.filter((c) => !['startAgent'].includes(c));
}

/** Reset mock that logs into `order` as well as `d.calls`. */
function logResets(d: ReturnType<typeof makeDevice>, order: string[]): void {
  d.device._resetApp.mockImplementation(async (_pkg, opts) => {
    const mode = opts.mode ?? 'warm';
    order.push(`reset:${mode}${opts.forceCold ? ':cold' : ''}`);
    d.calls.push(`resetApp:${mode}`);
    recordAction('resetApp');
    return { modeRequested: mode, modeUsed: mode, fellBack: false, coldLaunch: mode !== 'warm', durationMs: 5, hooksDetected: false, steps: [] };
  });
}

/** Parse a packaged trace's events. */
function traceEvents(tracePath: string): Array<Record<string, unknown> & { type: string }> {
  const zip = unzipSync(fs.readFileSync(tracePath));
  return new TextDecoder().decode(zip['trace.json']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Actions and groups of a trace, in order, as `action:x` / `group-start:x` / `group-end:x`. */
function traceOutline(tracePath: string): string[] {
  return traceEvents(tracePath)
    .filter((e) => e.type === 'action' || e.type === 'group-start' || e.type === 'group-end')
    .map((e) => e.type === 'action' ? `action:${String(e.action)}` : `${e.type}:${String(e.name)}`);
}

describe('runner app reset (declared isolation)', () => {
  it('default policy: one clear reset per file, before beforeAll hooks, attributed to the first test', async () => {
    const d = makeDevice();
    const order: string[] = [];
    d.device._resetApp.mockImplementation(async (_pkg, opts) => {
      order.push('clear'); d.calls.push(`resetApp:${opts.mode}`);
      return { modeRequested: 'clear', modeUsed: 'clear', fellBack: false, coldLaunch: true, durationMs: 5, hooksDetected: false, steps: [] };
    });

    pushContext();
    tapsmithBeforeAll(async () => { order.push('beforeAll'); });
    tapsmithTest('one', async () => { order.push('one'); });
    tapsmithTest('two', async () => { order.push('two'); });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed']);
    expect(order).toEqual(['clear', 'beforeAll', 'one', 'two']);
    expect(resetCalls(d)).toEqual(['resetApp:clear']);
    const [first, second] = collectResults(result);
    // setupMs is only recorded when non-zero; with instant mocks it may be 0.
    expect(first.setupMs ?? 0).toBeGreaterThanOrEqual(0);
    expect(first.durationMs).toBeGreaterThanOrEqual(first.setupMs ?? 0);
    expect(second.setupMs).toBeUndefined();
  });

  it('runs no reset without a sessionContext (embedders that own isolation, unit tests)', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithTest('one', async () => {});
    const ctx = popContext();

    const opts = makeOpts(d, makeConfig());
    delete opts.devices[0].sessionContext;
    const result = await runSuiteContext(ctx, '', [], [], opts);

    expect(result.tests[0].status).toBe('passed');
    expect(resetCalls(d)).toEqual([]);
  });

  it('appResetScope: test resets before every test and again on each retry', async () => {
    const d = makeDevice();
    let attempts = 0;
    pushContext();
    tapsmithTest('flaky', async () => { attempts++; if (attempts === 1) throw new Error('first attempt fails'); });
    tapsmithTest('stable', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
      appReset: 'restart', appResetScope: 'test', retries: 1,
    })));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed']);
    // flaky: attempt 0 + retry; stable: once. No file-level reset for a
    // test-scoped policy without beforeAll hooks.
    expect(resetCalls(d)).toEqual(['resetApp:restart', 'resetApp:restart', 'resetApp:restart']);
    expect(d.device._setForceColdDeepLinks).toHaveBeenCalledWith(true);
    // The retry attempt asks for a cold delivery explicitly.
    expect(d.device._resetApp.mock.calls.map((c) => c[1].forceCold)).toEqual([false, true, false]);
  });

  describe('retries under a file-scoped policy (PILOT-715)', () => {
    it('re-runs the file setup before a retry: afterAll, a cold reset, then beforeAll, as a fresh worker would', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      let attempts = 0;
      pushContext();
      tapsmithBeforeAll(async () => { order.push('beforeAll'); });
      tapsmithAfterAll(async () => { order.push('afterAll'); });
      tapsmithTest('flaky', async () => { attempts++; order.push(`flaky#${attempts}`); if (attempts === 1) throw new Error('first attempt fails'); });
      tapsmithTest('stable', async () => { order.push('stable'); });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ retries: 1 })));

      expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed']);
      expect(order).toEqual([
        'reset:clear', 'beforeAll', 'flaky#1',
        'afterAll', 'reset:clear:cold', 'beforeAll', 'flaky#2',
        'stable', 'afterAll',
      ]);
    });

    it('replays every enclosing scope\'s setup in order, including a nested describe\'s own reset', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      let attempts = 0;
      pushContext();
      tapsmithBeforeAll(async () => { order.push('root beforeAll'); });
      tapsmithDescribe('warm scope', () => {
        tapsmithTest.use({ appReset: 'restart' });
        tapsmithBeforeAll(async () => { order.push('inner beforeAll'); });
        tapsmithAfterAll(async () => { order.push('inner afterAll'); });
        tapsmithTest('flaky', async () => { attempts++; order.push(`flaky#${attempts}`); if (attempts === 1) throw new Error('boom'); });
      });
      tapsmithAfterAll(async () => { order.push('root afterAll'); });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ retries: 1 })));

      expect(collectResults(result).map((t) => t.status)).toEqual(['passed']);
      expect(order).toEqual([
        'reset:clear', 'root beforeAll', 'reset:restart', 'inner beforeAll', 'flaky#1',
        // teardown innermost first, then setup outermost first
        'inner afterAll', 'root afterAll',
        'reset:clear:cold', 'root beforeAll', 'reset:restart:cold', 'inner beforeAll', 'flaky#2',
        'inner afterAll', 'root afterAll',
      ]);
    });

    it('the retry\'s trace shows the reset that ran before it, not the startup launch that satisfied attempt 1', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-retry-reset-'));
      const d = makeDevice();
      logResets(d, []);
      let attempts = 0;
      try {
        pushContext();
        tapsmithBeforeAll(async () => { recordAction('openDeepLink'); });
        // Fails both attempts, so the result links the retry's own trace (a
        // flaky result links the failed first attempt's).
        tapsmithTest('broken', async () => { attempts++; throw new Error(`boom ${attempts}`); });
        const ctx = popContext();
        const holder = new Map([['device-1', { policy: { mode: 'clear' as const, scope: 'file' as const }, preparedAt: Date.now(), durationMs: 9_800, source: 'startup launch' }]]);

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
          rootDir: tempRoot, retries: 1,
          trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
        }), { _prepared: holder }));

        const [t] = collectResults(result);
        expect(t.status).toBe('failed');
        expect(t.error?.message).toBe('boom 2');
        const zip = unzipSync(fs.readFileSync(t.tracePath!));
        const events = new TextDecoder().decode(zip['trace.json']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
        const ordered = events.filter((e) => e.type === 'action' || e.type === 'group-start' || e.type === 'group-end')
          .map((e) => e.type === 'action' ? `action:${e.action}` : `${e.type}:${e.name}`);
        expect(ordered.slice(0, 6)).toEqual([
          'group-start:App reset', 'action:resetApp', 'group-end:App reset',
          'group-start:beforeAll Hooks', 'action:openDeepLink', 'group-end:beforeAll Hooks',
        ]);
        // Numbered from 0: nothing replayed occupies the first slots, so the
        // archive keeps the dense index space trace readers check.
        expect(events.find((e) => e.type === 'action').actionIndex).toBe(0);
        // Attempt 1 was satisfied by the startup launch; the retry was not.
        expect(events.some((e) => e.type === 'action' && e.action === 'appReset')).toBe(false);
        expect(ordered.filter((e) => e === 'action:resetApp')).toHaveLength(1);
        expect(d.device._resetApp.mock.calls.map((c) => c[1].forceCold)).toEqual([true]);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('a beforeAll that throws while re-establishing state fails that attempt with its error', async () => {
      const d = makeDevice();
      let runs = 0;
      pushContext();
      tapsmithBeforeAll(async () => { runs++; if (runs === 2) throw new Error('login failed on retry'); });
      tapsmithTest('always fails', async () => { throw new Error('body failure'); });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ retries: 1 })));

      const [t] = collectResults(result);
      expect(t.status).toBe('failed');
      expect(t.error?.message).toMatch(/login failed on retry/);
    });

    it('an afterAll that throws during retry teardown is logged and the retry still runs', async () => {
      const d = makeDevice();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      let attempts = 0;
      let afterAllRuns = 0;
      try {
        pushContext();
        tapsmithAfterAll(async () => { afterAllRuns++; if (afterAllRuns === 1) throw new Error('cleanup failed'); });
        tapsmithTest('flaky', async () => { attempts++; if (attempts === 1) throw new Error('boom'); });
        const ctx = popContext();

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ retries: 1 })));

        expect(collectResults(result).map((t) => t.status)).toEqual(['passed']);
        expect(afterAllRuns).toBe(2);
        expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(/afterAll hook error: cleanup failed/);
      } finally {
        stderr.mockRestore();
      }
    });

    it('a serial group still retries in place (its later tests depend on earlier ones; PILOT-590)', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      let attempts = 0;
      pushContext();
      tapsmithTest.describe.serial('flow', () => {
        tapsmithBeforeAll(async () => { order.push('beforeAll'); });
        tapsmithTest('flaky', async () => { attempts++; order.push(`flaky#${attempts}`); if (attempts === 1) throw new Error('boom'); });
      });
      const ctx = popContext();

      await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ retries: 1 })));

      expect(order).toEqual(['reset:clear', 'beforeAll', 'flaky#1', 'flaky#2']);
    });

    it('a test after a retry whose setup failed sets up again before it starts (no second teardown)', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      let beforeAllRuns = 0;
      pushContext();
      tapsmithBeforeAll(async () => { beforeAllRuns++; order.push(`beforeAll#${beforeAllRuns}`); if (beforeAllRuns === 2) throw new Error('login failed'); });
      tapsmithAfterAll(async () => { order.push('afterAll'); });
      tapsmithTest('broken', async () => { order.push('broken'); throw new Error('boom'); });
      tapsmithTest('next', async () => { order.push('next'); });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ retries: 1 })));

      expect(collectResults(result).map((t) => t.status)).toEqual(['failed', 'passed']);
      expect(order).toEqual([
        'reset:clear', 'beforeAll#1', 'broken',
        'afterAll', 'reset:clear:cold', 'beforeAll#2',
        // the torn-down setup is rebuilt (cold, after a failure) before the
        // next test, which would otherwise run on it
        'reset:clear:cold', 'beforeAll#3', 'next',
        'afterAll',
      ]);
    });

    it('a describe with appReset: none under a resetting file retries in place', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      let attempts = 0;
      pushContext();
      tapsmithBeforeAll(async () => { order.push('root beforeAll'); });
      tapsmithDescribe('shared state', () => {
        tapsmithTest.use({ appReset: 'none' });
        tapsmithTest('flaky', async () => { attempts++; order.push(`flaky#${attempts}`); if (attempts === 1) throw new Error('boom'); });
      });
      const ctx = popContext();

      await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ retries: 1 })));

      expect(order).toEqual(['reset:clear', 'root beforeAll', 'flaky#1', 'flaky#2']);
    });

    it('a retry in place does not replay the file-entry reset into its trace', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-retry-inplace-'));
      const d = makeDevice();
      logResets(d, []);
      let attempts = 0;
      try {
        pushContext();
        tapsmithTest.describe.serial('flow', () => {
          tapsmithBeforeAll(async () => { recordAction('openDeepLink'); });
          tapsmithTest('broken', async () => { attempts++; recordAction('tap'); throw new Error(`boom ${attempts}`); });
        });
        const ctx = popContext();

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
          rootDir: tempRoot, retries: 1,
          trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
        })));

        const [t] = collectResults(result);
        expect(t.error?.message).toBe('boom 2');
        const zip = unzipSync(fs.readFileSync(t.tracePath!));
        const events = new TextDecoder().decode(zip['trace.json']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
        const actions = events.filter((e) => e.type === 'action');
        // Nothing reset before the retry, so its trace shows no reset and no
        // setup: just the attempt itself, numbered from 0.
        expect(events.some((e) => e.type === 'group-start' && e.name === 'App reset')).toBe(false);
        expect(actions.map((e) => e.action)).toEqual(['tap']);
        expect(actions[0].actionIndex).toBe(0);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('restores a describe\'s own appState on retry even when a sibling\'s identical restore made its entry reset unnecessary', async () => {
      const d = makeDevice();
      let attempts = 0;
      pushContext();
      tapsmithDescribe('first authenticated', () => {
        tapsmithTest.use({ appState: './auth.tar.gz' });
        tapsmithTest('a', async () => {});
      });
      tapsmithDescribe('second authenticated', () => {
        tapsmithTest.use({ appState: './auth.tar.gz' });
        tapsmithTest('flaky', async () => { attempts++; if (attempts === 1) throw new Error('boom'); });
      });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ retries: 1 })));

      expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed']);
      expect(resetCalls(d)).toEqual([
        'resetApp:clear', 'restoreAppState', 'restartApp', // file entry, first describe
        // the second describe needed no entry reset; its retry starts as a
        // fresh worker would: the file reset, then its own restore
        'resetApp:clear', 'restoreAppState', 'restartApp',
      ]);
    });

    it('does not reset twice for a describe that declares its parent\'s policy again', async () => {
      const d = makeDevice();
      let attempts = 0;
      pushContext();
      tapsmithDescribe('authenticated', () => {
        tapsmithTest.use({ appState: './auth.tar.gz' });
        tapsmithTest('a', async () => {});
      });
      tapsmithDescribe('back to clear', () => {
        // what the file already resolves to (auto → clear): no policy change
        tapsmithTest.use({ appReset: 'clear' });
        tapsmithTest('flaky', async () => { attempts++; if (attempts === 1) throw new Error('boom'); });
      });
      const ctx = popContext();

      await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ retries: 1 })));

      expect(resetCalls(d)).toEqual([
        'resetApp:clear', 'restoreAppState', 'restartApp', 'resetApp:clear',
        'resetApp:clear', // retry: one cold reset, not one per scope
      ]);
    });

    it('appReset: none opts out of isolation, so a retry re-runs no setup', async () => {
      const d = makeDevice();
      const order: string[] = [];
      let attempts = 0;
      pushContext();
      tapsmithBeforeAll(async () => { order.push('beforeAll'); });
      tapsmithTest('flaky', async () => { attempts++; order.push(`flaky#${attempts}`); if (attempts === 1) throw new Error('boom'); });
      const ctx = popContext();

      await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ appReset: 'none', retries: 1 })));

      expect(order).toEqual(['beforeAll', 'flaky#1', 'flaky#2']);
      expect(resetCalls(d)).toEqual([]);
    });
  });

  describe('after a test\'s final failure (PILOT-739)', () => {
    it('the next test starts from a fresh app: afterAll, a cold reset, then beforeAll', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      pushContext();
      tapsmithBeforeAll(async () => { order.push('beforeAll'); });
      tapsmithAfterAll(async () => { order.push('afterAll'); });
      tapsmithTest('broken', async () => { order.push('broken'); throw new Error('boom'); });
      tapsmithTest('next', async () => { order.push('next'); });
      tapsmithTest('after', async () => { order.push('after'); });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

      expect(collectResults(result).map((t) => t.status)).toEqual(['failed', 'passed', 'passed']);
      expect(order).toEqual([
        'reset:clear', 'beforeAll', 'broken',
        // a fresh worker for the rest of the file
        'afterAll', 'reset:clear:cold', 'beforeAll', 'next',
        // a pass leaves nothing to redo
        'after', 'afterAll',
      ]);
    });

    it('after the retries run out, the next test starts fresh too', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      let attempts = 0;
      pushContext();
      tapsmithBeforeAll(async () => { order.push('beforeAll'); });
      tapsmithTest('broken', async () => { attempts++; order.push(`broken#${attempts}`); throw new Error('boom'); });
      tapsmithTest('next', async () => { order.push('next'); });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ retries: 1 })));

      expect(collectResults(result).map((t) => t.status)).toEqual(['failed', 'passed']);
      expect(order).toEqual([
        'reset:clear', 'beforeAll', 'broken#1',
        'reset:clear:cold', 'beforeAll', 'broken#2',
        'reset:clear:cold', 'beforeAll', 'next',
      ]);
    });

    it('a flaky pass and a failing last test cost nothing extra', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      let attempts = 0;
      pushContext();
      tapsmithTest('flaky', async () => { attempts++; order.push(`flaky#${attempts}`); if (attempts === 1) throw new Error('boom'); });
      tapsmithTest('stable', async () => { order.push('stable'); });
      tapsmithTest('last', async () => { order.push('last'); throw new Error('boom'); });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ retries: 1 })));

      expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed', 'failed']);
      expect(order).toEqual([
        'reset:clear', 'flaky#1', 'reset:clear:cold', 'flaky#2',
        'stable',
        'last', 'reset:clear:cold', 'last',
      ]);
    });

    it('a describe entered after a failure gets the fresh start before its own beforeAll runs', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      pushContext();
      tapsmithBeforeAll(async () => { order.push('root beforeAll'); });
      tapsmithAfterAll(async () => { order.push('root afterAll'); });
      tapsmithDescribe('first', () => {
        tapsmithAfterAll(async () => { order.push('first afterAll'); });
        tapsmithTest('broken', async () => { order.push('broken'); throw new Error('boom'); });
      });
      tapsmithDescribe('second', () => {
        tapsmithBeforeAll(async () => { order.push('second beforeAll'); });
        tapsmithAfterAll(async () => { order.push('second afterAll'); });
        tapsmithTest('a', async () => { order.push('a'); });
        tapsmithTest('b', async () => { order.push('b'); });
      });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

      expect(collectResults(result).map((t) => t.status)).toEqual(['failed', 'passed', 'passed']);
      expect(order).toEqual([
        'reset:clear', 'root beforeAll', 'broken', 'first afterAll',
        // `first` already tore itself down; the root goes, then comes back
        'root afterAll', 'reset:clear:cold', 'root beforeAll',
        'second beforeAll', 'a', 'b', 'second afterAll',
        'root afterAll',
      ]);
    });

    it('a describe entered after a failure in one with its own appState resets to the file policy once', async () => {
      const d = makeDevice();
      pushContext();
      tapsmithDescribe('authenticated', () => {
        tapsmithTest.use({ appState: './auth.tar.gz' });
        tapsmithTest('broken', async () => { throw new Error('boom'); });
      });
      tapsmithDescribe('signed out', () => {
        tapsmithTest('a', async () => {});
      });
      const ctx = popContext();

      await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

      expect(resetCalls(d)).toEqual([
        'resetApp:clear', 'restoreAppState', 'restartApp',
        // the fresh start leaves the file policy applied: `signed out` needs
        // no entry reset of its own on top of it
        'resetApp:clear',
      ]);
    });

    it('a failed beforeAll leaves a fresh start for the next describe', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      pushContext();
      tapsmithDescribe('first', () => {
        tapsmithBeforeAll(async () => { order.push('first beforeAll'); throw new Error('setup failed'); });
        tapsmithTest('x', async () => { order.push('x'); });
      });
      tapsmithDescribe('second', () => {
        tapsmithBeforeAll(async () => { order.push('second beforeAll'); });
        tapsmithTest('a', async () => { order.push('a'); });
      });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

      expect(collectResults(result).map((t) => t.status)).toEqual(['failed', 'passed']);
      expect(order).toEqual([
        'reset:clear', 'first beforeAll',
        'reset:clear:cold', 'second beforeAll', 'a',
      ]);
    });

    it('a fresh start that fails at a describe\'s entry fails that describe, and the next one sets up without a second teardown', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      let rootRuns = 0;
      pushContext();
      tapsmithBeforeAll(async () => { rootRuns++; order.push(`root beforeAll#${rootRuns}`); if (rootRuns === 2) throw new Error('login failed'); });
      tapsmithAfterAll(async () => { order.push('root afterAll'); });
      tapsmithDescribe('first', () => {
        tapsmithTest('broken', async () => { order.push('broken'); throw new Error('boom'); });
      });
      tapsmithDescribe('second', () => {
        tapsmithTest('b', async () => { order.push('b'); });
      });
      tapsmithDescribe('third', () => {
        tapsmithTest('c', async () => { order.push('c'); });
      });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

      const results = collectResults(result);
      expect(results.map((t) => t.status)).toEqual(['failed', 'failed', 'passed']);
      expect(results[1].error?.message).toMatch(/login failed/);
      expect(order).toEqual([
        'reset:clear', 'root beforeAll#1', 'broken',
        'root afterAll', 'reset:clear:cold', 'root beforeAll#2',
        // nothing completed to tear down: straight to the setup again
        'reset:clear:cold', 'root beforeAll#3', 'c',
        'root afterAll',
      ]);
    });

    it('a nested describe after a failing test in its parent starts fresh', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      pushContext();
      tapsmithDescribe('outer', () => {
        tapsmithBeforeAll(async () => { order.push('outer beforeAll'); });
        tapsmithTest('broken', async () => { order.push('broken'); throw new Error('boom'); });
        tapsmithDescribe('inner', () => {
          tapsmithTest('a', async () => { order.push('a'); });
        });
      });
      const ctx = popContext();

      await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

      expect(order).toEqual([
        'reset:clear', 'outer beforeAll', 'broken',
        'reset:clear:cold', 'outer beforeAll', 'a',
      ]);
    });

    it('serial groups, appReset: none and per-test scopes keep their own rules', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      pushContext();
      tapsmithTest('broken', async () => { order.push('broken'); throw new Error('boom'); });
      tapsmithDescribe('shared state', () => {
        tapsmithTest.use({ appReset: 'none' });
        tapsmithTest('none', async () => { order.push('none'); });
      });
      tapsmithDescribe('per test', () => {
        tapsmithTest.use({ appResetScope: 'test' });
        tapsmithTest('per-test', async () => { order.push('per-test'); });
      });
      tapsmithTest.describe.serial('flow', () => {
        tapsmithTest('serial', async () => { order.push('serial'); });
      });
      const ctx = popContext();

      await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

      expect(order).toEqual([
        'reset:clear', 'broken',
        // `appReset: 'none'` opted out of isolation: no reset before it
        'none',
        // a per-test scope resets before each test anyway
        'reset:clear', 'per-test',
        // the serial group's entry: a fresh start from its parent's setup
        'reset:clear:cold', 'serial',
      ]);
    });

    it('under a root that does not reset, a describe declaring its own reset is the fresh start, once', async () => {
      const d = makeDevice();
      const order: string[] = [];
      logResets(d, order);
      pushContext();
      tapsmithTest.use({ appReset: 'none' });
      tapsmithDescribe('first', () => {
        tapsmithTest.use({ appReset: 'clear' });
        tapsmithTest('broken', async () => { order.push('broken'); throw new Error('boom'); });
      });
      tapsmithDescribe('second', () => {
        tapsmithTest.use({ appReset: 'clear' });
        tapsmithBeforeAll(async () => { order.push('second beforeAll'); });
        tapsmithAfterAll(async () => { order.push('second afterAll'); });
        tapsmithTest('a', async () => { order.push('a'); });
        tapsmithTest('b', async () => { order.push('b'); });
      });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

      expect(collectResults(result).map((t) => t.status)).toEqual(['failed', 'passed', 'passed']);
      expect(order).toEqual([
        'reset:clear', 'broken',
        // `second` shares `first`'s policy, so only the failure makes it reset
        'reset:clear', 'second beforeAll', 'a', 'b', 'second afterAll',
      ]);
    });

    it('the next test\'s trace shows the fresh-start reset that ran before it, numbered from 0', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-fresh-start-'));
      const d = makeDevice();
      logResets(d, []);
      try {
        pushContext();
        tapsmithBeforeAll(async () => { recordAction('openDeepLink'); });
        tapsmithTest('broken', async () => { throw new Error('boom'); });
        tapsmithTest('next', async () => { recordAction('tap'); });
        const ctx = popContext();
        const holder = new Map([['device-1', { policy: { mode: 'clear' as const, scope: 'file' as const }, preparedAt: Date.now(), durationMs: 9_800, source: 'startup launch' }]]);

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
          rootDir: tempRoot,
          trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
        }), { _prepared: holder }));

        const [, next] = collectResults(result);
        expect(next.status).toBe('passed');
        const outline = traceOutline(next.tracePath!);
        expect(outline.slice(0, 6)).toEqual([
          'group-start:App reset', 'action:resetApp', 'group-end:App reset',
          'group-start:beforeAll Hooks', 'action:openDeepLink', 'group-end:beforeAll Hooks',
        ]);
        // not the file-entry reset (satisfied by the startup launch) replayed
        expect(outline).not.toContain('action:appReset');
        expect(outline.filter((e) => e === 'action:resetApp')).toHaveLength(1);
        expect(traceEvents(next.tracePath!).find((e) => e.type === 'action')?.actionIndex).toBe(0);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('a describe entered after a failure records the fresh start in its tests\' traces, not the original file setup', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-fresh-scope-'));
      const d = makeDevice();
      logResets(d, []);
      try {
        pushContext();
        tapsmithBeforeAll(async () => { recordAction('openDeepLink'); });
        tapsmithDescribe('first', () => {
          tapsmithTest('broken', async () => { throw new Error('boom'); });
        });
        tapsmithDescribe('second', () => {
          tapsmithTest('a', async () => { recordAction('tap'); });
        });
        const ctx = popContext();
        const holder = new Map([['device-1', { policy: { mode: 'clear' as const, scope: 'file' as const }, preparedAt: Date.now(), durationMs: 9_800, source: 'startup launch' }]]);

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
          rootDir: tempRoot,
          trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
        }), { _prepared: holder }));

        const [, a] = collectResults(result);
        expect(a.status).toBe('passed');
        const outline = traceOutline(a.tracePath!);
        expect(outline).not.toContain('action:appReset');
        expect(outline.filter((e) => e === 'action:resetApp')).toHaveLength(1);
        expect(outline.filter((e) => e === 'action:openDeepLink')).toHaveLength(1);
        expect(outline.indexOf('action:resetApp')).toBeLessThan(outline.indexOf('action:openDeepLink'));
        expect(outline.indexOf('action:openDeepLink')).toBeLessThan(outline.indexOf('action:tap'));
        const indices = traceEvents(a.tracePath!).filter((e) => e.type === 'action').map((e) => e.actionIndex);
        expect(indices).toEqual(indices.map((_, i) => i));
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe('later traces replay the setup that rebuilt the app, not the original one', () => {
    const traceOn = { mode: 'on' as const, network: false, screenshots: false, snapshots: false, sources: false };
    const startupPrepared = () => new Map([['device-1', { policy: { mode: 'clear' as const, scope: 'file' as const }, preparedAt: Date.now(), durationMs: 9_800, source: 'startup launch' }]]);

    /** Assert a trace replays exactly one live reset, ahead of the setup's deep link and the test's tap, densely numbered. */
    function expectFreshSetup(tracePath: string): void {
      const outline = traceOutline(tracePath);
      expect(outline).not.toContain('action:appReset');
      expect(outline.filter((e) => e === 'action:resetApp')).toHaveLength(1);
      expect(outline.indexOf('action:resetApp')).toBeLessThan(outline.indexOf('action:openDeepLink'));
      expect(outline.lastIndexOf('action:openDeepLink')).toBeLessThan(outline.indexOf('action:tap'));
      const indices = traceEvents(tracePath).filter((e) => e.type === 'action').map((e) => e.actionIndex);
      expect(indices).toEqual(indices.map((_, i) => i));
    }

    it('the tests after the fresh-started one in the same describe', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-fresh-later-'));
      const d = makeDevice();
      logResets(d, []);
      try {
        pushContext();
        tapsmithBeforeAll(async () => { recordAction('openDeepLink'); });
        tapsmithTest('broken', async () => { throw new Error('boom'); });
        tapsmithTest('next', async () => { recordAction('tap'); });
        tapsmithTest('after', async () => { recordAction('tap'); });
        const ctx = popContext();

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ rootDir: tempRoot, trace: traceOn }), { _prepared: startupPrepared() }));

        const [, next, after] = collectResults(result);
        expect(after.status).toBe('passed');
        expectFreshSetup(next.tracePath!);
        expectFreshSetup(after.tracePath!);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('a describe after the one that was fresh-started at its entry', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-fresh-sibling-'));
      const d = makeDevice();
      logResets(d, []);
      try {
        pushContext();
        tapsmithBeforeAll(async () => { recordAction('openDeepLink'); });
        tapsmithDescribe('first', () => { tapsmithTest('broken', async () => { throw new Error('boom'); }); });
        tapsmithDescribe('second', () => { tapsmithTest('b', async () => { recordAction('tap'); }); });
        tapsmithDescribe('third', () => {
          tapsmithBeforeAll(async () => {});
          tapsmithTest('c', async () => { recordAction('tap'); });
        });
        const ctx = popContext();

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ rootDir: tempRoot, trace: traceOn }), { _prepared: startupPrepared() }));

        const [, b, c] = collectResults(result);
        expect(c.status).toBe('passed');
        expectFreshSetup(b.tracePath!);
        expectFreshSetup(c.tracePath!);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('the test after a retry that rebuilt the setup', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-fresh-retry-'));
      const d = makeDevice();
      logResets(d, []);
      let attempts = 0;
      try {
        pushContext();
        tapsmithBeforeAll(async () => { recordAction('openDeepLink'); });
        tapsmithTest('flaky', async () => { attempts++; if (attempts === 1) throw new Error('boom'); });
        tapsmithTest('next', async () => { recordAction('tap'); });
        const ctx = popContext();

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ rootDir: tempRoot, retries: 1, trace: traceOn }), { _prepared: startupPrepared() }));

        const [, next] = collectResults(result);
        expect(next.status).toBe('passed');
        expectFreshSetup(next.tracePath!);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('later traces keep the rebuilt setup\'s screenshots after its own test\'s trace is packaged', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-fresh-shots-'));
      const d = makeDevice();
      logResets(d, []);
      /** An action with a before-screenshot the collector owns, as a real capture leaves it. */
      const recordShot = (action: string): void => {
        const c = getActiveTraceCollector()!;
        const index = c.currentActionIndex;
        const diskPath = path.join(c.tempDir, 'screenshots', screenshotFileName(index, 'before'));
        fs.writeFileSync(diskPath, 'png');
        (c as unknown as { _screenshots: Array<{ archivePath: string; diskPath: string; external?: boolean }> })
          ._screenshots.push({ archivePath: screenshotArchivePath(index, 'before'), diskPath, external: false });
        c.addActionEvent({
          category: 'device', action, duration: 1, success: true,
          hasScreenshotBefore: true, hasScreenshotAfter: false, hasHierarchyBefore: false, hasHierarchyAfter: false,
        });
      };
      try {
        pushContext();
        tapsmithBeforeAll(async () => { recordShot('openDeepLink'); });
        tapsmithTest('broken', async () => { throw new Error('boom'); });
        tapsmithTest('next', async () => { recordAction('tap'); });
        tapsmithTest('after', async () => { recordAction('tap'); });
        const ctx = popContext();

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
          rootDir: tempRoot, trace: { ...traceOn, screenshots: true },
        })));

        const [, next, after] = collectResults(result);
        for (const t of [next, after]) {
          const zip = unzipSync(fs.readFileSync(t.tracePath!));
          const deepLink = traceEvents(t.tracePath!).find((e) => e.type === 'action' && e.action === 'openDeepLink')!;
          expect(Object.keys(zip)).toContain(screenshotArchivePath(deepLink.actionIndex as number, 'before'));
        }
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('later traces replay the rebuilt setup without the teardown before it', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-fresh-noteardown-'));
      const d = makeDevice();
      logResets(d, []);
      try {
        pushContext();
        tapsmithBeforeAll(async () => { recordAction('openDeepLink'); });
        tapsmithAfterAll(async () => { recordAction('logout'); });
        tapsmithTest('broken', async () => { throw new Error('boom'); });
        tapsmithTest('next', async () => { recordAction('tap'); });
        tapsmithTest('after', async () => { recordAction('tap'); });
        // last, so the file's own afterAll is appended to its trace, not after's
        tapsmithTest('last', async () => {});
        const ctx = popContext();

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ rootDir: tempRoot, trace: traceOn })));

        const [, next, after] = collectResults(result);
        // the fresh-started test shows the teardown it ran; the test after it
        // replays only the setup that built its app
        expect(traceOutline(next.tracePath!).slice(0, 3)).toEqual(['group-start:afterAll Hooks', 'action:logout', 'group-end:afterAll Hooks']);
        expect(traceOutline(after.tracePath!)).not.toContain('action:logout');
        expectFreshSetup(after.tracePath!);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('a describe fresh-started at its entry: its later tests and nested describes replay no teardown', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-fresh-entry-later-'));
      const d = makeDevice();
      logResets(d, []);
      try {
        pushContext();
        tapsmithBeforeAll(async () => { recordAction('openDeepLink'); });
        tapsmithAfterAll(async () => { recordAction('logout'); });
        tapsmithDescribe('first', () => { tapsmithTest('broken', async () => { throw new Error('boom'); }); });
        tapsmithDescribe('second', () => {
          tapsmithTest('a', async () => { recordAction('tap'); });
          tapsmithTest('b', async () => { recordAction('tap'); });
          tapsmithDescribe('inner', () => { tapsmithTest('c', async () => { recordAction('tap'); }); });
        });
        tapsmithDescribe('again', () => { tapsmithTest('broken again', async () => { throw new Error('boom'); }); });
        // its first runnable test is nested
        tapsmithDescribe('wrapper', () => {
          tapsmithDescribe('nested', () => { tapsmithTest('n', async () => { recordAction('tap'); }); });
        });
        tapsmithDescribe('last', () => { tapsmithTest('z', async () => {}); });
        const ctx = popContext();

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ rootDir: tempRoot, trace: traceOn })));

        const [, a, b, c, , n] = collectResults(result);
        expect(n.fullName).toBe('wrapper > nested > n');
        // the teardown belongs to the failed test's setup, not to any of these
        for (const t of [a, b, c, n]) {
          expect(traceOutline(t.tracePath!)).not.toContain('action:logout');
          expectFreshSetup(t.tracePath!);
        }
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('a describe below a hook-less one that was fresh-started at entry replays the latest rebuild', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-fresh-deep-'));
      const d = makeDevice();
      logResets(d, []);
      let rootRuns = 0;
      try {
        pushContext();
        tapsmithBeforeAll(async () => { rootRuns++; recordAction(`openDeepLink#${rootRuns}`); });
        tapsmithDescribe('first', () => { tapsmithTest('broken', async () => { throw new Error('boom'); }); });
        tapsmithDescribe('wrapper', () => {
          tapsmithDescribe('inner', () => {
            tapsmithBeforeAll(async () => {});
            tapsmithTest('t1', async () => { throw new Error('boom'); });
            tapsmithTest('t2', async () => { recordAction('tap'); });
          });
          tapsmithDescribe('inner2', () => {
            tapsmithBeforeAll(async () => {});
            tapsmithTest('p', async () => { recordAction('tap'); });
          });
        });
        const ctx = popContext();

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ rootDir: tempRoot, trace: traceOn })));

        const p = collectResults(result).find((t) => t.name === 'p')!;
        expect(p.status).toBe('passed');
        // #1 at file entry, #2 at `wrapper`'s entry, #3 before t2
        expect(rootRuns).toBe(3);
        const outline = traceOutline(p.tracePath!);
        expect(outline).toContain('action:openDeepLink#3');
        expect(outline).not.toContain('action:openDeepLink#2');
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('a describe fresh-started at its entry does not charge the untraced teardown to its first reset', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-fresh-timing-'));
      const d = makeDevice();
      logResets(d, []);
      let afterAllRuns = 0;
      try {
        pushContext();
        tapsmithBeforeAll(async () => { recordAction('openDeepLink'); });
        tapsmithAfterAll(async () => { afterAllRuns++; if (afterAllRuns === 1) await new Promise((r) => setTimeout(r, 1500)); });
        tapsmithDescribe('first', () => { tapsmithTest('broken', async () => { throw new Error('boom'); }); });
        tapsmithDescribe('second', () => { tapsmithTest('a', async () => { recordAction('tap'); }); });
        const ctx = popContext();

        const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ rootDir: tempRoot, trace: traceOn })));

        const a = collectResults(result).find((t) => t.name === 'a')!;
        const reset = traceEvents(a.tracePath!).find((e) => e.type === 'action' && e.action === 'resetApp')!;
        expect(afterAllRuns).toBeGreaterThanOrEqual(1);
        expect(reset.wallDuration as number).toBeLessThan(1000);
        expect((reset.gapBefore as number | undefined) ?? 0).toBeLessThan(1000);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('removes the temp dirs a fresh start kept for later replays when the file ends', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-fresh-cleanup-'));
      const tmp = path.join(tempRoot, 'tmp');
      fs.mkdirSync(tmp);
      const prevTmp = process.env.TMPDIR;
      process.env.TMPDIR = tmp;
      const d = makeDevice();
      logResets(d, []);
      try {
        pushContext();
        tapsmithBeforeAll(async () => { recordAction('openDeepLink'); });
        tapsmithTest('broken', async () => { throw new Error('boom'); });
        tapsmithTest('next', async () => {});
        tapsmithTest('after', async () => {});
        const ctx = popContext();

        await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ rootDir: tempRoot, trace: traceOn })));

        expect(fs.readdirSync(tmp)).toEqual([]);
      } finally {
        if (prevTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = prevTmp;
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  it('per-test resets record in an APP RESET group ahead of BEFORE EACH', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-appreset-pertest-'));
    const d = makeDevice();
    d.device._resetApp.mockImplementation(async (_pkg, opts) => {
      recordAction('resetApp');
      return { modeRequested: opts.mode ?? 'warm', modeUsed: 'restart', fellBack: false, coldLaunch: true, durationMs: 5, hooksDetected: false, steps: [] };
    });
    try {
      pushContext();
      tapsmithBeforeEach(async () => { recordAction('tap'); });
      tapsmithTest('one', async () => {});
      const ctx = popContext();
      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
        rootDir: tempRoot, appReset: 'restart', appResetScope: 'test',
        trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
      })));
      const zip = unzipSync(fs.readFileSync(result.tests[0].tracePath!));
      const events = new TextDecoder().decode(zip['trace.json']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      const ordered = events.filter((e) => e.type === 'action' || e.type === 'group-start' || e.type === 'group-end')
        .map((e) => e.type === 'action' ? `action:${e.action}` : `${e.type}:${e.name}`);
      expect(ordered.slice(0, 6)).toEqual([
        'group-start:App reset', 'action:resetApp', 'group-end:App reset',
        'group-start:beforeEach Hooks', 'action:tap', 'group-end:beforeEach Hooks',
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('test-scoped policy still resets at file entry when the file has beforeAll hooks', async () => {
    const d = makeDevice();
    const order: string[] = [];
    d.device._resetApp.mockImplementation(async () => {
      order.push('restart');
      return { modeRequested: 'restart', modeUsed: 'restart', fellBack: false, coldLaunch: true, durationMs: 5, hooksDetected: false, steps: [] };
    });
    pushContext();
    tapsmithBeforeAll(async () => { order.push('beforeAll'); });
    tapsmithTest('one', async () => { order.push('one'); });
    const ctx = popContext();

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ appReset: 'restart', appResetScope: 'test' })));

    expect(order).toEqual(['restart', 'beforeAll', 'restart', 'one']);
  });

  it('auto isolation with in-app hooks: one warm reset per file (per-test is an explicit opt-in)', async () => {
    const d = makeDevice();
    const order: string[] = [];
    d.device._resetApp.mockImplementation(async (_pkg, opts) => {
      order.push(`reset:${opts.mode}`);
      return { modeRequested: opts.mode ?? 'warm', modeUsed: 'warm', fellBack: false, coldLaunch: false, durationMs: 5, hooksDetected: true, steps: [] };
    });
    pushContext();
    tapsmithDescribe('shared setup', () => {
      tapsmithBeforeAll(async () => { order.push('beforeAll'); });
      tapsmithTest('one', async () => { order.push('one'); });
      tapsmithTest('two', async () => { order.push('two'); });
    });
    tapsmithDescribe('independent', () => {
      tapsmithTest('three', async () => { order.push('three'); });
      tapsmithTest('four', async () => { order.push('four'); });
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), {
      resetCapabilities: { hooksDetected: true },
    }));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    // One warm reset at file entry; the nested describes declare no policy of
    // their own, so nothing resets between tests (per-test isolation is an
    // explicit `appResetScope: 'test'` opt-in).
    expect(order).toEqual([
      'reset:warm', 'beforeAll', 'one', 'two', 'three', 'four',
    ]);
  });

  it('a nested describe with appState restores (never pm clear) and resolves the path against rootDir', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithTest('logged out', async () => {});
    tapsmithDescribe('authenticated', () => {
      tapsmithTest.use({ appState: './auth.tar.gz' });
      tapsmithTest('logged in', async () => {});
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed']);
    expect(resetCalls(d)).toEqual([
      'resetApp:clear',                  // root: clear (daemon ladder)
      'restoreAppState', 'restartApp',   // nested: restore (never pm clear)
    ]);
    expect(d.device.restoreAppState).toHaveBeenCalledWith('com.example.app', path.resolve('/proj', './auth.tar.gz'));
  });

  it('root setup time is attributed to the first test even when it lives inside a describe', async () => {
    const d = makeDevice();
    // Measure what the hook actually took rather than asserting against the
    // nominal sleep: `setTimeout(60)` does not guarantee a 60ms Date.now()
    // delta (Node arms timers on the loop's cached clock while Date.now()
    // truncates), so `>= 60` failed roughly 1 run in 125 at exactly 59ms.
    // The runner brackets the hook — suiteStart before, setupMs measured
    // after — so first.durationMs >= hookMs holds by construction.
    let hookMs = 0;
    pushContext();
    tapsmithBeforeAll(async () => {
      const hookStart = Date.now();
      await new Promise((r) => setTimeout(r, 60));
      hookMs = Date.now() - hookStart;
    });
    tapsmithDescribe('nested', () => {
      tapsmithTest('first', async () => {});
      tapsmithTest('second', async () => {});
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

    const [first, second] = collectResults(result);
    expect(hookMs).toBeGreaterThan(0);
    expect(first.durationMs).toBeGreaterThanOrEqual(hookMs);
    // The setup landed on the first test, not carried into the second.
    expect(second.durationMs).toBeLessThan(hookMs);
  });

  it('the reporter hears onTestStart for the test the scope reset was announced under', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithTest('one', async () => {});
    tapsmithTest('two', async () => {});
    const ctx = popContext();
    const onTestStart = vi.fn();

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), {
      onTestStart: async () => {},
      reporter: { onTestStart } as unknown as RunOptions['reporter'],
    }));

    expect(onTestStart.mock.calls.map((c) => c[0])).toEqual(['one', 'two']);
  });

  it('announces each test with the isolation policy it runs under, not the announcing scope\'s', async () => {
    // The root scope resets on entry and announces the first test — inside
    // the describe — ahead of its own setup. That test runs per-test, so the
    // announcement must carry the test's policy, not the root's file policy.
    const d = makeDevice();
    pushContext();
    tapsmithDescribe('toggles', () => {
      tapsmithTest.use({ appResetScope: 'test' });
      tapsmithTest('one', async () => {});
    });
    const onTestStart = vi.fn(async () => {});
    await runSuiteContext(popContext(), '', [], [], makeOpts(d, makeConfig(), { onTestStart }));
    expect(onTestStart.mock.calls).toEqual([
      ['toggles > one', { policy: { mode: 'clear', scope: 'test', appState: undefined } }],
    ]);

    // A root-level test is announced under the file policy; the describe's
    // own test, announced by the per-test loop, under its per-test policy.
    const d2 = makeDevice();
    pushContext();
    tapsmithTest('root-level', async () => {});
    tapsmithDescribe('toggles', () => {
      tapsmithTest.use({ appResetScope: 'test' });
      tapsmithTest('one', async () => {});
    });
    const onTestStart2 = vi.fn(async () => {});
    await runSuiteContext(popContext(), '', [], [], makeOpts(d2, makeConfig(), { onTestStart: onTestStart2 }));
    expect(onTestStart2.mock.calls).toEqual([
      ['root-level', { policy: { mode: 'clear', scope: 'file', appState: undefined } }],
      ['toggles > one', { policy: { mode: 'clear', scope: 'test', appState: undefined } }],
    ]);
  });

  it('a nested describe inherits its parent appState instead of resetting to clear on entry', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithDescribe('authenticated', () => {
      tapsmithTest.use({ appState: './auth.tar.gz' });
      tapsmithTest('profile', async () => {});
      tapsmithDescribe('settings', () => {
        // Declares nothing: Playwright `use` semantics — the restored state
        // is still what these tests run against.
        tapsmithTest('notifications', async () => {});
        tapsmithDescribe('deeper', () => {
          tapsmithTest('theme', async () => {});
        });
      });
      tapsmithDescribe('signed out', () => {
        // An explicit empty appState still overrides the inherited archive.
        tapsmithTest.use({ appState: '' });
        tapsmithTest('landing', async () => {});
      });
      tapsmithDescribe('billing', () => {
        // Inherits the archive again, but the device now holds the sibling's
        // cleared state — so the archive is restored once more.
        tapsmithTest('invoices', async () => {});
      });
    });
    tapsmithDescribe('guest', () => {
      // Back at the root's policy while the device holds the archive.
      tapsmithTest('landing', async () => {});
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed']);
    expect(resetCalls(d)).toEqual([
      'resetApp:clear',                  // root
      'restoreAppState', 'restartApp',   // authenticated: restore once (settings/deeper inherit)
      'resetApp:clear',                  // signed out: explicit appState ''
      'restoreAppState', 'restartApp',   // billing: device held the cleared state
      'resetApp:clear',                  // guest: device held the archive
    ]);
  });

  it('project-level appState cascades to nested describes (no clear on describe entry)', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithDescribe('dashboard', () => {
      tapsmithTest('widgets', async () => {});
    });
    const ctx = popContext();
    ctx.useOptions = { appState: './auth.tar.gz' };

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

    expect(resetCalls(d)).toEqual(['restoreAppState', 'restartApp']);
  });

  it('appState "" in a nested describe clears again; the same policy does not re-reset', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithDescribe('same policy', () => {
      tapsmithTest('a', async () => {});
    });
    tapsmithDescribe('fresh', () => {
      tapsmithTest.use({ appState: '' });
      tapsmithTest('b', async () => {});
    });
    const ctx = popContext();

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

    expect(resetCalls(d)).toEqual(['resetApp:clear', 'resetApp:clear']);
  });

  it('a prepared device satisfying the policy skips the reset (first file after launch)', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithTest('one', async () => {});
    const ctx = popContext();
    const prepared: PreparedState = {
      policy: { mode: 'clear', scope: 'file' }, preparedAt: Date.now(), durationMs: 1200, source: 'startup launch',
    };
    const holder = new Map([['device-1', prepared]]);

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), { _prepared: holder }));

    expect(result.tests[0].status).toBe('passed');
    expect(resetCalls(d)).toEqual([]);
    expect(d.client.ping).toHaveBeenCalled();       // readiness still verified
    expect(holder.get('device-1')).toBeUndefined();  // consumed exactly once
  });

  it('a nested describe that resets first consumes the prepared device (root scope did not reset)', async () => {
    const d = makeDevice();
    const prepared = new Map([['device-1', { policy: { mode: 'warm' as const, scope: 'test' as const }, preparedAt: Date.now(), durationMs: 1000, source: 'background preparation' }]]);
    pushContext();
    // Root: hooks detected → auto per-test → no root reset. The describe has
    // a beforeAll → per-file → resets on entry; that reset is the file's first
    // and must use the prepared device instead of resetting again.
    tapsmithDescribe('shared setup', () => {
      tapsmithBeforeAll(async () => {});
      tapsmithTest('one', async () => {});
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), {
      resetCapabilities: { hooksDetected: true },
      _prepared: prepared,
    }));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed']);
    expect(resetCalls(d)).toEqual([]);
    expect(prepared.get('device-1')).toBeUndefined();
  });

  it('appResetScope: test inside a describe does not reset twice at file entry', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-appreset-double-'));
    const d = makeDevice();
    try {
      pushContext();
      // The exact shape of the repo's own per-test files: the root scope is
      // file-scoped and resets on entry; the describe opts into per-test.
      tapsmithDescribe('toggles', () => {
        tapsmithTest.use({ appResetScope: 'test' });
        tapsmithTest('one', async () => {});
        tapsmithTest('two', async () => {});
      });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
        rootDir: tempRoot,
        trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
      }), { _prepared: new Map() }));

      expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed']);
      // File entry, then one per test — minus the first per-test reset, which
      // the entry reset already satisfied (nothing touched the app between).
      expect(resetCalls(d)).toEqual(['resetApp:clear', 'resetApp:clear']);
      const [one, two] = collectResults(result);
      const rowsOf = (tracePath: string) => {
        const zip = unzipSync(fs.readFileSync(tracePath));
        return new TextDecoder().decode(zip['trace.json']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
          .filter((e) => e.type === 'action' && e.action === 'appReset');
      };
      const summary = rowsOf(one.tracePath!);
      expect(summary).toHaveLength(1);
      expect(summary[0]).toMatchObject({ origin: 'prepared' });
      expect(summary[0].detail).toMatch(/satisfied by the file-entry reset/);
      // The second test's reset is real device work again.
      expect(rowsOf(two.tracePath!)).toEqual([]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('a beforeAll hook between the entry reset and the first per-test reset forfeits the reuse', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithBeforeAll(async () => {});
    tapsmithDescribe('toggles', () => {
      tapsmithTest.use({ appResetScope: 'test' });
      tapsmithTest('one', async () => {});
    });
    const ctx = popContext();

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), { _prepared: new Map() }));

    // The hook may have touched the app: entry reset, then a real per-test reset.
    expect(resetCalls(d)).toEqual(['resetApp:clear', 'resetApp:clear']);
  });

  it('a file-scoped test running before the per-test describe forfeits the reuse', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithTest('root-level', async () => {});
    tapsmithDescribe('toggles', () => {
      tapsmithTest.use({ appResetScope: 'test' });
      tapsmithTest('one', async () => {});
    });
    const ctx = popContext();

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), { _prepared: new Map() }));

    // Entry reset for the file, the root test dirties the app, then a real
    // per-test reset for the describe's first test.
    expect(resetCalls(d)).toEqual(['resetApp:clear', 'resetApp:clear']);
  });

  it('a prepared device that does not satisfy the policy is ignored (appState wins)', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithTest.use({ appState: '/abs/auth.tar.gz' });
    tapsmithTest('one', async () => {});
    const ctx = popContext();
    const holder = new Map([['device-1', { policy: { mode: 'clear' as const, scope: 'file' as const }, preparedAt: 0, durationMs: 0, source: 'x' }]]);

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), { _prepared: holder }));

    expect(resetCalls(d)).toEqual(['restoreAppState', 'restartApp']);
  });

  it('test.use({ appResetColdEvery }) reaches the device for explicit resetApp() calls, scoped', async () => {
    const d = makeDevice();
    const seen: number[] = [];
    pushContext();
    tapsmithDescribe('valve off', () => {
      tapsmithTest.use({ appResetColdEvery: 0 });
      tapsmithTest('inner', async () => { seen.push(d.device._getAppResetColdEvery()); });
    });
    tapsmithTest('outer', async () => { seen.push(d.device._getAppResetColdEvery()); });
    const ctx = popContext();

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

    // Root-level tests run first; the describe's override is restored after it.
    expect(seen).toEqual([10, 0]);
    expect(d.device._getAppResetColdEvery()).toBe(10);
  });

  it('appReset: none only verifies the session', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithTest('one', async () => {});
    const ctx = popContext();

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ appReset: 'none' })));

    expect(resetCalls(d)).toEqual([]);
    expect(d.client.ping).toHaveBeenCalled();
  });

  it('a failing reset fails every test in the scope with the reset error', async () => {
    const d = makeDevice();
    d.device._resetApp.mockRejectedValue(new Error('pm clear failed'));
    pushContext();
    tapsmithTest('one', async () => {});
    tapsmithTest('two', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

    const flat = collectResults(result);
    expect(flat.map((t) => t.status)).toEqual(['failed', 'failed']);
    expect(flat[0].error?.message).toContain('pm clear failed');
  });

  it('a recoverable infrastructure error in the file-entry reset propagates to an embedder that opted into recovery', async () => {
    // worker-runner / cli / ui-worker pass abortFileOnError and recover the
    // session themselves; recording failed results here would make the retry
    // flag every test in the file as flaky although none ran.
    const d = makeDevice();
    d.device._resetApp.mockRejectedValue(new Error('UNAVAILABLE: agent socket closed'));
    pushContext();
    tapsmithTest('one', async () => {});
    tapsmithTest('two', async () => {});
    const ctx = popContext();
    const onTestEnd = vi.fn();

    await expect(runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), {
      abortFileOnError: (err) => err.message.includes('UNAVAILABLE'),
      reporter: { onTestEnd },
    }))).rejects.toThrow('agent socket closed');
    expect(onTestEnd).not.toHaveBeenCalled();
  });

  it('a non-recoverable file-entry reset error still fails the scope even when the embedder opted into recovery', async () => {
    const d = makeDevice();
    d.device._resetApp.mockRejectedValue(new Error('pm clear failed'));
    pushContext();
    tapsmithTest('one', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), {
      abortFileOnError: (err) => err.message.includes('UNAVAILABLE'),
    }));

    expect(collectResults(result).map((t) => t.status)).toEqual(['failed']);
  });

  it('test.use() rejects unknown trace and video modes', () => {
    pushContext();
    expect(() => tapsmithTest.use({ trace: 'onn' as never })).toThrow(/test\.use\(\): trace must be one of .*\(got "onn"\)/);
    expect(() => tapsmithTest.use({ video: { mode: 'always' as never } })).toThrow(/test\.use\(\): video must be one of/);
    expect(() => tapsmithTest.use({ trace: 'retain-on-failure', video: 'on' })).not.toThrow();
    popContext();
  });

  it('test.use() rejects unknown appReset values', () => {
    pushContext();
    expect(() => tapsmithTest.use({ appReset: 'bogus' as never })).toThrow(/appReset must be one of/);
    expect(() => tapsmithTest.use({ appResetScope: 'sometimes' as never })).toThrow(/appResetScope must be one of/);
    popContext();
  });

  it('records the reset in its own APP RESET group ahead of BEFORE ALL, with policy metadata', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-appreset-'));
    const d = makeDevice();
    // The real Device records each lifecycle call as a traced action into the
    // active collector; mimic that so the group has children (empty groups
    // are dropped from traces by design).
    d.device._resetApp.mockImplementation(async (_pkg, opts) => {
      d.calls.push(`resetApp:${opts.mode}`);
      getActiveTraceCollector()?.addActionEvent({
        category: 'device', action: 'resetApp', duration: 1, success: true, detail: 'cleared app data and relaunched, 0.0s',
        hasScreenshotBefore: false, hasScreenshotAfter: false, hasHierarchyBefore: false, hasHierarchyAfter: false,
      });
      return { modeRequested: 'clear', modeUsed: 'clear', fellBack: false, coldLaunch: true, durationMs: 5, hooksDetected: false, steps: [] };
    });
    try {
      pushContext();
      tapsmithBeforeAll(async () => { recordAction('tap'); });
      tapsmithTest('one', async () => {});
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
        rootDir: tempRoot,
        trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
      })));

      const tracePath = result.tests[0].tracePath;
      expect(tracePath).toBeDefined();
      const zip = unzipSync(fs.readFileSync(tracePath!));
      const events = new TextDecoder().decode(zip['trace.json']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      const groups = events.filter((e) => e.type === 'group-start').map((e) => e.name);
      // The reset is a sibling section *before* the hooks group — not nested
      // inside it (the actions panel renders groups as flat headers, so a
      // nested group would swallow the hook's own actions) and not mixed into
      // BEFORE ALL (which holds only the user's hook code).
      expect(groups.slice(0, 2)).toEqual(['App reset', 'beforeAll Hooks']);
      const ordered = events.filter((e) => e.type === 'action' || e.type === 'group-start' || e.type === 'group-end')
        .map((e) => e.type === 'action' ? `action:${e.action}` : `${e.type}:${e.name}`);
      expect(ordered.slice(0, 6)).toEqual([
        'group-start:App reset', 'action:resetApp', 'group-end:App reset',
        'group-start:beforeAll Hooks', 'action:tap', 'group-end:beforeAll Hooks',
      ]);
      const metadata = JSON.parse(new TextDecoder().decode(zip['metadata.json']));
      expect(metadata).toMatchObject({ appReset: 'clear', appResetScope: 'file' });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('records a summary row when the reset was satisfied by a prepared device', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-appreset-prepared-'));
    const d = makeDevice();
    try {
      pushContext();
      tapsmithTest('one', async () => {});
      const ctx = popContext();
      const holder = new Map([['device-1', { policy: { mode: 'clear' as const, scope: 'file' as const }, preparedAt: Date.now(), durationMs: 9_800, source: 'startup launch' }]]);

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
        rootDir: tempRoot,
        trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
      }), { _prepared: holder }));

      const zip = unzipSync(fs.readFileSync(result.tests[0].tracePath!));
      const events = new TextDecoder().decode(zip['trace.json']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      const summary = events.find((e) => e.type === 'action' && e.action === 'appReset');
      expect(summary).toMatchObject({ origin: 'prepared', category: 'device' });
      expect(summary.detail).toMatch(/satisfied by startup launch/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  describe('system dialogs the preflight handled (PILOT-398)', () => {
    const appDialog = (message: string) => ({ kind: 'app-dialog' as const, title: 'Example isn\'t responding', owner: 'com.example.app', message, timestamp: Date.now() });
    const foreignDialog = { kind: 'foreign-dialog' as const, title: 'Pixel Launcher isn\'t responding', owner: 'com.google.android.apps.nexuslauncher', message: 'Dismissed a system dialog from another app: "Pixel Launcher isn\'t responding" (com.google.android.apps.nexuslauncher).', timestamp: Date.now() };

    it('warns on the test whose preflight closed the app\'s own dialog, and on no other', async () => {
      const d = makeDevice();
      pushContext();
      tapsmithTest('one', async () => {});
      tapsmithTest('two', async () => {});
      const ctx = popContext();
      const opts = makeOpts(d, makeConfig({ appReset: 'none' }));
      let calls = 0;
      opts.beforeEachTest = async () => {
        calls++;
        if (calls === 2) opts.devices[0].sessionContext!.notices.push(appDialog('The app under test (com.example.app) showed "Example isn\'t responding"; Tapsmith dismissed it.'), foreignDialog);
      };

      const result = await runSuiteContext(ctx, '', [], [], opts);

      const [one, two] = collectResults(result);
      expect(one.warnings).toBeUndefined();
      // Another app's dialog is not a warning on the test (trace row only).
      expect(two.warnings).toEqual(['The app under test (com.example.app) showed "Example isn\'t responding"; Tapsmith dismissed it.']);
      expect(opts.devices[0].sessionContext!.notices).toEqual([]);
    });

    it('turns a missing-hooks notice into a warning on the next test (PILOT-774)', async () => {
      const d = makeDevice();
      pushContext();
      tapsmithTest('one', async () => {});
      tapsmithTest('two', async () => {});
      const ctx = popContext();
      const opts = makeOpts(d, makeConfig());
      d.device._resetApp.mockImplementation(async () => {
        opts.devices[0].sessionContext!.notices.push({ kind: 'hooks-missing', title: 'hooks not found', message: 'hooks never showed up', timestamp: Date.now() });
        return { modeRequested: 'clear', modeUsed: 'clear', fellBack: false, coldLaunch: true, durationMs: 5, hooksDetected: false, steps: [] };
      });

      const result = await runSuiteContext(ctx, '', [], [], opts);

      const [one, two] = collectResults(result);
      expect(one.warnings).toEqual(['hooks never showed up']);
      expect(two.warnings).toBeUndefined();
    });

    it('drops a missing-hooks notice once the session has since detected the hooks (PILOT-774)', async () => {
      const d = makeDevice();
      pushContext();
      tapsmithTest('one', async () => {});
      const ctx = popContext();
      const opts = makeOpts(d, makeConfig());
      d.device._resetApp.mockImplementation(async () => {
        const session = opts.devices[0].sessionContext!;
        session.notices.push({ kind: 'hooks-missing', title: 'hooks not found', message: 'hooks never showed up', timestamp: Date.now() });
        // A later read in the same session saw the marker (a slow first mount).
        (session.capabilities ??= {}).hooksDetected = true;
        return { modeRequested: 'clear', modeUsed: 'clear', fellBack: false, coldLaunch: true, durationMs: 5, hooksDetected: false, steps: [] };
      });

      const result = await runSuiteContext(ctx, '', [], [], opts);

      expect(collectResults(result)[0].warnings).toBeUndefined();
    });

    it('keeps the warning when the preflight that closed the dialog then failed the test', async () => {
      const d = makeDevice();
      pushContext();
      tapsmithTest('one', async () => {});
      const ctx = popContext();
      const opts = makeOpts(d, makeConfig({ appReset: 'none' }));
      opts.beforeEachTest = async () => {
        opts.devices[0].sessionContext!.notices.push(appDialog('closed it'));
        throw new Error('session recovered during before test one; retrying file');
      };

      const result = await runSuiteContext(ctx, '', [], [], opts);

      expect(result.tests[0]).toMatchObject({ status: 'failed', warnings: ['closed it'] });
    });

    it('puts a dialog closed by the scope-entry reset on the first test', async () => {
      const d = makeDevice();
      pushContext();
      tapsmithTest('one', async () => {});
      tapsmithTest('two', async () => {});
      const ctx = popContext();
      const opts = makeOpts(d, makeConfig());
      d.device._resetApp.mockImplementation(async () => {
        opts.devices[0].sessionContext!.notices.push(appDialog('closed at file entry'));
        return { modeRequested: 'clear', modeUsed: 'clear', fellBack: false, coldLaunch: true, durationMs: 5, hooksDetected: false, steps: [] };
      });

      const result = await runSuiteContext(ctx, '', [], [], opts);

      const [one, two] = collectResults(result);
      expect(one.warnings).toEqual(['closed at file entry']);
      expect(two.warnings).toBeUndefined();
    });

    it('keeps the warning on every test of a scope whose beforeAll then failed', async () => {
      const d = makeDevice();
      pushContext();
      tapsmithBeforeAll(async () => { throw new Error('app never came back'); });
      tapsmithTest('one', async () => {});
      tapsmithTest('two', async () => {});
      const ctx = popContext();
      const opts = makeOpts(d, makeConfig());
      d.device._resetApp.mockImplementation(async () => {
        opts.devices[0].sessionContext!.notices.push(appDialog('closed at file entry'));
        return { modeRequested: 'clear', modeUsed: 'clear', fellBack: false, coldLaunch: true, durationMs: 5, hooksDetected: false, steps: [] };
      });

      const result = await runSuiteContext(ctx, '', [], [], opts);

      expect(collectResults(result).map((t) => [t.status, t.warnings])).toEqual([
        ['failed', ['closed at file entry']],
        ['failed', ['closed at file entry']],
      ]);
    });

    it('keeps the warning when the entry reset that closed the dialog then failed', async () => {
      const d = makeDevice();
      pushContext();
      tapsmithTest('one', async () => {});
      const ctx = popContext();
      const opts = makeOpts(d, makeConfig());
      d.device._resetApp.mockImplementation(async () => {
        opts.devices[0].sessionContext!.notices.push(appDialog('closed at file entry'));
        throw new Error('App reset failed: RESET_FAILED');
      });

      const result = await runSuiteContext(ctx, '', [], [], opts);

      expect(collectResults(result).map((t) => [t.status, t.warnings])).toEqual([['failed', ['closed at file entry']]]);
    });

    it('shows the warning on the attempt it interrupted as well as the final result', async () => {
      const d = makeDevice();
      let attempts = 0;
      pushContext();
      tapsmithTest('flaky', async () => { attempts++; if (attempts === 1) throw new Error('first attempt fails'); });
      const ctx = popContext();
      const ended: Array<{ willRetry?: boolean; warnings?: string[] }> = [];
      const opts = makeOpts(d, makeConfig({ appReset: 'none', retries: 1 }), {
        reporter: { onTestEnd: (r) => { ended.push({ willRetry: r._willRetry, warnings: r.warnings }); } },
      });
      let calls = 0;
      opts.beforeEachTest = async () => {
        if (++calls === 1) opts.devices[0].sessionContext!.notices.push(appDialog('closed it'));
      };

      await runSuiteContext(ctx, '', [], [], opts);

      expect(ended).toEqual([
        { willRetry: true, warnings: ['closed it'] },
        { willRetry: undefined, warnings: ['closed it'] },
      ]);
    });

    it('records a trace row for every handled dialog', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-dialog-'));
      try {
        const d = makeDevice();
        pushContext();
        tapsmithTest('one', async () => {});
        const ctx = popContext();
        const opts = makeOpts(d, makeConfig({
          appReset: 'none',
          rootDir: tempRoot,
          trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
        }));
        opts.beforeEachTest = async () => {
          opts.devices[0].sessionContext!.notices.push(appDialog('closed it'), foreignDialog);
        };

        const result = await runSuiteContext(ctx, '', [], [], opts);

        const zip = unzipSync(fs.readFileSync(result.tests[0].tracePath!));
        const rows = new TextDecoder().decode(zip['trace.json']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
          .filter((e) => e.type === 'action' && e.action === 'systemDialog');
        expect(rows.map((r) => r.detail)).toEqual(['closed it', foreignDialog.message]);
        expect(rows[0]).toMatchObject({ category: 'device', success: true });
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });
});
