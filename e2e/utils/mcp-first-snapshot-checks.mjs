/**
 * Pure helpers for `verify-mcp-first-snapshot.mjs`: framing the MCP server's
 * stdio JSON-RPC output and judging a `tapsmith_snapshot` result. Kept apart
 * from the script so they are unit-tested without a device
 * (`utils/__tests__/mcp-first-snapshot-checks.test.mjs`).
 */

/**
 * Split newline-delimited JSON-RPC output into parsed messages.
 * Returns the messages, the lines that were not JSON (anything the server
 * writes to stdout outside the protocol corrupts a real client, so the caller
 * reports them), and the incomplete trailing chunk to prepend to the next read.
 *
 * @param {string} buffer
 * @returns {{ messages: object[], nonJson: string[], rest: string }}
 */
export function splitJsonRpcLines(buffer) {
  const messages = []
  const nonJson = []
  const lines = buffer.split("\n")
  const rest = lines.pop() ?? ""
  for (const raw of lines) {
    const line = raw.trim()
    if (line === "") continue
    try {
      messages.push(JSON.parse(line))
    } catch {
      nonJson.push(line)
    }
  }
  return { messages, nonJson, rest }
}

/** The text of a `tools/call` result's content blocks, joined. */
export function resultText(response) {
  const content = response?.result?.content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("\n")
}

/**
 * Judge a `tapsmith_snapshot` JSON-RPC response. Returns the problems found;
 * an empty list means the snapshot is a real read of the expected screen.
 *
 * @param {object} response the JSON-RPC response to `tools/call`
 * @param {{ expectText: string }} options text the screen must contain
 * @returns {string[]}
 */
export function checkSnapshotResponse(response, { expectText }) {
  if (!response) return ["no response from the MCP server"]
  if (response.error) {
    return [`the MCP server returned a protocol error: ${JSON.stringify(response.error)}`]
  }
  const text = resultText(response)
  const problems = []
  if (response.result?.isError) {
    problems.push(`tapsmith_snapshot failed: ${text.slice(0, 500) || "(no message)"}`)
  }
  if (text.includes("Interrupting test")) {
    problems.push("the result surfaces XCUITest's internal \"Interrupting test\"")
  }
  if (!response.result?.isError && !text.includes(expectText)) {
    problems.push(
      `the snapshot does not contain "${expectText}" — got: ${text.slice(0, 300) || "(empty)"}`,
    )
  }
  return problems
}

// ─── Handshake timing (PILOT-580) ───
//
// The check used to fail now and then with "initialize got no response within
// 30s" on the first MCP session after a simulator reboot. These describe where
// a session's handshake time went, and how busy the host was, so the log of a
// slow or failed session says why.

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`

/**
 * One line on an MCP session's `initialize` handshake. Times are milliseconds
 * since the server process was spawned; null when it has not happened.
 *
 * @param {{ firstOutputMs: number | null, answeredMs: number | null, elapsedMs: number }} timing
 * @returns {string}
 */
export function describeHandshake({ firstOutputMs, answeredMs, elapsedMs }) {
  const output = firstOutputMs == null ? null : `first server output after ${seconds(firstOutputMs)}`
  if (answeredMs != null) {
    return `initialize answered after ${seconds(answeredMs)}${output ? ` (${output})` : ""}`
  }
  const head = `no initialize reply after ${seconds(elapsedMs)}`
  return output ? `${head} (${output})` : `${head} and no server output yet: the server process was still starting`
}

/**
 * One line on how busy the host is: how long a bare `node -e 0` took to run,
 * the load averages (`sysctl -n vm.loadavg`) and the busiest processes
 * (`ps -Ao pcpu=,comm= -r`, already sorted by CPU). Anything that could not
 * be sampled or parsed is left out.
 *
 * @param {{ nodeBootMs: number | null, loadavg: string | null, ps: string | null, top?: number }} sample
 * @returns {string}
 */
export function summarizeHostLoad({ nodeBootMs, loadavg, ps, top = 5 }) {
  const parts = []
  if (nodeBootMs != null) parts.push(`node boot ${seconds(nodeBootMs)}`)
  const load = /^\{?\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec((loadavg ?? "").trim())
  if (load) parts.push(`load ${load[1]} ${load[2]} ${load[3]}`)
  const busiest = []
  for (const line of (ps ?? "").split("\n")) {
    const m = /^\s*([\d.]+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    // `comm` is the executable's full path on macOS, and may contain spaces.
    busiest.push(`${m[2].split("/").pop()} ${Math.round(Number(m[1]))}%`)
    if (busiest.length === top) break
  }
  if (busiest.length > 0) parts.push(`top CPU: ${busiest.join(", ")}`)
  return parts.length > 0 ? parts.join(" · ") : "(no host sample)"
}
