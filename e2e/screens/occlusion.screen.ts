import { Device } from "tapsmith"

export class OcclusionScreen {
  constructor(private device: Device) {}

  get input() { return this.device.getByRole("textfield", { name: "Occlusion input" }) }
  get counts() { return this.device.getByTestId("occlusion-counts") }

  get makeTallButton() { return this.device.getByRole("button", { name: "Make bottom action tall" }) }
  get showOverlayButton() { return this.device.getByRole("button", { name: "Show overlay" }) }
  get showOverlayBrieflyButton() { return this.device.getByRole("button", { name: "Show overlay briefly" }) }

  get bottomAction() { return this.device.getByRole("button", { name: "Bottom action" }) }
  get tallBottomAction() { return this.device.getByRole("button", { name: "Tall bottom action" }) }
  get coveredAction() { return this.device.getByRole("button", { name: "Covered action" }) }
  get overlay() { return this.device.getByRole("button", { name: "Overlay" }) }
  get passThroughAction() { return this.device.getByRole("button", { name: "Pass-through action" }) }
  get termsLink() { return this.device.getByRole("link", { name: "terms" }) }

  /** Focus the input so the software keyboard covers the bottom of the screen. */
  async openKeyboard() {
    await this.input.tap()
    await this.input.type("x")
  }
}
