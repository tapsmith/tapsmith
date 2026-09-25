# API Reference

Complete reference for all public APIs in the `tapsmith` package.

## Locators

Locators identify UI elements on the device. They are exposed as Playwright-style `getBy*` methods on `Device` and `ElementHandle`. Each method returns an `ElementHandle` — a lazy reference that resolves when an action or assertion runs against it.

See the [Locators Guide](locators.md) for a deeper discussion of when to use each one.

### `device.getByText(text: string, options?: { exact?: boolean }): ElementHandle`

Locate an element by its visible text. **Substring match by default**, like Playwright. Pass `{ exact: true }` for an exact match.

```typescript
device.getByText("Welcome")                          // substring
device.getByText("Sign In", { exact: true })         // exact
```

> Because the default is a substring match, `getByText("Sign in")` also matches longer text like `"Sign in to continue"`. When that happens, acting on the locator throws a [strict mode](#strict-mode) violation — add `{ exact: true }` or use `getByRole(role, { name })` to pin a single element.

### `device.getByRole(role: string, options?): ElementHandle`

Locate an element by its accessibility role, optionally filtered by accessible name or state.

```typescript
device.getByRole("button", { name: "Submit" })
device.getByRole("textfield", { name: "Email" })
device.getByRole("checkbox")
device.getByRole("switch", { name: "Dark Mode", checked: true })
device.getByRole("button", { name: "Submit", disabled: true })
device.getByRole("tab", { name: "Settings", selected: true })
device.getByRole("button", { name: "Details", expanded: true })
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Filter by accessible name |
| `checked` | `boolean` | Filter by checked state (checkbox, switch, radio) |
| `disabled` | `boolean` | Filter by disabled state |
| `selected` | `boolean` | Filter by selected state (tab, option) |
| `expanded` | `boolean` | Filter by expanded state (accordion, dropdown) |

### `device.getByDescription(text: string): ElementHandle`

Locate an element by its accessibility description (Android `contentDescription`, iOS `accessibilityLabel`).

```typescript
device.getByDescription("Close menu")
device.getByDescription("Profile photo")
```

### `device.getByPlaceholder(text: string): ElementHandle`

Locate an input by its placeholder / hint text.

```typescript
device.getByPlaceholder("Enter your email")
device.getByPlaceholder("Search")
```

### `device.getByTestId(testId: string): ElementHandle`

Locate an element by its dedicated test identifier.

```typescript
device.getByTestId("submit-button")
```

### `device.getByLabel(text: string): ElementHandle`

Locate an input element by its associated label text. Finds form controls (text fields, checkboxes, switches, etc.) whose accessible name matches the label.

- **Android**: matches inputs whose `contentDescription` equals the text, or inputs linked via `labelFor`/`labeledBy`.
- **iOS**: matches input elements (text fields, switches, sliders, etc.) whose `accessibilityLabel` equals the text.

```typescript
device.getByLabel("Email")           // finds the email text field
device.getByLabel("Dark Mode")       // finds the Dark Mode switch
device.getByLabel("Volume")          // finds the Volume slider
```

### `device.locator(options: LocatorOptions): ElementHandle`

Escape hatch for native, non-accessible queries. Exactly one of `id`, `xpath`, or `className` must be set.

```typescript
device.locator({ id: "com.myapp:id/email_input" })
device.locator({ className: "com.myapp.widget.ColorPicker" })
// XPath is Android-only. Always include a comment explaining why.
device.locator({ xpath: "//android.widget.Button[@text='OK']" })
```

**LocatorOptions:**

| Option | Type | Description |
|---|---|---|
| `id` | `string` | Native resource id (Android `R.id.foo` or iOS `accessibilityIdentifier`). |
| `xpath` | `string` | XPath expression. Android-only, and for use on its own. `and()`/`or()` refuse an xpath operand with an error (its text and bounds come from a different agent read and could never match the other side). Narrowing (`filter()`, `first()`/`nth()`) still queries, but actions through a narrowed xpath locator fail at the agent — it cannot act on an xpath match by id. |
| `className` | `string` | Native widget class name. |

> The `getBy*` methods and `locator()` are also available on every `ElementHandle`. Calling them on a parent locator scopes the search to its descendants. See [ElementHandle Scoping](#scoping).

> **iOS wrapper suppression.** When traversing the iOS accessibility tree, Tapsmith drops a matching `XCUIElementTypeOther` container if a descendant *also* matches the same locator and shares the wrapper's `accessibilityIdentifier` (or, when the wrapper's identifier is empty, its `accessibilityLabel`). This collapses the redundant wrappers React Native (and SwiftUI in some configurations) emit around interactive elements, so a `getByText("Submit")` resolves to the actual control rather than the surrounding container. The visible text of the wrapper and descendant is *not* compared — identifier/label match alone is enough. If your native iOS app deliberately exposes an `.other` container with the same identifier as a child you also want addressable, the outer wrapper will be silently suppressed in favour of the child — give the wrapper a unique `accessibilityIdentifier` (or use `device.locator({ id: ... })`) to address it directly.

### Strict mode

Like Playwright, Tapsmith locators are **strict**: a locator used for an action, single-element query, or assertion must resolve to exactly one element. When it resolves to more than one, the operation throws a `StrictModeViolationError` immediately (it does not keep auto-waiting) listing every match with a suggested unambiguous locator:

```
strict mode violation: getByText("Sign in") resolved to 2 elements:
    1) text "Sign in to continue to DreamSpinner" [44,210][436,260] aka device.getByText("Sign in to continue to DreamSpinner", { exact: true })
    2) button "Sign in" [44,640][436,712] aka device.getByRole("button", { name: "Sign in" })
Hint: use { exact: true }, getByRole(role, { name }), getByTestId(), or .first()/.nth()/.last() to target a single element.
```

This is the safety net for the substring default of `getByText` — without it, an ambiguous locator would silently act on the first match in document order, which is rarely the element you meant.

| Operation | Strict? |
|---|---|
| Actions (`tap`, `type`, `scroll`, `dragTo`, `setChecked`, …) | Yes |
| Single-element queries (`find`, `getText`, `isVisible`, `isHidden`, `boundingBox`, `scrollIntoView`, …) | Yes |
| `waitFor({ state: "visible" \| "attached" })` | Yes |
| Positive assertions (`toBeVisible`, `toHaveText`, `toBeChecked`, …) | Yes |
| `waitFor({ state: "hidden" \| "detached" })` | No — absence is evaluated over all matches |
| `toBeHidden`, `not.toBeVisible`, `not.toExist` | No — absence is evaluated over all matches |
| `count()`, `all()`, `allTextContents()`, `exists()`, `toHaveCount` | No — inherently multi-element |
| Locators narrowed with `.first()` / `.last()` / `.nth(n)` | Exempt — they target one match by definition |

To handle a violation programmatically, import the error class or the cross-realm-safe guard:

```typescript
import { StrictModeViolationError, isStrictModeViolation } from "tapsmith";

