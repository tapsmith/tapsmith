/**
 * A permission alert a test raises and never answers. SpringBoard keeps it up
 * across relaunches and runs, covering the app for every later test, so
 * Tapsmith answers it once the test has ended (pressing an accepting button,
 * never a denial) — but, on a simulator, not while the test that raised it is
 * running.
 *
 * The two tests run in order in one file: the first leaves the alert up, the
 * second checks it starts clean.
 */
import { describe, expect, test } from "../fixtures.js"

const PKG = "dev.tapsmith.testapp"
const COVERING = "A system alert is covering the app"

describe("a permission alert a test leaves up", () => {
  // clearAppData reinstalls the app on a simulator, which takes a while on a busy runner.
  test.use({ timeout: 120_000 })

  test("stays up while the test that raised it runs", async ({ device, permissionsScreen }) => {
    // Clearing the app's data resets its permissions, so iOS asks again.
    await device.clearAppData(PKG)
    await device.launchApp(PKG)
    await permissionsScreen.open()
    await permissionsScreen.requestLocationButton.tap()

    // Wait for SpringBoard to show it, through the not-found message that
    // names a covering alert. A lookup that misses taps nothing, where a tap
    // on the app's own button could land on the alert drawn over it.
    const missed = async () => device.getByText("Nothing on this screen has this text")
      .tap({ timeout: 1_000 }).then(() => "", (e: Error) => e.message)
    let message = ""
    for (let i = 0; i < 30 && !message.includes(COVERING); i++) message = await missed()
    expect(message).toContain(COVERING)
    expect(message).toContain("Don’t Allow")
    // Nothing answers it during the test: it is still covering the app.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(await missed()).toContain(COVERING)
    // The test ends without answering it.
  })

  test("is answered with an accepting button before the next test", async ({ permissionsScreen }) => {
    await permissionsScreen.open()
    // Asking again reads the answer without a new alert: granted, not denied.
    await permissionsScreen.requestLocationButton.tap()
    await expect(permissionsScreen.locationStatus).toHaveText("granted")
  })
})
