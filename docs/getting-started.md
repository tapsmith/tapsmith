# Getting Started

This guide walks you through installing Tapsmith, writing your first test, and running it against an Android or iOS device/simulator.

> **Setting up with an AI coding agent?** See [Using Tapsmith with AI coding agents](agents.md) for the non-interactive setup loop (`doctor --json` → `init --yes` → `verify --json`).

## Prerequisites

Before you begin, make sure you have the following installed:

### Android

| Requirement | Minimum version | How to check |
|---|---|---|
| Node.js | 22+ | `node --version` |
| ADB (Android Debug Bridge) | Any recent version | `adb --version` |
| Android device or emulator | Android 8.0+ (API 26+) | `adb devices` |

If you are using a single emulator or device, you can start it yourself and let
Tapsmith detect it automatically. Tapsmith can also launch emulator instances for you
when configured with `launchEmulators` and `avd`.

### iOS

| Requirement | Minimum version | How to check |
|---|---|---|
| Node.js | 22+ | `node --version` |
| Xcode | 15+ | `xcodebuild -version` |
| iOS Simulator | iOS 17+ | `xcrun simctl list devices` |

Tapsmith manages iOS simulators automatically. Set the `simulator` config option to
choose which simulator to boot (defaults to `iPhone 17`).

For **physical iOS devices**, additional prerequisites apply (libimobiledevice,
Apple Developer account, device pairing). See [iOS physical devices](./ios-physical-devices.md) for the full walkthrough.

## Installation

```bash
npm install tapsmith
```

This installs the TypeScript SDK, test runner, the Tapsmith daemon binary for your platform, and the Android agent APKs (via the `@tapsmith/agent-android` optional dependency).

## Quick Setup (Recommended)

The interactive setup wizard detects your environment, walks you through platform configuration, and generates your config file:

```bash
npx tapsmith init
```

The wizard walks through these steps:

1. **Environment detection** — checks for ADB, Xcode, simulators, emulators, and reports what's available
2. **Platform selection** — choose Android, iOS, or both
3. **App configuration** — specify your APK/`.app` path; the wizard detects the package name automatically
4. **Device setup** — choose between connected devices, emulators/simulators, or auto-launch
5. **Parallel execution** — optionally configure multiple workers with `launchEmulators` and `avd`
6. **Network capture** — optionally enable HTTPS traffic capture in traces
7. **File generation** — creates `tapsmith.config.ts` and an example test file

After setup, verify everything is working:

```bash
npx tapsmith doctor
```

`tapsmith doctor` runs a non-interactive health check and reports the status of each prerequisite:

```
  ✓ Node.js 22.5.0
  ✓ Tapsmith daemon found (/Users/you/.npm/.../tapsmith-core)
  ✓ ADB 35.0.2
  ✓ Android emulator available (Pixel_9_API_35)
  ✓ Tapsmith agent APK found
  ✓ Tapsmith agent test APK found
```

If anything is missing, `tapsmith doctor` prints the exact command to fix it. Run it whenever tests fail in unexpected ways to rule out setup issues.

## Make runs faster (optional, one line)

Tapsmith resets your app between test files by wiping its data and cold-launching — several seconds per file. React Native / Expo apps can do far better: mount `@tapsmith/react-native` once at the root and Tapsmith resets the app **in-process, in well under a second** — no config changes. Files that need a fresh app before every test opt in with one more line: `test.use({ appResetScope: "test" })` — still warm, still sub-second.

```tsx
import { TapsmithTestHooks } from "@tapsmith/react-native"
// in your root layout:
<TapsmithTestHooks urlPrefix={Linking.createURL("/")} clear={[AsyncStorage]} />
```

See the [Warm app reset guide](warm-reset.md) — including why the hooks must only ever be compiled into test builds, never a store release.

## Manual Configuration

If you prefer to configure manually, create `tapsmith.config.ts` in your project root:

### Android

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
  timeout: 30_000,
  screenshot: "only-on-failure",
});
```

The only required option is `apk` -- the path to the Android APK you want to test. If you want Tapsmith to auto-launch the app before tests, also set `package`. `activity` is optional and usually not needed.

### iOS

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  app: "./build/MyApp.app",
  package: "com.example.myapp",
  timeout: 30_000,
  screenshot: "only-on-failure",
});
```

For iOS, set `app` to the path to the `.app` bundle built for the iOS Simulator. The `package` option is the bundle identifier. Tapsmith auto-detects the platform from `app` (iOS) vs `apk` (Android), or you can set `platform: "ios"` explicitly.

See the [Configuration](configuration.md) guide for all available options.

### Parallel runs

