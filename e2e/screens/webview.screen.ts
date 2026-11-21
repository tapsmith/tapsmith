import { Device } from "tapsmith"

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
