# Debugging

When a Tapsmith test fails, the framework gives you several layers of diagnostic information -- from simple error messages up to full step-by-step trace replays. This guide walks through each debugging tool and technique, starting with what you see immediately when a test fails and progressing to more advanced approaches.

## When a Test Fails

A failed test prints four things: the error message, a code snippet pointing to the failing line, a partial stack trace, and paths to the screenshot and trace (when enabled).

```
  tests/checkout.test.ts

  PASS  [1] app launches and shows products (1204ms)
  ✗    [2] can complete checkout (30012ms)
        Element {"text":"Place Order"} was not found after waiting 30000ms

          12 |   await device.getByText("Add to Cart", { exact: true }).tap()
        > 13 |   await device.getByText("Place Order", { exact: true }).tap()
          14 |   await expect(device.getByText("Order Confirmed")).toBeVisible()

        at ElementHandle.tap (packages/tapsmith/src/element-handle.ts:654:15)
        at tests/checkout.test.ts:13:55
        at Runner._runTest (packages/tapsmith/src/runner.ts:828:9)
        Screenshot: tapsmith-results/screenshots/can_complete_checkout-1710345600000.png
        Trace:      npx tapsmith show-trace tapsmith-results/traces/trace-checkout_test-can_complete_checkout-attempt0.zip
```

The error message tells you _what_ went wrong. The code snippet tells you _where_. The screenshot shows you the actual state of the device at the moment of failure. And the trace lets you replay every step leading up to the failure.

When retries are enabled, intermediate failures (attempts before the last) are shown with a red `✗` but do not count toward the final result. Only the final attempt determines pass or fail.

## Using the Trace Viewer

The trace viewer is the most powerful debugging tool in Tapsmith. It records screenshots, view hierarchy snapshots, console output, device logs, and network requests at each test step, then lets you scrub through a timeline to understand exactly what happened.

### Opening a trace

```bash
npx tapsmith show-trace tapsmith-results/traces/trace-checkout_test.zip
```

This starts a local server and opens the trace viewer in your browser. You can also drag and drop a `.zip` file onto the trace viewer page.

### Actions panel (left sidebar)

The left panel shows a chronological list of every action and assertion your test performed. Each entry displays:

- An icon for the action type (tap, type, swipe, assertion, etc.)
- The locator used (e.g., `getByText("Submit")`)
- Duration in milliseconds
- Pass/fail status -- failed actions are highlighted in red

Click any action to jump to that point in the timeline. Groups created with `device.tracing.group()` appear as collapsible sections.

**Keyboard navigation:** Use arrow keys or `j`/`k` to move between actions. This makes it fast to step through a test one action at a time.

### Screenshot panel (center)

The center panel shows before/after screenshots for the selected action:

- **Before** -- the screen state before the action executed
- **Action** -- the "before" screenshot with an overlay showing where the tap or swipe landed (coordinates and gesture path)
- **After** -- the screen state after the action completed

Comparing before and after screenshots is often the fastest way to understand why a test failed -- you can see exactly what the app looked like at each step.

### Detail tabs (right sidebar)

The right sidebar has several tabs:

**Source tab** -- Shows your test source code with the current line highlighted. Useful for understanding which part of the test you are looking at.

**Hierarchy tab** -- Displays the view hierarchy (Android XML or iOS accessibility tree) at the moment of the selected action. The tree is searchable -- type a text string or class name to find elements. This is essential for understanding _why_ a locator did not match: you can see exactly what elements were present and what their properties were.

**Console tab** -- Shows `console.log`, `console.warn`, and `console.error` output from your test code, along with device logs (Android logcat or iOS syslog) captured during the test. Messages are color-coded by level. If your test logs diagnostic information, it will appear here timestamped alongside the actions.

**Network tab** -- Displays HTTP/HTTPS requests captured during the test (when network capture is enabled). Shows method, URL, status code, duration, and response size. Click a decrypted row to see request/response headers and bodies. Passthrough connections appear as `CONNECT passthrough` rows without bodies; configure `networkPassthroughHosts` for pinned or embedded-root hosts that Tapsmith cannot decrypt. See [Trace Viewer](trace-viewer.md) for network capture setup details.

**Errors tab** -- For failed actions, shows the full error message, stack trace, and (for assertions) the expected vs. actual values.

## Screenshots

Tapsmith captures screenshots to help you see what the device screen looked like when something went wrong.

### Screenshot modes

Configure when screenshots are captured in `tapsmith.config.ts`:

```typescript
import { defineConfig } from "tapsmith"

export default defineConfig({
  screenshot: "only-on-failure",  // default
})
```