try {
  await device.getByText("Delete").tap();
} catch (err) {
  if (isStrictModeViolation(err)) {
    console.log(err.elements.length); // the matched ElementInfo objects
  }
  throw err;
}
```

> **Accessibility-tree duplicates don't count.** Some platforms expose the same visual element twice — iOS in particular renders a React Native `<Text testID="...">` as a parent `StaticText` carrying the attributes plus an inner child with identical text and pixel-identical bounds. Matches with identical text **and** identical bounds are collapsed to one element (the attribute-carrying first occurrence) before the strict check, since acting on either taps the same point. This collapsing also applies to `count()`, `all()`, and `.nth()` indexing, so positional chains stay consistent with what you see on screen. Distinct elements that merely share text at different positions still violate.

> **Transient duplicates:** if a screen briefly shows two elements matching the locator mid-transition, the violation throws at that moment (Playwright behaves the same way). Prefer locators that are unique at all times, or `.first()` when duplication is expected.

> **WebView locators too.** `webview.getBy*` and `webview.locator(css)` locators enforce the same rules: actions, single-element queries (`isVisible()`, `textContent()`, …), and positive assertions throw on an ambiguous match, while `count()`, `all()`, absence checks, and `.first()/.nth()/.last()` chains are exempt. Element descriptions in the violation message come from the DOM (tag, text, `id`, `data-testid`, `aria-label`), and suggestions use `webview.*` selectors. For WebView violations `err.elements` holds at most the first 10 matches as sampled descriptions — check `err.totalCount` for the full match count. The string-selector convenience methods (`webview.click(css)`, `webview.fill(css, …)`, …) predate locators and still act on the first match — prefer `webview.locator(css)` for strict behavior.

---

## Device

The `Device` class is the primary interface for interacting with a mobile device. Test functions receive a `device` instance through the test fixtures.

In addition to the locator methods above, `Device` provides device-level actions that don't target a specific element.

### `device.platform: "android" | "ios"`

Read-only property exposing the platform the device is running. Useful for branching on platform-specific behaviour in tests (e.g. native dialog labels or soft-keyboard handling).

```typescript
if (device.platform === "android") {
  await device.pressBack();
}
```

### `device.swipe(direction: string, options?: SwipeOptions): Promise<void>`

Perform a swipe gesture across the screen in the given direction.

```typescript
await device.swipe("up");
await device.swipe("left", { speed: 500, distance: 0.5 });
```

**SwipeOptions:**

| Option | Type | Description |
|---|---|---|
| `speed` | `number` | Swipe speed in pixels per second |
| `distance` | `number` | Swipe distance as a fraction of screen size (0-1) |
| `timeoutMs` | `number` | Override the default timeout |

### `device.pressKey(key: string): Promise<void>`

Press a device key.

```typescript
await device.pressKey("ENTER");
await device.pressKey("HOME");
await device.pressKey("VOLUME_UP");
```

### `device.pressBack(): Promise<void>` *(Android only)*

Press the Android back button. Convenience method equivalent to `device.pressKey("BACK")`.

```typescript
await device.pressBack();
```

### `device.tapXY(x: number, y: number): Promise<void>`

Tap at raw screen coordinates in logical points (Android pixels; iOS points). Prefer locator-based `tap()` in tests; use this for coordinate-driven interaction (e.g., device mirror gestures).

```typescript
await device.tapXY(120, 340);
```

### `device.longPressXY(x: number, y: number, options?: { duration?: number }): Promise<void>`

Long-press at raw screen coordinates in logical points. `options.duration` specifies the hold duration in milliseconds (default 1000).

```typescript
await device.longPressXY(120, 340, { duration: 800 });
```

### `device.dragXY(from: { x: number; y: number }, to: { x: number; y: number }, options?: { duration?: number }): Promise<void>`

Drag/swipe from one point to another in logical points. `options.duration` specifies the drag duration in milliseconds (default 300).

```typescript
await device.dragXY({ x: 50, y: 200 }, { x: 50, y: 600 }, { duration: 400 });
```

> **Platform note:** `duration` is honored on Android (it scales the gesture's step count). On iOS the drag is performed via a fixed-duration synthesized gesture, so `duration` currently has no effect on speed.

### `device.inputText(text: string): Promise<void>`

Type `text` into whatever element currently has focus (no locator). Useful for inserting text without first tapping a field.

```typescript
await device.inputText("hello world");
```

### `device.takeScreenshot(): Promise<ScreenshotResponse>`

Capture a screenshot of the current device screen. Returns an object with `success`, `data` (PNG bytes), and `errorMessage` fields.

```typescript
const screenshot = await device.takeScreenshot();
```

### `device.waitForIdle(timeoutMs?: number): Promise<void>`

Wait until the device UI is idle (no animations, no pending layout passes). Uses the configured default timeout if none is specified.

```typescript
await device.waitForIdle();
await device.waitForIdle(5000);
```

### `device.installApk(apkPath: string): Promise<void>`

Install an APK on the connected device.

```typescript
await device.installApk("./app-debug.apk");
```

### `device.listDevices(): Promise<DeviceInfo[]>`

List all connected Android devices and emulators.

### `device.setDevice(serial: string): Promise<void>`

Target a specific device by its serial number.

```typescript
await device.setDevice("emulator-5554");
```

### `device.startAgent(targetPackage: string): Promise<void>`

Start the Tapsmith on-device agent for the given app package.

```typescript
await device.startAgent("com.myapp");
```

### `device.launchApp(packageName: string, options?: LaunchAppOptions): Promise<void>`

Launch an Android app by package name. This is the mobile equivalent of `page.goto(url)`.

```typescript
await device.launchApp("com.example.myapp");
await device.launchApp("com.example.myapp", { activity: ".MainActivity" });
await device.launchApp("com.example.myapp", { clearData: true }); // fresh start
await device.launchApp("com.example.myapp", { waitForIdle: false }); // return immediately
```

**Options:**
- `activity?` — specific Activity to launch (e.g., `".settings.ProfileActivity"`)
- `clearData?` — clear all app data before launching (default: `false`)
- `waitForIdle?` — wait for the UI to settle after launch (default: `true`)

### `device.openDeepLink(uri: string, options?: OpenDeepLinkOptions): Promise<void>`

Navigate to a screen via deep link URI.

```typescript
await device.openDeepLink("myapp://settings/profile");
await device.openDeepLink("https://example.com/product/123"); // app links
await device.openDeepLink("myapp://__reset", { forceColdLaunch: true });
```

**Options:**
- `forceColdLaunch?` — on iOS simulators, skip the warm in-process delivery
  attempt and cold-relaunch the app with the URL (default: `false`). Use when
  the deep link must start from a fresh process, e.g. a state-clearing reset.
  No effect on Android or physical iOS, which always deliver warm.

Deep links are delivered to the running app without relaunching it (warm
delivery) whenever possible. On iOS simulators, if warm delivery does not
reach its destination within a bounded window, Tapsmith automatically falls
back to a cold relaunch with the URL.

### `device.currentPackage(): Promise<string>`

Returns the package name of the foreground app.

```typescript
const pkg = await device.currentPackage(); // "com.example.myapp"
```

### `device.currentActivity(): Promise<string>` *(Android only)*

Returns the current activity name.

```typescript
const activity = await device.currentActivity(); // ".settings.ProfileActivity"
```

### `device.terminateApp(packageName?: string): Promise<void>`

Force-stop an app.

```typescript
await device.terminateApp("com.example.myapp");
```

### `device.getAppState(packageName: string): Promise<AppState>`

Check the state of an app. Returns `"not_installed"`, `"stopped"`, `"background"`, or `"foreground"`.

```typescript
const state = await device.getAppState("com.example.myapp");
```

### `device.sendToBackground(): Promise<void>` *(Android only)*

Press the home button to send the current app to the background.

```typescript
await device.sendToBackground();
```

### `device.bringToForeground(packageName: string): Promise<void>`

Bring a backgrounded app back to the foreground.

```typescript
await device.bringToForeground("com.example.myapp");
```

### `device.resetApp(options?): Promise<AppResetResult>`

Bring the app to a known state — the same reset the runner performs for the declared `appReset` policy, callable from inside a test. The daemon runs a ladder and reports which rung actually ran:

1. **warm** — in-app reset through the app's reset hook (`@tapsmith/react-native` marker, or `resetAppDeepLink`), process kept;
2. **restart** — terminate and relaunch, data kept;
3. **clear** — wipe app data and relaunch.

Note that on an app with no in-app reset hook, the default warm request falls back to **restart, which keeps app data** — pass `mode: "clear"` when you need an isolation-grade wipe.

Mid-test resets share the daemon's warm-window state with the runner's own resets and honour the same `appResetColdEvery` setting (default 10, `0` = off; a scope's `test.use({ appResetColdEvery })` applies to them too), so a warm `resetApp()` can come back as a cold relaunch with `reason: "cold relaunch: warm-window bound reached (…)"`.

```typescript
const result = await device.resetApp()                       // warm, falling back as needed
await device.resetApp({ mode: "clear", fallback: false })     // exactly a clear, or throw
await device.resetApp({ target: "/settings" })                 // warm reset landing on a route
```

| Option | Type | Default | Description |
|---|---|---|---|
| `mode` | `'warm' \| 'restart' \| 'clear'` | `'warm'` | How far to reset |
| `fallback` | `boolean` | `true` | Escalate warm → restart → clear when a rung fails |
| `target` | `string` | `'/'` | Route to land on after an in-app (warm) reset — it is the reset deep link's path. A `restart`/`clear` rung leaves the app at its launch route; check `modeUsed` and navigate if needed. |

**`AppResetResult`**

| Field | Type | Description |
|---|---|---|
| `modeRequested` / `modeUsed` | `'warm' \| 'restart' \| 'clear'` | What was asked for and what actually ran |
| `fellBack` | `boolean` | A lower rung ran because a higher one failed |
| `coldLaunch` | `boolean` | The process was recreated — by a `restart`/`clear` rung, a cold-window relaunch, or a warm delivery that had to relaunch the app to land (the `reason` says which) |
| `reason` | `string?` | Why a fallback or cold relaunch happened, e.g. `"cold relaunch: warm-window bound reached (10 resets)"` |
| `durationMs` | `number` | Wall time of the whole ladder |
| `hooksDetected` | `boolean` | `@tapsmith/react-native` hooks were found in the app |
| `epochBefore` / `epochAfter` | `number?` | In-app reset counter (hooks only) |
| `steps` | `{ name, durationMs, ok, detail? }[]` | Per-rung timings |

The call is recorded in the trace as a `resetApp` action whose detail line names the rung and reason. Throws when the ladder is exhausted (or `fallback: false` and the requested rung failed).

### `device.restartApp(packageName: string, options?: { waitForIdle?: boolean }): Promise<void>`

Force-stops and relaunches the app without clearing persistent storage. Resets all in-memory state (React component state, navigation stack) while preserving data on disk (AsyncStorage, SQLite, SharedPreferences).

Use this in `beforeEach` hooks when tests modify in-memory state and you need isolation, but don't need a clean persistent state:

```typescript
beforeEach(async ({ device }) => {
  await device.restartApp("com.example.myapp")
  await device.getByDescription("Settings").tap()
  await expect(device.getByText("Settings", { exact: true })).toBeVisible()
})
```

**Options:**
- `waitForIdle?` — wait for the UI to settle after relaunch (default: `true`)

### `device.clearAppData(packageName: string): Promise<void>`

Clear all app data and cache, providing test isolation similar to Playwright's fresh browser context.

```typescript
await device.clearAppData("com.example.myapp");
```

- **Android**: `pm clear` — wipes all persisted state, including the app's Android Keystore keys.
- **iOS simulator**: clears the app's data container **and the simulator's keychain**, so keychain-backed state (e.g. native Firebase Auth sessions, `expo-secure-store` items) doesn't survive a "full" clear. The simulator keychain is device-global, so this clears keychain items for *every* app on the simulator — fine for test-owned simulators. Set `TAPSMITH_NO_KEYCHAIN_STATE=1` to skip the keychain wipe.
- **iOS physical device**: uninstalls and reinstalls the app bundle (iOS deletes the app's keychain entries on uninstall).

### `device.saveAppState(packageName: string, path: string): Promise<void>`

Snapshot the app's persisted state and save it as a tar.gz archive on the host. The app is stopped before snapshotting to avoid data corruption.

- **Android**: archives the app's data directory (`/data/data/<package>/`) — SharedPreferences, databases, and internal files. Requires root (emulators) or a debuggable app (`run-as` fallback on physical devices). **Keystore-backed values** (`EncryptedSharedPreferences`, `expo-secure-store`, and many native auth SDKs) store only their *ciphertext* in the data directory; the decryption key lives in the Android Keystore, which is device-bound and **not** captured in the archive. [`restoreAppState`](#devicerestoreappstatepackagename-string-path-string-promisevoid) preserves the Keystore (it clears the data directory in place rather than running `pm clear`, which would wipe the app's Keystore keys), so these values **do** round-trip across a save/restore on the **same device**. **Limitation — cross-device / CI:** an archive is not portable across devices. The Keystore key only exists on the device that saved the archive, so the restored ciphertext can't be decrypted on a different device or CI runner, leaving the app unauthenticated. This applies even to auth SDKs that look like plain SharedPreferences: the Firebase Android SDK (used by `@react-native-firebase/auth`) persists its session token encrypted with a Tink keyset wrapped by an Android Keystore key. For cross-device/CI, mint auth state per device (run the login flow as a setup project on each device) or use API-driven auth (e.g. custom-token sign-in).
- **iOS simulator**: archives the app's data container **plus the simulator's keychain database** (as a reserved `.tapsmith-keychain` archive member), so keychain-backed auth state (e.g. native Firebase Auth, `expo-secure-store`) round-trips correctly. Set `TAPSMITH_NO_KEYCHAIN_STATE=1` to disable keychain capture. Best-effort across iOS runtimes: a save/restore on the *same* simulator is fully supported; restoring an archive captured on a different iOS version is not guaranteed.
- **iOS physical device**: archives the app's data container only. The keychain is not host-accessible on physical devices, so keychain-backed state (e.g. native auth SDK credentials) is **not** captured — a warning is logged. Prefer API-driven auth (e.g. custom-token sign-in) for test setup on physical devices.

```typescript
// Save authenticated state after login
await device.saveAppState("com.example.myapp", "./auth-state.tar.gz");
```

### `device.restoreAppState(packageName: string, path: string): Promise<void>`

Restore a previously saved app state archive. Clears the app's data first, then extracts the archive.

- **Android**: clears the app's data directory **in place** (rather than `pm clear`) so the app's Android Keystore keys survive — this is what lets Keystore-backed values (e.g. native auth tokens) decrypt after a restore on the same device. Then extracts the archive, fixing file ownership and SELinux contexts when running as root. See [`saveAppState`](#devicesaveappstatepackagename-string-path-string-promisevoid) for the cross-device limitation.
- **iOS simulator**: clears and re-extracts the data container; if the archive contains keychain state, the simulator's keychain is swapped to match and `securityd` is restarted so the change takes effect. The simulator keychain is device-global, so restoring swaps keychain state for every app on the simulator. Archives saved by older Tapsmith versions (without keychain state) restore exactly as before. Set `TAPSMITH_NO_KEYCHAIN_STATE=1` to skip the keychain swap.
- **iOS physical device**: reinstalls the app and pushes the archived container contents (keychain state is not restored — see `saveAppState`).

```typescript
// Restore state instead of logging in again
await device.restoreAppState("com.example.myapp", "./auth-state.tar.gz");
```

### `device.grantPermission(packageName: string, permission: string): Promise<void>` *(Android only)*

Programmatically grant an Android runtime permission.

```typescript
await device.grantPermission("com.example.myapp", "android.permission.CAMERA");
await device.grantPermission("com.example.myapp", "android.permission.ACCESS_FINE_LOCATION");
```

### `device.revokePermission(packageName: string, permission: string): Promise<void>` *(Android only)*

Revoke a previously granted runtime permission.

```typescript
await device.revokePermission("com.example.myapp", "android.permission.CAMERA");
```

### `device.setClipboard(text: string): Promise<void>`

Set the device clipboard content.

```typescript
await device.setClipboard("Hello, world!");
```

### `device.getClipboard(): Promise<string>`

Read the current device clipboard content.

```typescript
const text = await device.getClipboard();
```

### `device.setOrientation(orientation: Orientation): Promise<void>`

Set the device orientation. Accepts `"portrait"` or `"landscape"`.

```typescript
await device.setOrientation("landscape");
await device.setOrientation("portrait");
```

### `device.getOrientation(): Promise<Orientation>`

Get the current device orientation.

```typescript
const orientation = await device.getOrientation(); // "portrait" | "landscape"
```

### `device.isKeyboardShown(): Promise<boolean>`

Check if the soft keyboard is currently visible.

```typescript
if (await device.isKeyboardShown()) {
  await device.hideKeyboard();
}
```

### `device.hideKeyboard(): Promise<void>`

Hide the soft keyboard if it is visible. Resolves at once when no keyboard is shown, or when the app is not in the foreground. On iOS it throws if the app is in front but its screen cannot be read, since it cannot tell whether a keyboard is up.

```typescript
await device.hideKeyboard();
```

On Android this presses BACK, which the soft keyboard always obeys.

iOS has no API that puts the keyboard away, so `hideKeyboard()` does what a user would. It tries these in order and stops as soon as the keyboard is gone:

1. **Drag the scroll view the focused field is in** a few points, if it shows above the keyboard. The drag only starts from a spot clear of the scroll view's controls. A scroll view beside the field (a list under a search bar) is not dragged, and neither is a web view.
2. **Tap the keyboard's own dismiss key**, where it has one (iPad).
3. **Tap a blank spot** beside the focused field, above the keyboard, where no control, text, or image is drawn. The spot is inside the field's own container, so a sheet's backdrop is not tapped. This works on screens that dismiss the keyboard when you tap outside the field.
4. **Press the return key**, but only in a single-line field whose return key reads "return" or "done". This also submits the field, as it would for a user (React Native's `onSubmitEditing` fires). An action key such as "go", "send", "search" or "next" is never pressed, and neither is return in a multi-line field, where it would type a new line.

If the keyboard is still up after all of them, `hideKeyboard()` throws instead of reporting success. The error lists what it tried and why each step failed. Dismiss the keyboard the way your screen allows: tap its own Done or close button, or call `device.pressKey("enter")` if submitting the field is fine.

### `device.wake(): Promise<void>`

Wake the device screen if it is off.

```typescript
await device.wake();
```

### `device.unlock(): Promise<void>`

Wake the screen and dismiss the lock screen. Works with non-secure lock screens (no PIN/pattern). Useful for CI and emulator setups. On Android the lock screen is only dismissed when it is actually showing, so calling this on an unlocked device never sends gestures to the foreground app.

```typescript
await device.unlock();
```

### `device.pressHome(): Promise<void>` *(Android only)*

Press the home button. Convenience method equivalent to `device.pressKey("HOME")`.

```typescript
await device.pressHome();
```

### `device.openNotifications(): Promise<void>` *(Android only)*

Pull down the notification shade.

```typescript
await device.openNotifications();
```

### `device.openQuickSettings(): Promise<void>` *(Android only)*

Pull down the quick settings panel.

```typescript
await device.openQuickSettings();
```

### `device.pressRecentApps(): Promise<void>` *(Android only)*

Open the recent apps screen. Convenience method equivalent to `device.pressKey("APP_SWITCH")`.

```typescript
await device.pressRecentApps();
```

### `device.setColorScheme(scheme: ColorScheme): Promise<void>` *(Android only)*

Set the system UI mode. Accepts `"dark"` or `"light"`.

```typescript
await device.setColorScheme("dark");
await device.setColorScheme("light");
```

### `device.getColorScheme(): Promise<ColorScheme>`

Get the current system color scheme.

```typescript
const scheme = await device.getColorScheme(); // "dark" | "light"
```

### `device.close(): void`

Close the gRPC connection to the daemon.

---

### Network Interception

Tapsmith supports Playwright-style network interception. Route handlers let you mock, modify, or abort HTTP/HTTPS requests made by the app under test.

#### `device.route(url, handler, options?): Promise<void>`

Intercept network requests matching a URL pattern. Requires network tracing to be enabled (set `trace` to any mode other than `'off'` with `network: true`, which is the default). Without it, the MITM proxy that intercepts traffic is not active and route handlers will never fire. Route handlers only see traffic Tapsmith can decrypt; hosts that are configured for passthrough, or dynamically tunneled because an HTTP/2-capable client rejects the generated MITM certificate, cannot be matched.

See also: [`device.unroute()`](#deviceunrouteurl-handler-promisevoid), [`device.unrouteAll()`](#deviceunrouteall-promisevoid).

- `url`: `string | RegExp | ((url: URL) => boolean)` — URL pattern (glob), regex, or predicate
- `handler`: `(route: Route) => Promise<void> | void` — handler that decides how to handle the request
- `options.times?`: `number` — how many times to intercept (then auto-remove)

```ts
await device.route('**/api/posts*', async (route) => {
  await route.fulfill({ json: [{ id: 1, title: 'Mocked' }] })
})
```

#### `device.unroute(url, handler?): Promise<void>`

Remove a previously registered route handler. If `handler` is omitted, all handlers for the pattern are removed.

#### `device.unrouteAll(): Promise<void>`

Remove all registered route handlers.

#### `device.waitForRequest(urlOrPredicate, options?): Promise<TapsmithRequest>`

Wait for a network request matching the pattern. Requires network tracing to be enabled (same prerequisite as `device.route()`).

- `urlOrPredicate`: `string | RegExp | ((request: TapsmithRequest) => boolean)`
- `options.timeout?`: `number` — timeout in ms (default: device timeout)

#### `device.waitForResponse(urlOrPredicate, options?): Promise<NetworkResponseEventData>`

Wait for a network response matching the pattern. Requires network tracing to be enabled (same prerequisite as `device.route()`).

#### `device.on(event, handler): void`

Subscribe to network events: `'request'` or `'response'`.

```ts
device.on('request', (req) => console.log(req.url))
device.on('response', (resp) => console.log(resp.status))
```

#### `device.off(event, handler): void`

Unsubscribe from network events.

### Route

The `Route` object is passed to route handlers. It provides methods to decide how to handle the intercepted request.

#### `route.request(): TapsmithRequest`

Returns the intercepted request.

#### `route.abort(errorCode?): Promise<void>`

Abort the request. Optional `errorCode`: `'connectionrefused'`, `'connectionreset'`, `'timedout'`.

#### `route.continue(overrides?): Promise<void>`

Continue the request to the server with optional modifications.

- `overrides.url?`: `string` — override the request URL. Supports both same-origin path changes (e.g. `/v2/posts`) and cross-origin redirection (e.g. `https://staging.example.com/api/posts`). When the host differs, the `Host` header is automatically updated.
- `overrides.method?`: `string` — override the HTTP method
- `overrides.headers?`: `Record<string, string>` — override headers
- `overrides.postData?`: `string | Buffer` — override request body

#### `route.fulfill(options?): Promise<void>`

Return a mock response without contacting the server.

- `options.status?`: `number` — HTTP status code (default: 200)
- `options.headers?`: `Record<string, string>` — response headers
- `options.body?`: `string | Buffer` — response body
- `options.contentType?`: `string` — content-type header
- `options.json?`: `unknown` — convenience: JSON-serializes and sets content-type
- `options.path?`: `string` — read body from a file

#### `route.fetch(overrides?): Promise<FetchedAPIResponse>`

Fetch the actual response from the server. Returns a `FetchedAPIResponse` that you can inspect and modify before calling `route.fulfill()`.

- `overrides.url?`: `string` — override the URL to fetch from (supports cross-origin, same as `route.continue()`)
- `overrides.method?`: `string` — override the HTTP method
- `overrides.headers?`: `Record<string, string>` — override headers
- `overrides.postData?`: `string | Buffer` — override request body

```ts
await device.route('**/api/users/*', async (route) => {
  const response = await route.fetch()
  const data = response.json()
  data.name = 'Modified'
  await route.fulfill({ json: data })
})
```

