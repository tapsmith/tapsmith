import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-1444: scrollIntoView() then tap() is the documented way to press a
// control below the screen (tap() does not scroll). On Android each scroll
// step used to end its drag with a cancel, so a React Native ScrollView never
// saw its drag end; after a step that reached the end of the content (API
// 31+) the next tap could press the button without its onPress running.
// Steps now lift the finger. Both targets are the last controls of their
// lists, so the scroll ends at the end of the content. (The lost tap depends
// on how far the last step's final move scrolled, so this does not fail on
// every run without the fix; the agent's unit tests pin the lift.)

describe("scrollIntoView() then tap() at the end of a list", () => {
  test.use({ appResetScope: "test", timeout: 60_000 })

  test("presses a button at the bottom of a ScrollView", async ({ device, scrollScreen }) => {
    await openScreen(device, "/scroll")
    await expect(scrollScreen.heading).toBeVisible()

    await scrollScreen.bottomButton.scrollIntoView({ maxScrolls: 15 })
    await scrollScreen.bottomButton.tap()

    await expect(scrollScreen.bottomPresses).toHaveText("Bottom button presses: 1")
  })

  test("selects the last row of a FlatList", async ({ device, listScreen }) => {
    await openScreen(device, "/list")
    await expect(listScreen.selectedCount).toContainText("0 selected")

    await listScreen.item(30).scrollIntoView({ maxScrolls: 15 })
    await listScreen.item(30).tap()

    await expect(listScreen.selectedCount).toContainText("1 selected")
  })
})
