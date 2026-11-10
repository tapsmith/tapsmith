/**
 * E2E tests for route lifetime (PILOT-534): a `device.route()` registered in
 * `beforeAll` applies to every test of its describe block, and is removed when
 * that block ends.
 */
import {
  describe,
  expect,
  test,
} from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

const SHARED_TITLE = "Shared beforeAll Mock"

describe("Route lifetime", () => {
  test.use({ timeout: 20_000 })

  test.beforeEach(async ({ device, apiCallsScreen }) => {
    await openScreen(device, "/api-calls")
    await expect(apiCallsScreen.heading).toBeVisible()
  })

  describe("routes registered in beforeAll", () => {
    test.beforeAll(async ({ device }) => {
      await device.route("**/posts*", async (route) => {
        await route.fulfill({
          json: [{ id: 1, title: SHARED_TITLE, body: "registered once for the whole block" }],
        })
      })
    })

    test("mock the first test", async ({ device, apiCallsScreen }) => {
      await apiCallsScreen.fetchPostsButton.tap()
      await expect(device.getByText(SHARED_TITLE)).toBeVisible({ timeout: 10_000 })
    })

    test("still mock the second test", async ({ device, apiCallsScreen }) => {
      await apiCallsScreen.fetchPostsButton.tap()
      await expect(device.getByText(SHARED_TITLE)).toBeVisible({ timeout: 10_000 })
    })
  })

  // A sibling block, which runs after the one above (a test directly in this
  // block would run before its nested describes).
  describe("after that block", () => {
    test("no longer mocks the request", async ({ device, apiCallsScreen }) => {
      await apiCallsScreen.fetchPostsButton.tap()
      await expect(apiCallsScreen.postsHeading).toBeVisible({ timeout: 10_000 })
      await expect(device.getByText(SHARED_TITLE)).not.toBeVisible()
    })
  })
})
