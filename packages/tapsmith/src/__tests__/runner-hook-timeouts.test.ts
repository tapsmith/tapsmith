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
import { STOPPED_BY_USER } from '../abort.js';

// PILOT-583: hooks used to run unbounded, so a beforeAll/beforeEach/afterEach/
// afterAll awaiting something that never settles hung the whole run — no
// failure, no summary. Each hook now gets a budget equal to the test timeout
// (the config `timeout` × 3), like the test body, and a hook that runs out of
// it fails with an error naming the hook.

/** config.timeout 50 → a 150 ms test (and hook) budget. */
const ACTION_TIMEOUT = 50;
const BUDGET = ACTION_TIMEOUT * 3;

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: ACTION_TIMEOUT,
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
  return { config: makeConfig(), devices: [], resetCapabilities: {}, runMode: 'test', networkApisInRun: false, ...overrides };
}

const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
const fenceUrl = pathToFileURL(path.resolve('src/attempt-fence.ts')).href;
const progressUrl = pathToFileURL(path.resolve('src/action-progress.ts')).href;
let tempDir: string;

function writeFile(name: string, source: string): string {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(
    filePath,
    `import { test, describe, beforeAll, afterAll, beforeEach, afterEach } from ${JSON.stringify(runnerUrl)};\n`
    + `import { isCurrentAttemptClosed } from ${JSON.stringify(fenceUrl)};\n`
    + `import { withActionProgress } from ${JSON.stringify(progressUrl)};\n`
    + `const never = () => new Promise(() => {});\n`
    + `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n`
    + `const slowDeviceAction = (ms) => withActionProgress('restartApp', undefined, () => sleep(ms));\n`
    + source,
  );
  return filePath;
}

function stderrText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c) => String(c[0])).join('');
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-hook-timeouts-')));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).__pilot583;
});

