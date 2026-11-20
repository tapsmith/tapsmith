import { Device, expect } from "tapsmith"

/** The test app's runtime-permissions screen. */
export class PermissionsScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByRole("header", { name: "Permissions" }) }
  /** Reads the camera permission without prompting. */
  get checkCameraButton() { return this.device.getByRole("button", { name: "Check camera permission" }) }
  /** The camera card, labelled with the status last read ("granted", "undetermined"…). */
  cameraStatus(status: string) { return this.device.getByLabel(`Camera permission: ${status}`) }

  async open() {
    await this.device.openDeepLink("tapsmithtest:///permissions")
    await expect(this.heading).toBeVisible()
  }
}
