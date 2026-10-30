/**
 * `tapsmith verify` — end-to-end smoke proof of the configured setup.
 *
 * Spawns the real `tapsmith test` path (daemon spawn, emulator launch, app
 * install all included) on a single test file with the JSON reporter
 * redirected to a temp file, then reports a structured verdict. If the
 * project has no test files yet, a throwaway smoke test is scaffolded and
 * cleaned up afterwards.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatJson, jsonError, stripAnsi } from './cli-json.js';
import { isTapsmithNotInstalledError } from './config.js';
import { minimatch } from 'minimatch';
import { NO_TESTS_MATCH_FILTER_PREFIX } from './test-filter.js';

// ─── Pure helpers (unit-tested) ───

export interface VerifyArgs {
  json: boolean;
  config?: string;
}

/** init's example test (PILOT-554), then the name an older init gave it. */
const EXAMPLE_TEST_NAMES = ['example.tapsmith.ts', 'example.test.ts'];

export function pickVerifyTarget(testFiles: string[]): string | undefined {
  for (const name of EXAMPLE_TEST_NAMES) {
    const example = testFiles.find((f) => path.basename(f) === name);
    if (example) return example;
  }
  return testFiles[0];
}

interface ReportTest {
  fullName: string;
  /** The project the test ran in, when the config has projects. */
  project?: string;
  status: 'passed' | 'failed' | 'skipped';
  error?: { message: string };
  screenshotPath?: string;
}

interface ReportSuite {
  tests: ReportTest[];
  suites: ReportSuite[];
}

interface VerifyReport {
  stats: { passed: number; failed: number; skipped: number; duration: number };
  suites: ReportSuite[];
}

export interface VerifySummary {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  failures: VerifyFailure[];
}

export interface VerifyFailure {
  fullName: string;
  /** The project the test failed in, when the config has projects. */
  project?: string;
  /** The runner's whole message, near-miss hint included. */
  error: string;
  screenshotPath?: string;
}

/**
 * A failure's line in verify's text output. With projects, a test runs once
 * per project, so the line names the one that failed.
 */
export function formatVerifyFailure(f: VerifyFailure): string {
  return `  - ${f.project ? `[${f.project}] ` : ''}${f.fullName}: ${f.error}`;
}

export interface ScaffoldedVerifyTest {
  file: string;
  tempDir: string;
}

export function summarizeVerifyReport(report: VerifyReport): VerifySummary {
  const failures: VerifySummary['failures'] = [];
  const walk = (suite: ReportSuite): void => {
    for (const t of suite.tests) {
      if (t.status === 'failed') {
        failures.push({ fullName: t.fullName, project: t.project, error: t.error?.message ?? 'unknown error', screenshotPath: t.screenshotPath });
      }
    }
    suite.suites.forEach(walk);
  };
  report.suites.forEach(walk);
  return {
    // A run that executed nothing proves nothing about the setup (PILOT-394).
    // A flaky test is reported as passed, so it counts as having run.
    ok: report.stats.failed === 0 && report.stats.passed > 0,
    passed: report.stats.passed,
    failed: report.stats.failed,
    skipped: report.stats.skipped,
    duration: report.stats.duration,
    failures,
  };
}

/**
 * The NO_TESTS_RAN error when the run executed no test (none in the file, or
 * every one skipped), else undefined. A run with failures did run: that is
 * the `ok: false` result, not this. Playwright fails "No tests found" the
 * same way; an all-skipped run counts too, since it proves nothing about the
 * device or the app.
 *
 * The file was selected (an unselected one never reaches a report: the run
 * exits "No tests found." and verify reports RUN_FAILED), so the causes
 * left are a file with no runnable test and a grep that filters them out.
 * The counts cover the whole run (dependency projects, or a file several
 * projects match), so the message does not pin them on the file.
 * `scaffolded`: the file is verify's own throwaway smoke test, already
 * deleted by the time the error is read, so it is not named.
 */
export function noTestsRanError(
  summary: VerifySummary,
  testFile: string,
  scaffolded: boolean,
): { message: string; fix: string } | undefined {
  if (summary.passed + summary.failed > 0) return undefined;
  const grepFix = 'a grep / grepInvert in the config (at the root or in a project) that filters out every test';
  if (scaffolded) {
    return {
      message: 'No tests ran: the throwaway smoke test verify generated (the project has no test files yet) was skipped',
      fix: `Check for ${grepFix}`,
    };
  }
  return {
    message: summary.skipped > 0
      ? `No tests ran: running ${testFile} skipped all ${summary.skipped} test(s)`
      : `No tests ran: ${testFile} has no tests`,
    fix: `Give ${testFile} a test that is not skipped: check for test.skip / describe.skip, and for ${grepFix}`,
  };
}

/**
 * The NO_TESTS_RAN error for a run that refused to start because a grep in the
 * config selects none of the file's tests — `tapsmith test` checks that before
 * any device work and writes no report — from its stderr; else
 * undefined. Without captured stderr (verify without --json inherits it) the
 * run's own message has already reached the user.
 */
