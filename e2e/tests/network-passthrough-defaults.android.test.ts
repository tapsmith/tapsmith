/**
 * E2E test for the per-platform embedded-root passthrough defaults (PILOT-279).
 *
 * `firestore.googleapis.com` is in the daemon's `DEFAULT_PASSTHROUGH_HOSTS`.
 * That default exists for iOS, whose Firestore gRPC stack compiles its CA roots
 * into the app binary and can never trust the MITM CA. Android's Firestore runs
 * on gRPC-Java, which validates against the platform trust store, so applying
 * the default there only hid traffic Tapsmith can capture.
 *
 * This test pins the Android half: the host must be interceptable like any
 * other. The check is precise because the host-glob passthrough rule is
 * evaluated *before* MITM, so a tunnelled host yields no request/response event
 * at all — `waitForResponse` resolving is only possible if it was decrypted.
 *
 * Scope: this exercises the passthrough *gate*, not the HTTP/2 pipeline. React
 * Native's fetch (OkHttp) offers h2 and http/1.1, and the proxy negotiates
 * http/1.1 by server preference, so this request is captured over HTTP/1.1.
 * Real gRPC/h2 capture from a device is PILOT-234; the h2 framing layer itself
 * is covered by unit tests in `network_proxy.rs`.
 *
 * Requires a rootable emulator image so the CA reaches the system trust store
 * (CI uses `google_apis`). The iOS counterpart is
 * `network-passthrough-defaults.ios.test.ts`.
 */
import { describe, expect, test } from "../fixtures.js"
import { resetApp } from "../utils/app-reset.js"

const FIRESTORE_HOST = "firestore.googleapis.com"

describe("Embedded-root passthrough defaults (Android)", () => {
  test.use({ timeout: 30_000 })

  test.beforeEach(async ({ device, apiCallsScreen }) => {
    await resetApp(device, "/api-calls")
    await expect(apiCallsScreen.heading).toBeVisible()
  })

  test("a built-in passthrough host is captured on Android", async ({ device, apiCallsScreen }) => {
    const requestPromise = device.waitForRequest((req) => req.url.includes(FIRESTORE_HOST), {
      timeout: 20_000,
    })
    const responsePromise = device.waitForResponse((resp) => resp.url.includes(FIRESTORE_HOST), {
      timeout: 20_000,
    })

    await apiCallsScreen.fetchFirestoreHostButton.tap()

    // allSettled, not all: both waiters reject on timeout, and `Promise.all`
    // would surface the first while the second became an unhandled rejection —
    // which the runner treats as fatal, losing the actual assertion failure.
    const [requestResult, responseResult] = await Promise.allSettled([
      requestPromise,
      responsePromise,
    ])
    if (requestResult.status === "rejected") {
      throw new Error(
        `No request event for ${FIRESTORE_HOST} — the host looks tunnelled rather than captured: ${requestResult.reason}`,
      )
    }
    if (responseResult.status === "rejected") {
      throw new Error(
        `Request was captured but no response event arrived: ${responseResult.reason}`,
      )
    }
    const request = requestResult.value
    const response = responseResult.value

    // Seeing the URL and method at all means the connection was decrypted.
    expect(request.url).toContain(FIRESTORE_HOST)
    expect(request.isHttps).toBe(true)
    // Unauthenticated, so the status is an error — the point is that we can
    // read it, not what it is.
    expect(response.status).toBeGreaterThan(0)
    // A tunnelled connection is recorded as `CONNECT ... passthrough`; a
    // captured one carries no passthrough action.
    expect(response.routeAction).not.toBe("passthrough")
  })

  test("route() can intercept a built-in passthrough host on Android", async ({
    device,
    apiCallsScreen,
  }) => {
    // Mocking proves the request reached the route layer, which is impossible
    // for a tunnelled host. Matched by host predicate rather than a glob so the
    // assertion cannot fail for pattern-syntax reasons.
    await device.route(
      (url) => url.hostname === FIRESTORE_HOST,
      async (route) => {
        await route.fulfill({ json: { documents: [] } })
      },
    )

    try {
      const responsePromise = device.waitForResponse((resp) => resp.url.includes(FIRESTORE_HOST), {
        timeout: 20_000,
      })

      await apiCallsScreen.fetchFirestoreHostButton.tap()

      const response = await responsePromise
      expect(response.status).toBe(200)
      expect(response.routeAction).toBe("mocked")
    } finally {
      await device.unrouteAll()
    }
  })
})