### TapsmithRequest

Properties: `method`, `url`, `headers`, `postData`, `isHttps`.

### FetchedAPIResponse

Returned by `route.fetch()`. Properties: `status`, `headers`. Methods: `body()`, `text()`, `json()`.

---

## ElementHandle

An `ElementHandle` is a lazy reference to a UI element. It is returned by every `device.getBy*()` and `device.locator()` call, and supports chaining, queries, actions, and positional selection.

### Scoping

`ElementHandle` exposes the same `getBy*` methods and `locator()` as `Device`. Calling any of them on an existing handle scopes the search to its descendants — exactly like Playwright's `locator.locator(...)`.

| Method | Description |
|---|---|
| `getByText(text, options?)` | Substring (default) or exact text match within the parent. |
| `getByRole(role, options?)` | Accessibility role within the parent. |
| `getByDescription(text)` | Accessibility description within the parent. |
| `getByPlaceholder(text)` | Placeholder / hint text within the parent. |
| `getByTestId(id)` | Test identifier within the parent. |
| `getByLabel(text)` | Input element by associated label text within the parent. |
| `locator(options)` | Native id / xpath / className within the parent. |

Scoping also works after a positional or filtering modifier (`.first()`, `.last()`, `.nth()`, `.filter()`, `.and()`, `.or()`), just like Playwright. When the parent carries such a modifier it is resolved to its concrete element(s) and the child is scoped to them by geometric containment, so the parent must report bounds. A positional parent (`.first()`/`.nth()`) scopes to its single selected element; a filtering parent scopes to every match it resolves to (a child contained in any of them is in scope).

```typescript
const list = device.getByRole("list", { name: "Shopping cart" });
const item = list.getByText("Item 3", { exact: true });
await item.tap();

// Tap a delete button inside a specific row
await device.getByTestId("row-5").getByRole("button", { name: "Delete" }).tap();

// Scope into a positional match — the submit button inside the first dialog
await device.getByTestId("dialog").first().getByRole("button", { name: "Submit" }).tap();
```

### Positional Selection

#### `elementHandle.first(): ElementHandle`

Return a new handle targeting the first match. The handle is lazy -- it does not resolve until an action or assertion is performed.

```typescript
await device.getByRole("listitem").first().tap();
```

#### `elementHandle.last(): ElementHandle`

Return a new handle targeting the last match.

```typescript
await device.getByRole("listitem").last().tap();
```

#### `elementHandle.nth(index: number): ElementHandle`

Return a new handle targeting the match at the given 0-based index. Negative indices count from the end. The index must be an integer — `nth(1.5)` throws.