| Mode | Behavior |
|------|----------|
| `"only-on-failure"` | Capture a screenshot when a test fails. This is the default. |
| `"always"` | Capture a screenshot after every test, pass or fail. Useful in CI. |
| `"never"` | Never capture screenshots. |

You can also override the mode per-describe block:

```typescript
describe("visual regression suite", () => {
  test.use({ screenshot: "always" })

  test("home screen layout", async ({ device }) => {
    // screenshot captured regardless of pass/fail
  })
})
```

### Where screenshots are saved

Screenshots land in `<outputDir>/screenshots/` (by default `tapsmith-results/screenshots/`). Files are named with the test name and a timestamp:

```
tapsmith-results/screenshots/
  can_complete_checkout-1710345600000.png
  shows_error_on_invalid_credentials-1710345601234.png
```

### Element-level screenshots

You can capture a screenshot of a specific element, cropped to its bounding box:

```typescript
const png = await device.getByRole("image", { name: "Chart" }).screenshot()
```

This returns a `Buffer` containing PNG image data. Useful for visual comparisons or attaching to test reports.

## Retries

Retries let you re-run a failed test automatically, which is useful for handling inherent flakiness in mobile testing (animations, slow emulators, race conditions).

### Configuring retries

Set retries in your config:

```typescript
import { defineConfig } from "tapsmith"

export default defineConfig({
  retries: 2,  // retry failed tests up to 2 times
})
```

Or override per-describe block:

```typescript
describe("flaky network screen", () => {
  test.use({ retries: 3 })

  test("loads data from API", async ({ device }) => {
    // this test gets 3 retry attempts if it fails
  })
})
```

### How retry attempts work

When a test fails and retries are configured, Tapsmith re-runs the entire test from scratch -- including `beforeEach` hooks. Each attempt is independent:

1. **Attempt 0** (the original run) -- if this passes, no retries happen.
2. **Attempt 1** (first retry) -- `beforeEach` runs again, then the test body.
3. **Attempt 2** (second retry, if `retries >= 2`) -- same as above.

The final status is determined by the last attempt. If attempt 2 passes, the test is reported as "passed" (marked as "flaky" in reporters that support it). `afterEach` hooks run after every attempt, including failed ones.

### Tracing only retried tests

To minimize overhead, you can record traces only when a test is being retried:

```bash
npx tapsmith test --trace on-first-retry
```

This skips trace recording on the initial run (attempt 0) and only starts recording on the first retry. If the test passes on the first try, no trace overhead is incurred. The available retry-aware trace modes are:

| Mode | Records on | Keeps trace when |
|------|-----------|-----------------|
| `on-first-retry` | First retry only | Always (when recorded) |
| `on-all-retries` | All retries | Always (when recorded) |
| `retain-on-failure` | Every attempt | Test fails |
| `retain-on-failure-and-retries` | Every attempt | Run fails **or** is a retry |

