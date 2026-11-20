import { describe, expect, test } from "../fixtures.js"

// PILOT-1324: a list still loading shows a spinner and nothing that scrolls,
// so a swipe changes nothing. scrollIntoView() must wait for the list, as
// every action auto-waits, rather than take the unchanging spinner for the
// end of the content and fail within a couple of seconds.
describe("scrollIntoView() on a list that is still loading", () => {
  // The swipes and settle reads are not progress-tracked, so they count
  // against the test timeout (slow software-GPU CI emulators, PILOT-345).
  test.use({ timeout: 60_000 })

  test("waits for the list to load, then scrolls to the row", async ({ device, delayedListScreen }) => {
    await device.openDeepLink("tapsmithtest:///delayed-list")
    await delayedListScreen.loadButton.tap()

    const row = delayedListScreen.row(30)
    await row.scrollIntoView({ timeout: 20_000 })

    await expect(row).toBeVisible()
  })
})
