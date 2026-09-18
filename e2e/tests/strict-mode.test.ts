import { describe, expect, test } from "../fixtures.js"
import { isStrictModeViolation, StrictModeViolationError } from "tapsmith"

// PILOT-226: a locator resolving to multiple elements must throw instead of
// silently acting on the first match in document order.
describe("strict mode", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///list")
  })

  test("tapping an ambiguous locator throws a strict mode violation listing the matches", async ({ device }) => {
    let error: unknown
    try {
      // The list screen renders many "Item N" rows — substring getByText
      // matches all of them.
      await device.getByText("Item ").tap()
    } catch (err) {
      error = err
    }
    expect(error).toBeDefined()
    expect(isStrictModeViolation(error)).toBe(true)
    const message = (error as Error).message
    expect(message).toMatch(/^strict mode violation: getByText\("Item "\) resolved to \d+ elements/)
    expect((error as StrictModeViolationError).elements.length).toBeGreaterThan(1)
    expect(message).toContain("Hint: use { exact: true }")
  })

  test("assertions on an ambiguous locator throw instead of checking the first match", async ({ device }) => {
    let error: unknown
    try {
      await expect(device.getByText("Item ")).toBeVisible({ timeout: 3_000 })
    } catch (err) {
      error = err
    }
    expect(isStrictModeViolation(error)).toBe(true)
  })

  test(".first() disambiguates for actions", async ({ device, listScreen }) => {
    await device.getByText("Item ").first().tap()
    await expect(listScreen.selectedCount).toContainText("1 selected")
    // Deselect to leave the screen state clean for other tests
    await device.getByText("Item ").first().tap()
    await expect(listScreen.selectedCount).toContainText("0 selected")
  })

  test("count(), all() and exists() remain exempt from strict mode", async ({ device }) => {
    const handle = device.getByText("Item ")
    expect(await handle.count()).toBeGreaterThan(1)
    const items = await handle.all()
    expect(items.length).toBeGreaterThan(1)
    // PILOT-344: exists() answers presence over all matches. On a modified
    // handle the old implementation swallowed the strict violation as
    // "doesn't exist", so the filtered form is the regression check.
    expect(await handle.exists()).toBe(true)
    expect(await handle.filter({ hasText: "Item" }).exists()).toBe(true)
  })

  test("absence assertions evaluate over all matches without throwing", async ({ device }) => {
    await expect(device.getByText("No Such Element Anywhere")).not.toBeVisible({ timeout: 1_000 })
  })
})
