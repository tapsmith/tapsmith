import { describe, expect, test } from "tapsmith"

// The macOS slice's acceptance suite, against test-app-macos.

describe("macOS test app", () => {
  // Clear the app's data and relaunch before every test.
  test.use({ appResetScope: "test" })

  test("taps, types, toggles and saves", async ({ device }) => {
    // Whatever the app had saved before the run is cleared for it.
    await expect(device.getByTestId("savedCountLabel")).toHaveText("Saved: 0")

    await device.getByTestId("incrementButton").tap()
    await expect(device.getByTestId("countLabel")).toHaveText("Count: 1")
    await device.getByTestId("saveButton").tap()
    await expect(device.getByTestId("savedCountLabel")).toHaveText("Saved: 1")

    await device.getByTestId("nameField").clearAndType("Ada")
    await expect(device.getByTestId("greeting")).toHaveText("Hello, Ada")

    const agree = device.getByRole("checkbox", { name: "I agree" })
    await expect(agree).not.toBeChecked()
    await agree.tap()
    await expect(agree).toBeChecked()
    await expect(device.getByTestId("agreeState")).toHaveText("Agreed")
  })

  test("starts each test from the app's initial state, saved data too", async ({ device }) => {
    // The previous test counted to 1 and saved it: the reset clears both.
    await expect(device.getByTestId("countLabel")).toHaveText("Count: 0")
    await expect(device.getByTestId("greeting")).toHaveText("Hello, nobody")
    await expect(device.getByTestId("savedCountLabel")).toHaveText("Saved: 0")
  })

  test("an absent element is not visible", async ({ device }) => {
    // The not-found path must time out cleanly, never fail as an internal error.
    await expect(device.getByTestId("doesNotExist")).not.toBeVisible()
  })
})
