/**
 * PILOT-520: getByText, getByRole's name and getByLabel accept a RegExp, as in
 * Playwright, matched on device with JavaScript's semantics — `\s` covers the
 * non-breaking spaces on this screen, `i` folds case, `^`/`$` anchor the whole
 * text unless `m` is set. PILOT-548: toHaveText / toContainText accept a
 * RegExp and an array. The screen's text uses a non-breaking space, a narrow
 * no-break space, a line break and a run of spaces
 * (test-app/app/text-matching.tsx).
 */
import { describe, expect, test } from "tapsmith"

describe("RegExp locators (PILOT-520)", () => {
  // Tests tap counters on one screen, so each needs a fresh app state.
  test.use({ appResetScope: "test", appResetRoute: "/text-matching" })

  test("getByText(RegExp): \\s matches a non-breaking space", async ({ device }) => {
    await expect(device.getByText(/Welcome to\sExpo/)).toBeVisible()
    await expect(device.getByText(/Welcome to\sExpo/)).toHaveCount(1)
    // A plain space in the RegExp is a literal space, not NBSP.
    await expect(device.getByText(/Welcome to Expo/)).toHaveCount(0)
  })

  test("getByText(RegExp): the i flag and anchors", async ({ device }) => {
    await expect(device.getByText(/^welcome to\sexpo$/i)).toBeVisible()
    // Case-sensitive: not the heading ("welcome=0 save=0" below is lowercase).
    await expect(device.getByText(/^welcome to/)).toHaveCount(0)
    await expect(device.getByText(/^Expo/)).toHaveCount(0)
    await expect(device.getByText(/^Spaced\s+out$/)).toBeVisible()
  })

  test("getByText(RegExp) tests the raw text: line breaks need the m flag", async ({ device }) => {
    await expect(device.getByText(/^Line two$/m)).toBeVisible()
    await expect(device.getByText(/^Line two$/)).toHaveCount(0)
    await expect(device.getByText(/one\sLine/)).toBeVisible()
  })

  test("a RegExp match resolves to its element for actions", async ({ device }) => {
    await device.getByText(/^Welcome/).tap()
    await expect(device.getByTestId("text-matching-counts")).toHaveText("welcome=1 save=0")
  })

  test("getByRole name RegExp tests the whitespace-normalized name", async ({ device }) => {
    await device.getByRole("button", { name: /^save\sdraft$/i }).tap()
    await expect(device.getByTestId("text-matching-counts")).toHaveText("welcome=0 save=1")
  })

  test("getByLabel(RegExp) finds the field to type into", async ({ device }) => {
    const field = device.getByLabel(/^full\sname$/i)
    await field.type("Ada")
    await expect(field).toHaveValue("Ada")
  })

  test("an unsupported flag fails when the locator is built", async ({ device }) => {
    expect(() => device.getByText(/Welcome/y)).toThrow('getByText() does not support the RegExp flag "y"')
  })
})

describe("toHaveText / toContainText with RegExp and arrays (PILOT-548)", () => {
  test.use({ appResetScope: "test", appResetRoute: "/text-matching" })

  test("toHaveText(RegExp) tests the element's text", async ({ device }) => {
    await expect(device.getByTestId("text-matching-counts")).toHaveText(/^welcome=0 save=\d$/)
    await expect(device.getByTestId("text-matching-counts")).not.toHaveText(/save=1/)
  })

  test("toHaveText(array) and toContainText(array) read every match in order", async ({ device }) => {
    const lines = device.getByText(/^(Line|Spaced)/)
    await expect(lines).toHaveText([/^Line one\sLine two$/, /^Spaced\s+out$/])
    await expect(lines).toContainText(["Line", "out"])
    await expect(lines).not.toContainText(["out", "Line"])
  })
})
