import { describe, expect, openScreen, test } from "./fixtures.js"

// getByText reads text content (PILOT-794): a control's value or accessible
// name is not text, and a match that holds another match gives way to it, as
// Playwright returns the innermost element with the text. Each locator here
// is the one a test author would write first.
describe("Native: getByText matches text content", () => {
  test("a Toggle row gives way to its label text", async ({ device, toggles }) => {
    await openScreen(device, "toggles")
    await expect(toggles.darkMode).toBeVisible()
    await expect(device.getByText("Dark Mode", { exact: true })).toHaveCount(1)
    await expect(device.getByText("Dark Mode", { exact: true })).toHaveRole("text")
    await expect(device.getByText("notifications")).toHaveCount(1)
  })

  test("a Stepper's text is its label, not the Stepper or its buttons", async ({ device, toggles }) => {
    await openScreen(device, "toggles")
    await expect(device.getByText(/^Quantity: \d+$/)).toHaveText("Quantity: 1")
    await expect(device.getByText("Quantity: 1", { exact: true })).toHaveCount(1)
    await toggles.increment.tap()
    await expect(device.getByText(/^Quantity: \d+$/)).toHaveText("Quantity: 2")
  })

  test("a control's value is not text", async ({ device, toggles }) => {
    await openScreen(device, "toggles")
    await expect(toggles.notifications).toBeChecked()
    // The switches' "0"/"1", the Stepper's and its buttons' "1", the Slider's "50%".
    await expect(device.getByText("1", { exact: true })).toHaveCount(0)
    await expect(device.getByText("0", { exact: true })).toHaveCount(0)
    await expect(device.getByText("50%", { exact: true })).toHaveCount(0)
    // Its own label text is: "Volume: 50".
    await expect(device.getByText("Volume: 50", { exact: true })).toBeVisible()
  })

  test("a NavigationLink gives way to its text, which taps through", async ({ device, list }) => {
    await openScreen(device, "list")
    await expect(list.item(3)).toBeVisible()
    await expect(device.getByText("Item 3", { exact: true })).toHaveCount(1)
    await device.getByText("Item 3", { exact: true }).tap()
    await expect(list.detail(3)).toBeVisible()
  })

  test("an alert gives way to its title text", async ({ device, dialogs }) => {
    await openScreen(device, "dialogs")
    await dialogs.showAlert.tap()
    await expect(dialogs.alert).toBeVisible()
    await expect(device.getByText("Delete file?", { exact: true })).toHaveCount(1)
    await expect(device.getByText("Delete file?", { exact: true })).toHaveRole("text")
    // Not dialogs.alertCancel: the alert-scoped buttons are not found on
    // main either (see dialogs.native.ts).
    await device.getByRole("button", { name: "Cancel", exact: true }).tap()
    await expect(dialogs.result("Cancelled")).toBeVisible()
  })
})
