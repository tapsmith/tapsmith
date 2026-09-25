import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-363: on a screen without a scroll view, iOS hideKeyboard() used to
// report success with the keyboard still up — and its dismiss drags, aimed
// at the screen centre, pressed whatever control sat there. It must dismiss
// the keyboard the ways a user would that do nothing else, and fail loudly
// when none works. Android dismisses with BACK whatever the screen, so there
// every case below just dismisses.
//
// Every target on the screen counts its own taps and submits, so a test can
// tell what hideKeyboard() touched, not just whether it resolved.

describe("hideKeyboard() on a screen without a scroll view", () => {
  test.use({ appResetScope: "test" })

  test.beforeEach(async ({ device, keyboardScreen }) => {
    await openScreen(device, "/keyboard")
    await expect(keyboardScreen.counts).toBeVisible()
  })

  // The message an action failed with ("" if it succeeded).
  const failureOf = (action: Promise<unknown>) =>
    action.then(
      () => "",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )

  const counts = (c: { centre?: number; plainSubmits?: number; goSubmits?: number; background?: number }) =>
    `centre=${c.centre ?? 0} plainSubmits=${c.plainSubmits ?? 0} goSubmits=${c.goSubmits ?? 0} background=${c.background ?? 0}`

  test("dismisses a single-line field's keyboard without touching anything else", async ({ device, platform, keyboardScreen }) => {
    await keyboardScreen.openKeyboard("plain")
    expect(await device.isKeyboardShown()).toBe(true)

    await device.hideKeyboard()

    // Nothing was tapped: iOS used to drag at the screen centre, pressing
    // "Centre action". It puts the keyboard away with the field's "return"
    // key, which also submits the field.
    await expect(keyboardScreen.counts).toHaveText(counts({ plainSubmits: platform === "ios" ? 1 : 0 }))
    await expect.poll(() => device.isKeyboardShown()).toBe(false)
    await expect(keyboardScreen.plainInput).toHaveValue("a")
    // The keyboard really is gone: the button it covered takes a tap.
    await keyboardScreen.centreAction.tap()
    await expect(keyboardScreen.counts).toHaveText(counts({ centre: 1, plainSubmits: platform === "ios" ? 1 : 0 }))
  })

  test("fails instead of pressing an action return key when nothing else dismisses the keyboard", async ({ device, platform, keyboardScreen }) => {
    await keyboardScreen.openKeyboard("go")

    const failure = await failureOf(device.hideKeyboard())

    if (platform === "ios") {
      expect(failure).toMatch(/keyboard is still shown/i)
      expect(failure).toMatch(/return key is "go"/i)
      expect(failure).toContain('device.pressKey("enter")')
      expect(await device.isKeyboardShown()).toBe(true)
    } else {
      expect(failure).toBe("")
      await expect.poll(() => device.isKeyboardShown()).toBe(false)
    }
    // "go" was not pressed, and nothing else was touched.
    await expect(keyboardScreen.goInput).toHaveValue("a")
    await expect(keyboardScreen.counts).toHaveText(counts({}))
  })

  test("never presses return in a multi-line field", async ({ device, platform, keyboardScreen }) => {
    await keyboardScreen.openKeyboard("multiline")

    const failure = await failureOf(device.hideKeyboard())

    if (platform === "ios") {
      expect(failure).toMatch(/keyboard is still shown/i)
      expect(failure).toMatch(/multi-line/i)
      expect(await device.isKeyboardShown()).toBe(true)
    } else {
      expect(failure).toBe("")
      await expect.poll(() => device.isKeyboardShown()).toBe(false)
    }
    // No new line typed.
    await expect(keyboardScreen.multilineInput).toHaveValue("a")
    await expect(keyboardScreen.counts).toHaveText(counts({}))
  })

  test("taps a blank spot when the screen dismisses the keyboard on a background tap", async ({ device, platform, keyboardScreen }) => {
    await keyboardScreen.dismissOnBackgroundTapButton.tap()
    await keyboardScreen.openKeyboard("go")

    await device.hideKeyboard()

    await expect.poll(() => device.isKeyboardShown()).toBe(false)
    await expect(keyboardScreen.goInput).toHaveValue("a")
    // iOS dismissed it with one tap on the backdrop; "go" was not pressed.
    await expect(keyboardScreen.counts).toHaveText(counts({ background: platform === "ios" ? 1 : 0 }))
  })
})
