import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-1435: a screen laid out edge to edge draws its content under the
// system status bar, which takes every touch in its band. A button there used
// to be "tapped" at its centre, on the status bar, and tap() reported success
// while the button never saw it.

describe("Content under the status bar", () => {
  test.use({ appResetScope: "test" })

  const failureOf = (action: Promise<unknown>) =>
    action.then(
      () => "",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )

  test("tap() on a button wholly under it fails, without tapping it", async ({ device, statusBarScreen }) => {
    await openScreen(device, "/status-bar")
    await expect(statusBarScreen.counts).toHaveText("under=0 partly=0")

    const failure = await failureOf(statusBarScreen.under.tap({ timeout: 1_500 }))
    if (device.platform === "ios") {
      // iOS lists it, and XCUITest calls it hittable: the agent names the bar.
      expect(failure).toContain("covered by the status bar")
    } else {
      // Android leaves a view wholly behind the status bar out of the
      // accessibility tree, as it does one behind the keyboard.
      expect(failure).toContain("was not found")
    }

    await expect(statusBarScreen.counts).toHaveText("under=0 partly=0")
  })

  // Its centre is under the bar: the tap must aim below the bar.
  test("tap() on a button partly under it taps the part below the bar", async ({ device, statusBarScreen }) => {
    await openScreen(device, "/status-bar")
    await expect(statusBarScreen.counts).toHaveText("under=0 partly=0")

    await statusBarScreen.partly.tap()

    await expect(statusBarScreen.counts).toHaveText("under=0 partly=1")
  })

  test("tap() on a button under a status bar the app hides taps it", async ({ device, statusBarScreen }) => {
    await openScreen(device, "/status-bar")
    await statusBarScreen.hideStatusBar.tap()
    await expect(statusBarScreen.showStatusBar).toBeVisible()

    await statusBarScreen.under.tap()

    await expect(statusBarScreen.counts).toHaveText("under=1 partly=0")
  })
})
