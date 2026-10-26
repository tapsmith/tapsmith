import { describe, expect, test } from "../fixtures.js"

describe("Login screen", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///login")
  })

  // ─── Layout & Visibility ───

  test("shows the sign in heading", async ({ loginScreen }) => {
    await expect(loginScreen.heading).toBeVisible()
  })

  test("shows email and password fields", async ({ loginScreen }) => {
    await expect(loginScreen.emailField).toBeVisible()
    await expect(loginScreen.passwordField).toBeVisible()
  })

  test("email field is editable", async ({ loginScreen }) => {
    await expect(loginScreen.emailField).toBeEnabled()
  })

  test("sign in button starts disabled", async ({ loginScreen }) => {
    await expect(loginScreen.signInButton).toBeDisabled()
  })

  test("forgot password link is visible", async ({ loginScreen }) => {
    await expect(loginScreen.forgotPasswordLink).toBeVisible()
  })

  // ─── Text Input ───

  test("can type into email field", async ({ loginScreen }) => {
    await loginScreen.emailField.type("test@example.com")
    await expect(loginScreen.emailField).toHaveValue("test@example.com")
  })

  test("can type into password field", async ({ loginScreen }) => {
    await loginScreen.passwordField.type("password123")
  })

  // ─── Focus & Keyboard ───

  test("focusing and blurring email field toggles keyboard", async ({ device, loginScreen }) => {
    await loginScreen.emailField.focus()
    await expect(loginScreen.emailField).toBeFocused()
    let shown = await device.isKeyboardShown()
    expect(shown).toBe(true)

    await loginScreen.emailField.blur()
    await device.hideKeyboard()
    shown = await device.isKeyboardShown()
    expect(shown).toBe(false)
  })

  // ─── Clear & Retype ───

  test("clearAndType() replaces existing text", async ({ loginScreen }) => {
    await loginScreen.emailField.clearAndType("wrong@email.com")
    await expect(loginScreen.emailField).toContainText("wrong@email.com")
  })

  // The field is found by the text the clear removes: the daemon clears and
  // types as two agent commands, which must both reach this field (PILOT-848).
  test("clearAndType() replaces a field found by its own text", async ({ device, loginScreen, platform }) => {
    test.skip(platform !== "android", "PILOT-852: the iOS agent's clear re-reads the field by its selector, which stops matching once the text shrinks")
    await loginScreen.emailField.clearAndType("old@value.com")
    await device.getByText("old@value.com").clearAndType("new@value.com")
    await expect(loginScreen.emailField).toContainText("new@value.com")
    await expect(loginScreen.emailField).not.toContainText("old@value.com")
  })

  test("clear() empties the field", async ({ loginScreen }) => {
    await loginScreen.emailField.type("hello")
    await loginScreen.emailField.clear()
    await expect(loginScreen.emailField).toBeEmpty()
  })

  // ─── Form Submission ───

  // PILOT-622: tap() leaves the keyboard alone for a text input.
  test("tapping the next field keeps the keyboard up and moves the focus", async ({ device, loginScreen }) => {
    await loginScreen.emailField.clearAndType("test@example.com")
    await loginScreen.passwordField.tap()
    await expect(loginScreen.passwordField).toBeFocused()
    expect(await device.isKeyboardShown()).toBe(true)
  })

  // PILOT-622: the form is in a ScrollView with the default
  // keyboardShouldPersistTaps, which spends the first touch after typing on
  // closing the keyboard. tap() puts the keyboard away first, so no
  // hideKeyboard() is needed.
  test("can type credentials and submit without hiding the keyboard", async ({ device, loginScreen }) => {
    await loginScreen.emailField.clearAndType("test@example.com")
    await loginScreen.passwordField.clearAndType("password123")
    await expect(loginScreen.signInButton).toBeEnabled()
    expect(await device.isKeyboardShown()).toBe(true)
    await loginScreen.signInButton.tap()
    await expect(device.getByText("Login successful!", { exact: true })).toBeVisible()
  })
})
