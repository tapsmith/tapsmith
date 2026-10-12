#!/usr/bin/env node
/**
 * Regression check for PILOT-462: the first `tapsmith_snapshot` of a headless
 * MCP session on a freshly booted iOS simulator must return the screen.
 *
 * It used to fail after ~40 s with XCUITest's "Interrupting test". The daemon's
 * simulator clearData deleted the app container's container-manager metadata;
 * a later boot then reaped the orphaned container, and from there on the first
 * launch of the app after every boot (the agent's own launch at startup) had
 * no accessibility server. `tapsmith test` never noticed — every test
 * relaunches the app first — but an MCP session's first device tool did.
 *
 * This replays that sequence on a real simulator, through the MCP server the
 * way a client drives it:
 *
 *   1. reinstall the app (a fresh, healthy container);
 *   2. MCP session: `tapsmith_launch_app` with `clear_data: true`;
 *   3. reboot; MCP session: `tapsmith_snapshot` (the launch after which the
 *      orphaned container was reaped);
 *   4. reboot; new MCP session whose FIRST call is `tapsmith_snapshot` —
 *      checked: it must succeed and show the app's home screen.
 *
 * Both halves of the fix make step 4 pass on their own (the daemon keeps the
 * metadata; the agent relaunches an app it cannot see), so this guards either
 * regressing. The checks live in `utils/mcp-first-snapshot-checks.mjs` and are
 * unit-tested.
 *
 * Usage:
 *   node verify-mcp-first-snapshot.mjs -c tapsmith.config.ios-ci.mjs \
 *     --udid <simulator udid> --app ./fixtures/TapsmithTestApp.app
 *
 * `--udid` defaults to $TAPSMITH_IOS_UDID and `--bundle-id` to the test app's
 * (dev.tapsmith.testapp). Every MCP call is pinned to `--udid` with the
 * tools' `device` argument, so it drives the simulator the script reboots.
 */

import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  checkSnapshotResponse,
  describeHandshake,
  resultText,
  splitJsonRpcLines,
  summarizeHostLoad,
} from "./utils/mcp-first-snapshot-checks.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, "node_modules", "tapsmith", "dist", "cli.js")
/** Text on the test app's home screen, where a cleared app starts. */
const EXPECT_TEXT = "Tapsmith Test App"
/** Generous: the call includes a cold agent start on a just-booted simulator. */
const CALL_TIMEOUT_MS = 240_000
/**
 * How long the `initialize` handshake may take. On a warm host the server
 * answers in a few seconds (well under 1 s on a developer Mac). Straight after
 * a simulator reboot the CI runner is so busy that the same handshake has
 * taken 3–28 s in passing runs, and past 30 s in the runs that failed
 * (PILOT-580): the server was still starting when the old 30 s budget ran
 * out, and answered a few seconds later. The reboot is this script's own
 * doing, so those sessions get the larger budget; session 1 keeps the strict
 * one, so a server that has really become slow to answer still fails here.
 */
const HANDSHAKE_TIMEOUT_MS = 30_000
const POST_REBOOT_HANDSHAKE_TIMEOUT_MS = 120_000

function parseArgs(argv) {
  const opts = { config: null, udid: process.env.TAPSMITH_IOS_UDID ?? null, app: null, bundleId: "dev.tapsmith.testapp" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "-c" || a === "--config") opts.config = next()
    else if (a === "--udid") opts.udid = next()
    else if (a === "--app") opts.app = next()
    else if (a === "--bundle-id") opts.bundleId = next()
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!opts.config) throw new Error("-c <config> is required")
  if (!opts.udid) throw new Error("--udid (or $TAPSMITH_IOS_UDID) is required")
  if (!opts.app) throw new Error("--app <path to the .app> is required")
  return opts
}

function log(msg) {
  console.log(`[mcp-first-snapshot] ${msg}`)
}

function simctl(...args) {
  const res = spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8" })
  if (res.status !== 0) {
    throw new Error(`xcrun simctl ${args.join(" ")} failed (${res.status}): ${res.stderr?.trim()}`)
  }
  return res.stdout
}

/**
 * How busy the host is right now, as one log line: a bare node start (what
 * the MCP server pays first), the load averages, the busiest processes.
 */
function sampleHostLoad() {
  const run = (cmd, args) => {
    const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 })
    return res.status === 0 ? res.stdout : null
  }
  const started = Date.now()
  const node = spawnSync(process.execPath, ["-e", "0"], { timeout: 30_000 })
  const nodeBootMs = node.status === 0 ? Date.now() - started : null
  return summarizeHostLoad({
    nodeBootMs,
    loadavg: run("sysctl", ["-n", "vm.loadavg"]),
    ps: run("ps", ["-Ao", "pcpu=,comm=", "-r"]),
  })
}

