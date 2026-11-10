import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectResults, runTestFile, type RunOptions } from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import { Device } from '../device.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';

// PILOT-1013: a run whose test files use the network APIs starts each
// device's proxy when its file runs first — before worker fixtures, hooks
// and the first test's app reset — so connections the app opens from then on
// go through it. Once per device; a run that uses none starts nothing.

class FakeRouteStream extends EventEmitter {
  write(msg: unknown): boolean {
    const m = msg as { registerRoute?: { routeId?: string }; unregisterRoute?: { routeId?: string } };
    const registered = m.registerRoute?.routeId;
    if (registered) {
      queueMicrotask(() => this.emit('data', { registerRouteResponse: { routeId: registered, success: true, errorMessage: '' } }));
    }
    const unregistered = m.unregisterRoute?.routeId;
    if (unregistered) {
      queueMicrotask(() => this.emit('data', { unregisterRouteResponse: { routeId: unregistered, success: true } }));
    }
    return true;
  }
  end(): void {}
  cancel(): void {}
}

const g = globalThis as { __pilot1013?: string[] };

function makeDevice(startResults: Array<{ success: boolean; errorMessage: string }> = []) {
  const stream = new FakeRouteStream();
  const startNetworkCapture = vi.fn(async (_opts?: { requireIsolation?: boolean; httpPorts?: number[] }) => {
    g.__pilot1013?.push('start');
    return { proxyPort: 1, ...(startResults.shift() ?? { success: true, errorMessage: '' }) };
  });
  const stopNetworkCapture = vi.fn(async () => ({ success: true, entries: [], errorMessage: '' }));
  const client = {
    waitForIdle: async () => ({ success: true }),
    _setAbortSignal: () => {},
    startNetworkCapture,
    stopNetworkCapture,
    networkRouteStream: () => stream,
  } as unknown as TapsmithGrpcClient;
  const device = new Device(client, { timeout: 30_000 });
  return { device, startNetworkCapture };
}

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'never',
    testMatch: [],
    daemonAddress: 'localhost:50051',
    rootDir: tempDir,
    outputDir: 'out',
    workers: 1,
    launchEmulators: false,
    ...overrides,
  };
}

function makeOpts(devices: Device[], networkApisInRun: boolean, config: Partial<TapsmithConfig> = {}): RunOptions {
  return {
    config: makeConfig(config),
    devices: devices.map((device, i) => ({ name: `device-${i + 1}`, device })),
    resetCapabilities: {},
    runMode: 'test',
    networkApisInRun,
  };
}

const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
let tempDir: string;

function writeFile(name: string, source: string): string {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, `import { test, describe } from ${JSON.stringify(runnerUrl)};\n${source}`);
  return filePath;
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-session-net-')));
  g.__pilot1013 = [];
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete g.__pilot1013;
});

