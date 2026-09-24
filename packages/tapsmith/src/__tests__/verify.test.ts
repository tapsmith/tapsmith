import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseVerifyArgs, pickVerifyTarget, cleanupVerifySmokeTest, scaffoldVerifySmokeTest, summarizeVerifyReport, runVerify } from '../verify.js';

describe('parseVerifyArgs()', () => {
  it('parses --json and --config', () => {
    expect(parseVerifyArgs(['--json', '--config', 't.config.ts'])).toEqual({ json: true, config: 't.config.ts', help: false });
    expect(parseVerifyArgs(['--config=t.config.ts'])).toEqual({ json: false, config: 't.config.ts', help: false });
    expect(parseVerifyArgs([])).toEqual({ json: false, config: undefined, help: false });
  });

  it('parses --help and -h', () => {
    expect(parseVerifyArgs(['--help']).help).toBe(true);
    expect(parseVerifyArgs(['-h']).help).toBe(true);
  });

  it('throws on unknown flags', () => {
    expect(() => parseVerifyArgs(['--bogus'])).toThrow(/unknown/i);
  });
});

describe('pickVerifyTarget()', () => {
  it('prefers example.test.ts', () => {
    const files = ['/p/tests/login.test.ts', '/p/tests/example.test.ts'];
    expect(pickVerifyTarget(files)).toBe('/p/tests/example.test.ts');
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

  it('reports ok on all-pass', () => {
    const allPass = { ...report, stats: { ...report.stats, failed: 0 }, suites: [{ ...report.suites[0], tests: [report.suites[0].tests[0]] }] };
    expect(summarizeVerifyReport(allPass).ok).toBe(true);
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
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const file = path.join(dir, 'tapsmith.config.mjs');
      fs.writeFileSync(file, 'throw new Error("boom")\n');
      process.chdir(dir);
      await runVerify(['--json']);
      const out = JSON.parse(String(log.mock.calls[0]?.[0])) as { error: { code: string; message: string; fix: string } };
      expect(out.error.code).toBe('CONFIG_ERROR');
      expect(out.error.message).toContain(`Failed to load config file ${file}: boom`);
      expect(out.error.fix).not.toMatch(/init/);
    } finally {
      log.mockRestore();
      process.chdir(cwd);
      process.exitCode = exitCode;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
