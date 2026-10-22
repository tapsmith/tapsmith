import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

describe("Dialogs screen", () => {
  test.beforeEach(async ({ device, dialogsScreen }) => {
    await openScreen(device, "/dialogs")
    await expect(dialogsScreen.heading).toBeVisible()
  })

  // ─── Toast ───

  test("tapping show toast displays a toast", async ({ dialogsScreen }) => {
    await dialogsScreen.showToastButton.tap()
    await expect(dialogsScreen.toastSuccess).toBeVisible()
  })

  test("error toast shows error message", async ({ dialogsScreen }) => {
    await dialogsScreen.showErrorToastButton.tap()
    await expect(dialogsScreen.toastError).toBeVisible()
  })

  // ─── Snackbar ───

  test("can show and dismiss snackbar", async ({ dialogsScreen }) => {
    await dialogsScreen.showSnackbarButton.tap()
    await expect(dialogsScreen.snackbarMessage).toBeVisible()
    await expect(dialogsScreen.snackbarDismiss).toBeVisible()

    await dialogsScreen.snackbarDismiss.tap()
    await expect(dialogsScreen.snackbar).not.toBeVisible()
  })

  // ─── Modal ───

  test("can show and cancel modal", async ({ dialogsScreen }) => {
    await dialogsScreen.showModalButton.tap()
    await expect(dialogsScreen.modalTitle).toBeVisible()
    await expect(dialogsScreen.cancelButton).toBeVisible()
    await expect(dialogsScreen.confirmButton).toBeVisible()

    await dialogsScreen.cancelButton.tap()
    await expect(dialogsScreen.modal).not.toBeVisible()
  })

  // ─── Scoping off a parent handle (Playwright-style chaining) ───
  //
  // `getBy*`/`locator()` on a handle — plain or carrying a positional or
  // filtering modifier (`.first()`, `.filter()`, …) — resolves the parent to
  // its concrete element(s) and keeps the children inside their bounds
  // (PILOT-850). React Native's accessibility tree makes the modal's buttons
  // siblings of its testID view, so bounds, not the tree, define "inside".

  test("scopes a child off a positional (.first()) parent and acts on it", async ({ dialogsScreen, device }) => {
    await dialogsScreen.showModalButton.tap()
    await expect(dialogsScreen.modalTitle).toBeVisible()

    // `.first()` makes this a modified handle — scoping was previously rejected.
    await device.getByTestId("modal").first().getByRole("button", { name: "Confirm" }).tap()

    // Confirm dismisses the modal and fires its success toast.
    await expect(dialogsScreen.modal).not.toBeVisible()
    await expect(dialogsScreen.confirmedToast).toBeVisible()
  })

  test("scopes a child off a filtered parent", async ({ dialogsScreen, device }) => {
    await dialogsScreen.showModalButton.tap()
    await expect(dialogsScreen.modalTitle).toBeVisible()

    // Parent carries a `.filter({ has })` modifier; the child resolves within it.
    const scopedCancel = device
      .getByTestId("modal")
      .filter({ has: dialogsScreen.modalTitle })
      .getByRole("button", { name: "Cancel" })

    await expect(scopedCancel).toBeVisible()
    await scopedCancel.tap()
    await expect(dialogsScreen.modal).not.toBeVisible()
  })

  test("scopes a child off a plain parent and acts on it (PILOT-850)", async ({ dialogsScreen, device }) => {
    await dialogsScreen.showModalButton.tap()
    await expect(dialogsScreen.modalTitle).toBeVisible()

    // A parent with no modifier is resolved and scoped the same way.
    const cancel = device.getByTestId("modal").getByRole("button", { name: "Cancel" })
    await expect(cancel).toHaveCount(1)
    await cancel.tap()
    await expect(dialogsScreen.modal).not.toBeVisible()
  })

  test("a chained getter does not match its parent (PILOT-850)", async ({ dialogsScreen, device }) => {
    await dialogsScreen.showModalButton.tap()
    await expect(dialogsScreen.modalTitle).toBeVisible()
    await expect(dialogsScreen.modalContainer).toHaveCount(1)
    await expect(device.getByTestId("modal").getByTestId("modal")).toHaveCount(0)
  })
})