describe('runTestFile — network capture at session start (PILOT-1013)', () => {
  it('starts the proxy before worker fixtures, hooks and tests when the run uses network APIs', async () => {
    const { device } = makeDevice();
    const filePath = writeFile('plain.test.mjs', `
      const t = test.extend({
        w: [async ({}, use) => { globalThis.__pilot1013.push('worker fixture'); await use(1); }, { scope: 'worker' }],
      });
      t.beforeAll(async () => { globalThis.__pilot1013.push('beforeAll'); });
      t('direct traffic', async ({ w }) => { globalThis.__pilot1013.push('test'); });
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts([device], true)));

    expect(results.map((r) => r.status)).toEqual(['passed']);
    expect(g.__pilot1013![0]).toBe('start');
    expect(g.__pilot1013!.indexOf('worker fixture')).toBeGreaterThan(0);
    expect(device._networkProxyRunning).toBe(true);
  });

  it('leaves a later route() with a proxy that was already up: no start mid-test', async () => {
    const { device, startNetworkCapture } = makeDevice();
    const filePath = writeFile('mock.test.mjs', `
      test('mocks', async ({ device }) => {
        globalThis.__pilot1013.push('before route');
        await device.route('**/posts', (route) => route.fulfill({ status: 500 }));
        globalThis.__pilot1013.push('after route');
      });
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts([device], true)));

    expect(results.map((r) => r.status)).toEqual(['passed']);
    const log = g.__pilot1013!;
    expect(log.slice(log.indexOf('before route'))).toEqual(['before route', 'after route']);
    expect(startNetworkCapture.mock.calls.length).toBeGreaterThan(0);
    // The proxy was up before the test, so no "started mid-test" reason.
    expect(device._takeProxyStartedOnDemand()).toBe(false);
  });

  it('starts nothing for a run that uses no network APIs', async () => {
    const { device, startNetworkCapture } = makeDevice();
    const filePath = writeFile('plain.test.mjs', `test('a', async () => {}); test('b', async () => {});`);

    const results = collectResults(await runTestFile(filePath, makeOpts([device], false)));

    expect(results.map((r) => r.status)).toEqual(['passed', 'passed']);
    expect(startNetworkCapture).not.toHaveBeenCalled();
    expect(device._networkProxyRunning).toBe(false);
  });

  it('tries once per device: a failed start is not retried at the next file, only on demand', async () => {
    const { device, startNetworkCapture } = makeDevice([{ success: false, errorMessage: 'no redirector' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const a = writeFile('a.test.mjs', `test('a', async () => {});`);
      const b = writeFile('b.test.mjs', `test('b', async () => {});`);

      await runTestFile(a, makeOpts([device], true));
      await runTestFile(b, makeOpts([device], true));

      expect(startNetworkCapture).toHaveBeenCalledTimes(1);
      // The failure is reported as any failed start is.
      expect(warn.mock.calls.flat().join('\n')).toContain('no redirector');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not start again on a device a session open already tried', async () => {
    const { device, startNetworkCapture } = makeDevice();
    expect(device._claimSessionNetworkStart()).toBe(true);
    const filePath = writeFile('a.test.mjs', `test('a', async () => {});`);

    await runTestFile(filePath, makeOpts([device], true));

    expect(startNetworkCapture).not.toHaveBeenCalled();
  });

  it("reports the session open's failed start at the first file, and does not start it again", async () => {
    const { device, startNetworkCapture } = makeDevice([{ success: false, errorMessage: 'redirector not approved' }]);
    await device._startNetworkProxyForSession({ requireIsolation: false });
    expect(startNetworkCapture).toHaveBeenCalledTimes(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const filePath = writeFile('a.test.mjs', `test('a', async () => {});`);
      await runTestFile(filePath, makeOpts([device], true));

      expect(startNetworkCapture).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.flat().join('\n')).toContain('redirector not approved');
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the session open's start without starting again before the first test", async () => {
    const { device, startNetworkCapture } = makeDevice();
    await device._startNetworkProxyForSession({ requireIsolation: false });
    const filePath = writeFile('a.test.mjs', `test('a', async () => { globalThis.__pilot1013.push('test'); });`);

    await runTestFile(filePath, makeOpts([device], true));

    // The open's start, then the per-test start every running proxy gets.
    expect(g.__pilot1013).toEqual(['start', 'start', 'test']);
    expect(startNetworkCapture).toHaveBeenCalledTimes(2);
  });

  it('starts every device of a group, each asking for device isolation', async () => {
    const first = makeDevice();
    const second = makeDevice();
    const filePath = writeFile('group.test.mjs', `test('a', async () => {});`);

    await runTestFile(filePath, makeOpts([first.device, second.device], true, {
      trace: { mode: 'off', networkHttpPorts: [8080] },
      devices: [{ name: 'device-1' }, { name: 'device-2' }],
    }));

    for (const { startNetworkCapture } of [first, second]) {
      expect(startNetworkCapture).toHaveBeenCalled();
      expect(startNetworkCapture.mock.calls[0]![0]).toEqual({ requireIsolation: true, httpPorts: [8080] });
    }
  });
});