Chaining a positional modifier onto an already-positional handle narrows that one element rather than re-indexing the original match set, as in Playwright (and as `WebViewLocator` does): `list.nth(2).first()` is `list.nth(2)`, while `list.first().nth(1)` matches nothing. A `filter()` chained after the index applies to that one element too — see [`all()`](#elementhandleall-promiseelementhandle).

```typescript
await device.getByRole("listitem").nth(2).tap();
await device.getByRole("listitem").nth(-1).tap(); // last item
```

### Filtering

#### `elementHandle.filter(criteria: FilterOptions): ElementHandle`

Narrow matches by additional criteria without changing the locator. Returns a new lazy handle.

```typescript
const premiumItems = device.getByRole("listitem").filter({ hasText: "Premium" });
const count = await premiumItems.count();
```

**FilterOptions:**

| Option | Type | Description |
|---|---|---|
| `hasText` | `string \| RegExp` | Keep elements whose text contains this string or matches this RegExp |
| `hasNotText` | `string \| RegExp` | Exclude elements whose text contains this string or matches this RegExp |
| `has` | `ElementHandle` | Keep elements that have a descendant matching this locator |
| `hasNot` | `ElementHandle` | Exclude elements that have a descendant matching this locator |

### Combining Locators

#### `elementHandle.and(other: ElementHandle): ElementHandle`

Return a handle matching elements that satisfy both this and the other handle's locator (intersection). AND binds tighter than OR.

```typescript
const submitButton = device.getByRole("button").and(device.getByDescription("Submit"));
await submitButton.tap();
```

#### `elementHandle.or(other: ElementHandle): ElementHandle`

Return a handle matching elements that satisfy either this or the other handle's locator (union).

```typescript
const acceptButton = device.getByText("OK", { exact: true }).or(device.getByText("Accept", { exact: true }));
await acceptButton.tap();
```

**How operands are matched.** Each operand is resolved with its own hierarchy read, and the on-device agents give an element a fresh internal id on every read, so the two reads are combined by the element's *visual identity* — its bounds and its text — rather than by id. `and()` keeps the left operand's matches whose bounds and text also appear in the right operand's; `or()` keeps every left match and adds the right operand's matches that the left did not already have; the union is then ordered by position on screen (top, then left — matches without usable geometry come last, in operand order), so `first()` on a union is the topmost match, as with Playwright's DOM-ordered `or()`. A positional modifier on an operand applies to that operand first: `a.first().and(b)` intersects the first `a` with `b`. An xpath locator is refused as an operand (`and()`/`or()` throw), since on Android its text and bounds come from a different agent read and could never match the other side. Two distinct elements that share both bounds and text (a pressable and the single text it wraps, with no padding) count as the same target, which is also how strict mode already treats them; acting on either taps the same point. An element with no usable geometry — scrolled fully out of view, which Android reports as a zero-size rectangle — has no cross-read identity: `and()` does not match it until it is on screen (`scrollIntoView()` keeps scrolling; `toBeVisible()` is false either way), and `or()` keeps each operand's copy of it, so a single-element use of an overlapping union (including `scrollIntoView()`) fails with a strict-mode violation while the shared element is fully off-screen — bring it on screen through one operand first, or use a single-selector locator for scrolling. If the screen moves — or a label's text changes — between the two reads, that `and()` tick simply misses; auto-waiting readers (`find()`, actions, `expect(...)`) retry it, while the one-shot readers `count()` and `exists()` report that tick as it was, and an absence assertion (`toHaveCount(0)`, `toBeHidden()`, `not.toBeVisible()`) accepts it as its answer; an `or()` whose operands *both* match the moving element can see it twice for that tick and raise a strict-mode violation on a single-element action, so wait for the transition to settle before acting through an overlapping union. Both operands must also resolve the *same* node (or same-frame nodes): a role query resolving a row container and a text query resolving a differently-framed inner label do not intersect, so prefer operand pairs that target the same element, as the built-in role/text queries do.

### Queries

#### `elementHandle.find(): Promise<ElementInfo>`

Resolve the handle to an `ElementInfo` object. Throws if the element is not found within the timeout.

The `ElementInfo` object contains:

| Property | Type | Description |
|---|---|---|
| `elementId` | `string` | Internal element identifier |
| `className` | `string` | Android class name |
| `text` | `string` | Visible text content |
| `contentDescription` | `string` | Accessibility content description |
| `resourceId` | `string` | Android resource ID |
| `enabled` | `boolean` | Whether the element is enabled |
| `visible` | `boolean` | Whether the element is visible |
| `clickable` | `boolean` | Whether the element is clickable |
| `focusable` | `boolean` | Whether the element is focusable |
| `scrollable` | `boolean` | Whether the element is scrollable |
| `hint` | `string` | Input hint text |
| `checked` | `boolean` | Whether the element is checked |
| `selected` | `boolean` | Whether the element is selected |
| `focused` | `boolean` | Whether the element has input focus |
| `role` | `string` | Accessibility role (e.g. "button", "textfield") |
| `viewportRatio` | `number` | Fraction of element visible in viewport (0.0-1.0) |
| `bounds` | `Bounds` | Element bounding rectangle |

#### `elementHandle.exists(): Promise<boolean>`

Returns `true` if the element exists in the UI hierarchy **right now**, whether or not it is visible.

Like a Playwright presence check (Playwright has no `exists()`; `locator.count() > 0` is the idiom
there), this does **not** wait for the element to appear. It reads the current hierarchy and returns
`false` without waiting for it when nothing matches (two reads and a short idle wait, see below), so it
is safe to branch on presence. To wait for an element, use `expect(locator).toExist()` or `waitFor({ state: "attached" })`.
Both of those are strict (see below), so if the locator may match several elements, narrow it with
`.first()` first or wait on `expect(locator).toHaveCount(n)`.

```typescript
const exists = await device.getByText("Optional banner", { exact: true }).exists();

// Presence branch — answers at once, no timeout is spent on a missing element
const logOut = device.getByRole("button", { name: "Log out" });
if (await logOut.exists()) {
  await logOut.tap();
}
```

`exists()` is **exempt from strict mode**, like `count()` and `all()`: a locator that matches several
elements answers `true` rather than throwing. That is the difference from `isVisible()`, which is a
strict single-element query and also requires the match to be visible. An attached but off-screen or
invisible element exists.

The reliability contract is the same as `isVisible()`: a present element costs one hierarchy read; an
absent one costs two (the first empty read is confirmed after waiting for the UI to settle, at most
1.5 s); a stale mid-re-render snapshot is re-read; a momentary agent fault is retried for about two
seconds and then thrown (an agent command timeout, which means the agent is alive but slow, is retried
until the handle's timeout instead, like an action); and a user stop propagates instead of being reported as "doesn't exist".
Infrastructure problems are never reported as an answer. If every read is a stale snapshot (a screen
that never stops re-rendering, with no empty read to fall back on) the call re-reads for the handle's
timeout and then throws, pointing at `expect(locator).toExist()` / `.not.toExist()` and
`waitFor({ state: "attached" })`.

> **Behaviour change.** Before this release `exists()` handed the handle's timeout to the on-device
> agent, which waited for the element, so an absent element cost the whole action timeout (30 s by
> default) before `false` came back. It now answers at once. Code that relied on `exists()` to wait for
> an element to appear should use `await expect(x).toExist()` or `x.waitFor({ state: "attached" })` —
> or, for a locator that may match several elements, `await expect(x.first()).toExist()` or
> `await expect(x).toHaveCount(n)`, since the waiting forms are strict and `exists()` is not.
>
> Two further changes affect handles with `.filter()`, `.and()`, `.or()`, or a `getBy*` scoped to a
> modified parent. Those used to report `false` for *any* error, so `x.filter({ hasText: "X" }).exists()`
> answered `false` when the filter kept several candidates; it now answers `true`, as an ambiguous
> locator should for a multi-element query. And a user stop, a transport failure or a persistent
> device fault now propagates as an error instead of being reported as "doesn't exist" — including the
> descriptive error thrown when the hierarchy never settles for the whole timeout, which the
> unmodified form already threw.

#### `elementHandle.count(): Promise<number>`

Return the number of elements the locator matches. Every modifier applies — `filter()`, `and()`/`or()`, scoping and `first()`/`nth()`/`last()` — so `locator.first().count()` is 1 or 0, as in Playwright.

```typescript
const itemCount = await device.getByRole("listitem").count();
```

`count()` does not wait for an element: nothing matching is `0` at once. Like `isVisible()`, a read that
lands mid-re-render (a stale snapshot) is not treated as an answer but re-read until one lands between
frames, for up to the handle's timeout — so on a screen that never stops changing the call can take the
full timeout and then throws the stale error. A `timeout` of `0` in the config makes it a
single read. The same contract
applies to `all()` and `allTextContents()`.

#### `elementHandle.all(): Promise<ElementHandle[]>`

Return an array of `ElementHandle` instances, one for each element the locator matches. Useful for iterating over a list of elements. Every modifier applies, as for `count()`: `locator.first().all()` (or `.nth(i)`/`.last()`) yields the one handle that position names, or an empty array.

```typescript
// Read every row's text in one hierarchy read
const names = await device.getByRole("listitem").allTextContents();

// Iterate all() when each row needs its own action
for (const item of await device.getByRole("listitem").all()) {
  await item.tap(); // each handle is a live nth(i) locator — one read per call
}
```

Each returned handle is a plain `.nth(i)` locator, exactly as in Playwright: nothing is cached, so
every reader (`find()`, `getText()`, `isVisible()`, `isEnabled()`, `boundingBox()`, `exists()`,
`count()`, …), every action and every `expect()` on `items[i]` resolves live against the device.
A check and the action it guards therefore always describe the same element — whatever is at index
`i` when each of them runs:

```typescript
const rows = await device.getByRole("listitem").all();
await rows[0].tap(); // removes row 0; the list shifts up
if (await rows[1].isVisible()) {
  await rows[1].tap(); // taps the element now at index 1 — the same one isVisible() saw
}
```

The flip side is that once the list changes, `items[i]` names whatever is at index `i` *now*, not the
row it named when `all()` ran — including after `items[i].scrollIntoView()` on a virtualised list,
where the rendered window shifts under the index. To act on a particular row, prefer a locator that
names it (`getByText`, `filter({ hasText })`), or call `all()` again after the list changes.
Scoped children (`items[i].getByRole("button")`) resolve their parent the same live way.

Because a handle from `all()` is an ordinary positional locator, further modifiers compose in call
order, as in Playwright: `items[i].filter({ hasText: "Sold out" })` is row `i` if it matches and
nothing otherwise, `items[i].first()` is `items[i]` itself, `items[i].nth(1)` matches nothing, and
`items[i].and(x)` / `items[i].or(x)` use that row as an operand. The same rule applies to any
positional locator: `list.nth(1).filter(…)` means "row 1 if it matches", not "the second matching
row" — put the filter first (`list.filter(…).nth(1)`) for the latter. `list.first().all()` (or
`.nth(i)`/`.last()`) yields that one locator, or an empty array.

Each call on a handle from `all()` is one hierarchy read, so iterate `all()` when you need per-row
*actions*. For a batch *read*, use a single query instead: [`allTextContents()`](#elementhandlealltextcontents-promisestring)
for the texts, `count()` for the size, or an assertion such as `toHaveCount`. On an Android emulator a
hierarchy read costs roughly 0.7 s, so `for (const row of rows) await row.getText()` over ten rendered
rows takes about 7 s where `rows.allTextContents()` takes one read. Issuing the reads concurrently
(`Promise.all(rows.map((row) => row.getText()))`) does not help: the same dumps queue on one on-device
agent, and on a loaded emulator they surface as agent command timeouts and stale-snapshot retries
rather than as speed.

> **Behaviour change.** Before this release the handles returned by `all()` carried the snapshot they
> were resolved from: `find()`, `getText()`, `isEnabled()`, `boundingBox()` and actions answered from
> that capture (no device read), while `expect()`, `waitFor()`, `isVisible()` and `count()` re-queried
> live — so a check and the action it guarded could describe different elements, and `first()`,
> `nth()`, `filter()`, `and()`, `or()` and `all()` threw on such a handle. Every reader now resolves
> live and those methods compose instead of throwing. Two consequences on upgrade: a per-row loop such
> as `for (const row of rows) await row.getText()` now costs one hierarchy read per row (use
> `allTextContents()` for a batch read), and `list.nth(1).filter(…)` — on any positional locator, not
> only one from `all()` — now means "row 1 if it matches" rather than "the second matching row"; write
> `list.filter(…).nth(1)` for the old meaning.

#### `elementHandle.allTextContents(): Promise<string[]>`

Return the text of every element the locator matches, in match order, from a single hierarchy read
(Playwright's `allTextContents()`). Every modifier applies, as for `count()` and `all()`, and like them
it does not wait and is exempt from strict mode: when nothing matches it resolves to `[]`.

```typescript
const names = await device.getByRole("listitem").allTextContents();
expect(names).toEqual(["Item 1", "Item 2", "Item 3"]);
```

### Waiting

#### `elementHandle.waitFor(options?): Promise<void>`

Wait until the element reaches the specified state. Polls the UI hierarchy until the condition is met or the timeout expires.

```typescript
// Wait for a loading spinner to disappear
await device.getByRole("progressbar").waitFor({ state: "hidden" });

// Wait for an element to appear (default state is 'visible')
await device.getByText("Welcome").waitFor();

// Wait for element to be removed from the hierarchy entirely
await device.getByText("Toast message").waitFor({ state: "detached" });

// Wait for element to exist (even if not visible, e.g. off-screen)
await device.getByTestId("lazy-section").waitFor({ state: "attached" });
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `state` | `'visible' \| 'hidden' \| 'attached' \| 'detached'` | `'visible'` | Target state to wait for |
| `timeout` | `number` | Device timeout (30s) | Maximum time to wait in milliseconds |

**States:**

| State | Condition |
|-------|-----------|
| `visible` | Element exists in the hierarchy AND is visible |
| `hidden` | Element doesn't exist OR exists with `visible === false` |
| `attached` | Element exists in the hierarchy (regardless of visibility) |
| `detached` | Element does not exist in the hierarchy |

### Actions

#### `elementHandle.tap(): Promise<void>`

Tap this element.

```typescript
await device.getByRole("button", { name: "Submit" }).tap();
```

**Covered elements.** Like a Playwright click, a tap auto-waits for the element to be enabled and then for nothing to be drawn over it. If something covers the point it would tap, the tap waits for the cover to go away. Covers include the software keyboard, a bar or window drawn over the element, and another control painted on top of it (a button, link, text input, list cell, alert, sheet…). If the cover clears within the action timeout, the tap goes ahead. If it is still there at the timeout, the tap fails instead of tapping the cover: `Element is covered by the keyboard …` or `Element is covered by button "Overlay" …`. When the keyboard or a bar covers only part of the element, the tap lands on the visible part. `doubleTap()`, `longPress()`, and the tap that `type()`, `clear()` and `focus()` use to focus a field follow the same rules. A field that already has focus is not tapped at all when the keyboard, or a control on the same screen, covers it (typically its own keyboard): typing reaches it anyway. A dialog or other window over the field is waited out like any other cover, since it takes the input. If the element goes away, or turns into a different element, while its cover is being waited out, the action does not tap whatever replaced it: it looks the locator up again and fails as not found if nothing matches. If the keyboard is in the way, dismiss it first (`device.hideKeyboard()`, or submit the field). A plain view that is not a control (for example an unlabeled backdrop) is not detected as a cover yet (PILOT-364).

On Android, an element that is *entirely* behind the keyboard is hidden from the accessibility tree. An action on it fails as not found (after waiting out the timeout) rather than as covered, and assertions such as `toBeVisible()` and `toHaveValue()` cannot see it until the keyboard is gone.

#### `elementHandle.doubleTap(options?: { intervalMs?: number }): Promise<void>`

Double-tap this element.

- `options.intervalMs?`: `number` — interval in milliseconds between the two taps. Overrides the global `doubleTapInterval` config for this call. Defaults to `100`. On iOS, the interval is used for the coordinate-based EventSynthesizer path; the XCUIElement path handles timing internally.

```typescript
await device.getByText("Zoom here", { exact: true }).doubleTap();

// Custom interval for specific timing needs
await device.getByText("Zoom here").doubleTap({ intervalMs: 150 });
```

#### `elementHandle.longPress(durationMs?: number): Promise<void>`

Long press this element.

```typescript
await device.getByText("Item 1", { exact: true }).longPress(2000);
```

#### `elementHandle.type(text: string, options?: { delay?: number }): Promise<void>`

Type text into this element.

- `options.delay?`: `number` — delay in milliseconds between keystrokes. Overrides the global `typingDelay` config for this call. Defaults to `0` (no delay).

```typescript
await device.getByPlaceholder("Email").type("user@example.com");
await device.getByPlaceholder("OTP").type("123456", { delay: 50 });
```

> **Control characters.** `\n`, `\t`, and `\b` are dispatched as
> `KEYCODE_ENTER` / `KEYCODE_TAB` / `KEYCODE_DEL` key events on Android
> and the equivalent key events on iOS. Notably `\b` is **destructive**
> — `type("foo\bbar")` deletes the `o` and types `bar`, ending with
> `fobar`. CR (`\r`) is dropped (Android keyboards send `\n` for the
> Enter key). Other ASCII control codes below `0x20` are dropped with
> a one-shot warning log.

#### `elementHandle.clearAndType(text: string, options?: { delay?: number }): Promise<void>`

Clear existing text and type new text.

- `options.delay?`: `number` — delay in milliseconds between keystrokes. Same as `type()`.

```typescript
await device.locator({ id: "search_box" }).clearAndType("new query");
```

#### `elementHandle.clear(): Promise<void>`

Clear the text content of this element.

```typescript
await device.locator({ id: "search_box" }).clear();
```

> **iOS very-long-field ceiling.** On iOS, `clear()` first attempts
> Cmd+A + Delete; if that misses (common on React Native wrapped
> controls), it falls back to a per-character backspace loop capped at
> 16 iterations × 256 keystrokes = 4096 backspaces. A field with more
> than ~4000 grapheme clusters of content will throw `actionFailed`
> rather than partially clearing. The cap exists so a misbehaving
> field can't hang the agent. Android uses the native `UiObject2.clear()`
> API and isn't subject to this limit.

#### `elementHandle.scroll(direction: string, options?: { distance?: number }): Promise<void>`

Scroll this element in the given direction.

```typescript
await device.getByRole("list").scroll("down", { distance: 300 });
```

#### `elementHandle.scrollIntoView(options?: { direction?: string; maxScrolls?: number; speed?: number }): Promise<void>`

Scroll the viewport until this element is visible on screen. Useful for reaching elements that are below the fold in a scrollable container.

Swipes in the given direction, checking visibility between each attempt. Throws if the element is not visible after `maxScrolls` attempts.

If the element is already visible, this is a no-op — it returns without scrolling, so calling `scrollIntoView()` before every `tap()` is safe even when the target is on screen (an unnecessary swipe could otherwise shift it under a pinned app bar). When the element isn't found on the first check, Tapsmith waits for the UI to settle and re-checks before the first swipe, so a briefly stale accessibility tree (e.g. right after navigation) doesn't trigger a spurious scroll. A handle from `all()` is a live `.nth(i)` locator, so on a virtualised list the scroll stops on whatever row is at index `i` in the scrolled window — see the [`all()`](#elementhandleall-promiseelementhandle) section.

The visibility check honours every modifier on the locator — `filter()`, `and()`/`or()`, scoping and `first()`/`nth()`/`last()` — so `device.getByRole("listitem").filter({ hasText: "Zebra" }).scrollIntoView()` swipes until *that* row is on screen rather than stopping at the first list item. Strict mode applies as for any single-element query: an ambiguous locator throws (before the first swipe, if it is ambiguous from the start) rather than scrolling toward an arbitrary match.

| Option | Default | Description |
|---|---|---|
| `direction` | `"up"` | Swipe direction. `"up"` scrolls down (reveals content below), `"down"` scrolls up (reveals content above). |
| `maxScrolls` | `5` | Maximum swipe attempts before throwing |
| `speed` | `2000` | Swipe speed in pixels/second |

```typescript
// Scroll down until the "Settings" card is visible, then tap it
await device.getByDescription("Settings").scrollIntoView();
await device.getByDescription("Settings").tap();

// Scroll up (reverse direction)
await device.getByText("Top Section", { exact: true }).scrollIntoView({ direction: "down" });
```

#### `elementHandle.dragTo(target: ElementHandle): Promise<void>`

Drag this element to a target element.

```typescript
const source = device.getByText("Item 1", { exact: true });
const target = device.getByText("Drop Zone", { exact: true });
await source.dragTo(target);
```

#### `elementHandle.setChecked(checked: boolean): Promise<void>`

Ensure a checkbox, switch, or radio button is in the desired state. Idempotent -- only taps if the current state differs from the desired state, and verifies the state changed after tapping.

```typescript
await device.getByRole("switch", { name: "Dark Mode" }).setChecked(true);
await device.getByRole("checkbox", { name: "Remember me" }).setChecked(false);
```

#### `elementHandle.selectOption(option: string | { index: number }): Promise<void>`

Select an option from a native spinner or dropdown. Abstracts the tap-spinner, wait-for-popup, tap-option pattern into a single action.

```typescript
await device.getByRole("combobox").selectOption("Option 2");
await device.getByRole("combobox").selectOption({ index: 1 });
```

#### `elementHandle.focus(): Promise<void>`

Programmatically focus this element. For text fields, this shows the keyboard.

```typescript
await device.getByRole("textfield", { name: "Email" }).focus();
```

#### `elementHandle.blur(): Promise<void>`

Remove focus from this element by tapping outside its bounds.

```typescript
await device.getByRole("textfield", { name: "Email" }).blur();
```

#### `elementHandle.pinchIn(options?: { scale?: number }): Promise<void>`

Perform a pinch-in (zoom out) gesture on this element.

```typescript
await device.getByText("Map", { exact: true }).pinchIn();
await device.getByText("Map", { exact: true }).pinchIn({ scale: 0.3 });
```

#### `elementHandle.pinchOut(options?: { scale?: number }): Promise<void>`

Perform a pinch-out (zoom in) gesture on this element.

```typescript
await device.getByText("Map", { exact: true }).pinchOut();
await device.getByText("Map", { exact: true }).pinchOut({ scale: 3.0 });
```

#### `elementHandle.highlight(options?: { durationMs?: number }): Promise<void>`

Highlight this element for debugging. Validates that the element exists and is accessible.

```typescript
await device.getByRole("button", { name: "Submit" }).highlight();
```

#### `elementHandle.screenshot(): Promise<Buffer>`

Capture a screenshot cropped to this element's bounding box. Returns a `Buffer` containing PNG image data.

```typescript
const png = await device.getByRole("image", { name: "Profile" }).screenshot();
```

### Info Accessors

#### `elementHandle.getText(): Promise<string>`

Get the visible text content of this element. Waits for the element like `find()`. To read the text of
every match in one hierarchy read, use [`allTextContents()`](#elementhandlealltextcontents-promisestring).

```typescript
const label = await device.locator({ id: "status_label" }).getText();
```

#### `elementHandle.isVisible(): Promise<boolean>`

Check whether this element is visible on screen **right now**.

Like Playwright's `locator.isVisible()`, this does **not** wait for the element to appear: it reads the
current state and returns `false` when no element matches, so it is safe to branch on presence. To
wait for an element to become visible, use `expect(locator).toBeVisible()` or `waitFor()`.

```typescript
const visible = await device.getByText("Error", { exact: true }).isVisible();

// Presence branch — answers at once, no timeout is spent on a missing element
if (!(await device.getByRole("button", { name: "Enable notifications" }).isVisible())) {
  return; // no button to tap on this screen — nothing to do here
}
```

Strict mode still applies: a locator that matches more than one element throws a
`StrictModeViolationError`. On a settled screen a present element costs one hierarchy read on the
device (it never polls for the element). An absent answer costs two: the accessibility tree can briefly
lag a just-rendered screen, so the first empty read is confirmed by waiting for the UI to settle (at
most 1.5 s) and reading once more, as `scrollIntoView()` does before its first swipe. If that re-read
only yields stale snapshots (a spinner keeps the tree churning), it is retried for a couple of seconds
and then the first empty read stands as the answer — an absent element never costs the whole timeout. Infrastructure
problems are never reported as a visibility answer: a momentary agent fault is retried for a short
window after it first appears (about two seconds, capped by the handle's timeout) and then thrown. An
agent command timeout is different: the agent is alive but slow (a CPU-starved CI emulator's hierarchy
dump), so it is retried until the handle's timeout, exactly as an action would be, and only then thrown.
A stale mid-re-render snapshot
just means the screen is busy, so — like `find()` and `waitFor()` — it is re-read until the handle's
timeout; if the hierarchy never settles (a screen that never stops animating) the call keeps re-reading
for the handle's timeout and then throws a descriptive error, pointing at `expect(locator).toBeVisible()` /
`.not.toBeVisible()` and `waitFor()`, rather than guessing an answer.

> **Behaviour change.** Before this release `isVisible()` waited for the element like `find()` and threw
> when it never appeared, so `expect(await x.isVisible()).toBe(true)` straight after a navigation used
> to pass by waiting. It now reads the screen as it is at that instant and may return `false` while the
> new screen is still appearing. To wait for visibility, use `await expect(x).toBeVisible()`; use
> `isVisible()`/`isHidden()` only to branch on the current state.

Only `isVisible()`, `isHidden()` and `exists()` are non-waiting. `isEnabled()`, `isChecked()` and `isEditable()`
follow Playwright too: they wait for the element to be present and throw if it never appears, so a
negative answer always describes a real element.

#### `elementHandle.isHidden(): Promise<boolean>`

The opposite of `isVisible()`: `true` when the element is not visible **or** does not exist. Does not
wait for the element to appear or disappear. To wait for an element to go away, use
`expect(locator).not.toBeVisible()` or `waitFor({ state: "hidden" })`.

Like Playwright's `isHidden()`, this is a strict single-element query: a locator that matches more
than one element throws a `StrictModeViolationError`, whereas `not.toBeVisible()` and
`waitFor({ state: "hidden" })` evaluate absence over all matches. If the locator may match several
elements (say, two "Loading…" spinners), use those, or narrow with `.first()`/`.filter()`.

```typescript
// Presence branch: dismiss a banner only if one is showing
if (!(await device.getByRole("button", { name: "Dismiss" }).isHidden())) {
  await device.getByRole("button", { name: "Dismiss" }).tap();
}
```

Do not use `isHidden()` to wait for a spinner or animation to finish: an animating screen is exactly
what produces stale snapshots, so the probe would have to keep re-reading and, if the animation never
stops, throws. `await expect(device.getByText("Loading…")).not.toBeVisible()` is the tool for that.

#### `elementHandle.isEnabled(): Promise<boolean>`

Check whether this element is enabled (interactive). Waits for the element to be present (up to the
handle's timeout) and throws if it never appears.

```typescript
const enabled = await device.getByRole("button", { name: "Submit" }).isEnabled();
```

#### `elementHandle.isChecked(): Promise<boolean>`

Check whether this checkbox, switch, or radio button is in the checked state. Waits for the element to
be present (up to the handle's timeout) and throws if it never appears.

```typescript
const checked = await device.getByRole("switch", { name: "Notifications" }).isChecked();
```

#### `elementHandle.isEditable(): Promise<boolean>`

Check whether this element is an editable input field (text field role and enabled). Waits for the
element to be present (up to the handle's timeout) and throws if it never appears.

```typescript
const editable = await device.getByRole("textfield", { name: "Email" }).isEditable();
```

#### `elementHandle.inputValue(): Promise<string>`

Get the current value of an input field. On Android, this returns the element's text property. Waits
for the element to be present (up to the handle's timeout, on every handle shape including
`.first()`/`.nth()`/`.filter()`) and throws if it never appears.

```typescript
const value = await device.getByRole("textfield", { name: "Email" }).inputValue();
```

#### `elementHandle.boundingBox(): Promise<BoundingBox | null>`

Get the element's position and dimensions. Returns `null` if the element has no bounds. Waits for the
element to be present (up to the handle's timeout, on every handle shape including
`.first()`/`.nth()`/`.filter()`) and throws if it never appears.

```typescript
const box = await device.getByText("Header", { exact: true }).boundingBox();
// Returns: { x: number, y: number, width: number, height: number }
```

---

## Assertions

The `expect()` function creates assertions for an `ElementHandle` or a plain value. Locator assertions auto-wait by polling until the condition is met or the timeout expires.

### `expect(elementHandle: ElementHandle): TapsmithAssertions`

Create an assertion object for the given element handle.

```typescript
await expect(device.getByText("Hello", { exact: true })).toBeVisible();
```

### `expect(value: unknown): GenericAssertions`

Create a generic assertion for a plain value (non-ElementHandle). These are synchronous and do not auto-wait.

```typescript
expect(5).toBe(5);
expect("hello").toContain("ell");
expect([1, 2, 3]).toHaveLength(3);
```

### `expect.soft(elementHandle: ElementHandle): TapsmithAssertions`

Create a soft assertion that records failures without stopping the test. Failures are collected and can be flushed at the end.

```typescript
expect.soft(device.getByText("Header", { exact: true })).toBeVisible();
expect.soft(device.getByText("Footer", { exact: true })).toBeVisible();
// Test continues even if assertions fail

const errors = flushSoftErrors();
// errors contains any failures from soft assertions
```

### `expect.poll(fn: () => unknown | Promise<unknown>, options?: PollOptions): GenericAssertions`

Poll an async function until the assertion passes or the timeout expires. Useful for waiting on values that change over time.

```typescript
await expect.poll(async () => {
  const el = await device.getByRole("listitem").count();
  return el;
}).toBe(5);

await expect.poll(() => fetchStatus(), { timeout: 10000 }).toBe("ready");
```

**PollOptions:**

| Option | Type | Default | Description |
|---|---|---|---|
| `timeout` | `number` | 5000 | How long to poll before failing |
| `intervals` | `number[]` | `[250]` | Polling intervals in milliseconds |

### `flushSoftErrors(): Error[]`

Retrieve and clear all soft assertion failures collected by `expect.soft()`.

```typescript
const errors = flushSoftErrors();
if (errors.length > 0) {
  console.log(`${errors.length} soft assertions failed`);
}
```

### `.not`

Negate the following assertion.

```typescript
await expect(device.getByText("Loading...", { exact: true })).not.toBeVisible();
```

### Locator Assertions

All locator assertions accept an optional `options` object:

| Option | Type | Default | Description |
|---|---|---|---|
| `timeout` | `number` | Element's timeout (default 30s) | How long to wait for the condition |
| `ratio` | `number` | `0` | (toBeInViewport only) Minimum fraction of element visible in viewport |

#### `.toBeVisible(options?): Promise<void>`

Assert that the element is visible on screen. With `.not`, waits for the element to disappear.

```typescript
await expect(device.getByText("Welcome", { exact: true })).toBeVisible();
await expect(device.getByText("Spinner", { exact: true })).not.toBeVisible();

// Custom timeout
await expect(device.getByText("Welcome", { exact: true })).toBeVisible({ timeout: 10000 });
```

#### `.toBeEnabled(options?): Promise<void>`

Assert that the element is enabled (interactive).

```typescript
await expect(device.getByRole("button", { name: "Submit" })).toBeEnabled();
await expect(device.getByRole("button", { name: "Submit" })).not.toBeEnabled();
```

#### `.toBeDisabled(options?): Promise<void>`

Assert that the element is disabled (not interactive). More expressive than `.not.toBeEnabled()`.

```typescript
await expect(device.getByRole("button", { name: "Submit" })).toBeDisabled();
```

#### `.toBeChecked(options?): Promise<void>`

Assert that a checkbox, switch, or radio button is in the checked state.

```typescript
await expect(device.getByRole("switch", { name: "Dark Mode" })).toBeChecked();
await expect(device.getByRole("checkbox")).not.toBeChecked();
```

#### `.toBeHidden(options?): Promise<void>`

Assert that the element is not visible on screen (either not in the hierarchy or has visibility=false). More expressive than `.not.toBeVisible()`.

```typescript
await expect(device.getByText("Loading...", { exact: true })).toBeHidden();
```

#### `.toBeEmpty(options?): Promise<void>`

Assert that the element has no text content or is an empty input field. The agents normalize text-input fields so a placeholder/hint is not reported as text — `toBeEmpty()` after `clear()` passes even when the placeholder is still drawn.

> **Android API < 26 limitation.** The precise placeholder-vs-value distinction uses `AccessibilityNodeInfo.isShowingHintText()` and `getHintText()`, both of which are only available from API 26 (Android 8.0). On API 21–25 we cannot tell whether a textfield is displaying its placeholder or a real typed value, so `toBeEmpty()` after `clear()` may incorrectly report the field as non-empty (it sees the placeholder text). Bump `minSdk` to 26 if your tests rely on this behavior. iOS is unaffected.

```typescript
await expect(device.getByRole("textfield", { name: "Search" })).toBeEmpty();
```

#### `.toBeFocused(options?): Promise<void>`

Assert that the element currently has accessibility/input focus.

```typescript
await device.getByRole("textfield", { name: "Email" }).tap();
await expect(device.getByRole("textfield", { name: "Email" })).toBeFocused();
```

#### `.toBeEditable(options?): Promise<void>`

Assert that the element is an editable input field (a text field that is enabled).

```typescript
await expect(device.getByRole("textfield", { name: "Name" })).toBeEditable();
await expect(device.getByRole("textfield", { name: "ID" })).not.toBeEditable(); // read-only
```

#### `.toBeInViewport(options?): Promise<void>`

Assert that the element is currently within the visible screen area. Different from `toBeVisible()` which checks the visibility property -- this checks if the element's bounds intersect with the screen bounds.

```typescript
await expect(device.getByText("Footer", { exact: true })).toBeInViewport();
await expect(device.getByText("Footer", { exact: true })).toBeInViewport({ ratio: 0.5 }); // at least 50% visible
```

#### `.toHaveText(expected: string, options?): Promise<void>`

Assert that the element's text content matches the expected string exactly.

```typescript
await expect(device.locator({ id: "counter" })).toHaveText("42");
```

#### `.toContainText(expected: string | RegExp, options?): Promise<void>`

Assert that the element's text contains the given substring or matches a regex. Unlike `toHaveText()` which requires an exact match, this allows partial matching.

When the matched element has no own text (e.g. a wrapping `View` around `<Text>` children, common in React Native), the agents aggregate descendant text/labels so the assertion sees the visible string.

```typescript
await expect(device.getByTestId("status")).toContainText("Success");
await expect(device.getByTestId("status")).toContainText(/\d+ items/);
```

#### `.toHaveCount(count: number, options?): Promise<void>`

Assert that the locator resolves to exactly N elements. Every modifier on the locator applies — `filter()`, `and()`/`or()`, scoping and `first()`/`nth()`/`last()` — so it counts the same set `count()` returns, and a positional locator has a count of 1 or 0.

```typescript
await expect(device.getByRole("listitem")).toHaveCount(5);
await expect(device.getByText("Error", { exact: true })).toHaveCount(0);
```

#### `.toHaveAttribute(name: string, value: unknown, options?): Promise<void>`

Assert that the element has a specific property/attribute value. For Android, this maps to view properties like `className`, `resourceId`, `contentDescription`, `enabled`, `clickable`, `focusable`, `scrollable`, `selected`, etc.

```typescript
await expect(device.getByText("Item", { exact: true })).toHaveAttribute("selected", true);
await expect(device.getByText("Item", { exact: true })).toHaveAttribute("className", "android.widget.TextView");
```

#### `.toHaveAccessibleName(name: string | RegExp, options?): Promise<void>`

Assert that the element has the given accessible name. On Android, this is the `contentDescription` if set, otherwise the `text` property.

```typescript
await expect(device.getByRole("button")).toHaveAccessibleName("Submit form");
await expect(device.getByRole("image")).toHaveAccessibleName(/Profile/);
```

#### `.toHaveAccessibleDescription(description: string | RegExp, options?): Promise<void>`

Assert that the element has the given accessible description. On Android, this maps to the `hint` property.

```typescript
await expect(device.getByRole("image")).toHaveAccessibleDescription("Profile photo");
```

#### `.toHaveRole(role: string, options?): Promise<void>`

Assert that the element has a specific accessibility role.

The role is derived from a framework-set role description first (React Native's `accessibilityRole`, the `isHeading` flag, the `UIAccessibilityTraitHeader` trait, etc.) and falls back to the platform's class/element-type mapping. `"header"` and `"heading"` are accepted as aliases on both platforms.

```typescript
await expect(device.getByText("Submit", { exact: true })).toHaveRole("button");
await expect(device.getByTestId("toggle")).toHaveRole("switch");
await expect(device.getByText("Section title", { exact: true })).toHaveRole("heading");
```

#### `.toHaveValue(value: string, options?): Promise<void>`

Assert that an input field contains a specific value.

```typescript
await device.getByRole("textfield", { name: "Email" }).type("test@example.com");
await expect(device.getByRole("textfield", { name: "Email" })).toHaveValue("test@example.com");
```

#### `.toExist(options?): Promise<void>`

Assert that the element exists in the UI hierarchy (regardless of visibility).

```typescript
await expect(device.getByTestId("hidden-input")).toExist();
await expect(device.getByText("Deleted item", { exact: true })).not.toExist();
```

### Generic Value Assertions

When `expect()` receives a non-ElementHandle value, it returns `GenericAssertions` with synchronous Jest-style matchers. All support `.not` for negation.

| Assertion | Description |
|---|---|
| `.toBe(expected)` | Strict equality using `Object.is` |
| `.toEqual(expected)` | Deep equality |
| `.toStrictEqual(expected)` | Deep equality with type checking |
| `.toBeTruthy()` | Value is truthy |
| `.toBeFalsy()` | Value is falsy |
| `.toBeDefined()` | Value is not `undefined` |
| `.toBeUndefined()` | Value is `undefined` |
| `.toBeNull()` | Value is `null` |
| `.toBeNaN()` | Value is `NaN` |
| `.toContain(expected)` | String/array contains item |
| `.toContainEqual(expected)` | Array contains item matching deep equality |
| `.toHaveLength(expected)` | Value has `.length` equal to expected |
| `.toHaveProperty(path, value?)` | Value has property at path, optionally with value |
| `.toMatch(expected)` | String matches regex or string pattern |
| `.toMatchObject(expected)` | Object matches subset of properties |
| `.toBeGreaterThan(expected)` | Number is greater than expected |
| `.toBeGreaterThanOrEqual(expected)` | Number is greater than or equal to expected |
| `.toBeLessThan(expected)` | Number is less than expected |
| `.toBeLessThanOrEqual(expected)` | Number is less than or equal to expected |
| `.toBeCloseTo(expected, numDigits?)` | Number is close to expected within precision |
| `.toBeInstanceOf(expected)` | Value is instance of class |
| `.toThrow(expected?)` | Function throws, optionally matching message |

```typescript
expect(result).toBe(42);
expect(items).toHaveLength(3);
expect(name).toMatch(/^[A-Z]/);
expect(config).toMatchObject({ debug: true });
expect(() => parse("bad")).toThrow("Invalid");
```

---

## Test Runner

Tapsmith includes a built-in test runner with an API inspired by Jest and Playwright.

### `test(name: string, fn: (fixtures: TestFixtures) => Promise<void>): void`

Register a test. The test function receives a `fixtures` object containing a `device` instance.

```typescript
test("user can log in", async ({ device }) => {
  await device.getByText("Sign In", { exact: true }).tap();
});
```

### `test.only(name, fn)`

Run only this test (and other tests marked with `.only`). All other tests are skipped.

```typescript
test.only("focused test", async ({ device }) => {
  // Only this test will run
});
```

### `test.skip(name, fn)`

Skip this test.

```typescript
test.skip("broken test", async ({ device }) => {
  // This test will not run
});
```

### `test.use(options: UseOptions): void`

Override configuration options for all tests in the current describe scope. Overrides cascade — inner describe blocks inherit and can further override outer ones.

```typescript
describe("slow animations screen", () => {
  test.use({ timeout: 60000 })

  test("animation completes", async ({ device }) => {
    // runs with 60s timeout instead of the default
  })
})
```

Multiple calls in the same scope merge together:

```typescript
describe("custom config", () => {
  test.use({ timeout: 60000 })
  test.use({ screenshot: "always" })
  // equivalent to: test.use({ timeout: 60000, screenshot: "always" })
})
```

**`UseOptions`**

| Option       | Type                                        | Description                                  |
| ------------ | ------------------------------------------- | -------------------------------------------- |
| `timeout`    | `number`                                    | Action/assertion timeout (ms)                |
| `screenshot` | `'always' \| 'only-on-failure' \| 'never'` | Screenshot capture mode                      |
| `retries`    | `number`                                    | Retry count for failed tests                 |
| `trace`      | `TraceMode \| Partial<TraceConfig>`         | Trace recording configuration. See [configuration.md](./configuration.md#traceconfig) for the full `TraceConfig` shape (includes `network`, `networkHttpPorts`, `networkHosts`, `networkIgnoreHosts`, `networkPassthroughHosts`, `screenshots`, etc.). |
| `video`      | `VideoMode \| Partial<VideoConfig>`         | Video recording configuration. See the [Video recording](#video-recording) section below. |
| `appState`   | `string`                                    | Path to saved app state archive to restore; `""` means clear |
| `appReset`   | `'auto' \| 'clear' \| 'restart' \| 'warm' \| 'none'` | How the app is reset before tests in this scope. See [Test isolation](./writing-tests.md#test-isolation). |
| `appResetScope` | `'auto' \| 'file' \| 'test'`            | Reset once per file or before every test (`auto` resolves to per file; opt into per-test with `'test'`) |
| `appResetColdEvery` | `number`                               | Cold-relaunch every N warm resets (default 10; 0 = off) |

The following device-shaping fields may **only** be set on a project's
`use` block (not via `test.use()`), since the device is bound to the
worker before any test runs:

| Option            | Type                                  | Description                              |
| ----------------- | ------------------------------------- | ---------------------------------------- |
| `platform`        | `'android' \| 'ios'`                  | Target platform for this project         |
| `device`          | `string`                              | Explicit device serial / iOS UDID        |
| `devices`         | `number \| { name: string; device?: string }[]` | Drive several devices from one test (`devices: 2`, or named members, optionally pinned to a serial; at most 10). Tests receive them as the `devices` fixture. `test.use({ devices })` throws. See [Multi-device tests](./multi-device.md). |
| `avd`             | `string`                              | Android AVD name to launch               |
| `simulator`       | `string`                              | iOS simulator name or UDID               |
| `apk`             | `string`                              | Path to Android APK under test           |
| `app`             | `string`                              | Path to iOS .app bundle under test       |
| `package`         | `string`                              | Android package name / iOS bundle ID     |
| `activity`        | `string`                              | Optional Android launcher activity       |
| `agentApk`        | `string`                              | Override path to the Android agent APK   |
| `agentTestApk`    | `string`                              | Override path to the Android agent test APK |
| `iosXctestrun`    | `string`                              | Override path to the iOS .xctestrun file |
| `deviceStrategy`  | `'prefer-connected' \| 'avd-only'`    | Device selection strategy (Android)      |
| `launchEmulators` | `boolean`                             | Auto-launch emulators (Android)          |
| `resetAppDeepLink`| `string`                              | Warm-reset deep link (makes `appReset: 'auto'` → `warm`) |
| `resetAppWaitMs`  | `number`                              | Wait after the reset deep link           |

**Reusable auth state** — mirrors Playwright's `storageState`:

```typescript
// Setup: authenticate once and save state
test("authenticate", async ({ device }) => {
  await device.launchApp("com.example.myapp");
  // ... perform login flow ...
  await device.saveAppState("com.example.myapp", "./auth-state.tar.gz");
});

// Tests: restore state instead of logging in
describe("authenticated tests", () => {
  test.use({ appState: "./auth-state.tar.gz" });

  test("shows profile", async ({ device }) => {
    // Already logged in — no login flow needed
  });
});
```

### `TestFixtures`

The fixtures object passed to every test function. Destructure the fields you need:

```typescript
test("example", async ({ device, devices, request, projectName, platform }) => {
  // device — the primary interface for interacting with the mobile device
  // devices — every device of the test's group (devices[0] === device)
  // request — HTTP client for API calls (seeding data, fetching tokens, etc.)
  // projectName — current project name (when using multi-project config), or undefined
  // platform — resolved platform: "android" or "ios"
});
```

| Fixture | Type | Description |
|---|---|---|
| `device` | `Device` | Primary interface for interacting with the mobile device. An alias for `devices[0]`. |
| `devices` | `Device[]` | Every device the test drives, in the order declared by the project's `use.devices` — one entry unless the project declares a device group. Destructure by position (`{ devices: [alice, bob] }`) to drive two app sessions from one test. See [Multi-device tests](./multi-device.md). |
| `request` | `APIRequestContext` | HTTP client for API calls. See [API Request Fixture](#api-request-fixture). |
| `projectName` | `string \| undefined` | Name of the current project (from `projects` config). `undefined` when no projects are configured. |
| `platform` | `'android' \| 'ios'` | Resolved target platform for the current worker. |

### `test.extend<T>(definitions): TestFn<Fixtures & T>`

Create a new test function with additional custom fixtures. Returns a new `TestFn` with the extended fixture types. Follows the same pattern as Playwright's `test.extend()`.

Each fixture definition is a function that receives all other fixtures and a `use` callback. The fixture sets up its value, passes it to `use()`, and optionally cleans up after `use()` resolves. **Fixture functions must destructure their first parameter** (e.g., `({ request }, use)`) so the framework can track dependencies for lazy resolution.

```typescript
import { test as base, expect } from "tapsmith";

// Define a custom fixture that seeds a todo item via the API before each test
const test = base.extend<{ todoId: string }>({
  todoId: async ({ request }, use) => {
    // Setup: create a todo item via the API
    const res = await request.post("https://api.example.com/todos", {
      data: { title: "Buy groceries", completed: false },
    });
    const { id } = await res.json() as { id: string };

    // Provide the fixture value to the test
    await use(id);

    // Teardown: clean up after the test (runs even if the test fails)
    await request.delete(`https://api.example.com/todos/${id}`);
  },
});

test("can mark todo as complete", async ({ device, todoId, request }) => {
  await device.getByText("Refresh").tap();
  await device.getByText("Buy groceries").tap();
  await expect(device.getByRole("checkbox")).toBeChecked();

  // Verify the change persisted via the API
  const res = await request.get(`https://api.example.com/todos/${todoId}`);
  const todo = await res.json() as { completed: boolean };
  expect(todo.completed).toBe(true);
});
```

> **For authentication**, prefer setup projects with `device.saveAppState()` and `test.use({ appState })` instead of custom fixtures. This mirrors Playwright's `storageState` pattern — authenticate once, save to a file, and restore across all tests. See the [auth state example](#reusable-auth-state) above and the [Authentication patterns](writing-tests.md#authentication-patterns) section in the Writing Tests guide.

**Fixture scopes:**

By default, fixtures have `test` scope (created and torn down for each test). Use a tuple to specify `worker` scope (created once per worker, shared across tests):

```typescript
const test = base.extend<{ apiToken: string }>({
  apiToken: [async ({ request }, use) => {
    const res = await request.post("https://api.example.com/auth/service-token", {
      data: { clientId: process.env.API_CLIENT_ID },
    });
    const { token } = await res.json() as { token: string };
    await use(token);
  }, { scope: "worker" }],
});
```

| Scope | Lifecycle | Use for |
|---|---|---|
| `test` (default) | Created before each test, torn down after | Per-test data (seeded records, temp files) |
| `worker` | Created once when the worker starts, torn down when it ends | Expensive setup (API tokens, database connections) |

Custom fixtures can depend on other custom fixtures — they're resolved in dependency order automatically.

**Lazy resolution:** Only fixtures that are destructured by the test function and its hooks are resolved. If a test destructures `{ device, todoId }`, only `todoId` (and its transitive dependencies) will be set up — other fixtures defined in `test.extend()` are skipped. This matches Playwright's behavior.

### `describe(name: string, fn: () => void): void`

Group tests into a suite.

```typescript
describe("Login flow", () => {
  test("valid credentials", async ({ device }) => { /* ... */ });
  test("invalid credentials", async ({ device }) => { /* ... */ });
});
```

### `describe.only(name, fn)` / `describe.skip(name, fn)`

Focus or skip an entire suite.

### `beforeAll(fn: (fixtures) => void | Promise<void>): void`

Run a function once before all tests in the current suite. Receives builtin fixtures (`device`, `projectName`, `platform`), worker-scoped custom fixtures, and any test-scoped custom fixtures it destructures (see the note below).

```typescript
beforeAll(async ({ device }) => {
  // One-time setup for the suite
  await device.launchApp("com.example.myapp", { clearData: true });
});
```

### `afterAll(fn: (fixtures) => void | Promise<void>): void`

Run a function once after all tests in the current suite. Receives the same fixtures as `beforeAll`.

### `beforeEach(fn: (fixtures) => void | Promise<void>): void`

Run a function before each test in the current suite. Hooks are inherited by nested suites. Receives builtin fixtures (`device`, `request`, `projectName`, `platform`).

```typescript
beforeEach(async ({ device }) => {
  await device.restartApp("com.example.myapp");
});
```

### `afterEach(fn: (fixtures) => void | Promise<void>): void`

Run a function after each test in the current suite. Runs even if the test fails. Receives the same fixtures as `beforeEach`.

### `test.beforeAll(fn)` / `test.afterAll(fn)` / `test.beforeEach(fn)` / `test.afterEach(fn)`

Hook methods on the extended test function. Use these instead of standalone hooks when you need custom fixtures in your hooks:

```typescript
const test = base.extend<{ authScreen: AuthScreen }>({
  authScreen: async ({ device }, use) => {
    await use(new AuthScreen(device))
  },
});

// Custom fixtures are available in test.beforeEach/afterEach
test.beforeEach(async ({ device, authScreen }) => {
  await device.openDeepLink("myapp:///login");
  await expect(authScreen.heading).toBeVisible();
});
```

> **Note:** Test-scoped custom fixtures work in `beforeAll`/`afterAll` as well as `beforeEach`/`afterEach`. As in Playwright, each `beforeAll`/`afterAll` hook gets its **own** test-fixture scope: the fixtures it destructures are set up just before the hook runs and torn down immediately after (even if the hook throws). They are therefore not shared with the tests in the suite — for a single instance shared across the whole worker, declare the fixture with `{ scope: "worker" }` instead.

---

## API Request Fixture

The `request` fixture provides HTTP request methods for making API calls during tests. Useful for seeding test data, fetching auth tokens, or verifying backend state without going through the UI. Modeled after Playwright's `APIRequestContext`.

### Usage

The `request` fixture is built-in and available in every test alongside `device`:

```typescript
test("shows created item", async ({ device, request }) => {
  // Seed data via API
  await request.post("https://api.example.com/items", {
    data: { name: "Test Item", price: 9.99 },
    headers: { Authorization: "Bearer ..." },
  });

  // Verify it shows in the app
  await device.getByText("Refresh").tap();
  await expect(device.getByText("Test Item")).toBeVisible();
});
```

### `request.get(url, options?)`
### `request.post(url, options?)`
### `request.put(url, options?)`
### `request.patch(url, options?)`
### `request.delete(url, options?)`
### `request.head(url, options?)`

Send an HTTP request. Returns a `TapsmithAPIResponse`. **Does not throw on non-2xx responses** (matching Playwright's behavior) — check `.ok` or `.status` instead.

| Parameter | Type | Description |
|---|---|---|
| `url` | `string` | URL (absolute, or relative to `baseURL` if configured) |
| `options.data` | `unknown` | Request body. Objects are JSON-serialized automatically with `Content-Type: application/json`. |
| `options.headers` | `Record<string, string>` | Per-request headers (override `extraHTTPHeaders`). |
| `options.params` | `Record<string, string> \| URLSearchParams` | Query parameters appended to the URL. |
| `options.form` | `Record<string, string>` | Form-encoded body (sets `Content-Type: application/x-www-form-urlencoded`). |
| `options.timeout` | `number` | Per-request timeout in milliseconds. |

### `request.fetch(url, options?)`

Send a request with an explicit method via `options.method`. Defaults to `GET`.

### `TapsmithAPIResponse`

| Property / Method | Type | Description |
|---|---|---|
| `.status` | `number` | HTTP status code |
| `.statusText` | `string` | HTTP status text |
| `.ok` | `boolean` | `true` for 2xx status codes |
| `.url` | `string` | Final response URL |
| `.headers` | `Headers` | Response headers |
| `.json()` | `Promise<unknown>` | Parse body as JSON |
| `.text()` | `Promise<string>` | Body as UTF-8 string |
| `.body()` | `Promise<Buffer>` | Raw body buffer |
| `.dispose()` | `void` | Explicit cleanup |

The response body is eagerly buffered, so `.json()`, `.text()`, and `.body()` can each be called multiple times.

### Configuration

Set `baseURL` and `extraHTTPHeaders` in your config or via `test.use()`:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  baseURL: "https://api.example.com",
  extraHTTPHeaders: {
    Authorization: "Bearer my-token",
  },
});
```

With `baseURL` configured, relative paths are resolved against it:

```typescript
// Resolves to https://api.example.com/users/1
const res = await request.get("/users/1");
```

Per-request headers override `extraHTTPHeaders` when names collide.

### Trace Integration

When tracing is enabled (`--trace on`), each `request.*()` call:
- Appears as an action event in the trace viewer's actions panel
- Generates a network entry visible in the Network tab (alongside device network traffic)

This gives full visibility into test-level API calls alongside device interactions.

---

## Configuration

### `defineConfig(overrides?: Partial<TapsmithConfig>): TapsmithConfig`

Create a Tapsmith configuration by merging overrides with defaults. Used in `tapsmith.config.ts`.

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-debug.apk",
  timeout: 15_000,
});
```

See the [Configuration](configuration.md) guide for all options.

### Projects

Projects group test files with shared options and dependency ordering, mirroring Playwright's project concept. Each project can target its own device by overriding device-shaping fields under `use:`. Setup projects run first; dependent projects run after their dependencies complete.

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  projects: [
    // Setup project: runs first
    { name: "setup", testMatch: ["**/auth.setup.ts"] },
    // Default tests: no dependencies, runs in parallel with setup
    { name: "default", testMatch: ["**/*.test.ts"] },
    // Authenticated tests: runs after setup, with restored app state
    {
      name: "authenticated",
      dependencies: ["setup"],
      use: { appState: "./tapsmith-results/auth-state.tar.gz" },
      testMatch: ["**/app-state.test.ts"],
    },
  ],
});
```

**Per-device targeting (Android + iOS):**

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  package: "com.example.app",
  projects: [
    {
      name: "Pixel 6",
      use: {
        platform: "android",
        avd: "Pixel_6_API_34",
        apk: "./android/app-debug.apk",
        launchEmulators: true,
      },
    },
    {
      name: "iPhone 16",
      use: {
        platform: "ios",
        simulator: "iPhone 16",
        app: "./ios/MyApp.app",
        iosXctestrun: "./ios-agent/TapsmithAgent.xctestrun",
      },
    },
  ],
});
```

Run with `tapsmith test --workers 2` to execute both projects in parallel
(one worker per device target). Run with `--workers 1` to run them
sequentially with a device switch between projects. Both `--ui` and
`--watch` honor per-project devices and route file execution to the
correct device.

**`ProjectConfig`**

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique project name |
| `testMatch` | `string[]` | Glob patterns for test files (inherits global if unset) |
| `testIgnore` | `string[]` | Glob patterns to exclude from test discovery |
| `dependencies` | `string[]` | Projects that must complete first |
| `use` | `UseOptions` | Per-project option overrides (applied under file-level `test.use()`). Includes the device-shaping fields documented above. |
| `workers` | `number` | Number of parallel workers (devices) for this project. Additive — does not consume from the global `workers` budget. When unset, the project shares the global budget proportionally to file count. |
| `grep` | `RegExp \| RegExp[]` | Per-project grep filter, intersected with the root `grep`. A test must match at least one pattern in this set AND at least one pattern in the root set (when either is configured). |
| `grepInvert` | `RegExp \| RegExp[]` | Per-project grep-invert filter, unioned with the root `grepInvert`. A test that matches any pattern in either set is skipped. |

### `loadConfig(dir?: string, configFile?: string): Promise<TapsmithConfig>`

With `configFile`, load that file (resolved against `dir`); a missing one rejects with `Config file not found: <path>`. Otherwise, load configuration from the first of `tapsmith.config.ts`, `tapsmith.config.js` and `tapsmith.config.mjs` that exists in `dir` (default: the working directory). Falls back to defaults only if none exists: when the file exists but cannot be imported, the promise rejects with `Failed to load config file <path>: <reason>`, the import error as its `cause`, rather than trying the next candidate. TypeScript configs load without a TypeScript loader in the calling process. This is used internally by the CLI.

---

## Tracing

The `device.tracing` API provides programmatic control over trace recording.

### `device.tracing.start(options?)`

Start tracing. All subsequent device actions will be recorded.

```typescript
await device.tracing.start();
await device.tracing.start({ screenshots: true, snapshots: true });
```

**Options:**
| Option | Type | Default | Description |
|---|---|---|---|
| `screenshots` | `boolean` | `true` | Capture before/after screenshots |
| `snapshots` | `boolean` | `true` | Capture view hierarchy XML |
| `sources` | `boolean` | `true` | Include test source files |
| `network` | `boolean` | `true` | Capture HTTP/HTTPS traffic via proxy |
| `daemonLogs` | `boolean` | `false` | Stream the `tapsmith-core` daemon's own logs (gRPC, ADB/simctl invocations, device events) into the trace. Useful for diagnosing framework-level failures. Appears in the trace viewer's Console tab under the `daemon` source. Verbosity follows the daemon's log level — run the daemon with `--verbose` for debug-level detail. Opt-in (default off) because daemon logs are internal noise for typical app debugging. |
| `title` | `string` | — | Custom title for the trace |

### `device.tracing.stop(options?)`

Stop tracing and optionally write the trace archive.

```typescript
// Stop and save
await device.tracing.stop({ path: 'traces/my-test.zip' });

