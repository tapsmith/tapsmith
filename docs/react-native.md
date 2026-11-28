# React Native and Expo

Tapsmith tests React Native and Expo apps the way it tests any native app: it installs a build on an emulator, simulator or device, launches it, and drives it through the platform's accessibility tree. Nothing runs inside your JavaScript except the optional [warm reset hooks](warm-reset.md). This page collects what is specific to React Native: which builds to test, and how build variants, the JavaScript engine, over-the-air updates and Expo Go fit in. [Getting Started](getting-started.md#react-native-and-expo) has the build commands.

## Supported versions

| | Range |
|---|---|
| Tapsmith itself (`tapsmith`) | Any React Native or Expo version: it reads the native accessibility tree and does not depend on React Native |
| [`@tapsmith/react-native`](warm-reset.md) (warm reset hooks, optional) | Peer dependencies `react` 18 or later and `react-native` 0.72 or later |
| Debug and dev-client builds with Metro | Checked on Expo SDK 54 to 58 and on bare React Native 0.88 ([details](getting-started.md#debug-and-dev-client-builds-with-metro)) |

The device requirements (Android 8.0 / API 26 or later, iOS 17 or later) are in [Prerequisites](getting-started.md#prerequisites).

## Which build to test

Tapsmith tests the build your config names (`apk` for Android, `app` for iOS), not your source code. A Release build bundles your JavaScript and runs on its own, so it suits CI. A Debug or Expo development build loads the JavaScript from Metro, so Metro must be running while the tests run; it suits writing tests locally. [Build the app under test](getting-started.md#react-native-and-expo) shows both, and [After you change the app](getting-started.md#after-you-change-the-app) says when a change needs a rebuild.

### Expo Go

Tapsmith tests a build of your app, not Expo Go. Expo Go is Expo's own app: it loads your JavaScript inside itself, so a test that launches it sees Expo Go, not your project, and with `package` set to Expo Go Tapsmith warns that it is. Make a build instead (`npx expo run:android`, `npx expo run:ios`, or an EAS build) and point `apk` or `app` at it. A [development build](getting-started.md#debug-and-dev-client-builds-with-metro) keeps the edit-and-reload loop you had in Expo Go.

### Build variants and flavors

Any Android variant your device can install works. Point `apk` at that variant's output (for example `android/app/build/outputs/apk/staging/release/app-staging-release.apk` for a `staging` flavor) and set `package` to that variant's application ID, including any `applicationIdSuffix` (`com.example.myapp.staging`). On iOS, point `app` at the `.app` built for the scheme and configuration you test, and set `package` to its bundle identifier.

To test several variants, give each its own [project](configuration.md#projects-with-per-device-targeting) with its own `apk` or `app` and `package`, and pick one with `--project`.

### Hermes

Nothing changes. Tapsmith never talks to the JavaScript engine, so Hermes and JavaScriptCore builds are tested the same way.

### Over-the-air updates (EAS Update, CodePush)

Tapsmith knows nothing about over-the-air updates: the tests drive whatever JavaScript the app runs. A build that downloads an update when it launches can therefore run a newer bundle than the one it was built with, and a test run can change behaviour without a new build. For repeatable runs, test a build with updates turned off (for `expo-updates`, `"updates": { "enabled": false }` in the app config of the test build), or one that only receives updates from a channel you control.

## Warm reset

Between test files, Tapsmith resets the app by clearing its data and relaunching it. With [`@tapsmith/react-native`](warm-reset.md) mounted in your app, it resets the app in-process instead, in well under a second (a Release build keeps the hooks only when built with the flag described in [Release builds for e2e](warm-reset.md#release-builds-for-e2e)). A bare React Native app must register the URL scheme the reset links use; [Warm App Reset](warm-reset.md#add-the-in-app-hooks) shows how.

## Monorepos

Install Tapsmith in the package that holds your `tapsmith.config.ts`, and run `tapsmith` from there. [Package manager notes](getting-started.md#package-manager-notes) covers pnpm and Yarn workspaces.
