import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"
import type { ElementHandle } from "tapsmith"

/**
 * PILOT-974: a tap must land on a screen that keeps moving. React Native
 * gives a touch to the scroll view around it when a scroll event comes while
 * the touch is down (even from a nested carousel paging itself), cancelling
 * the press. The test app's carousel turns a page 50 ms after a touch lands
 * on "Add to basket", so a tap held past that is lost every time (iOS taps
 * held 100 ms lost 30 of 30). Android taps are not held at all, and iOS taps
 * at a point (which React Native buttons get too) are held 20 ms.
 */
async function addedCount(added: ElementHandle): Promise<number> {
  const match = /In basket: (\d+)/.exec(await added.getText())
  if (!match) throw new Error("no basket count on screen")
  return Number(match[1])
}

describe("Taps on a moving screen", () => {
  test.beforeEach(async ({ device, carouselScreen }) => {
    // The reset lands on the carousel screen without remounting it when it
    // is already showing, so its page and count carry over: counts below
    // are relative.
    await openScreen(device, "/carousel")
    await expect(carouselScreen.addButton).toBeVisible()
  })

  test("an element tap lands while the carousel beside it turns", async ({ carouselScreen }) => {
    const start = await addedCount(carouselScreen.added)
    for (let n = 1; n <= 5; n++) {
      await carouselScreen.addButton.tap()
      await expect(carouselScreen.added).toHaveText(`In basket: ${start + n}`)
    }
  })

  test("a tap at a point lands while the carousel beside it turns", async ({ device, carouselScreen }) => {
    const box = await carouselScreen.addButton.boundingBox()
    if (!box) throw new Error("Add to basket has no bounds")
    const start = await addedCount(carouselScreen.added)
    for (let n = 1; n <= 5; n++) {
      await device.tapXY(box.x + box.width / 2, box.y + box.height / 2)
      await expect(carouselScreen.added).toHaveText(`In basket: ${start + n}`)
    }
  })
})
