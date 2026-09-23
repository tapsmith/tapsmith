import { Device } from "tapsmith"

export class OcclusionScreen {
  constructor(private device: Device) {}

  get input() { return this.device.getByRole("textfield", { name: "Occlusion input" }) }
  get counts() { return this.device.getByTestId("occlusion-counts") }

  get makeTallButton() { return this.device.getByRole("button", { name: "Make bottom action tall" }) }
  get showOverlayButton() { return this.device.getByRole("button", { name: "Show overlay" }) }
  get showOverlayBrieflyButton() { return this.device.getByRole("button", { name: "Show overlay briefly" }) }
  get makeInputTallButton() { return this.device.getByRole("button", { name: "Make bottom input tall" }) }
  get avoidKeyboardButton() { return this.device.getByRole("button", { name: "Avoid keyboard" }) }
  get coverAndReplaceButton() { return this.device.getByRole("button", { name: "Cover and replace" }) }

  get bottomAction() { return this.device.getByRole("button", { name: "Bottom action" }) }
  get tallBottomAction() { return this.device.getByRole("button", { name: "Tall bottom action" }) }
  get coveredAction() { return this.device.getByRole("button", { name: "Covered action" }) }
  get replacementAction() { return this.device.getByRole("button", { name: "Replacement action" }) }
  get bottomInput() { return this.device.getByRole("textfield", { name: "Bottom input" }) }
  /** The top input by placeholder — a selector shape the iOS agent builds no live query for. */
  get inputByPlaceholder() { return this.device.getByPlaceholder("Type to open the keyboard") }
  get overlay() { return this.device.getByRole("button", { name: "Overlay" }) }
  get passThroughAction() { return this.device.getByRole("button", { name: "Pass-through action" }) }
  get termsLink() { return this.device.getByRole("link", { name: "terms" }) }

  /** Focus the input so the software keyboard covers the bottom of the screen. */
  async openKeyboard() {
    await this.input.tap()
    await this.input.type("x")
  }

  /**
   * Put the keyboard away by submitting the focused single-line input, which
   * blurs it. (Not hideKeyboard(): on iOS it relies on a scroll view to
   * dismiss into, and this screen has none.)
   */
  async submitInput() {
    await this.device.pressKey("enter")
  }
}
