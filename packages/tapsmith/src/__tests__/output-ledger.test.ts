import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beginOutputRun, recordOutputFile } from '../output-ledger.js';
import { writeEmptyShardBlob, runMergeReports } from '../merge-reports.js';
import { JsonReporter } from '../reporters/json.js';
import { JUnitReporter } from '../reporters/junit.js';
import type { TapsmithConfig } from '../config.js';

const RUN_ENV = 'TAPSMITH_OUTPUT_RUN';

let rootDir: string;
let config: TapsmithConfig;
let exitListeners: NodeJS.ExitListener[];

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-output-'));
  config = { rootDir, outputDir: 'out', timeout: 1, retries: 0 } as TapsmithConfig;
  exitListeners = process.listeners('exit');
  vi.stubEnv(RUN_ENV, '');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  for (const l of process.listeners('exit')) if (!exitListeners.includes(l)) process.off('exit', l);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function write(rel: string, content = 'data'): string {
  const file = path.join(rootDir, 'out', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function artifact(rel: string, content = 'data'): string {
  const file = write(rel, content);
  recordOutputFile(config, file);
  return file;
}

const ledgerDir = (): string => path.join(rootDir, 'out', '.tapsmith-output');
const ledgers = (): string[] => (fs.existsSync(ledgerDir()) ? fs.readdirSync(ledgerDir()) : []);

/** A run of another process; it writes `rel`, and ends however the process does. */
function runElsewhere(fn: () => void, owner: { host?: string; pid?: number } = {}): void {
  beginOutputRun(config, { clear: false });
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const run = JSON.parse(process.env[RUN_ENV]!) as Record<string, unknown>;
  process.env[RUN_ENV] = JSON.stringify({
    ...run, host: owner.host ?? run.host, owner: { pid: owner.pid ?? dead },
  });
  fn();
}

const CLI = path.resolve(import.meta.dirname, '..', '..', 'dist', 'cli.js');

describe.skipIf(!fs.existsSync(CLI) && !process.env.CI)('tapsmith test (the built CLI)', { timeout: 60_000 }, () => {
  const runCli = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [CLI, 'test', ...args], {
    cwd: rootDir, encoding: 'utf-8', timeout: 60_000,
    env: { ...process.env, TAPSMITH_TELEMETRY: '0', CI: '1', GITHUB_ACTIONS: '' },
  });

  beforeEach(() => {
    fs.writeFileSync(path.join(rootDir, 'package.json'), '{ "type": "module" }');
    fs.writeFileSync(path.join(rootDir, 'tapsmith.config.mjs'), 'export default { outputDir: "out", testMatch: ["*.test.mjs"], reporter: [["json", { outputFile: "out/r.json" }], ["html", { open: "never" }]] };');
    fs.writeFileSync(path.join(rootDir, 'a.test.mjs'), 'throw new Error("cannot load");');
  });

  it('clears earlier output when it runs, and not when it is refused', () => {
    let file = '';
    runElsewhere(() => { file = artifact('traces/a.zip'); });
    expect(runCli('--reporter', 'nonesuch').status).toBe(1);
    expect(runCli('no-such-file').status).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
    expect(runCli().status).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
    // Its own report is recorded in turn.
    expect(fs.existsSync(path.join(rootDir, 'out/r.json'))).toBe(true);
    expect(runCli('--reporter', 'list').status).toBe(1);
    expect(fs.existsSync(path.join(rootDir, 'out/r.json'))).toBe(false);
  });

  it('clears earlier output for a shard with no files', () => {
    let file = '';
    runElsewhere(() => { file = artifact('traces/a.zip'); });
    expect(runCli('--shard', '2/2').status).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('output ledger', () => {
  it('removes what finished runs wrote when the next run starts', () => {
    let files: string[] = [];
    runElsewhere(() => { files = [artifact('traces/a.zip'), artifact('screenshots/b.png'), artifact('videos/c.mp4')]; });
    beginOutputRun(config, { clear: true });
    expect(files.filter((f) => fs.existsSync(f))).toEqual([]);
    expect(ledgers()).toEqual([]);
  });

  it('keeps every file no ledger names: app state, logs, a user\'s own screenshots', () => {
    const own = [write('auth-state.tar.gz'), write('traces/mine.zip'), write('screenshots/t-1710345600000.png')];
    runElsewhere(() => { artifact('traces/a.zip'); });
    beginOutputRun(config, { clear: true });
    expect(own.every((f) => fs.existsSync(f))).toBe(true);
  });

  it('keeps a recorded file that has since been replaced', () => {
    let file = '';
    runElsewhere(() => { file = artifact('results.json', '{}'); });
    fs.writeFileSync(file, 'the user put something else here');
    beginOutputRun(config, { clear: true });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('keeps a recorded file replaced by one of the same size', () => {
    let file = '';
    runElsewhere(() => { file = artifact('results.json', '{"a":1}'); });
    fs.writeFileSync(file, '{"a":2}');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    beginOutputRun(config, { clear: true });
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"a":2}');
  });

  it('does not follow a directory that has become a link out of outputDir', () => {
    let file = '';
    runElsewhere(() => { file = artifact('traces/a.zip'); });
    const archive = path.join(rootDir, 'archive');
    fs.renameSync(path.dirname(file), archive);
    fs.symlinkSync(archive, path.dirname(file), 'dir');
    beginOutputRun(config, { clear: true });
    expect(fs.existsSync(path.join(archive, 'a.zip'))).toBe(true);
  });

  it('clears an outputDir that is itself a link', () => {
    const real = path.join(rootDir, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(rootDir, 'out'), 'dir');
    runElsewhere(() => { artifact('traces/a.zip'); });
    beginOutputRun(config, { clear: true });
    expect(fs.existsSync(path.join(real, 'traces/a.zip'))).toBe(false);
  });

  it('removes a trace that was amended after it was first recorded', () => {
    let file = '';
    runElsewhere(() => {
      file = artifact('traces/a.zip', 'short');
      fs.writeFileSync(file, 'longer, with the afterAll events');
      recordOutputFile(config, file);
    });
    beginOutputRun(config, { clear: true });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves the output of a run that is still going', () => {
    let file = '';
    runElsewhere(() => { file = artifact('traces/a.zip'); }, { pid: process.pid });
    beginOutputRun(config, { clear: true });
    expect(fs.existsSync(file)).toBe(true);
    expect(ledgers()).toHaveLength(1);
  });

  it('removes the output of a run whose end was recorded, though its pid runs again', () => {
    beginOutputRun(config, { clear: false });
    const file = artifact('traces/a.zip');
    for (const l of process.listeners('exit')) if (!exitListeners.includes(l)) l.call(process, 0);
    beginOutputRun(config, { clear: true });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves another machine\'s unfinished run for a day', () => {
    let file = '';
    runElsewhere(() => { file = artifact('traces/a.zip'); }, { host: 'elsewhere.invalid' });
    beginOutputRun(config, { clear: true });
    expect(fs.existsSync(file)).toBe(true);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(path.join(ledgerDir(), ledgers()[0]), old, old);
    beginOutputRun(config, { clear: true });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('never removes a file outside outputDir, or a directory, whatever a ledger says', () => {
    const outside = path.join(rootDir, 'app.ts');
    fs.writeFileSync(outside, 'data');
    write('dir/keep.txt');
    fs.mkdirSync(ledgerDir(), { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const entry = (file: string): string => JSON.stringify({ host: os.hostname(), owner: { pid: dead }, file, size: 4, mtimeMs: fs.statSync(outside).mtimeMs });
    fs.writeFileSync(path.join(ledgerDir(), 'x.jsonl'), [entry('../app.ts'), entry(outside), entry('dir'), 'not json', 'null'].join('\n'));
    beginOutputRun(config, { clear: true });
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'out/dir/keep.txt'))).toBe(true);
  });

  it('keeps the ledger of a file it could not remove, for the next run to retry', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    let file = '';
    runElsewhere(() => { file = artifact('traces/a.zip'); });
    fs.chmodSync(path.dirname(file), 0o500);
    try {
      expect(() => beginOutputRun(config, { clear: true })).not.toThrow();
      expect(ledgers()).toHaveLength(1);
    } finally {
      fs.chmodSync(path.dirname(file), 0o700);
    }
    beginOutputRun(config, { clear: true });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('records nothing outside a run, outside outputDir, or for a partial config', () => {
    recordOutputFile(config, write('traces/a.zip'));
    beginOutputRun(config, { clear: true });
    const elsewhere = path.join(rootDir, 'report.json');
    fs.writeFileSync(elsewhere, '{}');
    recordOutputFile(config, elsewhere);
    recordOutputFile({ rootDir } as TapsmithConfig, elsewhere);
    recordOutputFile(undefined, elsewhere);
    expect(ledgers()).toEqual([]);
  });

  it('keeps one ledger for a run', () => {
    runElsewhere(() => { artifact('traces/a.zip'); artifact('traces/b.zip'); });
    expect(ledgers()).toHaveLength(1);
  });

  it('clears JSON and JUnit reports in outputDir, so a run that dies cannot leave the last one\'s behind', async () => {
    const result = { status: 'passed' as const, duration: 1, tests: [], suites: [] };
    runElsewhere(() => {});
    for (const r of [new JsonReporter({ outputFile: 'out/r.json' }), new JUnitReporter({ outputFile: 'out/r.xml' })]) {
      r.onRunStart(config, 0);
      await r.onRunEnd(result);
    }
    expect(fs.existsSync(path.join(rootDir, 'out/r.json')) && fs.existsSync(path.join(rootDir, 'out/r.xml'))).toBe(true);
    beginOutputRun(config, { clear: true });
    expect(fs.existsSync(path.join(rootDir, 'out/r.json')) || fs.existsSync(path.join(rootDir, 'out/r.xml'))).toBe(false);
  });

  it('merge-reports leaves the runs\' output alone', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let file = '';
    runElsewhere(() => { file = artifact('traces/a.zip'); });
    await writeEmptyShardBlob(config);
    expect(await runMergeReports(path.join(rootDir, 'blob-report'), config, { reporter: 'json' })).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });
});
