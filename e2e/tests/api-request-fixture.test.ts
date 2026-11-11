/**
 * E2E tests for the `request` fixture (PILOT-121).
 *
 * Validates that the built-in API request fixture can make HTTP calls,
 * and that it works alongside device interactions. Uses the public
 * jsonplaceholder API (same endpoint the test app hits).
 *
 * Run with --trace on to see API actions in the trace viewer:
 *
 *   npx tapsmith test tests/api-request-fixture.test.ts --trace on
 */
import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

describe("request fixture", () => {
  test.use({ timeout: 15_000 })

  test("GET request returns parsed JSON", async ({ request }) => {
    const res = await request.get("https://jsonplaceholder.typicode.com/posts/1")
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; title: string }
    expect(body.id).toBe(1)
    expect(typeof body.title).toBe("string")
  })

  test("POST request sends JSON data", async ({ request }) => {
    const res = await request.post("https://jsonplaceholder.typicode.com/posts", {
      data: { title: "tapsmith test", body: "hello from E2E", userId: 1 },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: number; title: string }
    expect(body.title).toBe("tapsmith test")
  })

  test("non-2xx does not throw", async ({ request }) => {
    const res = await request.get("https://jsonplaceholder.typicode.com/posts/99999")
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })

  test("response body is re-readable", async ({ request }) => {
    const res = await request.get("https://jsonplaceholder.typicode.com/users/1")
    const text = await res.text()
    const json = (await res.json()) as { id: number }
    expect(JSON.parse(text)).toEqual(json)
  })

  test("custom headers are sent", async ({ request }) => {
    // jsonplaceholder doesn't echo headers, but we verify the request
    // doesn't fail with custom headers attached
    const res = await request.get("https://jsonplaceholder.typicode.com/posts/1", {
      headers: { "X-Test-Header": "tapsmith-e2e" },
    })
    expect(res.ok).toBe(true)
  })

  describe("combined device + request", () => {
    test.beforeEach(async ({ device, apiCallsScreen }) => {
      await openScreen(device, "/api-calls")
      await expect(apiCallsScreen.heading).toBeVisible()
    })

    test("seed data via API then verify app can fetch same endpoint", async ({ apiCallsScreen, request }) => {
      // Use the request fixture to verify the API is reachable
      const apiRes = await request.get("https://jsonplaceholder.typicode.com/users/1")
      expect(apiRes.ok).toBe(true)
      const user = (await apiRes.json()) as { name: string }

      // Now verify the app can also hit a similar endpoint via the UI
      await apiCallsScreen.fetchUserButton.tap()
      await expect(apiCallsScreen.userHeading).toBeVisible({ timeout: 10_000 })
    })
  })
})
