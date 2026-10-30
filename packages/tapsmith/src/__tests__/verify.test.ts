import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import { pickVerifyTarget, formatVerifyFailure, cleanupVerifySmokeTest, scaffoldVerifySmokeTest, summarizeVerifyReport, noTestsRanError, grepRefusalError, runVerify, stderrTail, configLoadFix } from '../verify.js';
import { TapsmithNotInstalledError } from '../config.js';

// runVerify spawns the real `tapsmith test`; the tests below replace that
// child with one that writes a canned JSON report. Every other spawnSync call
// (none today) goes to the real implementation.
const spawnSyncMock = vi.hoisted(() => ({ impl: undefined as undefined | ((opts: SpawnSyncOptions) => number) }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (cmd: string, args: readonly string[], opts: SpawnSyncOptions): SpawnSyncReturns<Buffer> => {
      if (!spawnSyncMock.impl) return actual.spawnSync(cmd, args, opts) as SpawnSyncReturns<Buffer>;
      const status = spawnSyncMock.impl(opts);
      return { pid: 1, output: [], stdout: Buffer.from(''), stderr: Buffer.from(''), status, signal: null };
    },
  };
});

describe('pickVerifyTarget()', () => {
  it('prefers example.test.ts', () => {
    const files = ['/p/tests/login.test.ts', '/p/tests/example.test.ts'];
    expect(pickVerifyTarget(files)).toBe('/p/tests/example.test.ts');
  });

  it("prefers init's example.tapsmith.ts (PILOT-554), then an older init's example.test.ts", () => {
    const files = ['/p/tests/example.test.ts', '/p/tests/login.tapsmith.ts', '/p/tests/example.tapsmith.ts'];
    expect(pickVerifyTarget(files)).toBe('/p/tests/example.tapsmith.ts');
  });

  it('falls back to the first file', () => {
    expect(pickVerifyTarget(['/p/tests/b.test.ts', '/p/tests/a.test.ts'])).toBe('/p/tests/b.test.ts');
  });

  it('returns undefined for empty list', () => {
    expect(pickVerifyTarget([])).toBeUndefined();
  });
});

describe('summarizeVerifyReport()', () => {
  const report = {
    stats: { total: 2, passed: 1, failed: 1, skipped: 0, duration: 4200, startTime: '2026-06-10T00:00:00Z' },
    suites: [{
      name: 'example.test.ts',
      duration: 4200,
      tests: [
        { name: 'a', fullName: 'a', status: 'passed' as const, duration: 2000 },
        { name: 'b', fullName: 'b', status: 'failed' as const, duration: 2200, error: { message: 'boom' }, screenshotPath: '/s.png' },
      ],
      suites: [],
    }],
  };

  it('flattens failures from nested suites', () => {
    const summary = summarizeVerifyReport(report);
    expect(summary).toMatchObject({ ok: false, passed: 1, failed: 1, skipped: 0, duration: 4200 });
    expect(summary.failures).toEqual([{ fullName: 'b', error: 'boom', screenshotPath: '/s.png' }]);
  });

  it('has exactly the documented --json keys (PILOT-270)', () => {
    // A public contract (docs/api-reference.md, CLI → JSON output); runVerify adds testFile.
    const summary = summarizeVerifyReport(report);
    expect(Object.keys(summary)).toEqual(['ok', 'passed', 'failed', 'skipped', 'duration', 'failures']);
    expect(Object.keys(JSON.parse(JSON.stringify(summary.failures[0])))).toEqual(['fullName', 'error', 'screenshotPath']);
  });

  // PILOT-933: with two projects, a failure must say which one failed.
  it('carries each failure\'s project, and the runner\'s whole message', () => {
    const message = 'Element getByRole("button", { name: "Sign in" }) was not found after waiting 5000ms. ' +
      'Nothing matches it, but on screen now this locator matches: getByDescription("Sign in") (1 element). ' +
      'To find a locator that matches, pick the element in UI mode (npx tapsmith test --ui) or check one with the MCP tool tapsmith_test_locator.';
    const twoProjects = {
      ...report,
      stats: { ...report.stats, passed: 1, failed: 1 },
      suites: [{
        ...report.suites[0],
        tests: [
          { name: 'launch', fullName: 'launch', status: 'passed' as const, duration: 1, project: 'ios' },
          { name: 'launch', fullName: 'launch', status: 'failed' as const, duration: 1, project: 'android', error: { message } },
        ],
      }],
    };
    const summary = summarizeVerifyReport(twoProjects);
    expect(summary.failures).toEqual([{ fullName: 'launch', project: 'android', error: message }]);
    expect(Object.keys(JSON.parse(JSON.stringify(summary.failures[0])))).toEqual(['fullName', 'project', 'error']);
  });

  it('reports ok on all-pass', () => {
    const allPass = { ...report, stats: { ...report.stats, failed: 0 }, suites: [{ ...report.suites[0], tests: [report.suites[0].tests[0]] }] };
    expect(summarizeVerifyReport(allPass).ok).toBe(true);
  });

  // PILOT-394: a run in which nothing executed proves nothing about the setup.
  it('is not ok when no test ran', () => {
    expect(summarizeVerifyReport(reportOf([])).ok).toBe(false);
    expect(summarizeVerifyReport(reportOf(['skipped', 'skipped'])).ok).toBe(false);
  });

  it('is ok when some tests passed and the rest were skipped', () => {
    expect(summarizeVerifyReport(reportOf(['passed', 'skipped'])).ok).toBe(true);
  });

  it('counts a flaky test (passed on retry) as having run', () => {
    // The JSON reporter records a flaky test as passed with retry > 0.
    const flaky = reportOf(['passed']);
    flaky.suites[0].tests[0] = { ...flaky.suites[0].tests[0], retry: 1 } as typeof flaky.suites[0]['tests'][0];
    const summary = summarizeVerifyReport(flaky);
    expect(summary.ok).toBe(true);
    expect(noTestsRanError(summary, 'tests/a.test.ts', false)).toBeUndefined();
  });
});

