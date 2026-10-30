import { describe, expect, openScreen, test } from "./fixtures.js"
import { expectSoftwareKeyboardShown } from "../utils/software-keyboard.js"

// UIKit mirrors of the SwiftUI tests: the same interactions against hosted
// UIKit view controllers, to tell SwiftUI-only bugs from all-native ones.

describe("UIKit: controls", () => {
  test.beforeEach(async ({ device, uikitControls }) => {
    await openScreen(device, "uikitcontrols")
    await expect(uikitControls.wifi).toBeVisible()
  })

  test("labelled UISwitch: setChecked both ways", async ({ uikitControls }) => {
    await uikitControls.wifi.setChecked(true)
    await expect(uikitControls.wifi).toBeChecked()
    await expect(uikitControls.status("Wi-Fi: on")).toBeVisible()
    await uikitControls.wifi.setChecked(false)
    await expect(uikitControls.wifi).not.toBeChecked()
  })

  test("unlabelled UISwitch: tap flips it", async ({ uikitControls }) => {
    await expect(uikitControls.bluetooth).toBeChecked()
    await uikitControls.bluetooth.tap()
    await expect(uikitControls.status("Bluetooth: off")).toBeVisible()
  })

  test("UISegmentedControl: tap a segment", async ({ uikitControls }) => {
    await uikitControls.segment("Large").tap()
    await expect(uikitControls.status("Size: Large")).toBeVisible()
    await expect(uikitControls.segment("Large", { selected: true })).toBeVisible()
  })

  test("UIStepper increment", async ({ uikitControls }) => {
    await uikitControls.increment.tap()
    await expect(uikitControls.count(1)).toBeVisible()
  })

  test("a UIStepper is a spinbutton (PILOT-702)", async ({ uikitControls }) => {
    await expect(uikitControls.stepper).toHaveCount(1)
    await expect(uikitControls.stepper).toHaveRole("spinbutton")
  })

  test("UIButton tap", async ({ uikitControls }) => {
    await uikitControls.submit.tap()
    await expect(uikitControls.status("Submitted")).toBeVisible()
  })

  test("getByText on a label beside an unlabelled switch is unique", async ({ device }) => {
    await expect(device.getByText("Bluetooth", { exact: true })).toHaveCount(1)
  })
})

describe("UIKit: table view", () => {
  test.beforeEach(async ({ device, uikitTable }) => {
    await openScreen(device, "uikittable")
    await expect(uikitTable.rowText(1)).toBeVisible()
  })

  test("tapping a cell selects it", async ({ uikitTable }) => {
    await uikitTable.rowText(3).tap()
    await expect(uikitTable.selection).toHaveText("Selected: Row 3")
  })

  test("a full swipe left deletes a row", async ({ device, uikitTable }) => {
    const box = await uikitTable.rowText(2).boundingBox()
    if (!box) throw new Error("Row 2 has no bounds")
    const y = box.y + box.height / 2
    await device.dragXY({ x: 380, y }, { x: 20, y })
    await expect(uikitTable.rowText(2)).toBeHidden()
    await expect(uikitTable.rowText(3)).toBeVisible()
  })

  // UITableView exposes every row; one with no loaded cell reports its
  // contents at a placeholder frame on screen (PILOT-800).
  test("an off-screen row is not visible, and is placed below the screen", async ({ uikitTable }) => {
    await expect(uikitTable.rowText(80)).toHaveCount(1)
    await expect(uikitTable.rowText(80)).not.toBeVisible()
    const first = await uikitTable.rowText(1).boundingBox()
    const far = await uikitTable.rowText(80).boundingBox()
    if (!first || !far) throw new Error("a row has no bounds")
    expect(far.y).toBeGreaterThan(first.y + 70 * first.height)
  })

  test("tap() refuses an off-screen row instead of tapping its placeholder", async ({ uikitTable }) => {
    const error = await uikitTable.rowText(80).tap({ timeout: 1_000 }).catch((err: unknown) => err)
    expect(String(error)).toContain("is off-screen")
    await expect(uikitTable.selection).toHaveText("Nothing selected")
  })

  // Last: it leaves the table scrolled.
  test("scrollIntoView reaches a reused cell far down, and back up", async ({ uikitTable }) => {
    await uikitTable.rowText(80).scrollIntoView({ maxScrolls: 30 })
    await uikitTable.rowText(80).tap()
    // Row 1 is now unloaded, above the screen; the selection label is the
    // table's header, scrolled away with it.
    await expect(uikitTable.rowText(1)).not.toBeVisible()
    await uikitTable.rowText(1).scrollIntoView({ direction: "up", maxScrolls: 30 })
    await expect(uikitTable.selection).toHaveText("Selected: Row 80")
  })
})

