import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"
import type { ElementHandle } from "tapsmith"

/**
 * End-to-end smoke test for the coordinate-based gesture API
 * (device.tapXY / longPressXY / dragXY / inputText) that powers the
 * interactive UI-mode device mirror. Resolves real element bounds and drives
 * the device by raw coordinate — a wrong coordinate-space mapping would miss
 * the target and fail the on-screen assertion.
 */
async function center(el: ElementHandle): Promise<{ x: number; y: number }> {
  const b = await el.boundingBox()
  if (!b) throw new Error("element has no bounds")
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

describe("Coordinate gesture API (mirror)", () => {
  test("tapXY taps at a resolved coordinate", async ({ device, gesturesScreen }) => {
    await openScreen(device, "/gestures")
    await expect(gesturesScreen.heading).toBeVisible()
    const c = await center(gesturesScreen.tapArea)
    await device.tapXY(c.x, c.y)
    await expect(gesturesScreen.tapCount).toContainText("1")
  })

  test("longPressXY long-presses at a resolved coordinate", async ({ device, gesturesScreen }) => {
    await openScreen(device, "/gestures")
    await expect(gesturesScreen.heading).toBeVisible()
    const c = await center(gesturesScreen.longPressArea)
    await device.longPressXY(c.x, c.y, { duration: 800 })
    await expect(gesturesScreen.lastGesture).toContainText("Long press")
  })

  test("dragXY drags from one coordinate to another", async ({ device, gesturesScreen }) => {
    await openScreen(device, "/gestures")
    await expect(gesturesScreen.heading).toBeVisible()
    const from = await center(gesturesScreen.draggable)
    const to = await center(gesturesScreen.dropZone)
    await device.dragXY(from, to, { duration: 600 })
    await expect(gesturesScreen.lastGesture).toContainText("Drag")
  })

  test("inputText types into the focused field", async ({ device, loginScreen }) => {
    await device.openDeepLink("tapsmithtest:///login")
    await expect(loginScreen.emailField).toBeVisible()
    const c = await center(loginScreen.emailField)
    await device.tapXY(c.x, c.y)
    await device.inputText("smoke@test.com")
    await expect(loginScreen.emailField).toHaveValue("smoke@test.com")
  })
})

// PILOT-970: Android held a long press, and ran a coordinate drag, one display
// frame per 5 ms of duration — ~3x as long as asked at 60 Hz, more on a slow
// emulator. Each call also carries overhead that varies on a loaded CI runner
// (the trace's before-capture, the RPC, a drag's fling settle), so each gesture
// is timed at a short and a long duration and the difference, which the
// overhead cancels out of, must be close to the difference in duration. The
// iOS agent and HID paths are not step-based, so only Android is held to this.
describe("Coordinate gesture durations", () => {
  // A fresh screen, so the draggable item starts away from the drop zone (an
  // item already dragged onto it sits under the zone and takes no touches).
  test.use({ appResetScope: "test" })

  async function timed(action: () => Promise<void>): Promise<number> {
    const started = Date.now()
    await action()
    return Date.now() - started
  }

  test("longPressXY and dragXY last their duration on Android", async ({ device, platform, gesturesScreen }) => {
    if (platform !== "android") return
    await openScreen(device, "/gestures")
    await expect(gesturesScreen.heading).toBeVisible()

    // 1500 ms more hold: ~1500 ms more time now, ~5000 ms before the fix.
    const press = await center(gesturesScreen.longPressArea)
    const shortPress = await timed(() => device.longPressXY(press.x, press.y, { duration: 200 }))
    const longPress = await timed(() => device.longPressXY(press.x, press.y, { duration: 1700 }))
    expect(longPress - shortPress).toBeGreaterThan(1000)
    expect(longPress - shortPress).toBeLessThan(3000)
    await expect(gesturesScreen.lastGesture).toContainText("Long press")

    // 1000 ms more drag: ~1000 ms more time now, ~3000 ms before the fix.
    // Sideways across the tap area, which neither scrolls nor counts a drag
    // as a tap, so both drags settle alike.
    const area = await gesturesScreen.tapArea.boundingBox()
    if (!area) throw new Error("tap area has no bounds")
    const y = area.y + area.height / 2
    const from = { x: area.x + area.width * 0.3, y }
    const to = { x: area.x + area.width * 0.7, y }
    const shortDrag = await timed(() => device.dragXY(from, to, { duration: 100 }))
    const longDrag = await timed(() => device.dragXY(to, from, { duration: 1100 }))
    expect(longDrag - shortDrag).toBeGreaterThan(600)
    expect(longDrag - shortDrag).toBeLessThan(2000)

    // And a timed drag still drags.
    const item = await center(gesturesScreen.draggable)
    const zone = await center(gesturesScreen.dropZone)
    await device.dragXY(item, zone, { duration: 1000 })
    await expect(gesturesScreen.lastGesture).toContainText("Drag")
  })
})
