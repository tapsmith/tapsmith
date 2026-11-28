# WebView Testing

Tapsmith supports testing hybrid apps that embed web content inside native shells. When your app renders a WebView, Tapsmith connects to it via Chrome DevTools Protocol (CDP) on Android or WebKit Inspector on iOS, giving you a Playwright-style API for interacting with the web content directly.

## When to Use WebView Testing

Use WebView testing when your app renders web content inside a native container:

- **Login and authentication screens** served by an OAuth provider or identity service inside an embedded browser.
- **Payment flows** rendered by Stripe, Braintree, or similar providers in a WebView.
- **In-app browsers** built on a `WKWebView` of the app's own. A system in-app browser (iOS `SFSafariViewController`, Android Custom Tabs) is not a WebView of the app: test it with native locators ([In-app browsers](#in-app-browsers)).
- **Cordova / Ionic / Capacitor apps** where the entire UI is web-based but wrapped in a native shell.
- **React Native WebView components** used to embed specific web pages or forms within an otherwise native app.

If your app is fully native, you do not need this. Stick with the standard [Locators Guide](locators.md) and native locators.

## In-app browsers

A link that opens in the system's in-app browser — `expo-web-browser`'s `openBrowserAsync()` (the `ExternalLink` in the `create-expo-app` template), `SFSafariViewController` on iOS, a Custom Tab on Android — shows a browser that another process draws over your app. Its controls are native elements, so close it with an ordinary locator:

```typescript
const explore = device.getByRole("tab", { name: "Explore" })
await device.getByText("Expo documentation").tap()   // opens the in-app browser
await expect(explore).toBeHidden()                     // the browser covers the app
if (device.platform === "ios") {
  await device.getByRole("button", { name: "Done", exact: true }).tap()
} else {
  await device.pressBack()   // a Custom Tab is another app's window
}
await expect(explore).toBeVisible()
```

On iOS, while a full-screen browser is up (`expo-web-browser`'s default presentation) it covers the app: the app's own screen is not in the hierarchy, so its locators do not match, and what locators, the trace viewer and the MCP snapshot see is the browser — its Done button, address bar and the page's accessibility elements. A locator for text the page shows too (often the link's own text) can match the page, so check the app's screen with something only the app shows, such as a tab. The page is not a WebView of your app: `device.webview()` does not reach it. iOS 26 and later leave the browser out of the app's accessibility snapshot; Tapsmith reads it in from the browser itself, which adds a fraction of a second to each lookup while the browser is up.

## Prerequisites

### Android

The app under test must enable WebView debugging. Without this, CDP cannot attach to the WebView process.

**Native Android apps** -- call this in your `Application.onCreate()` or before the WebView is created:

```java
WebView.setWebContentsDebuggingEnabled(true);
```

**React Native apps using `react-native-webview`** -- set the `webviewDebuggingEnabled` prop:

```tsx
<WebView
  source={{ uri: "https://example.com" }}
  webviewDebuggingEnabled={true}
/>
```

**Flutter apps using `webview_flutter`** -- enable debugging on the platform controller, through the `webview_flutter_android` package:

```dart
import 'package:flutter/foundation.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

if (kDebugMode) {
  AndroidWebViewController.enableDebugging(true);
}
```

