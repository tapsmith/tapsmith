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

  test("a field matched only through its value types into that field", async ({ device }) => {
    // The nickname field has no accessibility label. An empty field's
    // placeholder isn't its value, so give it one: it then matches through
    // that value alone, after the uppercased "NICKNAME" text above it.
    const nickname = device.getByPlaceholder("Nickname")
    await nickname.type("nick")
    const matches = device.getByText("NICK")
    await expect(matches).toHaveCount(2)
    // type(), not clearAndType(): clearing would remove the very value the
    // locator matches through.
    await matches.last().type("name")
    await expect(nickname).toHaveValue("nickname")
  })
})
