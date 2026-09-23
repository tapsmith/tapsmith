import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-223 (iOS) / PILOT-362 (Android): a tap on an element that is on
// screen but covered by something else — the software keyboard, an overlay —
// used to report success while the touch landed on the cover. Playwright fails
// a click whose target point is intercepted (after waiting for the cover to go
// away); so must we. Every target and cover on the screen counts its own taps,
// so each test can assert where a touch really went, not just whether tap()
// resolved.
//
// One platform difference shapes the keyboard cases: Android hides a view
// that is entirely behind the keyboard from the accessibility tree (a view
// the keyboard only half covers stays, bounds unclipped). So on Android an
// action on a fully covered element fails as not found rather than as
// covered, and a field behind the keyboard cannot be read until the keyboard
// is gone.

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

  // How an action on an element entirely behind the keyboard fails. Android
  // can also see it as covered: the element resolves before the keyboard has
  // finished rising over it.
  const behindKeyboardFailure = (platform: string) =>
    platform === "android" ? /covered by the keyboard|not found/i : /covered by the keyboard/i

  type Counter = "bottom" | "covered" | "overlay" | "passThrough" | "link" | "replacement"
  const counts = (c: Partial<Record<Counter, number>>) => {
    const all = { bottom: 0, covered: 0, overlay: 0, passThrough: 0, link: 0, replacement: 0, ...c }
    return (
      `bottom=${all.bottom} covered=${all.covered} overlay=${all.overlay} ` +
      `passThrough=${all.passThrough} link=${all.link} replacement=${all.replacement}`
    )
  }

  describe("covered targets fail instead of tapping the cover", () => {
    // Each of these waits out the full action timeout before failing; keep it
    // short so the file stays quick.
    test.use({ timeout: 4_000 })

    test("tap() on a button behind the keyboard fails and names the keyboard", async ({ device, platform, occlusionScreen }) => {
      await occlusionScreen.openKeyboard()
      expect(await device.isKeyboardShown()).toBe(true)

      expect(await failureOf(occlusionScreen.bottomAction.tap())).toMatch(behindKeyboardFailure(platform))

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

    test("type() into a field behind the keyboard fails instead of typing into the focused one", async ({ device, platform, occlusionScreen }) => {
      await occlusionScreen.openKeyboard()

      expect(await failureOf(occlusionScreen.bottomInput.type("abc"))).toMatch(behindKeyboardFailure(platform))

      // The focusing tap never reached the keyboard: no stray key in the
      // focused field, and nothing typed anywhere.
      await expect(occlusionScreen.input).toHaveValue("x")
      await occlusionScreen.submitInput()
      await expect.poll(() => device.isKeyboardShown()).toBe(false)
      await expect(occlusionScreen.bottomInput).toHaveValue("")
    })

    test("clear() and focus() on a field behind the keyboard fail too", async ({ device, platform, occlusionScreen }) => {
      // clear() of an empty field returns before it taps, so give the bottom
      // field text while nothing covers it yet.
      await occlusionScreen.bottomInput.type("abc")
      await occlusionScreen.openKeyboard()

      expect(await failureOf(occlusionScreen.bottomInput.clear())).toMatch(behindKeyboardFailure(platform))
      expect(await failureOf(occlusionScreen.bottomInput.focus())).toMatch(behindKeyboardFailure(platform))

      await expect(occlusionScreen.input).toHaveValue("x")
      await occlusionScreen.submitInput()
      await expect.poll(() => device.isKeyboardShown()).toBe(false)
      await expect(occlusionScreen.bottomInput).toHaveValue("abc")
    })

    test("a target replaced while its cover is waited out is not tapped in its place", async ({ occlusionScreen }) => {
      await occlusionScreen.coverAndReplaceButton.tap()
      await expect(occlusionScreen.overlay).toBeVisible()

      // The cover goes after 1.5 s, and "Covered action" goes with it.
      expect(await failureOf(occlusionScreen.coveredAction.tap())).toMatch(/not found|no element/i)

      await expect(occlusionScreen.replacementAction).toBeVisible()
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

  test("doubleTap() lands on the visible part of a button the keyboard half covers", async ({ device, occlusionScreen }) => {
    await occlusionScreen.makeTallButton.tap()
    await occlusionScreen.openKeyboard()
    expect(await device.isKeyboardShown()).toBe(true)

    // Coordinate gestures take the analyzer's point, not XCUITest's own.
    await occlusionScreen.tallBottomAction.doubleTap()

    await expect(occlusionScreen.counts).toHaveText(counts({ bottom: 2 }))
    await expect(occlusionScreen.input).toHaveValue("x")
  })

  test("type() and clear() on a field the keyboard half covers stay inside its visible part", async ({ device, occlusionScreen }) => {
    await occlusionScreen.makeInputTallButton.tap()
    await occlusionScreen.openKeyboard()
    expect(await device.isKeyboardShown()).toBe(true)

    const field = occlusionScreen.bottomInput
    await field.type("abc")
    await expect(field).toHaveValue("abc")

    // Every focusing tap clear() makes — including the refocus after the
    // field empties — lands in the visible part, never on a key.
    await field.clear()
    await expect(field).toHaveValue("")
    await expect(occlusionScreen.input).toHaveValue("x")
  })

  test("clear() refocuses a field where it is now, after the keyboard moved it", async ({ occlusionScreen }) => {
    // The screen lifts above the keyboard when it opens, so the first focusing
    // tap moves the bottom input; clear()'s later refocus must aim at its new
    // place, not where it was (now under the keyboard).
    await occlusionScreen.avoidKeyboardButton.tap()
    await occlusionScreen.bottomInput.type("abc")
    await expect(occlusionScreen.bottomInput).toHaveValue("abc")

    await occlusionScreen.bottomInput.clear()
    await expect(occlusionScreen.bottomInput).toHaveValue("")
  })

  test("type() into a focused field its own keyboard covers types into it", async ({ device, platform, occlusionScreen }) => {
    // Android hides the field from the accessibility tree once its keyboard
    // covers it, so there is nothing left to type into by locator.
    if (platform === "android") return
    // Tapping the bottom input raises a keyboard over it (no avoidance). The
    // field already has focus, so type() must not need a focusing tap.
    await occlusionScreen.bottomInput.tap()
    expect(await device.isKeyboardShown()).toBe(true)

    await occlusionScreen.bottomInput.type("abc")

    await expect(occlusionScreen.bottomInput).toHaveValue("abc")
  })

  test("actions through a locator with no live query (placeholder) still work", async ({ occlusionScreen }) => {
    // An id-addressed doubleTap (first()) used to fail as "stale" for these.
    // (The top input: a field that ends up under its own keyboard would take
    // the second tap on the keyboard rising over it.)
    await occlusionScreen.inputByPlaceholder.first().doubleTap()
    await occlusionScreen.inputByPlaceholder.type("xyz")
    await expect(occlusionScreen.input).toHaveValue("xyz")
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
    await occlusionScreen.submitInput()
    await expect.poll(() => device.isKeyboardShown()).toBe(false)

    await occlusionScreen.bottomAction.tap()

    await expect(occlusionScreen.counts).toHaveText(counts({ bottom: 1 }))
  })
})
