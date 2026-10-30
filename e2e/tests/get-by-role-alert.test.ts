import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-718: React Native renders <Text accessibilityRole="alert"> as plain
// static text on iOS — no trait, no role description — so
// getByRole("alert", { name }) never found the error text Android matches.
// A named query now finds it on both platforms; an unnamed one can't on iOS,
// and its failure says so.
// PILOT-919: React Native's Alert.alert is a native alert. On iOS that is an
// XCUIElementTypeAlert, the alert role — found without a name, and by its
// title without also finding the title text inside it. Android's
// AlertDialog has no alert role in its accessibility tree.
describe("getByRole('alert') on React Native's Alert.alert", () => {
  test.beforeEach(async ({ device, platform, dialogsScreen }) => {
    test.skip(platform !== "ios", "an Android AlertDialog has no alert role: find it by its text or buttons")
    await openScreen(device, "/dialogs")
    await expect(dialogsScreen.heading).toBeVisible()
    await dialogsScreen.showAlertButton.tap()
  })

  test("finds the alert, named by its title or not, and its buttons in it", async ({ dialogsScreen }) => {
    await expect(dialogsScreen.infoAlert).toBeVisible()
    await expect(dialogsScreen.infoAlert).toHaveRole("alert")
    await expect(dialogsScreen.anyAlert).toHaveCount(1)
    await dialogsScreen.infoAlertOk.tap()
    await expect(dialogsScreen.anyAlert).toHaveCount(0)
  })
})

// PILOT-862: the app's views stay in the tree behind a React Native alert,
// some of them centred under it, so scoping by bounds alone also returned
// the app's buttons behind it.
describe("an unnamed query scoped to React Native's Alert.alert", () => {
  test("finds only the alert's own buttons", async ({ device, platform, dialogsScreen }) => {
    test.skip(platform !== "ios", "an Android AlertDialog has no alert role: find it by its text or buttons")
    await openScreen(device, "/dialogs")
    await expect(dialogsScreen.heading).toBeVisible()
    await dialogsScreen.showConfirmButton.tap()
    await expect(dialogsScreen.confirmAlert).toBeVisible()
    await expect(dialogsScreen.confirmAlertButtons).toHaveCount(2)
    await dialogsScreen.confirmAlertCancel.tap()
    await expect(dialogsScreen.confirmResult).toHaveText("Result: Cancelled")
  })
})

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
