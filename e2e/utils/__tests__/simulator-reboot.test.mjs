/**
 * Tests for the bounded simulator reboot `verify-mcp-first-snapshot.mjs` uses
 * (PILOT-708). CI runs have hung in the reboot for the rest of the step's
 * 15 minutes, with nothing in the log to say which simctl call was stuck.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { rebootSimulator, runBounded } from "../simulator-reboot.mjs"

const UDID = "SIM-1"

/** A `run` that answers from a script, keyed by subcommand, and records calls. */
function fakeRun(script = {}) {
  const calls = []
  const counts = {}
  const run = (args, timeoutMs) => {
    const step = args[0]
    counts[step] = (counts[step] ?? 0) + 1
    calls.push({ args, timeoutMs })
    const answers = script[step] ?? []
    return answers[counts[step] - 1] ?? { status: 0, stderr: "", timedOut: false }
  }
  return { run, calls, steps: () => calls.map((c) => c.args[0]) }
}

const hung = { status: null, stderr: "", timedOut: true }

test("a reboot shuts down, boots and waits for the boot, each under its own bound", () => {
  const { run, calls, steps } = fakeRun()
  rebootSimulator(UDID, { run, log: () => {} })
  assert.deepEqual(steps(), ["shutdown", "boot", "bootstatus"])
  assert.deepEqual(calls[2].args, ["bootstatus", UDID, "-b"])
  for (const call of calls) assert.ok(call.timeoutMs > 0, `${call.args[0]} has no bound`)
})

test("a simulator that is already shut down is fine", () => {
  const { run, steps } = fakeRun({
    shutdown: [{ status: 149, stderr: "Unable to shutdown device in current state: Shutdown", timedOut: false }],
  })
  rebootSimulator(UDID, { run, log: () => {} })
  assert.deepEqual(steps(), ["shutdown", "boot", "bootstatus"])
})

test("a boot that fails outright fails with simctl's own words, and is not retried", () => {
  const { run, steps } = fakeRun({ boot: [{ status: 1, stderr: "Invalid device", timedOut: false }] })
  let recovered = 0
  assert.throws(
    () => rebootSimulator(UDID, { run, log: () => {}, recover: () => { recovered++ } }),
    /simctl boot SIM-1 failed \(1\): Invalid device/,
  )
  assert.equal(recovered, 0)
  assert.deepEqual(steps(), ["shutdown", "boot"])
})

for (const step of ["shutdown", "boot", "bootstatus"]) {
  test(`a hung ${step} is named in the log, recovered from and the whole reboot redone`, () => {
    const { run, steps } = fakeRun({ [step]: [hung] })
    const logs = []
    let recovered = 0
    rebootSimulator(UDID, { run, log: (m) => logs.push(m), recover: () => { recovered++ } })
    assert.equal(recovered, 1)
    assert.match(logs.join("\n"), new RegExp(`simctl ${step} .*did not finish within \\d+s`))
    const hungAt = ["shutdown", "boot", "bootstatus"].indexOf(step)
    assert.deepEqual(steps(), [
      ...["shutdown", "boot", "bootstatus"].slice(0, hungAt + 1),
      "shutdown",
      "boot",
      "bootstatus",
    ])
  })
}

test("a hang with no recovery available fails at once, naming the stuck call", () => {
  const { run, steps } = fakeRun({ bootstatus: [hung] })
  assert.throws(
    () => rebootSimulator(UDID, { run, log: () => {} }),
    /simctl bootstatus SIM-1 -b did not finish within \d+s/,
  )
  assert.deepEqual(steps(), ["shutdown", "boot", "bootstatus"])
})

test("a second hang after recovering ends the reboot: one recovery only", () => {
  const { run } = fakeRun({ shutdown: [hung, hung] })
  let recovered = 0
  assert.throws(
    () => rebootSimulator(UDID, { run, log: () => {}, recover: () => { recovered++ } }),
    /simctl shutdown SIM-1 did not finish within \d+s, even after recovering/,
  )
  assert.equal(recovered, 1)
})

test("runBounded kills a command that outlives its bound and says so", () => {
  const started = Date.now()
  const res = runBounded(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], 300)
  assert.equal(res.timedOut, true)
  assert.ok(Date.now() - started < 30_000, "the bound did not end the command")
})

test("runBounded reports a normal exit, and a command that cannot start", () => {
  const done = runBounded(process.execPath, ["-e", "console.error('nope'); process.exit(3)"], 30_000)
  assert.deepEqual([done.status, done.timedOut, done.stderr.trim()], [3, false, "nope"])
  const missing = runBounded("/nonexistent/simctl", [], 30_000)
  assert.equal(missing.timedOut, false)
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /ENOENT/)
})
