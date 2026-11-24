import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectResults, runTestFile, type RunOptions, type SuiteResult, type TestResult } from '../runner.js';
import { runFileWithSessionRecovery, type FileRecoveryRun } from '../file-recovery.js';
import type { TapsmithConfig } from '../config.js';
import { isRecoverableInfrastructureError } from '../worker-protocol.js';

// The sequential CLI's file recovery (cli.ts): one retry after a recovered
// session. PILOT-1383: whatever attempt it keeps, every test of the file is in
// its results — a test the retry's abort left unrun used to vanish from the
// summary and every report.

const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
const INFRA = 'Agent connection dropped (empty response) and agent is unreachable';
let tempDir: string;

function makeOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  const config: TapsmithConfig = {
    timeout: 1_000, retries: 0, screenshot: 'never', testMatch: [],
    daemonAddress: 'localhost:50051', rootDir: '/tmp', outputDir: 'out', workers: 1, launchEmulators: false,
  };
  return {
    config, devices: [], resetCapabilities: {}, runMode: 'test', networkApisInRun: false,
    abortFileOnError: isRecoverableInfrastructureError,
    ...overrides,
  };
}

/** A file whose test bodies throw by attempt: `plan[test][attempt - 1]` — 'infra', 'fail' or 'pass'. */
function writeFile(plan: Record<string, Array<'infra' | 'fail' | 'pass'>>): string {
  const filePath = path.join(tempDir, 'loop.test.mjs');
  const tests = Object.entries(plan).map(([name, outcomes]) => `
    test(${JSON.stringify(name)}, async () => {
      const outcome = ${JSON.stringify(outcomes)}[globalThis.__pilot1383attempt - 1];
      if (outcome === 'infra') throw new Error(${JSON.stringify(INFRA)});
      if (outcome === 'fail') throw new Error('assertion failed');
    });`).join('\n');
  fs.writeFileSync(filePath, `import { test } from ${JSON.stringify(runnerUrl)};\n${tests}\n`);
  return pathToFileURL(filePath).href;
}

/** The CLI's recovery around the real runner, with a reporter that records every result. */
function recoveryRun(file: string, extra: Partial<FileRecoveryRun> = {}) {
  const reported: TestResult[] = [];
  let attempt = 0;
  const recover = vi.fn(async () => {});
  const run: FileRecoveryRun = {
    fileName: 'loop.test.mjs',
    runAttempt: async (finalFileAttempt) => {
      attempt++;
      (globalThis as Record<string, unknown>).__pilot1383attempt = attempt;
      return runTestFile(file, makeOpts({ finalFileAttempt, reporter: { onTestEnd: (r) => reported.push(r) } }));
    },
    recover,
    onTestEnd: (r) => reported.push(r),
    log: () => {},
    ...extra,
  };
  return { run, reported, recover };
}

function statuses(results: TestResult[]): Array<[string, string]> {
  return results.map((r) => [r.fullName, r.status]);
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-file-recovery-')));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__pilot1383attempt;
});

