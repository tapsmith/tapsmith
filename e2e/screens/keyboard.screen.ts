import { Device } from "tapsmith"

export class KeyboardScreen {
  constructor(private device: Device) {}

  get plainInput() { return this.device.getByRole("textfield", { name: "Plain input" }) }
  get goInput() { return this.device.getByRole("textfield", { name: "Go input" }) }
  /** iOS exposes a multiline field as a text view (no placeholder). */
  get multilineInput() { return this.device.getByTestId("keyboard-multiline-input") }
  /** The multiline field by its role, a textfield on both platforms (PILOT-697). */
  get multilineInputByRole() { return this.device.getByRole("textfield", { name: "Multiline input" }) }
  /** The multiline field by its label. */
  get multilineInputByLabel() { return this.device.getByLabel("Multiline input") }
  /** Every text field on the screen: plain, go and multiline ("Done input" shows only on request). */
  get textFields() { return this.device.getByRole("textfield") }
  /** A field whose return key is "done", beside the app's own "Done" button (PILOT-756). */
  get doneInput() { return this.device.getByRole("textfield", { name: "Done input" }) }
  get doneButton() { return this.device.getByRole("button", { name: "Done", exact: true }) }
  get doneText() { return this.device.getByText("Done", { exact: true }) }
  get doneDescription() { return this.device.getByDescription("Done") }
  /** How many times the app's "Done" button was tapped (`done=<n>`). */
  get doneTaps() { return this.device.getByTestId("keyboard-done-taps") }
  get counts() { return this.device.getByTestId("keyboard-counts") }
  /** How many drags began on the scroll view (only with "Put in scroll view"). */
  get drags() { return this.device.getByTestId("keyboard-drags") }
  get dismissOnBackgroundTapButton() { return this.device.getByRole("button", { name: "Dismiss on background tap" }) }
  get putInScrollViewButton() { return this.device.getByRole("button", { name: "Put in scroll view" }) }
  get centreAction() { return this.device.getByRole("button", { name: "Centre action" }) }

  /** Focus `field` and type into it, so its keyboard is up. */
  async openKeyboard(field: "plain" | "go" | "multiline" | "done") {
    const input = {
      plain: this.plainInput,
      go: this.goInput,
      multiline: this.multilineInput,
      done: this.doneInput,
    }[field]
    await input.tap()
    await input.type("a")
  }
}
