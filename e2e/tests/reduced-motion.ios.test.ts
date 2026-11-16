/**
 * `reducedMotion: "reduce"` on an iOS simulator (set in the iOS simulator
 * configs): the daemon turns on UIKit's animation coefficient for the whole
 * simulator, so the app under test must carry the `UIKit/UIPreferences`
 * feature flag however it was launched — by the agent at startup, by the
 * cold deep-link reset at a file boundary (`simctl openurl`, which cannot
 * carry launch arguments), or by a restart.
 *
 * The check reads the app's process from the host, so it needs the
 * simulator's UDID (`TAPSMITH_IOS_UDID`, set by the iOS E2E workflow) to tell
 * this simulator's app from another one's, and is skipped without it.
 */
import { execFileSync } from "node:child_process"
import { describe, expect, test } from "../fixtures.js"

const UDID = process.env.TAPSMITH_IOS_UDID
const APP_BINARY = "/TapsmithTestApp.app/TapsmithTestApp"

/** The test app's process on this simulator, or undefined. */
function appPid(udid: string): string | undefined {
  const table = execFileSync("ps", ["-axww", "-o", "pid=,args="], { encoding: "utf8" })
  const line = table
    .split("\n")
    .find((l) => l.includes(`/Devices/${udid}/`) && l.trimEnd().endsWith(APP_BINARY))
  return line?.trim().split(/\s+/)[0]
}

/** The process's command line followed by its environment (`ps -E`). */
function appEnvironment(pid: string): string {
  return execFileSync("ps", ["-E", "-ww", "-p", pid, "-o", "command="], { encoding: "utf8" })
}

describe("reducedMotion on an iOS simulator", () => {
  test("the app runs with UIKit's sped-up animations on every launch", async ({ device, homeScreen }) => {
    test.skip(!UDID, "needs TAPSMITH_IOS_UDID to find the app's process on the host")
    const udid = UDID as string
    await expect(homeScreen.header).toBeVisible()

    const coefficient = execFileSync(
      "xcrun",
      ["simctl", "spawn", udid, "defaults", "read", "-g", "UIAnimationDragCoefficient"],
      { encoding: "utf8" },
    )
    expect(Number(coefficient.trim())).toBeCloseTo(0.1)

    // Launched by the file's reset (or the agent, for a shard's first file).
    const first = appPid(udid)
    expect(first).toBeDefined()
    expect(appEnvironment(first as string)).toContain("FEATUREFLAGS_ENABLED=UIKit/UIPreferences")

    await device.restartApp()
    await expect(homeScreen.header).toBeVisible()
    const second = appPid(udid)
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    expect(appEnvironment(second as string)).toContain("FEATUREFLAGS_ENABLED=UIKit/UIPreferences")
  })
})
