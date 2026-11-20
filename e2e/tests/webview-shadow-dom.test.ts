/**
 * WebView locators see into open shadow roots, as Playwright's do: Ionic,
 * Stencil, Lit and Shoelace render their native controls inside them.
 * Closed shadow roots stay out of reach.
 */
import { beforeAll, describe, expect, isStrictModeViolation, test } from "tapsmith"
import { openScreen } from "../utils/app-reset.js"
import { WebViewShadowScreen } from "../screens/webview-shadow.screen.js"

describe("WebView shadow DOM", () => {
  test.use({ timeout: 90_000 })

  beforeAll(async ({ device }) => {
    await openScreen(device, "/webview-shadow")
    await expect(device.getByText("Shadow DOM WebView")).toBeVisible()
  })

  test("CSS and getBy* locators find controls inside open shadow roots, not closed ones", async ({ device }) => {
    const screen = new WebViewShadowScreen(await device.webview())
    expect(await screen.allButtons.count()).toBe(2)
    await expect(screen.saveDraftButton).toBeVisible()
    await expect(screen.displayNameField).toBeVisible()
    await expect(screen.displayNameByPlaceholder).toBeVisible()
    await expect(screen.displayNameByTestId).toBeVisible()
    await expect(screen.dismissButton).toBeVisible()
    expect(await screen.hiddenAction.count()).toBe(0)
    await device.native()
  })

  test("actions and assertions work on shadow-DOM elements", async ({ device }) => {
    const screen = new WebViewShadowScreen(await device.webview())
    await screen.saveDraftButton.click()
    await expect(screen.status).toHaveText("Draft saved")

    await screen.displayNameField.fill("Jordan")
    await expect(screen.displayNameByTestId).toHaveValue("Jordan")
    await expect(screen.status).toHaveText("Hello, Jordan")

    await screen.dismissButton.click()
    await expect(screen.status).toHaveText("Banner dismissed")
    await device.native()
  })

  test("strict mode counts shadow-DOM matches", async ({ device }) => {
    const screen = new WebViewShadowScreen(await device.webview())
    const error = await screen.allButtons.click().catch((err: unknown) => err)
    expect(isStrictModeViolation(error)).toBe(true)
    await screen.allButtons.first().click()
    await expect(screen.status).toHaveText("Draft saved")
    await device.native()
  })
})
