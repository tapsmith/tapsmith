import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"
import { settledBoundingBox, turnTo } from "../utils/orientation.js"

describe("Drag and drop screen", () => {
  test.beforeEach(async ({ device, dragScreen }) => {
    await openScreen(device, "/drag")
    await expect(dragScreen.dropResult).toBeVisible()
  })

  test("dragTo() drops on the target", async ({ dragScreen }) => {
    const before = await dragScreen.dropCount()
    await dragScreen.source.dragTo(dragScreen.target)
    await expect(dragScreen.dropResult).toHaveText(`Drop ${before + 1}: On target`)
  })

  // PILOT-1258: on iOS 27 a device.swipe() straight after an alert's OK
  // landed while the alert's dismissal still animated. iOS dropped the touch,
  // the list stayed, and swipe() reported success. swipe() now waits for the
  // dismissal, as a tap does. No wait between the two, on purpose.
  test("device.swipe() straight after an alert's OK scrolls the list", async ({ device, dragScreen }) => {
    // The screen keeps its scroll position across tests.
    await dragScreen.listRow(1).scrollIntoView({ direction: "up" })
    await expect(dragScreen.listRow(1)).toBeVisible()
    await dragScreen.showAlertButton.tap()
    await dragScreen.alertOk.tap()
    await device.swipe("up")
    await expect(dragScreen.listRow(1)).toBeHidden()
  })

  // The same for scroll(). A positional handle sends the list's element id,
  // which scrolls at once; a plain locator is looked up on the device first,
  // which took long enough for the dismissal to end (PILOT-1258).
  test("scroll() straight after an alert's OK scrolls the list", async ({ dragScreen }) => {
    await dragScreen.listRow(1).scrollIntoView({ direction: "up" })
    await expect(dragScreen.listRow(1)).toBeVisible()
    await dragScreen.showAlertButton.tap()
    await dragScreen.alertOk.tap()
    await dragScreen.list.first().scroll("down")
    await expect(dragScreen.listRow(1)).toBeHidden()
  })

  test("dragTo() drops on the target in landscape", async ({ device, dragScreen }) => {
    // The target sits at the far right of the row, so a drag planned in the
    // turned screen's points but pressed as if it were still portrait lands
    // elsewhere (PILOT-1253).
    try {
      // Inside the try: if turning fails part-way, the device may still have
      // turned, and the tests after this one must start in portrait.
      // Portrait first: a landscape-native tablet starts out landscape.
      await turnTo(device, "portrait")
      await expect(dragScreen.target).toBeVisible()
      const portrait = await settledBoundingBox(dragScreen.target)
      await turnTo(device, "landscape")
      await expect(dragScreen.target).toBeVisible()
      // Some simulator runtimes turn the device but not the app: then there
      // is no rotated screen to drag on.
      const landscape = await settledBoundingBox(dragScreen.target)
      test.skip(
        !portrait || !landscape || landscape.x <= portrait.x + 50,
        "the app's UI did not rotate on this device, so its drags are not rotated either",
      )
      const before = await dragScreen.dropCount()
      await dragScreen.source.dragTo(dragScreen.target)
      await expect(dragScreen.dropResult).toHaveText(`Drop ${before + 1}: On target`)
    } finally {
      await device.setOrientation("portrait")
    }
  })
})