describe('runFileWithSessionRecovery (PILOT-1383)', () => {
  it('reports every test when the retry is aborted too — the persona L / P repro', async () => {
    // Attempt 1: the first test hits an agent drop, the file aborts and is
    // retried after recovery. The retry hits another one in the same test.
    const file = writeFile({
      'tab loop 1': ['infra', 'infra'],
      'tab loop 2': ['pass', 'pass'],
      'tab loop 3': ['pass', 'pass'],
    });
    const { run, reported, recover } = recoveryRun(file);

    const suite = await runFileWithSessionRecovery(run);

    expect(recover).toHaveBeenCalledTimes(1);
    expect(statuses(collectResults(suite))).toEqual([
      ['tab loop 1', 'failed'],
      ['tab loop 2', 'failed'],
      ['tab loop 3', 'failed'],
    ]);
    expect(collectResults(suite)[1].error?.message).toMatch(/^Did not run: .*"tab loop 1".*Agent connection dropped/);
    // The retry's results reach the reporters (the first attempt's one as well, as before).
    expect(statuses(reported.slice(1))).toEqual(statuses(collectResults(suite)));
  });

  it('reports every test when the retry aborts on a later test than the first attempt', async () => {
    const file = writeFile({
      one: ['infra', 'pass'],
      two: ['pass', 'infra'],
      three: ['pass', 'pass'],
    });
    const { run } = recoveryRun(file);

    const suite = await runFileWithSessionRecovery(run);

    expect(statuses(collectResults(suite))).toEqual([['one', 'passed'], ['two', 'failed'], ['three', 'failed']]);
  });

  it('keeps a retry that ran clean, with the recovered failure as flaky', async () => {
    const file = writeFile({ one: ['infra', 'pass'], two: ['pass', 'pass'] });
    const { run } = recoveryRun(file);

    const suite = await runFileWithSessionRecovery(run);

    expect(statuses(collectResults(suite))).toEqual([['one', 'passed'], ['two', 'passed']]);
    expect(collectResults(suite)[0].retry).toBe(1);
  });

  // `two` reaches maxFailures on the retry: what it left out is not a crash.
  it.each<[string, Record<string, Array<'infra' | 'fail' | 'pass'>>, Array<[string, string]>]>([
    ['leaving out the tests no attempt reached', { one: ['infra', 'pass'], two: ['pass', 'fail'], three: ['pass', 'pass'] }, [['one', 'passed'], ['two', 'failed']]],
    ['keeping the first attempt\'s results it did not reach', { one: ['pass', 'pass'], two: ['pass', 'fail'], three: ['infra', 'pass'] }, [['one', 'passed'], ['two', 'failed'], ['three', 'failed']]],
  ])('keeps a retry that maxFailures stopped, %s', async (_label, outcomes, expected) => {
    const file = writeFile(outcomes);
    let stopped = false;
    let attempt = 0;
    const { run, reported } = recoveryRun(file, {
      runAttempt: async (finalFileAttempt) => {
        (globalThis as Record<string, unknown>).__pilot1383attempt = ++attempt;
        return runTestFile(file, makeOpts({
          finalFileAttempt,
          stopRequested: () => stopped,
          reporter: {
            onTestEnd: (r) => {
              reported.push(r);
              if (r.error?.message === 'assertion failed') stopped = true;
            },
          },
        }));
      },
      stopped: () => stopped,
    });
    expect(statuses(collectResults(await runFileWithSessionRecovery(run)))).toEqual(expected);
    expect(reported.some((r) => r.error?.message.startsWith('Did not run'))).toBe(false);
  });

  it('adds the tests the first attempt left unrun when the retry crashes and the first attempt is kept', async () => {
    const file = writeFile({ one: ['infra'], two: ['pass'], three: ['pass'] });
    const base = recoveryRun(file);
    let attempt = 0;
    const { run, reported } = recoveryRun(file, {
      runAttempt: async (finalFileAttempt) => {
        attempt++;
        if (attempt === 2) throw new Error('worker fixture setup failed');
        return base.run.runAttempt(finalFileAttempt);
      },
    });

    const suite = await runFileWithSessionRecovery(run);

    expect(statuses(collectResults(suite))).toEqual([['one', 'failed'], ['two', 'failed'], ['three', 'failed']]);
    expect(collectResults(suite)[2].error?.message).toContain('Did not run');
    expect(statuses(reported)).toEqual([['two', 'failed'], ['three', 'failed']]);
    expect(statuses(base.reported)).toEqual([['one', 'failed']]);
  });

  it('adds them when the retry reports fewer results and the first attempt is kept', async () => {
    const file = writeFile({ one: ['infra'], two: ['pass'], three: ['pass'] });
    const base = recoveryRun(file);
    let attempt = 0;
    const empty: SuiteResult = { name: '', tests: [], suites: [], durationMs: 0 };
    const { run } = recoveryRun(file, {
      runAttempt: async (finalFileAttempt) => (++attempt === 2 ? empty : base.run.runAttempt(finalFileAttempt)),
    });

    const suite = await runFileWithSessionRecovery(run);

    expect(statuses(collectResults(suite))).toEqual([['one', 'failed'], ['two', 'failed'], ['three', 'failed']]);
  });

  it('keeps the first attempt over a retry that fails to load the file, counting the tests it left unrun', async () => {
    // One result (the load failure) is fewer than the first attempt's three
    // tests, even though that attempt ran only one of them.
    const file = writeFile({ one: ['infra'], two: ['pass'], three: ['pass'] });
    const base = recoveryRun(file);
    let attempt = 0;
    const loadFailure: SuiteResult = {
      name: '', durationMs: 0, suites: [],
      tests: [{ name: 'loop.test.mjs', fullName: 'loop.test.mjs', status: 'failed', durationMs: 0, error: new Error('SyntaxError: boom'), fileLevelFailure: true }],
    };
    const { run } = recoveryRun(file, {
      runAttempt: async (finalFileAttempt) => (++attempt === 2 ? loadFailure : base.run.runAttempt(finalFileAttempt)),
    });

    const suite = await runFileWithSessionRecovery(run);

    expect(statuses(collectResults(suite))).toEqual([['one', 'failed'], ['two', 'failed'], ['three', 'failed']]);
    expect(collectResults(suite)[0].error?.message).toContain('Agent connection dropped');
  });

  it('rethrows a non-infrastructure error from the first attempt without retrying', async () => {
    const recover = vi.fn(async () => {});
    await expect(runFileWithSessionRecovery({
      fileName: 'x', runAttempt: async () => { throw new Error('boom'); }, recover, onTestEnd: () => {}, log: () => {},
    })).rejects.toThrow('boom');
    expect(recover).not.toHaveBeenCalled();
  });
});
