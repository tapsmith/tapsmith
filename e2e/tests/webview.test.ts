/**
 * E2E tests for WebView interaction.
 *
 * Tests hybrid app scenarios: switch to WebView context, interact with
 * web content via CSS selectors, assert on DOM state, then switch back
 * to native.
 *
 * Tests are ordered so read-only/non-destructive tests run first,
 * then stateful tests (login, counter) run last — avoiding WebView
 * remounts between tests for debug socket stability on CI.
 */
import { beforeAll, describe, expect, isStrictModeViolation, test } from "tapsmith"
import { openScreen } from "../utils/app-reset.js"

describe("WebView testing", () => {
  test.use({ timeout: 90_000 })

  beforeAll(async ({ device }) => {
    await openScreen(device, "/webview")
    await expect(device.getByText("Embedded WebView")).toBeVisible()
  })

  test("can read text content from WebView", async ({ device }) => {
    const webview = await device.webview()
    const header = await webview.textContent(".header")
    expect(header).toBe("WebView Test Page")
    await device.native()
  })

  test("can fill inputs in WebView", async ({ device }) => {
    const webview = await device.webview()
    await webview.fill("#email", "user@test.com")
    const value = await webview.inputValue("#email")
    expect(value).toBe("user@test.com")
    await device.native()
  })

  test("locator assertions work with WebView elements", async ({ device }) => {
    const webview = await device.webview()

    // Verify header text
    await expect(webview.locator(".header")).toHaveText("WebView Test Page")

    // Verify description contains expected text
    await expect(webview.locator(".description")).toContainText("CDP")

    // Verify success message is initially hidden (must run before login tests)
    await expect(webview.locator(".success-message")).toBeHidden()

    await device.native()
  })

  test("can evaluate arbitrary JavaScript", async ({ device }) => {
    const webview = await device.webview()
    const result = await webview.evaluate<number>("2 + 2")
    expect(result).toBe(4)
    await device.native()
  })

  test("can switch between native and WebView contexts", async ({ device }) => {
    // Start in native
    await expect(device.getByText("Embedded WebView")).toBeVisible()

    // Switch to WebView
    const webview = await device.webview()
    await expect(webview.locator(".header")).toBeVisible()

    // Switch back to native
    await device.native()

    // Native elements should still be accessible
    await expect(device.getByText("Embedded WebView")).toBeVisible()
  })

  test("can click buttons and see state changes", async ({ device }) => {
    const webview = await device.webview()
    await webview.fill("#email", "user@test.com")
    await webview.fill("#password", "password123")
    await webview.click("#login-button")
    await expect(webview.locator(".success-message")).toBeVisible()
    await device.native()
  })

  test("can interact with counter", async ({ device }) => {
    const webview = await device.webview()

    await expect(webview.locator("#count-display")).toHaveText("Count: 0")
    await webview.click("#increment-button")
    await expect(webview.locator("#count-display")).toHaveText("Count: 1")
    await webview.click("#increment-button")
    await expect(webview.locator("#count-display")).toHaveText("Count: 2")

    await device.native()
  })

  test("strict mode: ambiguous locator throws, positional chains are exempt (PILOT-227)", async ({ device }) => {
    const webview = await device.webview()

    // The page has two <button> elements (Login, Increment).
    const buttons = webview.getByRole("button")
    expect(await buttons.count()).toBe(2)

    // Acting on the ambiguous locator throws instead of clicking the first match.
    let error: unknown
    try {
      await buttons.click()
    } catch (err) {
      error = err
    }
    expect(isStrictModeViolation(error)).toBe(true)
    expect(String(error)).toContain("resolved to 2 elements")

    // Positional narrowing targets a single match.
    await expect(buttons.first()).toBeVisible()
    await expect(buttons.first()).toHaveText("Login")
    await expect(buttons.nth(1)).toHaveText("Increment")
    await expect(buttons.last()).toHaveText("Increment")

    // all() enumerates without strict violations.
    const all = await buttons.all()
    expect(all.length).toBe(2)

    // The violation's suggestions resolve (PILOT-666): getByText finds leaf
    // elements only, so a parent's text is never offered as one, and a
    // leaf's is.
    const groupError = await webview.locator(".form-group").click().catch((err: unknown) => err)
    expect(isStrictModeViolation(groupError)).toBe(true)
    expect(String(groupError)).not.toContain("aka webview.getByText")
    const labelError = await webview.locator("label").click().catch((err: unknown) => err)
    expect(String(labelError)).toContain('aka webview.getByText("Email", { exact: true })')
    expect(await webview.getByText("Email", { exact: true }).count()).toBe(1)

    await device.native()
  })

  test("getByRole and getByText locators work", async ({ device }) => {
    const webview = await device.webview()

    // getByRole('heading') finds the h1
    await expect(webview.getByRole("heading")).toHaveText("WebView Test Page")

    // getByRole('button', { name }) finds a specific button
    await expect(webview.getByRole("button", { name: "Login" })).toBeVisible()

    // getByText finds elements by visible text
    await expect(webview.getByText("Forgot password?")).toBeVisible()

    // getByPlaceholder finds inputs by placeholder
    const emailField = webview.getByPlaceholder("Enter your email")
    await emailField.fill("test@example.com")
    await expect(emailField).toHaveValue("test@example.com")

    // getByRole('button') + click + assert
    await webview.getByPlaceholder("Enter your password").fill("secret")
    await webview.getByRole("button", { name: "Login" }).click()
    await expect(webview.getByText("Login successful!")).toBeVisible()

    await device.native()
  })
})
