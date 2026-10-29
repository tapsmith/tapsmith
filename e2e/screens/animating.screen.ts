import { Device } from "tapsmith"

export class AnimatingScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Creating your story", { exact: true }) }
  get status() { return this.device.getByText("Generating illustration", { exact: true }) }
  get stoppedStatus() { return this.device.getByText("Stopped", { exact: true }) }
  get stopButton() { return this.device.getByRole("button", { name: "Stop generation" }) }
  get backButton() { return this.device.getByRole("button", { name: "Go back" }) }
  /**
   * RN's ActivityIndicator, the screen's only progress indicator: a
   * progressbar on both platforms (PILOT-797). Its testID sits on a wrapper
   * view on iOS, so find it by role.
   */
  get progress() { return this.device.getByRole("progressbar").first() }
}
