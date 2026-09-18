# WebView Testing

Tapsmith supports testing hybrid apps that embed web content inside native shells. When your app renders a WebView, Tapsmith connects to it via Chrome DevTools Protocol (CDP) on Android or WebKit Inspector on iOS, giving you a Playwright-style API for interacting with the web content directly.

## When to Use WebView Testing

Use WebView testing when your app renders web content inside a native container:

- **Login and authentication screens** served by an OAuth provider or identity service inside an embedded browser.
- **Payment flows** rendered by Stripe, Braintree, or similar providers in a WebView.
- **In-app browsers** opened via Android Custom Tabs or iOS `SFSafariViewController` / `WKWebView`.
- **Cordova / Ionic / Capacitor apps** where the entire UI is web-based but wrapped in a native shell.
- **React Native WebView components** used to embed specific web pages or forms within an otherwise native app.

If your app is fully native, you do not need this. Stick with the standard [Locators Guide](locators.md) and native locators.

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

On iOS, Tapsmith connects via the simulator's WebKit Inspector protocol directly. No additional tooling or browser setup is required.

## Switching to WebView Context

To interact with web content, switch from the native context to the WebView context:

```typescript
const webview = await device.webview()
```

This auto-waits for a WebView to appear on screen. If no debuggable WebView is found within the timeout, it throws an error.

If your app has multiple WebViews or you need to target a specific one, pass the package name (Android) or bundle identifier (iOS):

```typescript
const webview = await device.webview("com.example.myapp")
```

You can also pass a custom timeout:

```typescript
const webview = await device.webview({ timeout: 60_000 })
```

## Switching Back to Native

When you are done interacting with the WebView and need to interact with native UI again, switch back:

```typescript
await device.native()
```

This closes the WebView connection. After calling `native()`, all subsequent `device.getByText()`, `device.getByRole()`, and other native locator calls work as usual.

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
```

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

All assertions support `.not` for negation and a `{ timeout }` option:

```typescript
await expect(webview.locator(".error")).not.toBeVisible()
await expect(webview.locator(".results")).toBeVisible({ timeout: 15_000 })
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

## Tips and Limitations

**The WebView must be visible and loaded.** `device.webview()` auto-waits for a debuggable WebView to become available, but the WebView needs to be on screen and its content needs to have started loading. If your WebView takes a long time to appear (for example, behind a native loading screen), increase the timeout:

```typescript
const webview = await device.webview({ timeout: 60_000 })
```

**Debugging must be enabled in the app.** On Android, `WebView.setWebContentsDebuggingEnabled(true)` must be called before the WebView is created. On iOS (16.4+), the `WKWebView` must have `isInspectable = true`. Without these, Tapsmith cannot connect and `device.webview()` will time out.

**One WebView connection at a time.** Calling `device.webview()` connects to a single WebView. If your app has multiple WebViews on screen, pass the package/bundle identifier to target the right one. Call `device.native()` before switching to a different WebView.

**Parallel workers get independent connections.** When running with multiple workers, each worker establishes its own CDP (Android) or WebKit Inspector (iOS) connection to its device's WebView. There are no shared-state concerns between workers.

**CSS selectors and `getBy*` locators.** WebView interactions use standard CSS selectors (`webview.locator(css)`) or the Playwright-style `webview.getByText/getByRole/getByPlaceholder/getByTestId/getByLabel` methods. Use `webview.getByTestId(...)` (matching `data-testid`) as your escape hatch, just as you would in Playwright web tests.

**`device.native()` closes the connection.** After calling `device.native()`, the WebView connection is torn down. If you need to interact with the WebView again, call `device.webview()` again to establish a new connection.

**Cross-platform selector consistency.** Because WebView content is rendered by a web engine (Chromium on Android, WebKit on iOS), the same CSS selectors work on both platforms. This makes WebView tests inherently cross-platform, unlike native locators which can differ between Android and iOS.

## Further Reading

- [API Reference](api-reference.md) -- full method signatures and options.
- [Locators Guide](locators.md) -- choosing the right locators for native UI.
- [Configuration](configuration.md) -- global timeout and project settings.
