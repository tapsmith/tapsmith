import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BlobReporter, BlobMergeError, mergeBlobs, describeMergedBlobs, incompleteMergeMessage } from '../reporters/blob.js';
import type { FullResult } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
import type { TestResult } from '../runner.js';

// ─── Helpers ───

function makeTest(overrides: Partial<TestResult> = {}): TestResult {
  return { name: 't', fullName: 'suite > t', status: 'passed', durationMs: 1, ...overrides };
}

function makeResult(tests: TestResult[] = [makeTest()]): FullResult {
  return { status: 'passed', duration: 10, tests, suites: [] };
}

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return { rootDir: '/', timeout: 30_000, retries: 0, ...overrides } as TapsmithConfig;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-blob-merge-'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a well-formed blob by hand, as a shard's blob reporter would. */
function writeBlob(
  file: string,
  opts: { shard?: { current: number; total: number }; tests?: string[]; version?: unknown } = {},
): void {
  const tests = (opts.tests ?? ['a']).map((fullName) => ({
    name: fullName, fullName, status: 'passed', durationMs: 1,
  }));
  const blob: Record<string, unknown> = {
    version: 'version' in opts ? opts.version : 1,
    startTime: new Date(0).toISOString(),
    config: { rootDir: '/', timeout: 30_000, retries: 0 },
    shard: opts.shard,
    duration: 5,
    suites: [],
    tests,
    screenshots: {},
    attachments: [],
  };
  if (blob.version === undefined) delete blob.version;
  fs.writeFileSync(path.join(tmpDir, file), JSON.stringify(blob) + '\n');
}

function mergeError(dir = tmpDir): BlobMergeError {
  try {
    mergeBlobs(dir);
  } catch (err) {
    expect(err).toBeInstanceOf(BlobMergeError);
    return err as BlobMergeError;
  }
  throw new Error('expected mergeBlobs to throw');
}

// ─── Input ───

