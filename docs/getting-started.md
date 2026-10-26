# Getting Started

This guide walks you through installing Tapsmith, writing your first test, and running it against an Android or iOS device/simulator.

> **Tapsmith requires Node.js 22 or newer.** Check with `node --version` before you install. On older Node, npm can install an old Tapsmith release whose commands don't match this guide (or fail with `No matching version found`).

> **Moving an existing suite?** The migration guides map your current tool onto Tapsmith and port a test side by side: [from Maestro](migrating-from-maestro.md), [from Detox](migrating-from-detox.md) and [from Appium](migrating-from-appium.md).

> **Setting up with an AI coding agent?** See [Using Tapsmith with AI coding agents](agents.md) for the non-interactive setup loop (`doctor --json` → `init --yes` → `verify --json`).

## Prerequisites

Before you begin, make sure you have the following installed:

### Android

| Requirement | Minimum version | How to check |
|---|---|---|
| Node.js | 22+ | `node --version` |
| ADB (Android Debug Bridge) | Any recent version | `adb --version` |
| Android device or emulator | Android 8.0+ (API 26+) | `adb devices` |

ADB comes with the Android SDK. If you don't have one yet, install
[Android Studio](https://developer.android.com/studio) (or the Android command-line tools, then
`sdkmanager platform-tools`), set `ANDROID_HOME` to the SDK location (Android Studio's default is
`~/Library/Android/sdk` on macOS and `~/Android/Sdk` on Linux), and add `$ANDROID_HOME/platform-tools`
to `PATH`.

If you are using a single emulator or device, you can start it yourself and let
Tapsmith detect it automatically. Tapsmith can also launch emulator instances for you
when configured with `launchEmulators` and `avd`.

### iOS

| Requirement | Minimum version | How to check |
|---|---|---|
| Node.js | 22+ | `node --version` |
| Xcode | 15+ | `xcodebuild -version` |
| iOS Simulator | iOS 17+ | `xcrun simctl list devices` |

Install Xcode from the Mac App Store (the Command Line Tools alone have no simulators), open it once
to finish setup, then select it: `sudo xcode-select -s /Applications/Xcode.app`.

On an Apple Silicon Mac, use an arm64 build of Node (`node -p process.arch` prints `arm64`). An x64 Node,
common after Migration Assistant from an Intel Mac, runs under Rosetta: npm then installs the x64 builds of
Tapsmith's packages, which run translated, and the prebuilt iOS simulator agent among them cannot run on
the Mac's arm64 simulators. Tapsmith still works — it builds an arm64 agent on the first iOS run and picks
arm64 emulator images — but `tapsmith doctor`, `init` and `test` warn until you switch Node and reinstall
(`rm -rf node_modules && npm install`).

Tapsmith manages iOS simulators automatically. Set the `simulator` config option to
the simulator to boot (for example `simulator: "iPhone 17"`; `xcrun simctl list devices`
lists the names). There is no default: without `simulator` (or `device`), Tapsmith
looks for a single paired physical iPhone instead, and the run fails before any test starts when there isn't one.

For **physical iOS devices**, additional prerequisites apply (libimobiledevice,
Apple Developer account, device pairing). See [iOS physical devices](./ios-physical-devices.md) for the full walkthrough.

## Installation

Add Tapsmith to your project as a dev dependency, with the package manager the project uses:

<!-- package-manager-tabs -->
```bash
npm install -D tapsmith
# yarn add -D tapsmith
# pnpm add -D tapsmith
```

This installs the TypeScript SDK, test runner, the Tapsmith daemon binary for your platform, and the Android agent APKs (via the `@tapsmith/agent-android` optional dependency).

These docs run the CLI as `npx tapsmith …`. With Yarn, run `yarn tapsmith …` instead, and with pnpm, `pnpm exec tapsmith …` (`npx tapsmith` also works in a pnpm project).

### npm: the `allow-scripts` warning

On npm 11.17 and later, the install may end with an `npm warn allow-scripts` (npm 12: `npm warn install-scripts`) list naming `protobufjs`, `esbuild` and, on macOS, `fsevents`. Tapsmith's own packages have no install scripts. These three come in through gRPC and `tsx`, and Tapsmith works with their scripts blocked: `protobufjs` only prints an advisory, `esbuild` only re-checks the binary npm already installed, and `fsevents` ships prebuilt. To record that decision and silence the warning, add this to your project's `package.json`:

