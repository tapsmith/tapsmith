#!/usr/bin/env node
/**
 * Decides whether CI runs `verify-mcp-first-snapshot.mjs` (PILOT-462).
 *
 * The check costs ~9 min on a macOS runner (two simulator reboots, three cold
 * agent starts), so on a pull request it runs only when the PR touches the
 * code it guards. On push to main and on manual runs it always runs. When the
 * changed files can't be determined it runs as well: a skipped regression
 * check is the expensive mistake.
 *
 * As a CLI (the e2e-ios.yml step), it reads the event name and the PR's base
 * commit from the environment, diffs the checked-out PR merge commit against
 * that base, prints the decision and writes `run=true|false` to
 * $GITHUB_OUTPUT. The decision logic is unit-tested in
 * `utils/__tests__/mcp-first-snapshot-paths.test.mjs`.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Path prefixes the check guards. A trailing `/` means "anything under".
 * Keep this list and the PR description of PILOT-462 in step.
 */
export const GUARDED_PATHS = [
  // Simulator data-container clearing and app-state restore, agent launch.
  "packages/tapsmith-core/src/ios/",
  // Where the daemon wires clearData, resets and restore to the ios/ helpers.
  "packages/tapsmith-core/src/grpc_server.rs",
  // ...and the platform backends those handlers call.
  "packages/tapsmith-core/src/grpc_server/",
  "packages/tapsmith-core/src/agent_comms.rs",
  // The XCUITest agent: the startup accessibility check and the dump error.
  "ios-agent/",
  // The headless MCP server the check drives.
  "packages/tapsmith/src/mcp/",
  // The check itself and the workflow that runs it.
  "e2e/verify-mcp-first-snapshot.mjs",
  "e2e/utils/mcp-first-snapshot-checks.mjs",
  "e2e/utils/mcp-first-snapshot-paths.mjs",
  "e2e/utils/__tests__/mcp-first-snapshot-checks.test.mjs",
  "e2e/utils/__tests__/mcp-first-snapshot-paths.test.mjs",
  ".github/workflows/e2e-ios.yml",
]

/** Whether `file` (repo-relative) is one of the guarded paths. */
export function isGuarded(file) {
  return GUARDED_PATHS.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p))
}

/**
 * @param {{ eventName: string, changedFiles: string[] | null }} input
 *   `changedFiles` is null when they could not be determined.
 * @returns {{ run: boolean, reason: string }}
 */
export function decide({ eventName, changedFiles }) {
  if (eventName !== "pull_request") {
    return { run: true, reason: `event "${eventName}" always runs the check` }
  }
  if (changedFiles === null) {
    return { run: true, reason: "could not list the PR's changed files; running to be safe" }
  }
  const hits = changedFiles.filter(isGuarded)
  if (hits.length > 0) {
    const shown = hits.slice(0, 5).join(", ") + (hits.length > 5 ? `, … (${hits.length} files)` : "")
    return { run: true, reason: `the PR touches guarded paths: ${shown}` }
  }
  return {
    run: false,
    reason: `none of the PR's ${changedFiles.length} changed file(s) are guarded paths`,
  }
}

/** Run git; on failure, throw with its stderr so the log says why. */
function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr).trim() : ""
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`)
  }
}

/**
 * The commit the PR is compared against: the checked-out merge commit's first
 * parent (the base branch tip GitHub merged into), else `baseSha`.
 * `pull_request.base.sha` can lag the base branch, and diffing against it
 * would count commits main gained since as the PR's own.
 */
function comparisonBase(baseSha) {
  // `cat-file -p` reads the parents from the commit object itself, which a
  // depth-1 checkout has even though it lacks the parent commits.
  const parents = git(["cat-file", "-p", "HEAD"])
    .split("\n")
    .filter((l) => l.startsWith("parent "))
    .map((l) => l.slice("parent ".length).trim())
  return parents.length >= 2 ? parents[0] : baseSha
}

/** Files the PR changes: the merge commit against the base it was merged into. */
function changedFilesSince(baseSha) {
  try {
    const base = comparisonBase(baseSha)
    if (!base) return null
    // The shard job's checkout is shallow; fetch just the base commit. A diff
    // of two trees needs no shared history.
    git(["fetch", "--no-tags", "--depth=1", "origin", base])
    // --no-renames: a rename lists both the old and the new path, so moving a
    // file out of a guarded directory still counts. -z: paths come unquoted.
    return git(["diff", "--name-only", "--no-renames", "-z", base, "HEAD"]).split("\0").filter(Boolean)
  } catch (err) {
    console.log(`could not list the PR's changed files: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

function main() {
  const eventName = process.env.EVENT_NAME ?? ""
  const changedFiles = eventName === "pull_request" ? changedFilesSince(process.env.BASE_SHA ?? "") : []
  const { run, reason } = decide({ eventName, changedFiles })
  console.log(`verify-mcp-first-snapshot: ${run ? "run" : "skip"} — ${reason}`)
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
