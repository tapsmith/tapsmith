import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-697: a multi-line TextInput is an EditText on Android and a text view
// on iOS. getByRole("textfield") finds it on both, as getByLabel does.

describe("a multi-line text field", () => {
  test.beforeEach(async ({ device, keyboardScreen }) => {
    await openScreen(device, "/keyboard")
    await expect(keyboardScreen.counts).toBeVisible()
  })

  test("is a textfield by role", async ({ keyboardScreen }) => {
    await expect(keyboardScreen.multilineInputByRole).toBeVisible()
    await expect(keyboardScreen.multilineInputByRole).toHaveRole("textfield")
  })

  test("counts among the screen's text fields", async ({ keyboardScreen }) => {
    await expect(keyboardScreen.textFields).toHaveCount(3)
    // A role-only nth() finds the same field again, past the single-line ones.
    expect(await keyboardScreen.textFields.nth(2).boundingBox()).toEqual(await keyboardScreen.multilineInput.boundingBox())
  })

  test("is editable, and takes text found by role", async ({ keyboardScreen }) => {
    await expect(keyboardScreen.multilineInputByRole).toBeEditable()
    await keyboardScreen.multilineInputByRole.clearAndType("line one")
    await expect(keyboardScreen.multilineInputByRole).toHaveValue("line one")
    // The same field by label, once it holds text: while it is empty, React
    // Native on iOS appends the placeholder to a multi-line input's label
    // ("Multiline input Multiline input"), which getByLabel compares whole.
    await expect(keyboardScreen.multilineInputByLabel).toHaveValue("line one")
    await expect(keyboardScreen.multilineInputByLabel).toHaveRole("textfield")
  })
})
