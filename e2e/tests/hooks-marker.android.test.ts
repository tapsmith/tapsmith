import pngjs from "pngjs"
import type { Device } from "tapsmith"
import { test, describe, expect } from "../fixtures.js"
import { readHooksMarker } from "../utils/hooks-marker.js"

/**
 * PILOT-732: the hooks marker's screen-sized carrier `<Text>` must not draw.
 * Under Fabric on Android a `color: 'transparent'` is dropped as "unset", and
 * the whole marker string drew in black across the top of the app.
 * PILOT-830: nor may a visible copy — earlier versions also drew the marker
 * in small grey text in the bottom-right corner, in every screenshot.
 *
 * Android only: the colour bug is in Fabric's Android colour encoding. The
 * strip at the top lies under the status bar; on the test app's home screen
 * the status icons draw white over a white header, so a clock tick between
 * the two screenshots changes nothing there.
 *
 * The check is differential, so it needs no knowledge of what the app or the
 * status bar draw there: change the marker's text, and nothing in the strip
 * the carrier's first line occupies, nor in the bottom strip where the
 * visible copy used to be, may change with it. The positive control is a
 * screenshot of another screen, which must differ from the first — or the
 * screenshots could not have seen a change anywhere.
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
  test("the marker draws nothing on screen, neither the carrier nor a visible copy", async ({ device, homeScreen, keyboardScreen }) => {
    await expect(homeScreen.header).toBeVisible()
    // No locator matches the marker (PILOT-830): read it from the hierarchy.
    const carrier = await readHooksMarker(device)
    expect(carrier, "the hooks marker carrier is in the hierarchy").toBeDefined()

    const before = await screenshot(device)
    // Any received URL bumps the marker's `nav` count. A link to the home
    // route pushes another home screen, which leaves the screen as it was:
    // the marker text is all that changes.
    await device.openDeepLink("tapsmithtest:///")
    await expect.poll(async () => (await readHooksMarker(device))?.text).not.toBe(carrier!.text)
    await expect(homeScreen.header).toBeVisible()
    await device.waitForIdle()
    const after = await screenshot(device)

    const strip = Math.ceil(before.height * STRIP)
    const top = carrier!.bounds.y
    expect(
      changedPixels(before, after, top, top + strip),
      "pixels changed where the invisible marker carrier's text sits",
    ).toBe(0)
    expect(
      changedPixels(before, after, before.height - strip, before.height),
      "pixels changed in the bottom strip, where a visible copy of the marker used to be drawn",
    ).toBe(0)

    // Positive control: another screen does show in a screenshot.
    await device.openDeepLink("tapsmithtest:///keyboard")
    await expect(keyboardScreen.counts).toBeVisible()
    const other = await screenshot(device)
    expect(
      changedPixels(before, other, 0, before.height),
      "a different screen changed the screenshot (positive control)",
    ).toBeGreaterThan(0)
  })
})
