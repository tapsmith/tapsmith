# Writing Tests

This guide covers the patterns and practices for writing reliable, maintainable Tapsmith tests. If you are new to Tapsmith, start with [Getting Started](getting-started.md) first, then return here.

## Test structure

A Tapsmith test file imports from `tapsmith` and uses the `test()` function to define tests. Each test receives fixtures -- most commonly `device`, which is your handle to the mobile device under test.

```typescript
import { test, expect } from "tapsmith"

test("home screen shows welcome message", async ({ device }) => {
  await expect(device.getByText("Welcome")).toBeVisible()
})
```

Use `describe()` to group related tests. Groups share hooks and make test output easier to scan:

```typescript
import { test, describe, expect, beforeAll } from "tapsmith"

describe("Login screen", () => {
  beforeAll(async ({ device }) => {
    await device.getByDescription("Login Form").tap()
  })

  test("shows email and password fields", async ({ device }) => {
    await expect(device.getByRole("textfield", { name: "Email" })).toBeVisible()
    await expect(device.getByRole("textfield", { name: "Password" })).toBeVisible()
  })

  test("sign in button starts disabled", async ({ device }) => {
    await expect(device.getByRole("button", { name: "Sign in" })).toBeDisabled()
  })
})
```

Every import you need comes from the `tapsmith` package: `test`, `describe`, `expect`, `beforeAll`, `afterAll`, `beforeEach`, `afterEach`, `flushSoftErrors`, `Device`, and the config utilities.

---

## Screen object pattern

The screen object pattern is the recommended way to abstract your locators. It is the mobile equivalent of Playwright's page object model. A screen class wraps the locators for a single screen of your app, keeping locators out of test logic and making changes to your UI a one-line fix.

### Defining a screen object

Create a file alongside your tests (or in a `screens/` directory):

```typescript
// screens/login.screen.ts
import { Device } from "tapsmith"

export class LoginScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Sign In", { exact: true }) }
  get emailField() { return this.device.getByRole("textfield", { name: "Email" }) }
  get passwordField() { return this.device.getByRole("textfield", { name: "Password" }) }
  get signInButton() { return this.device.getByRole("button", { name: "Sign in" }) }
  get forgotPasswordLink() { return this.device.getByText("Forgot password?", { exact: true }) }

  async login(email: string, password: string) {
    await this.emailField.clearAndType(email)
    await this.passwordField.clearAndType(password)
    await this.device.hideKeyboard()
    await this.signInButton.tap()
  }
}
```

### Using screen objects in tests

```typescript
import { test, describe, expect, beforeAll } from "tapsmith"
import { LoginScreen } from "../screens/login.screen.js"

describe("Login screen", () => {
  beforeAll(async ({ device }) => {
    await device.getByDescription("Login Form").tap()
  })

  test("shows the sign in heading", async ({ device }) => {
    const login = new LoginScreen(device)
    await expect(login.heading).toBeVisible()
  })

  test("can type into email field", async ({ device }) => {
    const login = new LoginScreen(device)
    await login.emailField.type("test@example.com")
    await expect(login.emailField).toHaveValue("test@example.com")
  })

  test("successful login flow", async ({ device }) => {
    const login = new LoginScreen(device)
    await login.login("test@example.com", "password123")
    await expect(device.getByText("Login successful!")).toBeVisible()
  })
})
```

### Guidelines

- **One class per screen.** If a screen has clearly distinct sections (e.g. a header and a scrollable list), expose them as getter groups within the same class.
- **Use getters, not constructor assignments.** Getters like `get emailField()` create a fresh locator on every access, which is the correct behavior -- locators are lazy references that resolve at action time.
- **Encapsulate multi-step flows.** Wrap common sequences (login, add to cart, navigate to settings) as methods on the screen class. Tests read better when they describe intent (`login.login(email, password)`) rather than mechanism.
- **Keep assertions in tests, not screen objects.** Screen objects provide locators and actions. Tests decide what to assert.

---

## Test isolation

Tests must not depend on each other. Each test should start from a known state and leave the device in a state that does not affect subsequent tests.

Tapsmith resets the app for you — the mobile equivalent of Playwright giving every test a fresh browser context. The reset is **declared**, not written by hand: it runs as fixture setup, appears in the trace in its own **APP RESET** section just before **BEFORE ALL** (per-file) or **BEFORE EACH** (per-test) — so the hook sections contain only your code — and its time counts toward the test's duration so slow isolation is visible rather than hidden.

