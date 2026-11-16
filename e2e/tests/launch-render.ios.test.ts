/**
 * iOS: launchApp() and restartApp() return once the app has drawn its first
 * screen, not while its blank launch screen is still up. A non-waiting read
 * made straight after them then sees the app. The idle wait that ends a
 * launch stops as soon as the screen holds still, and a launch screen holds
 * still, so the launch itself has to wait for rendered content. Each round
 * leaves the home screen first: a relaunch from another screen is where the
 * launch screen showed most.
 */
import { describe, expect, test } from "../fixtures.js"

const PKG = "dev.tapsmith.testapp"
const SCROLL = "tapsmithtest:///scroll"
const ROUNDS = 6

describe("A launch hands back a rendered app", () => {
  test.use({ appReset: "none", timeout: 120_000 })

  test("isVisible() right after restartApp() sees the first screen", async ({ device, homeScreen }) => {
    const seen: boolean[] = []
    for (let i = 0; i < ROUNDS; i++) {
      await device.openDeepLink(SCROLL)
      await device.restartApp()
      seen.push(await homeScreen.header.isVisible())
    }
    expect(seen).toEqual(Array(ROUNDS).fill(true))
  })

  test("isVisible() right after terminateApp() + launchApp() sees the first screen", async ({ device, homeScreen }) => {
    const seen: boolean[] = []
    for (let i = 0; i < ROUNDS; i++) {
      await device.openDeepLink(SCROLL)
      await device.terminateApp(PKG)
      await device.launchApp(PKG)
      seen.push(await homeScreen.header.isVisible())
    }
    expect(seen).toEqual(Array(ROUNDS).fill(true))
  })
})