// Stop and discard
await device.tracing.stop();
```

Returns the path to the created zip file, or `undefined` if no path was specified.

The archive follows the versioned [trace archive format](trace-format.md). Local paths in it are relative to the project's `rootDir`, or to the working directory when `device.tracing` is used outside the test runner. The archive can be validated against the JSON Schema the package exports as `tapsmith/trace-format.schema.json`.

### `device.tracing.group(name)` / `device.tracing.groupEnd()`

Group actions in the trace viewer for better organization.

```typescript
device.tracing.group('Login flow');
await device.getByText('Username', { exact: true }).tap();
await device.getByText('Username', { exact: true }).type('admin');
await device.getByRole('button', { name: 'Sign In' }).tap();
device.tracing.groupEnd();
```

### `device.tracing.startChunk(options?)` / `device.tracing.stopChunk(options?)`

Start a new trace chunk. Useful for splitting long test runs into multiple trace files.

```typescript
await device.tracing.startChunk();
// ... actions ...
await device.tracing.stopChunk({ path: 'traces/chunk-1.zip' });

await device.tracing.startChunk();
// ... more actions ...
await device.tracing.stopChunk({ path: 'traces/chunk-2.zip' });
```

---

## Reporters

Tapsmith includes a reporter system inspired by Playwright. Reporters receive lifecycle events during a test run and produce output in various formats.

### Configuration

Configure reporters in `tapsmith.config.ts`:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  // Single reporter
  reporter: "list",

  // Reporter with options
  reporter: ["json", { outputFile: "results.json" }],

  // Multiple reporters
  reporter: ["list", ["json", { outputFile: "results.json" }]],
});
```

