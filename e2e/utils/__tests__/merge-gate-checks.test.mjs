import test from "node:test"
import assert from "node:assert/strict"
import { judgeMerge, parseMissingShards } from "../merge-gate-checks.mjs"

// ─── Fixtures: the SDK's real messages (src/reporters/blob.ts, src/merge-reports.ts) ───

const missing = (...shards) =>
  `merge-reports: Missing shard${shards.length === 1 ? "" : "s"} ${shards.map((n) => `${n}/3`).join(", ")}: `
  + "found blob reports for shard 1 of 3. Check that every shard job finished and uploaded its blob-report directory."
const NO_BLOBS = "merge-reports: No blob reports (*.jsonl) found in /home/runner/work/all-blob-reports"
const NO_DIR = "merge-reports: No blob directory found at /home/runner/work/all-blob-reports"
const CORRUPT = "merge-reports: Invalid blob file report-1.jsonl: not valid JSON"

const job = (name, conclusion) => ({ name, conclusion })
const shards = (one, two, three) => [
  job("Shard 1/3", one),
  job("Shard 2/3", two),
  job("Shard 3/3", three),
]
const judge = (mergeOutput, jobs, exitCode = 1) =>
  judgeMerge({ exitCode, mergeOutput, jobs, shardTotal: 3 })

// ─── parseMissingShards ───

test("parseMissingShards reads one and several shards", () => {
  assert.deepEqual(parseMissingShards(missing(2), 3), [2])
  assert.deepEqual(parseMissingShards(missing(2, 3), 3), [2, 3])
})

test("parseMissingShards tolerates colour codes and surrounding output", () => {
  const output = `Merged 1 blob report\n\u001b[31m${missing(3)}\u001b[0m\n`
  assert.deepEqual(parseMissingShards(output, 3), [3])
})

test("parseMissingShards treats no blobs at all as every shard missing", () => {
  assert.deepEqual(parseMissingShards(NO_BLOBS, 3), [1, 2, 3])
  assert.deepEqual(parseMissingShards(NO_DIR, 3), [1, 2, 3])
})

test("parseMissingShards returns undefined for any other failure", () => {
  assert.equal(parseMissingShards(CORRUPT, 3), undefined)
  assert.equal(parseMissingShards("", 3), undefined)
})

test("parseMissingShards does not trust a total that disagrees with the workflow's", () => {
  assert.equal(parseMissingShards("merge-reports: Missing shard 2/5: found…", 3), undefined)
})

// ─── judgeMerge: a complete merge ───

test("a complete merge passes without looking at the jobs", () => {
  const verdict = judge("Merged 3 blob reports: failed", undefined, 0)
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.accounted, [])
})

// ─── judgeMerge: real merge errors ───

test("a real merge error fails, even with a failed shard next to it", () => {
  const verdict = judge(CORRUPT, shards("failure", "success", "success"))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, "Real merge error: Invalid blob file report-1.jsonl: not valid JSON")
})

test("an unrecognised merge-reports failure fails", () => {
  const verdict = judge("Segmentation fault", shards("success", "success", "success"))
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /Real merge error: merge-reports exited 1/)
})

// ─── judgeMerge: missing shards the run already shows ───

test("a failed shard with no blob does not fail the merge", () => {
  const verdict = judge(missing(2), shards("success", "failure", "success"))
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.accounted, ["Shard 2/3: job failure"])
})

test("a timed-out shard with no blob does not fail the merge", () => {
  assert.equal(judge(missing(1), shards("timed_out", "success", "success")).ok, true)
})

test("no blobs after a build job failed does not fail the merge", () => {
  const verdict = judge(NO_BLOBS, [
    job("Build SDK", "success"),
    job("Build Daemon", "failure"),
    job("Shard ${{ matrix.shard }}/3", "skipped"),
  ])
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.accounted, [
    "Shard 1/3: not run, Build Daemon failure",
    "Shard 2/3: not run, Build Daemon failure",
    "Shard 3/3: not run, Build Daemon failure",
  ])
})

