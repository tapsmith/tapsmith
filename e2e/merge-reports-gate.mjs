#!/usr/bin/env node
// Run `tapsmith merge-reports` for an E2E workflow's Merge Reports job, and
// fail the job only when that adds something: a real merge error, or a shard
// with no results when nothing else makes the run fail (PILOT-1023). A shard that
// failed, or never ran because a build failed, is reported as a notice, because
// the run already fails for it.
//
//   node merge-reports-gate.mjs <blob dir> <config file>
//
// Needs SHARD_TOTAL, and GITHUB_TOKEN with `actions: read` to list this run
// attempt's jobs. Without a job list, a missing shard stays red.
//
// The judging lives in utils/merge-gate-checks.mjs (unit-tested); this file
// only runs the merge and gathers the job list.

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import { judgeMerge } from "./utils/merge-gate-checks.mjs"

const MAX_OUTPUT_CHARS = 64 * 1024

const [blobDir, configFile] = process.argv.slice(2)
const shardTotal = Number(process.env.SHARD_TOTAL)
if (!blobDir || !configFile || !Number.isInteger(shardTotal) || shardTotal < 1) {
  console.error("Usage: SHARD_TOTAL=<n> node merge-reports-gate.mjs <blob dir> <config file>")
  process.exit(2)
}

/** Run merge-reports, passing its output through, and keep the end of it to judge. */
function runMerge() {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tapsmith", "merge-reports", blobDir, "-c", configFile], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const tee = (target) => (chunk) => {
      target.write(chunk)
      output = (output + chunk).slice(-MAX_OUTPUT_CHARS)
    }
    child.stdout.on("data", tee(process.stdout))
    child.stderr.on("data", tee(process.stderr))
    child.on("error", (err) => {
      console.error(`Could not run merge-reports: ${err.message}`)
      resolve({ exitCode: 1, output })
    })
    child.on("close", (code) => resolve({ exitCode: code ?? 1, output }))
  })
}

/** This run attempt's jobs, or undefined when they can't be read. */
async function listJobs() {
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_TOKEN } = process.env
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GITHUB_RUN_ATTEMPT) {
    console.error("Cannot list this run's jobs: not running in GitHub Actions, or GITHUB_TOKEN is not set.")
    return undefined
  }
  const api = GITHUB_API_URL ?? "https://api.github.com"
  const url = `${api}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}/jobs?per_page=100`
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${GITHUB_TOKEN}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      console.error(`Cannot list this run's jobs: GitHub answered ${response.status}.`)
      return undefined
    }
    const { jobs } = await response.json()
    return jobs.map(({ name, conclusion }) => ({ name, conclusion }))
  } catch (err) {
    console.error(`Cannot list this run's jobs: ${err.message}`)
    return undefined
  }
}

const { exitCode, output } = await runMerge()
const jobs = exitCode === 0 ? undefined : await listJobs()
const verdict = judgeMerge({ exitCode, mergeOutput: output, jobs, shardTotal })

console.log(`\nMerge gate: ${verdict.ok ? "pass" : "fail"}`)
for (const line of verdict.accounted) {
  console.log(`::notice title=Not in the merged report::${line}.`)
}
if (verdict.reason) {
  console.log(`::error title=Merge Reports::${verdict.reason.replaceAll("\n", "%0A")}`)
}
if (process.env.GITHUB_STEP_SUMMARY && !verdict.ok) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Merge Reports failed\n\n\`\`\`\n${verdict.reason}\n\`\`\`\n`)
}
process.exit(verdict.ok ? 0 : 1)