### Declaring the reset policy

Two options control it, at any level — config, `projects[].use`, or `test.use()`:

| Option | Values | Default |
|---|---|---|
| `appReset` | `'auto'` \| `'clear'` \| `'restart'` \| `'warm'` \| `'none'` | `'auto'` |
| `appResetScope` | `'auto'` \| `'file'` \| `'test'` | `'auto'` |

| Mode | What happens | Typical cost |
|---|---|---|
| `clear` | Wipe app data and cold-launch — fully hermetic | 7–13 s on iOS simulators, 1–3 s on Android emulators |
| `restart` | Terminate and relaunch, keeping persisted data (AsyncStorage, databases) | 1–3 s |
| `warm` | In-app reset through detected [`@tapsmith/react-native`](warm-reset.md) hooks (or the legacy `resetAppDeepLink`); no process restart | < 1 s |
| `none` | No reset — only verify the session is healthy | ~0 |

`'auto'` picks the fastest hermetic option the app supports: `warm` when in-app hooks are detected (or `resetAppDeepLink` is set), otherwise `clear`. A declared `warm` policy that cannot run warm (no hook, or the delivery fails) falls back to a **clear** — the policy's promise is state-clearing, and a restart would keep persisted data. Only the explicit [`device.resetApp()`](api-reference.md#deviceresetappoptions-promiseappresetresult) API keeps the gentler warm → restart → clear ladder. The scope is per-file — one reset at file entry (and at a nested `describe` that declares a different policy). Even a warm reset costs ~1-2 s, so resetting before every test roughly doubles a suite that navigates per test anyway; scopes that genuinely need it opt in with `appResetScope: "test"` (each of those resets is warm when the app mounts the hooks). With no configuration at all you get a clean app once per file, and nothing to write.

```typescript
// tapsmith.config.ts — restart between files instead of wiping data
export default defineConfig({
  apk: "./app-debug.apk",
  package: "com.example.myapp",
  appReset: "restart",
})
```

```typescript
// a spec that needs a truly fresh app before every test
test.use({ appReset: "clear", appResetScope: "test" })

test("first launch shows onboarding", async ({ device }) => { /* … */ })
test("skipping onboarding lands on home", async ({ device }) => { /* … */ })
```

```typescript
// tests that deliberately share state across the file
describe("multi-step wizard", () => {
  test.use({ appReset: "none" })
  // …
})
```

A `beforeEach` that only calls `device.restartApp()` or `device.clearAppData()` + `device.launchApp()` is the same thing written by hand — the `tapsmith/prefer-app-reset-option` lint rule points you at the option instead. The manual methods remain available for resets in the *middle* of a test.

### Restoring saved state with `test.use()`

For tests that need a specific starting state (e.g. logged-in), restore a previously saved snapshot. A restore replaces the reset for that scope — Tapsmith restores the archive and relaunches, and never wipes app data first (on Android that would destroy the keystore keys the saved credentials depend on):

```typescript
describe("authenticated tests", () => {
  test.use({ appState: "./tapsmith-results/auth-state.tar.gz" })

  test("profile screen is accessible", async ({ device }) => {
    await device.openDeepLink("myapp:///profile")
    await expect(device.getByText("Profile")).toBeVisible()
  })
})
```

To opt out of restored state in a nested scope, pass an empty string — it means "clear":

```typescript
describe("without auth", () => {
  test.use({ appState: "" })

  test("profile redirects to login", async ({ device }) => {
    await device.openDeepLink("myapp:///profile")
    await expect(device.getByText("Sign In")).toBeVisible()
  })
})
```

### Manual resets inside a test

