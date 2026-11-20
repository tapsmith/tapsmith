import { Device } from "tapsmith"

/**
 * The test app's native Android Views settings screen (Android only), opened
 * by deep link. Its rows have androidx Preference's shape: a clickable row
 * holding the title and summary, with an unnamed, unfocusable switch or
 * checkbox in its widget frame.
 */
export class NativeSettingsScreen {
  static readonly deepLink = "tapsmithnative://settings"

  constructor(private device: Device) {}

  async open() {
    await this.device.openDeepLink(NativeSettingsScreen.deepLink)
    await this.device.getByText("Native settings", { exact: true }).waitFor()
  }

  get fullBlack() { return this.device.getByRole("switch", { name: "Full black" }) }
  get fullBlackByLabel() { return this.device.getByLabel("Full black") }
  get dynamicColors() { return this.device.getByRole("switch", { name: "Dynamic colors" }) }
  get wifiOnly() { return this.device.getByRole("checkbox", { name: "Download on Wi-Fi only" }) }
  get wifiOnlyByLabel() { return this.device.getByLabel("Download on Wi-Fi only") }
  /** A switch TalkBack focuses on its own: its row does not name it. */
  get syncNowByName() { return this.device.getByRole("switch", { name: "Sync now" }) }
  get switches() { return this.device.getByRole("switch") }
  get rows() { return this.device.getByRole("listitem") }
  row(title: string) { return this.rows.filter({ hasText: title }) }
  status(text: string) { return this.device.getByText(text) }
}
