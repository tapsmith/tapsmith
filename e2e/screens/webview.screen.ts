import type { Device, WebViewHandle } from "tapsmith"

export class WebViewScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Embedded WebView", { exact: true }) }
  /** The page's heading, as the native accessibility tree shows it: the page has loaded. */
  get pageHeading() { return this.device.getByText("WebView Test Page", { exact: true }) }
  /** The page's Login button, through the native accessibility tree. */
  get nativeLoginButton() { return this.device.getByRole("button", { name: "Login" }) }
  /** Opens https://example.com in an in-app browser (expo-web-browser). */
  get openInAppBrowserButton() { return this.device.getByRole("button", { name: "Open in-app browser" }) }
  /**
   * The in-app browser's close button (SFSafariViewController's Done) while
   * the browser is up; the screen's own Done button otherwise.
   */
  get inAppBrowserDoneButton() { return this.device.getByRole("button", { name: "Done", exact: true }) }
}

/** The test app's /webview page, inside the WebView. */
export class WebViewPage {
  constructor(private webview: WebViewHandle) {}

  /** The email <input>, by its <label for="email">. */
  get emailByLabel() { return this.webview.getByLabel("Email") }
  /** The same <input>, by Playwright's ARIA role and its label as its name. */
  get emailTextbox() { return this.webview.getByRole("textbox", { name: "Email", exact: true }) }
  get passwordByLabel() { return this.webview.getByLabel("Password") }
}
