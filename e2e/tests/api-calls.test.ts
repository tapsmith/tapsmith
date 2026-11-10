/**
 * E2E tests for the API Calls screen.
 *
 * These tests make real HTTP requests to jsonplaceholder.typicode.com.
 * Run with --trace on to see network traffic in the trace viewer:
 *
 *   npx tapsmith test tests/api-calls.test.ts --trace on
 */
import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

describe("API Calls screen", () => {
  // Each test navigates back to the screen and makes real HTTP requests,
  // leaving little room for network latency under the default 10s timeout.
  test.use({ timeout: 15_000 })

  test.beforeEach(async ({ device, apiCallsScreen }) => {
    await openScreen(device, "/api-calls")
    await expect(apiCallsScreen.heading).toBeVisible()
  })

  test("fetches and displays posts", async ({ apiCallsScreen }) => {
    await apiCallsScreen.fetchPostsButton.tap()
    await expect(apiCallsScreen.postsHeading).toBeVisible({ timeout: 10_000 })
  })

  test("fetches and displays user", async ({ apiCallsScreen }) => {
    await apiCallsScreen.fetchUserButton.tap()
    await expect(apiCallsScreen.userHeading).toBeVisible({ timeout: 10_000 })
  })

  test("shows error for 404 request", async ({ apiCallsScreen }) => {
    await apiCallsScreen.fetch404Button.tap()
    await expect(apiCallsScreen.errorMessage).toBeVisible({ timeout: 10_000 })
  })
})
