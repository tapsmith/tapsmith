import { describe, expect, openScreen, test } from "./fixtures.js"

describe("Native: login form", () => {
  test.beforeEach(async ({ device, login }) => {
    await openScreen(device, "login")
    await expect(login.email).toBeVisible()
  })

  test("Sign In is disabled until both fields are filled", async ({ login }) => {
    await expect(login.signIn).toBeDisabled()
    await login.email.type("sam@example.com")
    await expect(login.signIn).toBeDisabled()
    await login.password.type("secret")
    await expect(login.signIn).toBeEnabled()
  })

  test("typing fills TextField and SecureField", async ({ login }) => {
    await login.email.type("sam@example.com")
    await expect(login.email).toHaveValue("sam@example.com")
    await login.password.type("secret")
    await login.signIn.tap()
    await expect(login.welcome).toBeVisible()
  })

  test("type appends to the text already in a field it comes back to", async ({ login }) => {
    await login.email.type("sam")
    await login.password.type("secret")
    await login.email.type("@example.com")
    await expect(login.email).toHaveValue("sam@example.com")
  })

  test("type appends to a value that runs past the middle of the field", async ({ login }) => {
    // Past the middle of the row, short of its end: a tap at the centre
    // would put the caret inside it. (A value as wide as the field leaves no
    // spot after the text for any tap.)
    const long = "samuel.long.name@example.com"
    await login.email.type(long)
    await login.password.type("secret")
    await login.email.type("Z")
    await expect(login.email).toHaveValue(`${long}Z`)
  })

  test("clearAndType replaces the field's text", async ({ login }) => {
    await login.email.type("wrong@example.com")
    await login.email.clearAndType("sam@example.com")
    await expect(login.email).toHaveValue("sam@example.com")
  })

  test("wrong password shows an error", async ({ login }) => {
    await login.email.type("sam@example.com")
    await login.password.type("nope")
    await login.signIn.tap()
    await expect(login.invalid).toBeVisible()
  })

  test("text fields report the textfield role and are editable", async ({ login }) => {
    await expect(login.email).toHaveRole("textfield")
    await expect(login.password).toHaveRole("textfield")
    await expect(login.email).toBeEditable()
  })
})
