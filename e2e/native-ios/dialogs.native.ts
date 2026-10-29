import { describe, expect, openScreen, test } from "./fixtures.js"

describe("Native: alerts, confirmation dialogs and sheets", () => {
  test.beforeEach(async ({ device, dialogs }) => {
    await openScreen(device, "dialogs")
    await expect(dialogs.showAlert).toBeVisible()
  })

  test("alert is found by role and its buttons scoped to it", async ({ dialogs }) => {
    await dialogs.showAlert.tap()
    await expect(dialogs.alert).toBeVisible()
    await expect(dialogs.alertMessage).toBeVisible()
    await dialogs.alertDelete.tap()
    await expect(dialogs.alert).toBeHidden()
    await expect(dialogs.result("Deleted")).toBeVisible()
  })

  test("alert cancel button", async ({ dialogs }) => {
    await dialogs.showAlert.tap()
    await dialogs.alertCancel.tap()
    await expect(dialogs.result("Cancelled")).toBeVisible()
  })

  // Tapped straight away, while the iOS 26 popover is still animating in: tap() must
  // wait for the button to stop changing on screen first, or the touch highlights it
  // without firing its action (PILOT-791).
  test("confirmation dialog action", async ({ dialogs }) => {
    await dialogs.showConfirmation.tap()
    await dialogs.copyLink.tap()
    await expect(dialogs.result("Copied")).toBeVisible()
  })

  test("sheet opens and its toolbar button closes it", async ({ dialogs }) => {
    await dialogs.showSheet.tap()
    await expect(dialogs.sheetContent).toBeVisible()
    await dialogs.sheetDone.tap()
    await expect(dialogs.sheetContent).toBeHidden()
    await expect(dialogs.result("Sheet closed")).toBeVisible()
  })

  // docs/locators.md: XCUITest shows an open Menu's items as buttons (PILOT-702).
  test("an open Menu's items are buttons", async ({ dialogs }) => {
    await dialogs.actionsMenu.tap()
    await expect(dialogs.menuItem("Rename")).toBeVisible()
    await expect(dialogs.menuItem("Duplicate")).toBeVisible()
  })

  test("a button behind the sheet is not visible", async ({ dialogs }) => {
    await dialogs.showSheet.tap()
    await expect(dialogs.sheetContent).toBeVisible()
    await expect(dialogs.showAlert).not.toBeVisible()
  })
})
