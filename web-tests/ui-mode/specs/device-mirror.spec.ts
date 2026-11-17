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
import { idleSeed, singleFileTree } from "../messages/scenarios.js"

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
    await expect(device.bezel).toHaveAttribute("data-frame", "photo")
    await expectCanvasFillsBezel(device)

    // Rotated: the same photograph, turned, around a landscape window.
    ui.sendFrame(screenFrame(1200, 540, 2))
    await expect(device.canvas).toHaveAttribute("width", "1200")
    await expect(device.bezel).toHaveAttribute("data-frame", "photo-landscape")
    await expectCanvasFillsBezel(device)
    expect(await device.frameImageFillsBezel()).toBe(true)
    const box = (await device.bezel.boundingBox())!
    expect(box.width).toBeGreaterThan(box.height)

    // And back. The canvas is the same element throughout, so it still paints.
    ui.sendFrame({ width: 540, height: 1200, seq: 3, png: solidPng(540, 1200, [0, 200, 0]) })
    await expect(device.canvas).toHaveAttribute("width", "540")
    await expect(device.bezel).toHaveAttribute("data-frame", "photo")
    await expectCanvasFillsBezel(device)
    expect(await device.frameImageFillsBezel()).toBe(true)
    await expect.poll(() => greenAt(device.canvas, 270, 600)).toBe(true)
  })

  test("returns to its full size after a rotation round trip", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(540, 1200, 1))
    await expect(device.bezel).toHaveAttribute("data-frame", "photo")
    await expectCanvasFillsBezel(device)
    const before = await device.canvas.boundingBox()

    ui.sendFrame(screenFrame(1200, 540, 2))
    await expect(device.bezel).toHaveAttribute("data-frame", "photo-landscape")
    await expectCanvasFillsBezel(device)
    ui.sendFrame(screenFrame(540, 1200, 3))
    await expect(device.bezel).toHaveAttribute("data-frame", "photo")

    // A landscape phase must not leave the pane (and so the device) shrunk.
    await expect.poll(async () => (await device.canvas.boundingBox())?.width).toBeCloseTo(before!.width, 0)
    expect((await device.canvas.boundingBox())!.height).toBeCloseTo(before!.height, 0)
  })

  for (const [what, w, h] of [
    ["the photo frame", 540, 1200],
    ["an SVG frame", 750, 1334],
  ] as const) {
    test(`grows back after the window is made shorter and then taller again (${what})`, async ({ app, device, page }) => {
      const ui = app
      const tall = page.viewportSize()!
      ui.sendFrame(screenFrame(w, h, 1))
      await expect(device.canvas).toHaveAttribute("width", String(w))
      await expectCanvasFillsBezel(device)
      const before = await device.canvas.boundingBox()

      await page.setViewportSize({ width: tall.width, height: 450 })
      await expect.poll(async () => (await device.canvas.boundingBox())!.height).toBeLessThan(before!.height - 50)
      await page.setViewportSize(tall)

      await expect.poll(async () => (await device.canvas.boundingBox())?.height).toBeCloseTo(before!.height, 0)
      await expectCanvasFillsBezel(device)
    })
  }

  // Every device class, each way up, in a frame whose window is its screen's
  // exact shape. The seeded device is `emulator-5554` (no name hints), so the
  // classes that need a name (foldables, a named tablet at phone shape) are
  // covered below with a named worker.
  for (const [what, w, h, frame] of [
    ["a tablet-shaped screen behind an opaque serial", 800, 1280, "tablet"],
    ["the same tablet turned", 1280, 800, "tablet"],
    ["a 16:9 (SE-class) phone", 720, 1280, "compact"],
    ["the same phone turned", 1280, 720, "compact"],
    ["an 18:9 phone the photo does not fit", 540, 1080, "phone"],
    ["the same phone turned", 1080, 540, "phone"],
  ] as const) {
    test(`frames ${what} exactly (${frame}, ${w}×${h})`, async ({ app, device }) => {
      const ui = app
      ui.sendFrame(screenFrame(w, h, 1))
      await expect(device.canvas).toHaveAttribute("width", String(w))
      await expect(device.bezel).toHaveAttribute("data-bezel", "image")
      await expect(device.bezel).toHaveAttribute("data-frame", frame)
      await expectCanvasFillsBezel(device)
      expect(await device.frameImageFillsBezel()).toBe(true)
      const box = (await device.bezel.boundingBox())!
      expect(box.width > box.height).toBe(w > h)
    })
  }

  for (const [what, w, h, frame] of [
    ["an iPhone SE-class phone", 750, 1334, "compact"],
    ["a tablet", 800, 1280, "tablet"],
    ["a landscape phone", 1200, 540, "photo-landscape"],
  ] as const) {
    test(`fits ${what} into a short pane without letterboxing it`, async ({ app, device, page }) => {
      const ui = app
      // A short window: the device has to shrink to the pane's height, and its
      // box must keep the frame's shape, or taps map to the wrong spot.
      await page.setViewportSize({ width: 1600, height: 500 })
      ui.sendFrame(screenFrame(w, h, 1))
      await expect(device.canvas).toHaveAttribute("width", String(w))
      await expect(device.bezel).toHaveAttribute("data-frame", frame)
      await expectCanvasFillsBezel(device)
      expect(await device.canvasInsideWindow()).toBe(true)
    })
  }

  test("falls back to a CSS bezel turned to match a landscape screen if the frame image fails", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(1200, 540, 1))
    await expect(device.bezel).toHaveAttribute("data-frame", "photo-landscape")
    await device.failFrameImage()
    await expect(device.bezel).toHaveAttribute("data-bezel", "css-phone")
    await expect(device.bezel).toHaveClass(/dm-skin-landscape/)
    await expectCanvasFillsBezel(device)
    // Turned counter-clockwise like the frames: the camera on the left short
    // edge, the side buttons along the top.
    const { camera, buttons } = await device.skinDecorations()
    expect(camera.x).toBeLessThan(0.1)
    expect(camera.y).toBeCloseTo(0.5, 1)
    expect(buttons.y).toBeLessThan(0.05)
    expect(buttons.x).toBeLessThan(0.5)
  })

  test("refits the CSS bezel when the device changes skin at the same screen shape", async ({ app, device, page }) => {
    const ui = app
    // Android and iOS skins pad the canvas differently, so a same-shaped frame
    // on the other platform needs a different canvas width to fit the pane.
    // The CSS skins only show if the frame image fails to load.
    await page.setViewportSize({ width: 1600, height: 500 })
    ui.sendFrame(screenFrame(750, 1334, 1))
    await expect(device.bezel).toHaveAttribute("data-frame", "compact")
    await device.failFrameImage()
    await expect(device.bezel).toHaveAttribute("data-bezel", "css-phone")
    await expect(device.bezel).toHaveClass(/dm-skin-android/)
    // No notch on these phones: none drawn over the status bar.
    expect(await device.bezelCutoutShown()).toBe(false)
    await expectCanvasFillsBezel(device)

    ui.send({ type: "device-info", serial: "SIM-1", isEmulator: true, platform: "ios", screenWidth: 750, screenHeight: 1334 })
    // A different device gets a fresh attempt at its frame image.
    await expect(device.bezel).toHaveAttribute("data-bezel", "image")
    await device.failFrameImage()
    await expect(device.bezel).toHaveClass(/dm-skin-ios/)
    // The canvas is refitted inside the iOS skin's padding: its box keeps the
    // frame's exact shape instead of being squashed by its max-height (a stale
    // Android-padding width), which would skew the tap mapping.
    await expect.poll(() => device.bezel.evaluate((el) => {
      const cs = getComputedStyle(el)
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      const r = el.querySelector("canvas")!.getBoundingClientRect()
      return Math.abs(r.width / r.height - 750 / 1334) < 0.002 && r.height + padY <= el.parentElement!.clientHeight + 0.5
    })).toBe(true)
    await expectCanvasFillsBezel(device)
  })

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

