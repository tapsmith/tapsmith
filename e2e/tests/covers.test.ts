import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-979: a loading overlay (a plain view holding a spinner) and a sticky
// list header are covers, though neither is a control — a tap used to land on
// them and report success. PILOT-980: a target under fixed chrome in its own
// window (a sticky header, a footer bar) is scrolled clear of it and tapped,
// as Playwright scrolls a target whose click another element intercepts.
// Every target and cover on the screen counts its own taps.

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

  type Counts = { behindLoading?: number; loadingOverlay?: number; row?: string; rowTaps?: number; added?: string; header?: number; footer?: number }
  const counts = (c: Counts) => {
    const all = { behindLoading: 0, loadingOverlay: 0, row: "none", rowTaps: 0, added: "none", header: 0, footer: 0, ...c }
    return (
      `behindLoading=${all.behindLoading} loadingOverlay=${all.loadingOverlay} row=${all.row} ` +
      `rowTaps=${all.rowTaps} added=${all.added} header=${all.header} footer=${all.footer}`
    )
  }

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

  describe("fixed chrome over a list", () => {
    test("tap() on a row under a footer bar scrolls it clear and taps it", async ({ coversScreen }) => {
      const label = await coversScreen.rowUnderFooter()

      await coversScreen.row(label).tap()

      await expect(coversScreen.counts).toHaveText(counts({ row: label, rowTaps: 1 }))
    })

    // The "Add" buttons all share one name, so nth() picks one by position.
    // Android follows the node it found through the scroll. The iOS agent
    // re-finds an element through a live query, which for one bound only by
    // position may pick another row once the list has moved, so iOS does not
    // scroll for it: it waits the cover out and fails, never tapping the cover.
    test("tap() on an nth() match under a footer bar scrolls it clear on Android and fails as covered on iOS", async ({ platform, coversScreen }) => {
      const label = await coversScreen.rowUnderFooter()
      const index = Number(label.replace("Row ", "")) - 1

      const failure = await failureOf(coversScreen.addButtons.nth(index).tap({ timeout: 3_000 }))

      if (platform === "android") {
        expect(failure).toBe("")
        await expect(coversScreen.counts).toHaveText(counts({ added: label }))
      } else {
        expect(failure).toMatch(/covered by .*Footer action/i)
        await expect(coversScreen.counts).toHaveText(counts({}))
      }
    })

    test("tap() on a row under a sticky header scrolls it clear and taps it", async ({ coversScreen }) => {
      await coversScreen.rowUnderHeaderButton.tap()

      await coversScreen.row("Row 5").tap()

      await expect(coversScreen.counts).toHaveText(counts({ row: "Row 5", rowTaps: 1 }))
    })
  })
})
