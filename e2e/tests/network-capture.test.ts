/**
 * E2E tests for network capture correctness (PILOT-187).
 *
 * Verifies that HTTPS requests from the app are captured with the correct
 * `https://` URL scheme — not `http://`, and that a real server's response
 * body reaches the test decoded.
 */
import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

describe("Network capture", () => {
  test.use({ timeout: 20_000 })

  test.beforeEach(async ({ device, apiCallsScreen }) => {
    await openScreen(device, "/api-calls")
    await expect(apiCallsScreen.heading).toBeVisible()
  })

  test("HTTPS request is captured with correct scheme and properties", async ({ device, apiCallsScreen }) => {
    await device.route("**/users/1", async (route) => {
      await route.fulfill({
        json: { id: 1, name: "Tapsmith Capture User" },
      })
    })

    try {
      const requestPromise = device.waitForRequest(
        (req) => req.url.includes("jsonplaceholder.typicode.com/users/1"),
        { timeout: 15_000 },
      )
      const responsePromise = device.waitForResponse(
        (resp) => resp.url.includes("jsonplaceholder.typicode.com/users/1"),
        { timeout: 15_000 },
      )

      await apiCallsScreen.fetchUserButton.tap()

      const [request, response] = await Promise.all([requestPromise, responsePromise])

      expect(request.url).toMatch(/^https:\/\//)
      expect(request.isHttps).toBe(true)

      expect(response.url).toMatch(/^https:\/\//)
      expect(response.status).toBe(200)
    } finally {
      await device.unrouteAll()
    }
  })

  describe("with an empty HTTP cache", () => {
    // The app's HTTP cache (OkHttp's disk cache, the iOS URLCache) survives a
    // warm reset, so a retry or re-run would revalidate and get an empty 304,
    // or no request at all. A clearing reset gives every attempt a real 200.
    test.use({ appReset: "clear" })

    test("a real server's compressed, chunked response body arrives decoded (PILOT-944)", async ({ device, apiCallsScreen }) => {
      // jsonplaceholder sits behind a CDN that answers with a chunked, brotli-
      // or gzip-compressed body; the proxy sees those wire bytes.
      const responsePromise = device.waitForResponse(
        (resp) => resp.url.includes("jsonplaceholder.typicode.com/posts?_limit=3"),
        { timeout: 15_000 },
      )

      await apiCallsScreen.fetchPostsButton.tap()

      const response = await responsePromise
      expect(response.status).toBe(200)
      const posts = JSON.parse(response.body!.toString()) as Array<{ id: number }>
      expect(posts).toHaveLength(3)
      expect(posts[0].id).toBe(1)
    })
  })
})