type Status = 'passed' | 'failed' | 'skipped';

function reportOf(statuses: Status[]) {
  const count = (s: Status): number => statuses.filter((x) => x === s).length;
  return {
    stats: { total: statuses.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped'), duration: 1000, startTime: '2026-10-02T00:00:00Z' },
    suites: [{
      name: 'a.test.ts',
      duration: 1000,
      tests: statuses.map((status, i) => ({
        name: `t${i}`, fullName: `t${i}`, status, duration: 10,
        ...(status === 'failed' ? { error: { message: 'boom' } } : {}),
      })),
      suites: [],
    }],
  };
}

describe('formatVerifyFailure()', () => {
  it('prefixes the line with the project when the run has projects (PILOT-933)', () => {
    expect(formatVerifyFailure({ fullName: 'app launches successfully', project: 'android', error: 'boom' }))
      .toBe('  - [android] app launches successfully: boom');
  });

  it('has no prefix without projects', () => {
    expect(formatVerifyFailure({ fullName: 'app launches successfully', error: 'boom' }))
      .toBe('  - app launches successfully: boom');
  });
});

describe('noTestsRanError()', () => {
  it('names an empty file', () => {
    const err = noTestsRanError(summarizeVerifyReport(reportOf([])), 'tests/a.test.ts', false);
    expect(err?.message).toBe('No tests ran: tests/a.test.ts has no tests');
  });

  it('reports a run whose tests were all skipped', () => {
    const err = noTestsRanError(summarizeVerifyReport(reportOf(['skipped', 'skipped'])), 'tests/a.test.ts', false);
    expect(err?.message).toBe('No tests ran: running tests/a.test.ts skipped all 2 test(s)');
  });

  it('points at what can cause it: skipped tests and a grep, not file selection', () => {
    // The file was selected: an unselected one exits "No tests found."
    // before any report is written (RUN_FAILED), so testMatch is not the cause.
    const err = noTestsRanError(summarizeVerifyReport(reportOf(['skipped'])), 'tests/a.test.ts', false);
    expect(err?.fix).toMatch(/test\.skip/);
    expect(err?.fix).toMatch(/grep/);
    expect(err?.fix).not.toMatch(/testMatch/);
  });

  it('does not name the throwaway smoke test, which is deleted by then', () => {
    const file = 'tests/tapsmith-verify-abc/smoke.test.ts';
    const err = noTestsRanError(summarizeVerifyReport(reportOf(['skipped'])), file, true);
    expect(err?.message).toMatch(/throwaway smoke test/);
    expect(err?.message).not.toContain(file);
    expect(err?.fix).not.toContain(file);
    expect(err?.fix).toMatch(/grep/);
  });

  it('is undefined when a test passed or failed', () => {
    expect(noTestsRanError(summarizeVerifyReport(reportOf(['passed', 'skipped'])), 'a', false)).toBeUndefined();
    // Failures alone are a failed run (the ok:false result), not "nothing ran".
    expect(noTestsRanError(summarizeVerifyReport(reportOf(['failed', 'skipped'])), 'a', false)).toBeUndefined();
  });
});

// PILOT-394: verify used to report ok, exit 0, when the run executed nothing.
describe('runVerify() outcome by what the run executed', () => {
  let dir: string;
  let cwd: string;
  let exitCode: typeof process.exitCode;
  let stdout: MockInstance<typeof process.stdout.write>;
  let log: MockInstance<typeof console.log>;
  let errLog: MockInstance<typeof console.error>;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-verify-run-')));
    fs.writeFileSync(path.join(dir, 'tapsmith.config.mjs'), 'export default {}\n');
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'tests', 'a.test.ts'), '// test file\n');
    cwd = process.cwd();
    exitCode = process.exitCode;
    process.exitCode = undefined;
    process.chdir(dir);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSyncMock.impl = undefined;
    stdout.mockRestore();
    log.mockRestore();
    errLog.mockRestore();
    process.chdir(cwd);
    process.exitCode = exitCode;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const childReports = (statuses: Status[], exitStatus = 0): void => {
    spawnSyncMock.impl = (opts) => {
      const file = (opts.env as NodeJS.ProcessEnv).TAPSMITH_JSON_OUTPUT_FILE!;
      fs.writeFileSync(file, JSON.stringify(reportOf(statuses)));
      return exitStatus;
    };
  };
  const jsonOut = (): Record<string, unknown> => {
    expect(stdout).toHaveBeenCalledTimes(1);
    return JSON.parse(String(stdout.mock.calls[0]?.[0])) as Record<string, unknown>;
  };

  it('--json: a file with no tests is NO_TESTS_RAN in the error envelope, exit 1', async () => {
    childReports([]);
    await runVerify({ json: true });
    const out = jsonOut();
    expect(Object.keys(out)).toEqual(['error']);
    const error = out.error as Record<string, string>;
    expect(Object.keys(error)).toEqual(['code', 'message', 'fix']);
    expect(error.code).toBe('NO_TESTS_RAN');
    expect(error.message).toBe(`No tests ran: ${path.join('tests', 'a.test.ts')} has no tests`);
    expect(process.exitCode).toBe(1);
  });

  it('text: every test skipped fails with the message and fix, never "Setup verified"', async () => {
    childReports(['skipped', 'skipped']);
    await runVerify({ json: false });
    const errors = errLog.mock.calls.map((c) => String(c[0]));
    expect(errors[0]).toBe(`✗ No tests ran: running ${path.join('tests', 'a.test.ts')} skipped all 2 test(s)`);
    expect(errors[1]).toMatch(/^→ .*test\.skip/);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/Setup verified/);
    expect(process.exitCode).toBe(1);
  });

  it('--json: a grep that filters out every test (the child writes its report, then exits 1) is NO_TESTS_RAN', async () => {
    childReports(['skipped'], 1);
    await runVerify({ json: true });
    expect((jsonOut().error as Record<string, string>).code).toBe('NO_TESTS_RAN');
    expect(process.exitCode).toBe(1);
  });

  it('--json: a passing run is still the ok result, exit code unset', async () => {
    childReports(['passed', 'skipped']);
    await runVerify({ json: true });
    expect(jsonOut()).toMatchObject({ ok: true, passed: 1, skipped: 1, failed: 0, testFile: path.join('tests', 'a.test.ts') });
    expect(process.exitCode).toBeUndefined();
  });

  it('text: a failing test in a project is listed under its project name (PILOT-933)', async () => {
    spawnSyncMock.impl = (opts) => {
      const report = reportOf(['passed', 'failed']);
      report.suites[0].tests = report.suites[0].tests.map((t, i) => ({ ...t, project: i === 0 ? 'ios' : 'android' }));
      fs.writeFileSync((opts.env as NodeJS.ProcessEnv).TAPSMITH_JSON_OUTPUT_FILE!, JSON.stringify(report));
      return 1;
    };
    await runVerify({ json: false });
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('✗ Verification failed: 1 of 2 test(s) failed');
    expect(lines).toContain('  - [android] t1: boom');
    expect(process.exitCode).toBe(1);
  });

  it('--json: a failing run is still the ok:false result, not NO_TESTS_RAN', async () => {
    childReports(['failed']);
    await runVerify({ json: true });
    expect(jsonOut()).toMatchObject({ ok: false, failed: 1 });
    expect(process.exitCode).toBe(1);
  });
});