See [Configuration](configuration.md#tracemode) for the complete list of trace modes.

## Console and Device Logs

### Test console output

Standard `console.log`, `console.warn`, and `console.error` calls in your test code appear in two places:

1. The terminal output (as usual)
2. The trace viewer's Console tab (when tracing is enabled)

This means you can add diagnostic logging to your tests and review it later in the trace:

```typescript
test("checkout flow", async ({ device }) => {
  const itemCount = await device.getByRole("listitem").count()
  console.log(`Found ${itemCount} items in cart`)

  await device.getByText("Checkout", { exact: true }).tap()
  console.log("Navigated to checkout screen")
})
```

### Device logs (logcat / syslog)

When tracing is enabled, Tapsmith streams device-level logs into the trace:

- **Android** -- logcat output from the device
- **iOS** -- simulator syslog output

Device logs are enabled by default in the trace config (`deviceLogs: true`). To disable them:

```typescript
import { defineConfig } from "tapsmith"

export default defineConfig({
  trace: {
    mode: "retain-on-failure",
    deviceLogs: false,
  },
})
```

Device logs appear in the trace viewer's Console tab alongside your test's `console.log` output, timestamped and interleaved chronologically.

### Verbose daemon logs

For low-level debugging of the Tapsmith daemon (gRPC, device communication, agent lifecycle), set `RUST_LOG`:

```bash
RUST_LOG=tapsmith_core=debug npx tapsmith test
```

This prints verbose daemon output to stderr. For even more detail:

```bash
RUST_LOG=tapsmith_core=trace npx tapsmith test
```

See [Environment Variables for Debugging](#environment-variables-for-debugging) for more options.

## Common Error Patterns

### Timeout: element not found

```
Element {"text":"Submit"} was not found after waiting 30000ms
```

**What happened:** Tapsmith polled the UI hierarchy for 30 seconds and never found an element matching your locator.

**Common causes and fixes:**

- **The element does not exist yet** -- the screen has not finished loading or navigating. Add a `waitFor()` on a preceding element, or increase the timeout:
  ```typescript
  await device.getByText("Products").waitFor()
  await device.getByText("Submit", { exact: true }).tap()
  ```
- **The locator is wrong** -- the text does not match exactly, or the element uses a different role. Use the trace viewer's Hierarchy tab or the `tapsmith_snapshot` MCP tool to inspect what is actually on screen.
- **The element is off-screen** -- it exists in the hierarchy but is not scrolled into view. Use `scrollIntoView()`:
  ```typescript
  await device.getByText("Submit", { exact: true }).scrollIntoView()
  await device.getByText("Submit", { exact: true }).tap()
  ```

### Timeout: assertion did not pass

```
Expected element {"text":"Success"} to be visible, but it was not found after waiting 30000ms
```

**What happened:** An `expect(...).toBeVisible()` (or similar assertion) polled until the timeout expired without the condition becoming true.

**Fixes:** Same as above -- check that the element actually appears. If the app needs more time, increase the assertion timeout:

```typescript
await expect(device.getByText("Success")).toBeVisible({ timeout: 60_000 })
```

### Element is disabled

```
Element {"text":"Submit"} is disabled after waiting 30000ms
```

**What happened:** Tapsmith found the element, but it was disabled (not interactive) for the entire timeout period. Tapsmith auto-waits for elements to become enabled before performing actions like `tap()`.

**Fixes:** Check why the element is disabled. Often it is because a form is incomplete or a loading state has not resolved. Ensure all prerequisites (form fields filled, data loaded) are met before interacting with the element.

### Action failed

```
Error: Tap failed: element {"role":"button","name":"Submit"} — element not interactable
```

**What happened:** The element was found and appeared enabled, but the action could not be performed on it -- typically because another element is overlapping it, or the element has zero size.

**Fixes:**

- Dismiss any overlapping dialogs, toasts, or keyboard
- Wait for animations to complete with `device.waitForIdle()`
- Check the element's bounding box: `const box = await element.boundingBox()`

### Device connectivity errors

```
Error: 14 UNAVAILABLE: failed to connect to all addresses
```

**What happened:** The Tapsmith SDK could not reach the daemon, or the daemon could not reach the device.

**Fixes:**

1. Run `npx tapsmith doctor` to check system health
2. Verify your device/emulator is running: `adb devices` (Android) or `xcrun simctl list devices booted` (iOS)
3. Check that no other process is using port 50051 (the default daemon port)
4. If using a custom `daemonAddress`, verify the daemon is running at that address

## Debugging Locators

When a test fails because an element was not found, the next step is usually figuring out _what elements are actually on screen_ and _what locators would match them_.

### Using the trace viewer Hierarchy tab

If you have a trace, open it and select the action that failed. The Hierarchy tab shows the complete view hierarchy at that moment. You can search by text, class name, or resource ID to find the element you are looking for. This often reveals mismatches: the text might be slightly different ("Log In" vs "Log in"), or the element might have a different role than expected.

### Using the MCP server snapshot tool

When working interactively (with `--ui` mode or an AI coding agent), the `tapsmith_snapshot` tool returns the accessibility tree with suggested locators for each interactive element:

```
$ tapsmith_snapshot

button "Settings" - device.getByRole("button", { name: "Settings" })
textfield "Email" - device.getByRole("textfield", { name: "Email" })
text "Welcome back, Sam" - device.getByText("Welcome back, Sam")
switch "Dark Mode" [checked] - device.getByRole("switch", { name: "Dark Mode" })
```

This shows you exactly which locators Tapsmith would use for each element on screen. See [MCP Server](mcp-server.md) for setup.

### Checking locator matches programmatically

Use `.exists()` and `.count()` to debug locator issues in your test code:

```typescript
// Does the element exist at all?
const exists = await device.getByText("Submit", { exact: true }).exists()
console.log("Submit exists:", exists)

// How many elements match?
const count = await device.getByRole("button").count()
console.log("Button count:", count)

// List every match's text — one hierarchy read
console.log("Buttons:", await device.getByRole("button").allTextContents())

// Per-element details: each handle from all() is a live locator, so every
// find() here is one hierarchy read (~0.7 s on an emulator) — fine for a
// handful of elements, slow for a long list
const buttons = await device.getByRole("button").all()
for (const btn of buttons) {
  const info = await btn.find()
  console.log("Button:", info.text, info.contentDescription)
}
```

### The escape hatch: `device.locator()`

When `getByRole()`, `getByText()`, and other accessible locators do not work, `device.locator()` gives you access to native identifiers:

```typescript
// By resource ID (Android) or accessibility identifier (iOS)
await device.locator({ id: "com.myapp:id/submit_btn" }).tap()

// By class name
await device.locator({ className: "com.myapp.widget.CustomButton" }).tap()

// By XPath (Android only, last resort)
await device.locator({
  xpath: "//android.widget.Button[@text='OK']",
}).tap()
```

See the [Locators Guide](locators.md) for the full priority hierarchy and when to use each approach.

### The ESLint plugin

Tapsmith's ESLint plugin warns when you use low-priority locators (test IDs, resource IDs, XPath) where a higher-priority accessible locator would work:

```javascript
// eslint.config.js
import { eslintPlugin } from "tapsmith"

export default [
  {
    plugins: { tapsmith: eslintPlugin },
    rules: { ...eslintPlugin.configs.recommended.rules },
  },
]
```

| Rule | What it catches |
|------|----------------|
| `tapsmith/prefer-role` | `locator({ className })` for standard widgets that have roles |
| `tapsmith/prefer-accessible-locators` | `getByTestId()` or `locator({ id })` when accessible locators exist |
| `tapsmith/no-bare-locator-xpath` | `locator({ xpath })` without an explanatory comment |
| `tapsmith/prefer-app-reset-option` | a `beforeEach` that only restarts/clears the app — declare `test.use({ appReset })` instead |

## Flaky Test Mitigation

Mobile tests are inherently more flaky than web tests due to animations, platform inconsistencies, and slower CI emulators. Here are the most common causes and their solutions.

### Animations and transitions

**Problem:** A tap lands while a screen transition is still animating, or an assertion checks before the animation completes.

**Solutions:**

```typescript
// Wait for the UI to settle after navigation
await device.getByRole("button", { name: "Next" }).tap()
await device.waitForIdle()
await expect(device.getByText("Step 2")).toBeVisible()

// Or wait for a specific element to appear before continuing
await device.getByText("Loading").waitFor({ state: "hidden" })
await device.getByText("Content loaded").waitFor()
```

### Race conditions with network data

**Problem:** The test proceeds before data loads, or data arrives at unpredictable times.

**Solutions:**

```typescript
// Wait for a loading indicator to disappear
await device.getByRole("progressbar").waitFor({ state: "hidden" })

// Or wait for the data to appear directly
await expect(device.getByRole("listitem")).toHaveCount(5, { timeout: 15_000 })

// Use network interception to control timing
await device.route("**/api/data", async (route) => {
  await route.fulfill({ json: { items: mockItems } })
})
```

### Slow CI emulators and dropped keystrokes

**Problem:** Emulators in CI are slower than local machines, causing timeouts or missed keystrokes during `type()`.

**Solutions:**

```typescript
import { defineConfig } from "tapsmith"

const isCI = process.env.CI === "true"

export default defineConfig({
  timeout: isCI ? 60_000 : 30_000,  // longer timeout in CI
  typingDelay: isCI ? 50 : 0,       // add delay between keystrokes in CI
  retries: isCI ? 2 : 0,            // retry in CI
})
```

Or add a per-call delay for specific inputs:

```typescript
await device.getByPlaceholder("OTP Code").type("123456", { delay: 50 })
```

### Capturing flake diagnostics

Use `retain-on-failure` tracing to capture full diagnostics only when tests fail:

```bash
npx tapsmith test --trace retain-on-failure
```

This records every test but only keeps the trace archive when a test fails, giving you full visibility into the failure without the storage overhead of tracing passing tests. In CI, upload traces as artifacts so you can download and replay them locally:

```yaml
- name: Run tests
  run: npx tapsmith test --trace retain-on-failure

- name: Upload traces
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: tapsmith-traces
    path: tapsmith-results/traces/
    retention-days: 30
```

See [CI Setup](ci-setup.md) for the complete workflow.

## `tapsmith doctor`

The `tapsmith doctor` command runs a non-interactive system health check across all Tapsmith dependencies. Run it whenever something is not working or after setting up a new environment:

```bash
npx tapsmith doctor
npx tapsmith doctor -c tapsmith.config.android.mjs   # judge a specific config
```

Config-dependent checks (app APK path, AVD system image) follow the loaded config: the AVD check verifies the AVD(s) your config actually names — top-level `avd` or per-project `use.avd` — and mentions other AVDs on the machine only as context.

Warnings and failures print a suggested fix on a `↳` line beneath them — where possible a ready-to-run command, e.g. a config pointing at a Google Play AVD suggests `npx tapsmith create-avd --name <avd> --api <level> --force` to replace it in place (same name, so no config change needed).

Example output:

```
Tapsmith Doctor

  Core
  ✓ Node.js 22.4.0
  ✓ Tapsmith daemon found (/Users/you/.npm/.../tapsmith-core)
  ✓ Config file found (tapsmith.config.ts)

  Android
  ✓ ADB 35.0.1
  ✓ ANDROID_HOME /Users/you/Library/Android/sdk
  ✓ 1 device connected (emulator-5554)
  ✓ Android agent (@tapsmith/agent-android)
  ✓ App APK exists (app-debug.apk)

  iOS
  ✓ Xcode 16.2
  ✓ iOS simulators available
  ✓ Simulator xctestrun found (TapsmithAgentUITests.xctestrun)

  Network Capture
  ✓ MITM CA exists (~/.tapsmith/ca.pem)
  ✓ AVD system images support HTTPS capture (2 AVDs checked)
  ✓ mitmproxy installed
  ✓ Network Extension enabled

15 checks passed
```

The checks cover:

- **Core:** Node.js version, daemon binary presence, config file
- **Android:** ADB, ANDROID_HOME, connected devices, agent APKs, app APK
- **iOS:** Xcode, simulators, xctestrun file (macOS only)
- **Network Capture:** MITM CA certificate, AVD system image compatibility (Google Play images can't capture HTTPS — see [Android emulator image requirements](network.md#android-emulator-image-requirements)), mitmproxy installation, Network Extension status, and a macOS system proxy left behind by an exited daemon (with the command to clear it)

Exit code is 0 when all checks pass (warnings are acceptable), 1 when any hard error is found.

## Stepping Through Tests

### Watch mode

Watch mode re-runs tests automatically when you save a file, giving you a fast edit-run-debug loop:

```bash
npx tapsmith test --watch
```

Or use the short form:

```bash
npx tapsmith test -w
```

When you edit a test file, Tapsmith detects the change and re-runs that file immediately. This is much faster than a full test run because the daemon and device stay connected between runs.

Watch mode cannot be combined with `--shard` (sharding is for CI distribution, not interactive development).

### UI mode

UI mode opens an interactive web interface for test selection and execution:

```bash
npx tapsmith test --ui
```

Optionally specify a port:

```bash
npx tapsmith test --ui --ui-port 8080
```

UI mode provides:

- A test tree showing all discovered test files, suites, and individual tests
- Click-to-run individual tests or groups
- Real-time progress tracking with inline results
- Built-in file watching (re-runs on save)
- An MCP server endpoint for AI coding agents (see [MCP Server](mcp-server.md))

When multiple projects are configured, the UI groups tests by project and routes execution to the correct device.

## Environment Variables for Debugging

### `TAPSMITH_DAEMON_LOG`

Capture all daemon (Rust) output to a file for later analysis:

```bash
TAPSMITH_DAEMON_LOG=daemon.log npx tapsmith test
```

This redirects the daemon's stdout and stderr to the specified file. Useful when you need to share daemon logs with someone, or when the daemon output scrolls past too quickly in the terminal.

### `RUST_LOG`

Control the verbosity of the Rust daemon logs:

```bash
# Debug-level logs for the Tapsmith daemon
RUST_LOG=tapsmith_core=debug npx tapsmith test

# Trace-level (very verbose — includes gRPC message details)
RUST_LOG=tapsmith_core=trace npx tapsmith test

# Combine with other Rust crate logs
RUST_LOG=tapsmith_core=debug,tonic=info npx tapsmith test
```

The `RUST_LOG` variable follows the standard [`env_logger`](https://docs.rs/env_logger/) syntax. It accepts comma-separated `target=level` pairs. Common levels: `error`, `warn`, `info`, `debug`, `trace`.

### `TAPSMITH_DEBUG`

Enable debug output from the TypeScript SDK:

```bash
TAPSMITH_DEBUG=1 npx tapsmith test
```

This prints additional diagnostic information from the SDK layer, including detailed assertion polling logs and gRPC call timings.

### Combining environment variables

For maximum visibility into a hard-to-debug failure:

```bash
RUST_LOG=tapsmith_core=debug \
  TAPSMITH_DAEMON_LOG=daemon.log \
  TAPSMITH_DEBUG=1 \
  npx tapsmith test --trace on tests/problematic.test.ts
```

This gives you:

1. Verbose daemon logs saved to `daemon.log`
2. SDK debug output in the terminal
3. A full trace archive with screenshots, hierarchy, console, network, and device logs
