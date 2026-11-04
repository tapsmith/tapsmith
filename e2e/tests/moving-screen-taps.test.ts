import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"
import type { ElementHandle } from "tapsmith"

/**
 * Every action that touches must land on a screen that keeps moving. On iOS,
 * React Native gives a touch to the scroll view around it when a scroll event
 * comes while the touch is down (even from a nested carousel paging itself),
 * cancelling the press: the action reports success and nothing happens. The
 * test app's carousel turns a page 50 ms after a touch lands on any control
 * below it, so on iOS a touch held past that is lost every time (taps held
 * 100 ms lost 30 of 30). Touches are held 10 ms, or 20 ms on a control that
 * needs the touch to span a display frame (the switch), or whose target is
 * unknown (a tap at a point). React Native on Android keeps the press whatever
 * the hold, so there the tests only check that the actions land. The
 * double-tap target turns on its second touch. A double tap's presses were
 * held 40 ms before, also inside the 50 ms turn, so that test, like the
 * switch's (a switch needs its 20 ms, and XCTest's own tap also lifts within
 * 50 ms), checks only that the action lands: a turn sooner than 50 ms to
 * catch a 40 ms press left too little margin on a slow CI simulator.
 */
async function count(handle: ElementHandle, pattern: RegExp): Promise<number> {
  const match = pattern.exec(await handle.getText())
  if (!match) throw new Error(`no count matching ${pattern} on screen`)
  return Number(match[1])
}

describe("Touches on a moving screen", () => {
  test.beforeEach(async ({ device, carouselScreen }) => {
    // The reset lands on the carousel screen without remounting it when it
    // is already showing, so its page, counts and switch carry over: every
    // test reads where it starts.
    await openScreen(device, "/carousel")
    await expect(carouselScreen.addButton).toBeVisible()
  })

  test("an element tap lands while the carousel beside it turns", async ({ carouselScreen }) => {
    const start = await count(carouselScreen.added, /In basket: (\d+)/)
    for (let n = 1; n <= 5; n++) {
      await carouselScreen.addButton.tap()
      await expect(carouselScreen.added).toHaveText(`In basket: ${start + n}`)
    }
  })

  test("a tap at a point lands while the carousel beside it turns", async ({ device, carouselScreen }) => {
    const box = await carouselScreen.addButton.boundingBox()
    if (!box) throw new Error("Add to basket has no bounds")
    const start = await count(carouselScreen.added, /In basket: (\d+)/)
    for (let n = 1; n <= 5; n++) {
      await device.tapXY(box.x + box.width / 2, box.y + box.height / 2)
      await expect(carouselScreen.added).toHaveText(`In basket: ${start + n}`)
    }
  })

  test("both taps of a double tap land while the carousel beside it turns", async ({ carouselScreen }) => {
    const start = await count(carouselScreen.likes, /Likes: (\d+)/)
    for (let n = 1; n <= 3; n++) {
      await carouselScreen.likeButton.doubleTap()
      await expect(carouselScreen.likes).toHaveText(`Likes: ${start + n}`)
    }
  })

  test("setChecked() flips a switch while the carousel beside it turns", async ({ carouselScreen }) => {
    let on = (await carouselScreen.giftWrapState.getText()).endsWith("on")
    for (let n = 1; n <= 4; n++) {
      on = !on
      await carouselScreen.giftWrap.setChecked(on)
      await expect(carouselScreen.giftWrapState).toHaveText(`Gift wrap: ${on ? "on" : "off"}`)
    }
  })

  test("selectOption() opens a dropdown and picks while the carousel beside it turns", async ({ carouselScreen }) => {
    // Each size in turn, every one a change: a lost pick would leave the
    // size as it was.
    const current = (await carouselScreen.sizeChosen.getText()).replace("Size: ", "")
    const sizes = ["Small", "Medium", "Large"].filter((size) => size !== current)
    for (const size of [...sizes, sizes[0]]) {
      await carouselScreen.sizeButton.selectOption(size)
      await expect(carouselScreen.sizeChosen).toHaveText(`Size: ${size}`)
    }
  })
})
