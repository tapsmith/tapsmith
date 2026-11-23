import { Device, expect } from "tapsmith"

/** The test app's runtime-permissions screen. */
export class PermissionsScreen {
  constructor(private device: Device) {}

  // The title shows twice on iOS (the navigation bar's and the page's own
  // heading); this is a screen-arrival check, so either match proves it.
  get heading() { return this.device.getByRole("header", { name: "Permissions" }).first() }
  /** Reads the camera permission without prompting. */
  get checkCameraButton() { return this.device.getByRole("button", { name: "Check camera permission" }) }
  /** The camera status last read ("unknown", "granted", "undetermined"…). */
  get cameraStatus() { return this.device.getByTestId("camera-status") }
  /** Asks for location access: iOS shows its permission alert when it is undetermined. */
  get requestLocationButton() { return this.device.getByRole("button", { name: "Request location permission" }) }
  /** The location status last read ("unknown", "granted", "denied"…). */
  get locationStatus() { return this.device.getByTestId("location-status") }

  async open() {
    await this.device.openDeepLink("tapsmithtest:///permissions")
    await expect(this.heading).toBeVisible()
  }
}
