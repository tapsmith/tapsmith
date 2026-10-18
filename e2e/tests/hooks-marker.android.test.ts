import pngjs from "pngjs"
import type { Device } from "tapsmith"
import { test, describe, expect } from "../fixtures.js"

/**
 * PILOT-732: the hooks marker's screen-sized carrier `<Text>` must not draw.
 * Under Fabric on Android a `color: 'transparent'` is dropped as "unset", and
 * the whole marker string drew in black across the top of the app.
 *
 * Android only: the bug is in Fabric's Android colour encoding, and on iOS the
 * status bar's clock sits in the strip this test reads.
 *
 * The check is differential, so it needs no knowledge of what the app or the
 * status bar draw there: change the marker's text, and nothing in the strip
 * the carrier's first line occupies may change with it. The visible copy in
 * the bottom-right corner is the positive control — the same change must show
 * there, or the screenshots could not have seen it anywhere.
 */

/** Fraction of the screen height read at the top and at the bottom. */
const STRIP = 0.03
/** A channel difference above this counts the pixel as changed. */
const THRESHOLD = 16

type Image = { width: number; height: number; data: Buffer }

async function screenshot(device: Device): Promise<Image> {
  const shot = await device.takeScreenshot()
  if (!shot.success) throw new Error(`screenshot failed: ${shot.errorMessage}`)
  return pngjs.PNG.sync.read(Buffer.from(shot.data))
}

/** Pixels in rows [top, bottom) whose colour differs between the two images. */
function changedPixels(a: Image, b: Image, top: number, bottom: number): number {
  expect(b.width).toBe(a.width)
  expect(b.height).toBe(a.height)
  let changed = 0
  for (let y = Math.max(0, top); y < Math.min(a.height, bottom); y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4
      if (
        Math.abs(a.data[i] - b.data[i]) > THRESHOLD ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > THRESHOLD ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > THRESHOLD
      ) changed++
    }
  }
  return changed
}

describe("Hooks marker visibility", () => {
  test("the marker carrier draws nothing; only the corner copy shows the marker", async ({ device, homeScreen }) => {
    await expect(homeScreen.header).toBeVisible()
    const carrier = await homeScreen.hooksMarker.boundingBox()
    expect(carrier, "the hooks marker carrier is in the hierarchy").not.toBeNull()
    const markerBefore = await homeScreen.hooksMarker.getText()

    const before = await screenshot(device)
    // Any received URL bumps the marker's `nav` count. A link to the home
    // route pushes another home screen, which leaves the strip under the
    // status bar as it was: the marker text is all that changes there.
    await device.openDeepLink("tapsmithtest:///")
    await expect(homeScreen.hooksMarker).not.toHaveText(markerBefore)
    await expect(homeScreen.header).toBeVisible()
    await device.waitForIdle()
    const after = await screenshot(device)

    const strip = Math.ceil(before.height * STRIP)
    const top = carrier!.y
    expect(
      changedPixels(before, after, before.height - strip, before.height),
      "the visible corner copy of the marker changed on screen (positive control)",
    ).toBeGreaterThan(0)
    expect(
      changedPixels(before, after, top, top + strip),
      "pixels changed where the invisible marker carrier's text sits",
    ).toBe(0)
  })
})
