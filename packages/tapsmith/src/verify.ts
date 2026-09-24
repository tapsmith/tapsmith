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

// ─── Pure helpers (unit-tested) ───

export interface VerifyArgs {
  json: boolean;
  config: string | undefined;
  help: boolean;
}

export function parseVerifyArgs(argv: string[]): VerifyArgs {
  const args: VerifyArgs = { json: false, config: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--config' || arg === '-c') args.config = argv[++i];
    else if (arg.startsWith('--config=')) args.config = arg.slice('--config='.length);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown verify flag: ${arg} (usage: tapsmith verify [--json] [--config <file>])`);
  }
  return args;
}

export function pickVerifyTarget(testFiles: string[]): string | undefined {
  return testFiles.find((f) => path.basename(f) === 'example.test.ts') ?? testFiles[0];
}

interface ReportTest {
  fullName: string;
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
  failures: Array<{ fullName: string; error: string; screenshotPath?: string }>;
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
        failures.push({ fullName: t.fullName, error: t.error?.message ?? 'unknown error', screenshotPath: t.screenshotPath });
      }
    }
    suite.suites.forEach(walk);
  };
  report.suites.forEach(walk);
  return {
    ok: report.stats.failed === 0,
    passed: report.stats.passed,
    failed: report.stats.failed,
    skipped: report.stats.skipped,
    duration: report.stats.duration,
    failures,
  };
}

export function scaffoldVerifySmokeTest(testDir: string, contents: string): ScaffoldedVerifyTest {
  const tempDir = fs.mkdtempSync(path.join(testDir, 'tapsmith-verify-'));
  const file = path.join(tempDir, 'smoke.test.ts');
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

// ─── Command entry ───

const VERIFY_USAGE = `Usage: tapsmith verify [--json] [--config <file>]

Runs one test end-to-end (device boot, app install, real runner) to prove
the configured setup works. Scaffolds a throwaway smoke test if the project
has no tests yet.

Options:
  --json             Machine-readable output (also on errors)
  -c, --config <p>   Path to config file
  -h, --help         Show this help
`;

function emitError(json: boolean, code: string, message: string, fix?: string): void {
  if (json) {
    console.log(JSON.stringify({ error: { code, message, fix } }, null, 2));
  } else {
    console.error(`✗ ${message}`);
    if (fix) console.error(`→ ${fix}`);
  }
  process.exitCode = 1;
}

export async function runVerify(argv: string[]): Promise<void> {
  let args: VerifyArgs;
  try {
    args = parseVerifyArgs(argv);
  } catch (err) {
    emitError(argv.includes('--json'), 'BAD_ARGS', err instanceof Error ? err.message : String(err));
    return;
  }

  if (args.help) {
    process.stdout.write(VERIFY_USAGE);
    return;
  }

  try {
    // Fast-fail when no config file exists and no explicit --config was provided.
    // loadConfig falls back to defaults, so without this guard verify would launch
    // a full 10-minute run against an unconfigured project.
    if (!args.config) {
      const configNames = ['tapsmith.config.ts', 'tapsmith.config.mjs', 'tapsmith.config.js'];
      const found = configNames.find((name) => fs.existsSync(path.join(process.cwd(), name)));
      if (!found) {
        emitError(args.json, 'NO_CONFIG', 'No tapsmith.config.{ts,mjs,js} found in the current directory',
          'Run: npx tapsmith init --yes');
        return;
      }
    }

    const { loadConfig } = await import('./config.js');
    let config;
    try {
      config = await loadConfig(undefined, args.config);
    } catch (err) {
      // The file exists (the NO_CONFIG guard above, or an explicit --config
      // that loadConfig found): `init --yes` would refuse to overwrite it.
      emitError(args.json, 'CONFIG_ERROR', `Could not load config: ${err instanceof Error ? err.message : String(err)}`,
        'Fix the error in the config file named above (npx tapsmith doctor --json also reports it)');
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
        scaffolded = scaffoldVerifySmokeTest(testDir, generateExampleTest());
        target = scaffolded.file;
      }

      if (!args.json) {
        console.log(`Verifying setup with ${path.relative(config.rootDir, target)} ...`);
      }

      const child = spawnSync(process.execPath, [
        process.argv[1], 'test', target, '--reporter', 'json',
        ...(args.config ? ['--config', args.config] : []),
      ], {
        stdio: args.json ? ['ignore', 'ignore', 'pipe'] : 'inherit',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, TAPSMITH_JSON_OUTPUT_FILE: resultsFile },
        timeout: 10 * 60 * 1000,
      });

      if (child.error || !fs.existsSync(resultsFile)) {
        const reason = child.error
          ? `Failed to execute test process: ${child.error.message}`
          : `Test run produced no results (exit code ${child.status ?? 'unknown'})`;
        const stderr = child.stderr ? child.stderr.toString().slice(-2000) : undefined;
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

      if (args.json) {
        console.log(JSON.stringify({ ...summary, testFile: path.relative(config.rootDir, target) }, null, 2));
      } else {
        console.log(summary.ok
          ? `✓ Setup verified: ${summary.passed} test(s) passed in ${(summary.duration / 1000).toFixed(1)}s`
          : `✗ Verification failed: ${summary.failed} of ${summary.passed + summary.failed} test(s) failed`);
        for (const f of summary.failures) console.log(`  - ${f.fullName}: ${f.error}`);
      }
      if (!summary.ok) process.exitCode = 1;
    } finally {
      signals.forEach((sig) => process.off(sig, onSignal));
      fs.rmSync(resultsFile, { force: true });
      cleanupVerifySmokeTest(scaffolded, testDirCreated, testDir);
    }
  } catch (err) {
    emitError(args.json, 'UNEXPECTED_ERROR',
      `An unexpected error occurred during verification: ${err instanceof Error ? err.message : String(err)}`);
  }
}