**Default:** When `reporter` is not set, Tapsmith uses the `list` reporter everywhere, including CI. Set `reporter: 'dot'` explicitly if you prefer the compact one-character-per-test output in CI. The `github` reporter is automatically added when running in GitHub Actions.

### Built-in reporters

| Reporter | Description | Default |
| --- | --- | --- |
| `list` | Detailed per-test output with status, name, and duration | All runs |
| `line` | Concise single-line output, overwrites previous line | — |
| `dot` | Minimal output: one character per test (`·` / `F` / `×`) | — |
| `json` | Structured JSON file with full test data | — |
| `junit` | JUnit XML for CI system ingestion | — |
| `html` | Self-contained interactive HTML report | — |
| `github` | GitHub Actions annotations on failures | Auto in GH Actions |
| `blob` | Serialized data for shard merging | — |

### Reporter options

**`json`**

| Option | Type | Default |
| --- | --- | --- |
| `outputFile` | `string` | `"tapsmith-results/results.json"` |

**`junit`**

| Option | Type | Default |
| --- | --- | --- |
| `outputFile` | `string` | `"tapsmith-results/results.xml"` |

**`html`**

| Option | Type | Default |
| --- | --- | --- |
| `outputFolder` | `string` | `"tapsmith-report"` |
| `open` | `"always" \| "never" \| "on-failure"` | `"on-failure"` |