function reboot(udid) {
  log(`rebooting simulator ${udid}`)
  const started = Date.now()
  spawnSync("xcrun", ["simctl", "shutdown", udid], { encoding: "utf8" }) // already shut down is fine
  simctl("boot", udid)
  simctl("bootstatus", udid, "-b")
  log(`  booted in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

/**
 * One MCP stdio session: run `calls` in order, then close stdin and wait for
 * the server to exit. Logs how busy the host was at the start and how long
 * the handshake took, so a slow session's log says where its time went.
 */
async function mcpSession(config, calls, { handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS } = {}) {
  log(`  host: ${sampleHostLoad()}`)
  const spawnedAt = Date.now()
  let firstOutputAt = null
  const child = spawn(process.execPath, [CLI, "mcp-server", "--config", config], {
    cwd: HERE,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  })
  const stderr = []
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (d) => {
    firstOutputAt ??= Date.now()
    stderr.push(d)
  })
  // Writing to a server that already died must fail the call, not crash the script.
  child.stdin.on("error", () => {})

  const pending = new Map()
  let exitInfo = null
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal }
      // A server that dies mid-call fails its pending requests now, not at their timeout.
      for (const settle of pending.values()) settle(null)
      pending.clear()
      resolve(exitInfo)
    }),
  )
  const nonJsonStdout = []
  let buf = ""
  child.stdout.on("data", (d) => {
    const { messages, nonJson, rest } = splitJsonRpcLines(buf + d)
    buf = rest
    nonJsonStdout.push(...nonJson)
    for (const msg of messages) {
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })

  let nextId = 1
  const request = (method, params, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      if (exitInfo) {
        reject(new Error(`${method}: the MCP server already exited (${JSON.stringify(exitInfo)})`))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} got no response within ${timeoutMs / 1000}s`))
      }, timeoutMs)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        if (msg === null) reject(new Error(`${method}: the MCP server exited (${JSON.stringify(exitInfo)})`))
        else resolve(msg)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })

  const results = []
  let error = null
  const handshake = (answeredAt) =>
    describeHandshake({
      firstOutputMs: firstOutputAt == null ? null : firstOutputAt - spawnedAt,
      answeredMs: answeredAt == null ? null : answeredAt - spawnedAt,
      elapsedMs: Date.now() - spawnedAt,
    })
  try {
    try {
      await request(
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "verify-mcp-first-snapshot", version: "1" },
        },
        handshakeTimeoutMs,
      )
    } catch (err) {
      log(`  handshake: ${handshake(null)}`)
      log(`  host: ${sampleHostLoad()}`)
      throw err
    }
    log(`  handshake: ${handshake(Date.now())}`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    for (const { name, args } of calls) {
      const started = Date.now()
      const response = await request("tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS)
      const elapsed = ((Date.now() - started) / 1000).toFixed(1)
      log(`  ${name} → ${response.result?.isError ? "error" : "ok"} (${elapsed}s)`)
      results.push({ name, response, elapsed })
    }
  } catch (err) {
    error = err
  } finally {
    // The server shuts itself (and its daemon and agent) down on stdin EOF.
    child.stdin.end()
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 20_000))
    if ((await Promise.race([exited, timeout])) === null) {
      log("  MCP server did not exit within 20s of stdin closing; killing it")
      child.kill("SIGKILL")
      await exited
    }
  }
  const session = { results, stderr: stderr.join(""), nonJsonStdout }
  if (error) {
    // The server's stderr is the only diagnostic for a session that broke.
    printServerLog(session)
    throw error
  }
  return session
}

function printServerLog(session) {
  // ANSI colour codes make CI logs unreadable.
  const text = session.stderr.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim()
  if (text) console.log(text.split("\n").map((l) => `    | ${l}`).join("\n"))
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(CLI)) throw new Error(`Tapsmith CLI not found at ${CLI} — build packages/tapsmith first`)
  const app = path.resolve(opts.app)
  const failures = []

  // Uninstall first: `simctl install` over an existing install keeps its data
  // container, which may already be orphaned — the check must start healthy.
  log(`reinstalling ${app}`)
  spawnSync("xcrun", ["simctl", "uninstall", opts.udid, opts.bundleId], { encoding: "utf8" })
  simctl("install", opts.udid, app)

  log("session 1: tapsmith_launch_app with clear_data")
  const s1 = await mcpSession(opts.config, [
    { name: "tapsmith_launch_app", args: { package: opts.bundleId, clear_data: true, device: opts.udid } },
  ])
  const launch = s1.results[0]?.response
  if (!launch || launch.result?.isError) {
    printServerLog(s1)
    failures.push(`setup: tapsmith_launch_app clear_data failed: ${resultText(launch) || JSON.stringify(launch?.error)}`)
  }

  if (failures.length === 0) {
    reboot(opts.udid)
    log("session 2: tapsmith_snapshot after the first reboot")
    const s2 = await mcpSession(opts.config, [{ name: "tapsmith_snapshot", args: { device: opts.udid } }], {
      handshakeTimeoutMs: POST_REBOOT_HANDSHAKE_TIMEOUT_MS,
    })
    for (const p of checkSnapshotResponse(s2.results[0]?.response, { expectText: EXPECT_TEXT })) {
      failures.push(`after the first reboot: ${p}`)
    }
    if (failures.length > 0) printServerLog(s2)

    reboot(opts.udid)
    log("session 3: the first call of a new session is tapsmith_snapshot")
    const s3 = await mcpSession(opts.config, [{ name: "tapsmith_snapshot", args: { device: opts.udid } }], {
      handshakeTimeoutMs: POST_REBOOT_HANDSHAKE_TIMEOUT_MS,
    })
    const problems = checkSnapshotResponse(s3.results[0]?.response, { expectText: EXPECT_TEXT })
    for (const p of problems) failures.push(`after the second reboot: ${p}`)
    if (problems.length > 0) printServerLog(s3)
    for (const line of [...s1.nonJsonStdout, ...s2.nonJsonStdout, ...s3.nonJsonStdout]) {
      failures.push(`the MCP server wrote non-JSON-RPC output to stdout: ${line.slice(0, 200)}`)
    }
  }

  if (failures.length > 0) {
    console.error(`\n✖ ${failures.length} check(s) failed:`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log("\n✔ the first MCP snapshot after a clearData and two reboots returned the screen")
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
