import { expect } from "tapsmith"
import type { Device, ElementHandle } from "tapsmith"

type Orientation = "portrait" | "landscape"

/** The screen's shape as a screenshot shows it, upright. */
export async function screenShape(device: Device): Promise<Orientation> {
  const shot = Buffer.from((await device.takeScreenshot()).data)
  return shot.readUInt32BE(16) > shot.readUInt32BE(20) ? "landscape" : "portrait"
}

/**
 * Turn the device and wait until the screen has the new shape. Android's
 * setOrientation() returns before the display turns, so a layout read straight
 * after it can still see the old shape. Not waited for on iOS: some simulator
 * runtimes turn the device but not the app, and the tests skip there instead.
 */
export async function turnTo(device: Device, orientation: Orientation): Promise<void> {
  await device.setOrientation(orientation)
  if (device.platform !== "android") return
  await expect.poll(() => screenShape(device)).toBe(orientation)
}

/**
 * The element's bounding box once two reads in a row agree, so a layout that
 * is still settling after a turn is not measured half-way.
 */
export async function settledBoundingBox(element: ElementHandle) {
  let previous = JSON.stringify(await element.boundingBox())
  await expect
    .poll(async () => {
      const current = JSON.stringify(await element.boundingBox())
      const settled = current === previous
      previous = current
      return settled
    })
    .toBe(true)
  return JSON.parse(previous) as Awaited<ReturnType<ElementHandle["boundingBox"]>>
}