The HTML report is a self-contained page with pass/fail summary, filtering, and per-test durations, with links to each failure's trace and video:

![HTML report with a pass/fail summary, filter chips, and per-test rows including trace and video links for a failed test](images/html-report.png)

**`blob`**

| Option | Type | Default |
| --- | --- | --- |
| `outputDir` | `string` | `"blob-report"` |

The blob reporter empties `outputDir` at the start of every run (before any device launch), as Playwright's does, so each
run leaves exactly one blob (plus its trace and video attachments) and an earlier run's results
can't be merged as though they were this run's. Point `outputDir` at a dedicated directory. If
`outputDir` is, or contains, the project root or the working directory, `tapsmith test` stops
with an error before launching any device. Clearing it would delete the project. A shard that gets no test files still writes an empty blob, so `merge-reports` can tell an
empty shard from a missing one. UI mode writes no blobs and leaves `outputDir` alone. Shards run
at the same time on one machine each need their own `outputDir`, or one run's clearing deletes
another's blob. Playwright behaves the same way.

### Custom reporters

Implement the `TapsmithReporter` interface:

```typescript
import type { TapsmithReporter, FullResult } from "tapsmith";
import type { TestResult } from "tapsmith";

class MyReporter implements TapsmithReporter {
  onRunStart(config, fileCount) {
    console.log(`Running ${fileCount} test files`);
  }

  onTestEnd(test: TestResult) {
    console.log(`${test.status}: ${test.fullName}`);
  }

  onRunEnd(result: FullResult) {
    console.log(`Done in ${result.duration}ms`);
  }
}

export default MyReporter;
```

Use by path in config:

```typescript
export default defineConfig({
  reporter: [["./my-reporter.ts", {}]],
});
```

### `TapsmithReporter` interface

All types are importable from `"tapsmith"`:

```typescript
import type {
  TapsmithReporter,
  FullResult,
  TapsmithConfig,
  TestResult,
  SuiteResult,
} from "tapsmith";
```

```typescript
interface TapsmithReporter {
  onRunStart?(config: TapsmithConfig, fileCount: number): void;
  onTestFileStart?(filePath: string): void;
  onTestStart?(fullName: string, filePath?: string): void;
  onTestEnd?(test: TestResult): void;
  onTestFileEnd?(filePath: string, results: TestResult[]): void;
  onTestFileRetry?(filePath: string, discardedCount: number): void;
  onRunEnd?(result: FullResult): Promise<void> | void;
  onError?(error: Error): void;
}
```

### `TestResult`

```typescript
interface TestResult {
  name: string;
  fullName: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: Error;
  firstAttemptError?: Error; // on a flaky (passed-on-retry) result: the first failed attempt's error
  failedAttemptArtifacts?: { screenshot?: boolean; trace?: boolean; video?: boolean }; // which linked artifacts came from the failed attempt
  screenshotPath?: string;
  tracePath?: string; // path to the trace archive (.zip) when tracing is enabled
  videoPath?: string; // path to the recorded MP4 when `video` is enabled and retained
  workerIndex?: number; // set in parallel mode — index of the worker that ran this test
  retry?: number; // zero-based attempt number this result was recorded on (omitted for a first-attempt pass)
  filePath?: string; // path to the test file this result belongs to
}
```

For a **flaky** test (failed, then passed on retry) the final result links the
**first failed attempt's** trace, screenshot, and video — the failure is what
needs debugging, and shipping pipelines (blob reports, CI artifacts) only pack
linked files. The failed attempt's error is kept in `firstAttemptError`, and
console reporters print it in the flaky section of the run summary. When the
failed attempt has no artifact of a given kind (e.g. `trace: "on-first-retry"`
records nothing on the first attempt), the passing retry's artifact is linked
instead.

### `SuiteResult`

```typescript
interface SuiteResult {
  name: string;
  durationMs: number;
  tests: TestResult[];
  suites: SuiteResult[]; // nested describe() blocks
}
```

### `FullResult`

```typescript
interface FullResult {
  status: "passed" | "failed";
  duration: number; // total wall-clock time in milliseconds (including setup)
  setupDuration?: number; // time spent on device provisioning, APK install, agent startup
  tests: TestResult[]; // flattened list of all test results
  suites: SuiteResult[]; // hierarchical suite tree (one per test file)
}
```

When `setupDuration` is present, console reporters show a timing breakdown:

```
Summary: 12 passed | 45.2s (setup 30.1s, tests 15.1s)
```

---

## CLI

### `tapsmith test [files...]`

Run test files. If no files are specified, discovers tests using the `testMatch` patterns from your config.

```bash
npx tapsmith test
npx tapsmith test tests/login.test.ts tests/signup.test.ts
```

### `tapsmith test --device <serial>` / `tapsmith test -d <serial>`

Target a specific device by its ADB serial number (or simulator UDID). This is
mainly useful for single-device debugging or reproducing an issue on one known
device.

```bash
npx tapsmith test --device emulator-5554
```

A pinned device hosts exactly one worker, in every mode — sequential, parallel,
watch and UI. `--device` combined with a `--workers N` the run cannot use is
refused: both are on the command line and ask for different runs. In a
single-platform config that is any N > 1 the run could otherwise use (more
than one file in a wave — `--device X --workers 2 one.test.ts` just runs on X);
in a config whose projects span
Android and iOS, `--device` (like a root `device` in the config) pins only the
projects of that device's platform, and the other platform's projects may use
the remaining workers — unless the device is pinned by several projects of its
platform (two apps, say), in which case the whole run uses one worker and runs
them one after another (UI and watch mode refuse that: they keep a worker per
target alive). Any other worker count — a `workers` value in the config,
or `--workers N` with a `device` pinned in the config or by `use.devices`
members — is capped to one for that device target, with a note saying so. For multi-worker
emulator runs, use config-based provisioning with `workers`, `launchEmulators`,
and `avd` instead.

### `tapsmith test --workers <n>` / `tapsmith test -j <n>`

Run tests in parallel across `n` devices. Each worker gets its own device/emulator and daemon instance. Tests are distributed via a work-stealing queue for natural load balancing.

```bash
npx tapsmith test --workers 4
npx tapsmith test -j 2
```

Overrides the `workers` config option. Requires enough connected devices or `launchEmulators: true` with an `avd` configured. In parallel mode, each test result includes a `workerIndex` field and console reporters show `[worker N]` tags.

### `tapsmith test --shard=x/y`

Split the test suite deterministically across `y` machines, running only shard `x`. Shards are assigned by file index (`file_index % total === current - 1`).

```bash
# In a CI matrix with 4 jobs:
npx tapsmith test --shard=1/4
npx tapsmith test --shard=2/4
npx tapsmith test --shard=3/4
npx tapsmith test --shard=4/4
```

When sharding is active, the `blob` reporter is automatically added so results can be merged later with `tapsmith merge-reports`.

### `tapsmith test --grep <pattern>` / `tapsmith test -g <pattern>`

Run only the tests whose fullName (`describe > test`) matches the given regular expression. Mirrors Playwright's `--grep`.

```bash
npx tapsmith test --grep checkout            # Only tests with "checkout" in their fullName
npx tapsmith test -g "^login > "             # Only tests inside the top-level "login" describe
npx tapsmith test --grep "@smoke|@critical"  # Run smoke + critical tests by tag-style suffixes
```

The pattern is compiled as a JavaScript `RegExp`. Combine with `--grep-invert` to further narrow the selection.

