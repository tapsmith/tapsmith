/**
 * PILOT-510: text and name matching normalize whitespace like Playwright.
 * The stock create-expo-app heading is "Welcome to&nbsp;Expo", which both
 * agents expose with U+00A0, so getByText("Welcome to Expo") never matched.
 * Every query below is typed with plain single spaces; the screen's text uses
 * a non-breaking space, a narrow no-break space, a line break and a run of
 * spaces (test-app/app/text-matching.tsx).
 */
import { describe, expect, test } from "tapsmith"

describe("Whitespace-normalized text matching (PILOT-510)", () => {
  // Tests tap counters on one screen, so each needs a fresh app state.
  test.use({ appResetScope: "test", appResetRoute: "/text-matching" })

  test("getByText exact matches text with a non-breaking space", async ({ device }) => {
    const heading = device.getByText("Welcome to Expo", { exact: true })
    await expect(heading).toBeVisible()
    // It is the NBSP heading itself, not some other element.
    const el = await heading.find()
    expect(el.text.replace(/ /g, "<nbsp>")).toBe("Welcome to<nbsp>Expo")
  })

  test("getByText substring matches across a non-breaking space", async ({ device }) => {
    await expect(device.getByText("to Expo")).toBeVisible()
    await expect(device.getByText("Welcome to Expo")).toHaveCount(1)
  })

  test("a normalized match resolves to its element for actions", async ({ device }) => {
    await device.getByText("Welcome to Expo", { exact: true }).tap()
    await expect(device.getByTestId("text-matching-counts")).toHaveText("welcome=1 save=0")
  })

  test("getByText matches text broken over two lines", async ({ device }) => {
    await expect(device.getByText("Line one Line two", { exact: true })).toBeVisible()
    await expect(device.getByText("one Line")).toBeVisible()
  })

  test("getByText collapses runs of spaces on both sides", async ({ device }) => {
    await expect(device.getByText("Spaced out", { exact: true })).toBeVisible()
    await expect(device.getByText("  Spaced  out ", { exact: true })).toBeVisible()
  })

  test("exact matching still requires the whole text", async ({ device }) => {
    await expect(device.getByText("Welcome to", { exact: true })).toHaveCount(0)
  })

  test("getByRole name matches a label with a narrow no-break space", async ({ device }) => {
    await device.getByRole("button", { name: "Save draft" }).tap()
    await expect(device.getByTestId("text-matching-counts")).toHaveText("welcome=0 save=1")
  })

  test("getByLabel matches a label with a non-breaking space", async ({ device }) => {
    const field = device.getByLabel("Full name")
    await field.type("Ada")
    await expect(field).toHaveValue("Ada")
  })
})
