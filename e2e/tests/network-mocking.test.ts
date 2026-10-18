/**
 * E2E tests for network route interception and mocking.
 *
 * These tests exercise the `device.route()` API against the test app's
 * API Calls screen, which fetches from jsonplaceholder.typicode.com.
 *
 * Run with --trace on to see route badges in the trace viewer:
 *   npx tapsmith test tests/network-mocking.test.ts --trace on
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import {
  describe,
  expect,
  test,
  type Route,
} from "../fixtures.js"
import { openScreen, resetApp } from "../utils/app-reset.js"

function routeFetchNoCacheOptions(route: Route) {
  const headers = { ...route.request().headers }
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase()
    if (
      lower === "if-none-match" ||
      lower === "if-modified-since" ||
      lower === "cache-control" ||
      lower === "pragma"
    ) {
      delete headers[key]
    }
  }
  headers["cache-control"] = "no-cache"
  headers.pragma = "no-cache"

  const url = new URL(route.request().url)
  url.searchParams.set("tapsmith-route-fetch", "1")

  return { headers, url: url.toString() }
}

describe("Network mocking", () => {
  // Network interception + real HTTP need generous timeout.
  test.use({ timeout: 20_000 })

  let crossOriginServer: Server | undefined
  let crossOriginUserUrl = ""

  test.beforeAll(async () => {
    crossOriginServer = createServer((req, res) => {
      if (req.url === "/cross-origin-user") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          id: 1,
          name: "Tapsmith Redirect User",
          email: "redirect@example.test",
          phone: "555-0100",
        }))
        return
      }

      res.writeHead(404, { "content-type": "text/plain" })
      res.end("not found")
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      crossOriginServer!.once("error", onError)
      crossOriginServer!.listen(0, "127.0.0.1", () => {
        crossOriginServer!.off("error", onError)
        const address = crossOriginServer!.address() as AddressInfo
        crossOriginUserUrl = `http://127.0.0.1:${address.port}/cross-origin-user`
        resolve()
      })
    })
  })

  test.afterAll(async () => {
    if (!crossOriginServer) return
    await new Promise<void>((resolve, reject) => {
      crossOriginServer!.close((err) => err ? reject(err) : resolve())
    })
  })

  test.beforeEach(async ({ device, apiCallsScreen }) => {
    await openScreen(device, "/api-calls")
    await expect(apiCallsScreen.heading).toBeVisible()
  })

  test("route.fulfill() — mock a JSON response", async ({ device, apiCallsScreen }) => {
    await device.route("**/posts*", async (route) => {
      await route.fulfill({
        json: [
          { id: 99, title: "Mocked Post Title", body: "This is a mocked post body" },
        ],
      })
    })

    await apiCallsScreen.fetchPostsButton.tap()
    await expect(apiCallsScreen.postsHeading).toBeVisible({ timeout: 10_000 })
    await expect(device.getByText("Mocked Post Title")).toBeVisible()

    await device.unrouteAll()
  })

  test("route.fulfill() — mock error status", async ({ device, apiCallsScreen }) => {
    await device.route("**/users/1", async (route) => {
      await route.fulfill({
        status: 500,
        body: "Internal Server Error",
        contentType: "text/plain",
      })
    })

    await apiCallsScreen.fetchUserButton.tap()
    // The app should show an error since it received a 500
    await expect(device.getByText("Failed to fetch user")).toBeVisible({ timeout: 10_000 })

    await device.unrouteAll()
  })

  test("route.abort() — block a request", async ({ device, apiCallsScreen }) => {
    await device.route("**/posts*", async (route) => {
      await route.abort()
    })

    await apiCallsScreen.fetchPostsButton.tap()
    // The app should show an error since the request was aborted
    await expect(device.getByText("Failed to fetch posts")).toBeVisible({ timeout: 10_000 })

    await device.unrouteAll()
  })

  test("route.continue() — passthrough with no modifications", async ({ device, apiCallsScreen }) => {
    let intercepted = false
    await device.route("**/posts*", async (route) => {
      intercepted = true
      await route.continue()
    })

    await apiCallsScreen.fetchPostsButton.tap()
    await expect(apiCallsScreen.postsHeading).toBeVisible({ timeout: 10_000 })
    expect(intercepted).toBe(true)

    await device.unrouteAll()
  })

  test("route.fetch() — modify real response", async ({ device, apiCallsScreen }) => {
    await device.route("**/users/1", async (route) => {
      const response = await route.fetch(routeFetchNoCacheOptions(route))
      const data = response.json() as Record<string, unknown>
      data.name = "Tapsmith Modified User"
      await route.fulfill({ json: data })
    })

    await apiCallsScreen.fetchUserButton.tap()
    await expect(apiCallsScreen.userHeading).toBeVisible({ timeout: 10_000 })
    await expect(device.getByText("Tapsmith Modified User")).toBeVisible()

    await device.unrouteAll()
  })

  test("device.unroute() — remove specific route", async ({ device, apiCallsScreen }) => {
    const handler = async (route: Route) => {
      await route.fulfill({
        json: [{ id: 1, title: "Still Mocked", body: "body" }],
      })
    }

    await device.route("**/posts*", handler)

    // First call should be mocked
    await apiCallsScreen.fetchPostsButton.tap()
    await expect(device.getByText("Still Mocked")).toBeVisible({ timeout: 10_000 })

    // Reset to clear UI state without dropping registered routes.
    await resetApp(device, "/api-calls")
    await expect(apiCallsScreen.heading).toBeVisible()

    // Remove the route
    await device.unroute("**/posts*", handler)

    // Second call should go through to the real server
    await apiCallsScreen.fetchPostsButton.tap()
    await expect(apiCallsScreen.postsHeading).toBeVisible({ timeout: 10_000 })
    // Real jsonplaceholder doesn't have "Still Mocked"
    await expect(device.getByText("Still Mocked")).not.toBeVisible()
  })

  test("device.unrouteAll() — remove all routes", async ({ device, apiCallsScreen }) => {
    await device.route("**/posts*", async (route) => {
      await route.abort()
    })
    await device.route("**/users/*", async (route) => {
      await route.abort()
    })

    // Verify routes work
    await apiCallsScreen.fetchPostsButton.tap()
    await expect(device.getByText("Failed to fetch posts")).toBeVisible({ timeout: 10_000 })

    // Remove all routes and reset the app state.
    await device.unrouteAll()
    await resetApp(device, "/api-calls")
    await expect(apiCallsScreen.heading).toBeVisible()

    // Now requests should go through
    await apiCallsScreen.fetchPostsButton.tap()
    await expect(apiCallsScreen.postsHeading).toBeVisible({ timeout: 10_000 })
  })

  test("route with times option — limited invocations", async ({ device, apiCallsScreen }) => {
    let routeHits = 0

    await device.route("**/posts*", async (route) => {
      routeHits += 1
      await route.fulfill({
        json: [{ id: 1, title: "Once Only", body: "body" }],
      })
    }, { times: 1 })

    // First call: mocked
    await apiCallsScreen.fetchPostsButton.tap()
    await expect(device.getByText("Once Only")).toBeVisible({ timeout: 10_000 })
    expect(routeHits).toBe(1)

    // Reset app to clear state without dropping route registrations.
    await resetApp(device, "/api-calls")
    await expect(apiCallsScreen.heading).toBeVisible()

    // Second call: route should have expired after 1 use.
    await apiCallsScreen.fetchPostsButton.tap()
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(routeHits).toBe(1)
    await expect(device.getByText("Once Only")).not.toBeVisible({ timeout: 1_000 })
  })

  test("route.continue({ url }) — cross-origin redirect", async ({ device, apiCallsScreen }) => {
    // Redirect the user request from jsonplaceholder to a deterministic local
    // origin so this test exercises cross-origin continue without depending on
    // a public service.
    await device.route("**/users/1", async (route) => {
      await route.continue({ url: crossOriginUserUrl })
    })

    await apiCallsScreen.fetchUserButton.tap()
    await expect(apiCallsScreen.userHeading).toBeVisible({ timeout: 10_000 })
    await expect(device.getByText("Tapsmith Redirect User")).toBeVisible()
    // jsonplaceholder user 1 is "Leanne Graham" — if cross-origin
    // redirect worked, that name won't appear.
    await expect(device.getByText("Leanne Graham")).not.toBeVisible()

    await device.unrouteAll()
  })

  test("multiple routes — last registered wins", async ({ device, apiCallsScreen }) => {
    // First: broad route that would abort everything
    await device.route("**/*", async (route) => {
      await route.abort()
    })

    // Second: specific route that fulfills posts — should win for posts URLs
    await device.route("**/posts*", async (route) => {
      await route.fulfill({
        json: [{ id: 1, title: "Priority Route Won", body: "body" }],
      })
    })

    await apiCallsScreen.fetchPostsButton.tap()
    await expect(device.getByText("Priority Route Won")).toBeVisible({ timeout: 10_000 })

    await device.unrouteAll()
  })
})

// PILOT-775: mocking needs no trace config — with tracing off, the first
// route() or network wait of a test starts the proxy on demand. Routes and
// waits come first, before the screen that sends the request.
describe("Network mocking without a trace (PILOT-775)", () => {
  test.use({ trace: "off", timeout: 20_000 })

  test("route() mocks a response with tracing off", async ({ device, apiCallsScreen }) => {
    await device.route("**/posts*", async (route) => {
      await route.fulfill({ json: [{ id: 7, title: "Mocked Without Trace", body: "b" }] })
    })
    await openScreen(device, "/api-calls")
    await apiCallsScreen.fetchPostsButton.tap()
    await expect(device.getByText("Mocked Without Trace")).toBeVisible({ timeout: 10_000 })
  })

  test("waitForResponse() sees a response with tracing off", async ({ device, apiCallsScreen }) => {
    await device.route("**/posts*", (route) => route.fulfill({ json: [] }))
    const response = device.waitForResponse("**/posts*", { timeout: 10_000 })
    await openScreen(device, "/api-calls")
    await apiCallsScreen.fetchPostsButton.tap()
    expect((await response).status).toBe(200)
  })
})