describe('scaffoldVerifySmokeTest()', () => {
  it('creates a unique temporary test without overwriting the legacy smoke filename', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-verify-test-'));
    const testDir = path.join(tmp, 'tests');
    const legacy = path.join(testDir, 'tapsmith-verify-smoke.test.ts');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(legacy, 'user test');

    try {
      const scaffolded = scaffoldVerifySmokeTest(testDir, 'generated test');

      expect(scaffolded.file).not.toBe(legacy);
      expect(fs.readFileSync(legacy, 'utf8')).toBe('user test');
      expect(fs.readFileSync(scaffolded.file, 'utf8')).toBe('generated test');
      expect(path.dirname(scaffolded.file)).toBe(scaffolded.tempDir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The throwaway file is run by name, and a run with projects runs a named
  // file only when a project's testMatch covers it (PILOT-553), so its name
  // follows the config's testMatch: init's configs match only *.tapsmith.ts (PILOT-554).
  it.each([
    { testMatch: ['**/*.tapsmith.ts'], name: 'smoke.tapsmith.ts' },
    { testMatch: ['**/*.test.ts', '**/*.spec.ts'], name: 'smoke.test.ts' },
    { testMatch: ['**/*.spec.ts'], name: 'smoke.spec.ts' },
    { testMatch: ['tests/**/*.tapsmith.ts'], name: 'smoke.tapsmith.ts' },
    // Nothing the scaffold could be called matches: the historical name.
    { testMatch: ['e2e/**/*.ts'], name: 'smoke.test.ts' },
  ])('names the smoke test $name for testMatch $testMatch', ({ testMatch, name }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-verify-test-'));
    const testDir = path.join(tmp, 'tests');
    fs.mkdirSync(testDir);
    try {
      const scaffolded = scaffoldVerifySmokeTest(testDir, 'generated test', { testMatch, rootDir: tmp });
      expect(path.basename(scaffolded.file)).toBe(name);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('cleans a test directory created before scaffolding fails', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-verify-test-'));
    const testDir = path.join(tmp, 'tests');
    fs.mkdirSync(testDir);

    try {
      cleanupVerifySmokeTest(undefined, true, testDir);
      expect(fs.existsSync(testDir)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// A config that exists but cannot be loaded is a CONFIG_ERROR (PILOT-262).
// The fix must point at the file: `init --yes` refuses to overwrite it.
describe('runVerify() with a config that fails to load', () => {
  it('reports CONFIG_ERROR naming the file, with a fix that does not suggest init', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-verify-cfg-')));
    const cwd = process.cwd();
    const exitCode = process.exitCode;
    const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const file = path.join(dir, 'tapsmith.config.mjs');
      fs.writeFileSync(file, 'throw new Error("boom")\n');
      process.chdir(dir);
      await runVerify({ json: true });
      const out = JSON.parse(String(log.mock.calls[0]?.[0])) as { error: { code: string; message: string; fix: string } };
      expect(out.error.code).toBe('CONFIG_ERROR');
      expect(out.error.message).toContain(`Failed to load config file ${file}: boom`);
      expect(out.error.fix).not.toMatch(/init/);
      expect(Object.keys(out.error)).toEqual(['code', 'message', 'fix']);
    } finally {
      log.mockRestore();
      process.chdir(cwd);
      process.exitCode = exitCode;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // `npx tapsmith init` writes a config importing tapsmith into a project
  // that may not have it; "fix the config" sent users to the wrong place
  // (PILOT-551). (Vitest's own resolver finds `tapsmith` from any directory,
  // so this cannot go through a real load here; config.test.ts covers that.)
  it('gives the install command when the config imports tapsmith and the project lacks it', () => {
    const err = new TapsmithNotInstalledError(
      '/p/tapsmith.config.ts',
      { command: 'yarn', args: ['add', '-D', 'tapsmith'], display: 'yarn add -D tapsmith' },
      new Error("Cannot find module 'tapsmith'"),
    );
    expect(configLoadFix(err)).toBe('Run: yarn add -D tapsmith');
    expect(configLoadFix(new Error('boom'))).not.toMatch(/init|install/);
  });
});


describe('stderrTail()', () => {
  it('strips ANSI codes before cutting, so no half escape sequence is left', () => {
    const stderr = '\x1b[31mFatal';
    // Cutting the raw text to 7 characters would leave "1mFatal".
    expect(stderr.slice(-7)).toBe('1mFatal');
    expect(stderrTail(stderr, 7)).toBe('Fatal');
  });
});

describe('grepRefusalError()', () => {
  const stderr = '\u001b[31mNo tests found: no test matches grep /zzzz/.\nChecked 1 test in 1 test file\u001b[39m\n';

  it('reads the run\'s early grep refusal as NO_TESTS_RAN', () => {
    const err = grepRefusalError(stderr, 'tests/a.test.ts', false);
    expect(err?.message).toBe('No tests ran: tests/a.test.ts was filtered out (No tests found: no test matches grep /zzzz/.)');
    expect(err?.fix).toMatch(/grep/);
  });

  it('does not name the throwaway smoke test', () => {
    expect(grepRefusalError(stderr, 'tests/tapsmith-verify-x/smoke.test.ts', true)?.message).not.toContain('tapsmith-verify');
  });

  it('leaves any other failure, and uncaptured stderr, to RUN_FAILED', () => {
    expect(grepRefusalError('Error: daemon failed to start', 'tests/a.test.ts', false)).toBeUndefined();
    expect(grepRefusalError(undefined, 'tests/a.test.ts', false)).toBeUndefined();
  });
});
