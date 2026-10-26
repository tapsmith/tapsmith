import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// getByText reads text content (PILOT-794), as Playwright does: a control's
// accessible name or value is not text, and an element that holds a matching
// element gives way to it. On iOS a switch is labelled like the text beside
// it, a switch's value is "0"/"1", and a native alert is labelled with its
// title text — none of which getByText now matches twice. Android already
// read only the text, so the same locators find the same elements there.
describe("getByText matches text content", () => {
  test("a switch labelled like the text beside it isn't that text", async ({ device, togglesScreen }) => {
    await openScreen(device, "/toggles")
    await expect(togglesScreen.darkModeSwitch).toBeVisible()
    await expect(device.getByText("Dark Mode", { exact: true })).toHaveCount(1)
    await expect(device.getByText("Dark Mode", { exact: true })).toHaveRole("text")
  })

  test("a switch's value isn't text", async ({ device, togglesScreen }) => {
    await openScreen(device, "/toggles")
    await expect(togglesScreen.notificationsSwitch).toBeChecked()
    await expect(togglesScreen.darkModeSwitch).not.toBeChecked()
    await expect(device.getByText("1", { exact: true })).toHaveCount(0)
    await expect(device.getByText("0", { exact: true })).toHaveCount(0)
  })

  test("an accessibilityValue isn't text", async ({ device, accessibilityScreen }) => {
    await openScreen(device, "/accessibility")
    await expect(accessibilityScreen.uploadProgress).toHaveCount(1)
    await expect(device.getByText("65%", { exact: true })).toHaveCount(0)
  })

  test("a native alert gives way to its title text", async ({ device, dialogsScreen }) => {
    await openScreen(device, "/dialogs")
    await dialogsScreen.showAlertButton.tap()
    await expect(dialogsScreen.alertOk).toBeVisible()
    await expect(device.getByText("Info", { exact: true })).toHaveCount(1)
    await expect(device.getByText("Info", { exact: true })).toHaveRole("text")
    await dialogsScreen.alertOk.tap()
    await expect(dialogsScreen.alertOk).toBeHidden()
  })
})
