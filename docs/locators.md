# Locators Guide

Locators are how you tell Tapsmith which UI element to interact with. Tapsmith exposes them as Playwright-style `getBy*` methods on `Device` and `ElementHandle`. The guiding principle: **tests should interact with the app the way users do.**

Locators that reflect what users see and what assistive technologies read are preferred over locators that depend on implementation details. This makes your tests more resilient to refactors and ensures your app remains accessible.

## Priority Hierarchy

| Priority | Methods | When to use |
|---|---|---|
| 1 (preferred) | `getByRole()`, `getByText()`, `getByDescription()` | Default choice. Reflects what users see. |
| 2 (acceptable) | `getByPlaceholder()` | For text inputs without an associated label. |
| 3 (escape hatch) | `getByTestId()`, `locator({ id })`, `locator({ className })` | When no user-visible attribute works. |
| 4 (discouraged) | `locator({ xpath })` | Last resort, Android-only. |

## Cross-Platform Considerations

Tapsmith supports both Android and iOS. Most locators work identically on both platforms, but there is one important difference to be aware of when writing cross-platform tests.

### Child text inside labeled containers

On iOS, when a component has an explicit `accessibilityLabel`, child text elements are **hidden from the accessibility tree**. The parent becomes a single accessible element with only its label visible. On Android, child text remains individually queryable through UIAutomator.

```tsx
// React Native component
<Pressable accessibilityLabel="Login Form" accessibilityRole="button">
  <Text>Login Form</Text>
  <Text>Text inputs, buttons, focus/blur, keyboard</Text>  {/* ← hidden on iOS */}
</Pressable>
```

On Android, `device.getByText("Text inputs, buttons, focus/blur, keyboard")` finds the child `Text` element. On iOS, this text does not exist in the accessibility tree — only the parent with description `"Login Form"` is visible.

**Recommended cross-platform patterns:**

1. **Target the parent by role or description**, not the child text:
   ```typescript
   await device.getByRole("button", { name: "Login Form" }).tap()
   await device.getByDescription("Login Form").tap()
   ```

2. **Use `getByTestId()` for elements that must be individually addressable:**
   ```typescript
   await expect(device.getByTestId("login-description")).toBeVisible()
   ```

3. **Use a separately accessible status element** for verifying state changes:
   ```typescript
   // Instead of checking child text inside a labeled container:
   // ✗ await expect(device.getByText("Long pressed!")).toBeVisible()

   // Check a dedicated status element with its own testID:
   // ✓ await expect(device.locator({ id: "last-gesture" })).toHaveText("Last gesture: Long press")
   ```

## Priority 1 — Accessible Locators (Preferred)

These match what real users and assistive technologies see. They should be your default choice.

### `getByRole(role, { name? })`

Find an element by its accessibility role, optionally filtered by its accessible name. This is the **top recommended locator** because it verifies your app is accessible while also being resilient to implementation changes.

```typescript
// Find a button labeled "Submit"
await device.getByRole("button", { name: "Submit" }).tap()

// Find a text field labeled "Email"
await device.getByRole("textfield", { name: "Email" }).type("user@example.com")

// Find a checkbox
await device.getByRole("checkbox", { name: "Remember me" }).tap()

// Find a switch toggle
await device.getByRole("switch", { name: "Dark mode" }).tap()
```

Supported roles map to platform-native element types. On iOS, many React Native components render as `XCUIElementTypeOther` — Tapsmith identifies roles from accessibility traits (e.g. a `Pressable` with `accessibilityRole="button"` gets the button trait) and falls back to matching `.other` elements by name. Native iOS and Android apps use typed elements that map directly.

| Role | Android classes | iOS types |
|---|---|---|
| `button` | `Button`, `ImageButton`, Material/AppCompat variants | `XCUIElementTypeButton`, `.other` with button trait |
| `textfield` | `EditText` | `XCUIElementTypeTextField`, `XCUIElementTypeSecureTextField` |
| `checkbox` | `CheckBox` | `XCUIElementTypeCheckBox`, `.other` (RN fallback) |
| `switch` | `Switch` | `XCUIElementTypeSwitch`, `XCUIElementTypeToggle` |
| `radiobutton` | `RadioButton` | `XCUIElementTypeRadioButton`, `.other` (RN fallback) |
| `heading` | RN `accessibilityRole="header"` / native `isHeading` | `.other` with header trait, `XCUIElementTypeStaticText` with header trait |
| `link` | RN `accessibilityRole="link"` | `XCUIElementTypeLink`, `.other` with link trait |
| `image` | `ImageView` or RN `accessibilityRole="image"` | `XCUIElementTypeImage`, `.other` with image trait |
| `text` | `TextView` | `XCUIElementTypeStaticText` |
| `alert` | RN `accessibilityRole="alert"` | `.other` (RN — matched by name) |
| `progressbar` | `ProgressBar` | `XCUIElementTypeProgressIndicator` |
| `seekbar` / `slider` | `SeekBar` | `XCUIElementTypeSlider`, `.other` with adjustable trait |
| `combobox` | RN `accessibilityRole="combobox"` | `.other` (RN — matched by name) |
| `searchfield` | `SearchView` | `XCUIElementTypeSearchField`, `.other` with search trait |
| `spinner` | `Spinner` | `XCUIElementTypePicker`, `XCUIElementTypeActivityIndicator` |
| `toolbar` | `Toolbar` | `XCUIElementTypeToolbar` |
| `tab` | `TabLayout` | `XCUIElementTypeTab`, `XCUIElementTypeTabBar` |

