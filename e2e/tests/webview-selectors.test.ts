/**
 * Verify that every locator the Locator Playground would suggest
 * for WebView elements actually works at runtime.
 */
import { beforeAll, describe, expect, test } from "tapsmith"
import { openScreen } from "../utils/app-reset.js"

describe("WebView locator playground parity", () => {
  test.use({ timeout: 90_000 })

  beforeAll(async ({ device }) => {
    await openScreen(device, "/webview")
    await expect(device.getByText("Embedded WebView")).toBeVisible()
  })

  test("getByRole with name finds heading", async ({ device }) => {
    const webview = await device.webview()
    await expect(webview.getByRole("heading", { name: "WebView Test Page" })).toBeVisible()
    await device.native()
  })

  test("getByText finds heading text", async ({ device }) => {
    const webview = await device.webview()
    await expect(webview.getByText("WebView Test Page")).toBeVisible()
    await device.native()
  })

  test("getByPlaceholder finds email input", async ({ device }) => {
    const webview = await device.webview()
    const field = webview.getByPlaceholder("Enter your email")
    await field.fill("placeholder@test.com")
    await expect(field).toHaveValue("placeholder@test.com")
    await device.native()
  })

  test("getByPlaceholder finds password input", async ({ device }) => {
    const webview = await device.webview()
    const field = webview.getByPlaceholder("Enter your password")
    await field.fill("pass456")
    await expect(field).toHaveValue("pass456")
    await device.native()
  })

  test("locator with #id finds email", async ({ device }) => {
    const webview = await device.webview()
    await webview.locator("#email").fill("id@test.com")
    await expect(webview.locator("#email")).toHaveValue("id@test.com")
    await device.native()
  })

  test("locator with #id finds password", async ({ device }) => {
    const webview = await device.webview()
    await webview.locator("#password").fill("idpass")
    await expect(webview.locator("#password")).toHaveValue("idpass")
    await device.native()
  })

  test("getByRole button with name finds login button", async ({ device }) => {
    const webview = await device.webview()
    await expect(webview.getByRole("button", { name: "Login" })).toBeVisible()
    await webview.getByRole("button", { name: "Login" }).click()
    await device.native()
  })

  test("getByRole button with name finds increment button", async ({ device }) => {
    const webview = await device.webview()
    await expect(webview.getByRole("button", { name: "Increment" })).toBeVisible()
    await webview.getByRole("button", { name: "Increment" }).click()
    await expect(webview.getByText("Count: 1")).toBeVisible()
    await device.native()
  })

  test("locator with #id finds buttons", async ({ device }) => {
    const webview = await device.webview()
    await expect(webview.locator("#login-button")).toBeVisible()
    await expect(webview.locator("#increment-button")).toBeVisible()
    await device.native()
  })

  test("getByText finds link text", async ({ device }) => {
    const webview = await device.webview()
    await expect(webview.getByText("Forgot password?")).toBeVisible()
    await device.native()
  })

  test("getByText finds paragraph text", async ({ device }) => {
    const webview = await device.webview()
    await expect(webview.getByText("This page tests WebView interaction via CDP.")).toBeVisible()
    await device.native()
  })

  test("getByRole textfield with label name finds email", async ({ device }) => {
    const webview = await device.webview()
    const field = webview.getByRole("textfield", { name: "Email" })
    await field.fill("label@test.com")
    await expect(field).toHaveValue("label@test.com")
    await device.native()
  })

  test("getByRole textfield with label name finds password", async ({ device }) => {
    const webview = await device.webview()
    const field = webview.getByRole("textfield", { name: "Password" })
    await field.fill("labelpass")
    await expect(field).toHaveValue("labelpass")
    await device.native()
  })

  test("locator with tag.class finds elements", async ({ device }) => {
    const webview = await device.webview()
    await expect(webview.locator("h1.header")).toHaveText("WebView Test Page")
    await expect(webview.locator("p.description")).toContainText("CDP")
    await device.native()
  })
})
