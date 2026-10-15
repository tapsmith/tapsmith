import { describe, expect, test } from "../fixtures.js"

/**
 * A retry starts where the first attempt started (PILOT-715): under the
 * default per-file reset, Tapsmith resets the app again and re-runs the
 * file's beforeAll hooks before the retry, as Playwright's fresh worker does.
 * The first attempt here deliberately leaves the app on another screen and
 * fails, so this test always reports as flaky: the retry passes only if it
 * started back on the login screen the beforeAll opened.
 */
describe("Retry after a failed attempt", () => {
  test.use({ retries: 1 })

  let attempt = 0

  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///login")
  })

  test("starts from the beforeAll screen, not where the failed attempt stopped", async ({ device, loginScreen, scrollScreen }) => {
    attempt++
    await expect(loginScreen.heading).toBeVisible()
    if (attempt === 1) {
      await device.openDeepLink("tapsmithtest:///scroll")
      await expect(scrollScreen.heading).toBeVisible()
      throw new Error("Deliberate first-attempt failure: the retry must start on the login screen again")
    }
  })
})
