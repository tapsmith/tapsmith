import type { WebViewHandle } from "tapsmith"

/** The test app's /webview-shadow page: web components with shadow roots. */
export class WebViewShadowScreen {
  constructor(private webview: WebViewHandle) {}

  /** The <button> inside x-button's open shadow root, named by slotted text. */
  get saveDraftButton() { return this.webview.getByRole("button", { name: "Save draft" }) }
  /** The <input> inside x-field's shadow root, labelled by a <label for> there. */
  get displayNameField() { return this.webview.getByRole("textfield", { name: "Display name" }) }
  get displayNameByPlaceholder() { return this.webview.getByPlaceholder("Your display name") }
  get displayNameByTestId() { return this.webview.getByTestId("display-name-input") }
  /** x-icon-button moves its host aria-label onto the inner button, as Ionic does. */
  get dismissButton() { return this.webview.getByLabel("Dismiss banner") }
  /** Every <button>: the light DOM has none, two are in open shadow roots, one in a closed root. */
  get allButtons() { return this.webview.locator("button") }
  get nativeButtons() { return this.webview.locator("button.button-native") }
  /** Only inside x-closed-button's closed shadow root. */
  get hiddenAction() { return this.webview.getByText("Hidden action") }
  get status() { return this.webview.locator("#shadow-status") }
}