describe('runTestFile — hook timeouts (PILOT-583)', () => {
  it('fails every test of the scope when a beforeAll never settles, naming the hook', async () => {
    const filePath = writeFile('before-all.test.mjs', `
      describe('scope', () => {
        beforeAll(async () => { await never(); });
        test('one', async () => {});
        test('two', async () => {});
      });
      test('outside the scope', async () => {});
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts()));

    // (A file's own tests are reported before its describes'.)
    expect(results.map((r) => [r.fullName, r.status])).toEqual([
      ['outside the scope', 'passed'],
      ['scope > one', 'failed'],
      ['scope > two', 'failed'],
    ]);
    expect(results[1].error!.message).toBe(
      `"beforeAll" hook at before-all.test.mjs:9 timed out after ${BUDGET}ms`,
    );
    // The stack points at the hook, so reporters show its code frame.
    expect(results[1].error!.stack).toContain(`${filePath}:9`);
  });

  it('fails the test when a beforeEach never settles, and still runs afterEach and the next test', async () => {
    const filePath = writeFile('before-each.test.mjs', `
      globalThis.__pilot583 = [];
      let calls = 0;
      beforeEach(async () => { if (calls++ === 0) await never(); });
      afterEach(async () => { globalThis.__pilot583.push('afterEach'); });
      test('hangs in setup', async () => { globalThis.__pilot583.push('body 1'); });
      test('next', async () => { globalThis.__pilot583.push('body 2'); });
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts()));

    expect(results.map((r) => [r.fullName, r.status])).toEqual([
      ['hangs in setup', 'failed'],
      ['next', 'passed'],
    ]);
    expect(results[0].error!.message).toBe(
      `"beforeEach" hook at before-each.test.mjs:10 timed out after ${BUDGET}ms`,
    );
    expect((globalThis as Record<string, unknown>).__pilot583).toEqual(['afterEach', 'body 2', 'afterEach']);
  });

  it('fails a passing test when an afterEach never settles, and still runs the remaining afterEach hooks', async () => {
    const filePath = writeFile('after-each.test.mjs', `
      globalThis.__pilot583 = [];
      describe('scope', () => {
        afterEach(async () => { await never(); });
        test('passes its body', async () => {});
      });
      afterEach(async () => { globalThis.__pilot583.push('outer afterEach'); });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe(
      `"afterEach" hook at after-each.test.mjs:10 timed out after ${BUDGET}ms`,
    );
    expect((globalThis as Record<string, unknown>).__pilot583).toEqual(['outer afterEach']);
  });

  it('keeps a failed test\'s own error first and adds the afterEach timeout after it', async () => {
    const filePath = writeFile('after-each-failed.test.mjs', `
      afterEach(async () => { await never(); });
      test('fails', async () => { throw new Error('Element not found'); });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe(
      'Element not found\n\n--- Additionally ---\n'
      + `"afterEach" hook at after-each-failed.test.mjs:8 timed out after ${BUDGET}ms`,
    );
  });

  it('reports an afterAll that never settles like a throwing afterAll, and the run finishes', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const filePath = writeFile('after-all.test.mjs', `
      describe('scope', () => {
        afterAll(async () => { await never(); });
        test('one', async () => {});
      });
      test('after the scope', async () => {});
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts()));

    expect(results.map((r) => [r.fullName, r.status])).toEqual([
      ['after the scope', 'passed'],
      ['scope > one', 'passed'],
    ]);
    expect(stderrText(stderr)).toContain(
      `[tapsmith] afterAll hook error: "afterAll" hook at after-all.test.mjs:9 timed out after ${BUDGET}ms`,
    );
  });

  it('lets a slow hook that finishes within the budget pass', async () => {
    const filePath = writeFile('slow.test.mjs', `
      beforeAll(async () => { await sleep(${BUDGET / 3}); });
      beforeEach(async () => { await sleep(${BUDGET / 3}); });
      afterEach(async () => { await sleep(${BUDGET / 3}); });
      test('passes', async () => {});
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('passed');
  });

  it('gives each hook its own budget rather than sharing one across hooks', async () => {
    const filePath = writeFile('each-own-budget.test.mjs', `
      beforeEach(async () => { await sleep(${Math.round(BUDGET * 0.6)}); });
      beforeEach(async () => { await sleep(${Math.round(BUDGET * 0.6)}); });
      test('passes', async () => {});
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('passed');
  });

  it('applies a scope\'s larger test.use({ timeout }) to its hooks', async () => {
    const filePath = writeFile('scope-timeout.test.mjs', `
      describe('scope', () => {
        test.use({ timeout: ${BUDGET * 3} });
        beforeEach(async () => { await sleep(${BUDGET * 2}); });
        test('passes', async () => {});
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('passed');
  });

  it('does not count time inside slow device actions against a hook\'s budget, as for a test body', async () => {
    const filePath = writeFile('device-action.test.mjs', `
      beforeEach(async () => { await slowDeviceAction(${BUDGET * 2}); });
      test('passes', async () => {});
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('passed');
  });

  it('names the registration line of a hook registered on a test.extend() result', async () => {
    const filePath = writeFile('extended.test.mjs', `
      const extended = test.extend({ answer: async ({}, use) => { await use(42); } });
      extended.beforeEach(async ({ answer }) => { await never(); });
      extended('t', async ({ answer }) => {});
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe(
      `"beforeEach" hook at extended.test.mjs:9 timed out after ${BUDGET}ms`,
    );
  });

  it('still tears down the fixtures of a beforeAll that timed out', async () => {
    const filePath = writeFile('fixture-teardown.test.mjs', `
      globalThis.__pilot583 = [];
      const extended = test.extend({
        resource: async ({}, use) => { await use('r'); globalThis.__pilot583.push('torn down'); },
      });
      describe('scope', () => {
        extended.beforeAll(async ({ resource }) => { await never(); });
        extended('t', async () => {});
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('failed');
    expect((globalThis as Record<string, unknown>).__pilot583).toEqual(['torn down']);
  });

  it('fences a timed-out hook: calls it makes afterwards are refused like a timed-out test body\'s', async () => {
    const filePath = writeFile('fence.test.mjs', `
      beforeEach(async () => {
        await sleep(${BUDGET * 2});
        globalThis.__pilot583 = isCurrentAttemptClosed();
      });
      test('hangs in setup', async () => {});
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));
    await new Promise((r) => setTimeout(r, BUDGET * 2));

    expect(result.status).toBe('failed');
    expect((globalThis as Record<string, unknown>).__pilot583).toBe(true);
  });

  it('does not fence a hook that finished: work it started for the test keeps running', async () => {
    const filePath = writeFile('no-fence.test.mjs', `
      let pending;
      beforeEach(async () => {
        pending = sleep(10).then(() => isCurrentAttemptClosed());
      });
      test('awaits what the hook started', async () => {
        globalThis.__pilot583 = await pending;
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('passed');
    expect((globalThis as Record<string, unknown>).__pilot583).toBe(false);
  });

  it('keeps a stopped test reported as stopped when its afterEach then times out', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const controller = new AbortController();
    const filePath = writeFile('abort-after-each.test.mjs', `
      afterEach(async () => { await never(); });
      test('stopped mid-body', async () => { await never(); });
    `);

    setTimeout(() => controller.abort(), 20);
    const [result] = collectResults(await runTestFile(filePath, makeOpts({ abortSignal: controller.signal })));

    // UI mode and MCP tell a stopped test from a failed one by this exact message.
    expect(result.error?.message).toBe(STOPPED_BY_USER);
    expect(stderrText(stderr)).toContain(
      `[tapsmith] afterEach hook error: "afterEach" hook at abort-after-each.test.mjs:8 timed out after ${BUDGET}ms`,
    );
  });

  it('stops a hung beforeAll when the run is stopped, without waiting for the timeout', async () => {
    const controller = new AbortController();
    const filePath = writeFile('abort-before-all.test.mjs', `
      beforeAll(async () => { await never(); });
      test('never starts', async () => {});
    `);

    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    await runTestFile(filePath, makeOpts({
      config: makeConfig({ timeout: 10_000 }),
      abortSignal: controller.signal,
    }));

    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('stops a hung beforeEach when the run is stopped, without waiting for the timeout', async () => {
    const controller = new AbortController();
    const filePath = writeFile('abort.test.mjs', `
      beforeEach(async () => { await never(); });
      test('hangs in setup', async () => {});
    `);

    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    const [result] = collectResults(await runTestFile(filePath, makeOpts({
      config: makeConfig({ timeout: 10_000 }),
      abortSignal: controller.signal,
    })));

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.error?.name).toBe('AbortError');
  });
});
