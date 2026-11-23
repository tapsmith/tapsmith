import { Device } from "tapsmith"

export class TogglesScreen {
  constructor(private device: Device) {}

  // Section headings
  get switchesHeading() { return this.device.getByText("Switches", { exact: true }) }

  // Switches
  get darkModeSwitch() { return this.device.getByRole("switch", { name: "Dark Mode" }) }
  get notificationsSwitch() { return this.device.getByRole("switch", { name: "Notifications" }) }

  // Checkboxes
  get agreeCheckbox() { return this.device.getByRole("checkbox", { name: "I agree to terms" }) }

  // Radio buttons
  get radioSmall() { return this.device.getByRole("radiobutton", { name: "Small" }) }
  get radioMedium() { return this.device.getByRole("radiobutton", { name: "Medium" }) }
  get radioLarge() { return this.device.getByRole("radiobutton", { name: "Large" }) }
  get largeByLabel() { return this.device.getByLabel("Large") }
  get smallLabel() { return this.device.getByText("Small", { exact: true }) }
  get mediumLabel() { return this.device.getByText("Medium", { exact: true }) }
  get largeLabel() { return this.device.getByText("Large", { exact: true }) }
}
