import { Device } from "tapsmith"

/** Buttons laid out edge to edge under the system status bar (PILOT-1435). */
export class StatusBarScreen {
  constructor(private device: Device) {}

  get counts() { return this.device.getByTestId("status-bar-counts") }
  /** Wholly inside the status bar's band. */
  get under() { return this.device.getByTestId("status-bar-under") }
  /** Starts inside the band and reaches below it. */
  get partly() { return this.device.getByTestId("status-bar-partly") }
  get hideStatusBar() { return this.device.getByRole("button", { name: "Hide status bar" }) }
  get showStatusBar() { return this.device.getByRole("button", { name: "Show status bar" }) }
}
