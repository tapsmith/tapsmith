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
// emulator. Each must take its duration (plus the call's overhead and, for the
// drag, its fling settle), not a multiple of it. The iOS agent and HID paths are
// not step-based, so only Android is held to this here.
describe("Coordinate gesture durations", () => {
  // A fresh screen, so the draggable item starts away from the drop zone (an
  // item already dragged onto it sits under the zone and takes no touches).
  test.use({ appResetScope: "test" })

  test("longPressXY and dragXY last their duration on Android", async ({ device, platform, gesturesScreen }) => {
    if (platform !== "android") return
    await openScreen(device, "/gestures")
    await expect(gesturesScreen.heading).toBeVisible()

    const press = await center(gesturesScreen.longPressArea)
    let started = Date.now()
    await device.longPressXY(press.x, press.y, { duration: 1500 })
    const pressMs = Date.now() - started
    expect(pressMs).toBeGreaterThanOrEqual(1500)
    expect(pressMs).toBeLessThan(3000)
    await expect(gesturesScreen.lastGesture).toContainText("Long press")

    const from = await center(gesturesScreen.draggable)
    const to = await center(gesturesScreen.dropZone)
    started = Date.now()
    await device.dragXY(from, to, { duration: 1000 })
    const dragMs = Date.now() - started
    expect(dragMs).toBeGreaterThanOrEqual(1000)
    expect(dragMs).toBeLessThan(2500)
    await expect(gesturesScreen.lastGesture).toContainText("Drag")
  })
})
