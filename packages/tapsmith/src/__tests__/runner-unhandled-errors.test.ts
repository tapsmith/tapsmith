import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectResults,
  runTestFile,
  type RunOptions,
} from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import { runnerClaimsUnhandledRejection } from '../unhandled-errors.js';
import { TestEndedError } from '../attempt-fence.js';
import { Device } from '../device.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import type { NetworkRouteManager } from '../network.js';

// PILOT-543: a promise a test never awaits (typically a waitForResponse()
// left behind by a step that failed) used to reject unhandled and kill the
// whole run. While a file runs, the runner owns unhandled rejections and
// fails the test they happen in — only that test.

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'never',
    testMatch: [],
    daemonAddress: 'localhost:50051',
    rootDir: '/tmp',
    outputDir: 'out',
    workers: 1,
    launchEmulators: false,
    ...overrides,
  };
}

function makeOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  return { config: makeConfig(), devices: [], resetCapabilities: {}, runMode: 'test', ...overrides };
}

const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
let tempDir: string;
let savedRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
let savedExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];

function writeFile(name: string, source: string): string {
  const filePath = path.join(tempDir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `import { test, describe } from ${JSON.stringify(runnerUrl)};\n${source}`);
  return filePath;
}

/** Let Node run its unhandled-rejection check (after the microtask queue drains). */
const SETTLE = 'await new Promise((r) => setTimeout(r, 10));';

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-unhandled-')));
  // Vitest's own listeners would report the deliberate rejections below as
  // errors of this test file; the runner's are what is under test (it stays
  // installed once a file has run, so it is left in place).
  savedRejectionListeners = process.listeners('unhandledRejection')
    .filter((l) => l.name !== 'onUnhandledRejection');
  savedExceptionListeners = process.listeners('uncaughtException');
  for (const l of savedRejectionListeners) process.removeListener('unhandledRejection', l);
  process.removeAllListeners('uncaughtException');
});

