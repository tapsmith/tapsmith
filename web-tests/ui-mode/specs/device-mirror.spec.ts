// Device mirror: the binary screen-frame path.
//
// Frames are the one part of the protocol that isn't JSON — an 11-byte header
// plus a raw PNG, decoded by `use-screen-mirror.ts` and painted to a <canvas>.
// That path depends on the frame arriving as an ArrayBuffer (the hook branches
// on `instanceof ArrayBuffer`), so these are what stop a silent break there: a
// Blob instead would drop every frame with no error raised anywhere.

import { test, expect } from "../fixtures.js"
import type { Locator } from "@playwright/test"
import { screenFrame, solidPng } from "../messages/frames.js"
import type { DevicePane } from "../panes/device.pane.js"

/**
 * The canvas covers its bezel's screen opening on both axes, and its box keeps
 * the frame's shape (no letterboxing either around or inside the canvas).
 */
async function expectCanvasFillsBezel(device: DevicePane, canvas?: Locator) {
  await expect.poll(async () => {
    const fill = await device.canvasFill(canvas)
    return Math.min(fill.width, fill.height) > 0.9 && Math.abs(fill.shape - 1) < 0.02
  }).toBe(true)
}

/** Whether the canvas pixel at (x, y) is the green test colour. */
async function greenAt(canvas: Locator, x: number, y: number) {
  return canvas.evaluate((el, [px, py]) => {
    const d = (el as HTMLCanvasElement).getContext("2d")?.getImageData(px, py, 1, 1).data
    return !!d && d[1] > 150 && d[0] < 50 && d[2] < 50
  }, [x, y] as const)
}

