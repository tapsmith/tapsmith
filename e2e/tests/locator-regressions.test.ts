/**
 * Regression tests for locator and assertion bugs that have been fixed.
 * Each section preserves the original PILOT issue ID so future regressions
 * are easy to triage.
 */
import { describe, expect, test } from "tapsmith"

describe("Locator & assertion regressions", () => {
  // Every test starts from the home screen and types into shared fields —
  // genuine per-test isolation, worth ~1 s of warm reset before each test.
  test.use({ appResetScope: "test" })

  // ─── PILOT-131: testId() now resolves to resource-id ───
  test("PILOT-131: testId() should find element by resource-id", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    const el = await device.getByTestId("email-input").find()
    expect(el.resourceId).toBe("email-input")
  })

  // ─── PILOT-132: hint() filters by extracted hint attribute ───
  test("PILOT-132: hint() should match by placeholder text", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    const el = await device.getByPlaceholder("Enter your email").find()
    expect(el.hint).toBe("Enter your email")
  })

  // ─── PILOT-133: type()/clearAndType() must not wrap text in literal quotes ───
  test("PILOT-133: type() should not add quotes around text", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    await device.getByTestId("email-input").type("test@example.com")
    await expect(device.getByTestId("email-input")).toHaveValue("test@example.com")
  })

  test("PILOT-133: clearAndType() should not add quotes around text", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    await device.getByTestId("email-input").type("seed text")
    await device.getByTestId("email-input").clearAndType("new@example.com")
    await expect(device.getByTestId("email-input")).toHaveValue("new@example.com")
  })

  // ─── accessibilityRole now flows through to the role attribute ───
  // The "Test Screens" element is rendered by test-app/app/index.tsx as
  // <Text accessibilityRole="header">Test Screens</Text>; if that
  // declaration changes, expect this test to need updating.
  test("accessibilityRole should map to UIAutomator role", async ({ device }) => {
    await expect(device.getByText("Test Screens", { exact: true })).toHaveRole("heading")
  })

  // ─── toContainText now traverses descendant text nodes ───
  test("toContainText should traverse child text nodes", async ({ device }) => {
    await device.getByDescription("Dialogs").tap()
    await device.locator({ id: "show-toast-button" }).tap()
    await expect(device.locator({ id: "toast" })).toContainText("Item saved successfully!")
  })

  // ─── toBeEmpty now ignores placeholder/hint after clear() ───
  test("toBeEmpty should ignore placeholder text after clear", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    await device.getByTestId("email-input").type("hello")
    await device.getByTestId("email-input").clear()
    await expect(device.getByTestId("email-input")).toBeEmpty()
  })

  // ─── type() must round-trip shell metacharacters verbatim ───
  // Android's typeTextWithoutFocus runs `input text $tokenized` where
  // `tokenized` is passed through UiDevice.executeShellCommand with no
  // surrounding shell — so &, ;, |, $, `, (, ) etc. must survive.
  test("type() round-trips shell metacharacters", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    const tricky = "a&b;c|d$e`f(g)h"
    await device.getByTestId("email-input").type(tricky)
    await expect(device.getByTestId("email-input")).toHaveValue(tricky)
  })

  // ─── type("\n") must NOT garble surrounding characters ───
  // Before this fix, Android `input text "foo\nbar"` was garbled by the
  // shell tokenizer and only the first whitespace-delimited segment
  // reached the field. Now the agent splits printable runs on control
  // characters and dispatches Enter as a key event between them. Post-
  // Enter behavior is platform-specific:
  //   - Android single-line TextInput consumes Enter as a space and
  //     keeps appending → final value is "foo bar".
  //   - iOS UITextField blurs the field so trailing input lands
  //     elsewhere → final value is just "foo".
  // Split per-platform so either one regressing to the other's behavior
  // fails loudly.
  test("type() around newline (Android → 'foo bar' with KEYCODE_ENTER-as-space)", async ({ device, platform }) => {
    if (platform !== "android") return
    await device.getByDescription("Login Form").tap()
    await device.getByTestId("email-input").type("foo\nbar")
    await expect(device.getByTestId("email-input")).toHaveValue("foo bar")
  })

  test("type() around newline (iOS → 'foo' because Enter blurs)", async ({ device, platform }) => {
    if (platform !== "ios") return
    await device.getByDescription("Login Form").tap()
    await device.getByTestId("email-input").type("foo\nbar")
    await expect(device.getByTestId("email-input")).toHaveValue("foo")
  })

  // ─── header is an accepted alias for heading on toHaveRole ───
  test("toHaveRole accepts 'header' as an alias for 'heading'", async ({ device }) => {
    await expect(device.getByText("Test Screens", { exact: true })).toHaveRole("header")
  })

  // ─── %s in type() round-trips verbatim on both platforms ───
  // Previously Android's `input text` shell command treated `%s` as a space
  // token, but the agent now handles escaping correctly.
  test("type() — %s round-trips verbatim", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    await device.getByTestId("email-input").type("a%sb")
    await expect(device.getByTestId("email-input")).toHaveValue("a%sb")
  })

  // ─── getByPlaceholder negative case: unknown placeholder returns nothing ───
  test("getByPlaceholder returns no match for an unknown placeholder", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    await expect(
      device.getByPlaceholder("This placeholder definitely does not exist"),
    ).toHaveCount(0)
  })
})
