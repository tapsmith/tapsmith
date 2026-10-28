/**
 * PILOT-834: a text field with no accessibility label is named by its
 * placeholder, as Playwright names an input with no label — SwiftUI's
 * TextField("Title", text:) and a React Native TextInput without an
 * accessibilityLabel publish only a placeholder. A labelled field stays
 * named by its label alone. The text-matching screen has both: "Full name"
 * (placeholder "Your name") and the label-less "Nickname" field.
 */
import { beforeEach, describe, expect, test } from "tapsmith"
import { openScreen } from "../utils/app-reset.js"
import { TextMatchingScreen } from "../screens/text-matching.screen.js"

describe("getByRole name falls back to the placeholder (PILOT-834)", () => {
  // Tests type into the fields, so each needs a fresh app state.
  test.use({ appResetScope: "test" })

  let screen: TextMatchingScreen

  beforeEach(async ({ device }) => {
    screen = new TextMatchingScreen(device)
    await openScreen(device, "/text-matching")
  })

  test("a field with no label is found, and typed into, by its placeholder name", async ({ device }) => {
    const byRole = device.getByRole("textfield", { name: "Nickname" })
    await expect(byRole).toHaveCount(1)
    // type() needs the live element on iOS: it must be the nickname field.
    await byRole.type("nick")
    await expect(screen.nicknameField).toHaveValue("nick")
    await expect(screen.fullNameField).toHaveValue("")
  })

  test("the placeholder still names the field once text is typed into it", async ({ device }) => {
    await screen.nicknameField.type("ada")
    await expect(device.getByRole("textfield", { name: "Nickname", exact: true })).toHaveCount(1)
    await expect(device.getByRole("textfield", { name: /^nick/i })).toHaveCount(1)
    await expect(screen.nicknameField).toHaveAccessibleName("Nickname")
  })

  test("a labelled field is named by its label, not its placeholder", async ({ device }) => {
    await expect(device.getByRole("textfield", { name: "Your name" })).toHaveCount(0)
    await expect(device.getByRole("textfield", { name: "Full name" })).toHaveCount(1)
    await expect(screen.fullNameField).toHaveAccessibleName("Full name")
  })
})
