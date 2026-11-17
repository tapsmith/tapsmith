#!/usr/bin/env node
/**
 * End-to-end check for PILOT-1239: the test lines MCP action tools answer
 * with, pasted into a test, replay the walk.
 *
 *   1. A headless MCP session walks the test app's login flow the way an AI
 *      agent would: launch the app fresh, tap through to the login form
 *      (a tap that navigates away: its line is checked on the screen it
 *      started from), type the credentials, tap the password field by
 *      position (`.nth(1)`: the device agent should replace it with a
 *      locator that matches the field alone), and sign in.
 *   2. Every action must answer with a verified `Test line:`, and the walk
 *      must end on the signed-in screen.
 *   3. The lines go, as they are, into a generated spec, which `tapsmith test`
 *      runs on the same device. It must pass, and end on the same screen.
 *
 * The checks on each result live in `utils/mcp-test-lines-checks.mjs` and are
 * unit-tested.
 *
 * Usage:
 *   node verify-mcp-test-lines.mjs -c tapsmith.config.android-ci.mjs --device <serial or udid>
 */

import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  describeServerExit,
  resultText,
  splitJsonRpcLines,
  waitForChildExit,
} from "./utils/mcp-first-snapshot-checks.mjs"
import { replaySpec, testLineOf } from "./utils/mcp-test-lines-checks.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, "node_modules", "tapsmith", "dist", "cli.js")
const PACKAGE = "dev.tapsmith.testapp"
/** Includes a cold agent start for the session's first call. */
const CALL_TIMEOUT_MS = 240_000
const HANDSHAKE_TIMEOUT_MS = 60_000
/** Where the replay's spec and config are written, and removed from afterwards. */
const GENERATED_DIR = path.join(HERE, "mcp-test-lines-generated")
const SIGNED_IN = "Login successful!"

/** The walk: what an agent would send, step by step. */
const WALK = [
  { name: "tapsmith_launch_app", args: { package: PACKAGE, clear_data: true } },
  { name: "tapsmith_tap", args: { locator: 'device.getByText("Login Form", { exact: true })' } },
  { name: "tapsmith_type", args: { locator: 'device.getByRole("textfield", { name: "Email" })', text: "test@example.com" } },
  { name: "tapsmith_tap", args: { locator: 'device.getByRole("textfield").nth(1)' } },
  { name: "tapsmith_type", args: { locator: 'device.getByRole("textfield", { name: "Password" })', text: "password123", clear: true } },
  { name: "tapsmith_tap", args: { locator: 'device.getByRole("button", { name: "Sign in" })' } },
]

function parseArgs(argv) {
  const opts = { config: null, device: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-c" || a === "--config") opts.config = argv[++i]
    else if (a === "--device") opts.device = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!opts.config) throw new Error("-c <config> is required")
  if (!opts.device) throw new Error("--device <serial or udid> is required")
  return opts
}

function log(msg) {
  console.log(`[mcp-test-lines] ${msg}`)
}

/**
 * One MCP stdio session: the calls in order, stopping at the first that
 * fails, then stdin closed (the server shuts itself and its daemon down).
 */
async function mcpSession(config, calls) {
  const child = spawn(process.execPath, [CLI, "mcp-server", "--config", config], {
    cwd: HERE,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  })
  const stderr = []
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (d) => stderr.push(d))
  child.stdin.on("error", () => {})
  const pending = new Map()
  let exitInfo = null
  const exited = waitForChildExit(child).then((info) => {
    exitInfo = info
    for (const settle of pending.values()) settle(null)
    pending.clear()
  })
  let buf = ""
  const nonJson = []
  child.stdout.on("data", (d) => {
    const { messages, nonJson: bad, rest } = splitJsonRpcLines(buf + d)
    buf = rest
    nonJson.push(...bad)
    for (const msg of messages) {
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })
  let nextId = 1
  const request = (method, params, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (exitInfo) return reject(new Error(`${method}: ${describeServerExit(exitInfo)}`))
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} got no response within ${timeoutMs / 1000}s`))
      }, timeoutMs)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        if (msg === null) reject(new Error(`${method}: ${describeServerExit(exitInfo)}`))
        else resolve(msg)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })

  const results = []
  let error = null
  try {
    await request(
      "initialize",
      { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "verify-mcp-test-lines", version: "1" } },
      HANDSHAKE_TIMEOUT_MS,
    )
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    for (const { name, args } of calls) {
      const started = Date.now()
      const response = await request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS)
      log(`  ${name} ${JSON.stringify(args)} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
      for (const line of resultText(response).split("\n").slice(0, 4)) log(`    | ${line}`)
      results.push({ name, response })
      if (response.error || response.result?.isError) break
    }
  } catch (err) {
    error = err
  } finally {
    child.stdin.end()
    const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 20_000))
    if ((await Promise.race([exited, timeout])) === "timeout") {
      log("  MCP server did not exit within 20s of stdin closing; killing it")
      child.kill("SIGKILL")
      await exited
    }
  }
  return { results, error, stderr: stderr.join(""), nonJson }
}

