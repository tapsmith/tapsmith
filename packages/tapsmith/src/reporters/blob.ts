/**
 * Blob reporter — serialized test data for shard merging.
 *
 * Serializes all test run data into a JSON-based blob file that can later
 * be merged with results from other shards via `npx tapsmith merge-reports`.
 *
 * @see PILOT-74
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TapsmithReporter, FullResult } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
import type { TestResult, SuiteResult } from '../runner.js';

/** The blob format this version writes, and the newest it can merge. */
const BLOB_VERSION = 1;

interface BlobData {
  version: typeof BLOB_VERSION
  startTime: string
  config: {
    rootDir: string
    timeout: number
    retries: number
  }
  shard?: { current: number; total: number }
  duration: number
  suites: SerializedSuite[]
  tests: SerializedTest[]
  screenshots: Record<string, string>
  attachments?: string[]
}

interface SerializedTest {
  name: string
  fullName: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  error?: { message: string; stack?: string }
  firstAttemptError?: { message: string; stack?: string }
  failedAttemptArtifacts?: { screenshot?: boolean; trace?: boolean; video?: boolean }
  screenshotKey?: string
  traceKey?: string
  videoKey?: string
  retry?: number
}

interface SerializedSuite {
  name: string
  durationMs: number
  tests: SerializedTest[]
  suites: SerializedSuite[]
}

export class BlobReporter implements TapsmithReporter {
  private _outputDir: string;
  private _config?: TapsmithConfig;
  private _startTime = new Date();
  private _refusal?: Error;

  constructor(options: Record<string, unknown> = {}) {
    this._outputDir = (options.outputDir as string) ?? 'blob-report';
  }

  /**
   * Clears the output directory, as Playwright's blob reporter does. Blob file
   * names are unique per run, so without this a second run into the same
   * directory leaves two blobs and `merge-reports` counts every test twice.
   * Unlike Playwright (which clears when it writes), this clears at run start:
   * a run that dies before the end then leaves no blob at all, rather than the
   * previous run's blob posing as this run's shard.
   */
  onRunStart(config: TapsmithConfig, _fileCount: number): void {
    this._config = config;
    this._startTime = new Date();
    this._refusal = undefined;
    const outputDir = this._resolveOutputDir();
    for (const protectedDir of new Set([path.resolve(config.rootDir ?? process.cwd()), process.cwd()])) {
      if (isSameOrAncestor(outputDir, protectedDir)) {
        // Remembered so onRunEnd writes nothing either: the dispatcher logs
        // and swallows hook errors, and a blob dropped into the project root
        // would be picked up by the next merge.
        this._refusal = new Error(
          `Blob reporter outputDir ${outputDir} contains the project root (${protectedDir}). `
          + 'It is cleared at the start of every run; point outputDir at a dedicated directory such as "blob-report".',
        );
        throw this._refusal;
      }
    }
    fs.rmSync(outputDir, { recursive: true, force: true });
  }

  private _resolveOutputDir(): string {
    const rootDir = this._config?.rootDir ?? process.cwd();
    return path.resolve(rootDir, this._outputDir);
  }

  async onRunEnd(result: FullResult): Promise<void> {
    if (this._refusal) throw this._refusal;
    const outputDir = this._resolveOutputDir();
    fs.mkdirSync(outputDir, { recursive: true });

    // Encode screenshots as base64, copy traces/videos as files
    const screenshots: Record<string, string> = {};
    const attachments: string[] = [];

    const copyAttachment = (filePath: string): string | undefined => {
      try {
        if (!fs.existsSync(filePath)) return undefined;
        const key = path.basename(filePath);
        const dest = path.join(outputDir, key);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(filePath, dest);
        }
        attachments.push(key);
        return key;
      } catch {
        return undefined;
      }
    };

    const serializeTest = (t: TestResult): SerializedTest => {
      let screenshotKey: string | undefined;
      if (t.screenshotPath && fs.existsSync(t.screenshotPath)) {
        screenshotKey = path.basename(t.screenshotPath);
        if (!screenshots[screenshotKey]) {
          screenshots[screenshotKey] = fs.readFileSync(t.screenshotPath).toString('base64');
        }
      }
      const traceKey = t.tracePath ? copyAttachment(t.tracePath) : undefined;
      const videoKey = t.videoPath ? copyAttachment(t.videoPath) : undefined;
      return {
        name: t.name,
        fullName: t.fullName,
        status: t.status,
        durationMs: t.durationMs,
        error: t.error ? { message: t.error.message, stack: t.error.stack } : undefined,
        firstAttemptError: t.firstAttemptError
          ? { message: t.firstAttemptError.message, stack: t.firstAttemptError.stack }
          : undefined,
        failedAttemptArtifacts: t.failedAttemptArtifacts,
        screenshotKey,
        traceKey,
        videoKey,
        retry: t.retry,
      };
    };

