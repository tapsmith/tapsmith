/**
 * PILOT-522, iOS: a case-insensitive substring getByText can match elements
 * of different types — here the uppercased "FULL NAME" text and the field
 * labelled "Full name" below it. An action that needs the live XCUIElement
 * (typing) must bind the element the locator picked, not shift onto
 * another one because the live query counts only the field's type.
 */
import { beforeEach, describe, expect, test } from "tapsmith"
import { openScreen } from "../utils/app-reset.js"

describe("Case-insensitive substring getByText, live elements (PILOT-522)", () => {
  test.use({ appResetScope: "test" })

  beforeEach(async ({ device }) => {
    await openScreen(device, "/text-matching")
  })

  test(".last() types into the field, not past it", async ({ device }) => {
    const matches = device.getByText("full name")
    await expect(matches).toHaveCount(2)
    await matches.last().type("Ada")
    await expect(device.getByLabel("Full name")).toHaveValue("Ada")
  })

  test("a substring match skips the application element and the keyboard", async ({ device }) => {
    // The application element's label is the app's name, "Tapsmith Test App".
    await expect(device.getByText("tapsmith test app")).toHaveCount(0)
    // With the software keyboard up, its lowercase keys ("shift", "delete")
    // aren't text in the app either.
    await device.getByLabel("Full name").type("Ada")
    await expect(device.getByText("SHIFT")).toHaveCount(0)
    await expect(device.getByText("Delete")).toHaveCount(0)
  })
})
