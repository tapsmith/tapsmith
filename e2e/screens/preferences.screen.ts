import { Device, expect } from "tapsmith"

/** The test app's UserDefaults screen (`Settings` from react-native; iOS only). */
export class PreferencesScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByRole("header", { name: "Preferences" }) }
  get input() { return this.device.getByTestId("preferences-input") }
  get saveButton() { return this.device.getByTestId("preferences-save-button") }
  get loadButton() { return this.device.getByTestId("preferences-load-button") }
  /** The value last loaded, or "(empty)". */
  get value() { return this.device.getByTestId("preferences-value") }
  get status() { return this.device.getByTestId("preferences-status") }

  async open() {
    await this.device.openDeepLink("tapsmithtest:///preferences")
    await expect(this.heading).toBeVisible()
  }

  async save(text: string) {
    await this.input.clearAndType(text)
    await this.device.hideKeyboard()
    await this.saveButton.tap()
    await expect(this.status).toHaveText("Saved")
  }

  /** Read the value the app's UserDefaults held when it started (or since saved). */
  async load() {
    await this.loadButton.tap()
    await expect(this.status).toHaveText("Loaded")
  }
}
