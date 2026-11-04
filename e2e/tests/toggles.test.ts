import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

describe("Toggles screen", () => {
  // Tests toggle persisted state and scroll the screen; the beforeEach
  // asserts a clean top-of-screen, so reset before every test.
  test.use({ appResetScope: "test" })

  test.beforeEach(async ({ device, togglesScreen }) => {
    await openScreen(device, "/toggles")
    await expect(togglesScreen.switchesHeading).toBeVisible()
  })

  // ─── Switches ───

  test("dark mode switch starts unchecked", async ({ togglesScreen }) => {
    await expect(togglesScreen.darkModeSwitch).not.toBeChecked()
  })

  test("notifications switch starts checked", async ({ togglesScreen }) => {
    await expect(togglesScreen.notificationsSwitch).toBeChecked()
  })

  test("setChecked() can turn dark mode on and off", async ({ togglesScreen }) => {
    await togglesScreen.darkModeSwitch.setChecked(true)
    await expect(togglesScreen.darkModeSwitch).toBeChecked()

    await togglesScreen.darkModeSwitch.setChecked(false)
    await expect(togglesScreen.darkModeSwitch).not.toBeChecked()
  })

  test("tap() lands on the switch after rotating to landscape", async ({ device, togglesScreen }) => {
    // The switch sits at the right of its row, so a touch mapped as if the
    // screen were still portrait would miss it.
    await device.setOrientation("landscape")
    try {
      await expect(togglesScreen.darkModeSwitch).toBeVisible()
      await togglesScreen.darkModeSwitch.tap()
      await expect(togglesScreen.darkModeSwitch).toBeChecked()
    } finally {
      await device.setOrientation("portrait")
    }
  })

  test("isChecked() returns current state", async ({ togglesScreen }) => {
    const checked = await togglesScreen.notificationsSwitch.isChecked()
    expect(checked).toBe(true)
  })

  // ─── Checkboxes ───

  test("agree checkbox starts unchecked", async ({ togglesScreen }) => {
    await expect(togglesScreen.agreeCheckbox).not.toBeChecked()
  })

  test("tapping checkbox toggles its state", async ({ togglesScreen }) => {
    await togglesScreen.agreeCheckbox.tap()
    await expect(togglesScreen.agreeCheckbox).toBeChecked()

    await togglesScreen.agreeCheckbox.tap()
    await expect(togglesScreen.agreeCheckbox).not.toBeChecked()
  })

  // ─── Radio Buttons ───

  test("radio buttons are visible", async ({ device, togglesScreen }) => {
    await device.swipe("up")
    await expect(togglesScreen.smallLabel).toBeVisible()
    await expect(togglesScreen.mediumLabel).toBeVisible()
    await expect(togglesScreen.largeLabel).toBeVisible()
  })

  test("tapping small selects it", async ({ device, togglesScreen }) => {
    await device.swipe("up")
    await togglesScreen.radioSmall.tap()
    await expect(togglesScreen.radioSmall).toBeChecked()
  })
})