describe("UIKit: UIAlertController", () => {
  test.beforeEach(async ({ device, uikitDialogs }) => {
    await openScreen(device, "uikitdialogs")
    await expect(uikitDialogs.showAlert).toBeVisible()
  })

  test("alert action", async ({ uikitDialogs }) => {
    await uikitDialogs.showAlert.tap()
    await expect(uikitDialogs.alert).toBeVisible()
    await expect(uikitDialogs.anyAlert).toHaveCount(1)
    await uikitDialogs.remove.tap()
    await expect(uikitDialogs.result("Removed")).toBeVisible()
  })

  // Tapped while the popover is still animating in (PILOT-791).
  test("action sheet action, tapped straight away", async ({ uikitDialogs }) => {
    await uikitDialogs.showSheet.tap()
    await uikitDialogs.exportPdf.tap()
    await expect(uikitDialogs.result("PDF")).toBeVisible()
  })
})

describe("UIKit: keyboard", () => {
  test.beforeEach(async ({ device, uikitKeyboard }) => {
    await openScreen(device, "uikitkeyboard")
    await expect(uikitKeyboard.city).toBeVisible()
  })

  test("return key fires textFieldShouldReturn", async ({ device, uikitKeyboard }) => {
    await uikitKeyboard.city.type("Leeds")
    await device.pressKey("enter")
    await expect(uikitKeyboard.entered("Leeds")).toBeVisible()
  })

  test("hideKeyboard dismisses it", async ({ device, uikitKeyboard }) => {
    await uikitKeyboard.city.tap()
    await expectSoftwareKeyboardShown(device)
    await device.hideKeyboard()
    expect(await device.isKeyboardShown()).toBe(false)
  })

  test("UITextView takes text", async ({ uikitKeyboard }) => {
    await uikitKeyboard.notes.type("hello")
    await expect(uikitKeyboard.notes).toHaveValue("hello")
  })
})

describe("UIKit: gestures", () => {
  test.beforeEach(async ({ device, uikitGestures }) => {
    await openScreen(device, "uikitgestures")
    await expect(uikitGestures.status("Waiting")).toBeVisible()
  })

  test("UITapGestureRecognizer with two taps", async ({ uikitGestures }) => {
    await uikitGestures.doubleTapTarget.doubleTap()
    await expect(uikitGestures.status("Double tapped")).toBeVisible()
  })

  test("UILongPressGestureRecognizer", async ({ uikitGestures }) => {
    await uikitGestures.longPressTarget.longPress(1200)
    await expect(uikitGestures.status("Long pressed")).toBeVisible()
  })

  // PILOT-825: a real two-finger pinch that a UIPinchGestureRecognizer reads.
  test("UIPinchGestureRecognizer pinching in", async ({ uikitGestures }) => {
    await uikitGestures.pinchTarget.pinchIn({ scale: 0.4 })
    await expect(uikitGestures.status("Pinched in")).toBeVisible()
  })

  test("UIPinchGestureRecognizer pinching out", async ({ uikitGestures }) => {
    await uikitGestures.pinchTarget.pinchOut({ scale: 2.5 })
    await expect(uikitGestures.status("Pinched out")).toBeVisible()
  })
})
