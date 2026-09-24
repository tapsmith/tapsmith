/**
 * `tapsmith merge-reports [dir]` — merge sharded blob reports into one run
 * and feed it to the configured reporters.
 *
 * @see PILOT-74, PILOT-257
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TapsmithConfig } from './config.js';
import { createReporters, ReporterDispatcher } from './reporter.js';
import { BlobMergeError, BlobReporter, describeMergedBlobs, mergeBlobs } from './reporters/blob.js';
import { bold, dim, green, red } from './reporters/base.js';

/**
 * Returns the process exit code. A merge that cannot be trusted (no blobs, a
 * corrupt or newer-format file, a missing or duplicate shard) is 1. A merge
 * that succeeds is 0 even when the merged run failed — Playwright's
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
  return 0;
}

/**
 * A shard that got no test files still writes a (test-less) blob, as
 * Playwright's does, so `merge-reports` can tell "shard 4/4 had nothing to
 * run" from "shard 4/4 never uploaded" when there are fewer files than shards.
 * Uses the configured blob reporter's options when there is one.
 */
export async function writeEmptyShardBlob(config: TapsmithConfig): Promise<void> {
  const configured = (await createReporters(config.reporter))
    .find((r): r is BlobReporter => r instanceof BlobReporter);
  const reporter = configured ?? new BlobReporter();
  reporter.onRunStart(config, 0);
  await reporter.onRunEnd({ status: 'passed', duration: 0, tests: [], suites: [] });
}
