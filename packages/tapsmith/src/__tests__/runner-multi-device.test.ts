import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import {
  test as tapsmithTest,
  describe as tapsmithDescribe,
  collectResults,
  runTestFile,
  _internal,
  type RunDevice,
  type RunOptions,
} from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import type { SessionPreflightContext } from '../session-preflight.js';
import type { PreparedState } from '../app-reset.js';
import { Tracing } from '../trace/tracing.js';
import { getActiveTraceCollector } from '../trace/trace-collector.js';
import { telemetry } from '../telemetry.js';

const { pushContext, popContext, runSuiteContext } = _internal;

// A test that drives two devices at once (PILOT-310). The runner holds the
// whole group: every device is reset, checked, timed and screenshotted, and
// tests reach the members through the `devices` fixture.

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
    devices: [{ name: 'alice' }, { name: 'bob' }],
    ...overrides,
  };
}

function makeDevice(name: string) {
  const calls: string[] = [];
  const record = (op: string) => vi.fn(async (..._args: unknown[]) => { calls.push(op); });
  let timeoutMs = 30_000;
  const device = {
    _traceDeviceId: name,
    _client: { _setAbortSignal: vi.fn() },
    tracing: new Tracing(async () => Buffer.from(`${name}-png`), async () => undefined),
    waitForIdle: vi.fn(async () => {}),
    takeScreenshot: vi.fn(async () => ({ success: true, data: Buffer.from(`${name}-shot`) })),
    startAgent: record('startAgent'),
    terminateApp: record('terminateApp'),
    launchApp: record('launchApp'),
    restartApp: record('restartApp'),
    clearAppData: record('clearAppData'),
    restoreAppState: record('restoreAppState'),
    openDeepLink: record('openDeepLink'),
    _resetApp: vi.fn(async (_pkg: string, opts: { mode?: 'warm' | 'restart' | 'clear' }) => {
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
    _getDefaultTimeout: () => timeoutMs,
    _setDefaultTimeout: vi.fn((ms: number) => { timeoutMs = ms; }),
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
    waitForAppReady: vi.fn(async () => ({ requestId: '1', ready: true, supported: true })),
  };
  const sessionContext: SessionPreflightContext = {
    label: name,
    config: makeConfig(),
    device: device as unknown as SessionPreflightContext['device'],
    client: client as unknown as SessionPreflightContext['client'],
    notices: [],
    relaunches: { count: 0 },
  };
  const runDevice: RunDevice = {
    name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner double
    device: device as any,
    serial: `emulator-${name}`,
    sessionContext,
  };
  return { device, client, calls, runDevice };
}

function makeOpts(group: ReturnType<typeof makeDevice>[], config: TapsmithConfig, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    config,
    devices: group.map((g) => g.runDevice),
    resetCapabilities: {},
    runMode: 'test', networkApisInRun: false,
    _applied: {},
    _prepared: new Map(),
    ...extra,
  };
}

describe('runner refuses a group that does not match the project', () => {
  // `use.devices` is project-level. An embedder that resolved the group from
  // the root config hands a two-device project one device; the file must not
  // run with a `devices` fixture missing the member its tests destructure.
  it('fails the file when the embedder handed fewer devices than `use.devices` declares', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-group-size-'));
    const filePath = path.join(tempDir, 'pair.mjs');
    const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
    try {
      fs.writeFileSync(filePath, `
        import { test } from ${JSON.stringify(runnerUrl)};
        test('chat', async ({ devices }) => { await devices[1].tap(); });
      `);
      const alice = makeDevice('alice');
      await expect(runTestFile(pathToFileURL(filePath).href, makeOpts([alice], makeConfig({ devices: undefined }), {
        projectName: 'pair',
        projectUseOptions: { devices: [{ name: 'alice' }, { name: 'bob' }] },
        bustImportCache: true,
      }))).rejects.toThrow(/Project "pair" declares a device group of 2 .* was given 1 device\(s\) \(alice=emulator-alice\)/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails the file when a single-device project is handed a whole group', async () => {
    // A worker holds its target's largest group; an embedder that forgot to
    // slice hands a solo project both devices, and its trace would name a
    // device the project never declared. The same check catches it.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-group-size-solo-'));
    const filePath = path.join(tempDir, 'solo.mjs');
    const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
    try {
      fs.writeFileSync(filePath, `
        import { test } from ${JSON.stringify(runnerUrl)};
        test('one', async () => {});
      `);
      const alice = makeDevice('alice');
      const bob = makeDevice('bob');
      await expect(runTestFile(pathToFileURL(filePath).href, makeOpts([alice, bob], makeConfig({ devices: undefined }), {
        projectName: 'solo',
        bustImportCache: true,
      }))).rejects.toThrow(/Project "solo" declares no device group \(a single device\) but the run was given 2 device\(s\) \(alice=emulator-alice, bob=emulator-bob\)/);
      // A root-level `devices` counts as the project's declaration. (A second
      // path: two imports of one URL in the same millisecond share the module
      // cache despite `bustImportCache`, and register nothing.)
      const rootedPath = path.join(tempDir, 'solo-rooted.mjs');
      fs.copyFileSync(filePath, rootedPath);
      const rooted = await runTestFile(pathToFileURL(rootedPath).href, makeOpts([alice, bob], makeConfig({ devices: 2 }), {
        bustImportCache: true,
      }));
      expect(collectResults(rooted).map((t) => t.status)).toEqual(['passed']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('names the run\'s devices after the project\'s group, and restores the embedder\'s names afterwards', async () => {
    // A worker holds its target's largest group (`alice`, `bob`). A project on
    // that target declaring no group runs on `alice`, but its trace must not
    // name a device it never declared: it runs as `device-1`, untagged, and
    // the session goes back to `alice` for the next group file.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-device-names-'));
    const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
    try {
      const soloPath = path.join(tempDir, 'solo.mjs');
      fs.writeFileSync(soloPath, `
        import { test } from ${JSON.stringify(runnerUrl)};
        test('one', async ({ device, devices }) => {
          globalThis.__tapsmithSeen = { tag: device._traceDeviceId, count: devices.length };
        });
      `);
      const alice = makeDevice('alice');
      const bob = makeDevice('bob');
      const soloOpts = makeOpts([alice], makeConfig({ devices: undefined }), { projectName: 'solo', bustImportCache: true });
      const solo = await runTestFile(pathToFileURL(soloPath).href, soloOpts);
      expect(collectResults(solo).map((t) => t.status)).toEqual(['passed']);
      const seen = (globalThis as { __tapsmithSeen?: { tag?: string; count: number } }).__tapsmithSeen;
      expect(seen).toEqual({ tag: undefined, count: 1 });
      // Restored once the file is done.
      expect(alice.device._traceDeviceId).toBe('alice');
      expect(soloOpts.devices[0].name).toBe('alice');

      // A declared group names by position: `devices: 2` on sessions the
      // embedder opened as alice/bob runs as device-1/device-2 …
      const pairPath = path.join(tempDir, 'pair.mjs');
      fs.writeFileSync(pairPath, `
        import { test } from ${JSON.stringify(runnerUrl)};
        test('two', async ({ devices }) => {
          globalThis.__tapsmithSeen = { tags: devices.map((d) => d._traceDeviceId) };
        });
      `);
      const pairOpts = makeOpts([alice, bob], makeConfig({ devices: undefined }), {
        projectUseOptions: { devices: 2 }, bustImportCache: true,
      });
      const pair = await runTestFile(pathToFileURL(pairPath).href, pairOpts);
      expect(collectResults(pair).map((t) => t.status)).toEqual(['passed']);
      expect((globalThis as { __tapsmithSeen?: { tags: string[] } }).__tapsmithSeen).toEqual({ tags: ['device-1', 'device-2'] });
      expect(pairOpts.devices.map((d) => d.name)).toEqual(['alice', 'bob']);
      expect([alice.device._traceDeviceId, bob.device._traceDeviceId]).toEqual(['alice', 'bob']);

      // … and a group declared with the sessions' own names leaves them as they are.
      const namedPath = path.join(tempDir, 'named.mjs');
      fs.copyFileSync(pairPath, namedPath);
      const namedOpts = makeOpts([alice, bob], makeConfig({ devices: undefined }), {
        projectUseOptions: { devices: [{ name: 'alice' }, { name: 'bob' }] }, bustImportCache: true,
      });
      await runTestFile(pathToFileURL(namedPath).href, namedOpts);
      expect((globalThis as { __tapsmithSeen?: { tags: string[] } }).__tapsmithSeen).toEqual({ tags: ['alice', 'bob'] });
    } finally {
      delete (globalThis as { __tapsmithSeen?: unknown }).__tapsmithSeen;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs a group that matches, and a single-device project without `use.devices`', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-group-size-ok-'));
    const filePath = path.join(tempDir, 'solo.mjs');
    const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
    try {
      fs.writeFileSync(filePath, `
        import { test } from ${JSON.stringify(runnerUrl)};
        test('one', async () => {});
      `);
      const alice = makeDevice('alice');
      const bob = makeDevice('bob');
      const paired = await runTestFile(pathToFileURL(filePath).href, makeOpts([alice, bob], makeConfig({ devices: undefined }), {
        projectUseOptions: { devices: 2 },
        bustImportCache: true,
      }));
      expect(collectResults(paired).map((t) => t.status)).toEqual(['passed']);
      // A second file: two imports of one URL in the same millisecond share
      // the module cache despite `bustImportCache`, and register nothing.
      const soloPath = path.join(tempDir, 'solo-again.mjs');
      fs.copyFileSync(filePath, soloPath);
      const solo = await runTestFile(pathToFileURL(soloPath).href, makeOpts([alice], makeConfig({ devices: undefined }), {
        bustImportCache: true,
      }));
      expect(collectResults(solo).map((t) => t.status)).toEqual(['passed']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('runner with a device group', () => {
  it('exposes the group as the `devices` fixture with `device` aliasing the primary', async () => {
    const alice = makeDevice('alice');
    const bob = makeDevice('bob');
    let seen: { device: unknown; devices: unknown[] } | undefined;
    pushContext();
    tapsmithTest('pair', async ({ device, devices }) => { seen = { device, devices }; });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts([alice, bob], makeConfig()));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed']);
    expect(seen?.devices).toHaveLength(2);
    expect(seen?.devices[0]).toBe(alice.device);
    expect(seen?.devices[1]).toBe(bob.device);
    expect(seen?.device).toBe(alice.device);
  });

  it('resets every device of the group on file entry, and waits for all of them before each test', async () => {
    const alice = makeDevice('alice');
    const bob = makeDevice('bob');
    pushContext();
    tapsmithTest('one', async () => {});
    const ctx = popContext();

    await runSuiteContext(ctx, '', [], [], makeOpts([alice, bob], makeConfig()));

    expect(alice.calls).toEqual(['resetApp:clear']);
    expect(bob.calls).toEqual(['resetApp:clear']);
    expect(alice.device.waitForIdle).toHaveBeenCalledWith(1_000);
    expect(bob.device.waitForIdle).toHaveBeenCalledWith(1_000);
    // Readiness is verified on both daemons.
    expect(alice.client.ping).toHaveBeenCalled();
    expect(bob.client.ping).toHaveBeenCalled();
  });

  it('runs the group reset concurrently, not one device after the other', async () => {
    const alice = makeDevice('alice');
    const bob = makeDevice('bob');
    let inFlight = 0;
    let maxInFlight = 0;
    for (const d of [alice, bob]) {
      d.device._resetApp.mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { modeRequested: 'clear', modeUsed: 'clear', fellBack: false, coldLaunch: true, durationMs: 20, hooksDetected: false, steps: [] };
      });
    }
    pushContext();
    tapsmithTest('one', async () => {});
    const ctx = popContext();

    await runSuiteContext(ctx, '', [], [], makeOpts([alice, bob], makeConfig()));

    expect(maxInFlight).toBe(2);
  });

  it('consumes prepared state per device: a prepared member skips its reset while the other resets', async () => {
    const alice = makeDevice('alice');
    const bob = makeDevice('bob');
    const prepared: PreparedState = {
      policy: { mode: 'clear', scope: 'file' }, preparedAt: Date.now(), durationMs: 900, source: 'startup launch',
    };
    pushContext();
    tapsmithTest('one', async () => {});
    const ctx = popContext();

    const holder = new Map([['alice', prepared]]);
    await runSuiteContext(ctx, '', [], [], makeOpts([alice, bob], makeConfig(), { _prepared: holder }));

    expect(alice.calls).toEqual([]);
    expect(bob.calls).toEqual(['resetApp:clear']);
    // Consumed exactly once: the test body then touched the apps, so neither
    // member's state is reusable by a later reset.
    expect(holder.get('alice')).toBeUndefined();
    expect(holder.get('bob')).toBeUndefined();
  });

  it('applies a scope timeout to every device and restores it afterwards', async () => {
    const alice = makeDevice('alice');
    const bob = makeDevice('bob');
    pushContext();
    tapsmithDescribe('slow', () => {
      tapsmithTest.use({ timeout: 60_000 });
      tapsmithTest('one', async () => {
        expect(alice.device._getDefaultTimeout()).toBe(60_000);
        expect(bob.device._getDefaultTimeout()).toBe(60_000);
      });
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts([alice, bob], makeConfig()));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed']);
    expect(alice.device._getDefaultTimeout()).toBe(30_000);
    expect(bob.device._getDefaultTimeout()).toBe(30_000);
  });

  it('captures a failure screenshot from every device, suffixing the members by name', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-multi-shots-'));
    try {
      const alice = makeDevice('alice');
      const bob = makeDevice('bob');
      pushContext();
      tapsmithTest('boom', async () => { throw new Error('nope'); });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts([alice, bob], makeConfig({ screenshot: 'only-on-failure' }), {
        screenshotDir: tempRoot,
      }));

      const [test] = collectResults(result);
      expect(test.status).toBe('failed');
      const files = fs.readdirSync(tempRoot).sort();
      expect(files).toHaveLength(2);
      expect(files.some((f) => f.startsWith('boom-') && !f.includes('-bob-'))).toBe(true);
      expect(files.some((f) => f.startsWith('boom-bob-'))).toBe(true);
      expect(test.screenshotPath && path.basename(test.screenshotPath)).toMatch(/^boom-\d+\.png$/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('records one trace for the test naming every device, with events tagged by the acting device', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-multi-trace-'));
    try {
      const alice = makeDevice('alice');
      const bob = makeDevice('bob');
      pushContext();
      tapsmithTest('chat', async () => {
        // Stand-ins for the tagged events Device/ElementHandle emit through the
        // shared active collector.
        const collector = getActiveTraceCollector()!;
        collector.addActionEvent({
          category: 'tap', action: 'tap', duration: 1, success: true, deviceId: 'alice',
          hasScreenshotBefore: false, hasScreenshotAfter: false, hasHierarchyBefore: false, hasHierarchyAfter: false,
        });
        collector.addAssertionEvent({
          assertion: 'toBeVisible', passed: true, soft: false, negated: false, duration: 1, attempts: 1, deviceId: 'bob',
        });
      });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts([alice, bob], makeConfig({
        rootDir: tempRoot,
        trace: { mode: 'on', network: false, screenshots: true, snapshots: false, sources: false },
      })));

      const [test] = collectResults(result);
      expect(test.status).toBe('passed');
      const zip = unzipSync(fs.readFileSync(test.tracePath!));
      const metadata = JSON.parse(new TextDecoder().decode(zip['metadata.json']));
      expect(metadata.device.serial).toBe('emulator-alice');
      expect(metadata.devices.map((d: { name: string; serial: string }) => [d.name, d.serial])).toEqual([
        ['alice', 'emulator-alice'],
        ['bob', 'emulator-bob'],
      ]);
      const events = new TextDecoder().decode(zip['trace.json']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      const tagged = events.filter((e) => e.type === 'action' || e.type === 'assertion');
      expect(tagged.map((e) => e.deviceId)).toEqual(['alice', 'bob']);
      // Both devices' terminal screenshots are kept, on distinct indices.
      const shots = Object.keys(zip).filter((k) => k.startsWith('screenshots/')).sort();
      expect(shots).toEqual([
        `screenshots/action-${String(metadata.actionCount).padStart(3, '0')}-before.png`,
        `screenshots/action-${String(metadata.actionCount + 1).padStart(3, '0')}-before.png`,
      ]);
      expect(new TextDecoder().decode(zip[shots[0]])).toBe('alice-png');
      expect(new TextDecoder().decode(zip[shots[1]])).toBe('bob-png');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('refuses test.use({ devices }) with the project-level fix', () => {
    pushContext();
    expect(() => tapsmithTest.use({ devices: 2 })).toThrow(/Declare it on a project instead/);
    popContext();
  });
});

describe('runner reports one anonymous telemetry event per file (PILOT-330)', () => {
  it('records mode, platform, group size and counts — and nothing identifying', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-telemetry-'));
    const filePath = path.join(tempDir, 'mixed.mjs');
    const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
    const recordRun = vi.spyOn(telemetry, 'recordRun').mockImplementation(() => undefined);
    try {
      fs.writeFileSync(filePath, `
        import { test } from ${JSON.stringify(runnerUrl)};
        test('secret feature works', async () => {});
        test('secret feature fails', async () => { throw new Error('nope'); });
        test.skip('secret feature skipped', async () => {});
      `);
      const alice = makeDevice('alice');
      const bob = makeDevice('bob');
      const config = makeConfig({ devices: 2, platform: 'ios' });
      const suite = await runTestFile(pathToFileURL(filePath).href, makeOpts([alice, bob], config, {
        runMode: 'test-parallel',
        bustImportCache: true,
      }));
      expect(collectResults(suite).map((t) => t.status).sort()).toEqual(['failed', 'passed', 'skipped']);

      expect(recordRun).toHaveBeenCalledTimes(1);
      const [cfg, event] = recordRun.mock.calls[0];
      // The runner hands over the config it ran with, so `telemetry: false` reaches the client.
      expect(cfg).toBe(config);
      expect(event).toEqual({
        mode: 'test-parallel',
        platform: 'ios',
        devices: 2,
        tests: 3,
        passed: 1,
        failed: 1,
        skipped: 1,
        durationMs: expect.any(Number),
      });
      // Belt and braces: no test name, path, or serial anywhere in the event.
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain(tempDir);
      expect(serialized).not.toContain('emulator-');
    } finally {
      recordRun.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('on a retry-capable path, does not report an attempt with a recoverable infrastructure failure (PILOT-330 review)', async () => {
    // The CLI / parallel / UI paths set abortFileOnError and retry such a file;
    // reporting the discarded attempt would emit a second event and inflate
    // `failed`. The runner must skip it there.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-telemetry-infra-'));
    const filePath = path.join(tempDir, 'flaky.mjs');
    const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
    const recordRun = vi.spyOn(telemetry, 'recordRun').mockImplementation(() => undefined);
    try {
      fs.writeFileSync(filePath, `
        import { test } from ${JSON.stringify(runnerUrl)};
        test('hits an agent drop', async () => { throw new Error('Agent connection dropped'); });
      `);
      const alice = makeDevice('alice');
      const suite = await runTestFile(pathToFileURL(filePath).href, makeOpts([alice], makeConfig({ devices: undefined }), {
        runMode: 'test-parallel',
        abortFileOnError: () => true,
        bustImportCache: true,
      }));
      expect(collectResults(suite).map((t) => t.status)).toEqual(['failed']);
      expect(recordRun).not.toHaveBeenCalled();
    } finally {
      recordRun.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('on a non-retry path (watch/mcp), still reports a single infra-degraded run (PILOT-330 review 2)', async () => {
    // watch-run runs a file exactly once with in-place recovery and no
    // abortFileOnError, so its infra-degraded run is the real outcome and must
    // be counted — the retry-only skip must not swallow it.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-telemetry-infra-watch-'));
    const filePath = path.join(tempDir, 'flaky.mjs');
    const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
    const recordRun = vi.spyOn(telemetry, 'recordRun').mockImplementation(() => undefined);
    try {
      fs.writeFileSync(filePath, `
        import { test } from ${JSON.stringify(runnerUrl)};
        test('hits an agent drop', async () => { throw new Error('Agent connection dropped'); });
      `);
      const alice = makeDevice('alice');
      await runTestFile(pathToFileURL(filePath).href, makeOpts([alice], makeConfig({ devices: undefined }), {
        runMode: 'watch',
        bustImportCache: true,
      }));
      expect(recordRun).toHaveBeenCalledTimes(1);
      expect(recordRun.mock.calls[0][1]).toMatchObject({ mode: 'watch', tests: 1, failed: 1, passed: 0 });
    } finally {
      recordRun.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports nothing for a file with no devices (the runner\'s own unit tests)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-telemetry-nodev-'));
    const filePath = path.join(tempDir, 'nodev.mjs');
    const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
    const recordRun = vi.spyOn(telemetry, 'recordRun').mockImplementation(() => undefined);
    try {
      fs.writeFileSync(filePath, `
        import { test } from ${JSON.stringify(runnerUrl)};
        test('one', async () => {});
      `);
      await runTestFile(pathToFileURL(filePath).href, makeOpts([], makeConfig(), { bustImportCache: true }));
      expect(recordRun).not.toHaveBeenCalled();
    } finally {
      recordRun.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('system-dialog warnings in a device group (PILOT-398)', () => {
  it('names the device whose app showed the dialog', async () => {
    const alice = makeDevice('alice');
    const bob = makeDevice('bob');
    pushContext();
    tapsmithTest('pair', async () => {});
    const ctx = popContext();
    const opts = makeOpts([alice, bob], makeConfig({ appReset: 'none' }));
    opts.beforeEachTest = async () => {
      bob.runDevice.sessionContext!.notices.push({ kind: 'app-dialog', title: 'App keeps stopping', message: 'closed it', timestamp: Date.now() });
    };

    const result = await runSuiteContext(ctx, '', [], [], opts);

    expect(collectResults(result)[0].warnings).toEqual(['[bob] closed it']);
  });
});
