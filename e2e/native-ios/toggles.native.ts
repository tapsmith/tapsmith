import { describe, expect, openScreen, test } from "./fixtures.js"

describe("Native: toggles and controls", () => {
  test.beforeEach(async ({ device, toggles }) => {
    await openScreen(device, "toggles")
    await expect(toggles.darkMode).toBeVisible()
  })

  test("Toggle state reads through toBeChecked", async ({ toggles }) => {
    await expect(toggles.darkMode).not.toBeChecked()
    await expect(toggles.notifications).toBeChecked()
  })

  // BUG PILOT-790: tap() lands on the centre of the Toggle's row (the label), which a
  // Form Toggle ignores; only the knob flips it. tapXY() near the knob works.
  test.skip("setChecked flips a SwiftUI Toggle both ways", async ({ toggles }) => {
    await toggles.darkMode.setChecked(true)
    await expect(toggles.darkMode).toBeChecked()
    await toggles.darkMode.setChecked(false)
    await expect(toggles.darkMode).not.toBeChecked()
  })

  // BUG PILOT-790: same as above.
  test.skip("tapping a Toggle flips it", async ({ toggles }) => {
    await toggles.notifications.tap()
    await expect(toggles.notifications).not.toBeChecked()
  })

  test("segmented Picker: tap a segment and read selection", async ({ toggles }) => {
    await toggles.sizeSegment("Large").tap()
    await expect(toggles.selectedSize("Large")).toBeVisible()
    await expect(toggles.sizeSegment("Large", { selected: true })).toBeVisible()
  })

  test("Stepper increment button", async ({ toggles }) => {
    await expect(toggles.quantity(1)).toBeVisible()
    await toggles.increment.tap()
    await expect(toggles.quantity(2)).toBeVisible()
  })

  test("a Stepper is a spinbutton (PILOT-702)", async ({ toggles }) => {
    await expect(toggles.stepper).toBeVisible()
    await expect(toggles.stepper).toHaveRole("spinbutton")
    await expect(toggles.stepper).toHaveValue("1")
  })

  test("Slider is found by role", async ({ toggles }) => {
    await toggles.slider.scrollIntoView()
    await expect(toggles.slider).toBeVisible()
    await expect(toggles.slider).toHaveRole("slider")
  })
})
