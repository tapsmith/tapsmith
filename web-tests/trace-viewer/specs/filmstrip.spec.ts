// Timeline filmstrip: frame geometry and offset labels. Both cases here were
// found by hand on a trace whose first row was a prepared app reset — a row
// with no screenshot of its own that ran before the test began.

import { test, expect } from "../fixtures.js"
import { actionEvent, defaultMetadata } from "../trace-builder.js"
import { solidPng } from "../../png.js"

test.describe("Timeline filmstrip", () => {
  test("sizes a placeholder frame like its neighbouring phone thumbnails, selected or not", async ({ viewer, filmstrip }) => {
    // Step 0 has no screenshot and nothing earlier to borrow one from, so it
    // renders the numbered placeholder; step 1 renders a real portrait
    // thumbnail. The placeholder must neither collapse to its label nor
    // stand out wider than the screenshots beside it.
    await viewer.open({
      events: [
        actionEvent({ actionIndex: 0, action: "appReset" }),
        actionEvent({ actionIndex: 1, action: "tap", screenshots: { before: true } }),
      ],
      screenshots: { "screenshots/action-001-before.png": solidPng(90, 195) },
    })
    await expect(filmstrip.frames).toHaveCount(2)
    await expect(filmstrip.placeholders).toHaveCount(1)

    // Within 2px: the two boxes use different box-sizing and 1.5px borders
    // rasterise differently, but the bugs this guards against were a 12px
    // overshoot and a collapse to 8px.
    const within2px = (a: number | undefined, b: number | undefined) =>
      expect(Math.abs((a ?? 0) - (b ?? 0))).toBeLessThanOrEqual(2)
    const placeholder = filmstrip.placeholders.first()
    const thumbBox = await filmstrip.frames.nth(1).locator("img").boundingBox()
    const unselected = await placeholder.boundingBox()
    within2px(unselected?.height, thumbBox?.height)
    within2px(unselected?.width, thumbBox?.width)

    await filmstrip.selectFrame(0)
    await expect(placeholder).toHaveClass(/selected/)
    const selected = await placeholder.boundingBox()
    within2px(selected?.width, thumbBox?.width)
  })

  for (const [what, width, height] of [["landscape", 195, 90], ["tablet", 150, 200]] as const) {
    test(`sizes a placeholder frame like its ${what} neighbours, not like a portrait phone`, async ({ viewer, filmstrip }) => {
      await viewer.open({
        events: [
          actionEvent({ actionIndex: 0, action: "appReset" }),
          actionEvent({ actionIndex: 1, action: "tap", screenshots: { before: true } }),
        ],
        screenshots: { "screenshots/action-001-before.png": solidPng(width, height) },
      })
      await expect(filmstrip.placeholders).toHaveCount(1)
      const thumb = filmstrip.frames.nth(1).locator("img")
      await expect.poll(async () => {
        const p = await filmstrip.placeholders.first().boundingBox()
        const t = await thumb.boundingBox()
        return !!p && !!t && Math.abs(p.width - t.width) <= 3 && Math.abs(p.height - t.height) <= 3
      }).toBe(true)
    })
  }

  test("measures offsets from the earliest frame when setup predates the test start", async ({ viewer, filmstrip }) => {
    // The runner replays inherited scope setup (file-entry app reset,
    // beforeAll) into every test's trace; for the second test onwards that
    // setup ran before the test's own start time. Measured from the test
    // start it would read as a negative offset.
    const base = defaultMetadata().startTime
    await viewer.open({
      metadata: { startTime: base + 5_000 },
      events: [
        actionEvent({ actionIndex: 0, action: "appReset" }), // at base
        actionEvent({ actionIndex: 1, action: "tap" }), // at base + 100
      ],
    })
    await expect(filmstrip.labels).toHaveText(["0ms", "100ms"])
  })
})
