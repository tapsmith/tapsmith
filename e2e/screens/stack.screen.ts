import { Device } from "tapsmith"

/** A screen on every level of a native stack (PILOT-985). */
export class StackScreen {
  constructor(private device: Device) {}

  get back() { return this.device.getByTestId("stack-back") }
  get push() { return this.device.getByTestId("stack-push") }
  get level() { return this.device.getByTestId("stack-level") }
}