> **React Native note:** RN components that set `accessibilityRole` (e.g. `accessibilityRole="button"`) expose the corresponding iOS accessibility trait, and `getByRole` will find them. Components that don't set `accessibilityRole` (common in many RN apps) render as generic `XCUIElementTypeOther` with no role — use `getByText`, `getByPlaceholder`, or `getByDescription` instead.

#### Making React Native apps testable (and accessible)

Adding accessibility props to your RN components makes them both testable with `getByRole` and accessible to screen readers — a single change that improves both. The key props:

```tsx
// ✗ Invisible to getByRole — renders as generic XCUIElementTypeOther
<TouchableOpacity onPress={handleSubmit}>
  <Text>Sign in</Text>
</TouchableOpacity>

// ✓ Found by getByRole("button", { name: "Sign in" })
<TouchableOpacity
  onPress={handleSubmit}
  accessibilityRole="button"
  accessibilityLabel="Sign in"
>
  <Text>Sign in</Text>
</TouchableOpacity>
```

Common components and their recommended props:

| Component | Props to add | Tapsmith locator |
|---|---|---|
| `TouchableOpacity` / `Pressable` | `accessibilityRole="button"` | `getByRole("button", { name: "..." })` |
| `TextInput` | `accessibilityLabel="Email"` | `getByRole("textfield", { name: "Email" })` or `getByPlaceholder(...)` |
| `Switch` | `accessibilityRole="switch"`, `accessibilityLabel="..."` | `getByRole("switch", { name: "..." })` |
| `Image` | `accessibilityRole="image"`, `accessibilityLabel="..."` | `getByRole("image", { name: "..." })` |
| Section headers | `accessibilityRole="header"` | `getByRole("heading", { name: "..." })` |
| Links | `accessibilityRole="link"` | `getByRole("link", { name: "..." })` |

> **Tip:** If you can't modify the app, `getByText` and `getByPlaceholder` work without any accessibility props. `getByRole` is preferred when the props are available because it verifies both the element's function and its text, making tests more precise.

### `getByText(text, { exact? })`

Find an element by its visible text content. **Substring match by default**, like Playwright. Pass `{ exact: true }` for an exact match.

```typescript
// Substring match — finds elements containing "Welcome"
await expect(device.getByText("Welcome")).toBeVisible()

// Exact match
await device.getByText("Sign In", { exact: true }).tap()

// Useful for dynamic content
await expect(device.getByText("3 items")).toBeVisible()
```