function printServerLog(session) {
  const text = session.stderr.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim()
  if (text) console.log(text.split("\n").map((l) => `    | ${l}`).join("\n"))
}

/** Run the generated spec on the device with the base config's app and agent. */
function replay(baseConfig, device, lines) {
  fs.rmSync(GENERATED_DIR, { recursive: true, force: true })
  fs.mkdirSync(GENERATED_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(GENERATED_DIR, "walk.mcp-lines.ts"),
    replaySpec(lines, `await expect(device.getByText(${JSON.stringify(SIGNED_IN)}, { exact: true })).toBeVisible();`),
  )
  // The base config's device, app and agent; one project, this spec only.
  const config = path.join(HERE, "tapsmith.config.mcp-lines.generated.mjs")
  fs.writeFileSync(
    config,
    [
      `import base from ${JSON.stringify(`./${path.basename(baseConfig)}`)}`,
      "const { projects, ...rest } = base",
      "export default {",
      "  ...rest,",
      `  rootDir: ${JSON.stringify(HERE)},`,
      `  testMatch: [${JSON.stringify(`${path.basename(GENERATED_DIR)}/*.mcp-lines.ts`)}],`,
      '  reporter: [["list"]],',
      '  trace: "retain-on-failure",',
      '  video: "off",',
      "}",
      "",
    ].join("\n"),
  )
  console.log(fs.readFileSync(path.join(GENERATED_DIR, "walk.mcp-lines.ts"), "utf8"))
  const args = [CLI, "test", "-c", config, "--device", device, "--workers", "1"]
  log(`> node ${args.map((a) => path.relative(HERE, a) || a).join(" ")}`)
  const res = spawnSync(process.execPath, args, { cwd: HERE, stdio: "inherit" })
  fs.rmSync(config, { force: true })
  fs.rmSync(GENERATED_DIR, { recursive: true, force: true })
  if (res.error) throw res.error
  return res.status ?? 1
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(CLI)) throw new Error(`Tapsmith CLI not found at ${CLI} — build packages/tapsmith first`)
  const failures = []

  log("walking the login flow through the MCP server")
  const calls = [...WALK, { name: "tapsmith_snapshot", args: {} }].map((c) => ({ ...c, args: { ...c.args, device: opts.device } }))
  const session = await mcpSession(opts.config, calls)
  if (session.error) failures.push(`the MCP session broke: ${session.error.message}`)
  for (const line of session.nonJson) failures.push(`the MCP server wrote non-JSON-RPC output to stdout: ${line.slice(0, 200)}`)

  const lines = []
  WALK.forEach((step, i) => {
    const got = testLineOf(session.results[i]?.response)
    if ("problem" in got) failures.push(`step ${i + 1} (${step.name}): ${got.problem}`)
    else lines.push(got.line)
  })
  // The positional tap: the agent should have found the field's own locator.
  const positional = testLineOf(session.results[3]?.response)
  if ("line" in positional && !positional.replaced) {
    failures.push(`step 4: the .nth(1) tap was not replaced by a locator that matches the field alone: ${positional.line}`)
  }
  const snapshot = session.results[WALK.length]?.response
  if (snapshot && !resultText(snapshot).includes(SIGNED_IN)) {
    failures.push(`the walk did not end signed in; the screen was:\n${resultText(snapshot).slice(0, 1500)}`)
  }

  if (failures.length === 0) {
    log("replaying the lines as a test")
    const status = replay(opts.config, opts.device, lines)
    if (status !== 0) failures.push(`the replayed lines failed as a test (exit ${status})`)
  } else {
    printServerLog(session)
  }

  if (failures.length > 0) {
    console.error(`\n✖ ${failures.length} check(s) failed:`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log("\n✔ the MCP walk's test lines replayed as a passing test")
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
