import { describe, expect, openScreen, test } from "./fixtures.js"

describe("Native: ScrollView + LazyVStack", () => {
  test.beforeEach(async ({ device, scroll }) => {
    await openScreen(device, "scroll")
    await expect(scroll.row(1)).toBeVisible()
  })

  test("scrollIntoView reaches the end of a lazy stack", async ({ scroll }) => {
    await scroll.end.scrollIntoView({ maxScrolls: 20 })
    await expect(scroll.end).toBeVisible()
    await expect(scroll.end).toBeInViewport()
  })

  test("scrolling back down to the top row", async ({ scroll }) => {
    await scroll.row(40).scrollIntoView({ maxScrolls: 20 })
    await scroll.row(1).scrollIntoView({ direction: "down", maxScrolls: 20 })
    await expect(scroll.row(1)).toBeInViewport()
  })
})

describe("Native: keyboard", () => {
  test.beforeEach(async ({ device, keyboard }) => {
    await openScreen(device, "keyboard")
    await expect(keyboard.name).toBeVisible()
  })

  test("return key fires onSubmit", async ({ device, keyboard }) => {
    await keyboard.name.type("Ada")
    await device.pressKey("enter")
    await expect(keyboard.submitted("Ada")).toBeVisible()
  })

  // BUG PILOT-792: hideKeyboard() reports success but the keyboard stays up (6/6). The
  // agent logs "keyboard element has no on-screen area; nothing to dismiss"
  // while isKeyboardShown() still says true.
  test.skip("focus shows the keyboard and hideKeyboard dismisses it", async ({ device, keyboard }) => {
    await keyboard.name.tap()
    await expect(keyboard.name).toBeFocused()
    expect(await device.isKeyboardShown()).toBe(true)
    await device.hideKeyboard()
    expect(await device.isKeyboardShown()).toBe(false)
  })

  test("TextEditor accepts multi-line text", async ({ keyboard }) => {
    await keyboard.notes.type("hello world")
    await expect(keyboard.notes).toHaveValue("hello world")
  })

  test("button tap after typing is not swallowed by the keyboard", async ({ keyboard }) => {
    await keyboard.notes.type("abc")
    await keyboard.saveNotes.tap()
    await expect(keyboard.submitted("notes (3 chars)")).toBeVisible()
  })
})