**Capacitor apps** -- Debug builds are debuggable by default (`android.webContentsDebuggingEnabled` in `capacitor.config.ts` controls it). See [Capacitor / Ionic](#capacitor--ionic).

This flag is typically enabled in debug builds and disabled in production. No other Android-side configuration is needed -- Tapsmith discovers debuggable WebViews automatically via ADB.

### iOS

Since iOS 16.4, `WKWebView` instances are not inspectable by default. Your app must opt in.

**Native iOS apps** -- set `isInspectable` on the `WKWebView` instance:

```swift
let webView = WKWebView(frame: .zero, configuration: config)
#if DEBUG
webView.isInspectable = true
#endif
```

**React Native apps using `react-native-webview`** -- set the `webviewDebuggingEnabled` prop (same as Android):

```tsx
<WebView
  source={{ uri: "https://example.com" }}
  webviewDebuggingEnabled={true}
/>
```

**Flutter apps using `webview_flutter`** -- make the controller's web view inspectable, through the `webview_flutter_wkwebview` package:

```dart
import 'package:flutter/foundation.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

final controller = WebViewController();
final platform = controller.platform;
if (kDebugMode && platform is WebKitWebViewController) {
  platform.setInspectable(true);
}
```

**Capacitor apps** -- Debug builds are inspectable by default (`ios.webContentsDebuggingEnabled` in `capacitor.config.ts` controls it).

On iOS, Tapsmith connects via the simulator's WebKit Inspector protocol directly. No additional tooling or browser setup is required. `device.webview()` works on iOS simulators only: on a physical iPhone or iPad it cannot connect, so test the page there with native locators.

Tapsmith finds your app's WebView by its bundle identifier. A simulator build made with code signing turned off (`xcodebuild … CODE_SIGNING_ALLOWED=NO`, common in CI recipes) has none as far as the WebKit Inspector is concerned: it lists the app as `process-<executable name>`. Tapsmith then matches the app by the process ID it runs under on the simulator, so such builds work too. If the connect still times out, the error names the apps that had inspectable pages, and says when one of them had no bundle identifier.

## Switching to WebView Context

To interact with web content, switch from the native context to the WebView context:

```typescript
const webview = await device.webview()
```

This auto-waits for a WebView to appear on screen. If no debuggable WebView is found within the action timeout (the config's `timeout`, 30 s by default, or a `test.use({ timeout })` around the test), it throws an error.

By default Tapsmith looks for a WebView of the app your config's `package` names. On iOS, when no inspectable page of that app is found, Tapsmith connects to the newest app that has one (Mobile Safari, say), so make sure the app's own WebView is inspectable and loaded. To connect to a WebView of another app, pass its package name (Android) or bundle identifier (iOS):

```typescript
const webview = await device.webview("com.example.myapp")
```

When the app has several pages open (several WebViews, say), Tapsmith connects to one of them (on Android, the first page the debugger lists), and there is no option yet to pick another.

## Switching Back to Native

When you are done interacting with the WebView and need to interact with native UI again, switch back:

```typescript
await device.native()
```

This leaves the WebView context; the connection stays open, and the next `device.webview()` reuses it. After calling `native()`, all subsequent `device.getByText()`, `device.getByRole()`, and other native locator calls work as usual.

## WebView Actions

All WebView actions use **CSS selectors** and auto-wait for the target element to appear in the DOM before acting. If the element is not found within the timeout, the action throws.

### `webview.click(selector)`

Click an element.

```typescript
await webview.click("#submit-button")
await webview.click("button.primary")
await webview.click("[data-testid='login']")
```

### `webview.fill(selector, value)`

Clear an input and type a new value. Dispatches both `input` and `change` events, matching how a real user would fill the field.

```typescript
await webview.fill("#email", "user@example.com")
await webview.fill("input[name='password']", "secret123")
```

### `webview.textContent(selector)`

Read the text content of an element.

```typescript
const message = await webview.textContent(".status-message")
```

### `webview.innerHTML(selector)`

Read the inner HTML of an element.

```typescript
const html = await webview.innerHTML(".rendered-content")
```

### `webview.inputValue(selector)`

Read the current value of an input, textarea, or select element.

```typescript
const email = await webview.inputValue("#email")
```

### `webview.getAttribute(selector, name)`

Read an attribute value from an element.

```typescript
const href = await webview.getAttribute("a.terms-link", "href")
const disabled = await webview.getAttribute("#submit", "disabled")
```

### `webview.isVisible(selector)`

Check whether an element is visible. Returns `false` if the element is not rendered at all (no layout boxes — including when an ancestor has `display: none`), or has `display: none`, `visibility: hidden`, or `opacity: 0`.

```typescript
const visible = await webview.isVisible(".error-banner")
```

### `webview.isHidden(selector)`

The opposite of `isVisible(selector)`: `true` when nothing matches the selector or the match is not visible. One DOM read, no auto-wait — use it to branch on the current state, and `expect(locator).not.toBeVisible()` to wait for something to disappear.

```typescript
if (await webview.isHidden(".cookie-banner")) {
  // nothing to dismiss
}
```

### `webview.evaluate<T>(expression)`

Execute arbitrary JavaScript in the WebView and return the result.

```typescript
const title = await webview.evaluate<string>("document.title")
const count = await webview.evaluate<number>("document.querySelectorAll('.item').length")

// Complex expressions
await webview.evaluate("window.scrollTo(0, document.body.scrollHeight)")
```

### `webview.goto(url)`

Navigate the WebView to a new URL.

```typescript
await webview.goto("https://example.com/checkout")
```

### `webview.title()`

Read the current page title.

```typescript
const title = await webview.title()
```

### `webview.url()`

Read the current page URL.

```typescript
const url = await webview.url()
```

## WebView Locators

For reusable element references, create a locator with a CSS selector:

```typescript
const submitButton = webview.locator("#submit-button")
const emailInput = webview.locator("input[type='email']")
const errorMessage = webview.locator(".error-message")
```

Playwright-style locators are also available for common attributes:

```typescript
await webview.getByRole("button", { name: "Login" }).click()
await webview.getByPlaceholder("Enter your email").fill("user@test.com")
await expect(webview.getByText("Welcome back")).toBeVisible()
await expect(webview.getByTestId("status")).toHaveText("Ready")
await expect(webview.getByLabel("Close dialog")).toBeVisible()
await webview.getByRole("textbox", { name: "Email" }).fill("user@test.com")
```

`getByRole` and `getByLabel` follow Playwright's rules, so a locator from a Playwright web test of the same pages finds the same element: roles are ARIA roles (`textbox`, `searchbox`, `checkbox`, …, plus Tapsmith's `textfield`), names follow the accessible name computation, and `getByLabel` reads `<label for>`, a wrapping `<label>`, `aria-labelledby` and `aria-label`. A `name` or label is a case-insensitive substring unless you pass `exact: true`. See [Roles and names](api-reference.md#webviewgetbytexttext-options-and-friends) in the API reference.

Locators also find elements inside open shadow roots, as Playwright's do, so they work on Ionic, Stencil, Lit and Shoelace components: `webview.getByRole("button", { name: "Sign in" })` finds the native `<button>` inside `<ion-button>Sign in</ion-button>`. Closed shadow roots stay out of reach, and a CSS selector's combinators don't cross a shadow boundary (`webview.locator("button")` finds the button inside an `ion-button`, `webview.locator("ion-button button")` does not). See [Shadow DOM](api-reference.md#webviewgetbytexttext-options-and-friends) in the API reference.

A `WebViewLocator` supports the same actions as the direct methods:

```typescript
await submitButton.click()
await emailInput.fill("user@test.com")

const text = await errorMessage.textContent()
const html = await errorMessage.innerHTML()
const value = await emailInput.inputValue()
const href = await webview.locator("a.link").getAttribute("href")
const visible = await errorMessage.isVisible()
const hidden = await errorMessage.isHidden() // true when absent or not visible
```

Locators are lazy -- no queries are made until you call an action or pass the locator to `expect()`.

WebView locators are **strict**, like native locators: an action, single-element query, or positive assertion on a locator that matches more than one DOM element throws a `StrictModeViolationError` listing the matches. Narrow with `.first()`, `.last()`, or `.nth(index)`, or enumerate matches with `.count()` and `.all()`:

```typescript
const rows = webview.locator("li.result")
await rows.first().click()          // positional chains are exempt from strict mode
console.log(await rows.count())     // multi-element queries too
for (const row of await rows.all()) {
  console.log(await row.textContent())
}
```

See [Strict mode](api-reference.md#strict-mode) in the API reference for the full rules.

## WebView Assertions

Pass a `WebViewLocator` to `expect()` for auto-waiting assertions. These poll until the condition is met or the timeout expires.

### `toBeVisible()` / `toBeHidden()`

Assert that an element is visible or hidden.

```typescript
await expect(webview.locator(".welcome-banner")).toBeVisible()
await expect(webview.locator(".loading-spinner")).toBeHidden()
```

### `toHaveText(text)` / `toContainText(text)`

Assert that an element has exact text content, or contains a substring.

```typescript
await expect(webview.locator("h1")).toHaveText("Payment Complete")
await expect(webview.locator(".status")).toContainText("Success")
```

### `toExist()`

Assert that an element exists in the DOM (regardless of visibility).

```typescript
await expect(webview.locator("meta[name='csrf-token']")).toExist()
```

### `toHaveValue(value)`

Assert that an input has a specific value.

```typescript
await expect(webview.locator("#email")).toHaveValue("user@test.com")
```

### `toHaveAttribute(name, value)`

Assert that an element has an attribute with the expected value.

```typescript
await expect(webview.locator("#submit")).toHaveAttribute("disabled", "true")
await expect(webview.locator("form")).toHaveAttribute("action", "/api/login")
```

### Negation and custom timeouts

All assertions support `.not` for negation and a `{ timeout }` option. `toBeVisible` also takes `{ visible: false }`, which asserts the element is hidden, like `toBeHidden()`. Any other option throws a `TypeError` rather than being ignored:

```typescript
await expect(webview.locator(".error")).not.toBeVisible()
await expect(webview.locator(".results")).toBeVisible({ timeout: 15_000 })
await expect(webview.locator(".banner")).toBeVisible({ visible: isLoggedIn })
```

## Complete Example

This test navigates to a screen containing a WebView login form, fills it out, submits, verifies the result in the WebView, then switches back to native to confirm the app updated.

```typescript
import { test, expect } from "tapsmith"

test("complete WebView login flow", async ({ device }) => {
  // Tap a native button that opens a WebView-based login screen
  await device.getByText("Open Login").tap()

  // Switch to the WebView context (auto-waits for it to appear)
  const webview = await device.webview()

  // Fill out the login form using CSS selectors
  await webview.fill("#email", "user@test.com")
  await webview.fill("#password", "secret123")
  await webview.click("#login-button")

  // Verify the success message appears in the WebView
  await expect(webview.locator(".success-message")).toBeVisible()

  // Switch back to native context
  await device.native()

  // Verify the native app updated after the WebView login
  await expect(device.getByText("Welcome back")).toBeVisible()
})
```

Here is a more involved example testing a payment flow with multiple assertions:

```typescript
import { test, expect } from "tapsmith"

test("in-app payment via WebView", async ({ device }) => {
  await device.getByRole("button", { name: "Upgrade to Pro" }).tap()

  const webview = await device.webview()

  // Verify we landed on the right page
  await expect(webview.locator("h1")).toHaveText("Complete Your Purchase")

  // Fill payment details
  await webview.fill("#card-number", "4242424242424242")
  await webview.fill("#expiry", "12/28")
  await webview.fill("#cvc", "123")
  await webview.click("#pay-now")

  // Wait for confirmation (payment processing can be slow)
  await expect(webview.locator(".confirmation")).toBeVisible({ timeout: 15_000 })
  await expect(webview.locator(".confirmation")).toContainText("Payment successful")

  // Return to native app
  await device.native()
  await expect(device.getByText("Pro Member")).toBeVisible()
})
```

## Capacitor / Ionic

A Capacitor app (Ionic included) is a native shell around one WebView, so it is tested like any other hybrid app. Build the web app, copy it into the native project, then build the native app. On Android:

```bash
npm run build            # your framework's web build: ng build, ionic build, vite build, …
npx cap sync android
(cd android && ./gradlew assembleDebug)
# writes android/app/build/outputs/apk/debug/app-debug.apk
```

A debug build's WebView is debuggable without any change (see [Prerequisites](#prerequisites)), so `device.webview()` connects to it. On Android the page's accessibility tree is also part of the native hierarchy, so native locators (`device.getByText()`, `device.getByRole()`) find its text and controls too; use `device.webview()` when you want CSS selectors, DOM values or `webview.evaluate()`. Ionic closes the topmost overlay (an `ion-modal`, an action sheet) on the Android back button, so `device.pressBack()` dismisses it; in a Capacitor app Ionic needs `@capacitor/app` installed to receive the back button.

## Tips and Limitations

**The WebView must be visible and loaded.** `device.webview()` auto-waits for a debuggable WebView to become available, but the WebView needs to be on screen and its content needs to have started loading. `device.webview()` takes no timeout option: it waits up to the action timeout. If your WebView takes a long time to appear (for example, behind a native loading screen), raise the timeout for the tests that need it:

```typescript
describe("checkout", () => {
  test.use({ timeout: 60_000 })

  test("pays by card", async ({ device }) => {
    const webview = await device.webview()
    // …
  })
})
```

`test.use({ timeout })` raises every action and assertion timeout in its scope. To raise only the wait for the screen, wait for the native screen that hosts the WebView first, with an assertion that takes its own timeout, then connect: `await expect(device.getByText("Checkout")).toBeVisible({ timeout: 60_000 })`.

**Debugging must be enabled in the app.** On Android, `WebView.setWebContentsDebuggingEnabled(true)` must be called before the WebView is created. On iOS (16.4+), the `WKWebView` must have `isInspectable = true`. Without these, Tapsmith cannot connect and `device.webview()` will time out. On Android, the timeout error lists the WebViews it did find, so a WebView that is debuggable but belongs to another app shows up there. On iOS, Tapsmith connects to another app's inspectable page instead, when one is open (see above).

**One WebView connection at a time.** Calling `device.webview()` connects to a single WebView, and later calls return that same connection while it is alive (in later tests of the file too, until the app is relaunched), whatever package they name.

**Parallel workers get independent connections.** When running with multiple workers, each worker establishes its own CDP (Android) or WebKit Inspector (iOS) connection to its device's WebView. There are no shared-state concerns between workers.

**CSS selectors and `getBy*` locators.** WebView interactions use standard CSS selectors (`webview.locator(css)`) or the Playwright-style `webview.getByText/getByRole/getByPlaceholder/getByTestId/getByLabel` methods. Use `webview.getByTestId(...)` (matching `data-testid`) as your escape hatch, just as you would in Playwright web tests.

**`device.native()` keeps the connection.** After calling `device.native()`, the WebView connection stays open. Call `device.webview()` again to get back to the WebView: it reuses that connection while it is alive, and connects again if the page has gone. `webview.close()` closes it; Tapsmith also closes it when it relaunches the app (`device.restartApp()`, or an app reset other than a warm one) and at the end of the test file.

**Cross-platform selector consistency.** Because WebView content is rendered by a web engine (Chromium on Android, WebKit on iOS), the same CSS selectors work on both platforms. This makes WebView tests inherently cross-platform, unlike native locators which can differ between Android and iOS.

## Further Reading

- [API Reference](api-reference.md) -- full method signatures and options.
- [Locators Guide](locators.md) -- choosing the right locators for native UI.
- [Configuration](configuration.md) -- global timeout and project settings.
