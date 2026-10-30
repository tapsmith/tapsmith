# Locators Guide

Locators are how you tell Tapsmith which UI element to interact with. Tapsmith exposes them as Playwright-style `getBy*` methods on `Device` and `ElementHandle`. The guiding principle: **tests should interact with the app the way users do.**

Locators that reflect what users see and what assistive technologies read are preferred over locators that depend on implementation details. This makes your tests more resilient to refactors and ensures your app remains accessible.

## Finding locators

Don't guess a locator and wait out a timeout to learn it was wrong. Ask the app what is on screen:

- **Pick it in UI mode.** Run `npx tapsmith test --ui`, drive the app to the screen you are testing, click the pick button (crosshair) in the device mirror, then click the element. The **Locator** tab lists suggested locators, each checked by the device to find exactly that element. Copy one into your test. Edit it in the tab to see its match count change live. See [Picking locators from the mirror](ui-mode.md#picking-locators-from-the-mirror).
- **Ask your coding agent.** With the [MCP server](mcp-server.md) registered, `tapsmith_snapshot` lists the screen's elements with locators the device has checked, and `tapsmith_test_locator` counts how many elements a locator matches on the live screen. A locator is ready for a test when it counts exactly 1. [Using Tapsmith with AI coding agents](agents.md#the-locator-loop) gives your agent the whole loop.

### Locators that match nothing

When a locator still matches nothing, the error says what does. At the timeout, Tapsmith asks the device how the same words match under the other getters, and lists the locators that find something:

```
Element getByRole("button", { name: "Sign in" }) was not found after waiting 30000ms. Nothing matches it, but on screen now this locator matches: getByText("Sign in") (1 element). … To find a locator that matches, pick the element in UI mode (npx tapsmith test --ui) or check one with the MCP tool tapsmith_test_locator.
```

It checks `getByText()`, `getByLabel()`, `getByPlaceholder()` and `getByDescription()` with the same words, words that end in punctuation also without it under `getByText()` and `getByDescription()` (so a miss of `getByText("Forgot password?")` on a link [labelled `"Forgot password"`](#child-text-inside-labeled-containers) names `getByDescription("Forgot password")`), and a `getByRole()` again without `exact` or its state filters. If only the role matches, it says so: `getByRole("button") matches 3 elements on screen now, none named "Sign in".` It lists at most three near misses. The check takes at most 2 seconds, and never longer than the locator itself waited. A read with a timeout of 0 skips it. The checks only run for a locator built straight from `device`, with a string (not a RegExp) and without `.first()`, `.filter()`, `.and()`, `.or()` or a parent locator. Other locators get only the pointer to the picker. A miss of `.nth(i)` past the first or last element reports the index instead, since the locator itself may well match. The screen may have changed since the test needed the element, so treat a near miss as a lead and check it before using it.

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

### What locators never match

Some of what is on the screen, and in the hierarchy the trace viewer shows, is not the app's own content. No locator matches it, on either platform:

- **The software keyboard.** Its keys, its return, globe, emoji and dictation buttons, and the bar of typing predictions above it, so a *Done* button beside an open keyboard is not ambiguous with the keyboard's *Done* key. A toolbar the app shows above the keyboard (an input accessory view) is the app's, and matches.
- **The iOS application element**, whose label is the app's name. `getByText("App")` does not match it in an app called *My App*.
- **Android's status and navigation bars**: their clock, icons and *Back* / *Home* buttons.
- **The `@tapsmith/react-native` hooks marker** ([warm reset](warm-reset.md)), which exists only for Tapsmith to read.

Other windows on Android do match: a notification shade or quick settings panel you pull down (`device.openNotifications()`), a heads-up notification, the app's own overlay windows, system dialogs, and other apps' windows the app opens, such as a permission dialog.

XPath (`locator({ xpath })`, Android only) is the exception: it evaluates the raw hierarchy dump.

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

As in Playwright, `name` is a **case-insensitive substring match** by default, so `{ name: "sign in" }` finds a button labelled `SIGN IN` (how Android renders React Native's `<Button title="Sign In">`) or `Sign in now`. Pass `exact: true` for a case-sensitive, whole-string match — needed when one name is part of another on the same screen:

```typescript
await device.getByRole("button", { name: "Show overlay", exact: true }).tap()  // not "Show overlay briefly"
```

Supported roles map to platform-native element types. On iOS, many React Native components render as `XCUIElementTypeOther` — Tapsmith identifies roles from accessibility traits (e.g. a `Pressable` with `accessibilityRole="button"` gets the button trait) and, for roles iOS has no trait for, from the role description React Native puts in the element's accessibility value (`"checkbox, unchecked"`). A plain `.other` element with neither is never matched by an unnamed `getByRole()`; a named one (`getByRole("alert", { name: "…" })`) still finds it by its name, unless a role trait or another of those descriptions marks it as a different role. React Native's new architecture publishes a description only for `checkbox` and `radio`, so an unnamed `alert`, `combobox` or generic-view role query (below) that finds nothing on iOS says so in its error and suggests the named form. Native UIKit and Android View apps use typed elements that map directly. Jetpack Compose builds its accessibility tree from semantics instead: see [Jetpack Compose](#jetpack-compose) below for how its controls are found.

| Role | Android classes | iOS types |
|---|---|---|
| `button` | `Button`, `ImageButton`, `ToggleButton` (also RN `accessibilityRole="togglebutton"`), Material/AppCompat variants | `XCUIElementTypeButton`, `.other` with button trait (RN `togglebutton` too) |
| `textfield` | `EditText`, single- or multi-line | `XCUIElementTypeTextField`, `XCUIElementTypeSecureTextField`, `XCUIElementTypeTextView` (a multi-line input: React Native's `<TextInput multiline />`, a `UITextView`, a SwiftUI `TextEditor`) |
| `checkbox` | `CheckBox` | `XCUIElementTypeCheckBox`, `.other` described as a checkbox (RN), or a named `.other` |
| `switch` | `Switch`, `SwitchCompat`, `SwitchMaterial`, or the "Switch" role description (Compose `Switch`) | `XCUIElementTypeSwitch`, `XCUIElementTypeToggle` |
| `radiobutton` / `radio` | `RadioButton` | `XCUIElementTypeRadioButton`, `.other` described as a radio button (RN), or a named `.other` |
| `heading` | RN `accessibilityRole="header"` / native `isHeading` | any element with the header trait (plain static text is `text`, not a heading) |
| `link` | RN `accessibilityRole="link"` | `XCUIElementTypeLink`, `.other` with link trait |
| `image` | `ImageView` or RN `accessibilityRole="image"` | `XCUIElementTypeImage`, `.other` with image trait |
| `text` | `TextView` | `XCUIElementTypeStaticText` |
| `alert` | RN `accessibilityRole="alert"` (an `AlertDialog`, including React Native's `Alert.alert`, has no alert role on Android: find it by its text or buttons) | `XCUIElementTypeAlert` — a native alert (SwiftUI `.alert`, a `UIAlertController` alert, React Native's `Alert.alert`), named by its title; `.other` or static text described as an alert (RN old architecture), or a named `.other` or static text outside a native alert — React Native's `<Text accessibilityRole="alert">` is plain static text on iOS, so `getByRole("alert", { name: "Failed to fetch posts" })` finds it and an unnamed query can't |
| `progressbar` | `ProgressBar` (determinate or not) or RN `accessibilityRole="progressbar"` | `XCUIElementTypeProgressIndicator`, `XCUIElementTypeActivityIndicator` (an indeterminate `ProgressView` or `UIActivityIndicatorView`, which `toHaveRole()` reports as `progressbar`) |
| `seekbar` / `slider` | `SeekBar` | `XCUIElementTypeSlider`, `.other` with adjustable trait |
| `combobox` | RN `accessibilityRole="combobox"` | `.other` described as a combo box (RN old architecture), or a named `.other` |
| `searchfield` / `search` | `SearchView` (RN `accessibilityRole="search"` is a plain `EditText` on Android, so a `textfield` there) | `XCUIElementTypeSearchField`, `.other` with search trait |
| `spinner` | `Spinner` (a dropdown) | `XCUIElementTypePicker`, and `XCUIElementTypeActivityIndicator` for compatibility (prefer `progressbar` for a loading indicator: it is the same on both platforms and in ARIA) |
| `toolbar` | `Toolbar` or RN `accessibilityRole="toolbar"` | `XCUIElementTypeToolbar` |
| `tab` | a tab item publishing the "Tab" role description: RN `accessibilityRole="tab"` (e.g. React Navigation bottom tabs), Material `TabLayout` and `BottomNavigationView` items, Compose `Role.Tab` | `XCUIElementTypeTab`, or a button inside an `XCUIElementTypeTabBar` (a `UITabBar`'s items) |
| `tablist` | `TabWidget`, `TabLayout`, or RN `accessibilityRole="tablist"` | `XCUIElementTypeTabBar`, or a named `.other` (RN) |
| `list` | `ListView`, `GridView`, `RecyclerView` | `XCUIElementTypeTable`, `XCUIElementTypeCollectionView` |
| `listitem` | `LinearLayout`, `RelativeLayout`, `FrameLayout` | `XCUIElementTypeCell` |
| `scrollview` | `ScrollView`, `HorizontalScrollView`, `NestedScrollView` | `XCUIElementTypeScrollView` |
| `radiogroup` | `RadioGroup`, or RN `accessibilityRole="radiogroup"` | `XCUIElementTypeRadioGroup`, or a named `.other` (RN) |
| `spinbutton` | `NumberPicker` (it reports no name of its own: find it by role alone or by scoping), or RN `accessibilityRole="spinbutton"` | `XCUIElementTypeStepper` (a `Stepper` or `UIStepper`), or a named `.other` (RN) |
| `timer` | `Chronometer` (Android names it by the time it shows, `"5 seconds"`, whatever its `contentDescription`, so find a running one by role alone, by scoping or by test id), or RN `accessibilityRole="timer"` | a named `.other` (RN) |
| `menu`, `menubar`, `menuitem` | RN `accessibilityRole` of the same name | `XCUIElementTypeMenu`, `XCUIElementTypeMenuBar`, `XCUIElementTypeMenuItem`, or a named `.other` (RN) |
| `scrollbar`, `summary` | RN `accessibilityRole` of the same name | a named `.other` (RN) |

Role names are case-insensitive. Any other role throws as soon as the locator is built — `Unknown role "row". Supported: alert, button, …` — instead of waiting out the timeout. Playwright's ARIA names that differ here get a hint (`textbox` → `textfield`, `img` → `image`, `searchbox` → `searchfield`, `alertdialog` and `dialog` → `alert`), and so does React Native's `togglebutton`, which is a `button` on both platforms (as an ARIA toggle button is) — check its state with `toBeChecked()`. WebView locators (`webview.getByRole()`) take the page's ARIA roles instead.

> **Native iOS alerts:** a SwiftUI `.alert`, a `UIAlertController` alert and React Native's `Alert.alert` are one `XCUIElementTypeAlert`, which `getByRole("alert")` finds with or without a name and `toHaveRole("alert")` confirms. Its name is its title, and the text and views inside it are not alerts, so `getByRole("alert", { name: "Delete file?" })` finds the alert alone; scope its buttons to it with `alert.getByRole("button", { name: "Delete" })`. Scoped to the alert, a query finds only what is in the alert, never the app's views behind it, so `alert.getByRole("button")` counts the alert's own buttons. Action sheets and confirmation dialogs (`XCUIElementTypeSheet`) have no role: find them by their buttons or text.

> **Lists in React Native:** `list` and `listitem` match native list widgets. A React Native `FlatList`, `SectionList` or `ScrollView` and its rows are not those widgets, so `getByRole("list")` finds nothing in them. Give the list a `testID` and target it with `getByTestId()`; target a row by its text, or by `getByRole("button")` when the row is a `Pressable` or `TouchableOpacity` with `accessibilityRole="button"`.

> **React Native's generic-view roles:** `menu`, `menubar`, `menuitem`, `radiogroup`, `scrollbar`, `spinbutton`, `summary`, `timer` and (in React Native) `tablist` are generic views in React Native, beside whatever native widget has the role (the table above). On Android, React Native publishes each as a role description, so `getByRole("menuitem")` finds every menu item. On iOS React Native publishes nothing Tapsmith reads for them, so give the query a name — `getByRole("menuitem", { name: "Copy" })` — which finds a generic view with that label, as for `alert` and `combobox`. iOS reports no role for those views, so `toHaveRole()` can't confirm one there, and it reports a React Native `Text` as static text whatever its role. A named `alert` query also matches static text, but these roles' queries don't (a named `menuitem` query would also match the label text beside one): put the role on an `accessible` `View` (`<View accessible accessibilityRole="timer" accessibilityLabel="Elapsed time">`) for iOS to find it. React Native publishes the descriptions in the device's language and Tapsmith reads only the English ones, so on Android run these queries on a device set to English (the same holds for `alert`, `combobox`, `tab`, `progressbar` and `toolbar`).
>
> **Native menus:** neither platform shows an open menu as menu elements. On iOS a SwiftUI `Menu`'s or a `UIMenu`'s items are buttons in a list (`getByRole("button", { name: "Rename" })`), and on Android a `PopupMenu`'s are list rows (`getByText("Rename")`). The iOS `menu`, `menubar` and `menuitem` types above match only where XCUITest reports an element of that type.

> **Tabs:** `tab` matches a tab *item*, and `tablist` the bar that holds the items. On iOS a `UITabBar`'s items — expo-router `NativeTabs` (the `create-expo-app` template), UIKit's `UITabBarController`, SwiftUI's `TabView` — are buttons inside the bar, so `getByRole("tab", { name: "Explore" })` finds the item and `getByRole("tablist")` the bar. Those items still match `getByRole("button")` too, but `toHaveRole()` reports them as `tab`. On Android a tab item is known by the "Tab" role description React Native, Material's `TabLayout` and `BottomNavigationView`, and Compose publish. Each publishes it in the device's language and Tapsmith reads only the English word, so run `tab` queries on an Android device set to English. React Navigation's bottom tabs are `tab`s on Android, but on iOS React Navigation gives them the `button` role and a label like `"Settings, tab, 2 of 4"`, so `getByRole("button", { name: "Settings" })` finds them there. A tab bar whose items publish no role at all (a custom tab bar built from plain views) has no `tab` to find: use `getByText()` or `getByDescription()`.

> **SwiftUI toggles:** iOS exposes a SwiftUI `Toggle` as a switch the size of its row, named by its label, with the switch's knob inside it as a second, unnamed switch. Tapsmith treats the pair as the one control it is: `getByRole("switch")` finds one switch per `Toggle`, named and checked like the row, and `tap()` and `setChecked()` touch the knob, since a `Toggle` in a `Form` ignores a touch on the rest of its row. A UIKit `UISwitch` is a single switch.

#### Jetpack Compose

Compose controls are found by role and name the way TalkBack reads them. A Material3 `Button`, a `NavigationBarItem`, an `IconButton` or a row made toggleable with `Modifier.toggleable(role = Role.Checkbox)` is one element: its role comes from the control's `Role`, and its name from the text (or `contentDescription`) of what it contains. So `getByRole("button", { name: "Sign in" })` finds `Button(onClick) { Text("Sign in") }`, `getByRole("tab", { name: "Items" })` a navigation bar item, and `getByRole("checkbox", { name: "Remember me" })` the toggleable row below. `checked`, `selected` and `disabled` read the control's state, and `toHaveRole()` reports its role.

A control's name is what it contains, so a `Checkbox` or `Switch` placed beside a separate `Text` has no name, for TalkBack as for Tapsmith (and for Playwright on a web page, where a checkbox needs a `<label>`). Put the text inside the control instead, which also gives the user a larger touch target:

```kotlin
Row(
    Modifier.toggleable(value = remember, onValueChange = { remember = it }, role = Role.Checkbox),
    verticalAlignment = Alignment.CenterVertically,
) {
    Checkbox(checked = remember, onCheckedChange = null) // the Row handles the click
    Text("Remember me")
}
```

A text field's `label = { Text("Email") }` is its label, so both `getByLabel("Email")` and `getByRole("textfield", { name: "Email" })` find it. Compose's `Switch` and `Tab` publish their role as a description in the device's language, which Tapsmith reads only in English, so run `switch` and `tab` queries on an Android device set to English.

`Modifier.testTag()` is not a test id by default. Compose exposes test tags to UI Automator, and so to `getByTestId()`, only where `testTagsAsResourceId` is on. Set it once on the root of your content and every tag below it becomes a test id:

```kotlin
setContent {
    MaterialTheme {
        Surface(Modifier.semantics { testTagsAsResourceId = true }) {
            App()
        }
    }
}
```

#### Flutter

Flutter draws its own widgets and publishes them to each platform's accessibility tree through its semantics, so Tapsmith finds the same elements TalkBack and VoiceOver read. Two things differ from a native app.

**A `Key` is not a test id.** `Key('login_button')` exists only inside the Flutter engine, and neither `getByTestId()` nor `locator({ id })` can find it. Wrap the widget in `Semantics(identifier: …)` instead: Flutter publishes the identifier as the Android resource id and the iOS `accessibilityIdentifier`, so `getByTestId()` finds it on both platforms:

```dart
Semantics(
  identifier: 'login_button',
  child: ElevatedButton(onPressed: _submit, child: const Text('Sign In')),
)
```

```typescript
await device.getByTestId("email_field").type("sam@example.com")
await device.getByTestId("login_button").tap()
```

**Text on Android is a description.** Flutter publishes a `Text` widget's text to Android as its content description, not as text. So on Android `getByText()` does not find it, and `getText()` and `toHaveText()` read `""`. `getByDescription()` finds it on both platforms (on iOS it reads the same label `getByText()` does):

```typescript
await expect(device.getByDescription("Welcome to ShopList")).toBeVisible()
await expect(device.getByDescription("Invalid credentials")).toBeVisible() // a SnackBar's text
```

Roles and names work on both platforms for most Material widgets, and are the first thing to reach for:

| Widget | Locator that works on both platforms | Notes |
|---|---|---|
| `ElevatedButton`, `TextButton`, `FilledButton`, … | `getByRole("button", { name: "Sign In" })` | |
| `TextField` / `TextFormField` with `labelText` | `getByRole("textfield", { name: "Email" })` | The label is found by `getByLabel()` on iOS and by `getByPlaceholder()` on Android, so neither works on both |
| `CheckboxListTile` | `getByLabel("Remember me")` | A `checkbox` on Android and a `switch` on iOS, so `getByRole()` needs the role per platform. `setChecked()` and `toBeChecked()` work on both |
| `SwitchListTile` | `getByRole("switch", { name: "Notifications" })` | |
| `ListTile` with `onTap` | `getByRole("button", { name: /Item 1(?!\d)/ })` | Named by all of its text together (leading, title and subtitle), so match part of the name: `{ name: "Price: $3.00" }` finds the row too, and the `RegExp` keeps `"Item 1"` from also matching `"Item 10"` |
| `BottomNavigationBar` item | `getByRole("button", { name: "Settings" })` | A button, not a `tab`, on both platforms |
| `AlertDialog` | its buttons by role, its title with `getByDescription()` | Flutter draws the dialog itself, so it is not a native alert and `getByRole("alert")` does not find it. Its buttons tap as usual |

An `AppBar` title is not a `heading` on either platform: find it with `getByDescription()`. When no role or name fits a widget, give it a `Semantics(identifier:)`.

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

### `getByText(text | RegExp, { exact? })`

Find an element by its visible text content. **Case-insensitive substring match by default**, like Playwright. Pass `{ exact: true }` for a case-sensitive, whole-text match.

```typescript
// Substring match — finds elements containing "Welcome", in any case
await expect(device.getByText("Welcome")).toBeVisible()

// Finds a button rendered as "GET STARTED" (e.g. textTransform: "uppercase")
await device.getByText("get started").tap()

// Exact match
await device.getByText("Sign In", { exact: true }).tap()

// Useful for dynamic content
await expect(device.getByText("3 items")).toBeVisible()

// A regular expression, for patterns
await expect(device.getByText(/^\d+ items?$/)).toBeVisible()
```

Whitespace differences don't matter for a string: non-breaking spaces, line breaks and runs of spaces in the element's text (or in your query) are treated as a single space, and leading and trailing whitespace is ignored — the same normalization Playwright applies. `getByText("Welcome to Expo")` finds a heading rendered as `Welcome to&nbsp;Expo`.

A `RegExp` (also accepted by `getByLabel` and `getByRole`'s `name`) is matched with JavaScript's semantics against the text as it is: `\s` covers non-breaking spaces, and `^`/`$` anchor the whole text unless you pass the `m` flag. See [Regular expressions](api-reference.md#regular-expressions) for the details.

On iOS, `getByText` returns the innermost element holding the text, as Playwright does: a SwiftUI `Toggle` row, a `NavigationLink` or an alert gives way to the text inside it, so `getByText("Dark Mode")` finds one element. A control's value (a switch's `1`, a slider's `50%`) is not text.

> **Strict mode:** because of the case-insensitive substring default, `getByText("Sign in")` also matches longer or differently-cased text such as `"Sign in to continue"` or a `"SIGN IN"` heading. A locator that resolves to more than one element throws a `strict mode violation` when you act or assert on it (instead of silently using the first match). Disambiguate with `{ exact: true }`, `getByRole(role, { name, exact: true })`, `getByTestId()`, or `.first()/.nth()/.last()`. Absence checks (`toBeHidden`, `not.toBeVisible`, `waitFor({ state: "hidden" })`) and multi-element APIs (`count()`, `all()`, `toHaveCount`) are exempt. See the [API reference](api-reference.md#strict-mode) for the full rules. WebView locators (`webview.getBy*`, `webview.locator(css)`) enforce the same rules.

### `getByDescription(text)`

Find an element by its accessibility description. On Android this matches `contentDescription`; on iOS it matches `accessibilityLabel`. Use this for icon buttons, images, and elements where the accessible label differs from visible text.

On iOS, `getByText` also matches `accessibilityLabel`, so both work for text-bearing elements — except a switch, slider or stepper, whose label is its accessible name rather than text on screen ([what `getByText` reads on iOS](api-reference.md#devicegetbytexttext-string--regexp-options--exact-boolean--elementhandle)). Prefer `getByDescription` for elements that have an explicit accessibility description but no visible text (e.g. icon-only buttons).

```typescript
// Tap an icon button with a description
await device.getByDescription("Close menu").tap()

// Verify an image is present
await expect(device.getByDescription("Profile photo")).toBeVisible()
```

## Priority 2 — Placeholder Locator

### `getByPlaceholder(text)`

Find an input by its placeholder / hint text. Useful for text fields that do not have a separate visible label.

A field with no label (and no title) is also *named* by its placeholder, as in Playwright, so `getByRole("textfield", { name: "Email" })` finds SwiftUI's `TextField("Email", text: $email)` too. `getByPlaceholder` still finds a field whose label differs from its placeholder.

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

On Android, `getByTestId` matches React Native's `testID` prop, which becomes the element's whole resource ID; a native view's package-qualified ID (`com.myapp:id/submit`) is found with `locator({ id })` instead. A Jetpack Compose `Modifier.testTag()` is a test id only where the app turns on `testTagsAsResourceId` ([Jetpack Compose](#jetpack-compose)). In a Flutter app it matches a `Semantics(identifier:)`, on both platforms, and never a widget's `Key` ([Flutter](#flutter)). On iOS, it matches the `accessibilityIdentifier`.

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

An XPath locator is for use on its own. `and()`/`or()` refuse an XPath operand with an error, because the agent reports an XPath match's text and bounds from a different read path than every other selector, so it could never match the other operand. Narrowing one (`filter()`, `first()`/`nth()`) and an XPath `locator()` chained off another locator still answer queries, but **actions** on the XPath match fail at the agent, which cannot act on an XPath match by id. A `getBy*` scoped off an XPath locator resolves its own match, so its actions work.

## Chaining and Scoping

`getBy*` and `locator()` are also available on every `ElementHandle`. Calling them on a parent locator scopes the search to the elements inside it, like Playwright's `locator.locator(...)`: an element is inside when its centre lies within the parent's bounds and it is not a larger element around the parent; on iOS the parent itself matches when nothing inside it does (an accessible container's children are not exposed there). Bounds rather than the accessibility tree decide, because React Native's trees often make a container's children its siblings; see [ElementHandle Scoping](api-reference.md#scoping).

```typescript
// Find "Item 3" inside a specific list (a FlatList with testID="cart-list")
const item = device.getByTestId("cart-list").getByText("Item 3", { exact: true })
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

Install ESLint (9.22 or later) and [typescript-eslint](https://typescript-eslint.io), which lets ESLint parse TypeScript:

```bash
npm install --save-dev eslint typescript-eslint
```

Then create `eslint.config.mjs` in your project root:

```javascript
// eslint.config.mjs
import { defineConfig } from "eslint/config"
import tseslint from "typescript-eslint"
import { eslintPlugin } from "tapsmith"

export default defineConfig({
  // Where your Tapsmith tests and screen objects live
  files: ["tests/**/*.ts"],
  extends: [tseslint.configs.base, eslintPlugin.configs.recommended],
  languageOptions: {
    // Type information, so a missing `await` is caught
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
  },
})
```

Run it with `npx eslint tests/`. Change `files` to match where your tests are.

- `tseslint.configs.base` sets the TypeScript parser. Without it, ESLint stops at the first type annotation with `Parsing error: Unexpected token :`.
- `eslintPlugin.configs.recommended` registers the plugin and turns on its rules (below).
- `@typescript-eslint/no-floating-promises` reports an action or assertion you forgot to `await`, such as `expect(item).toBeVisible()`. Without the `await`, the test does not wait for the action or assertion, so a failure can be missed or reported in the wrong test. This rule needs type information, so your `tsconfig.json` must include the test files. `tapsmith init` writes one that does when the project has no `tsconfig.json` (or `jsconfig.json`). If ESLint reports a file "was not found by the project service", add that folder to your tsconfig's `include`, or, in a project with no tsconfig, create this one:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["tapsmith.config.ts", "tests", "**/*.tapsmith.ts"]
}
```

The `.mjs` extension makes Node load the config as an ES module whether or not your `package.json` has `"type": "module"`.

#### Adding it to an existing config

If your project already has an ESLint config, add the object to that config instead of creating a second file. ESLint reads only one config file, and it picks `eslint.config.js` before `eslint.config.mjs`, so a new file would be ignored.

Expo's `npx expo lint` creates an `eslint.config.js` that uses `require`, and installs ESLint with `eslint-config-expo`, which already sets up typescript-eslint for `.ts` files. So in an Expo project, skip the install step above and add an object like this to the array passed to `defineConfig`:

```javascript
// eslint.config.js
const { defineConfig } = require("eslint/config")
const expoConfig = require("eslint-config-expo/flat")
const { eslintPlugin } = require("tapsmith")

module.exports = defineConfig([
  expoConfig,
  {
    files: ["tests/**/*.ts"],
    // No tseslint.configs.base: expoConfig already sets the TypeScript parser
    extends: [eslintPlugin.configs.recommended],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
])
```

The same applies to any config that already uses typescript-eslint: leave out `tseslint.configs.base`. If two copies of typescript-eslint's plugin are installed, registering both fails with `Cannot redefine plugin "@typescript-eslint"`.

`require("tapsmith")` needs Node.js 22.12 or later. The object has to be inside `defineConfig()`, because a plain exported array does not accept the `extends` key.

### Rules

| Rule | Default | Description |
|---|---|---|
| `tapsmith/prefer-role` | warn | Suggests `getByRole()` instead of `locator({ className })` for standard Android widgets. |
| `tapsmith/no-bare-locator-xpath` | error | Requires an explanatory comment when using `locator({ xpath })`. |
| `tapsmith/prefer-accessible-locators` | warn | Suggests accessible getters instead of `getByTestId()` or `locator({ id })`. |
| `tapsmith/prefer-app-reset-option` | warn | Suggests `test.use({ appReset, appResetScope })` when a `beforeEach` only restarts or clears the app. |