If a `--grep` / `--grep-invert` filter selects zero tests (e.g. a typo'd pattern), the run exits non-zero with an error rather than reporting a green "0 tests" success.

The same filter can be set in `tapsmith.config.ts`:

```ts
export default defineConfig({
  grep: /checkout/,                  // single pattern
})

// Or match any of several patterns:
export default defineConfig({
  grep: [/login/, /signup/],         // any pattern matches
})
```

Per-project filters are intersected with the root filter (a test must match both):

```ts
export default defineConfig({
  grep: /smoke/,
  projects: [
    { name: 'android', grep: /android/ }, // runs tests matching BOTH /smoke/ and /android/
  ],
})
```

### `tapsmith test --grep-invert <pattern>`

Skip tests whose fullName matches the given regular expression. Mirrors Playwright's `--grep-invert`.

```bash
npx tapsmith test --grep-invert slow          # Run everything except "slow" tests
npx tapsmith test -g checkout --grep-invert wip  # Checkout tests, excluding work-in-progress
```

Also configurable in `tapsmith.config.ts` as `grepInvert: RegExp | RegExp[]`, with per-project entries unioned with the root entry.

### `tapsmith test --project <name>`

Run only the named [project](#projects) from your config. Repeat the flag to run
several. Mirrors Playwright's `--project`. Any [dependencies](#projects) of the
selected projects run automatically, so setup projects are never skipped.

```bash
npx tapsmith test --project android              # Only the "android" project (+ its deps)
npx tapsmith test --project android --project ios # Both platforms
```

The flag requires a `projects` array in your config. An unknown name fails the
run with the list of available projects. Combine with file arguments to further
narrow a project to specific test files:

```bash
npx tapsmith test --project android tests/login.test.ts
```

### `tapsmith test --watch` / `tapsmith test -w`

Watch test files for changes and re-run them automatically. The daemon, device, and agent are kept alive across re-runs, so only the app reset + test execution cost is paid (~1-2s per re-run).

```bash
npx tapsmith test --watch
npx tapsmith test -w tests/login.test.ts   # Watch a specific file
```

See [Watch Mode](watch-mode.md) for details.

### `tapsmith test --ui`

Open the interactive UI mode in the browser. Provides a web-based test runner with a test tree, click-to-run, live progress, and an MCP endpoint for AI agent integration.

```bash
npx tapsmith test --ui
npx tapsmith test --ui --ui-port 8080   # Use a specific port
```

See [UI Mode](ui-mode.md) for details.

### `tapsmith test --config <path>` / `tapsmith test -c <path>`

Use a specific config file instead of the default `tapsmith.config.ts`:

```bash
npx tapsmith test -c tapsmith.config.ci.ts
npx tapsmith test --config=./configs/ios.config.mjs
```

### `tapsmith test --force-install`

Reinstall the app under test (APK or `.app`) on every device the run sets up, even when the installed build already matches. Applies in every mode: the sequential run, each `--workers` worker, and the workers watch and UI mode start (a UI worker respawned mid-session does not reinstall). The Tapsmith agent is not reinstalled by this flag. Useful when the app's installed state has drifted outside Tapsmith — a rebuilt APK is already detected and reinstalled without it.

```bash
npx tapsmith test --force-install
```

Without this flag, Tapsmith checks if the package is already installed and skips the install step to save time.

### `tapsmith init`

Run the interactive setup wizard. Detects your environment (ADB, Xcode, simulators, emulators), walks you through platform and app configuration, and generates a `tapsmith.config.ts` file and an example test.

```bash
npx tapsmith init
```

### `tapsmith doctor`

Run a non-interactive system health check. Verifies all prerequisites: Node.js version, daemon binary, ADB (Android), agent APKs, AVD system image compatibility, Xcode (iOS), simulators, and network capture dependencies. Exits with code 0 if all checks pass, 1 if any hard errors.

```bash
npx tapsmith doctor
```

### `tapsmith telemetry [status|enable|disable] [--json]`

Show or switch the anonymous usage telemetry described in [Telemetry](telemetry.md). `status` (the default) says whether this process would report and, if not, which switch decided it: the environment (`TAPSMITH_TELEMETRY`, `DO_NOT_TRACK`), the project config (`telemetry: false`), or the machine-wide switch. `disable` turns it off for every project on this machine by writing to `~/.tapsmith/telemetry.json`; `enable` turns it back on (it cannot override the environment or a config opt-out). `--json` emits the status object for scripting. Pass `-c <file>` to consult a specific config.

```bash
npx tapsmith telemetry            # status
npx tapsmith telemetry disable
npx tapsmith telemetry enable
npx tapsmith telemetry status --json
```

### `tapsmith create-avd [--api <level>] [--name <name>] [--device <profile>] [--abi <abi>] [--force] [--install-tools]`

Create an Android AVD that supports HTTPS network capture. Downloads a **Google APIs** system image with `sdkmanager` and creates the AVD with `avdmanager` — Google Play images (the ones Android Studio preselects) block `adb root`, so Tapsmith cannot decrypt HTTPS traffic on them (see [Android emulator image requirements](./network.md#android-emulator-image-requirements)).

If the Android SDK command-line tools are missing (Android Studio doesn't install them by default), the command offers to download and install them into `$ANDROID_HOME/cmdline-tools/latest` for you — pass `--install-tools` to skip the prompt in scripts/CI. When no `java` is available, Android Studio's bundled JDK is used automatically. A system image that is already installed is not re-downloaded.

Defaults: API level 36, name `Tapsmith_Phone_API_<api>`, device profile `medium_phone`, ABI matching the host architecture (`arm64-v8a` on Apple Silicon, `x86_64` on Intel). `--force` overwrites an existing AVD with the same name.

```bash
npx tapsmith create-avd                         # Tapsmith_Phone_API_36
npx tapsmith create-avd --api 34 --device pixel_7
npx tapsmith create-avd --install-tools         # non-interactive bootstrap (CI)
```

### `tapsmith list-devices [--json]`

Print a table of every device Tapsmith can target: Android (ADB), iOS simulators (simctl), and iOS physical devices (devicectl). Each row shows a one-line status (`Ready` or an imperative fix). `--json` emits machine-readable JSON.

```bash
npx tapsmith list-devices
npx tapsmith list-devices --json
```

### `tapsmith show-trace <file.zip>`

Open the trace viewer in the default browser to inspect a recorded trace.

```bash
npx tapsmith show-trace test-results/traces/trace-my_test.zip
```

The trace viewer shows:
- **Actions panel** — chronological list of actions with icons, locators, and durations
- **Timeline filmstrip** — screenshot thumbnails for quick navigation
- **Screenshot panel** — before/after screenshots with tap coordinate overlays
- **Detail tabs** — Call info, Console output, Source code, View hierarchy, Network requests, Errors
- **Keyboard navigation** — Arrow keys or j/k to move between actions

### `tapsmith test --trace <mode>`

Record traces during test execution. Overrides the `trace` config option.

```bash
npx tapsmith test --trace on                    # Record all tests
npx tapsmith test --trace retain-on-failure     # Only keep traces for failures
```

### `tapsmith test --video <mode>`

Record an MP4 of the device screen for the lifetime of each test. Mirrors
Playwright's `video` flag and overrides the `video` config option. Accepts
the same mode set as `--trace`. See [Video recording](#video-recording).

```bash
npx tapsmith test --video on                    # Record every test
npx tapsmith test --video retain-on-failure     # Only keep videos for failed tests
```

## Video recording

Tapsmith records continuous screen video over the duration of each test,
mirroring Playwright's `video` config (PILOT-114). Retained videos land in
`<outputDir>/videos/` as `<safe-test-name>-<timestamp>.mp4` and are surfaced
on `TestResult.videoPath`. The HTML reporter embeds an inline `<video>`
element and a download link in each test's detail panel.

### Modes

```typescript
import { defineConfig } from 'tapsmith'

export default defineConfig({
  use: {
    video: 'retain-on-failure', // mode shorthand
    // — or —
    video: {
      mode: 'on',
      size: { width: 1280, height: 720 }, // Android only
    },
  },
})
```

The supported modes are the same as `trace`:

| Mode                        | Behaviour                                              |
| --------------------------- | ------------------------------------------------------ |
| `off`                       | No recording (default).                                |
| `on`                        | Record every test, retain every video.                 |
| `retain-on-failure`         | Record every test; keep videos only for failed tests.  |
| `retain-on-first-failure`   | Like `retain-on-failure` but limited to attempt 0.     |
| `on-first-retry`            | Record only on the first retry attempt.                |
| `on-all-retries`            | Record on every retry attempt (skips the first run).   |
| `retain-on-failure-and-retries` | Record every test; keep the video for any run that failed or that is a retry. |

**Recording cost**: `retain-on-failure` still records (and pays the video
encode cost for) every test — it only deletes the file for passing tests
afterwards. `on-first-retry` starts no recorder at all on the first attempt,
eliminating encode load on healthy runs while still producing a video for
any test flaky or broken enough to be retried. The trade-off: it requires
`retries >= 1` to ever produce a video (the runner warns at startup if
`retries` is 0), and the recorded retry won't show first-attempt-only
failures. This mirrors Playwright's `on-first-retry` caveat.

### Implementation

| Platform              | Recorder                                                   |
| --------------------- | ---------------------------------------------------------- |
| Android               | `adb shell screenrecord` (3-min hard cap per recording).   |
| iOS Simulator         | `xcrun simctl io <udid> recordVideo --codec h264`.         |
| iOS physical device   | `ffmpeg -f avfoundation` — requires `ffmpeg` on `PATH`.    |

**Android 3-minute cap**: `screenrecord` truncates at 180 seconds. Recordings
of longer tests are truncated by the device-side encoder; the daemon emits
a one-time warning per test that exceeds the cap. Chained-segment recording
is on the roadmap.

**iOS physical devices**: ffmpeg's AVFoundation backend captures the
iPhone's screen via the CoreMediaIO video device that appears on macOS once
the device is paired in Xcode and you have accepted the "Trust This
Computer" prompt. The daemon resolves the device by friendly name; if
multiple iPhones are connected, name conflicts can cause the wrong device
to be recorded. See [ios-physical-devices.md](./ios-physical-devices.md).

**`size` option**: honoured on Android only (passed through as
`screenrecord --size WxH`). On iOS the daemon emits a one-time warning and
records at native resolution.

### `tapsmith test --network` / `tapsmith test --no-network`

Enable or disable network capture when tracing. By default, network capture is enabled whenever tracing is active. Use `--no-network` to disable it.

```bash
npx tapsmith test --trace on --no-network      # Trace without network capture
```

### `tapsmith merge-reports [dir]`

Merge blob reports from sharded CI runs into a single HTML report.

```bash
# After collecting all shard blob-report/ directories:
npx tapsmith merge-reports           # reads from blob-report/
npx tapsmith merge-reports ./blobs   # custom directory
```

It checks the blobs before merging. It refuses to merge, printing a one-line error and exiting
with status 1, when:

- the directory holds no blob reports (`*.jsonl`), for example after a failed artifact download;
- a file is not a valid blob report (`Invalid blob file <name>: …`);
- a blob was written by a newer Tapsmith (its blob format is newer than this version reads);
- the sharded blobs aren't one split: a shard appears twice, the blobs come from different
  splits (say `1/3` and `2/4`), or an unsharded blob sits among sharded ones. Merge each run,
  such as Android and iOS, from its own directory. A set of unsharded blobs is merged without
  these checks.

When a shard is **missing**, the shards that are present are still merged and reported, so CI
keeps a report to triage from. The merged status is `failed`, the missing shards are named, and
the command exits 1.

Once a complete set is merged, the command exits 0 even if the merged run has failed tests.
Playwright's `merge-reports` does the same, since the shard jobs already carry the failure. The
last line gives the merged status, e.g.
`Merged 3 blob reports (shards 1–3 of 3): failed — 41 passed, 2 failed`.
A `blob` reporter in the config is skipped here, because merging reads blobs and never writes one. If
`blob` is the only reporter configured, the merge falls back to `list`.

### `tapsmith show-report [dir]`

Open the HTML test report in the default browser.

```bash
npx tapsmith show-report               # opens tapsmith-report/index.html
npx tapsmith show-report ./my-report   # custom directory
```

### iOS physical-device commands

These commands support running tests on USB-attached iPhones/iPads. See
[docs/ios-physical-devices.md](./ios-physical-devices.md) for the full
setup walkthrough.

#### `tapsmith list-devices [--json]`

Print a table of every device Tapsmith can target right now — Android (ADB),
iOS simulators (simctl), and iOS physical (devicectl) — with a one-line
status (`Ready` or an imperative fix). `--json` emits the row model for
scripting.

#### `tapsmith setup-ios-device [udid]`

Run the per-device preflight checklist for a physical iOS device: pairing,
Developer Mode, Developer Disk Image, USB transport, built agent cache,
firewall stealth mode, and the Xcode 26 CoreDevice sudo prompt probe.
Prints per-check `ok`/`fix` output and exits non-zero if anything blocks
`tapsmith test`. With no UDID, auto-selects the single attached device.

#### `tapsmith build-ios-agent [--team <id>] [--device|--simulator]`

Build the signed `TapsmithAgent` XCUITest bundle for the current device /
provisioning profile. Auto-detects the Apple Developer team ID from Xcode's
preferences (or keychain) if `--team` is omitted. The resulting
`.xctestrun` is cached under `~/.tapsmith/` and picked up automatically by
`tapsmith test`.

#### `tapsmith configure-ios-network <udid> [--ssid <name>] [--device-name <name>]`

Generate a `.mobileconfig` profile that routes the physical device's Wi-Fi
traffic through Tapsmith's MITM proxy, and reveal it in Finder so you can
AirDrop it to the device. Decrypted capture is available for clients that trust
the Tapsmith CA; pinned or embedded-root clients may need passthrough.
`--ssid` targets a specific Wi-Fi network (defaults to the host's current SSID);
`--device-name` sets the profile's `PayloadDisplayName`.

#### `tapsmith refresh-ios-network <udid>`

Regenerate the profile for a device whose host IP or Wi-Fi SSID has
changed since the last run. Same shape as `configure-ios-network` — the
difference is only wording in the output.

#### `tapsmith verify-ios-network <udid>`

End-to-end sanity check that the installed profile plus the trusted CA
actually produce decrypted HTTPS capture for a normal system-trust client.
Starts the proxy, asks you to load an HTTPS page in Safari on the device, then
reports whether Tapsmith saw the request and could decrypt the body. Exits
non-zero on failure with fix-it hints for each failure mode.

### `tapsmith --version` / `tapsmith -v`

Print the Tapsmith version.

### `tapsmith --help` / `tapsmith -h`

Show help text with available commands and options.

---

## WebView Testing

Test hybrid apps that embed WebViews (login screens, payment flows, in-app browsers, Cordova/Ionic).

### Prerequisites

- **Android**: The app must enable WebView debugging: `WebView.setWebContentsDebuggingEnabled(true)`. React Native WebView provides a `webviewDebuggingEnabled` prop.
- **iOS**: The WKWebView must set `isInspectable = true` (required since iOS 16.4). React Native WebView provides a `webviewDebuggingEnabled` prop which sets this automatically. Tapsmith connects directly to the simulator's WebKit Inspector — no external tools needed.

### `device.webview(packageName?: string): Promise<WebViewHandle>`

Switch to a WebView context. Discovers available WebViews on the device and connects via CDP (Chrome DevTools Protocol).

```typescript
const webview = await device.webview()
// or target a specific package when multiple WebViews are present
const webview = await device.webview("com.example.myapp")
```

Auto-waits for the WebView to appear up to the device timeout. Throws if no WebView is found.

### `device.native(): Promise<void>`

Switch back to native context, closing the active WebView connection.

```typescript
await device.native()
// Now you can interact with native elements again
await device.getByRole("button", { name: "Continue" }).tap()
```

### WebViewHandle

Returned by `device.webview()`. All methods use CSS selectors and auto-wait for elements.

#### `webview.click(selector: string): Promise<void>`

Click an element in the WebView.

```typescript
await webview.click("#login-button")
await webview.click(".submit-btn")
```

#### `webview.fill(selector: string, value: string): Promise<void>`

Fill an input element with text. Dispatches `input` and `change` events.

```typescript
await webview.fill("#email", "user@test.com")
await webview.fill("#password", "secret123")
```

#### `webview.textContent(selector: string): Promise<string>`

Get the text content of an element.

```typescript
const heading = await webview.textContent("h1")
```

#### `webview.innerHTML(selector: string): Promise<string>`

Get the inner HTML of an element.

#### `webview.inputValue(selector: string): Promise<string>`

Get the current value of an input element.

#### `webview.getAttribute(selector: string, name: string): Promise<string | null>`

Get an attribute value from an element.

#### `webview.isVisible(selector: string): Promise<boolean>`

Check if an element is visible: it must be rendered (have layout boxes — an ancestor with `display: none` counts as hidden) and not have `display: none`, `visibility: hidden`, or `opacity: 0`.

#### `webview.isHidden(selector: string): Promise<boolean>`

The opposite of `isVisible(selector)`: `true` when nothing matches the selector or the match is not visible. One DOM read, no auto-wait. Both string forms appear as their own row in a trace, like the locator forms.

#### `webview.evaluate<T>(expression: string): Promise<T>`

Execute arbitrary JavaScript in the WebView and return the result.

```typescript
const count = await webview.evaluate<number>("document.querySelectorAll('li').length")
const title = await webview.evaluate<string>("document.title")
```

#### `webview.goto(url: string): Promise<void>`

Navigate the WebView to a URL.

#### `webview.title(): Promise<string>`

Get the document title.

#### `webview.url(): Promise<string>`

Get the current URL.

#### `webview.locator(cssSelector: string): WebViewLocator`

Create a lazy locator for a CSS selector. Returns a `WebViewLocator` that can be used with `expect()` assertions.

```typescript
const loginBtn = webview.locator("#login-button")
await loginBtn.click()
await expect(loginBtn).toBeVisible()
```

#### `webview.getByText(text, options?)` and friends

Playwright-style locators for DOM elements, mirroring the native `device.getBy*` API:

| Method | Matches |
|---|---|
| `webview.getByText(text, { exact? })` | Leaf elements by visible text (substring by default) |
| `webview.getByRole(role, { name? })` | ARIA/HTML role, optionally filtered by accessible name |
| `webview.getByPlaceholder(text)` | `placeholder` attribute |
| `webview.getByTestId(testId)` | `data-testid` attribute |
| `webview.getByLabel(text)` | `aria-label` attribute |

```typescript
await webview.getByRole("button", { name: "Login" }).click()
await webview.getByPlaceholder("Enter your email").fill("user@test.com")
await expect(webview.getByText("Welcome back")).toBeVisible()
```

#### `webview.close(): Promise<void>`

Close the WebView connection. Usually called via `device.native()` instead.

### WebViewLocator

Lazy reference to an element within a WebView, created by `webview.locator()` or the `webview.getBy*` methods. Supports actions and assertions.

**Actions & queries (strict):** `click()`, `fill(value)`, `textContent()`, `innerHTML()`, `inputValue()`, `getAttribute(name)`, `isVisible()`, `isHidden()` (both a single DOM read with no auto-wait — the same non-waiting contract as on `ElementHandle`, minus the native probe's stale-snapshot re-reads, which a DOM query does not need)

**Narrowing & multi-element (strict-mode exempt):**

- `.first()` / `.last()` / `.nth(index)` — narrow to one match positionally (negative `nth` counts from the end). Returns a new `WebViewLocator`.
- `.count()` — number of elements currently matching (no auto-wait).
- `.all()` — one positionally-narrowed locator per current match.

WebView locators are [strict](#strict-mode): acting or asserting on a locator that resolves to more than one DOM element throws a `StrictModeViolationError` listing the matches.

```typescript
const rows = webview.locator("li.result")
await expect(rows.first()).toBeVisible()
console.log(await rows.count())
for (const row of await rows.all()) {
  console.log(await row.textContent())
}
```

### WebView Assertions

`expect(webview.locator(selector))` returns WebView-specific assertions:

```typescript
await expect(webview.locator(".header")).toBeVisible()
await expect(webview.locator(".header")).toHaveText("Welcome")
await expect(webview.locator(".header")).toContainText("Welc")
await expect(webview.locator(".error")).toBeHidden()
await expect(webview.locator("#email")).toExist()
await expect(webview.locator("#email")).toHaveValue("user@test.com")
await expect(webview.locator("a")).toHaveAttribute("href", "/about")
```

All assertions support `.not` and a `{ timeout }` option:

```typescript
await expect(webview.locator(".spinner")).not.toBeVisible()
await expect(webview.locator(".loaded")).toBeVisible({ timeout: 10_000 })
```

## MCP Server

Tapsmith includes a built-in MCP server that lets AI coding agents interact with devices, run tests, and inspect results. It supports two transport modes:

- **SSE mode** (via `tapsmith test --ui`) -- agent shares the UI session with full test tree, results, watch mode, and mutual exclusion. 16 tools available.
- **Stdio mode** (client-launched `tapsmith mcp-server`) -- standalone agent with its own headless test session, daemon, and device. Includes test discovery, results, watch mode, stop, and session info. 16 tools available.

See the [MCP Server Guide](mcp-server.md) for setup instructions, the full tool reference, and the recommended workflow.
