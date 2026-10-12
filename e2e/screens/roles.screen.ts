import { Device } from "tapsmith"

export class RolesScreen {
  constructor(private device: Device) {}

  get status() { return this.device.getByTestId("roles-status") }

  // React Native generic-view roles (PILOT-664)
  get menuItems() { return this.device.getByRole("menuitem") }
  menuItem(name: string) { return this.device.getByRole("menuitem", { name }) }
  get elapsedTimer() { return this.device.getByRole("timer", { name: "Elapsed time" }) }
  get orderSummary() { return this.device.getByRole("summary", { name: "Order summary" }) }
  get quantitySpinButton() { return this.device.getByRole("spinbutton", { name: "Quantity" }) }

  // accessibilityRole="togglebutton" is a button on both platforms
  get boldToggle() { return this.device.getByRole("button", { name: "Bold" }) }
}
