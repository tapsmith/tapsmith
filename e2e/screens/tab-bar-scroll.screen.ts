import { Device } from "tapsmith"

/** Lists above a bottom tab bar, each with a row just out of the list's view (PILOT-1370). */
export class TabBarScrollScreen {
  constructor(private device: Device) {}

  get status() { return this.device.getByTestId("tab-bar-scroll-status") }
  get target() { return this.device.getByTestId("tab-bar-scroll-target") }
}
