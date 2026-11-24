#!/usr/bin/env node
/**
 * Verify that a trace recorded against a *real device* contains real data.
 *
 * The SDK unit suite covers the archive end to end
 * (`packages/tapsmith/src/__tests__/trace-archive-contents.test.ts`), but every
 * capture there comes from a mocked gRPC client. Nothing checked that a trace
 * produced by an actual emulator/simulator holds decodable screenshots at the
 * device's real resolution, a hierarchy snapshot that actually contains the
 * element its action targeted, or the app's genuine HTTPS traffic. Those are
 * the failures a mock cannot reproduce, and they were invisible to the device
 * E2E suite, which keeps a trace only for a failed or retried attempt
 * (`retain-on-failure-and-retries`).
 *
 * This drives one existing E2E test with tracing forced on, then reads the
 * archive it produced and checks it. Everything it asserts is derived from the
 * archive itself — the selectors the steps recorded, the screenshot dimensions
 * the device reported — so it stays correct if the test it drives is edited.
 * The checks live in `utils/trace-archive-checks.mjs` and are unit-tested.
 *
 * Usage:
 *   node verify-trace-archive.mjs -c tapsmith.config.android-ci.mjs [--device SERIAL]
 *   node verify-trace-archive.mjs --verify-only path/to/trace.zip
 *
 * Other arguments are passed through to `tapsmith test`. `--verify-only` skips
 * the run and re-checks an archive that already exists, which is how a CI
 * failure is reproduced from the uploaded artifact.
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { checkArchive, readArchive } from "./utils/trace-archive-checks.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The test this drives: taps a button and waits on a real HTTPS response. */
const TEST_FILE = "tests/api-calls.test.ts"
const TEST_GREP = "fetches and displays user"
/**
 * Driven alongside it: turns the device to landscape, so the checks see
 * turned captures and can hold them to their hierarchy dumps (PILOT-1235:
 * iOS once sent a landscape screen's pixels sideways). It makes no requests.
 */
const LANDSCAPE_TEST_FILE = "tests/gestures.test.ts"
const LANDSCAPE_TEST_NAME = "a landscape screen is captured upright"
/**
 * The host that test's request goes to. The network checks are pinned to it, so
 * they cannot be satisfied by unrelated traffic — `--trace on` replaces the
 * config's whole `trace` object with the string form (`resolveTraceConfig`
 * returns pure defaults), which drops the iOS config's
 * `networkHosts: ["jsonplaceholder.typicode.com", "127.0.0.1"]` allowlist. This
 * run therefore captures a wider set of entries than the rest of the suite, and
 * without this pin a Metro/system call could stand in for the app's own.
 */
const EXPECTED_HOST = "jsonplaceholder.typicode.com"

// Not the sharded run's folder: this run would clear its traces.
const OUTPUT_DIR = process.env.E2E_OUTPUT_DIR ?? "tapsmith-results"
const TRACES_DIR = path.join(HERE, OUTPUT_DIR, "traces")

function runTracedTest(passthrough) {
  const args = [
    "tapsmith",
    "test",
    TEST_FILE,
    LANDSCAPE_TEST_FILE,
    "--trace",
    "on",
    "--workers",
    "1",
    "--grep",
    `${TEST_GREP}|${LANDSCAPE_TEST_NAME}`,
    // Leave the sharded run's html/blob output untouched.
    "--reporter",
    "list",
    ...passthrough,
  ]
  console.log(`> npx ${args.join(" ")}`)
  const res = spawnSync("npx", args, { cwd: HERE, stdio: "inherit" })
  if (res.error) throw res.error
  return res.status ?? 1
}

function tracesSince(sinceMs) {
  if (!fs.existsSync(TRACES_DIR)) return []
  return fs
    .readdirSync(TRACES_DIR)
    .filter((f) => f.endsWith(".zip"))
    .map((f) => {
      const full = path.join(TRACES_DIR, f)
      return { full, mtimeMs: fs.statSync(full).mtimeMs }
    })
    // Only traces this run produced — the sharded run before it may have
    // retained traces for failed tests.
    .filter((c) => c.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((c) => c.full)
}

/** The newest of `zips` whose metadata names a test ending in `testName`. */
function traceOf(zips, testName) {
  return zips.find((zip) => readArchive(zip).metadata.testName?.endsWith(testName)) ?? null
}

/**
 * Check one archive. `landscape` is for the landscape test's trace: no
 * network, and a landscape capture required.
 */
function verify(zipPath, { landscape = false } = {}) {
  const shown = zipPath.startsWith(HERE) ? path.relative(HERE, zipPath) : zipPath
  console.log(`\nVerifying ${shown} (${fs.statSync(zipPath).size} bytes)`)
  const archive = readArchive(zipPath)
  const options = landscape
    ? { network: false, expectLandscape: true }
    : { expectedHost: EXPECTED_HOST }
  const { failures, notes } = checkArchive(archive, options)
  for (const line of notes) console.log(`  · ${line}`)

  if (failures.length > 0) {
    console.error(`\n✖ ${failures.length} trace content check(s) failed:`)
    for (const failure of failures) console.error(`  - ${failure}`)
    return 1
  }
  console.log("\n✔ trace archive contents verified against real device data")
  return 0
}

function main() {
  const argv = process.argv.slice(2)

  const only = argv.indexOf("--verify-only")
  if (only !== -1) {
    const zipPath = argv[only + 1]
    if (!zipPath || !fs.existsSync(zipPath)) {
      console.error("--verify-only needs the path to an existing trace .zip")
      process.exit(2)
    }
    const zip = path.resolve(zipPath)
    const landscape = !!readArchive(zip).metadata.testName?.endsWith(LANDSCAPE_TEST_NAME)
    process.exit(verify(zip, { landscape }))
  }

  const startedAt = Date.now()
  const status = runTracedTest(argv)
  if (status !== 0) {
    console.error(`\n✖ the traced run failed (exit ${status}) — nothing to verify`)
    process.exit(status)
  }

  const zips = tracesSince(startedAt - 1000)
  const zipPath = traceOf(zips, TEST_GREP)
  if (!zipPath) {
    console.error(`\n✖ the run passed but wrote no trace archive for "${TEST_GREP}" to ${TRACES_DIR}`)
    process.exit(1)
  }
  let result = verify(zipPath)
  const landscapePath = traceOf(zips, LANDSCAPE_TEST_NAME)
  if (!landscapePath) {
    console.error(`\n✖ the run passed but wrote no trace archive for "${LANDSCAPE_TEST_NAME}" to ${TRACES_DIR}`)
    process.exit(1)
  }
  if (readArchive(landscapePath).metadata.testStatus === "skipped") {
    // The test skips itself where the runtime turns the device but not the
    // app's UI: there is no landscape screen to check there.
    console.log(`\n· ${LANDSCAPE_TEST_NAME}: skipped (the app's UI did not rotate) — no landscape captures to check`)
  } else {
    result = Math.max(result, verify(landscapePath, { landscape: true }))
  }
  process.exit(result)
}

main()
