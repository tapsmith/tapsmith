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
  test("finds the adjustable view, and not the scroll view's indicators", async ({ device, gesturesScreen }) => {
    await openScreen(device, "/gestures")
    await expect(gesturesScreen.draggable).toBeVisible()
    await expect(device.getByRole("seekbar", { name: "Draggable item" })).toBeVisible()
    await expect(device.getByRole("seekbar")).toHaveCount(1)
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
