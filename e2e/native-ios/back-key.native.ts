import { describe, expect, openScreen, test } from "./fixtures.js"

// PILOT-1225: iOS has no back key, so pressKey("BACK") taps the navigation
// stack's own back button (UIKit's "BackButton", in UIKit and SwiftUI stacks
// alike). A screen without one refuses: it used to tap the first button in
// the navigation bar instead (an Edit, a sheet's Done) and report success.
describe("Native: the BACK key", () => {
  test("pops a pushed SwiftUI screen", async ({ device, home, toggles }) => {
    await openScreen(device, "toggles")
    await expect(toggles.darkMode).toBeVisible()
    await device.pressKey("BACK")
    await expect(home.title).toBeVisible()
  })

  test("pops a screen pushed in a presented SwiftUI stack", async ({ device, backKey }) => {
    await openScreen(device, "backkey")
    await backKey.openSwiftUIStack.tap()
    await backKey.openSwiftUIDetail.tap()
    await expect(backKey.swiftUIDetail).toBeVisible()
    await device.pressKey("BACK")
    await expect(backKey.openSwiftUIDetail).toBeVisible()
    await expect(backKey.swiftUIDetail).toBeHidden()
  })

  test("pops a screen pushed on a UIKit navigation controller", async ({ device, backKey }) => {
    await openScreen(device, "backkey")
    await backKey.openUIKitStack.tap()
    await backKey.openUIKitDetail.tap()
    await expect(backKey.uikitDetail).toBeVisible()
    await device.pressKey("BACK")
    await expect(backKey.openUIKitDetail).toBeVisible()
    await expect(backKey.uikitDetail).toBeHidden()
  })

  test("refuses on a SwiftUI stack's root and leaves its Edit button alone", async ({ device, backKey }) => {
    await openScreen(device, "backkey")
    await backKey.openSwiftUIStack.tap()
    await expect(backKey.swiftUIRoot).toBeVisible()
    const error = await device.pressKey("BACK").catch((err: unknown) => err)
    expect(String(error)).toContain("No back button found")
    await expect(backKey.edit).toBeVisible()
    await expect(backKey.done).toBeHidden()
  })

  test("refuses on a UIKit navigation controller's root and leaves its Edit button alone", async ({ device, backKey }) => {
    await openScreen(device, "backkey")
    await backKey.openUIKitStack.tap()
    await expect(backKey.uikitEditing).toBeVisible()
    const error = await device.pressKey("BACK").catch((err: unknown) => err)
    expect(String(error)).toContain("No back button found")
    await expect(backKey.uikitEditing).toBeVisible()
    await expect(backKey.edit).toBeVisible()
  })

  test("refuses on a sheet and leaves its Done button alone", async ({ device, dialogs }) => {
    await openScreen(device, "dialogs")
    await dialogs.showSheet.tap()
    await expect(dialogs.sheetContent).toBeVisible()
    const error = await device.pressKey("BACK").catch((err: unknown) => err)
    expect(String(error)).toContain("No back button found")
    await expect(dialogs.sheetContent).toBeVisible()
    await expect(dialogs.sheetDone).toBeVisible()
  })

  test("refuses under an alert and leaves the screen where it is", async ({ device, dialogs }) => {
    await openScreen(device, "dialogs")
    await dialogs.showAlert.tap()
    await expect(dialogs.alert).toBeVisible()
    // A native alert hides the screen behind it from the tree, back button
    // and all (iOS 26.5 and 27.2). An alert whose app stays in the tree (React
    // Native's) refuses as "covered by alert" instead (BackButtonTests).
    const error = await device.pressKey("BACK").catch((err: unknown) => err)
    expect(String(error)).toContain("No back button found")
    await expect(dialogs.alert).toBeVisible()
    await dialogs.alertCancel.tap()
    await expect(dialogs.showAlert).toBeVisible()
  })

  test("a push tapped just before BACK is popped", async ({ device, home, toggles }) => {
    await openScreen(device, "")
    await expect(home.title).toBeVisible()
    await home.row("Toggles").tap()
    await device.pressKey("BACK")
    await expect(home.title).toBeVisible()
    await expect(toggles.darkMode).toBeHidden()
  })
})
