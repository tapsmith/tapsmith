/**
 * An in-app browser (expo-web-browser's openBrowserAsync, an
 * SFSafariViewController) is drawn by SafariViewService over the app. On
 * iOS 26+ the app's accessibility snapshot stops at it, so its Done button
 * used to be invisible to locators (PILOT-1384). The agent now reads the
 * browser's content into the app's tree.
 *
 * iOS only: on Android the browser is a Custom Tab, another app, which the
 * back key closes.
 */
import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

describe("an in-app browser", () => {
  // Presenting SafariViewService takes seconds on a busy runner.
  test.use({ timeout: 60_000 })

  test("is closed with its Done button", async ({ device, webviewScreen }) => {
    await openScreen(device, "/webview")
    await expect(webviewScreen.heading).toBeVisible()

    await webviewScreen.openInAppBrowserButton.tap()
    // The browser covers the app: its screen is gone and the browser's
    // controls are what locators see.
    await expect(webviewScreen.inAppBrowserDoneButton).toBeVisible({ timeout: 20_000 })
    await expect(webviewScreen.heading).toBeHidden()

    await webviewScreen.inAppBrowserDoneButton.tap()
    await expect(webviewScreen.heading).toBeVisible({ timeout: 10_000 })
    await expect(webviewScreen.inAppBrowserDoneButton).toBeHidden()
  })
})