- `device.resetApp()` — the same ladder the runner uses (warm hook → restart → clear); returns what actually ran. See [API reference](api-reference.md#deviceresetappoptions-promiseappresetresult).
- `device.restartApp()` — restart, keep persisted data.
- `device.clearAppData(pkg)` then `device.launchApp(pkg)`, or `device.launchApp(pkg, { clearData: true })` — full wipe.
- `device.openDeepLink(resetLink)` — trigger your app's own reset hook.

### Choosing the right approach

| Scenario | Method |
|---|---|
| Tests are independent, app has little persistent state | `appReset: "restart"` |
| Tests modify persistent storage | default (`clear`), or `appResetScope: "test"` for per-test hermeticity |
| App exposes a reset hook | `resetAppDeepLink` (→ `warm`) — see [Configuration](configuration.md#warm-app-reset) |
| Many tests need the same complex starting state | Setup project with `saveAppState()` + `test.use({ appState })` |
| One specific scope needs different state | `test.use({ appState: "" })` or `test.use({ appState: "other.tar.gz" })` |
| Tests intentionally build on each other | `test.use({ appReset: "none" })` in that scope |

---

## Authentication patterns

Most real apps require authentication. Re-running a login flow before every test is slow and fragile. Instead, use a setup project that authenticates once and saves the app state, then dependent projects that restore it.

### Step 1: Create a setup test

```typescript
// tests/auth.setup.ts
import path from "node:path"
import { test, expect } from "tapsmith"
import { LoginScreen } from "../screens/login.screen.js"

test("authenticate and save app state", async ({ device, projectName }) => {
  const suffix = projectName ? `-${projectName.replace(/[^a-zA-Z0-9]/g, "-")}` : ""
  const statePath = path.join(process.cwd(), "tapsmith-results", `auth-state${suffix}.tar.gz`)

  await device.getByDescription("Login Form").tap()

  const login = new LoginScreen(device)
  await login.login("test@example.com", "password123")
  await expect(device.getByText("Login successful!")).toBeVisible()

  await device.saveAppState("com.example.myapp", statePath)
})
```

### Step 2: Configure projects with dependencies

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith"

export default defineConfig({
  package: "com.example.myapp",
  timeout: 10_000,
  projects: [
    {
      name: "setup",
      testMatch: ["**/auth.setup.ts"],
      use: { timeout: 30_000 },
    },
    {
      name: "default",
      testMatch: ["**/*.test.ts"],
      testIgnore: ["**/auth-gate.test.ts"],
    },
    {
      name: "authenticated",
      dependencies: ["setup"],
      use: { appState: "./tapsmith-results/auth-state-setup.tar.gz" },
      testMatch: ["**/auth-gate.test.ts"],
    },
  ],
})
```

The `dependencies` array ensures the setup project runs to completion before any authenticated tests begin. The `appState` path in `use` tells the runner to restore that state archive before each test file in the project.

### Multi-platform authentication

When running on both Android and iOS, each platform needs its own auth state file. Use `projectName` to generate unique paths:

```typescript
// tapsmith.config.ts
export default defineConfig({
  projects: [
    { name: "android:auth-setup", testMatch: ["**/auth.setup.ts"], use: { platform: "android", /* ... */ } },
    { name: "ios:auth-setup",     testMatch: ["**/auth.setup.ts"], use: { platform: "ios", /* ... */ } },
    {
      name: "android:authenticated",
      dependencies: ["android:auth-setup"],
      use: { platform: "android", appState: "./tapsmith-results/auth-state-android-auth-setup.tar.gz" },
      testMatch: ["**/auth-gate.test.ts"],
    },
    {
      name: "ios:authenticated",
      dependencies: ["ios:auth-setup"],
      use: { platform: "ios", appState: "./tapsmith-results/auth-state-ios-auth-setup.tar.gz" },
      testMatch: ["**/auth-gate.test.ts"],
    },
  ],
})
```

> **Android + Keystore-backed auth (e.g. Firebase):** restoring saved app state works on the **same device** that saved it, but an archive is **not portable across devices**. Many auth SDKs (including the Firebase Android SDK behind `@react-native-firebase/auth`) encrypt their session token with an Android Keystore key that stays on the saving device and isn't captured in the archive — so restoring it on a different device or CI runner results in an unauthenticated state. The setup-project pattern above already handles this: `dependencies` re-runs `auth.setup` on each device, minting fresh state where the tests run. Don't commit an Android auth archive and restore it elsewhere; let the setup project regenerate it (or use API-driven auth such as custom-token sign-in). See [`saveAppState`](api-reference.md#devicesaveappstatepackagename-string-path-string-promisevoid) for details.

---

## Locator best practices

Locators determine how your tests find UI elements. The right locator makes tests resilient to refactors. The wrong one makes them break whenever a developer moves a button.

### Priority hierarchy

Use the most accessible locator that uniquely identifies the element:

| Priority | Method | When to use |
|---|---|---|
| 1 (preferred) | `getByRole()` | Buttons, text fields, checkboxes, switches, headings |
| 2 (preferred) | `getByText()` | Static text, labels, headings without a role |
| 3 (preferred) | `getByDescription()` | Elements with explicit accessibility descriptions |
| 4 (acceptable) | `getByPlaceholder()` | Text inputs without a visible label |
| 5 (escape hatch) | `getByTestId()` | When no user-visible attribute works |
| 6 (discouraged) | `locator({ id })`, `locator({ className })` | Platform-specific locators |
| 7 (last resort) | `locator({ xpath })` | Android-only, extremely fragile |

```typescript
// Good -- uses accessible role + name
device.getByRole("button", { name: "Submit" })

// Good -- matches visible text
device.getByText("Welcome back")

// Acceptable -- no better alternative for this input
device.getByPlaceholder("Search products")

// Escape hatch -- element has no accessible attributes
device.getByTestId("animated-loader")

// Avoid -- breaks if layout changes
device.locator({ xpath: "//android.widget.Button[2]" })
```

### Role filtering options

`getByRole()` supports state filters that make locators both precise and readable:

```typescript
device.getByRole("switch", { name: "Dark Mode", checked: true })
device.getByRole("button", { name: "Submit", disabled: true })
device.getByRole("tab", { name: "Settings", selected: true })
device.getByRole("button", { name: "Details", expanded: true })
```

### Cross-platform considerations

On iOS, when a component has an explicit `accessibilityLabel`, child text elements are hidden from the accessibility tree. The parent becomes a single accessible element. On Android, child text remains individually queryable.

```tsx
// React Native component
<Pressable accessibilityLabel="Login Form" accessibilityRole="button">
  <Text>Login Form</Text>
  <Text>Enter your credentials</Text>  {/* hidden on iOS */}
</Pressable>
```

Write cross-platform tests by targeting the parent:

```typescript
// Works on both platforms
await device.getByRole("button", { name: "Login Form" }).tap()
await device.getByDescription("Login Form").tap()

// Android-only -- child text is hidden on iOS
await device.getByText("Enter your credentials").tap()
```

For elements that must be individually addressable on both platforms, use `getByTestId()`.

### ESLint plugin

Tapsmith ships an ESLint plugin that warns when tests use low-priority locators. Add it to your ESLint config to enforce accessible locator usage across your team. See [Locators Guide](locators.md) for full details.

### Scoping with `.locator()`

Narrow a search to descendants of a specific element using chained `getBy*` calls:

```typescript
const form = device.getByRole("button", { name: "Login Form" })
const emailField = form.getByRole("textfield", { name: "Email" })
await emailField.type("user@example.com")
```

---

## Waiting strategies

Tapsmith auto-waits in most situations. Understanding when it waits and when it does not helps you write tests that neither flake nor waste time.

### Auto-wait in assertions

Assertion methods like `toBeVisible()`, `toHaveText()`, and `toBeEnabled()` automatically poll until the condition is met or the timeout expires. You do not need to add explicit waits before assertions:

```typescript
// Correct -- toBeVisible() polls automatically (default 5s assertion timeout)
await expect(device.getByText("Welcome")).toBeVisible()

// Unnecessary -- do not add manual waits before auto-waiting assertions
await device.waitForIdle()  // remove this
await expect(device.getByText("Welcome")).toBeVisible()
```

Override the assertion timeout when an element takes longer than usual to appear:

```typescript
await expect(device.getByText("Data loaded")).toBeVisible({ timeout: 15_000 })
```

### Auto-wait in actions

Actions like `tap()`, `type()`, and `longPress()` wait for the element to exist before executing. If the element is not found within the action timeout (default 30s, configurable), the action throws.

### Explicit `waitFor()` for state transitions

When you need to wait for a specific state before proceeding (not just asserting), use `waitFor()`:

```typescript
// Wait for a loading indicator to disappear before continuing
await device.getByText("Loading...").waitFor({ state: "hidden", timeout: 10_000 })

// Wait for an element to appear
await device.getByText("Ready").waitFor({ state: "visible" })

// Wait for an element to be added to the hierarchy (may not be visible)
await device.getByTestId("offscreen-data").waitFor({ state: "attached" })

// Wait for an element to be removed from the hierarchy entirely
await device.getByTestId("splash-screen").waitFor({ state: "detached" })
```

The four states:

| State | Meaning |
|---|---|
| `visible` | Element exists and is visible on screen (default) |
| `hidden` | Element either does not exist or exists but is not visible |
| `attached` | Element exists in the hierarchy, regardless of visibility |
| `detached` | Element does not exist in the hierarchy at all |

### `waitForIdle()`

Waits for the device UI to reach a stable state (no animations, no pending layout). Useful after complex transitions:

```typescript
await device.swipe("up")
await device.waitForIdle()
```

### Network-dependent flows

For flows that depend on network responses, use `waitForRequest()` or `waitForResponse()` instead of arbitrary timeouts. These require network tracing to be enabled:

```typescript
// Wait for a specific API call to complete
const responsePromise = device.waitForResponse("**/api/users")
await device.getByRole("button", { name: "Load Users" }).tap()
const response = await responsePromise
```

---

## Organizing large test suites

### File naming conventions

Tapsmith discovers test files matching `**/*.test.ts` and `**/*.spec.ts` by default. Use either convention consistently:

```
tests/
  login.test.ts
  checkout.test.ts
  settings.test.ts
  device-management.android.test.ts    # platform-specific tests
```

### Folder structure

For large projects, organize by feature or screen:

```
e2e/
  screens/
    login.screen.ts
    checkout.screen.ts
    settings.screen.ts
  tests/
    login.test.ts
    checkout.test.ts
    settings.test.ts
  utils/
    test-data.ts
  tapsmith.config.ts
```

### Filtering with `testMatch` and `testIgnore`

Control which tests run in each project:

```typescript
export default defineConfig({
  projects: [
    {
      name: "smoke",
      testMatch: ["**/smoke-*.test.ts"],
    },
    {
      name: "full",
      testMatch: ["**/*.test.ts"],
      testIgnore: ["**/smoke-*.test.ts"],
    },
  ],
})
```

### Tag-style filtering with `--grep`

Tag your test names with markers and filter on the command line:

```typescript
test("@smoke login flow works", async ({ device }) => { /* ... */ })
test("@regression edge case in checkout", async ({ device }) => { /* ... */ })
```

```bash
# Run only smoke tests
npx tapsmith test --grep "@smoke"

# Run everything except regression tests
npx tapsmith test --grep-invert "@regression"
```

You can also configure `grep` and `grepInvert` in the config file or per-project:

```typescript
export default defineConfig({
  projects: [
    {
      name: "smoke",
      grep: /@smoke/,
    },
    {
      name: "full",
      grepInvert: /@smoke/,
    },
  ],
})
```

### Platform-specific tests

Use file naming conventions combined with `testIgnore` to exclude platform-specific tests:

```typescript
export default defineConfig({
  projects: [
    {
      name: "ios",
      use: { platform: "ios" },
      testIgnore: ["**/*.android.test.ts"],
    },
    {
      name: "android",
      use: { platform: "android" },
    },
  ],
})
```

Or use the `platform` fixture inside tests:

```typescript
test("android notification shade", async ({ device, platform }) => {
  if (platform !== "android") return
  await device.openNotifications()
  // ...
})
```

---

## Hooks

Hooks run setup and teardown code around your tests. They are registered inside `describe()` blocks and apply to all tests within that block.

### `beforeEach` / `afterEach`

Run before and after every test in the enclosing `describe`. Use these for per-test setup like resetting app state:

```typescript
describe("Checkout", () => {
  beforeEach(async ({ device }) => {
    await device.restartApp()
    await device.getByDescription("Cart").tap()
  })

  afterEach(async ({ device }) => {
    // Clean up test data if needed
    await device.clearAppData("com.example.myapp")
  })

  test("shows empty cart message", async ({ device }) => {
    await expect(device.getByText("Your cart is empty")).toBeVisible()
  })
})
```

### `beforeAll` / `afterAll`

Run once before all tests in the enclosing `describe` and once after all tests complete. Use these for expensive one-time setup:

```typescript
describe("Settings screen", () => {
  beforeAll(async ({ device }) => {
    // Navigate to settings once -- all tests in this block start here
    await device.getByDescription("Settings").tap()
  })

  test("shows account section", async ({ device }) => {
    await expect(device.getByText("Account")).toBeVisible()
  })

  test("shows notification preferences", async ({ device }) => {
    await expect(device.getByText("Notifications")).toBeVisible()
  })
})
```

### Hooks receive fixtures

All hooks receive the same `{ device }` fixture that tests do. `beforeAll` and `afterAll` also receive `device`, which is the same device instance used for the worker's lifetime:

```typescript
beforeAll(async ({ device }) => {
  await device.getByDescription("Login Form").tap()
})

beforeEach(async ({ device }) => {
  await device.restartApp()
})
```

Hooks can also be defined without fixtures for setup that does not involve the device:

```typescript
beforeAll(() => {
  console.log("Starting test suite")
})
```

### Nesting and inheritance

Hooks cascade through nested `describe` blocks. Inner hooks run after outer hooks:

```typescript
describe("App", () => {
  beforeEach(async ({ device }) => {
    await device.restartApp()             // runs first
  })

  describe("Login", () => {
    beforeEach(async ({ device }) => {
      await device.getByDescription("Login Form").tap()  // runs second
    })

    test("shows sign in form", async ({ device }) => {
      // restartApp() has run, then navigated to login
      await expect(device.getByText("Sign In")).toBeVisible()
    })
  })
})
```

### When to use which

| Hook | Scope | Use for |
|---|---|---|
| `beforeAll` | Once per `describe` | Navigating to a screen, one-time setup |
| `afterAll` | Once per `describe` | Cleaning up shared resources |
| `beforeEach` | Before every test | Resetting app state, ensuring a clean starting point |
| `afterEach` | After every test | Cleaning up test-specific side effects |

**Caution:** `beforeAll` runs once, so all tests in that block share whatever state it creates. If one test modifies the screen, subsequent tests see that modification. When in doubt, use `beforeEach`.

---

## Custom fixtures with `test.extend()`

Custom fixtures let you define reusable setup/teardown logic that tests can request by name. They follow the same `use()` callback pattern as Playwright.

### Defining a fixture

Fixtures are ideal for reusable test data setup/teardown, navigation helpers, or any per-test context that isn't authentication (for auth, use the [app state pattern](#authentication-patterns) instead).

```typescript
// fixtures.ts
import { test as base } from "tapsmith"

// A fixture that seeds a product via the API and cleans it up afterward
const test = base.extend<{ productId: string }>({
  productId: async ({ request }, use) => {
    // Setup: create test data via API
    const res = await request.post("https://api.example.com/products", {
      data: { name: "Test Widget", price: 9.99 },
    })
    const { id } = await res.json() as { id: string }

    // Hand the value to the test
    await use(id)

    // Teardown: clean up after the test (runs even on failure)
    await request.delete(`https://api.example.com/products/${id}`)
  },
})

export { test }
```

### Using a custom fixture

```typescript
import { test } from "./fixtures.js"
import { expect } from "tapsmith"

test("product appears in catalog", async ({ device, productId }) => {
  await device.getByText("Refresh").tap()
  await expect(device.getByText("Test Widget")).toBeVisible()
})
```

### Test-scoped vs worker-scoped fixtures

By default, fixtures are **test-scoped** -- they set up and tear down for each test. For expensive setup that should persist across all tests in a worker, use **worker scope**:

```typescript
const test = base.extend<{ dbConnection: DatabaseClient }>({
  dbConnection: [async ({}, use) => {
    const db = await connectToTestDatabase()
    await use(db)
    await db.close()
  }, { scope: "worker" }],
})
```

Worker-scoped fixtures are created once per worker and shared across all tests that worker runs. They are torn down when the worker exits.

### The `use()` callback pattern

The `use()` function is the boundary between setup and teardown:

```typescript
myFixture: async ({ device }, use) => {
  // Everything before use() is SETUP
  const data = await seedTestData()

  await use(data)  // <-- test runs here

  // Everything after use() is TEARDOWN (always runs, even on failure)
  await cleanupTestData(data)
},
```

---

## Soft assertions

Regular assertions stop the test immediately on failure. Soft assertions record the failure but let the test continue, so you can check multiple things and see all failures at once.

### Using `expect.soft()`

```typescript
import { test, expect, flushSoftErrors } from "tapsmith"

test("dashboard shows all sections", async ({ device }) => {
  await expect.soft(device.getByText("Revenue")).toBeVisible()
  await expect.soft(device.getByText("Users")).toBeVisible()
  await expect.soft(device.getByText("Orders")).toBeVisible()
  await expect.soft(device.getByText("Inventory")).toBeVisible()

  // Flush at the end to fail the test if any soft assertions failed
  const errors = flushSoftErrors()
  expect(errors).toHaveLength(0)
})
```

### When to use soft assertions

- **Layout verification tests** where you want to check the visibility of many elements at once and see which ones are missing.
- **Data validation** where multiple fields should have specific values.
- **Smoke tests** where you want a single test to check many screens and report all failures.

### When not to use soft assertions

Do not use soft assertions when later steps depend on earlier ones. If tapping a button is a prerequisite for checking the next screen, a regular assertion is correct -- there is no point continuing if the tap target does not exist.

---

## API testing with the `request` fixture

The `request` fixture provides an HTTP client for making API calls during tests. Use it to seed test data, verify backend state, or fetch authentication tokens.

### Basic usage

```typescript
import { test, expect } from "tapsmith"

test("GET request returns data", async ({ request }) => {
  const response = await request.get("https://api.example.com/users/1")
  expect(response.ok).toBe(true)
  expect(response.status).toBe(200)

  const body = (await response.json()) as { id: number; name: string }
  expect(body.id).toBe(1)
})
```

### Available methods

The `request` fixture supports all standard HTTP methods:

```typescript
await request.get(url, options?)
await request.post(url, options?)
await request.put(url, options?)
await request.patch(url, options?)
await request.delete(url, options?)
await request.head(url, options?)
```

### Sending data

```typescript
// JSON body (most common)
await request.post("https://api.example.com/posts", {
  data: { title: "Test Post", body: "Created by Tapsmith" },
})

// Form-encoded body
await request.post("https://api.example.com/login", {
  form: { username: "admin", password: "secret" },
})

// Custom headers
await request.get("https://api.example.com/protected", {
  headers: { Authorization: "Bearer token123" },
})

// Query parameters
await request.get("https://api.example.com/search", {
  params: { q: "tapsmith", limit: "10" },
})
```

### Combining device and API interactions

The most powerful pattern is using `request` alongside `device` to seed backend state and then verify it in the UI:

```typescript
test("user created via API appears in app", async ({ device, request }) => {
  // Seed data via API
  const res = await request.post("https://api.example.com/users", {
    data: { name: "Jane Doe", email: "jane@example.com" },
  })
  expect(res.status).toBe(201)

  // Refresh the app and verify the user appears
  await device.getByRole("button", { name: "Refresh" }).tap()
  await expect(device.getByText("Jane Doe")).toBeVisible()
})
```

### Configuring a base URL

Set `baseURL` in your config to avoid repeating the full URL in every call:

```typescript
// tapsmith.config.ts
export default defineConfig({
  baseURL: "https://api.example.com",
})
```

```typescript
// In tests, use relative URLs
const res = await request.get("/users/1")
```

You can also set `extraHTTPHeaders` in config for headers that apply to all requests (e.g. API keys).

---

## Parallel test considerations

Tapsmith supports parallel execution across multiple workers, where each worker runs on its own device or emulator. This speeds up large test suites dramatically, but requires tests to be written with isolation in mind.

### Tests must be independent

Each worker runs a subset of test files. Tests must not depend on:
- Shared mutable backend state (e.g. a single test user that two workers modify concurrently)
- Execution order (files are distributed to workers in no guaranteed order)
- Device state left by a previous test file

### Use unique test data

When parallel workers hit the same backend, use unique identifiers to avoid collisions:

```typescript
test("create and verify user", async ({ device, request }) => {
  const uniqueEmail = `test-${Date.now()}@example.com`
  await request.post("/api/users", {
    data: { email: uniqueEmail, name: "Test User" },
  })
  // ...
})
```

### App state isolation

Each worker gets its own device, so device-level state (app data, clipboard, orientation) is naturally isolated. No extra work is needed for on-device isolation.

Backend isolation is your responsibility. If your test creates a resource via API, clean it up in teardown or use unique identifiers so parallel runs do not interfere.

### Configuration

```typescript
export default defineConfig({
  workers: 4,                   // 4 parallel workers
  avd: "Pixel_6",              // each worker gets its own emulator instance
  launchEmulators: true,        // auto-launch emulators to fill worker count
})
```

Per-project worker counts are also supported:

```typescript
export default defineConfig({
  projects: [
    { name: "android", workers: 2, use: { platform: "android", avd: "Pixel_6" } },
    { name: "ios",     workers: 1, use: { platform: "ios", simulator: "iPhone 16" } },
  ],
})
```

---

## Further reading

- [Locators Guide](locators.md) -- deep dive into locator types and cross-platform behavior
- [API Reference](api-reference.md) -- complete reference for all public APIs
- [Configuration](configuration.md) -- all config options, reporters, trace modes, and video recording