    const serializeSuite = (s: SuiteResult): SerializedSuite => ({
      name: s.name,
      durationMs: s.durationMs,
      tests: s.tests.map(serializeTest),
      suites: s.suites.map(serializeSuite),
    });

    const blob: BlobData = {
      version: BLOB_VERSION,
      startTime: this._startTime.toISOString(),
      config: {
        rootDir: this._config?.rootDir ?? process.cwd(),
        timeout: this._config?.timeout ?? 30_000,
        retries: this._config?.retries ?? 0,
      },
      shard: this._config?.shard,
      duration: result.duration,
      suites: result.suites.map(serializeSuite),
      tests: result.tests.map(serializeTest),
      screenshots,
      attachments,
    };

    // Use a shard-friendly filename (timestamp + random suffix)
    const suffix = Math.random().toString(36).slice(2, 8);
    const filename = `report-${Date.now()}-${suffix}.jsonl`;
    const outputPath = path.join(outputDir, filename);
    fs.writeFileSync(outputPath, JSON.stringify(blob) + '\n');

    process.stderr.write(`Blob report written to ${outputPath}\n`);
  }
}

// ─── Merge utility ───

/**
 * A blob directory that cannot be merged: no blobs, a corrupt or foreign
 * file, a newer blob format, or a shard set with a hole or a duplicate.
 * The message is the whole user-facing explanation, so the CLI prints it
 * without a stack.
 */
export class BlobMergeError extends Error {
  override name = 'BlobMergeError';
}

interface ParsedBlob {
  file: string
  blob: BlobData
}

interface MergeInfo {
  blobCount: number
  shardTotal?: number
}

const mergeInfo = new WeakMap<FullResult, MergeInfo>();

/**
 * Merge multiple blob reports into a single FullResult.
 * Used by `npx tapsmith merge-reports <dir>`.
 *
 * Throws {@link BlobMergeError} rather than merging something misleading:
 * an empty directory (Playwright: "No report files found"), an invalid file,
 * a blob from a newer Tapsmith, or a sharded set that is missing a shard,
 * holds one twice, or mixes shard splits. Unsharded blobs are merged as-is,
 * any number of them, as Playwright does.
 */
export function mergeBlobs(blobDir: string): FullResult {
  let entries: string[];
  try {
    if (!fs.statSync(blobDir).isDirectory()) {
      throw new BlobMergeError(`${blobDir} is not a directory`);
    }
    entries = fs.readdirSync(blobDir);
  } catch (err) {
    if (err instanceof BlobMergeError) throw err;
    throw new BlobMergeError(`Cannot read blob directory ${blobDir}: ${(err as Error).message}`);
  }
  const files = entries.filter((f) => f.endsWith('.jsonl')).sort();
  if (files.length === 0) {
    throw new BlobMergeError(`No blob reports (*.jsonl) found in ${blobDir}`);
  }

  const blobs = files.map((file) => ({ file, blob: parseBlob(blobDir, file) }));
  const shardTotal = checkShards(blobs);
  blobs.sort((a, b) =>
    (a.blob.shard?.current ?? 0) - (b.blob.shard?.current ?? 0) || a.file.localeCompare(b.file));

  const allTests: TestResult[] = [];
  const allSuites: SuiteResult[] = [];
  let totalDuration = 0;

  for (const { blob } of blobs) {
    totalDuration = Math.max(totalDuration, blob.duration);

    // Restore screenshots to disk
    if (blob.screenshots) {
      for (const [key, base64] of Object.entries(blob.screenshots)) {
        const screenshotPath = path.join(blobDir, key);
        if (!fs.existsSync(screenshotPath)) {
          fs.writeFileSync(screenshotPath, Buffer.from(base64, 'base64'));
        }
      }
    }

    for (const t of blob.tests) {
      allTests.push(restoreTest(t, blobDir));
    }
    for (const s of blob.suites) {
      allSuites.push(deserializeSuite(s, blobDir));
    }
  }

  const hasFailed = allTests.some((t) => t.status === 'failed');
  const result: FullResult = {
    status: hasFailed ? 'failed' : 'passed',
    duration: totalDuration,
    tests: allTests,
    suites: allSuites,
  };
  mergeInfo.set(result, { blobCount: blobs.length, shardTotal });
  return result;
}

/**
 * One line naming what was merged and the merged status, e.g.
 * `Merged 3 blob reports (shards 1–3 of 3): failed — 10 passed, 2 failed`.
 * `merge-reports` exits 0 whatever the status (as Playwright's does), so this
 * line is where a failed merge is stated outright.
 */
export function describeMergedBlobs(result: FullResult): string {
  const info = mergeInfo.get(result);
  const count = info?.blobCount ?? 0;
  let what = `Merged ${count} blob report${count === 1 ? '' : 's'}`;
  if (info?.shardTotal) what += ` (shards 1–${info.shardTotal} of ${info.shardTotal})`;
  const counts = (['passed', 'failed', 'skipped'] as const)
    .map((status) => [status, result.tests.filter((t) => t.status === status).length] as const)
    .filter(([status, n]) => n > 0 || status === 'passed')
    .map(([status, n]) => `${n} ${status}`);
  return `${what}: ${result.status} — ${counts.join(', ')}`;
}

