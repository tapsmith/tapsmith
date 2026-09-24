/**
 * `tapsmith merge-reports [dir]` — merge sharded blob reports into one run
 * and feed it to the configured reporters.
 *
 * @see PILOT-74, PILOT-257
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TapsmithConfig } from './config.js';
import { createReporters, normalizeReporterConfig, ReporterDispatcher, type TapsmithReporter } from './reporter.js';
import { BlobMergeError, BlobReporter, describeMergedBlobs, incompleteMergeMessage, mergeBlobs } from './reporters/blob.js';
import { bold, dim, green, red } from './reporters/base.js';

/**
 * Returns the process exit code. A merge that cannot be trusted (no blobs, a
 * corrupt or newer-format file, a duplicate shard, mixed runs) is refused
 * with 1 before any reporter runs. A merge missing a shard reports the shards
 * that are there — a partial CI report beats none — then fails with 1. A
 * complete merge is 0 even when the merged run failed — Playwright's
 * merge-reports does the same (the shard jobs carry the failure) — so the
 * final line states the merged status outright.
 */
export async function runMergeReports(blobDir: string, config: TapsmithConfig): Promise<number> {
  const resolvedDir = path.resolve(process.cwd(), blobDir);
  if (!fs.existsSync(resolvedDir)) {
    console.error(red(`merge-reports: No blob directory found at ${resolvedDir}`));
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

  // A configured blob reporter would clear its output directory — often the
  // very directory being merged — or add a merged blob to it that the next
  // merge would count twice. merge-reports reads blobs; it never writes one.
  const reporters = (await createReporters(config.reporter ?? 'list'))
    .filter((r) => !(r instanceof BlobReporter));
  const dispatcher = new ReporterDispatcher(reporters);
  dispatcher.onRunStart(config, 0);
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
 * Errors are logged like any reporter hook error.
 */
export function prepareBlobOutputDirs(reporters: TapsmithReporter[], config: TapsmithConfig): void {
  for (const r of reporters) {
    if (!(r instanceof BlobReporter)) continue;
    try {
      r.prepareOutputDir(config);
    } catch (err) {
      process.stderr.write(`Reporter error in onRunStart: ${(err as Error).message}\n`);
    }
  }
}

/**
 * A shard that got no test files still writes a (test-less) blob, as
 * Playwright's does, so `merge-reports` can tell "shard 4/4 had nothing to
 * run" from "shard 4/4 never uploaded" when there are fewer files than shards.
 * Uses the configured blob reporter's options when there is one.
 */
export async function writeEmptyShardBlob(config: TapsmithConfig): Promise<void> {
  // Read the blob entry's options rather than instantiating every configured
  // reporter: this runs before the tsx re-exec, where a custom TypeScript
  // reporter may not load.
  const entry = normalizeReporterConfig(config.reporter)
    .find((d) => (typeof d === 'string' ? d : d[0]) === 'blob');
  const options = Array.isArray(entry) ? entry[1] : {};
  const dispatcher = new ReporterDispatcher([new BlobReporter(options)]);
  dispatcher.onRunStart(config, 0);
  await dispatcher.onRunEnd({ status: 'passed', duration: 0, tests: [], suites: [] });
}
