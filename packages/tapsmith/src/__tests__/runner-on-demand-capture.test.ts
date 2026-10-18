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

// PILOT-775: with no trace recording network, the runner starts capture on a
// device's first route() or network wait — from a test, a hook or a worker
// fixture — keeps the proxy (and its route stream) across tests and files,
// and drains it after each test. These run a real Device against a fake
// daemon client through runTestFile, the path every embedder takes.

/** A route stream that confirms each (un)registration, and records whether it was closed. */
class FakeRouteStream extends EventEmitter {
  ended = false;
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
  end(): void { this.ended = true; }
  cancel(): void { this.ended = true; }
}

function makeDevice(startResults: Array<{ success: boolean; errorMessage: string }> = []) {
  const stream = new FakeRouteStream();
  const startNetworkCapture = vi.fn(async () => ({ proxyPort: 1, ...(startResults.shift() ?? { success: true, errorMessage: '' }) }));
  const stopNetworkCapture = vi.fn(async (_opts?: { keepRunning?: boolean }) => ({ success: true, entries: [], errorMessage: '' }));
  const client = {
    waitForIdle: async () => ({ success: true }),
    _setAbortSignal: () => {},
    startNetworkCapture,
    stopNetworkCapture,
    networkRouteStream: () => stream,
  } as unknown as TapsmithGrpcClient;
  const device = new Device(client, { timeout: 30_000 });
  return { device, stream, startNetworkCapture, stopNetworkCapture };
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

function makeOpts(device: Device, config: Partial<TapsmithConfig> = {}): RunOptions {
  return {
    config: makeConfig(config),
    devices: [{ name: 'device-1', device }],
    resetCapabilities: {},
    runMode: 'test',
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
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-on-demand-')));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('runTestFile — on-demand network capture (PILOT-775)', () => {
  it('starts capture from a beforeAll route, drains after each test and at file end, and keeps the route stream', async () => {
    const { device, stream, startNetworkCapture, stopNetworkCapture } = makeDevice();
    const filePath = writeFile('a.test.mjs', `
      test.beforeAll(async ({ device }) => {
        await device.route('**/feed', (route) => route.fulfill({ json: [] }));
      });
      test('first', async () => {});
      test('second', async () => {});
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts(device)));

    expect(results.map((r) => r.status)).toEqual(['passed', 'passed']);
    expect(startNetworkCapture).toHaveBeenCalled();
    expect(device._networkProxyRunning).toBe(true);
    // Drained after each test and at the file's end, never released.
    expect(stopNetworkCapture.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [opts] of stopNetworkCapture.mock.calls) expect(opts).toEqual({ keepRunning: true });
    // The route stream survives the file, for the next file's first request.
    expect(stream.ended).toBe(false);
  });

  it("keeps a worker fixture's routes and listeners for the whole file, then removes them", async () => {
    const { device, stream } = makeDevice();
    const seen: string[] = [];
    const g = globalThis as { __pilot775?: { seen: string[]; emit: (msg: unknown) => void; routesLive: boolean[] } };
    g.__pilot775 = { seen, emit: (msg) => stream.emit('data', msg), routesLive: [] };
    const filePath = writeFile('w.test.mjs', `
      const t = test.extend({
        mocks: [async ({ device }, use) => {
          await device.route('**/config', (route) => route.fulfill({ json: {} }));
          device.on('request', (req) => globalThis.__pilot775.seen.push(req.url));
          await use(1);
        }, { scope: 'worker' }],
      });
      const probe = async (device, url) => {
        globalThis.__pilot775.routesLive.push(device._routeManager.hasRoutes);
        globalThis.__pilot775.emit({ requestEvent: { method: 'GET', url, headers: [], body: Buffer.alloc(0), isHttps: true } });
        await new Promise((r) => setTimeout(r, 1));
      };
      t('first', async ({ mocks, device }) => { await probe(device, 'https://a.test/1'); });
      t('second', async ({ mocks, device }) => { await probe(device, 'https://a.test/2'); });
    `);
    try {
      const results = collectResults(await runTestFile(filePath, makeOpts(device)));

      expect(results.map((r) => r.status)).toEqual(['passed', 'passed']);
      expect(g.__pilot775.routesLive).toEqual([true, true]);
      expect(seen).toEqual(['https://a.test/1', 'https://a.test/2']);
      // Gone with the file, so the next file's worker fixtures start clean.
      expect(device._routeManager?.hasRoutes).toBe(false);
      stream.emit('data', { requestEvent: { method: 'GET', url: 'https://a.test/3', headers: [], body: Buffer.alloc(0), isHttps: true } });
      expect(seen).toHaveLength(2);
    } finally {
      delete g.__pilot775;
    }
  });

  it("removes a worker fixture's routes and disarms on-demand capture when a later fixture throws", async () => {
    const { device } = makeDevice();
    const filePath = writeFile('x.test.mjs', `
      const t = test.extend({
        mocks: [async ({ device }, use) => {
          await device.route('**/config', (route) => route.fulfill({ json: {} }));
          await use(1);
        }, { scope: 'worker' }],
        broken: [async ({ mocks }, use) => { throw new Error('backend down'); }, { scope: 'worker' }],
      });
      t('never runs', async ({ broken }) => {});
    `);

    await runTestFile(filePath, makeOpts(device)).catch(() => undefined);

    expect(device._networkProxyRunning).toBe(true);
    expect(device._routeManager?.hasRoutes).toBe(false);
    expect((device as unknown as { _onDemandCapture: unknown })._onDemandCapture).toBeNull();
  });

  it('tries a failed start again on the retry attempt', async () => {
    const { device, startNetworkCapture } = makeDevice([{ success: false, errorMessage: 'proxy unavailable' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const filePath = writeFile('b.test.mjs', `
        test('mocks', async ({ device }) => {
          await device.route('**/feed', (route) => route.fulfill({ json: [] }));
        });
      `);

      const [result] = collectResults(await runTestFile(filePath, makeOpts(device, { retries: 1 })));

      expect(result!.status).toBe('passed');
      expect(startNetworkCapture).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('starts on demand and drains when the trace records but leaves network out', async () => {
    const { device, startNetworkCapture, stopNetworkCapture } = makeDevice();
    const filePath = writeFile('c.test.mjs', `
      test('mocks', async ({ device }) => {
        await device.route('**/feed', (route) => route.fulfill({ json: [] }));
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts(device, {
      trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false, deviceLogs: false },
    })));

    expect(result!.status).toBe('passed');
    expect(startNetworkCapture).toHaveBeenCalledTimes(1);
    expect(stopNetworkCapture).toHaveBeenCalledWith({ keepRunning: true });
  });
});
