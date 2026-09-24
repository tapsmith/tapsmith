import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareBlobOutputDirs, runMergeReports, writeEmptyShardBlob } from '../merge-reports.js';
import { BlobReporter } from '../reporters/blob.js';
import { ListReporter } from '../reporters/list.js';
import { mergeBlobs } from '../reporters/blob.js';
import type { TapsmithConfig } from '../config.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

let tmpDir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-merge-reports-'));
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(stripAnsi(a.join(' '))); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(stripAnsi(a.join(' '))); });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(stripAnsi(String(chunk)));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err.push(stripAnsi(String(chunk)));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function config(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return { rootDir: tmpDir, timeout: 30_000, retries: 0, reporter: 'list', ...overrides } as TapsmithConfig;
}

function writeBlob(dir: string, file: string, shard: { current: number; total: number } | undefined, status = 'passed'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify({
    version: 1, startTime: '', config: {}, shard, duration: 1, suites: [], screenshots: {},
    tests: [{ name: file, fullName: file, status, durationMs: 1, error: status === 'failed' ? { message: 'boom' } : undefined }],
  }));
}

describe('runMergeReports', () => {
  it('exits 1 with a clean one-line error for an empty directory', async () => {
    const dir = path.join(tmpDir, 'blobs');
    fs.mkdirSync(dir);
    expect(await runMergeReports(dir, config())).toBe(1);
    expect(err.join('\n')).toBe(`merge-reports: No blob reports (*.jsonl) found in ${dir}`);
  });

  it('exits 1 for a missing directory', async () => {
    const dir = path.join(tmpDir, 'nope');
    expect(await runMergeReports(dir, config())).toBe(1);
    expect(err.join('\n')).toBe(`merge-reports: No blob directory found at ${dir}`);
  });

  it('exits 1 naming a corrupt file, with no stack trace', async () => {
    const dir = path.join(tmpDir, 'blobs');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'report-x.jsonl'), '{not json');
    expect(await runMergeReports(dir, config())).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^merge-reports: Invalid blob file report-x\.jsonl: not valid JSON/);
    expect(err[0]).not.toMatch(/\n\s+at /);
  });

  it('still reports the shards that are there when one is missing, then exits 1', async () => {
    const dir = path.join(tmpDir, 'blobs');
    writeBlob(dir, 'a.jsonl', { current: 1, total: 2 });
    const reportDir = path.join(tmpDir, 'report');
    expect(await runMergeReports(dir, config({ reporter: [['html', { outputFolder: reportDir, open: 'never' }]] }))).toBe(1);
    expect(fs.existsSync(path.join(reportDir, 'index.html'))).toBe(true);
    expect(out.join('\n')).toContain('Merged 1 blob report (shards 1 of 2; missing 2/2): failed — 1 passed');
    expect(err.join('\n')).toMatch(/merge-reports: Missing shard 2\/2/);
  });

  it('exits 0 on a failed merged status, as Playwright does, and says it failed', async () => {
    const dir = path.join(tmpDir, 'blobs');
    writeBlob(dir, 'a.jsonl', { current: 1, total: 2 }, 'failed');
    writeBlob(dir, 'b.jsonl', { current: 2, total: 2 });
    expect(await runMergeReports(dir, config())).toBe(0);
    expect(out.join('\n')).toContain('Merged 2 blob reports (shards 1–2 of 2): failed — 1 passed, 1 failed');
  });

  it('does not run a configured blob reporter, which would clear or add to the blobs it is merging', async () => {
    const dir = path.join(tmpDir, 'blob-report');
    writeBlob(dir, 'a.jsonl', undefined);
    const code = await runMergeReports(dir, config({ reporter: ['list', 'blob'] }));
    expect(code).toBe(0);
    expect(fs.readdirSync(dir)).toEqual(['a.jsonl']);
    expect(mergeBlobs(dir).tests).toHaveLength(1);
  });
});

describe('runMergeReports with a blob-only config', () => {
  it('falls back to the list reporter rather than producing no report', async () => {
    const dir = path.join(tmpDir, 'blob-report');
    writeBlob(dir, 'a.jsonl', undefined, 'failed');
    expect(await runMergeReports(dir, config({ reporter: 'blob' }))).toBe(0);
    expect(out.join('')).toContain('Failures:');
  });
});

describe('writeEmptyShardBlob', () => {
  it('writes a blob for a shard with no files, so the merge sees every shard', async () => {
    const shard2 = config({ shard: { current: 2, total: 2 }, reporter: 'list' });
    await writeEmptyShardBlob(shard2);
    const dir = path.join(tmpDir, 'blob-report');
    writeBlob(dir, 'shard1.jsonl', { current: 1, total: 2 });
    const merged = mergeBlobs(dir);
    expect(merged.tests.map((t) => t.fullName)).toEqual(['shard1.jsonl']);
  });

  it('returns a refused outputDir as a message rather than throwing, and writes nothing', async () => {
    const refusal = await writeEmptyShardBlob(config({
      shard: { current: 1, total: 1 },
      reporter: [['blob', { outputDir: '.' }]],
    }));
    expect(refusal).toMatch(/^Blob reporter outputDir .* contains the project root or working directory/);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('does not load the other configured reporters (the empty-shard path runs before the tsx re-exec)', async () => {
    await writeEmptyShardBlob(config({
      shard: { current: 1, total: 1 },
      reporter: ['./no-such-reporter.ts', 'blob'],
    }));
    expect(fs.readdirSync(path.join(tmpDir, 'blob-report')).some((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('honours a configured blob outputDir', async () => {
    await writeEmptyShardBlob(config({
      shard: { current: 1, total: 1 },
      reporter: ['list', ['blob', { outputDir: 'custom-blobs' }]],
    }));
    expect(fs.readdirSync(path.join(tmpDir, 'custom-blobs')).some((f) => f.endsWith('.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'blob-report'))).toBe(false);
  });
});

describe('prepareBlobOutputDirs', () => {
  it('empties each blob reporter directory before launch, leaving other reporters alone', () => {
    const dir = path.join(tmpDir, 'blob-report');
    writeBlob(dir, 'old.jsonl', { current: 1, total: 2 });
    prepareBlobOutputDirs([new ListReporter(), new BlobReporter()], config());
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('returns a refused outputDir as a message, deleting nothing', () => {
    fs.writeFileSync(path.join(tmpDir, 'keep.ts'), 'x');
    expect(prepareBlobOutputDirs([new BlobReporter({ outputDir: '.' })], config()))
      .toMatch(/contains the project root or working directory/);
    expect(fs.existsSync(path.join(tmpDir, 'keep.ts'))).toBe(true);
  });

  it('returns undefined when every outputDir is safe', () => {
    expect(prepareBlobOutputDirs([new BlobReporter()], config())).toBeUndefined();
  });
});