describe('mergeBlobs input checks', () => {
  it('refuses a directory with no blob files instead of merging to a green empty run', () => {
    fs.writeFileSync(path.join(tmpDir, 'unrelated.txt'), 'x');
    expect(mergeError().message).toBe(`No blob reports (*.jsonl) found in ${tmpDir}`);
  });

  it('refuses a path that is a file, not a directory', () => {
    const file = path.join(tmpDir, 'report.jsonl');
    fs.writeFileSync(file, '{}');
    expect(mergeError(file).message).toBe(`${file} is not a directory`);
  });

  it('names the file when a blob is not valid JSON', () => {
    writeBlob('report-a.jsonl');
    fs.writeFileSync(path.join(tmpDir, 'report-b.jsonl'), '{"version":1, trunc');
    const err = mergeError();
    expect(err.message).toMatch(/^Invalid blob file report-b\.jsonl: not valid JSON \(/);
  });

  it('names the file when a blob is an empty file', () => {
    fs.writeFileSync(path.join(tmpDir, 'report-a.jsonl'), '');
    expect(mergeError().message).toBe('Invalid blob file report-a.jsonl: the file is empty');
  });

  it('names the file when a blob is JSON but not a Tapsmith blob', () => {
    fs.writeFileSync(path.join(tmpDir, 'report-a.jsonl'), JSON.stringify({ version: 1, hello: 'world' }));
    expect(mergeError().message).toBe(
      'Invalid blob file report-a.jsonl: missing or malformed "tests" (not a Tapsmith blob report?)',
    );
  });

  it('refuses a blob with no version', () => {
    writeBlob('report-a.jsonl', { version: undefined });
    expect(mergeError().message).toBe('Invalid blob file report-a.jsonl: missing or malformed "version"');
  });

  it('refuses a blob written by a newer Tapsmith', () => {
    writeBlob('report-a.jsonl', { version: 2 });
    expect(mergeError().message).toBe(
      'Blob report report-a.jsonl was created with a newer version of Tapsmith (blob format 2; this version reads up to 1). Upgrade Tapsmith to merge it.',
    );
  });

  it('names the file when a nested suite entry is malformed', () => {
    fs.writeFileSync(path.join(tmpDir, 'report-a.jsonl'), JSON.stringify({
      version: 1, duration: 1, tests: [], suites: [{ name: 's', durationMs: 1 }],
    }));
    expect(mergeError().message).toMatch(/^Invalid blob file report-a\.jsonl: malformed test or suite entry \(/);
  });

  it('names the file when a blob cannot be read (a directory named *.jsonl)', () => {
    fs.mkdirSync(path.join(tmpDir, 'report-a.jsonl'));
    expect(mergeError().message).toMatch(/^Invalid blob file report-a\.jsonl: cannot read it \(/);
  });

  it.each([
    ['a screenshot key', { screenshots: { '../escape.png': 'eA==' } }],
    ['a trace key', { tests: [{ name: 'a', fullName: 'a', status: 'passed', durationMs: 1, traceKey: '/etc/passwd' }] }],
    ['a nested video key', { suites: [{ name: 's', durationMs: 1, suites: [], tests: [
      { name: 'a', fullName: 'a', status: 'passed', durationMs: 1, videoKey: 'sub/dir.webm' },
    ] }] }],
  ])('refuses %s that is not a plain file name, writing nothing outside the directory', (_what, extra) => {
    const inner = path.join(tmpDir, 'blobs');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, 'report-a.jsonl'), JSON.stringify({
      version: 1, duration: 1, tests: [], suites: [], screenshots: {}, ...extra,
    }));
    expect(mergeError(inner).message).toMatch(/^Invalid blob file report-a\.jsonl: attachment name .* is not a plain file name$/);
    expect(fs.existsSync(path.join(tmpDir, 'escape.png'))).toBe(false);
  });

  it('refuses a malformed shard field', () => {
    writeBlob('report-a.jsonl', { shard: { current: 0, total: 2 } });
    expect(mergeError().message).toBe('Invalid blob file report-a.jsonl: malformed "shard"');
  });
});

// ─── Shards ───

describe('mergeBlobs shard checks', () => {
  it('merges the shards that are there when one is missing, as failed, and names the missing one', () => {
    writeBlob('report-1.jsonl', { shard: { current: 1, total: 3 }, tests: ['one'] });
    writeBlob('report-3.jsonl', { shard: { current: 3, total: 3 }, tests: ['three'] });
    const merged = mergeBlobs(tmpDir);
    expect(merged.tests.map((t) => t.fullName)).toEqual(['one', 'three']);
    expect(merged.status).toBe('failed');
    expect(incompleteMergeMessage(merged)).toBe(
      'Missing shard 2/3: found blob reports for shards 1, 3 of 3. '
      + 'Check that every shard job finished and uploaded its blob-report directory.',
    );
  });

  it('lists every missing shard', () => {
    writeBlob('report-2.jsonl', { shard: { current: 2, total: 4 } });
    expect(incompleteMergeMessage(mergeBlobs(tmpDir)))
      .toMatch(/^Missing shards 1\/4, 3\/4, 4\/4: found blob reports for shard 2 of 4\./);
  });

  it('has no incomplete message for a complete or an unsharded set', () => {
    writeBlob('report-1.jsonl', { shard: { current: 1, total: 1 } });
    expect(incompleteMergeMessage(mergeBlobs(tmpDir))).toBeUndefined();
    fs.rmSync(path.join(tmpDir, 'report-1.jsonl'));
    writeBlob('report-a.jsonl');
    expect(incompleteMergeMessage(mergeBlobs(tmpDir))).toBeUndefined();
  });

  it('refuses sharded blobs mixed with an unsharded one, which would count every test twice', () => {
    writeBlob('report-1.jsonl', { shard: { current: 1, total: 1 } });
    writeBlob('report-full.jsonl');
    expect(mergeError().message).toBe(
      'Blob reports mix sharded and unsharded runs (report-1.jsonl is shard 1/1, report-full.jsonl is not sharded). '
      + 'Merge each run from its own directory.',
    );
  });

  it('refuses the same shard twice, naming both files', () => {
    writeBlob('report-1a.jsonl', { shard: { current: 1, total: 2 } });
    writeBlob('report-1b.jsonl', { shard: { current: 1, total: 2 } });
    writeBlob('report-2.jsonl', { shard: { current: 2, total: 2 } });
    expect(mergeError().message).toBe(
      'Duplicate blob reports for shard 1/2: report-1a.jsonl, report-1b.jsonl. '
      + 'Each shard must be merged once — remove the stale file, '
      + 'or merge runs (e.g. different platforms) from separate directories.',
    );
  });

  it('refuses blobs from different shard splits', () => {
    writeBlob('report-a.jsonl', { shard: { current: 1, total: 2 } });
    writeBlob('report-b.jsonl', { shard: { current: 2, total: 3 } });
    expect(mergeError().message).toBe(
      'Blob reports come from different shard splits (report-a.jsonl is shard 1/2, report-b.jsonl is shard 2/3). '
      + 'Merge each run from its own directory.',
    );
  });

  it('merges a complete shard set in shard order, whatever the file names', () => {
    writeBlob('report-zzz.jsonl', { shard: { current: 1, total: 3 }, tests: ['one'] });
    writeBlob('report-aaa.jsonl', { shard: { current: 3, total: 3 }, tests: ['three'] });
    writeBlob('report-mmm.jsonl', { shard: { current: 2, total: 3 }, tests: ['two'] });
    const merged = mergeBlobs(tmpDir);
    expect(merged.tests.map((t) => t.fullName)).toEqual(['one', 'two', 'three']);
    expect(merged.status).toBe('passed');
  });

  it('merges any number of unsharded blobs without calling them duplicates', () => {
    writeBlob('report-a.jsonl', { tests: ['a'] });
    writeBlob('report-b.jsonl', { tests: ['b'] });
    expect(mergeBlobs(tmpDir).tests.map((t) => t.fullName)).toEqual(['a', 'b']);
  });
});

// ─── Summary line ───

describe('describeMergedBlobs', () => {
  it('reports the shard set and the merged status', () => {
    writeBlob('report-1.jsonl', { shard: { current: 1, total: 2 }, tests: ['a'] });
    writeBlob('report-2.jsonl', { shard: { current: 2, total: 2 }, tests: ['b'] });
    const result = mergeBlobs(tmpDir);
    expect(describeMergedBlobs(result)).toBe('Merged 2 blob reports (shards 1–2 of 2): passed — 2 passed');
  });

  it('names the missing shards in the summary', () => {
    writeBlob('report-1.jsonl', { shard: { current: 1, total: 3 }, tests: ['a'] });
    writeBlob('report-3.jsonl', { shard: { current: 3, total: 3 }, tests: ['b'] });
    expect(describeMergedBlobs(mergeBlobs(tmpDir)))
      .toBe('Merged 2 blob reports (shards 1, 3 of 3; missing 2/3): failed — 2 passed');
  });

  it('reports a failed merged status with its counts', () => {
    const tests = [
      { name: 'a', fullName: 'a', status: 'failed', durationMs: 1, error: { message: 'boom' } },
      { name: 'b', fullName: 'b', status: 'skipped', durationMs: 0 },
      { name: 'c', fullName: 'c', status: 'passed', durationMs: 1 },
    ];
    fs.writeFileSync(path.join(tmpDir, 'report-a.jsonl'), JSON.stringify({
      version: 1, startTime: '', config: {}, duration: 1, suites: [], tests, screenshots: {},
    }));
    const result = mergeBlobs(tmpDir);
    expect(result.status).toBe('failed');
    expect(describeMergedBlobs(result)).toBe('Merged 1 blob report: failed — 1 passed, 1 failed, 1 skipped');
  });
});

// ─── BlobReporter output directory ───

describe('BlobReporter output directory', () => {
  it('clears the previous run so a second run into the same directory is not double-counted', async () => {
    const outputDir = path.join(tmpDir, 'blob-report');
    for (let run = 0; run < 2; run++) {
      const reporter = new BlobReporter({ outputDir });
      reporter.onRunStart(makeConfig(), 1);
      await reporter.onRunEnd(makeResult([makeTest({ fullName: `run ${run}` })]));
    }
    expect(fs.readdirSync(outputDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
    expect(mergeBlobs(outputDir).tests.map((t) => t.fullName)).toEqual(['run 1']);
  });

  it('clears stale attachments from a previous run too', async () => {
    const outputDir = path.join(tmpDir, 'blob-report');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, 'old-trace.zip'), 'x');
    const reporter = new BlobReporter({ outputDir });
    reporter.onRunStart(makeConfig(), 1);
    expect(fs.existsSync(path.join(outputDir, 'old-trace.zip'))).toBe(false);
  });

  it('clears at run start, so a run that never reaches the end leaves no stale blob behind', async () => {
    const outputDir = path.join(tmpDir, 'blob-report');
    const first = new BlobReporter({ outputDir });
    first.onRunStart(makeConfig(), 1);
    await first.onRunEnd(makeResult());
    new BlobReporter({ outputDir }).onRunStart(makeConfig(), 1);
    expect(fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : []).toEqual([]);
  });

  it('resolves a relative outputDir against rootDir', async () => {
    const reporter = new BlobReporter({ outputDir: 'out/blobs' });
    reporter.onRunStart(makeConfig({ rootDir: tmpDir }), 1);
    await reporter.onRunEnd(makeResult());
    expect(fs.readdirSync(path.join(tmpDir, 'out/blobs')).some((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('refuses to clear an outputDir that is the project root, deleting nothing', () => {
    const keep = path.join(tmpDir, 'keep.ts');
    fs.writeFileSync(keep, 'x');
    const reporter = new BlobReporter({ outputDir: '.' });
    expect(() => reporter.onRunStart(makeConfig({ rootDir: tmpDir }), 1)).toThrow(
      `Blob reporter outputDir ${tmpDir} contains the project root or working directory (${tmpDir}). `
      + 'It is cleared at the start of every run; point outputDir at a dedicated directory such as "blob-report".',
    );
    expect(fs.existsSync(keep)).toBe(true);
  });

  it('writes no blob at run end after refusing, so nothing lands in the project root', async () => {
    const reporter = new BlobReporter({ outputDir: '.' });
    expect(() => reporter.onRunStart(makeConfig({ rootDir: tmpDir }), 1)).toThrow();
    await expect(reporter.onRunEnd(makeResult())).rejects.toThrow(/contains the project root/);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('refuses to clear an ancestor of the project root', () => {
    const rootDir = path.join(tmpDir, 'project');
    fs.mkdirSync(rootDir);
    const reporter = new BlobReporter({ outputDir: '..' });
    expect(() => reporter.onRunStart(makeConfig({ rootDir }), 1)).toThrow(/contains the project root/);
    expect(fs.existsSync(rootDir)).toBe(true);
  });

  it('refuses an ancestor reached through a symlink', () => {
    const real = path.join(tmpDir, 'real');
    const rootDir = path.join(real, 'project');
    fs.mkdirSync(rootDir, { recursive: true });
    const link = path.join(tmpDir, 'link');
    fs.symlinkSync(real, link);
    const reporter = new BlobReporter({ outputDir: link });
    expect(() => reporter.onRunStart(makeConfig({ rootDir }), 1)).toThrow(/contains the project root/);
    expect(fs.existsSync(rootDir)).toBe(true);
  });

  it.runIf(process.platform === 'darwin')('refuses an ancestor spelled in a different case (case-insensitive macOS volume)', () => {
    const rootDir = path.join(tmpDir, 'project');
    fs.mkdirSync(rootDir);
    const variant = tmpDir.toUpperCase();
    if (!fs.existsSync(variant)) return; // case-sensitive volume: the variant is a different path
    const reporter = new BlobReporter({ outputDir: variant });
    expect(() => reporter.onRunStart(makeConfig({ rootDir }), 1)).toThrow(/contains the project root/);
    expect(fs.existsSync(rootDir)).toBe(true);
  });

  it('prepareOutputDir clears before the run starts', () => {
    const outputDir = path.join(tmpDir, 'blob-report');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, 'report-old.jsonl'), '{}');
    new BlobReporter({ outputDir }).prepareOutputDir(makeConfig());
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('writes a mergeable blob for a shard with no tests', async () => {
    const outputDir = path.join(tmpDir, 'blob-report');
    const reporter = new BlobReporter({ outputDir });
    reporter.onRunStart(makeConfig({ shard: { current: 2, total: 2 } }), 0);
    await reporter.onRunEnd(makeResult([]));
    writeBlob('blob-report/report-1.jsonl', { shard: { current: 1, total: 2 }, tests: ['a'] });
    expect(mergeBlobs(outputDir).tests.map((t) => t.fullName)).toEqual(['a']);
  });
});
