import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-1424: a bar the screen lays over the bottom of a list (a checkout
// bar, a mini player) takes a tap meant for the row under it. On Android in a
// React Native app the bar is a plain view, nothing in it clickable, and the
// tap used to land on it and report success while the row never saw it.

describe("A bar laid over a list", () => {
  test.use({ appResetScope: "test" })

  const failureOf = (action: Promise<unknown>) =>
    action.then(
      () => "",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )

  test("tap() on a row under it fails naming the bar, without tapping it", async ({ device, tabBarScrollScreen }) => {
    await openScreen(device, "/tab-bar-scroll/covered")
    await expect(tabBarScrollScreen.status).toHaveText("Row under the bar taps: 0")

    const failure = await failureOf(tabBarScrollScreen.target.tap({ timeout: 1_500 }))
    expect(failure).toMatch(/covered by .*tab-bar-scroll-bar/)
    expect(failure).toContain("scrollIntoView()")

    await expect(tabBarScrollScreen.status).toHaveText("Row under the bar taps: 0")
  })
})
