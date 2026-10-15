import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-718: React Native renders <Text accessibilityRole="alert"> as plain
// static text on iOS — no trait, no role description — so
// getByRole("alert", { name }) never found the error text Android matches.
// A named query now finds it on both platforms; an unnamed one can't on iOS,
// and its failure says so.
describe("getByRole('alert') on a React Native alert Text", () => {
  test.use({ timeout: 20_000 })

  test.beforeEach(async ({ device, apiCallsScreen }) => {
    await openScreen(device, "/api-calls")
    await expect(apiCallsScreen.heading).toBeVisible()
    await device.route("**/posts*", (route) => route.fulfill({ status: 500, body: "boom" }))
    await apiCallsScreen.fetchPostsButton.tap()
  })

  test.afterEach(async ({ device }) => {
    await device.unrouteAll()
  })

  test("finds the alert by its name", async ({ apiCallsScreen }) => {
    await expect(apiCallsScreen.postsErrorAlert).toBeVisible({ timeout: 10_000 })
    await expect(apiCallsScreen.postsErrorAlert).toHaveText(/^Failed to fetch posts: /)
  })

  test("an unnamed query explains its miss on iOS", async ({ device, platform, apiCallsScreen }) => {
    test.skip(platform !== "ios", "Android publishes the alert role description, so the unnamed query matches")
    await expect(apiCallsScreen.postsErrorAlert).toBeVisible({ timeout: 10_000 })
    // The call under test: the unnamed role query itself.
    let message = ""
    try {
      await expect(device.getByRole("alert")).toHaveCount(1, { timeout: 1_000 })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('to have count 1, but found 0. On iOS, React Native publishes no "alert" role')
  })
})