test("a build failure accounts for the matrix when no shard job was created at all", () => {
  assert.equal(judge(NO_BLOBS, [job("Build SDK", "success"), job("Build Agent", "failure")]).ok, true)
})

test("a failed build accounts for a skipped shard row", () => {
  assert.equal(judge(missing(2), [job("Build Agent", "failure"), ...shards("success", "skipped", "success")]).ok, true)
})

test("several failed shards all pass", () => {
  assert.equal(judge(missing(1, 3), shards("failure", "success", "failure")).ok, true)
})

// ─── judgeMerge: missing shards nothing else shows ───

test("a shard cancelled alone fails, naming it: the run would read as cancelled", () => {
  const verdict = judge(missing(1), shards("cancelled", "success", "success"))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.unaccounted.length, 1)
  assert.match(verdict.unaccounted[0], /^Shard 1\/3: job cancelled while the run was not/)
})

test("a build cancelled alone fails, naming every shard it stopped", () => {
  const verdict = judge(NO_BLOBS, [
    job("Build SDK", "success"),
    job("Build Daemon", "cancelled"),
    job("Shard ${{ matrix.shard }}/3", "skipped"),
  ])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.unaccounted.length, 3)
  assert.match(verdict.unaccounted[2], /^Shard 3\/3: not run, Build Daemon cancelled while the run was not/)
})

test("a failed build wins over a cancelled one: the run already fails", () => {
  const verdict = judge(NO_BLOBS, [job("Build Agent", "cancelled"), job("Build Daemon", "failure")])
  assert.equal(verdict.ok, true)
})

test("a shard that succeeded but left no blob fails, naming it", () => {
  const verdict = judge(missing(2), shards("success", "success", "success"))
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.unaccounted, ["Shard 2/3: job succeeded but left no blob report"])
})

test("a shard with no job record fails, naming it (the 4 Nov runs)", () => {
  const verdict = judge(missing(2), [job("Shard 1/3", "success"), job("Shard 3/3", "success")])
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.unaccounted, ["Shard 2/3: GitHub has no job for it in this attempt"])
})

test("a failed shard does not hide another shard's silent loss", () => {
  const verdict = judge(missing(1, 2), [job("Shard 1/3", "failure"), job("Shard 3/3", "success")])
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.accounted, ["Shard 1/3: job failure"])
  assert.deepEqual(verdict.unaccounted, ["Shard 2/3: GitHub has no job for it in this attempt"])
})

test("no blobs with every build fine fails, naming every shard", () => {
  const verdict = judge(NO_BLOBS, [job("Build SDK", "success"), ...shards("success", "success", "success")])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.unaccounted.length, 3)
  assert.match(verdict.reason, /Shard 1\/3[\s\S]*Shard 2\/3[\s\S]*Shard 3\/3/)
})

test("a skipped shard with every build fine fails", () => {
  const verdict = judge(missing(2), shards("success", "skipped", "success"))
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.unaccounted, ["Shard 2/3: job skipped with no failed build to explain it"])
})

test("a failed build does not excuse a shard that ran and left nothing", () => {
  const verdict = judge(missing(2), [job("Build Agent", "failure"), ...shards("success", "success", "success")])
  assert.equal(verdict.ok, false)
})

test("a failed job that is not a shard or build accounts for nothing", () => {
  const verdict = judge(missing(2), [job("Multi-device", "failure"), job("Shard 1/3", "success"), job("Shard 3/3", "success")])
  assert.equal(verdict.ok, false)
})

test("an unfinished shard job fails", () => {
  const verdict = judge(missing(2), shards("success", null, "success"))
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.unaccounted, ["Shard 2/3: job still unfinished"])
})

// ─── judgeMerge: failing closed ───

test("an unreadable job list keeps the merge red, naming the shard", () => {
  const verdict = judge(missing(2), undefined)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /Shard 2\/3/)
  assert.match(verdict.reason, /job list/i)
})
