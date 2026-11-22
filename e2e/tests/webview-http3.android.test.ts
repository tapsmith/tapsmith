/**
 * HTTP/3 is kept off while capture is active (PILOT-1393).
 *
 * jsonplaceholder sits behind Cloudflare, which advertises HTTP/3 in an
 * `alt-svc: h3=":443"` response header. Android WebView (Chromium) then sends
 * later requests to that host as QUIC over UDP 443, which the TCP-only
 * transparent redirect never saw: routes stopped firing and waits timed out
 * from the second request on. Tapsmith now rejects outbound UDP 443 during
 * capture, so the WebView falls back to TCP and every request reaches the proxy.
 */
import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

const API = "https://jsonplaceholder.typicode.com"

describe("WebView requests to an HTTP/3 host", () => {
  test.use({ timeout: 60_000 })

  test("are all seen by route() after the host advertises h3", async ({ device, webviewScreen }) => {
    await openScreen(device, "/webview")
    await expect(webviewScreen.pageHeading).toBeVisible()
    const webview = await device.webview()
    const fetchJson = (path: string) =>
      webview.evaluate<{ status: number; body: { id: number; title: string } }>(
        `fetch(${JSON.stringify(API + path)}, { cache: "no-store" })` +
          `.then(async (r) => ({ status: r.status, body: await r.json() }))`,
      )

    try {
      // The first request is a real one. Its response teaches the WebView
      // that the host speaks HTTP/3 — unless it already knew from a run before.
      const first = await fetchJson("/posts/1")
      expect(first.status).toBe(200)
      expect(first.body.id).toBe(1)

      // Every later request to the host must still cross the proxy.
      let hits = 0
      await device.route("**/posts/2", async (route) => {
        hits++
        await route.fulfill({
          json: { id: 2, title: "mocked by Tapsmith" },
          headers: { "access-control-allow-origin": "*" },
        })
      })
      for (let i = 0; i < 3; i++) {
        const responsePromise = device.waitForResponse((r) => r.url === `${API}/posts/2`, { timeout: 15_000 })
        const mocked = await fetchJson("/posts/2")
        expect(mocked.body.title).toBe("mocked by Tapsmith")
        expect((await responsePromise).status).toBe(200)
      }
      expect(hits).toBe(3)
    } finally {
      await device.unrouteAll()
      await device.native()
    }
  })
})