// Classes only a device's name tells apart: a foldable (unfolded, it is as
// square as a tablet; folded, as tall as a phone) and a named tablet.
test.describe("Device mirror (named devices)", () => {
  for (const [name, platform, frames] of [
    ["Pixel 9 Pro Fold", "android", [[1080, 2424, "foldable-outer"], [2076, 2152, "foldable-inner"], [2152, 2076, "foldable-inner"], [2424, 1080, "foldable-outer"]]],
    ["iPhone Duo", "ios", [[1080, 2300, "foldable-outer"], [1720, 2000, "foldable-inner"], [2000, 1720, "foldable-inner"], [2300, 1080, "foldable-outer"]]],
    ["iPad Air 11-inch (M2)", "ios", [[1640, 2360, "tablet"], [2360, 1640, "tablet"]]],
  ] as const) {
    test(`frames a ${name} by its name, folded, unfolded and turned`, async ({ ui, device }) => {
      ui.seed([
        ...idleSeed(singleFileTree()),
        { type: "workers-info", workers: [{ workerId: 0, deviceSerial: "SER-1", displayName: name, platform }] },
      ])
      await ui.open()
      let seq = 1
      for (const [w, h, frame] of frames) {
        // Real sizes halved: big enough to fill the frame (the canvas never grows).
        ui.sendFrame(screenFrame(w / 2, h / 2, seq++))
        await expect(device.canvas).toHaveAttribute("width", String(w / 2))
        await expect(device.bezel).toHaveAttribute("data-frame", frame)
        await expectCanvasFillsBezel(device)
        expect(await device.frameImageFillsBezel()).toBe(true)
      }
    })
  }
})
