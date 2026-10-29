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

  test("setChecked flips a SwiftUI Toggle both ways", async ({ toggles }) => {
    await toggles.darkMode.setChecked(true)
    await expect(toggles.darkMode).toBeChecked()
    await toggles.darkMode.setChecked(false)
    await expect(toggles.darkMode).not.toBeChecked()
  })

  test("tapping a Toggle flips it", async ({ toggles }) => {
    await toggles.notifications.tap()
    await expect(toggles.notifications).not.toBeChecked()
  })

  test("setChecked flips a Toggle found by its label", async ({ toggles }) => {
    await toggles.labelled("Dark Mode").setChecked(true)
    await expect(toggles.darkMode).toBeChecked()
  })

  // A SwiftUI Toggle is a row-sized switch holding an unlabelled switch, its
  // knob: one control, found once and tapped on the knob (PILOT-790).
  test("each Toggle is one switch", async ({ toggles }) => {
    await expect(toggles.switches()).toHaveCount(2)
    await expect(toggles.switches({ checked: true })).toHaveCount(1)
  })

  test("nth() by role alone taps the right Toggle", async ({ toggles }) => {
    await toggles.switches().nth(1).tap()
    await expect(toggles.notifications).not.toBeChecked()
    await expect(toggles.darkMode).not.toBeChecked()
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
