import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-223: a tap on an element that is on screen but covered by something
// else — the software keyboard, an overlay — used to report success while the
// touch landed on the cover. Playwright fails a click whose target point is
// intercepted (after waiting for the cover to go away); so must we. Every
// target and cover on the screen counts its own taps, so each test can assert
// where a touch really went, not just whether tap() resolved.
//
// iOS-only until the Android agent gets the same check (PILOT-362); drop the
// `.ios` from the file name then.

describe("Occlusion", () => {
  test.use({ appResetScope: "test" })

  test.beforeEach(async ({ device, occlusionScreen }) => {
    await openScreen(device, "/occlusion")
    await expect(occlusionScreen.counts).toBeVisible()
  })

  // The message an action failed with ("" if it succeeded).
  const failureOf = (action: Promise<unknown>) =>
    action.then(
      () => "",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )

  const counts = (c: Partial<Record<"bottom" | "covered" | "overlay" | "passThrough" | "link", number>>) => {
    const all = { bottom: 0, covered: 0, overlay: 0, passThrough: 0, link: 0, ...c }
    return `bottom=${all.bottom} covered=${all.covered} overlay=${all.overlay} passThrough=${all.passThrough} link=${all.link}`
  }

  describe("covered targets fail instead of tapping the cover", () => {
    // Each of these waits out the full action timeout before failing; keep it
    // short so the file stays quick.
    test.use({ timeout: 4_000 })

    test("tap() on a button behind the keyboard fails and names the keyboard", async ({ device, occlusionScreen }) => {
      await occlusionScreen.openKeyboard()
      expect(await device.isKeyboardShown()).toBe(true)

      expect(await failureOf(occlusionScreen.bottomAction.tap())).toMatch(/covered by the keyboard/i)

      // The keyboard never saw the touch (no stray key typed) and it is still up.
      await expect(occlusionScreen.input).toHaveValue("x")
      expect(await device.isKeyboardShown()).toBe(true)
      await expect(occlusionScreen.counts).toHaveText(counts({}))
    })

    test("tap() on a button under an overlay fails and does not tap the overlay", async ({ occlusionScreen }) => {
      await occlusionScreen.showOverlayButton.tap()
      await expect(occlusionScreen.overlay).toBeVisible()

      expect(await failureOf(occlusionScreen.coveredAction.tap())).toMatch(/covered by .*Overlay/i)

      await expect(occlusionScreen.counts).toHaveText(counts({}))
    })

    test("doubleTap() and longPress() refuse a covered target too", async ({ occlusionScreen }) => {
      await occlusionScreen.showOverlayButton.tap()
      await expect(occlusionScreen.overlay).toBeVisible()

      expect(await failureOf(occlusionScreen.coveredAction.doubleTap())).toMatch(/covered by/i)
      expect(await failureOf(occlusionScreen.coveredAction.longPress())).toMatch(/covered by/i)

      await expect(occlusionScreen.counts).toHaveText(counts({}))
    })
  })

  test("tap() waits for a transient overlay to go away, then taps the target", async ({ occlusionScreen }) => {
    await occlusionScreen.showOverlayBrieflyButton.tap()
    await expect(occlusionScreen.overlay).toBeVisible()

    await occlusionScreen.coveredAction.tap()

    await expect(occlusionScreen.counts).toHaveText(counts({ covered: 1 }))
  })

  test("tap() taps the visible part of a button the keyboard half covers", async ({ device, occlusionScreen }) => {
    await occlusionScreen.makeTallButton.tap()
    await occlusionScreen.openKeyboard()
    expect(await device.isKeyboardShown()).toBe(true)

    await occlusionScreen.tallBottomAction.tap()

    await expect(occlusionScreen.counts).toHaveText(counts({ bottom: 1 }))
    await expect(occlusionScreen.input).toHaveValue("x")
  })

  test("tap() goes through an overlay that does not take touches", async ({ occlusionScreen }) => {
    await occlusionScreen.passThroughAction.tap()

    await expect(occlusionScreen.counts).toHaveText(counts({ passThrough: 1 }))
  })

  test("tap() on a link nested in a text run still works", async ({ occlusionScreen }) => {
    await occlusionScreen.termsLink.tap()

    await expect(occlusionScreen.counts).toHaveText(counts({ link: 1 }))
  })

  test("tap() on a button behind the keyboard works once the keyboard is gone", async ({ device, occlusionScreen }) => {
    await occlusionScreen.openKeyboard()
    // Submitting blurs the single-line input. (Not hideKeyboard(): on iOS it
    // relies on a scroll view to dismiss into, and this screen has none.)
    await device.pressKey("enter")
    await expect.poll(() => device.isKeyboardShown()).toBe(false)

    await occlusionScreen.bottomAction.tap()

    await expect(occlusionScreen.counts).toHaveText(counts({ bottom: 1 }))
  })
})
