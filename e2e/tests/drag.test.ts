import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

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

  test("dragTo() drops on the target in landscape", async ({ device, dragScreen }) => {
    // The target sits at the far right of the row, so a drag planned in the
    // turned screen's points but pressed as if it were still portrait lands
    // elsewhere (PILOT-1253).
    const portrait = await dragScreen.target.boundingBox()
    try {
      // Inside the try: if turning fails part-way, the device may still have
      // turned, and the tests after this one must start in portrait.
      await device.setOrientation("landscape")
      await expect(dragScreen.target).toBeVisible()
      // Some simulator runtimes turn the device but not the app: then there
      // is no rotated screen to drag on.
      const landscape = await dragScreen.target.boundingBox()
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
