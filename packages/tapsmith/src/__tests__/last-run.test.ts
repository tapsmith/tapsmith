import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readLastRun, selectLastFailed, writeLastRun, type LastRunTest } from '../last-run.js';
import { beginOutputRun, KEEP_OUTPUT_ENV, recordOutputFile } from '../output-ledger.js';
import type { ResolvedProject } from '../project.js';
import type { TestResult } from '../runner.js';

let rootDir: string;
const config = () => ({ rootDir, outputDir: 'out' });
const abs = (file: string): string => path.join(rootDir, file);
const result = (file: string, fullName: string, over: Partial<TestResult> = {}): TestResult => ({
  name: fullName, fullName, status: 'failed', durationMs: 1, filePath: abs(file), ...over,
});

beforeEach(() => { rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-last-run-')); });
afterEach(() => {
  delete process.env[KEEP_OUTPUT_ENV];
  delete process.env.TAPSMITH_OUTPUT_RUN;
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('the last-run record', () => {
  it('keeps the failed tests, and only them', () => {
    writeLastRun(config(), {
      status: 'failed',
      tests: [
        result('tests/a.test.ts', 'a > fails', { project: 'ios' }),
        result('tests/a.test.ts', 'a > passes', { status: 'passed' }),
        result('tests/a.test.ts', 'a > skips', { status: 'skipped' }),
      ],
    });
    expect(readLastRun(config())).toEqual([{ file: 'tests/a.test.ts', project: 'ios', title: 'a > fails' }]);
    expect(JSON.parse(fs.readFileSync(abs('out/.last-run.json'), 'utf-8')).status).toBe('failed');
  });

  it('survives the next run clearing the last one\'s output', () => {
    beginOutputRun(config(), { clear: true });
    fs.mkdirSync(abs('out/traces'), { recursive: true });
    fs.writeFileSync(abs('out/traces/t.zip'), 'trace');
    recordOutputFile(config(), abs('out/traces/t.zip'));
    writeLastRun(config(), { status: 'failed', tests: [result('a.test.ts', 'a')] });
    const [ledger] = fs.readdirSync(abs('out/.tapsmith-output'));
    fs.appendFileSync(abs(`out/.tapsmith-output/${ledger}`), '{"end":true}\n');
    beginOutputRun(config(), { clear: true });
    expect(fs.existsSync(abs('out/traces/t.zip'))).toBe(false);
    expect(readLastRun(config())).toHaveLength(1);
  });

  it.each([['not json'], ['null'], ['{}'], ['{"failedTests":[{"file":1}]}']])('reads %j as no record', (text) => {
    fs.mkdirSync(abs('out'));
    fs.writeFileSync(abs('out/.last-run.json'), text);
    expect(readLastRun(config())).toBeUndefined();
  });

  it('is not written by a run that keeps the output (tapsmith verify)', () => {
    process.env[KEEP_OUTPUT_ENV] = '1';
    writeLastRun(config(), { status: 'failed', tests: [result('a.test.ts', 'a')] });
    expect(readLastRun(config())).toBeUndefined();
  });
});

describe('selectLastFailed', () => {
  const project = (name: string, files: string[], dependencies: string[] = [], over: Partial<ResolvedProject> = {}): ResolvedProject => ({
    name, testMatch: [], testIgnore: [], dependencies, testFiles: files.map(abs),
    effectiveConfig: {} as ResolvedProject['effectiveConfig'], deviceSignature: '', ...over,
  });
  const select = (projects: ResolvedProject[], failed: LastRunTest[], names = ['one', 'two']): string[] =>
    selectLastFailed(projects, failed, config(), () => names).map((f) => path.relative(rootDir, f));

  it('keeps the files with a failure, and the failed tests of each', () => {
    const p = project('default', ['a.test.ts', 'b.test.ts'], [], { synthesized: true });
    expect(select([p], [{ file: 'a.test.ts', title: 'two' }])).toEqual(['a.test.ts']);
    expect(p.fullNamesByFile).toEqual(new Map([[abs('a.test.ts'), ['two']]]));
  });

  it('tells the projects that run one file apart', () => {
    const android = project('android', ['a.test.ts']);
    const ios = project('ios', ['a.test.ts']);
    select([android, ios], [{ file: 'a.test.ts', project: 'ios', title: 'one' }]);
    expect(android.testFiles).toEqual([]);
    expect(ios.testFiles).toEqual([abs('a.test.ts')]);
  });

  it('runs a setup project whole for a dependent with a failure', () => {
    const setup = project('setup', ['s.test.ts']);
    const tests = project('tests', ['a.test.ts'], ['setup']);
    expect(select([setup, tests], [
      { file: 'a.test.ts', project: 'tests', title: 'one' },
      { file: 's.test.ts', project: 'setup', title: 'one' },
    ])).toEqual(['a.test.ts', 's.test.ts']);
    expect(setup.fullNamesByFile).toBeUndefined();
  });

  it('re-runs a setup project\'s own failure, and drops one with none', () => {
    const base = project('base', ['b.test.ts']);
    const setup = project('setup', ['s.test.ts'], ['base']);
    const tests = project('tests', ['a.test.ts'], ['setup']);
    const other = project('other', ['o.test.ts']);
    expect(select([base, setup, tests, other], [{ file: 's.test.ts', project: 'setup', title: 'one' }]))
      .toEqual(['b.test.ts', 's.test.ts']);
  });

  it('drops a test that no longer exists', () => {
    expect(select([project('p', ['a.test.ts'])], [{ file: 'a.test.ts', project: 'p', title: 'renamed' }])).toEqual([]);
  });

  it.each([['a.test.ts'], ['a.test.ts — failed to load']])('runs the whole file for the failure titled %j', (title) => {
    const p = project('p', ['a.test.ts']);
    expect(select([p], [{ file: 'a.test.ts', project: 'p', title }])).toEqual(['a.test.ts']);
    expect(p.fullNamesByFile?.size).toBe(0);
    // ... unless the other filters select none of its tests.
    expect(select([project('p', ['a.test.ts'])], [{ file: 'a.test.ts', project: 'p', title }], [])).toEqual([]);
  });

  it('trusts the record when the file\'s tests are not known', () => {
    const p = project('p', ['a.test.ts']);
    selectLastFailed([p], [{ file: 'a.test.ts', project: 'p', title: 'one' }], config(), () => undefined);
    expect(p.fullNamesByFile).toEqual(new Map([[abs('a.test.ts'), ['one']]]));
  });
});
