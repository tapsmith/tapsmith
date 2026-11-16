import { describe, test, expect } from "../fixtures.js"

// ─── Authenticated tests ───
// This file runs as part of the "authenticated" project, which has
// `dependencies: ['setup']` and `use: { appState: './tapsmith-results/auth-state.tar.gz' }`.
// The runner automatically restores app state before these tests —
// no manual login flow needed. Mirrors Playwright's storageState pattern.

test("profile screen is accessible without logging in", async ({ device }) => {
  // Navigate to the auth-gated profile screen (at bottom of home, needs scroll)
  await device.openDeepLink("tapsmithtest:///profile")

  // Without restored auth, this would redirect to login.
  // With restored app state, we land directly on the profile.
  await expect(device.getByText("Profile", { exact: true }).first()).toBeVisible()
  await expect(device.getByText("test@example.com", { exact: true })).toBeVisible()
  await expect(device.getByText("Authenticated", { exact: true })).toBeVisible()
})

test("login screen shows authenticated state", async ({ device }) => {
  await device.openDeepLink("tapsmithtest:///login")

  // Should show the logged-in view, not the sign-in form
  await expect(device.getByText("Login successful!", { exact: true })).toBeVisible()
  await expect(device.getByText("Welcome, test@example.com", { exact: true })).toBeVisible()
})

// ─── Override: opt out of restored auth for a single scope ───
// Mirrors Playwright's test.use({ storageState: { cookies: [], origins: [] } })

describe("without auth", () => {
  test.use({ appState: "" })

  test("profile redirects to login when app state is cleared", async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///profile")

    // appState: '' clears app data, so the profile gate should redirect to login
    await expect(device.getByText("Sign In", { exact: true })).toBeVisible()
  })
})

// ─── Restored state kept between tests ───
// The test app's hooks count AsyncStorage writes and reload the session from
// storage (`track` + `onReload`), so after the first restore a reset keeps the
// restored data warm while no test has written, and restores the archive
// again after one has. The profile shows how many resets kept the data in
// this app process: 0 after any cold launch, including a restore.
// Runs after "without auth", whose clear relaunches the app, so the first
// test here always starts from a cold restore.

describe("restored state kept between tests", () => {
  test.use({ appResetScope: "test" })

  let reloadsAfterRestore: number | undefined
  let keptAttempts = 0

  test("a test that only reads the restored state", async ({ device, profileScreen }) => {
    await device.openDeepLink("tapsmithtest:///profile")
    await expect(profileScreen.status).toHaveText("Authenticated")
    reloadsAfterRestore = Number(await profileScreen.reloadCount.getText())
  })

  test("the next test keeps the restored data with a warm reset", async ({ device, profileScreen }) => {
    keptAttempts++
    await device.openDeepLink("tapsmithtest:///profile")
    await expect(profileScreen.status).toHaveText("Authenticated")
    // A retry restores the archive cold by design: only the first attempt
    // follows a test that wrote nothing.
    if (keptAttempts === 1 && reloadsAfterRestore !== undefined) {
      await expect(profileScreen.reloadCount).toHaveText(String(reloadsAfterRestore + 1))
    }
  })

  test("a test that writes: logging out removes the stored session", async ({ device, profileScreen, loginScreen }) => {
    await device.openDeepLink("tapsmithtest:///profile")
    await expect(profileScreen.status).toHaveText("Authenticated")
    await profileScreen.logOutButton.tap()
    await expect(loginScreen.heading).toBeVisible()
  })

  test("after a write the next test gets the pristine archive, restored cold", async ({ device, profileScreen }) => {
    await device.openDeepLink("tapsmithtest:///profile")
    // A warm reset here would have kept the logged-out storage and redirected
    // to the login screen.
    await expect(profileScreen.status).toHaveText("Authenticated")
    await expect(profileScreen.reloadCount).toHaveText("0")
  })
})
