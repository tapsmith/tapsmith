import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// A React Native checkbox or radio is a CheckBox or RadioButton on Android
// and a generic view on iOS, described in its value ("checkbox, unchecked").
// The same locator lines find it on both: getByLabel by its
// accessibilityLabel, getByText the text beside it alone.

describe("a checkbox beside its row's text", () => {
  test.use({ appResetScope: "test", appResetRoute: "/checklist" })

  test.beforeEach(async ({ checklistScreen }) => {
    await expect(checklistScreen.status).toHaveText("Done: 0 of 2")
  })

  test("getByLabel finds the checkbox, and taps it", async ({ checklistScreen }) => {
    await expect(checklistScreen.checkbox("Buy oat milk")).not.toBeChecked()
    await checklistScreen.checkbox("Buy oat milk").tap()
    await expect(checklistScreen.checkbox("Buy oat milk")).toBeChecked()
    await expect(checklistScreen.checkbox("Walk the dog")).not.toBeChecked()
    await expect(checklistScreen.status).toHaveText("Done: 1 of 2")
  })

  test("getByText finds the row's text, not the checkbox named after it", async ({ checklistScreen }) => {
    await expect(checklistScreen.taskText("Buy oat milk")).toHaveCount(1)
    await expect(checklistScreen.taskText("Buy oat milk")).toHaveRole("text")
    await expect(checklistScreen.taskText("Walk the dog")).toBeVisible()
  })

  test("a switch-role Pressable is found by its label, and its text beside it", async ({ checklistScreen }) => {
    await checklistScreen.remindSwitch.tap()
    await expect(checklistScreen.remindSwitch).toBeChecked()
    await expect(checklistScreen.remindText).toHaveCount(1)
    await expect(checklistScreen.status).toHaveText("Done: 0 of 2, reminders on")
  })
})

describe("a radio button whose text is inside it", () => {
  test("getByLabel finds it, and getByText its text", async ({ device, togglesScreen }) => {
    await openScreen(device, "/toggles")
    await device.swipe("up")
    await expect(device.getByLabel("Large")).not.toBeChecked()
    await device.getByLabel("Large").tap()
    await expect(device.getByLabel("Large")).toBeChecked()
    // React Native hides the radio's own text inside it on iOS, so its
    // label is the text there: getByText still finds it.
    await expect(togglesScreen.largeLabel).toBeVisible()
  })
})
