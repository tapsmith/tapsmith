import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectResults,
  runTestFile,
  takeDeferredNotRunResults,
  test as tapsmithTest,
  _internal,
  type RunOptions,
  type TestResult,
} from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import { Tracing } from '../trace/tracing.js';
import { isRecoverableInfrastructureError } from '../worker-protocol.js';

const { pushContext, popContext, runSuiteContext, FileAbortState } = _internal;

// PILOT-1383: a file aborted by an infrastructure error (`abortFileOnError`)
// stops running its remaining tests. On the embedder's last attempt at the
// file nothing re-runs them, so each is reported as not run — before, they
// dropped out of the console summary and every report.

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 1_000,
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
  return {
    config: makeConfig(),
    devices: [],
    resetCapabilities: {},
    runMode: 'test',
    networkApisInRun: false,
    abortFileOnError: isRecoverableInfrastructureError,
    ...overrides,
  };
}

const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
const INFRA = 'Agent connection dropped (empty response) and agent is unreachable';
let tempDir: string;

function writeFile(source: string): string {
  const filePath = path.join(tempDir, 'aborted.test.mjs');
  fs.writeFileSync(
    filePath,
    `import { test, describe, afterAll } from ${JSON.stringify(runnerUrl)};\n`
    + `const ran = (globalThis.__pilot1383 ??= []);\n`
    + `const infra = () => { throw new Error(${JSON.stringify(INFRA)}); };\n`
    + source,
  );
  return pathToFileURL(filePath).href;
}

function ran(): string[] {
  return ((globalThis as Record<string, unknown>).__pilot1383 as string[] | undefined) ?? [];
}

function summary(results: TestResult[]): Array<[string, string]> {
  return results.map((r) => [r.fullName, r.status]);
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-file-abort-')));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__pilot1383;
});