For parallel Android emulator runs, use:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
  package: "com.example.myapp",
  workers: 4,
  launchEmulators: true,
  avd: "Pixel_9_API_35",
});
```

When `avd` is set, Tapsmith defaults to using that AVD for provisioned emulator
capacity. Set `deviceStrategy: "prefer-connected"` if you want connected
devices to win instead.

For parallel iOS simulator runs:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  app: "./build/MyApp.app",
  package: "com.example.myapp",
  workers: 4,
  simulator: "iPhone 17",
});
```

Tapsmith provisions additional simulator clones automatically for multi-worker iOS runs.

## Write Your First Test

Create a file at `tests/smoke.test.ts`:

```typescript
import { test, expect } from "tapsmith";

test("app launches and shows welcome screen", async ({ device }) => {
  // Wait for the welcome text to appear
  await expect(device.getByText("Welcome")).toBeVisible();
});

test("can navigate to settings", async ({ device }) => {
  // Tap a button by its accessibility role and name
  await device.getByRole("button", { name: "Settings" }).tap();

  // Verify we arrived at the settings screen
  await expect(device.getByText("Settings")).toBeVisible();
});
```

A few things to note:

- Tests receive a `device` fixture automatically. This is your primary interface for interacting with the app.
- `getByText()`, `getByRole()`, and the other `getBy*` methods are Playwright-style locators that identify UI elements. See the [Locators Guide](locators.md) for the full list.
- `expect()` creates assertions that auto-wait. `toBeVisible()` polls until the element appears or the timeout expires.

## Run Your Tests

```bash
npx tapsmith test
```

Tapsmith will:

1. Connect to the Tapsmith daemon (starting it if needed).
2. Detect your connected device or emulator.
3. Install the APK under test and the Tapsmith agent.
4. Discover all test files matching `**/*.test.ts` and `**/*.spec.ts`.
5. Run each test sequentially and report results.

For multi-worker runs, Tapsmith will assign one device per worker. If
`launchEmulators: true` is configured, it will launch additional emulator
instances automatically. If `avd` is set, those instances will use that AVD.

### Run a specific file

```bash
npx tapsmith test tests/smoke.test.ts
```

### Run on multiple devices in parallel

```bash
npx tapsmith test --workers 4
```

Or configure `workers` in `tapsmith.config.ts`. Each worker gets its own device. See [CI Setup](ci-setup.md) for sharding across CI machines.

### Target a specific device

If you need to debug against one known device, specify which one to use:

```bash
npx tapsmith test --device emulator-5554
```

For normal parallel runs, prefer `workers + launchEmulators + avd` in config.

## Understanding the Output

Tapsmith prints results to the terminal with pass/fail status and timing for each test:

```
Found 2 test file(s)

  tests/smoke.test.ts

Results:

  PASS  app launches and shows welcome screen (1204ms)
  PASS  can navigate to settings (2841ms)

Summary: 2 passed | 4.05s
```

When a test fails, Tapsmith prints the error message, a partial stack trace, and the path to a screenshot captured at the moment of failure:

```
  FAIL  can navigate to settings (30012ms)
        Expected element {"text":"Settings"} to be visible, but it was not
        Screenshot: tapsmith-results/screenshots/can_navigate_to_settings-1710345600000.png
```

## Organizing Tests

You can use `describe` blocks and hooks to organize your tests:

```typescript
import { test, describe, beforeEach, expect } from "tapsmith";

describe("Login flow", () => {
  beforeEach(async () => {
    // Reset app state before each test if needed
  });

  test("successful login", async ({ device }) => {
    await device.getByRole("textfield", { name: "Email" }).type("user@example.com");
    await device.getByRole("textfield", { name: "Password" }).type("password123");
    await device.getByRole("button", { name: "Sign In" }).tap();
    await expect(device.getByText("Welcome back")).toBeVisible();
  });

  test("invalid credentials", async ({ device }) => {
    await device.getByRole("textfield", { name: "Email" }).type("bad@example.com");
    await device.getByRole("textfield", { name: "Password" }).type("wrong");
    await device.getByRole("button", { name: "Sign In" }).tap();
    await expect(device.getByText("Invalid credentials")).toBeVisible();
  });
});
```

## Next Steps

- Learn about choosing the right locators in the [Locators Guide](locators.md).
- Read the [Writing Tests](writing-tests.md) guide for best practices, screen objects, and test isolation.
- Browse the complete [API Reference](api-reference.md).
- Configure Tapsmith for your project in the [Configuration](configuration.md) guide.
- Set up [Watch Mode](watch-mode.md) for fast iteration during development.
- Author and debug tests interactively with [UI Mode](ui-mode.md).
- Mock and inspect network traffic with the [Network Interception](network.md) guide.
- Test hybrid apps with the [WebView Testing](webview.md) guide.
- Run tests faster with the [Parallel Execution and Sharding](parallel-and-sharding.md) guide.
- Set up automated testing in the [CI Setup](ci-setup.md) guide.
- When things go wrong, check the [Debugging](debugging.md) guide.
