import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

/**
 * Regression (PILOT-985): an action straight after a push resolves against
 * the screen that was pushed.
 *
 * While a native stack animates, iOS keeps both screens in the accessibility
 * tree, with the outgoing one's controls at frames that can be on screen. So a
 * control every screen has matched twice for that half second: a strict-mode
 * violation; `.last()` then missed in the live query, which by then saw one;
 * and `.first()` meant the outgoing screen's control. Each test acts with no
 * wait after the push, and checks which level reacted.
 */
describe("Navigation stack: a control that every screen has", () => {
  test.beforeEach(async ({ device, stackScreen }) => {
    await openScreen(device, "/stack/1")
    await expect(stackScreen.level).toHaveText("Level 1")
  })

  test("a plain locator taps the pushed screen's control", async ({ stackScreen }) => {
    await stackScreen.push.tap()
    await stackScreen.back.tap()
    await expect(stackScreen.level).toHaveText("Level 1")
  })

  test("last() taps the pushed screen's control", async ({ stackScreen }) => {
    await stackScreen.push.tap()
    await stackScreen.back.last().tap()
    await expect(stackScreen.level).toHaveText("Level 1")
  })

  test("first() taps the pushed screen's control", async ({ stackScreen }) => {
    await stackScreen.push.tap()
    await stackScreen.back.first().tap()
    await expect(stackScreen.level).toHaveText("Level 1")
  })

  test("count() sees the pushed screen alone", async ({ stackScreen }) => {
    await stackScreen.push.tap()
    expect(await stackScreen.back.count()).toBe(1)
    await expect(stackScreen.level).toHaveText("Level 2")
  })

  test("pushes and pops can follow each other with no wait", async ({ stackScreen }) => {
    await stackScreen.push.tap()
    await stackScreen.push.tap()
    await stackScreen.push.tap()
    await expect(stackScreen.level).toHaveText("Level 4")
    await stackScreen.back.tap()
    await stackScreen.back.tap()
    await expect(stackScreen.level).toHaveText("Level 2")
  })
})
