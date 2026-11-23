/**
 * `tapsmith merge-reports [dir]` — merge sharded blob reports into one run
 * and feed it to the `--reporter` reporters, else the configured ones, else
 * `list` and `html`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TapsmithConfig } from './config.js';
import {
  createReporters,
  normalizeReporterConfig,
  ReporterDispatcher,
  type ReporterDescription,
  type TapsmithReporter,
} from './reporter.js';
import { parseReporterList } from './reporter-names.js';
import { BlobMergeError, BlobOutputDirError, BlobReporter, describeMergedBlobs, incompleteMergeMessage, mergeBlobs } from './reporters/blob.js';
import { bold, dim, green, red } from './reporters/base.js';

/** Options `tapsmith merge-reports` takes on the command line. */
export interface MergeReportsOptions {
  /** `--reporter`: comma-separated reporter names that replace the config's. */
  reporter?: string
}

/**
 * The reporters to merge with when neither `--reporter` nor the config names
 * one besides `blob` — the config `init` writes sets none, and sharded CI
 * configs often set only `blob`. The HTML report is what the merge job
 * uploads, so it is written to its default `tapsmith-report/`; it is never
 * opened, since nobody asked for it (and a CI runner has no browser).
 */
const DEFAULT_MERGE_REPORTERS: ReporterDescription[] = ['list', ['html', { open: 'never' }]];

const reporterName = (d: ReporterDescription): string => (typeof d === 'string' ? d : d[0]);

/** The reporters for the merge, or the refusal message for a bad `--reporter`. */
function mergeReporterDescriptions(
  config: TapsmithConfig,
  cliReporter: string | undefined,
): ReporterDescription[] | string {
  if (cliReporter !== undefined) {
    const names = parseReporterList(cliReporter);
    if (names.length === 0) return '--reporter needs at least one reporter name, e.g. --reporter html';
    if (names.includes('blob')) {
      return '--reporter blob is not available here: merge-reports reads blob reports and never writes one';
    }
    return names;
  }
  // A configured blob reporter would clear its output directory — often the
  // very directory being merged — or add a merged blob to it that the next
  // merge would count twice. merge-reports reads blobs; it never writes one.
  // An unset reporter is checked here, as normalizeReporterConfig would fill
  // in `tapsmith test`'s default (`list` alone).
  const configured = config.reporter
    ? normalizeReporterConfig(config.reporter).filter((d) => reporterName(d) !== 'blob')
    : [];
  return configured.length > 0 ? configured : DEFAULT_MERGE_REPORTERS;
}

/**
 * Returns the process exit code. A merge that cannot be trusted (no blobs, a
 * corrupt or newer-format file, a duplicate shard, mixed runs) is refused
 * with 1 before any reporter runs. A merge missing a shard reports the shards
 * that are there — a partial CI report beats none — then fails with 1. A
 * complete merge is 0 even when the merged run failed — Playwright's
 * merge-reports does the same (the shard jobs carry the failure) — so the
 * final line states the merged status outright.
 */
export async function runMergeReports(
  blobDir: string,
  config: TapsmithConfig,
  options: MergeReportsOptions = {},
): Promise<number> {
  const resolvedDir = path.resolve(process.cwd(), blobDir);
  if (!fs.existsSync(resolvedDir)) {
    console.error(red(`merge-reports: No blob directory found at ${resolvedDir}`));
    return 1;
  }

  // Load the reporters first, so a bad name is refused before any output.
  const descriptions = mergeReporterDescriptions(config, options.reporter);
  if (typeof descriptions === 'string') {
    console.error(red(`merge-reports: ${descriptions}`));
    return 1;
  }
  let reporters: TapsmithReporter[];
  try {
    reporters = (await createReporters(descriptions, { rootDir: config.rootDir })).filter((r) => !(r instanceof BlobReporter));
  } catch (err) {
    console.error(red(`merge-reports: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  let result;
  try {
    result = mergeBlobs(resolvedDir);
  } catch (err) {
    if (!(err instanceof BlobMergeError)) throw err;
    console.error(red(`merge-reports: ${err.message}`));
    return 1;
  }

  console.log(bold('Merging blob reports'));
  console.log(dim(resolvedDir));
  console.log();

  const dispatcher = new ReporterDispatcher(reporters);
  dispatcher.onRunStart(config, 0, { merge: true });
  await dispatcher.onRunEnd(result);

  const summary = describeMergedBlobs(result);
  console.log();
  console.log(result.status === 'passed' ? green(summary) : red(summary));
  const incomplete = incompleteMergeMessage(result);
  if (incomplete) {
    console.error(red(`merge-reports: ${incomplete}`));
    return 1;
  }
  return 0;
}

/**
 * Empty every blob reporter's output directory now, before `tapsmith test`
 * launches devices, so a run that fails during launch (before `onRunStart`)
 * can't leave the previous run's blob behind to be merged as this run's.
 * Returns the refusal message when an outputDir would take the project with
 * it (the caller exits 1 on it), else undefined.
 */
export function prepareBlobOutputDirs(reporters: TapsmithReporter[], config: TapsmithConfig): string | undefined {
  for (const r of reporters) {
    if (!(r instanceof BlobReporter)) continue;
    const refusal = refusalOf(() => r.prepareOutputDir(config));
    if (refusal) return refusal;
  }
  return undefined;
}

function refusalOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    if (err instanceof BlobOutputDirError) return err.message;
    throw err;
  }
}

/**
 * A shard that got no test files still writes a (test-less) blob, as
 * Playwright's does, so `merge-reports` can tell "shard 4/4 had nothing to
 * run" from "shard 4/4 never uploaded" when there are fewer files than shards.
 * Uses the configured blob reporter's options when there is one. Returns the
 * refusal message for an outputDir that would take the project with it (the
 * caller exits 1 on it), else undefined.
 */
export async function writeEmptyShardBlob(config: TapsmithConfig): Promise<string | undefined> {
  // Read the blob entry's options rather than instantiating every configured
  // reporter: this runs before the tsx re-exec, where a custom TypeScript
  // reporter may not load.
  const entry = normalizeReporterConfig(config.reporter)
    .find((d) => (typeof d === 'string' ? d : d[0]) === 'blob');
  const options = Array.isArray(entry) ? entry[1] : {};
  const reporter = new BlobReporter(options);
  const refusal = refusalOf(() => reporter.onRunStart(config, 0));
  if (refusal) return refusal;
  await reporter.onRunEnd({ status: 'passed', duration: 0, tests: [], suites: [] });
  return undefined;
}