afterEach(() => {
  for (const l of savedRejectionListeners) process.on('unhandledRejection', l);
  for (const l of savedExceptionListeners) process.on('uncaughtException', l);
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runTestFile — unhandled errors during a test (PILOT-543)', () => {
  it('fails only the test whose promise rejected unhandled, and runs the rest', async () => {
    const filePath = writeFile('a.test.mjs', `
      test('leaves a rejection behind', async () => {
        Promise.reject(new Error('waitForResponse timed out after 30000ms'));
        ${SETTLE}
      });
      test('runs after it', async () => {});
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts()));

    expect(results.map((r) => [r.fullName, r.status])).toEqual([
      ['leaves a rejection behind', 'failed'],
      ['runs after it', 'passed'],
    ]);
    expect(results[0].error!.message).toBe('waitForResponse timed out after 30000ms');
  });

  it('keeps the test\'s own failure as the headline and lists the unhandled error after it', async () => {
    const filePath = writeFile('b.test.mjs', `
      test('fails, then its waiter rejects', async () => {
        Promise.reject(new Error('waitForResponse timed out after 30000ms'));
        ${SETTLE}
        throw new Error('Element not found: button "Missing"');
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe(
      'Element not found: button "Missing"\n\n--- Additionally ---\n'
      + 'Unhandled error during the test: waitForResponse timed out after 30000ms',
    );
  });

  it('leaves uncaught exceptions alone: swallowing one could hang a hook awaiting its callback', async () => {
    const filePath = writeFile('c.test.mjs', `
      test('observes the listeners', async () => {
        globalThis.__pilot543Listeners = process.listenerCount('uncaughtException');
      });
    `);

    try {
      const [result] = collectResults(await runTestFile(filePath, makeOpts()));
      expect(result.status).toBe('passed');
      expect((globalThis as Record<string, unknown>).__pilot543Listeners).toBe(0);
    } finally {
      delete (globalThis as Record<string, unknown>).__pilot543Listeners;
    }
  });

  it('wraps a rejection with a non-Error value', async () => {
    const filePath = writeFile('d.test.mjs', `
      test('rejects with a string', async () => {
        Promise.reject('nope');
        ${SETTLE}
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe('Unhandled rejection with a non-Error value: "nope"');
  });

  it('gives a retry its own scope: an error in the first attempt does not fail the second', async () => {
    const filePath = writeFile('e.test.mjs', `
      let attempt = 0;
      test('flaky', async () => {
        if (attempt++ === 0) Promise.reject(new Error('first attempt only'));
        ${SETTLE}
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts({ config: makeConfig({ retries: 1 }) })));

    expect(result.status).toBe('passed');
    expect(result.retry).toBe(1);
  });

  it('fails the scope like a throwing beforeAll when the error happens during beforeAll', async () => {
    const filePath = writeFile('f.test.mjs', `
      describe('scope', () => {
        test.beforeAll(async () => {
          Promise.reject(new Error('rejected during beforeAll'));
          ${SETTLE}
        });
        test('one', async () => {});
        test('two', async () => {});
      });
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts()));

    expect(results.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(results[0].error!.message).toMatch(/rejected during beforeAll/);
  });

  it('prints an error raised outside any test and carries on', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const filePath = writeFile('g.test.mjs', `
      test.afterAll(async () => {
        Promise.reject(new Error('rejected during afterAll'));
        ${SETTLE}
      });
      test('passes', async () => {});
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts()));

    expect(results.map((r) => r.status)).toEqual(['passed']);
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain(`Unhandled rejection outside a test in ${filePath}`);
    expect(printed).toContain('rejected during afterAll');
  });

  it('does not blame the running test for a leftover of a test that already ended', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const filePath = writeFile('j.test.mjs', `
      test('forgets to await an action', async () => {
        // Stands in for an un-awaited device action that fails late.
        new Promise((_, reject) => setTimeout(() => reject(new Error('late tap failure')), 30));
      });
      test('is running when it fails', async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts()));

    expect(results.map((r) => r.status)).toEqual(['passed', 'passed']);
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain(`Unhandled rejection from a test that has already ended in ${filePath}`);
    expect(printed).toContain('late tap failure');
  });

  it('still fails the test whose own leftover rejects during its afterEach', async () => {
    const filePath = writeFile('k.test.mjs', `
      test.afterEach(async () => { await new Promise((r) => setTimeout(r, 80)); });
      test('leftover rejects after the body', async () => {
        new Promise((_, reject) => setTimeout(() => reject(new Error('rejected during afterEach')), 20));
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe('rejected during afterEach');
  });

  it('notes a refused call from an ended test without failing anything', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fenceUrl = pathToFileURL(path.resolve('src/attempt-fence.ts')).href;
    const filePath = writeFile('l.test.mjs', `
      import { TestEndedError } from ${JSON.stringify(fenceUrl)};
      test('a fenced call nobody awaited', async () => {
        Promise.reject(new TestEndedError("'tap'"));
        ${SETTLE}
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('passed');
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(
      `A call from a test that has already ended in ${filePath} was refused (an action the test did not await?)`,
    );
    // The CLI's fatal handler must leave it alone even outside a file.
    expect(runnerClaimsUnhandledRejection(new TestEndedError())).toBe(true);
  });

  it('claims unhandled rejections only while a file runs', async () => {
    const filePath = writeFile('h.test.mjs', `
      test('observes ownership', async () => {
        if (!globalThis.__pilot543Claims()) throw new Error('runner did not claim rejections during the test');
      });
    `);
    (globalThis as Record<string, unknown>).__pilot543Claims = () => runnerClaimsUnhandledRejection(new Error('x'));
    try {
      const [result] = collectResults(await runTestFile(filePath, makeOpts()));
      expect(result.status).toBe('passed');
    } finally {
      delete (globalThis as Record<string, unknown>).__pilot543Claims;
    }

    expect(runnerClaimsUnhandledRejection(new Error('x'))).toBe(false);
  });

  it('releases ownership when the file fails to load', async () => {
    const filePath = writeFile('i.test.mjs', `import './missing-helper.mjs';`);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.fileLevelFailure).toBe(true);
    expect(runnerClaimsUnhandledRejection(new Error('x'))).toBe(false);
  });

  it('reports a leftover of the file\'s last test that fails after the file ended, without crashing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const filePath = writeFile('m.test.mjs', `
      test('last test forgets to await', async () => {
        new Promise((_, reject) => setTimeout(() => reject(new Error('failed after the file ended')), 30));
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));
    await new Promise((r) => setTimeout(r, 80));

    expect(result.status).toBe('passed');
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('Unhandled rejection from a test that has already ended');
    expect(printed).toContain('failed after the file ended');
  });

  it('an async describe that rejects after a sibling describe failed the load does not crash the process', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const filePath = writeFile('o.test.mjs', `
      describe('a', async () => {
        await new Promise((r) => setTimeout(r, 30));
        throw new Error('late async describe rejection');
      });
      describe('b', () => { throw new Error('sync describe throw'); });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));
    // With the runner's listener the only one, an unhandled late rejection
    // would be rethrown here and take the worker down.
    await new Promise((r) => setTimeout(r, 80));

    expect(result).toMatchObject({ status: 'failed', fileLevelFailure: true });
    expect(result.error!.message).toBe('sync describe throw');
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).not.toContain('late async describe rejection');
  });

  it('leaves a rejection outside any file to the other listeners', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const other = vi.fn();
    process.on('unhandledRejection', other);
    try {
      // Make sure the runner's listener is installed.
      await runTestFile(writeFile('n.test.mjs', `test('t', async () => {});`), makeOpts());
      Promise.reject(new Error('not a test\'s'));
      await new Promise((r) => setTimeout(r, 10));

      expect(other).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).not.toContain('not a test');
    } finally {
      process.removeListener('unhandledRejection', other);
    }
  });
});

describe('runTestFile — network waiters end with their test (PILOT-543)', () => {
  function makeRealDevice(): Device {
    const client = {
      waitForIdle: async () => ({ success: true }),
      _setAbortSignal: () => {},
      // The runner starts capture on a test's first network wait (PILOT-775).
      startNetworkCapture: async () => ({ success: true, proxyPort: 1, errorMessage: '' }),
      stopNetworkCapture: async () => ({ success: true, entries: [], errorMessage: '' }),
    } as unknown as TapsmithGrpcClient;
    const device = new Device(client, { timeout: 30_000 });
    device._routeManager = {
      addRequestListener: () => {},
      removeRequestListener: () => {},
      addResponseListener: () => {},
      removeResponseListener: () => {},
      hasRoutes: false,
      ensureEventsSubscribed: () => {},
      takeHandlerCalls: () => 0,
      dispose: async () => {},
    } as unknown as NetworkRouteManager;
    return device;
  }

  it('a waiter a failed test never awaited does not fail the next test when its timeout passes', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const filePath = writeFile('w.test.mjs', `
      test('loads products', async ({ device }) => {
        const p = device.waitForResponse('**/products?*', { timeout: 30 });
        throw new Error('Element not found: button "Missing"');
        await p;
      });
      test('runs past the waiter timeout', async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts({
      devices: [{ name: 'device-1', device: makeRealDevice() }],
    })));

    expect(results.map((r) => [r.fullName, r.status])).toEqual([
      ['loads products', 'failed'],
      ['runs past the waiter timeout', 'passed'],
    ]);
    expect(results[0].error!.message).toBe('Element not found: button "Missing"');
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).not.toContain('waitForResponse timed out');
  });

  it('a waiter that times out while its test still runs fails that test', async () => {
    const filePath = writeFile('x.test.mjs', `
      test('forgets to await', async ({ device }) => {
        device.waitForResponse('**/never', { timeout: 20 });
        await new Promise((r) => setTimeout(r, 80));
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts({
      devices: [{ name: 'device-1', device: makeRealDevice() }],
    })));

    expect(result.status).toBe('failed');
    // The proxy only came up with the wait itself (PILOT-775), so it says so.
    expect(result.error!.message).toMatch(/^waitForResponse timed out after 20ms\. The network proxy started on demand with this wait/);
    // The stack points at the call in the test, for the reporter's code frame.
    expect(result.error!.stack).toContain('x.test.mjs');
  });
});