> **Strict mode:** because of the substring default, `getByText("Sign in")` also matches longer text such as `"Sign in to continue"`. A locator that resolves to more than one element throws a `strict mode violation` when you act or assert on it (instead of silently using the first match). Disambiguate with `{ exact: true }`, `getByRole(role, { name })`, `getByTestId()`, or `.first()/.nth()/.last()`. Absence checks (`toBeHidden`, `not.toBeVisible`, `waitFor({ state: "hidden" })`) and multi-element APIs (`count()`, `all()`, `toHaveCount`) are exempt. See the [API reference](api-reference.md#strict-mode) for the full rules. WebView locators (`webview.getBy*`, `webview.locator(css)`) enforce the same rules.

### `getByDescription(text)`

Find an element by its accessibility description. On Android this matches `contentDescription`; on iOS it matches `accessibilityLabel`. Use this for icon buttons, images, and elements where the accessible label differs from visible text.

On iOS, `getByText` also matches `accessibilityLabel`, so both work for text-bearing elements. Prefer `getByDescription` for elements that have an explicit accessibility description but no visible text (e.g. icon-only buttons).

```typescript
// Tap an icon button with a description
await device.getByDescription("Close menu").tap()

// Verify an image is present
await expect(device.getByDescription("Profile photo")).toBeVisible()
```

## Priority 2 — Placeholder Locator

### `getByPlaceholder(text)`

Find an input by its placeholder / hint text. Useful for text fields that do not have a separate visible label.

```typescript
await device.getByPlaceholder("Enter your email").type("user@example.com")
await device.getByPlaceholder("Password").type("secret123")
```

## Priority 3 — Test IDs and Native Locators (Escape Hatch)

These are invisible to users. Use them only when no accessible attribute uniquely identifies the element. The ESLint plugin will warn when you reach for them.

### `getByTestId(id)`

Find an element by a dedicated test identifier.

```typescript
await device.getByTestId("submit-button").tap()
```

On Android, `getByTestId` matches React Native's `testID` prop (mapped to a content-description prefix). On iOS, it matches the `accessibilityIdentifier`.

### `locator({ id })`

Find an element by its native resource id. On Android this is the `R.id.foo` resource id; on iOS, the `accessibilityIdentifier`.

```typescript
await device.locator({ id: "com.myapp:id/email_input" }).type("user@example.com")

// Short form also works if the package prefix is unambiguous
await device.locator({ id: "email_input" }).type("user@example.com")
```

> **Warning:** Resource IDs are implementation details. They break when views are refactored, renamed, or replaced. Prefer accessible locators whenever possible.

### `locator({ className })`

Find an element by its native widget class name. Use this when no role mapping covers a custom widget.

```typescript
await device.locator({ className: "com.myapp.widget.ColorPicker" }).tap()
```

> **Tip:** For standard Android widgets, prefer `getByRole()`. The ESLint plugin warns when `locator({ className })` is used for widgets that have well-known roles.

## Priority 4 — XPath (Discouraged, Android-only)

### `locator({ xpath })`

Find an element using an XPath expression on the view hierarchy. Fragile, verbose, tightly coupled to the view structure, and **Android-only** (iOS does not support XPath). Use only as a last resort.

```typescript
// Custom compound view with no accessible attributes
await device.locator({
  xpath: "//android.widget.LinearLayout[@index='2']/android.widget.Button[1]",
}).tap()
```

> **Warning:** The ESLint plugin requires an explanatory comment on the same or preceding line whenever `locator({ xpath })` is used. If you find yourself reaching for XPath, consider whether adding accessibility attributes to the app would be a better long-term solution.

## Chaining and Scoping

`getBy*` and `locator()` are also available on every `ElementHandle`. Calling them on a parent locator scopes the search to its descendants — exactly like Playwright's `locator.locator(...)`.

```typescript
// Find "Item 3" inside a specific list
const item = device.getByRole("list", { name: "Shopping cart" }).getByText("Item 3", { exact: true })
await expect(item).toBeVisible()

// Tap the delete button inside a specific row
await device.getByTestId("row-5").getByRole("button", { name: "Delete" }).tap()
```

Scoping is **lazy** — no queries are made until you call an action or assertion.

## Choosing the Right Locator

Follow this decision process:

1. **Can you identify the element by its role and name?** Use `getByRole()`.
2. **Does the element have unique visible text?** Use `getByText()`.
3. **Is it an icon or image with a description?** Use `getByDescription()`.
4. **Is it a text input with a placeholder?** Use `getByPlaceholder()`.
5. **None of the above work?** Use `getByTestId()` or `locator({ id })`.
6. **Custom widget with no standard role?** Use `locator({ className })`.
7. **Nothing else works on Android?** Use `locator({ xpath })` with an explanatory comment.

## ESLint Plugin

Tapsmith includes an ESLint plugin that enforces locator best practices in your test files.

### Setup

```javascript
// eslint.config.js (flat config)
import { eslintPlugin } from "tapsmith"

export default [
  {
    plugins: {
      tapsmith: eslintPlugin,
    },
    rules: {
      ...eslintPlugin.configs.recommended.rules,
    },
  },
]
```

### Rules

| Rule | Default | Description |
|---|---|---|
| `tapsmith/prefer-role` | warn | Suggests `getByRole()` instead of `locator({ className })` for standard Android widgets. |
| `tapsmith/no-bare-locator-xpath` | error | Requires an explanatory comment when using `locator({ xpath })`. |
| `tapsmith/prefer-accessible-locators` | warn | Suggests accessible getters instead of `getByTestId()` or `locator({ id })`. |
| `tapsmith/prefer-app-reset-option` | warn | Suggests `test.use({ appReset, appResetScope })` when a `beforeEach` only restarts or clears the app. |
