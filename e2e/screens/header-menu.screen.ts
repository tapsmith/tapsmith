import { Device } from "tapsmith"

/**
 * Bottom tabs under a header with a button at each end and a text field
 * between them, and a second text field below the tabs (header-menu route).
 */
export class HeaderMenuScreen {
  constructor(private device: Device) {}

  /** "Menu <n>, add <m>": how often each header button fired. */
  get status() { return this.device.getByTestId("header-menu-status") }
  /** "Search “<text>”, note “<text>”": what each text field holds. */
  get fields() { return this.device.getByTestId("header-menu-fields") }
  get content() { return this.device.getByTestId("header-menu-content") }
  /** Every button, in tree order: the header's two, then the tab bar's. */
  get buttons() { return this.device.getByRole("button") }
  /** Both text fields, in tree order: the header's, then the one below the tabs. */
  get textFields() { return this.device.getByRole("textfield") }

  /** How often each header button has fired so far. */
  async taps(): Promise<{ menu: number; add: number }> {
    const match = /^Menu (\d+), add (\d+)$/.exec(await this.status.getText())
    if (!match) throw new Error("header-menu-status has an unexpected text")
    return { menu: Number(match[1]), add: Number(match[2]) }
  }
}
