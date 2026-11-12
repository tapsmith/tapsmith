import { Device } from "tapsmith"

export class ProfileScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Profile", { exact: true }).first() }
  get status() { return this.device.getByTestId("profile-status") }
  /** How many resets in this app process kept the restored data (0 after a cold launch). */
  get reloadCount() { return this.device.getByTestId("profile-reload-count") }
  get logOutButton() { return this.device.getByRole("button", { name: "Log out" }) }
}
