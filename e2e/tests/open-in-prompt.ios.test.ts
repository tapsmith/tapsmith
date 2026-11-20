/**
 * SpringBoard's "Open in “App”?" prompt, raised from outside the test the way
 * `npx expo run:ios` leaves it (`simctl openurl <scheme>://…`). Locators only
 * see the app under test, so while it is up every lookup misses: the errors
 * must name it, and a relaunch must cancel it.
 *
 * Raising it needs the simulator's UDID on the host (`TAPSMITH_IOS_UDID`,
 * set by the iOS E2E workflow), so the test is skipped without it.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { describe, expect, test } from "../fixtures.js"

const UDID = process.env.TAPSMITH_IOS_UDID
const COVERING = "A system alert is covering the app: \"Open in “"

/**
 * Once Open has been pressed on a `simctl openurl` prompt for the scheme (the
 * daemon's cold deep-link path does), the simulator opens later ones without
 * asking. Forget that approval so the prompt comes up whatever ran before.
 */
function forgetSchemeApproval(udid: string): void {
  try {
    execFileSync("xcrun", ["simctl", "spawn", udid, "defaults", "delete",
      "com.apple.launchservices.schemeapproval", "com.apple.CoreSimulator.CoreSimulatorBridge-->tapsmithtest"],
    { stdio: "ignore", timeout: 30_000 })
  } catch {
    // Not approved yet: nothing to forget.
  }
}

/** `simctl openurl` can block until the prompt is answered, so leave it running. */
function raiseOpenInPrompt(udid: string): ChildProcess {
  const child = spawn("xcrun", ["simctl", "openurl", udid, "tapsmithtest://from-a-dev-tool"], { stdio: "ignore" })
  child.on("error", () => {})
  return child
}

describe("an Open-in prompt left on the simulator", () => {
  // Raising the prompt through simctl takes seconds on a busy runner.
  test.use({ timeout: 90_000 })

  test("is named in errors, and cancelled when the app is relaunched", async ({ device, homeScreen, loginScreen }) => {
    test.skip(!UDID, "needs TAPSMITH_IOS_UDID to raise the prompt from the host")
    await homeScreen.loginCard.tap()
    await expect(loginScreen.heading).toBeVisible()

    forgetSchemeApproval(UDID as string)
    const openurl = raiseOpenInPrompt(UDID as string)
    try {
      // Wait for SpringBoard to show it: until then the miss is an ordinary one.
      let missed = ""
      for (let i = 0; i < 30 && !missed.includes(COVERING); i++) {
        missed = await loginScreen.resetAlertMessage.tap({ timeout: 1_000 }).then(() => "", (e: Error) => e.message)
      }
      expect(missed).toContain(COVERING)
      expect(missed).toContain("(buttons: Cancel, Open)")

      // The focusing taps land on the alert, and the error says so.
      const typed = await loginScreen.emailField.type("a@b.co").then(() => "", (e: Error) => e.message)
      expect(typed).toContain("did not give it keyboard focus")
      expect(typed).toContain(COVERING)

      // A relaunch cancels it (Cancel, not Open), so the app takes taps again.
      await device.restartApp()
      await expect(homeScreen.header).toBeVisible()
      await homeScreen.loginCard.tap()
      await expect(loginScreen.heading).toBeVisible()
    } finally {
      openurl.kill()
    }
  })
})
