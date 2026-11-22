import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-1370: a row on screen but outside the part of its list that shows.
// On iOS frames are not clipped, so a row just below a list, behind a bottom
// tab bar, is "visible", and scrollIntoView() used to return after 0 scrolls,
// leaving tap() to wait out its timeout. A bar the screen lays over the list
// hides the rows under it on both platforms. Android lists only on-screen
// rows, so its "below" and "above" rows are plain off-screen scrolls.

describe("scrollIntoView() and a bottom tab bar", () => {
  test.use({ appResetScope: "test" })

  test("scrolls in a row just below the list, behind the tab bar, so tap() reaches it", async ({ device, tabBarScrollScreen }) => {
    await openScreen(device, "/tab-bar-scroll")
    await expect(tabBarScrollScreen.status).toHaveText("Row below the list taps: 0")

    await tabBarScrollScreen.target.scrollIntoView()
    await tabBarScrollScreen.target.tap()

    await expect(tabBarScrollScreen.status).toHaveText("Row below the list taps: 1")
  })

  test("scrolls in a row just above the list, scrolled past", async ({ device, platform, tabBarScrollScreen }) => {
    await openScreen(device, "/tab-bar-scroll/above")
    await expect(tabBarScrollScreen.status).toHaveText("Row above the list taps: 0")

    // iOS sees where the row is; Android does not list it, so it needs the way.
    await tabBarScrollScreen.target.scrollIntoView(platform === "android" ? { direction: "up" } : undefined)
    await tabBarScrollScreen.target.tap()

    await expect(tabBarScrollScreen.status).toHaveText("Row above the list taps: 1")
  })

  test("scrolls in a row under a bar laid over the list, so tap() does not land on the bar", async ({ device, tabBarScrollScreen }) => {
    await openScreen(device, "/tab-bar-scroll/covered")
    await expect(tabBarScrollScreen.status).toHaveText("Row under the bar taps: 0")

    await tabBarScrollScreen.target.scrollIntoView()
    await tabBarScrollScreen.target.tap()

    await expect(tabBarScrollScreen.status).toHaveText("Row under the bar taps: 1")
  })
})
