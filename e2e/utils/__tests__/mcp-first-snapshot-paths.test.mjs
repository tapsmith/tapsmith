/**
 * Tests for when CI runs `verify-mcp-first-snapshot.mjs`: always outside pull
 * requests, and on a pull request only when it touches the guarded code.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import assert from "node:assert/strict"
import { decide, GUARDED_PATHS, isGuarded } from "../mcp-first-snapshot-paths.mjs"

test("push and workflow_dispatch always run, whatever changed", () => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    assert.equal(decide({ eventName, changedFiles: ["README.md"] }).run, true)
    assert.equal(decide({ eventName, changedFiles: [] }).run, true)
  }
})

test("a PR that touches no guarded path skips the check", () => {
  const d = decide({
    eventName: "pull_request",
    changedFiles: [
      "docs/locators.md",
      "packages/tapsmith/src/expect.ts",
      "agent/src/main/kotlin/Agent.kt",
      "packages/tapsmith-core/src/android/adb.rs",
      ".github/workflows/e2e-android.yml",
      "e2e/tests/login.test.ts",
    ],
  })
  assert.equal(d.run, false)
  assert.match(d.reason, /none of the PR's 6 changed file/)
})

test("a PR touching any guarded area runs the check", () => {
  const samples = [
    "packages/tapsmith-core/src/ios/device.rs",
    "packages/tapsmith-core/src/grpc_server.rs",
    "packages/tapsmith-core/src/grpc_server/ios_backend.rs",
    "packages/tapsmith-core/src/agent_comms.rs",
    "ios-agent/TapsmithAgent/HierarchyDumper.swift",
    "ios-agent/TapsmithAgent.xcodeproj/project.pbxproj",
    "packages/tapsmith/src/mcp/connection.ts",
    "packages/tapsmith/src/mcp/tools/snapshot.ts",
    "e2e/verify-mcp-first-snapshot.mjs",
    "e2e/utils/mcp-first-snapshot-checks.mjs",
    "e2e/utils/mcp-first-snapshot-paths.mjs",
    ".github/workflows/e2e-ios.yml",
  ]
  for (const file of samples) {
    const d = decide({ eventName: "pull_request", changedFiles: ["docs/x.md", file] })
    assert.equal(d.run, true, file)
    assert.match(d.reason, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
})

test("prefixes are matched as path prefixes, exact files exactly", () => {
  assert.equal(isGuarded("packages/tapsmith-core/src/ios_helper.rs"), false)
  assert.equal(isGuarded("packages/tapsmith-core/src/grpc_server.rs.bak"), false)
  assert.equal(isGuarded("ios-agent-docs/readme.md"), false)
  assert.equal(isGuarded("packages/tapsmith/src/mcp-utils.ts"), false)
  assert.equal(isGuarded(".github/workflows/e2e-ios-multi.yml"), false)
})

test("unknown changed files run the check rather than skip it", () => {
  assert.equal(decide({ eventName: "pull_request", changedFiles: null }).run, true)
})

test("every guarded path exists, so a rename can't silently drop it from the filter", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  for (const p of GUARDED_PATHS) assert.ok(existsSync(join(root, p)), p)
})

// git with a clean environment: no GIT_DIR/GIT_WORK_TREE leaking in from a
// caller (a hook), and no signing from the user's global config.
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k]
  return env
}

function scratchRepo() {
  const repo = mkdtempSync(join(tmpdir(), "mcp-paths-"))
  const git = (...a) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
      cwd: repo,
      encoding: "utf8",
      env: cleanEnv(),
    }).trim()
  git("init", "-q")
  return { repo, git }
}

const SCRIPT = fileURLToPath(new URL("../mcp-first-snapshot-paths.mjs", import.meta.url))

function runCli(repo, baseSha, eventName = "pull_request") {
  const out = join(repo, `out-${Math.random()}`)
  execFileSync(process.execPath, [SCRIPT], {
    cwd: repo,
    env: cleanEnv({ EVENT_NAME: eventName, BASE_SHA: baseSha, GITHUB_OUTPUT: out }),
  })
  return readFileSync(out, "utf8").trim()
}

function commitFile(repo, git, file) {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), file)
  git("add", "-A")
  git("commit", "-q", "-m", file)
}

test("the CLI writes run=false for a non-guarded diff and run=true for a guarded one", () => {
  const { repo, git } = scratchRepo()
  try {
    git("commit", "-q", "--allow-empty", "-m", "base")
    const base = git("rev-parse", "HEAD")
    // The CLI fetches the base from origin; point origin at the repo itself.
    git("remote", "add", "origin", repo)
    commitFile(repo, git, "docs/a.md")
    assert.equal(runCli(repo, base), "run=false")
    commitFile(repo, git, "ios-agent/X.swift")
    assert.equal(runCli(repo, base), "run=true")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("moving a file out of a guarded directory runs the check", () => {
  const { repo, git } = scratchRepo()
  try {
    commitFile(repo, git, "ios-agent/A.swift")
    const base = git("rev-parse", "HEAD")
    git("remote", "add", "origin", repo)
    mkdirSync(join(repo, "other"))
    git("mv", "ios-agent/A.swift", "other/A.swift")
    git("commit", "-q", "-m", "move")
    assert.equal(runCli(repo, base), "run=true")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("a base commit that cannot be fetched runs the check", () => {
  const { repo, git } = scratchRepo()
  try {
    commitFile(repo, git, "docs/a.md")
    git("remote", "add", "origin", repo)
    assert.equal(runCli(repo, "0123456789abcdef0123456789abcdef01234567"), "run=true")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("the CLI always runs outside a pull request, and on a PR with no base sha", () => {
  const { repo, git } = scratchRepo()
  try {
    commitFile(repo, git, "docs/a.md")
    assert.equal(runCli(repo, "", "push"), "run=true")
    assert.equal(runCli(repo, "", "workflow_dispatch"), "run=true")
    // A plain (non-merge) HEAD with no base sha: nothing to diff against.
    assert.equal(runCli(repo, ""), "run=true")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("a PR merge commit is diffed against its first parent, not a stale base sha", () => {
  // GitHub checks out refs/pull/N/merge: main's tip merged with the PR. The
  // event's base.sha can predate commits main gained since; those are not
  // the PR's changes.
  const { repo, git } = scratchRepo()
  try {
    git("checkout", "-q", "-b", "main")
    commitFile(repo, git, "README.md")
    const staleBase = git("rev-parse", "HEAD")
    git("remote", "add", "origin", repo)
    git("checkout", "-q", "-b", "pr")
    commitFile(repo, git, "docs/a.md")
    git("checkout", "-q", "main")
    commitFile(repo, git, "ios-agent/Later.swift") // landed on main after the PR's base
    git("merge", "-q", "--no-ff", "-m", "merge pr", "pr")
    assert.equal(runCli(repo, staleBase), "run=false")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
