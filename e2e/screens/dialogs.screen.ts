import { Device } from "tapsmith"

export class DialogsScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Dialogs & Overlays", { exact: true }) }

  // Alerts (React Native's Alert.alert: a native alert on both platforms)
  get showAlertButton() { return this.device.getByRole("button", { name: "Show alert" }) }
  get alertOk() { return this.device.getByRole("button", { name: "OK", exact: true }) }
  /** The "Show alert" alert, by its title. On iOS a native alert is the alert role (PILOT-919). */
  get infoAlert() { return this.device.getByRole("alert", { name: "Info" }) }
  get anyAlert() { return this.device.getByRole("alert") }
  get infoAlertOk() { return this.infoAlert.getByRole("button", { name: "OK", exact: true }) }
  get showConfirmButton() { return this.device.getByRole("button", { name: "Show confirm dialog" }) }
  get confirmAlert() { return this.device.getByRole("alert", { name: "Confirm" }) }
  /** Every button in the "Confirm" alert — not the app's buttons behind it (PILOT-862). */
  get confirmAlertButtons() { return this.confirmAlert.getByRole("button") }
  get confirmAlertCancel() { return this.confirmAlert.getByRole("button", { name: "Cancel", exact: true }) }
  get confirmResult() { return this.device.getByTestId("confirm-result") }

  // Toast
  get showToastButton() { return this.device.getByRole("button", { name: "Show toast" }) }
  get showErrorToastButton() { return this.device.getByRole("button", { name: "Show error toast" }) }
  get toastSuccess() { return this.device.getByText("Item saved successfully!", { exact: true }) }
  get toastError() { return this.device.getByText("Something went wrong", { exact: true }) }

  // Snackbar
  get showSnackbarButton() { return this.device.getByRole("button", { name: "Show snackbar" }) }
  get snackbar() { return this.device.getByText("Message archived") }
  get snackbarMessage() { return this.device.getByText("Message archived", { exact: true }) }
  get snackbarDismiss() { return this.device.getByRole("button", { name: "Dismiss" }) }

  // Modal
  get showModalButton() { return this.device.getByRole("button", { name: "Show modal" }) }
  get modal() { return this.device.getByText("Modal Title") }
  get modalContainer() { return this.device.getByTestId("modal") }
  get modalTitle() { return this.device.getByText("Modal Title", { exact: true }) }
  get cancelButton() { return this.device.getByRole("button", { name: "Cancel" }) }
  get confirmButton() { return this.device.getByRole("button", { name: "Confirm" }) }
  get confirmedToast() { return this.device.getByText("Action confirmed!", { exact: true }) }

  // Sheet: a scrolling sheet over a backdrop that closes it (PILOT-934)
  get showSheetButton() { return this.device.getByRole("button", { name: "Show sheet" }) }
  get sheetTitle() { return this.device.getByText("Sheet Title", { exact: true }) }
  sheetItem(n: number) { return this.device.getByText(`Sheet item ${n}`, { exact: true }) }
}
