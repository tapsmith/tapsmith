import { Device } from "tapsmith"

export class KeyboardScreen {
  constructor(private device: Device) {}

  get plainInput() { return this.device.getByRole("textfield", { name: "Plain input" }) }
  get goInput() { return this.device.getByRole("textfield", { name: "Go input" }) }
  /** iOS exposes a multiline field as a text view (no textfield role, no placeholder). */
  get multilineInput() { return this.device.getByTestId("keyboard-multiline-input") }
  get counts() { return this.device.getByTestId("keyboard-counts") }
  /** How many drags began on the scroll view (only with "Put in scroll view"). */
  get drags() { return this.device.getByTestId("keyboard-drags") }
  get dismissOnBackgroundTapButton() { return this.device.getByRole("button", { name: "Dismiss on background tap" }) }
  get putInScrollViewButton() { return this.device.getByRole("button", { name: "Put in scroll view" }) }
  get centreAction() { return this.device.getByRole("button", { name: "Centre action" }) }

  /** Focus `field` and type into it, so its keyboard is up. */
  async openKeyboard(field: "plain" | "go" | "multiline") {
    const input = field === "plain" ? this.plainInput : field === "go" ? this.goInput : this.multilineInput
    await input.tap()
    await input.type("a")
  }
}
