/**
 * Pure helpers for `merge-reports-gate.mjs`: deciding whether a failed
 * `tapsmith merge-reports` should fail the E2E workflows' Merge Reports job.
 * Kept apart from the script so they are unit-tested without a workflow run
 * (`utils/__tests__/merge-gate-checks.test.mjs`).
 *
 * The job adds information in two cases only, and stays red for both: a real
 * merge error, and a shard that left no blob with no failed job to account for
 * it. A shard that failed, or never ran because a build failed, is accounted for.
 * A failed job elsewhere doesn't excuse a shard that vanished without a trace.
 *
 * A cancelled job is different: it is visible, but with no failed job next to it
 * the run ends as `cancelled`, the same as a run a newer push replaced, so it
 * reads as nothing to look at. The merge job doesn't run at all when the whole
 * run is cancelled (`!cancelled()`), so a cancelled job seen here was cancelled
 * alone: GitHub could not get it a runner, or it hit `timeout-minutes`. That stays
 * red unless another job already fails the run.
 */

/** Conclusions that make the run fail without the merge job's help. */
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out"])

const CANCELLED_ALONE = "cancelled while the run was not (no runner, or timeout-minutes; see that job)"

const ANSI_COLOUR = /\u001b\[[0-9;]*m/g

/**
 * The shards `merge-reports` said it could not find, from its output. Returns
 * undefined when the output is not a missing-shard failure, which the caller
 * treats as a real merge error, so a reworded message fails closed.
 *
 * @param {string} output merge-reports' combined stdout and stderr
 * @param {number} shardTotal the workflow's shard count
 * @returns {number[] | undefined}
 */
export function parseMissingShards(output, shardTotal) {
  const text = output.replace(ANSI_COLOUR, "")
  if (/merge-reports: No blob (directory found at|reports \(\*\.jsonl\) found in)/.test(text)) {
    return Array.from({ length: shardTotal }, (_, i) => i + 1)
  }
  const list = /merge-reports: Missing shards? ((?:\d+\/\d+(?:, )?)+):/.exec(text)
  if (!list) return undefined
  const parsed = list[1].split(", ").map((entry) => entry.split("/").map(Number))
  // A total the workflow doesn't expect means the blobs aren't this run's shape.
  if (parsed.some(([, total]) => total !== shardTotal)) return undefined
  return parsed.map(([shard]) => shard)
}

/**
 * @typedef {{ name: string, conclusion: string | null }} Job
 * @typedef {{ ok: boolean, reason?: string, accounted: string[], unaccounted: string[] }} Verdict
 */

/**
 * @param {{ exitCode: number, mergeOutput: string, jobs: Job[] | undefined, shardTotal: number }} input
 *   `jobs` is this run attempt's job list, undefined when it couldn't be read.
 * @returns {Verdict}
 */
export function judgeMerge({ exitCode, mergeOutput, jobs, shardTotal }) {
  if (exitCode === 0) return { ok: true, accounted: [], unaccounted: [] }

  const missing = parseMissingShards(mergeOutput, shardTotal)
  if (!missing) {
    const message = mergeOutput.replace(ANSI_COLOUR, "").match(/^merge-reports: (.*)$/m)?.[1]
    return {
      ok: false,
      reason: `Real merge error: ${message ?? `merge-reports exited ${exitCode}, and not because of a missing shard.`}`,
      accounted: [],
      unaccounted: [],
    }
  }

  if (!jobs) {
    const names = missing.map((n) => shardName(n, shardTotal)).join(", ")
    return {
      ok: false,
      reason: `Missing ${names}, and the job list could not be read to tell whether another job already fails the run.`,
      accounted: [],
      unaccounted: missing.map((n) => `${shardName(n, shardTotal)}: job list unavailable`),
    }
  }

  const accounted = []
  const unaccounted = []
  for (const shard of missing) {
    const name = shardName(shard, shardTotal)
    const shown = explainMissingShard(shard, shardTotal, jobs)
    if (shown.accounted) accounted.push(`${name}: ${shown.detail}`)
    else unaccounted.push(`${name}: ${shown.detail}`)
  }
  if (unaccounted.length === 0) return { ok: true, accounted, unaccounted }
  return {
    ok: false,
    reason: `These shards left no results, and no failed job accounts for them:\n  ${unaccounted.join("\n  ")}`,
    accounted,
    unaccounted,
  }
}

/** Must match the `name:` of the workflows' `e2e-test` job. */
function shardName(shard, shardTotal) {
  return `Shard ${shard}/${shardTotal}`
}

/** @returns {{ accounted: boolean, detail: string }} */
function explainMissingShard(shard, shardTotal, jobs) {
  const row = jobs.find((job) => job.name === shardName(shard, shardTotal))
  if (row && FAILING_CONCLUSIONS.has(row.conclusion)) {
    return { accounted: true, detail: `job ${row.conclusion}` }
  }
  const runFails = jobs.some((job) => FAILING_CONCLUSIONS.has(job.conclusion))
  if (row?.conclusion === "cancelled") {
    return runFails
      ? { accounted: true, detail: "job cancelled, and another job fails the run" }
      : { accounted: false, detail: `job ${CANCELLED_ALONE}` }
  }
  if (row?.conclusion === "success") {
    return { accounted: false, detail: "job succeeded but left no blob report" }
  }
  if (row && row.conclusion !== "skipped") {
    return { accounted: false, detail: `job still ${row.conclusion ?? "unfinished"}` }
  }

  // Never ran. GitHub lists a matrix that never expanded under the job's
  // unexpanded name, or not at all, so there may be no row for this shard.
  const failedBuild = jobs.find((job) => isBuild(job) && FAILING_CONCLUSIONS.has(job.conclusion))
  if (failedBuild) {
    return { accounted: true, detail: `not run, ${failedBuild.name} ${failedBuild.conclusion}` }
  }
  const cancelledBuild = jobs.find((job) => isBuild(job) && job.conclusion === "cancelled")
  if (cancelledBuild) {
    return runFails
      ? { accounted: true, detail: `not run, ${cancelledBuild.name} cancelled, and another job fails the run` }
      : { accounted: false, detail: `not run, ${cancelledBuild.name} ${CANCELLED_ALONE}` }
  }
  if (row) return { accounted: false, detail: "job skipped with no failed build to explain it" }
  return { accounted: false, detail: "GitHub has no job for it in this attempt" }
}

function isBuild(job) {
  return job.name.startsWith("Build ")
}
