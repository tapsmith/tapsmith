// Device frames: every device class, each way up, shown in a frame whose
// screen window is the screenshot's exact shape. The frame is chosen from the
// recorded device's model (named tablets and foldables) and the screenshot's
// shape, the same choice the live mirror makes (assets/bezels/frames.ts).

import { test, expect } from "../fixtures.js"
import { actionEvent } from "../trace-builder.js"
import { solidPng } from "../../png.js"
import type { ScreenshotPane } from "../../panes/screenshot.pane.js"

async function expectFitsFrame(screenshot: ScreenshotPane, bezel = screenshot.bezel) {
  await expect.poll(async () => {
    const fit = await screenshot.frameFit(bezel)
    return fit.width > 0.98 && fit.height > 0.98 && fit.imageFillsBox
  }).toBe(true)
}

const CLASSES = [
  // [what, model, platform, width, height, frame]
  ["a modern phone", "sdk_gphone64_arm64", "android", 270, 600, "photo"],
  ["a landscape phone", "sdk_gphone64_arm64", "android", 600, 270, "photo-landscape"],
  ["a landscape iPhone", "iPhone 17 Pro", "ios", 639, 295, "photo-landscape"],
  ["an iPhone SE", "iPhone SE (3rd generation)", "ios", 375, 667, "compact"],
  ["an iPhone SE turned", "iPhone SE (3rd generation)", "ios", 667, 375, "compact"],
  ["an 18:9 phone", "sdk_gphone64_arm64", "android", 300, 600, "phone"],
  ["an iPad", "iPad Air 11-inch (M2)", "ios", 410, 590, "tablet"],
  ["an iPad turned", "iPad Air 11-inch (M2)", "ios", 590, 410, "tablet"],
  ["an Android tablet", "sdk_gtablet_arm64", "android", 400, 640, "tablet"],
  ["a folded Pixel Fold", "Pixel 9 Pro Fold", "android", 270, 606, "foldable-outer"],
  ["an unfolded Pixel Fold", "Pixel 9 Pro Fold", "android", 519, 538, "foldable-inner"],
  ["a folded iPhone Duo", "iPhone Duo", "ios", 270, 575, "foldable-outer"],
  ["an unfolded iPhone Duo", "iPhone Duo", "ios", 500, 430, "foldable-inner"],
] as const

test.describe("Device frames", () => {
  for (const [what, model, platform, width, height, frame] of CLASSES) {
    test(`frames ${what} (${frame}, ${width}×${height})`, async ({ viewer, screenshotPanel: screenshot }) => {
      await viewer.open({
        metadata: { device: { serial: "SER-1", model, platform, isEmulator: true, screenResolution: { width, height } } },
        events: [actionEvent({ actionIndex: 0, action: "tap", screenshots: { before: true } })],
        // Real-screen sized (×4): a screenshot never grows past its own size.
        screenshots: { "screenshots/action-000-before.png": solidPng(width * 4, height * 4) },
      })
      await expect(screenshot.bezel).toHaveAttribute("data-frame", frame)
      await expectFitsFrame(screenshot)
      const box = (await screenshot.bezel.boundingBox())!
      expect(box.width > box.height).toBe(width > height)
    })
  }

  test("frames each device of a group by its own model and shape", async ({ viewer, screenshotPanel: screenshot }) => {
    await viewer.open({
      metadata: {
        device: { serial: "SER-A", model: "Pixel 9 Pro Fold", isEmulator: true },
        devices: [
          { name: "alice", serial: "SER-A", model: "Pixel 9 Pro Fold", isEmulator: true, platform: "android" },
          { name: "bob", serial: "SER-B", model: "iPad Air 11-inch (M2)", isEmulator: true, platform: "ios" },
        ],
        actionCount: 2,
      },
      events: [
        actionEvent({ actionIndex: 0, action: "tap", deviceId: "alice", screenshots: { before: true } }),
        actionEvent({ actionIndex: 1, action: "tap", deviceId: "bob", screenshots: { before: true } }),
      ],
      screenshots: {
        "screenshots/action-000-before.png": solidPng(2076, 2152),
        "screenshots/action-001-before.png": solidPng(2360, 1640),
      },
    })
    await expect(screenshot.paneBezel("alice")).toHaveAttribute("data-frame", "foldable-inner")
    await expect(screenshot.paneBezel("bob")).toHaveAttribute("data-frame", "tablet")
    await expectFitsFrame(screenshot, screenshot.paneBezel("alice"))
    await expectFitsFrame(screenshot, screenshot.paneBezel("bob"))
  })
})
