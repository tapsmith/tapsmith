import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// A seekbar is a slider, not web content (PILOT-1329). The iOS agent once
// read a private trait WebKit sets on every element in a WKWebView as the
// adjustable trait, so every web node was a seekbar, and the test app's RN
// `accessibilityRole="adjustable"` view (the gestures screen's draggable item)
// was none.

async function dump(device: unknown): Promise<string> {
  // Internal gRPC client: the role the hierarchy dump reports is under test.
  const client = (device as { _client: { getUiHierarchy(): Promise<{ hierarchyXml: string }> } })._client
  return (await client.getUiHierarchy()).hierarchyXml
}

describe("getByRole seekbar", () => {
  test("finds the adjustable view", async ({ device, gesturesScreen }) => {
    await openScreen(device, "/gestures")
    await expect(gesturesScreen.draggable).toBeVisible()
    await expect(device.getByRole("seekbar", { name: "Draggable item" })).toBeVisible()
    const seekbar = device.getByRole("seekbar")
    await expect(seekbar).toHaveCount(1)
    // Found by role alone, it is bound to the view itself, not looked for
    // among the screen's sliders (it has none).
    expect((await seekbar.screenshot()).length).toBeGreaterThan(0)
  })

  test("is not a scroll view's indicator", async ({ device, scrollScreen }) => {
    await openScreen(device, "/scroll")
    await expect(scrollScreen.heading).toBeVisible()
    if (device.platform === "ios") {
      // iOS lists a scroll view's indicators ("Vertical scroll bar, 2 pages")
      // as adjustable generic views, like the adjustable view above.
      await expect(device.getByDescription("Vertical scroll bar").first()).toExist()
    }
    await expect(device.getByRole("seekbar")).toHaveCount(0)
  })

  describe("in a WebView", () => {
    // A WebView's page can take a while to load on a busy CI machine.
    test.use({ timeout: 60_000 })

    test("matches nothing in a WebView's content", async ({ device, webviewScreen }) => {
      await openScreen(device, "/webview")
      await expect(webviewScreen.heading).toBeVisible()
      await expect(webviewScreen.pageHeading).toBeVisible({ timeout: 30_000 })
      // The page's own elements keep their roles.
      await expect(webviewScreen.nativeLoginButton).toBeVisible()
      await expect(device.getByRole("seekbar")).toHaveCount(0)
      if (device.platform === "ios") {
        expect(await dump(device)).not.toContain('tapsmith-role="seekbar"')
      }
    })
  })
})
