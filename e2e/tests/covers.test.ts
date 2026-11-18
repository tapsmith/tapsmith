import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-979: a loading overlay (a plain view holding a spinner) is a cover,
// though it is not a control — a tap used to land on it and report success.
// The target and the overlay each count their own taps.

describe("Covers", () => {
  test.use({ appResetScope: "test" })

  test.beforeEach(async ({ device, coversScreen }) => {
    await openScreen(device, "/covers")
    await expect(coversScreen.counts).toBeVisible()
  })

  const failureOf = (action: Promise<unknown>) =>
    action.then(
      () => "",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )

  const counts = (c: { behindLoading?: number; loadingOverlay?: number }) =>
    `behindLoading=${c.behindLoading ?? 0} loadingOverlay=${c.loadingOverlay ?? 0}`

  describe("a loading overlay", () => {
    test("tap() waits for a loading overlay to go away, then taps the target", async ({ coversScreen }) => {
      await coversScreen.loadBrieflyButton.tap()
      await expect(coversScreen.loadingOverlay).toBeVisible()

      await coversScreen.behindLoading.tap()

      await expect(coversScreen.counts).toHaveText(counts({ behindLoading: 1 }))
    })

    test("tap() under a loading overlay that stays fails naming it, without tapping the overlay", async ({ coversScreen }) => {
      await coversScreen.keepLoadingButton.tap()
      await expect(coversScreen.loadingOverlay).toBeVisible()

      expect(await failureOf(coversScreen.behindLoading.tap({ timeout: 1_500 }))).toMatch(/covered by a loading overlay/i)

      await expect(coversScreen.counts).toHaveText(counts({}))
    })
  })
})