```json
"allowScripts": { "protobufjs": false, "esbuild": false, "fsevents": false }
```

### pnpm: `ERR_PNPM_IGNORED_BUILDS`

pnpm blocks dependency build scripts unless the project approves them. From pnpm 11, `pnpm add -D tapsmith` installs everything and then exits 1 with `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: esbuild, protobufjs` (pnpm 10 prints the same list as a warning). They are the same scripts as in the npm warning above, and Tapsmith works without them. Only the project can approve or deny them, so to record that decision and silence the error, set them to `false` under `allowBuilds` in the `pnpm-workspace.yaml` beside your `pnpm-lock.yaml` (in a monorepo, the one at the workspace root; create it if there isn't one). Some pnpm versions have already added them there with the value `set this to true or false`: replace that value rather than adding a second `allowBuilds:`.

```yaml
allowBuilds:
  esbuild: false
  protobufjs: false
```

Then run `pnpm install`. If `tapsmith init` ran the install for you, it prints this snippet.

### pnpm: the Android agent package

pnpm 11 and later skip `@tapsmith/agent-android` when installing Tapsmith 0.7.0 or earlier: they read the `-android` in its name as "Android-only" and leave the optional dependency out, so Android runs fail on a device that doesn't already have the agent. Later releases declare the platforms the package installs on. On an affected version, `tapsmith doctor` reports `Android agent not found`; add the package directly:

```bash
pnpm add -D @tapsmith/agent-android
```

The same applies to any install that leaves optional dependencies out (`npm install --omit=optional`, `pnpm install --no-optional`).

### Yarn: use the `node-modules` linker

Tapsmith doesn't run under Yarn Plug'n'Play, the default for new Yarn 2+ projects (a `.pnp.cjs` file next to `package.json`). It starts `tsx`, its daemon and its device agents as programs, and Plug'n'Play keeps packages inside zip archives, so `tapsmith test`, `verify` and `mcp-server` stop with an error naming the fix, and `tapsmith doctor` reports it. Switch the project to the `node-modules` linker (React Native and Expo projects already use it):

```yaml
# .yarnrc.yml
nodeLinker: node-modules
```

Then run `yarn install`.

## Build the app under test

Tapsmith installs and launches a build of your app; it does not build it for you. You need:

- **Android**: an `.apk`. Any variant your emulator or device can install works.
- **iOS Simulator**: a `.app` built for the simulator (`-sdk iphonesimulator`, under a `…-iphonesimulator/` products folder).
- **iOS physical device**: a `.app` built for `iphoneos` and code-signed for the device. Simulator and device builds are not interchangeable; see [iOS physical devices](./ios-physical-devices.md).

`tapsmith init` recognises a React Native layout (`android/` and `ios/`) and a native one (a `settings.gradle` or `settings.gradle.kts` at the root, an `.xcodeproj` or `.xcworkspace` at the root or one folder down). It offers the builds it finds in any Gradle module's `build/outputs/apk/` and in any `*-iphonesimulator/` (or `*-iphoneos/`) products folder of the project (in `android/` and `ios/` in a React Native project, anywhere in a native one), such as `app/build/outputs/apk/debug/` or `build/Build/Products/Debug-iphonesimulator/`. When the project holds no simulator build (or, for a physical device, no device build), it also looks in Xcode's default DerivedData folder for this project's builds. A build anywhere else can still be used: enter its path.

### Native projects

A native Android or iOS project works with Tapsmith as it is. Tapsmith is an npm package, though, so your repository gains a `package.json`, a `node_modules/` folder, `tapsmith.config.ts` and a `tests/` folder. Put them at the root of the repository, beside `settings.gradle.kts` or the `.xcodeproj`: that is where `tapsmith init` looks for the project and its builds.

Build the app first, at the root of the repository (which is also where CI builds it), so `tapsmith init` finds the build:

```bash
# Android (Android Studio project): writes app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleDebug

# iOS Simulator (Xcode project): writes build/Build/Products/Debug-iphonesimulator/MyApp.app
xcodebuild -project MyApp.xcodeproj -scheme MyApp \
  -configuration Debug -sdk iphonesimulator -derivedDataPath build build
```

Then add Tapsmith and run the setup wizard:

```bash
npm init -y && npm install -D tapsmith   # creates package.json and node_modules/
npx tapsmith init                        # adds node_modules/ to .gitignore if it isn't ignored yet
```

- **Android.** A native debug APK runs without any dev server, and Gradle signs it with the debug keystore, so it installs on any emulator or device. The release APK of Android Studio's project templates is unsigned and does not install: test the debug build, or configure release signing first. A module not named `app` writes to `<module>/build/outputs/apk/`.
- **iOS.** If the project has an `.xcworkspace` (CocoaPods, or a workspace you created), build that with `-workspace MyApp.xcworkspace` instead of `-project`. `xcodebuild -list` shows the scheme names. With XcodeGen, run `xcodegen generate` first if the `.xcodeproj` isn't committed.
- **Xcode's default build folder.** Without `-derivedDataPath`, Xcode (and a build from the Xcode UI) writes to `~/Library/Developer/Xcode/DerivedData/<MyApp>-<hash>/Build/Products/Debug-iphonesimulator/MyApp.app`. `tapsmith init` finds it there when the project has no build of its own, and warns that the path exists only on your Mac and changes when DerivedData is cleared. Build with `-derivedDataPath build` to get a stable path inside the project that teammates and CI share.

Run `tapsmith init` in a subfolder instead (an `e2e/` folder with its own `package.json`, say) and it does not see the project or its builds: enter the build's path in the wizard, or pass `--apk` or `--app`.

A React Native project keeps its native projects in `android/` and `ios/`, and needs a different build, described next.

### React Native and Expo

A React Native **Debug** build does not contain your JavaScript: it loads it from the
Metro dev server at launch. Without Metro running (`npx expo start` or
`npx react-native start`) it opens on a red error screen instead of your app. Even with
Metro running, an Expo build that includes `expo-dev-client` opens the dev launcher
rather than the app on a cold launch, and a physical Android device reaches Metro only
after `adb reverse tcp:8081 tcp:8081`. A **Release** build bundles the JavaScript into
the app and runs on its own, which makes it the simplest choice for tests, locally and
in CI:

```bash
# Android (the React Native template signs release builds with the debug keystore)
cd android && ./gradlew assembleRelease   # android/app/build/outputs/apk/release/app-release.apk

# iOS Simulator
cd ios && xcodebuild -workspace MyApp.xcworkspace -scheme MyApp \
  -configuration Release -sdk iphonesimulator -derivedDataPath build build
```

When a debug APK is also lying around, the wizard lists it first and `tapsmith init --yes` picks it over the release one: choose the release APK in the wizard, or pass `--apk android/app/build/outputs/apk/release/app-release.apk`.

**Expo** projects have no `android/` or `ios/` folder until you generate them (`tapsmith init` recognises an Expo project and suggests these commands when it finds no build):

- `npx expo prebuild` generates the native projects; then build them with the commands above.
- `npx expo run:android --variant release` generates, builds and installs in one step, leaving the APK in `android/app/build/outputs/apk/release/`. `npx expo run:ios --configuration Release` does the same for iOS, but builds into Xcode's default DerivedData folder (the path above), where `tapsmith init` does not look: enter that path, or build with the `xcodebuild … -derivedDataPath build` command above after `expo prebuild`.
- With EAS, use a build profile that produces simulator and installable builds, for example `"e2e": { "ios": { "simulator": true }, "android": { "buildType": "apk" } }` in `eas.json`, then `eas build --profile e2e --platform ios --local` (or download the build). An iOS simulator build arrives as a `.tar.gz`; extract it and point `app` at the `.app` inside.

If the app mounts [`@tapsmith/react-native`](warm-reset.md), its reset hooks are on in Debug builds but switched off in Release builds unless you turn them on for your test build. In an Expo project, mount it with `enabled={__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === "1"}` and set `EXPO_PUBLIC_TAPSMITH_HOOKS=1` at build time. The check has to be in your app's code, because Expo inlines `EXPO_PUBLIC_*` variables only there, never inside `node_modules`. A bare React Native app does not inline that variable, so pass the hooks' `enabled` prop from a build-time flag of your own instead.

## Quick Setup (Recommended)

The interactive setup wizard detects your environment, walks you through platform configuration, and generates your config file:

```bash
npx tapsmith init
```

The wizard walks through these steps:

1. **Environment detection** — checks for ADB, Xcode, simulators, emulators, and reports what's available
2. **Platform selection** — choose Android, iOS, or both; the default is one that can run here (Android needs ADB, iOS needs Xcode and a simulator), following your project's layout (`android/` and `ios/`, or a root `settings.gradle` and an Xcode project)
3. **Android** — pick your APK from the builds the wizard finds in the project (the same ones `init --yes` looks for) or enter a path, which must exist; the wizard reads the package name from the APK and asks only when it can't (in an Expo project, with `expo.android.package` from the app config pre-filled). Then choose emulators, physical devices or both, and, for emulators, the AVD Tapsmith should launch (one that supports HTTPS capture is selected: Google Play images don't)
4. **iOS** — choose simulators, physical devices or both. For simulators, pick your simulator `.app` the same way (a build from Xcode's DerivedData is marked `this Mac only`) and the simulator to use, from every iOS simulator Xcode has (stock-named simulators come first, an already-booted one among them first and selected, as it saves a boot; simulators you renamed come last, marked `this Mac only`, since teammates and CI won't have them). For physical devices, the wizard runs a code-signing preflight, offers to build the device agent, and asks for your device-signed (`iphoneos`) `.app`. It reads each build's bundle ID and asks only when it can't (in an Expo project, with `expo.ios.bundleIdentifier` pre-filled). Choosing both writes two projects, `ios` (simulator) and `ios-device` (physical device), so `npx tapsmith test --project ios-device` runs on the device alone (the layout of [Running simulator and device together](./ios-physical-devices.md#running-simulator-and-device-together), with these project names)
5. **Network capture** — optionally record HTTP/HTTPS traffic; saying yes writes `trace: { mode: 'retain-on-failure' }`, which [`device.route()`](network.md#prerequisites) needs, and lists the per-platform setup still to do
6. **iOS simulator agent** — if no simulator agent build is found, offers to build it now (~30 s)
7. **Example test** — optionally creates `tests/example.tapsmith.ts`
8. **AGENTS.md** — optionally adds a Tapsmith section to `AGENTS.md` for AI coding agents
9. **Files** — writes `tapsmith.config.ts` with the app, its `package` and, for iOS, `platform: 'ios'` and the simulator, plus `testMatch: ['**/*.tapsmith.ts']` (see [Tapsmith tests and your unit tests](#tapsmith-tests-and-your-unit-tests)), the example test and the `AGENTS.md` section you asked for, and adds `tapsmith-results/` (traces and screenshots), `tapsmith-report/` (the HTML report) and, if nothing ignores it yet, `node_modules/` to `.gitignore`. It checks it can write every file before writing any (and, before the platform questions, that it can write to the project directory at all), and writes the config last: if a file can't be written (a read-only directory, say), the wizard stops there with exit code 1, saying which file, how to fix it and which files, if any, it had already written
10. **Install** — if the project doesn't have Tapsmith yet (you ran `npx tapsmith init` before installing it), offers to install it with your package manager (`npm i -D tapsmith`, `yarn add -D tapsmith`, …), since the config and example test import it. Decline and the command is the first of the next steps. In a folder with no `package.json` it doesn't offer: the command then starts with `npm init -y` (or your package manager's equivalent), because a bare `npm i -D tapsmith` would install into the nearest parent folder that has a `package.json`. Install Tapsmith first, as in [Installation](#installation): with no local install, `npx tapsmith init` runs whichever version npx downloads, not the one your project will use

The wizard ends with your next steps: after the install, if it still needs doing, `npx tapsmith verify` (see below) comes first. It does not ask about workers; see [Parallel runs](#parallel-runs) to add them.

After setup, check the environment:

```bash
npx tapsmith doctor
```

`tapsmith doctor` runs a non-interactive health check and reports the status of each prerequisite, grouped by platform. It checks the platforms your config targets; a platform it does not target shows `– skipped: …` instead of its checks. For example, on a Mac set up for both platforms, with a config that tests both:

```
Tapsmith Doctor

  Core
  ✓ Node.js 22.21.0
  ✓ Tapsmith daemon found (…/node_modules/@tapsmith/core-darwin-arm64/tapsmith-core)
  ✓ Config file found (tapsmith.config.ts)

  Android
  ✓ ADB 37.0.0
  ✓ ANDROID_HOME (/Users/you/Library/Android/sdk)
  ⚠ No Android devices connected
    ↳ Start an emulator or connect a device with USB debugging enabled
  ✓ Android agent (@tapsmith/agent-android)

  iOS
  ✓ Xcode 26.0
  ✓ iOS simulators available (3 iOS simulators)
  ✓ Simulator xctestrun found (auto-build cache, SDK 26.0, built by Tapsmith 0.7.1)

  Network Capture
  ✓ MITM CA exists (~/.tapsmith/ca.pem)
  ✓ AVD system images support HTTPS capture (1 AVD checked)
  ✓ mitmproxy installed (Homebrew cask)
  ✓ Network Extension enabled
  ✓ macOS system proxy not set by Tapsmith

14 checks passed, 1 warning
```

A warning (`⚠`) or error (`✗`) that Tapsmith knows how to fix is followed by a `↳` line saying how, often the exact command to run. `tapsmith doctor --json` prints the same checks for scripts and AI agents, with a `fix` field wherever there is one. The command exits 1 if any check is an error, including when neither Android nor iOS can run on the machine. Run it whenever tests fail in unexpected ways to rule out setup issues.

Then prove the whole loop works before writing tests:

```bash
npx tapsmith verify
```

`tapsmith verify` runs one real test through `tapsmith test` (starting the daemon, launching the emulator or simulator, installing the app) and reports whether it passed. It runs `tests/example.tapsmith.ts` if the wizard created it, or your first test file; with no test files yet it runs a throwaway smoke test and removes it afterwards.

### Tapsmith tests and your unit tests

Jest and Vitest run every `*.test.ts` and `*.spec.ts` file in the project by default, so a Tapsmith test with one of those names would run in your unit-test suite too, and fail there. That's why `tapsmith init` names its example `tests/example.tapsmith.ts` and writes `testMatch: ['**/*.tapsmith.ts']` into the config: name your Tapsmith test files `*.tapsmith.ts` and each suite leaves the other's files alone. Keep them out of `__tests__` folders, though: Jest runs every file in one, whatever its name.

If you'd rather keep `*.test.ts` names, set `testMatch` in `tapsmith.config.ts` to `['tests/**/*.test.ts']` (or remove it to use the default, which also matches `*.test.ts` files outside `tests/`), and exclude the Tapsmith test directory from the unit-test runner: `testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/']` in your Jest config, or `exclude: [...configDefaults.exclude, 'tests/**']` under `test` in your Vitest config (`configDefaults` comes from `vitest/config`). Re-running `tapsmith init` warns about any Tapsmith tests the new config's `testMatch` won't run.

## Make runs faster (optional)

Tapsmith resets your app between test files by wiping its data and cold-launching — several seconds per file. React Native / Expo apps can do far better: mount `@tapsmith/react-native` once at the root and Tapsmith resets the app **in-process, in well under a second** — no config changes. Files that need a fresh app before every test opt in with one more line: `test.use({ appResetScope: "test" })` — still warm, still sub-second.

```tsx
import * as Linking from "expo-linking"
import { TapsmithTestHooks } from "@tapsmith/react-native"
// in your root layout:
<TapsmithTestHooks
  urlPrefix={Linking.createURL("/")}
  enabled={__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === "1"}
/>
```

A warm reset re-navigates and runs your own reset, but it does not wipe stored data unless you pass the stores to `clear`, such as `clear={[AsyncStorage]}`. See the [Warm app reset guide](warm-reset.md) for that, and for why the hooks must only ever be compiled into test builds, never a store release.

## Manual Configuration

If you prefer to configure manually, create `tapsmith.config.ts` in your project root:

### Android

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  testMatch: ["**/*.tapsmith.ts"],
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
  package: "com.example.myapp",
  timeout: 30_000,
  screenshot: "only-on-failure",
});
```

`testMatch` makes Tapsmith run `*.tapsmith.ts` files, the names `tapsmith init` uses, which your Jest or Vitest run leaves alone ([why](#tapsmith-tests-and-your-unit-tests)); without it Tapsmith runs `*.test.ts` and `*.spec.ts` files. `apk` is the path to the Android APK you want to test; Tapsmith installs it. `package` is its package name, and you need it too: without `package`, Tapsmith never launches the app and never resets it between test files, so tests start on whatever happens to be on screen. `activity` is optional and usually not needed.

### iOS

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  testMatch: ["**/*.tapsmith.ts"],
  platform: "ios",
  app: "./ios/build/Build/Products/Debug-iphonesimulator/MyApp.app",
  package: "com.example.myapp",
  simulator: "iPhone 17",
  timeout: 30_000,
  screenshot: "only-on-failure",
});
```

For iOS, `platform: "ios"` is required: Tapsmith does not infer the platform from `app`, and a config that sets `app` or `simulator` without it is treated as Android: the run looks for an Android device (and fails there when there is none), and is refused when tests start (`tapsmith doctor` reports it up front as `config-platform`). Set `app` to the `.app` bundle built for the iOS Simulator, `package` to its bundle identifier (needed to launch and reset the app, as on Android), and `simulator` to the simulator to boot.

See the [Configuration](configuration.md) guide for all available options.

### Parallel runs

For parallel Android emulator runs, use:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  testMatch: ["**/*.tapsmith.ts"],
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

On your own machine, each emulator Tapsmith launches opens a window and
quick-boots from the AVD's snapshot. In CI it runs headless, and
`emulatorLaunchOptions: { headless: true }` does the same locally, at the cost
of a slower cold boot. Emulators Tapsmith
launches keep running after the run so the next one can reuse them. The run
names each one and says how to stop it. See
[How Tapsmith launches emulators](./configuration.md#how-tapsmith-launches-emulators).

For parallel iOS simulator runs:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  testMatch: ["**/*.tapsmith.ts"],
  platform: "ios",
  app: "./ios/build/Build/Products/Debug-iphonesimulator/MyApp.app",
  package: "com.example.myapp",
  workers: 4,
  simulator: "iPhone 17",
});
```

Tapsmith provisions additional simulator clones automatically for multi-worker iOS runs.

## Write Your First Test

Create a file at `tests/smoke.tapsmith.ts`:

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
- **Tests in the same file share the app.** Tapsmith resets the app to a clean state once at the start of each test file, not before every test. So the second test above starts on whatever screen the first one left, with any state it created, such as a signed-in user. This differs from Playwright, where every test gets a fresh browser context. If a file's tests each need a fresh app, add `test.use({ appResetScope: "test" })` to that file. Without in-app hooks, each of those resets is a full clear and relaunch, which takes a few seconds per test. React Native and Expo apps that mount the [warm reset hooks](warm-reset.md) reset in well under a second instead. [Test isolation](writing-tests.md#test-isolation) covers the other reset options.

## Run Your Tests

```bash
npx tapsmith test
```

Tapsmith will:

1. Connect to the Tapsmith daemon (starting it if needed).
2. Detect your connected device or emulator.
3. Install the APK under test and the Tapsmith agent.
4. Discover the test files your config's `testMatch` matches (`**/*.tapsmith.ts` in a config from `tapsmith init`; `**/*.test.ts` and `**/*.spec.ts` when the config doesn't set it).
5. Run each test sequentially and report results.

For multi-worker runs, Tapsmith will assign one device per worker. If
`launchEmulators: true` is configured, it will launch additional emulator
instances automatically. If `avd` is set, those instances will use that AVD.

### Run a specific file

```bash
npx tapsmith test tests/smoke.tapsmith.ts
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

  tests/smoke.tapsmith.ts

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

You can use `describe` blocks to group tests, and `test.use()` to set options for a group:

```typescript
import { test, describe, expect } from "tapsmith";

describe("Login flow", () => {
  // Start every test signed out. Without this, "invalid credentials" would
  // start where "successful login" left off: already signed in.
  test.use({ appResetScope: "test" });

  test("successful login", async ({ device }) => {
    await device.getByRole("textfield", { name: "Email" }).type("user@example.com");
    await device.getByRole("textfield", { name: "Password" }).type("password123");
    // The keyboard is still up. On a React Native ScrollView, which by default
    // spends the next tap on closing it, tap() puts it away first. On a screen
    // without one, call device.hideKeyboard() first if the keyboard covers
    // the button.
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

`test.use()` inside a `describe` applies only to the tests in that group. Hooks (`beforeAll`, `beforeEach`, `afterEach`, `afterAll`) are also available. You don't need one to reset the app, because the reset is declared with `appReset` and `appResetScope` instead. See [Writing Tests](writing-tests.md#test-isolation).

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
- Moving tests over from another tool? See the migration guides for [Maestro](migrating-from-maestro.md), [Detox](migrating-from-detox.md) and [Appium](migrating-from-appium.md).