function parseBlob(blobDir: string, file: string): BlobData {
  const invalid = (reason: string) => new BlobMergeError(`Invalid blob file ${file}: ${reason}`);
  const content = fs.readFileSync(path.join(blobDir, file), 'utf-8').trim();
  if (!content) throw invalid('the file is empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw invalid(`not valid JSON (${(err as Error).message})`);
  }
  if (!isRecord(parsed)) throw invalid('not a JSON object (not a Tapsmith blob report?)');
  const { version } = parsed;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw invalid('missing or malformed "version"');
  }
  if (version > BLOB_VERSION) {
    throw new BlobMergeError(
      `Blob report ${file} was created with a newer version of Tapsmith (blob format ${version}; `
      + `this version reads up to ${BLOB_VERSION}). Upgrade Tapsmith to merge it.`,
    );
  }
  for (const key of ['tests', 'suites'] as const) {
    if (!Array.isArray(parsed[key])) throw invalid(`missing or malformed "${key}" (not a Tapsmith blob report?)`);
  }
  if (typeof parsed.duration !== 'number') throw invalid('missing or malformed "duration"');
  const { shard } = parsed;
  if (shard !== undefined && shard !== null) {
    const ok = isRecord(shard)
      && Number.isInteger(shard.current) && Number.isInteger(shard.total)
      && (shard.current as number) >= 1 && (shard.current as number) <= (shard.total as number);
    if (!ok) throw invalid('malformed "shard"');
  }
  return parsed as unknown as BlobData;
}

/**
 * Sharded blobs must be one complete split: a single total, each shard once,
 * none missing. Returns that total, or undefined when nothing is sharded.
 */
function checkShards(blobs: ParsedBlob[]): number | undefined {
  const sharded = blobs.filter((b) => b.blob.shard);
  if (sharded.length === 0) return undefined;

  const first = sharded[0];
  const total = first.blob.shard!.total;
  const other = sharded.find((b) => b.blob.shard!.total !== total);
  if (other) {
    throw new BlobMergeError(
      `Blob reports come from different shard splits (${first.file} is shard ${shardLabel(first)}, `
      + `${other.file} is shard ${shardLabel(other)}). Merge each run from its own directory.`,
    );
  }

  const byShard = new Map<number, string[]>();
  for (const b of sharded) {
    const current = b.blob.shard!.current;
    byShard.set(current, [...(byShard.get(current) ?? []), b.file]);
  }
  for (const [current, files] of [...byShard].sort(([a], [b]) => a - b)) {
    if (files.length > 1) {
      throw new BlobMergeError(
        `Duplicate blob reports for shard ${current}/${total}: ${files.join(', ')}. `
        + 'Each shard must be merged once — remove the stale file, '
        + 'or merge runs (e.g. different platforms) from separate directories.',
      );
    }
  }

  const missing: number[] = [];
  for (let i = 1; i <= total; i++) if (!byShard.has(i)) missing.push(i);
  if (missing.length > 0) {
    const found = [...byShard.keys()].sort((a, b) => a - b);
    throw new BlobMergeError(
      `Missing shard${missing.length === 1 ? '' : 's'} ${missing.map((n) => `${n}/${total}`).join(', ')}: `
      + `found blob reports for shard${found.length === 1 ? '' : 's'} ${found.join(', ')} of ${total}. `
      + 'Check that every shard job finished and uploaded its blob-report directory.',
    );
  }
  return total;
}

function shardLabel(b: ParsedBlob): string {
  return `${b.blob.shard!.current}/${b.blob.shard!.total}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `dir` is `target` or one of its ancestors. */
function isSameOrAncestor(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

function restoreTest(t: SerializedTest, blobDir: string): TestResult {
  return {
    name: t.name,
    fullName: t.fullName,
    status: t.status,
    durationMs: t.durationMs,
    error: t.error ? Object.assign(new Error(t.error.message), { stack: t.error.stack }) : undefined,
    firstAttemptError: t.firstAttemptError
      ? Object.assign(new Error(t.firstAttemptError.message), { stack: t.firstAttemptError.stack })
      : undefined,
    failedAttemptArtifacts: t.failedAttemptArtifacts,
    screenshotPath: t.screenshotKey ? path.join(blobDir, t.screenshotKey) : undefined,
    tracePath: t.traceKey ? path.join(blobDir, t.traceKey) : undefined,
    videoPath: t.videoKey ? path.join(blobDir, t.videoKey) : undefined,
    retry: t.retry,
  };
}

function deserializeSuite(
  s: SerializedSuite,
  blobDir: string,
): SuiteResult {
  return {
    name: s.name,
    durationMs: s.durationMs,
    tests: s.tests.map((t) => restoreTest(t, blobDir)),
    suites: s.suites.map((child) => deserializeSuite(child, blobDir)),
  };
}