test.describe("Device mirror", () => {
  test("paints a frame onto the canvas", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(180, 320))

    await expect(device.canvas).toHaveAttribute("width", "180")
    await expect(device.canvas).toHaveAttribute("height", "320")
  })

  test("resizes when a later frame changes dimensions", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(180, 320, 1))
    await expect(device.canvas).toHaveAttribute("width", "180")

    // A rotation, or a different device mid-session.
    ui.sendFrame(screenFrame(320, 180, 2))
    await expect(device.canvas).toHaveAttribute("width", "320")
    await expect(device.canvas).toHaveAttribute("height", "180")
  })

  test("ignores a frame that arrives out of order", async ({ app, device, page }) => {
    const ui = app
    ui.sendFrame(screenFrame(180, 320, 10))
    await expect(device.canvas).toHaveAttribute("width", "180")

    // A frame from before the current one must not repaint over it. Needs a
    // settle: asserting straight away would pass before the stale frame had
    // even been decoded, whether or not the SPA drops it.
    ui.sendFrame(screenFrame(64, 64, 9))
    await page.waitForTimeout(300)
    await expect(device.canvas).toHaveAttribute("width", "180")
    await expect(device.canvas).toHaveAttribute("height", "320")
  })

  test("decodes the PNG payload rather than just reading the header", async ({ app, device }) => {
    const ui = app
    // Green, so a mis-sliced payload (or nothing drawn at all) is obvious: the
    // pixel would read transparent instead of opaque green.
    ui.sendFrame({ width: 32, height: 32, png: solidPng(32, 32, [0, 200, 0]) })
    await expect(device.canvas).toHaveAttribute("width", "32")

    const pixel = await device.canvas.evaluate((el) => {
      const ctx = (el as HTMLCanvasElement).getContext("2d")
      if (!ctx) return null
      return [...ctx.getImageData(16, 16, 1, 1).data]
    })

    expect(pixel).not.toBeNull()
    const [r, g, b, a] = pixel!
    expect(a).toBe(255)
    expect(g).toBeGreaterThan(150)
    expect(r).toBeLessThan(50)
    expect(b).toBeLessThan(50)
  })

  test("survives a corrupt frame without breaking the mirror", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(180, 320, 1))
    await expect(device.canvas).toHaveAttribute("width", "180")

    // A truncated PNG is dropped silently; the next good frame must still land.
    ui.sendFrame({ width: 64, height: 64, seq: 2, png: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
    ui.sendFrame(screenFrame(200, 400, 3))

    await expect(device.canvas).toHaveAttribute("width", "200")
    await expect(device.canvas).toHaveAttribute("height", "400")
  })

  test("follows the frame's shape when choosing the bezel, including a rotation", async ({ app, device }) => {
    const ui = app
    // Frames here are real-screen sized: the canvas shrinks to fit its bezel
    // but never grows, so a tiny frame would never fill one whatever the bezel.
    // A modern phone (≈0.45, like 1080×2400) fits the photographic frame.
    ui.sendFrame(screenFrame(540, 1200, 1))
    await expect(device.canvas).toHaveAttribute("width", "540")
    await expect(device.bezel).toHaveAttribute("data-bezel", "image")
    await expectCanvasFillsBezel(device)

    // Rotated: a landscape frame must not be squeezed into the upright photo.
    ui.sendFrame(screenFrame(1200, 540, 2))
    await expect(device.canvas).toHaveAttribute("width", "1200")
    await expect(device.bezel).toHaveAttribute("data-bezel", "css-phone")
    await expectCanvasFillsBezel(device)
    // The upright phone's notch would sit over the rotated screen's content.
    expect(await device.bezelCutoutShown()).toBe(false)

    // And back. The canvas is the same element throughout, so it still paints.
    ui.sendFrame({ width: 540, height: 1200, seq: 3, png: solidPng(540, 1200, [0, 200, 0]) })
    await expect(device.canvas).toHaveAttribute("width", "540")
    await expect(device.bezel).toHaveAttribute("data-bezel", "image")
    await expectCanvasFillsBezel(device)
    await expect.poll(() => greenAt(device.canvas, 270, 600)).toBe(true)
  })

  test("gives a tablet-shaped screen the tablet bezel even with an opaque serial", async ({ app, device }) => {
    const ui = app
    // The seeded device is `emulator-5554`: nothing in the name says tablet.
    ui.sendFrame(screenFrame(800, 1280, 1)) // 1600×2560
    await expect(device.canvas).toHaveAttribute("width", "800")
    await expect(device.bezel).toHaveAttribute("data-bezel", "css-tablet")
    await expectCanvasFillsBezel(device)
  })

  test("gives a squarer phone (iPhone SE class) the CSS bezel instead of letterboxing it", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(750, 1334, 1)) // 750×1334
    await expect(device.canvas).toHaveAttribute("width", "750")
    await expect(device.bezel).toHaveAttribute("data-bezel", "css-phone")
    await expectCanvasFillsBezel(device)
    // These phones have no notch: none drawn over the status bar.
    expect(await device.bezelCutoutShown()).toBe(false)
  })

  for (const [what, w, h, bezel] of [
    ["an iPhone SE-class phone", 750, 1334, "css-phone"],
    ["a tablet", 800, 1280, "css-tablet"],
  ] as const) {
    test(`fits ${what} on the CSS bezel into a short pane without letterboxing it`, async ({ app, device, page }) => {
      const ui = app
      // A short window: the device has to shrink to the pane's height, and its
      // box must keep the frame's shape, or taps map to the wrong spot.
      await page.setViewportSize({ width: 1600, height: 500 })
      ui.sendFrame(screenFrame(w, h, 1))
      await expect(device.canvas).toHaveAttribute("width", String(w))
      await expect(device.bezel).toHaveAttribute("data-bezel", bezel)
      await expectCanvasFillsBezel(device)
      expect(await device.canvasInsideWindow()).toBe(true)
    })
  }

  test("shows a placeholder while no device is connected", async ({ app, device }) => {
    const ui = app
    ui.drop()
    await expect(device.mirrorStatus).toHaveText("Waiting for device")
    await expect(device.mirrorStatusHint).toHaveText("Connect a device or start a test run")
  })

  test("names the mirror for assistive tech", async ({ app, device }) => {
    void app
    // A bare <canvas> is invisible to screen readers; the label is the only
    // thing that names it.
    await expect(device.canvas).toHaveCount(1)
    await expect(device.root).toHaveCount(1)
  })
})
