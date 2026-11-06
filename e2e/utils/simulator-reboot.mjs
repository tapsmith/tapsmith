/**
 * A simulator reboot where every simctl call has a bound, for
 * `verify-mcp-first-snapshot.mjs` (PILOT-708).
 *
 * The reboots are this check's own setup, and on CI one has hung in simctl
 * until the step's timeout ended the job, with the log showing only that a
 * reboot had started. So each call says what it is waiting for when it
 * overruns, and one overrun gets one recovery and a fresh reboot. The caller
 * decides what recovering means, and whether it may at all.
 *
 * The logic is unit-tested (`utils/__tests__/simulator-reboot.test.mjs`); the
 * command runner is passed in.
 */

import { spawnSync } from "node:child_process"

/**
 * Far above the slowest reboots seen on CI runners (82 s for the whole
 * reboot at a load average of 300), so only a call that is stuck reaches them.
 */
export const REBOOT_TIMEOUTS_MS = {
  shutdown: 120_000,
  boot: 120_000,
  bootstatus: 300_000,
}

/**
 * Run a command for at most `timeoutMs`. A command that overruns is killed
 * with SIGKILL: a stuck simctl does not answer a polite signal, and this call
 * blocks until the command has gone.
 *
 * @returns {{ status: number | null, stderr: string, timedOut: boolean }}
 */
export function runBounded(command, args, timeoutMs) {
  const res = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" })
  const timedOut = res.error?.code === "ETIMEDOUT"
  return {
    status: res.status,
    stderr: res.stderr || (timedOut ? "" : (res.error?.message ?? "")),
    timedOut,
  }
}

class SimctlHang extends Error {}

/**
 * Shut down and boot a simulator, and wait until it has booted.
 *
 * @param {string} udid
 * @param {object} options
 * @param {(args: string[], timeoutMs: number) => { status: number | null, stderr: string, timedOut: boolean }} options.run
 *   runs `simctl <args>`
 * @param {(message: string) => void} options.log
 * @param {() => void} [options.recover] called once if a call hangs, before
 *   the reboot is redone. Without it, a hang fails the reboot at once.
 */
export function rebootSimulator(udid, { run, log, recover }) {
  const call = (args, timeoutMs) => {
    const res = run(args, timeoutMs)
    if (res.timedOut) {
      throw new SimctlHang(`simctl ${args.join(" ")} did not finish within ${Math.round(timeoutMs / 1000)}s`)
    }
    return res
  }
  const attempt = () => {
    // Already shut down is fine, so its exit status does not matter.
    call(["shutdown", udid], REBOOT_TIMEOUTS_MS.shutdown)
    for (const [args, timeoutMs] of [
      [["boot", udid], REBOOT_TIMEOUTS_MS.boot],
      [["bootstatus", udid, "-b"], REBOOT_TIMEOUTS_MS.bootstatus],
    ]) {
      const res = call(args, timeoutMs)
      if (res.status !== 0) {
        throw new Error(`simctl ${args.join(" ")} failed (${res.status}): ${res.stderr.trim()}`)
      }
    }
  }

  try {
    attempt()
    return
  } catch (err) {
    if (!(err instanceof SimctlHang) || !recover) throw err
    log(`  ${err.message}; recovering and rebooting again`)
  }
  recover()
  try {
    attempt()
  } catch (err) {
    if (err instanceof SimctlHang) throw new Error(`${err.message}, even after recovering`)
    throw err
  }
}
