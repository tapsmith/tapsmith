import { Device } from "tapsmith"

export class OcclusionScreen {
  constructor(private device: Device) {}

  // Role names are case-insensitive substrings by default, as in Playwright, so
  // a name that is part of another button's ("Overlay" / "Show overlay
  // briefly", "Cover input" / "Uncover input") needs exact: true.

  get input() { return this.device.getByRole("textfield", { name: "Occlusion input" }) }
  get counts() { return this.device.getByTestId("occlusion-counts") }

  get makeTallButton() { return this.device.getByRole("button", { name: "Make bottom action tall" }) }
  get showOverlayButton() { return this.device.getByRole("button", { name: "Show overlay", exact: true }) }
  get showOverlayBrieflyButton() { return this.device.getByRole("button", { name: "Show overlay briefly" }) }
  get makeInputTallButton() { return this.device.getByRole("button", { name: "Make bottom input tall" }) }
  get avoidKeyboardButton() { return this.device.getByRole("button", { name: "Avoid keyboard" }) }
  get coverAndReplaceButton() { return this.device.getByRole("button", { name: "Cover and replace" }) }
  get coverInputButton() { return this.device.getByRole("button", { name: "Cover input", exact: true }) }

  get bottomAction() { return this.device.getByRole("button", { name: "Bottom action", exact: true }) }
  get tallBottomAction() { return this.device.getByRole("button", { name: "Tall bottom action" }) }
  get coveredAction() { return this.device.getByRole("button", { name: "Covered action" }) }
  get replacementAction() { return this.device.getByRole("button", { name: "Replacement action" }) }
  get bottomInput() { return this.device.getByRole("textfield", { name: "Bottom input" }) }
  /** The top input by placeholder — a selector shape the iOS agent builds no live query for. */
  get inputByPlaceholder() { return this.device.getByPlaceholder("Type to open the keyboard") }
  get overlay() { return this.device.getByRole("button", { name: "Overlay", exact: true }) }
  get inputCover() { return this.device.getByRole("button", { name: "Input cover" }) }
  get passThroughAction() { return this.device.getByRole("button", { name: "Pass-through action" }) }
  get termsLink() { return this.device.getByRole("link", { name: "terms" }) }
  /** An empty wrapper View with the testID, its touch surface laid inside it as a sibling. */
  get headerMenuButton() { return this.device.getByTestId("header-menu-button") }
  get headerMenu() { return this.device.getByTestId("header-menu") }

  /** Focus the input so the software keyboard covers the bottom of the screen. */
  async openKeyboard() {
    await this.input.tap()
    await this.input.type("x")
  }
}