describe('runTestFile — tests a file abort leaves unrun (PILOT-1383)', () => {
  it('on the last attempt, reports every unrun test as failed, naming the error that stopped the file', async () => {
    const file = writeFile(`
      test('tab loop 1', async () => { ran.push('1'); infra(); });
      test('tab loop 2', async () => { ran.push('2'); });
      test('tab loop 3', async () => { ran.push('3'); });
    `);
    const onTestEnd = vi.fn();

    const suite = await runTestFile(file, makeOpts({ finalFileAttempt: true, reporter: { onTestEnd } }));

    expect(ran()).toEqual(['1']);
    const results = collectResults(suite);
    expect(summary(results)).toEqual([
      ['tab loop 1', 'failed'],
      ['tab loop 2', 'failed'],
      ['tab loop 3', 'failed'],
    ]);
    expect(results[0].error?.message).toBe(INFRA);
    for (const r of results.slice(1)) {
      expect(r.error?.message).toBe(
        `Did not run: the file was stopped by an infrastructure error in "tab loop 1" that Tapsmith could not recover from: ${INFRA}`,
      );
      // No stack frames: they would point into the runner, not at the test.
      expect(r.error?.stack).toBe(`Error: ${r.error?.message}`);
      expect(r.filePath).toBe(results[0].filePath);
      expect(r.durationMs).toBe(0);
    }
    // Every reporter (console, JUnit, JSON, blob, HTML) is fed from these.
    expect(onTestEnd.mock.calls.map(([r]) => [r.fullName, r.status])).toEqual(summary(results));
  });

  it('reports the unrun tests of later describes, keeping test.skip, .only and filters as they would have run', async () => {
    const file = writeFile(`
      describe('first', () => {
        test('breaks', async () => { ran.push('breaks'); infra(); });
        test('after', async () => { ran.push('after'); });
      });
      describe('second', () => {
        test('runnable', async () => { ran.push('runnable'); });
        test.skip('skipped', async () => {});
        test('filtered out', async () => {});
        describe('nested', () => {
          test('deep', async () => { ran.push('deep'); });
        });
      });
      describe.skip('skipped describe', () => {
        test('inside', async () => {});
      });
    `);

    const suite = await runTestFile(file, makeOpts({
      finalFileAttempt: true,
      grepInvert: [/filtered out/],
    }));

    expect(ran()).toEqual(['breaks']);
    expect(summary(collectResults(suite))).toEqual([
      ['first > breaks', 'failed'],
      ['first > after', 'failed'],
      ['second > runnable', 'failed'],
      ['second > skipped', 'skipped'],
      ['second > nested > deep', 'failed'],
      ['skipped describe > inside', 'skipped'],
    ]);
    const deep = collectResults(suite).find((r) => r.fullName === 'second > nested > deep');
    expect(deep?.error?.message).toContain('Did not run');
    const skipped = collectResults(suite).find((r) => r.fullName === 'second > skipped');
    expect(skipped?.error).toBeUndefined();
  });

  it('honours .only in the unrun part of the file', async () => {
    const file = writeFile(`
      test.only('focused breaks', async () => { ran.push('focused'); infra(); });
      test('unfocused', async () => { ran.push('unfocused'); });
      test.only('focused later', async () => { ran.push('later'); });
    `);

    const suite = await runTestFile(file, makeOpts({ finalFileAttempt: true }));

    expect(summary(collectResults(suite))).toEqual([
      ['focused breaks', 'failed'],
      ['unfocused', 'skipped'],
      ['focused later', 'failed'],
    ]);
  });

  it('still runs afterAll hooks after the abort', async () => {
    const file = writeFile(`
      afterAll(() => { ran.push('afterAll'); });
      test('breaks', async () => { ran.push('breaks'); infra(); });
      test('unrun', async () => { ran.push('unrun'); });
    `);

    const suite = await runTestFile(file, makeOpts({ finalFileAttempt: true }));

    expect(ran()).toEqual(['breaks', 'afterAll']);
    expect(collectResults(suite)).toHaveLength(2);
  });

  it('on an attempt the embedder will retry, holds the unrun tests back for it instead of reporting them', async () => {
    const file = writeFile(`
      test('breaks', async () => { infra(); });
      test('unrun 1', async () => {});
      test('unrun 2', async () => {});
    `);
    const onTestEnd = vi.fn();

    const suite = await runTestFile(file, makeOpts({ reporter: { onTestEnd } }));

    // The retry re-runs the whole file: the first attempt reports only what ran.
    expect(summary(collectResults(suite))).toEqual([['breaks', 'failed']]);
    expect(onTestEnd).toHaveBeenCalledTimes(1);
    // An embedder that falls back to this attempt's results takes them, once.
    const deferred = takeDeferredNotRunResults(suite);
    expect(summary(deferred)).toEqual([['unrun 1', 'failed'], ['unrun 2', 'failed']]);
    expect(deferred[0].error?.message).toContain('Did not run');
    expect(takeDeferredNotRunResults(suite)).toEqual([]);
  });

  it('holds nothing back when no file abort happened', async () => {
    const file = writeFile(`
      test('fails normally', async () => { throw new Error('assertion'); });
      test('runs', async () => {});
    `);

    const suite = await runTestFile(file, makeOpts());

    expect(summary(collectResults(suite))).toEqual([['fails normally', 'failed'], ['runs', 'passed']]);
    expect(takeDeferredNotRunResults(suite)).toEqual([]);
  });

  it('reports nothing for the untouched tests when the user stops the run (PILOT-222)', async () => {
    const stop = new AbortController();
    (globalThis as Record<string, unknown>).__pilot1383stop = () => stop.abort();
    const file = writeFile(`
      test('stopped in', async () => { ran.push('stopped'); globalThis.__pilot1383stop(); infra(); });
      test('untouched', async () => { ran.push('untouched'); });
    `);
    try {
      const suite = await runTestFile(file, makeOpts({ finalFileAttempt: true, abortSignal: stop.signal }));

      expect(ran()).toEqual(['stopped']);
      expect(collectResults(suite).map((r) => r.fullName)).toEqual(['stopped in']);
      expect(takeDeferredNotRunResults(suite)).toEqual([]);
    } finally {
      delete (globalThis as Record<string, unknown>).__pilot1383stop;
    }
  });
});

describe('runSuiteContext — a not-run test is not a test that ran (PILOT-1383)', () => {
  it('attributes the afterAll trace re-tag to the test that ran, not to an unrun one after it', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-file-abort-retag-'));
    const mockDevice = {
      tracing: new Tracing(async () => undefined, async () => undefined),
      waitForIdle: vi.fn(async () => {}),
      _stopDeviceLogStream: vi.fn(),
      _startDeviceLogStream: vi.fn(),
      _startDaemonLogStream: vi.fn(),
      _stopDaemonLogStream: vi.fn(),
    };
    const attributed: string[] = [];
    const fileAbort = new FileAbortState(undefined);
    try {
      pushContext();
      tapsmithTest.afterAll(async () => {});
      tapsmithTest('breaks', async () => { throw new Error(INFRA); });
      tapsmithTest('unrun', async () => {});
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({
          rootDir: tempRoot,
          trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner lifecycle mock
        devices: [{ name: 'device-1', device: mockDevice as any }],
        finalFileAttempt: true,
        _fileAbort: fileAbort,
        abortSignal: fileAbort.signal,
        onTestStart: async (fullName, options) => {
          if (options?.attributionOnly) attributed.push(fullName);
        },
      }));

      expect(summary(collectResults(result))).toEqual([['breaks', 'failed'], ['unrun', 'failed']]);
      expect(attributed).toEqual(['breaks']);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