export function grepRefusalError(
  stderr: string | undefined,
  testFile: string,
  scaffolded: boolean,
): { message: string; fix: string } | undefined {
  if (!stderr) return undefined;
  const line = stripAnsi(stderr).split('\n').find((l) => l.startsWith(NO_TESTS_MATCH_FILTER_PREFIX));
  if (!line) return undefined;
  const fix = 'Check for a grep / grepInvert in the config (at the root or in a project) that filters out every test';
  return scaffolded
    ? { message: `No tests ran: the throwaway smoke test verify generated was filtered out (${line})`, fix }
    : { message: `No tests ran: ${testFile} was filtered out (${line})`, fix };
}

/** Names the throwaway smoke test can take, in order of preference. */
const SMOKE_TEST_NAMES = ['smoke.test.ts', 'smoke.spec.ts', 'smoke.tapsmith.ts'];

/**
 * The smoke test's file name: the first of SMOKE_TEST_NAMES that `testMatch`
 * covers at `dir`. It is run by name, and with projects a named file runs only
 * when a project's testMatch covers it (PILOT-553); init's configs match only
 * `*.tapsmith.ts` (PILOT-554). None covered: `smoke.test.ts`.
 */
function smokeTestName(dir: string, match: { testMatch: string[]; rootDir: string } | undefined): string {
  if (match) {
    const relDir = path.relative(match.rootDir, dir).split(path.sep).join('/');
    const covered = (name: string): boolean => match.testMatch.some((glob) =>
      minimatch(relDir ? `${relDir}/${name}` : name, glob.replace(/^\.\//, ''), { dot: true }));
    const name = SMOKE_TEST_NAMES.find(covered);
    if (name) return name;
  }
  return SMOKE_TEST_NAMES[0];
}

export function scaffoldVerifySmokeTest(
  testDir: string,
  contents: string,
  match?: { testMatch: string[]; rootDir: string },
): ScaffoldedVerifyTest {
  const tempDir = fs.mkdtempSync(path.join(testDir, 'tapsmith-verify-'));
  const file = path.join(tempDir, smokeTestName(tempDir, match));
  try {
    fs.writeFileSync(file, contents, { flag: 'wx' });
    return { file, tempDir };
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

export function cleanupVerifySmokeTest(scaffolded: ScaffoldedVerifyTest | undefined, testDirCreated: boolean, testDir: string | undefined): void {
  if (scaffolded) fs.rmSync(scaffolded.tempDir, { recursive: true, force: true });
  if (testDirCreated && testDir) {
    try { fs.rmdirSync(testDir); } catch { /* non-empty or already gone */ }
  }
}

/**
 * The end of the test run's stderr, for RUN_FAILED. ANSI codes are stripped
 * before cutting, so the cut never leaves half an escape sequence behind.
 */
export function stderrTail(stderr: string, max = 2000): string {
  return stripAnsi(stderr).slice(-max);
}

// ─── Command entry ───

function emitError(json: boolean, code: string, message: string, fix?: string): void {
  if (json) {
    process.stdout.write(formatJson(jsonError(code, message, { fix })));
  } else {
    console.error(`✗ ${message}`);
    if (fix) console.error(`→ ${fix}`);
  }
  process.exitCode = 1;
}


/**
 * The fix for a config that could not be loaded: the install command when
 * the project lacks Tapsmith itself, else the config.
 */
export function configLoadFix(err: unknown): string {
  if (isTapsmithNotInstalledError(err)) return `Run: ${err.installCommand.display}`;
  return 'Fix the config problem described above (npx tapsmith doctor --json also reports it)';
}

export async function runVerify(args: VerifyArgs): Promise<void> {
  try {
    // Fast-fail when no config file exists and no explicit --config was provided.
    // loadConfig falls back to defaults, so without this guard verify would launch
    // a full 10-minute run against an unconfigured project.
    // Found the same way loadConfig finds it (PILOT-263).
    const { loadConfig, findConfigFile } = await import('./config.js');
    if (!args.config && !findConfigFile(process.cwd())) {
      emitError(args.json, 'NO_CONFIG', 'No tapsmith.config.{ts,js,mjs} found in the current directory',
        'Run: npx tapsmith init --yes');
      return;
    }

    let config;
    try {
      config = await loadConfig(undefined, args.config);
    } catch (err) {
      // A config that exists but cannot be loaded, a missing --config path or
      // an invalid value: not a missing config, so not `init --yes`, which
      // would refuse to overwrite an existing one.
      emitError(args.json, 'CONFIG_ERROR', `Could not load config: ${err instanceof Error ? err.message : String(err)}`,
        configLoadFix(err));
      return;
    }

    const { discoverTestFiles } = await import('./test-file-discovery.js');
    const testFiles = await discoverTestFiles(config.testMatch, config.rootDir);

    let target = pickVerifyTarget(testFiles);
    let scaffolded: ScaffoldedVerifyTest | undefined;
    let testDir: string | undefined;
    let testDirCreated = false;
    const resultsFile = path.join(os.tmpdir(), `tapsmith-verify-${process.pid}.json`);

    // Ctrl-C during the (up to 10-minute) run would otherwise skip the finally
    // block, leaving a scaffolded smoke test inside the project's tests/ dir
    // that subsequent runs would discover and execute. Clean up on interrupt.
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const onSignal = (): void => {
      signals.forEach((sig) => process.off(sig, onSignal));
      fs.rmSync(resultsFile, { force: true });
      cleanupVerifySmokeTest(scaffolded, testDirCreated, testDir);
      process.exit(130);
    };
    signals.forEach((sig) => process.on(sig, onSignal));

    try {
      if (!target) {
        // No tests yet — scaffold a throwaway smoke test (cleaned up below).
        const { generateExampleTest } = await import('./init.js');
        testDir = path.join(config.rootDir, 'tests');
        if (!fs.existsSync(testDir)) {
          fs.mkdirSync(testDir, { recursive: true });
          testDirCreated = true;
        }
        scaffolded = scaffoldVerifySmokeTest(testDir, generateExampleTest(), { testMatch: config.testMatch, rootDir: config.rootDir });
        target = scaffolded.file;
      }

      if (!args.json) {
        console.log(`Verifying setup with ${path.relative(config.rootDir, target)} ...`);
      }

      const child = spawnSync(process.execPath, [
        process.argv[1], 'test', target, '--reporter', 'json',
        // = form: a path that starts with "-" would read as a flag.
        ...(args.config ? [`--config=${args.config}`] : []),
      ], {
        stdio: args.json ? ['ignore', 'ignore', 'pipe'] : 'inherit',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, TAPSMITH_JSON_OUTPUT_FILE: resultsFile },
        timeout: 10 * 60 * 1000,
      });

      if (child.error || !fs.existsSync(resultsFile)) {
        const refusal = child.error
          ? undefined
          : grepRefusalError(child.stderr?.toString(), path.relative(config.rootDir, target), scaffolded !== undefined);
        if (refusal) {
          emitError(args.json, 'NO_TESTS_RAN', refusal.message, refusal.fix);
          return;
        }
        const reason = child.error
          ? `Failed to execute test process: ${child.error.message}`
          : `Test run produced no results (exit code ${child.status ?? 'unknown'})`;
        const stderr = child.stderr ? stderrTail(child.stderr.toString()) : undefined;
        emitError(args.json, 'RUN_FAILED',
          `${reason}${stderr ? `: ${stderr}` : ''}`,
          'Run: npx tapsmith doctor --json to diagnose the environment');
        return;
      }

      let report: VerifyReport;
      try {
        report = JSON.parse(fs.readFileSync(resultsFile, 'utf8')) as VerifyReport;
      } catch (err) {
        emitError(args.json, 'PARSE_FAILED',
          `Failed to parse test results: ${err instanceof Error ? err.message : String(err)}`,
          'Run: npx tapsmith doctor --json to diagnose the environment');
        return;
      }
      const summary = summarizeVerifyReport(report);
      const testFile = path.relative(config.rootDir, target);
      const noTests = noTestsRanError(summary, testFile, scaffolded !== undefined);
      if (noTests) {
        emitError(args.json, 'NO_TESTS_RAN', noTests.message, noTests.fix);
        return;
      }

      if (args.json) {
        process.stdout.write(formatJson({ ...summary, testFile }));
      } else {
        console.log(summary.ok
          ? `✓ Setup verified: ${summary.passed} test(s) passed in ${(summary.duration / 1000).toFixed(1)}s`
          : `✗ Verification failed: ${summary.failed} of ${summary.passed + summary.failed} test(s) failed`);
        for (const f of summary.failures) console.log(formatVerifyFailure(f));
      }
      if (!summary.ok) process.exitCode = 1;
    } finally {
      signals.forEach((sig) => process.off(sig, onSignal));
      // Best effort, reported on stderr: the verdict is already on stdout, and a
      // throw here would add a second document under --json.
      // Each step on its own, so a results file that cannot be removed never
      // leaves the scaffolded smoke test in the project.
      const warnCleanup = (what: string, err: unknown): void => {
        console.error(`⚠ Could not remove ${what}: ${err instanceof Error ? err.message : String(err)}`);
      };
      try { fs.rmSync(resultsFile, { force: true }); } catch (err) { warnCleanup(resultsFile, err); }
      try {
        cleanupVerifySmokeTest(scaffolded, testDirCreated, testDir);
      } catch (err) {
        warnCleanup(scaffolded ? `${scaffolded.tempDir} (the throwaway smoke test; remove it by hand)` : 'the smoke test', err);
      }
    }
  } catch (err) {
    emitError(args.json, 'UNEXPECTED_ERROR',
      `An unexpected error occurred during verification: ${err instanceof Error ? err.message : String(err)}`,
      'Run: npx tapsmith doctor --json to diagnose the environment');
  }
}
