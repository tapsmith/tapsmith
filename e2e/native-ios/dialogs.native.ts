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

  // BUG PILOT-791: the tap lands while the iOS 26 popover is still animating in — the
  // button highlights but its action never fires (4/4). Waiting ~1.5s first
  // makes it pass. tap() needs a stability check before it touches.
  test.skip("confirmation dialog action", async ({ dialogs }) => {
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

  test("a button behind the sheet is not visible", async ({ dialogs }) => {
    await dialogs.showSheet.tap()
    await expect(dialogs.sheetContent).toBeVisible()
    await expect(dialogs.showAlert).not.toBeVisible()
  })
})
