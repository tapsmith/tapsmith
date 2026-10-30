import { describe, expect, test } from "../fixtures.js"

describe("Scroll screen", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///scroll")
  })

  test("shows heading and description", async ({ scrollScreen }) => {
    await expect(scrollScreen.heading).toBeVisible()
  })

  test("first section is visible", async ({ scrollScreen }) => {
    await expect(scrollScreen.sectionA).toBeVisible()
    await expect(scrollScreen.firstItem).toBeVisible()
  })

  test("first item has correct accessible name", async ({ scrollScreen }) => {
    await expect(scrollScreen.firstItem).toHaveAccessibleName("Item A-1")
  })

  // ─── Element Screenshots ───

  test("can take element screenshot", async ({ scrollScreen }) => {
    const png = await scrollScreen.sectionA.screenshot()
    expect(png.length).toBeGreaterThan(0)
  })

  test("can take full device screenshot", async ({ device }) => {
    const screenshot = await device.takeScreenshot()
    expect(screenshot.success).toBe(true)
    expect(screenshot.data.length).toBeGreaterThan(0)
  })
})

// PILOT-891: with no direction, scrollIntoView() swipes the way the element
// lies. iOS lists the ScrollView's off-screen rows with their frames, so a row
// the screen was scrolled past is reached without `direction: "up"`. Android
// lists only on-screen rows, so it cannot know a row is above and keeps the
// documented "down" default there (the explicit direction is the way back:
// "up", the way the view scrolls, as scroll() takes it — PILOT-929).
//
// Last in the file: it leaves the screen scrolled. The per-file app reset
// restores it for the next file.
describe("Scroll screen — scrollIntoView() picks its direction (PILOT-891)", () => {
  // The swipes and settle reads are not progress-tracked, so they count
  // against the test timeout (slow software-GPU CI emulators, PILOT-345).
  test.use({ timeout: 60_000 })

  test("scrollIntoView() with no direction scrolls back up to a row above the screen", async ({ device, scrollScreen, platform }) => {
    await device.openDeepLink("tapsmithtest:///scroll")
    await expect(scrollScreen.firstItem).toBeVisible()

    // Down to the last section: below the screen, so "down" either way.
    const far = scrollScreen.item("D-5")
    await far.scrollIntoView({ maxScrolls: 15 })
    await expect(far).toBeVisible()
    await expect(scrollScreen.firstItem).not.toBeVisible()

    if (platform === "ios") {
      await scrollScreen.firstItem.scrollIntoView({ maxScrolls: 15 })
    } else {
      await scrollScreen.firstItem.scrollIntoView({ direction: "up", maxScrolls: 15 })
    }
    await expect(scrollScreen.firstItem).toBeVisible()
  })

  // PILOT-929: a swipe that changes nothing on screen means the content is at
  // its end, so scrollIntoView() stops there instead of swiping out maxScrolls.
  test("scrollIntoView() stops at the end of the content and says so", async ({ device, scrollScreen }) => {
    await device.openDeepLink("tapsmithtest:///scroll")
    await expect(scrollScreen.firstItem).toBeVisible()
    const missing = scrollScreen.item("Z-9")

    // At the top already: the first swipe toward the top moves nothing.
    const atTop = await missing.scrollIntoView({ direction: "up", maxScrolls: 30 }).then(() => null, (e: unknown) => e)
    expect(atTop).toBeInstanceOf(Error)
    expect((atTop as Error).message).toMatch(
      /^scrollIntoView: reached the end of the scrollable content without finding getByDescription\("Item Z-9"\) on screen: the screen stopped changing after 1 scroll\(s\) in direction "up" \(pass \{ direction: "down" \} to scroll the other way\)\./,
    )
    await expect(scrollScreen.firstItem).toBeVisible()

    // Down to the bottom: well short of the 30 allowed swipes.
    const atBottom = await missing.scrollIntoView({ maxScrolls: 30 }).then(() => null, (e: unknown) => e)
    expect(atBottom).toBeInstanceOf(Error)
    const swipes = Number(/the screen stopped changing after (\d+) scroll\(s\) in direction "down"/.exec((atBottom as Error).message)?.[1])
    expect(swipes).toBeGreaterThan(1)
    expect(swipes).toBeLessThan(30)
    await expect(scrollScreen.item("D-10")).toBeVisible()
  })
})
