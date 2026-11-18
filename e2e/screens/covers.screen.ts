import { Device } from "tapsmith"

export class CoversScreen {
  constructor(private device: Device) {}

  get counts() { return this.device.getByTestId("covers-counts") }

  get loadBrieflyButton() { return this.device.getByRole("button", { name: "Load briefly" }) }
  get keepLoadingButton() { return this.device.getByRole("button", { name: "Keep loading" }) }
  get stopLoadingButton() { return this.device.getByRole("button", { name: "Stop loading" }) }

  get behindLoading() { return this.device.getByRole("button", { name: "Behind loading" }) }
  get loadingOverlay() { return this.device.getByTestId("loading-overlay") }
  /** A text field under a second loading overlay, shown with the first. */
  get fieldBehindLoading() { return this.device.getByRole("textfield", { name: "Field behind loading" }) }
}
