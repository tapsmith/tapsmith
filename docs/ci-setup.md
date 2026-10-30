# CI Setup

This guide covers running Tapsmith tests in continuous integration environments.

## Overview

To run Tapsmith tests in CI, you need:

1. Node.js 22+ installed.
2. The Tapsmith daemon binary (installed automatically with `npm install tapsmith`).
3. **Android**: ADB on the PATH, and either an AVD for Tapsmith to launch (see [Letting Tapsmith launch the emulator](#letting-tapsmith-launch-the-emulator)) or an emulator you start yourself.
4. **iOS**: A macOS runner with Xcode installed (simulators are managed by Tapsmith).

## GitHub Actions (Android)

Here is a complete GitHub Actions workflow that builds a React Native app, starts an emulator, and
runs Tapsmith tests (for an Android Studio project, see [Native Android project](#native-android-project), and for a Flutter app, [Flutter app on Android](#flutter-app-on-android)). It works as pasted in a React Native CLI project and in an Expo project, whether
or not the project commits its `android/` directory: when `android/` is missing (Expo's
[Continuous Native Generation](https://docs.expo.dev/workflow/continuous-native-generation/)), the
workflow generates it with `npx expo prebuild`.

```yaml
name: Android Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 60

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Set up JDK
        uses: actions/setup-java@v4
        with:
          distribution: "temurin"
          java-version: "17"

      # Expo projects that don't commit android/ generate it here.
      - name: Generate the native project (Expo)
        if: hashFiles('android/gradlew') == ''
        run: npx expo prebuild --platform android

      # A release build bundles the JavaScript into the APK. A debug build
      # loads it from the Metro dev server, which isn't running in CI.
      # Building only the emulator's ABI (x86_64) cuts the build time.
      - name: Build the release APK
        working-directory: android
        run: ./gradlew assembleRelease -PreactNativeArchitectures=x86_64

      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm

      - name: Start the emulator and run the tests
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 33
          arch: x86_64
          emulator-options: -no-window -gpu swiftshader_indirect -no-snapshot -noaudio -no-boot-anim
          script: npx tapsmith test

      - name: Upload test artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: tapsmith-results
          path: tapsmith-results/
          retention-days: 14
```

The matching config points `apk` at the APK the workflow builds. Set `package` to your app's
`applicationId` (in `android/app/build.gradle`). In an Expo project that doesn't commit `android/`,
set `android.package` in `app.json` and use that: without it, `expo prebuild` makes an ID up from
the account it runs as, so it differs between your machine and CI.

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./android/app/build/outputs/apk/release/app-release.apk",
  package: "com.example.myapp",
  timeout: 60_000, // CI emulators are slower than a developer machine
});
```

### Key Points

- **Release build.** A debug APK loads its JavaScript from the Metro dev server, so in CI the app
  opens on an error screen instead of your UI. React Native CLI and Expo projects both sign release builds with the
  debug keystore until you configure your own, so the APK installs on an emulator as it is.
- **Native project.** The `if: hashFiles('android/gradlew') == ''` condition runs `expo prebuild`
  only when the project does not commit `android/`; a React Native CLI project (or an Expo project
  that commits it) skips the step.
- **KVM acceleration** is required for acceptable emulator performance on Linux CI runners. The
  `Enable KVM` step configures this.
- The `android-emulator-runner` action handles downloading the system image, creating the AVD, and
  starting the emulator. Your test command runs in the `script` parameter after the emulator boots.
- The `if: always()` on the upload step ensures screenshots are uploaded even when tests fail.
- The workflow uses npm. With Yarn or pnpm, change the `cache` input and the install command (for
  example `yarn install --frozen-lockfile`).
- **What a release build turns off.** `__DEV__` is false in a release build, so anything your app
  enables only in development is off in CI. Two things Tapsmith uses:
  - the [`@tapsmith/react-native` reset hooks](warm-reset.md#release-builds-for-e2e). In an Expo
    project whose root layout passes `enabled={__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === "1"}`
    (as the guide shows), keep them by setting `EXPO_PUBLIC_TAPSMITH_HOOKS: "1"` in the `env` of the
    build step (only in the job that builds your test app, never a store build). A React Native CLI
    project's Babel preset does not inline that variable: add a Babel plugin that does (such as
    `babel-plugin-transform-inline-environment-variables`), or set the provider's `enabled` prop from
    a flag your own build already passes.
  - [WebView debugging](webview.md), which `device.webview()` needs: a
    `webviewDebuggingEnabled={__DEV__}` prop must be enabled for the test build too.

### Native Android project

In an Android Studio project, with Gradle and Tapsmith's `package.json` both at the root of the
repository, the same workflow builds the debug APK at the root instead: there is no `android/`
folder, no `expo prebuild` and no Metro. Replace the `Generate the native project (Expo)` and
`Build the release APK` steps with this one:

```yaml
      # A native debug APK needs no dev server, and Gradle signs it with the
      # debug keystore, so it installs on the emulator as built.
      - name: Build the debug APK
        run: ./gradlew assembleDebug
```

and point `apk` at it:

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
  package: "com.example.myapp", // applicationId in app/build.gradle.kts
  timeout: 60_000,
});
```

Build the debug variant rather than `assembleRelease`: Android Studio's project templates leave the
release build unsigned, and an unsigned APK does not install. An app module not named `app` (often
`composeApp` in a Kotlin Multiplatform project) writes to `<module>/build/outputs/apk/debug/`.

### Flutter app on Android

In a Flutter project, with `pubspec.yaml` and Tapsmith's `package.json` both at the root of the
repository, install Flutter and build the debug APK with it. Replace the
`Generate the native project (Expo)` and `Build the release APK` steps with these two, keeping
`Set up JDK` before them, since the Gradle build that `flutter build` runs needs it:

```yaml
      - name: Set up Flutter
        uses: subosito/flutter-action@v2
        with:
          channel: stable
          cache: true

      # A Flutter debug APK holds the app's Dart code and runs on its own.
      # --target-platform builds only the emulator's ABI, which cuts the build time.
      - name: Build the debug APK
        run: flutter build apk --debug --target-platform android-x64
```

and point `apk` at it:

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./build/app/outputs/flutter-apk/app-debug.apk",
  package: "com.example.my_app", // applicationId in android/app/build.gradle.kts
  timeout: 60_000,
});
```

Keep the emulator on a rootable image: the `android-emulator-runner` default (`target: default`) or
`google_apis`, not `google_apis_playstore`. On a Google Play image Tapsmith cannot capture the
traffic of `package:http` or `dio` ([Flutter apps](network.md#flutter-apps)).

### Letting Tapsmith launch the emulator

Instead of starting the emulator in the workflow, you can give Tapsmith an AVD and let it launch
the emulator itself — the same setup as on a developer machine, and the one
[parallel workers](#parallel-workers) need:

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./android/app/build/outputs/apk/release/app-release.apk",
  package: "com.example.myapp",
  avd: "Tapsmith_Phone_API_36", // launchEmulators defaults to true when avd is set
  timeout: 60_000,
});
```

These steps replace the workflow's `Enable KVM` and `Start the emulator and run the tests` steps
(keep `Upload test artifacts` after them):

```yaml
      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm

      - name: Put adb on the PATH
        run: echo "$ANDROID_HOME/platform-tools" >> "$GITHUB_PATH"

      # Downloads the Google APIs system image and creates Tapsmith_Phone_API_36.
      - name: Create AVD
        run: npx tapsmith create-avd --install-tools

      - name: Run Tapsmith tests
        run: npx tapsmith test
```

In CI, Tapsmith launches the emulator headless (no window, software GPU, cold boot) and waits up to
5 minutes for it to boot. The emulator is left running after the run so a rerun on the same machine
can reuse it; a hosted runner discards it with the job. On a self-hosted runner that keeps its state
between jobs, create the AVD once instead of in every run: `create-avd` refuses to overwrite an
existing AVD unless you pass `--force`.

Booting in the workflow (as above with `android-emulator-runner`) overlaps the boot with your other
setup steps, so it is usually a little faster. Tapsmith's own CI covers both setups: its main suites
boot the emulator in the workflow, and a separate job — run weekly and on changes to Tapsmith's
emulator-provisioning code — starts with nothing running and checks that Tapsmith launched the
emulators the tests ran on and left none it does not track. A weekly variant starts from a bare runner
through `tapsmith create-avd --install-tools`.

## GitHub Actions (iOS)

iOS tests require a macOS runner with Xcode installed. Tapsmith manages the simulator lifecycle
automatically. Like the Android workflow, this one works as pasted in a React Native CLI project and
in an Expo project (for an Xcode project, see [Native iOS project](#native-ios-project), and for a Flutter app, [Flutter app on iOS](#flutter-app-on-ios)), generating `ios/` with `npx expo prebuild` when the project does not commit it.
Replace `MyApp` with your app's name — the name of the `.xcworkspace` in `ios/`, which is also its
scheme and the name of the built `.app`. In an Expo project that doesn't commit `ios/`, `expo prebuild`
derives that name from `name` in `app.json` and drops characters Xcode can't use, so run
`npx expo prebuild --platform ios` once locally and use the name of the `.xcworkspace` it creates:

```yaml
name: iOS Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: macos-26
    timeout-minutes: 60

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      # Expo projects that don't commit ios/ generate it here.
      - name: Generate the native project (Expo)
        if: hashFiles('ios/Podfile') == ''
        run: npx expo prebuild --platform ios --no-install

      - name: Install CocoaPods
        working-directory: ios
        run: pod install

      # A Release build bundles the JavaScript into the app. A Debug build
      # loads it from the Metro dev server, which isn't running in CI.
      # -derivedDataPath puts the .app where tapsmith.config.ts expects it.
      # ARCHS=arm64 builds only the Apple-silicon simulator slice the runner
      # needs; a Release build otherwise compiles x86_64 too, doubling the time.
      - name: Build the app for the simulator
        working-directory: ios
        run: |
          xcodebuild build \
            -workspace MyApp.xcworkspace \
            -scheme MyApp \
            -configuration Release \
            -sdk iphonesimulator \
            -destination 'generic/platform=iOS Simulator' \
            -derivedDataPath build \
            ARCHS=arm64 \
            -quiet

      - name: Run Tapsmith tests
        run: npx tapsmith test

      - name: Upload test artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: tapsmith-results
          path: tapsmith-results/
          retention-days: 14
```

The matching config points `app` at the `.app` bundle the workflow builds. Set `package` to your
app's bundle identifier (`PRODUCT_BUNDLE_IDENTIFIER` in Xcode, or `ios.bundleIdentifier` in an Expo
project's `app.json`, which, as on Android, you should set rather than leave to `expo prebuild`), and
`simulator` to a simulator the runner's Xcode has:

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  platform: "ios",
  app: "./ios/build/Build/Products/Release-iphonesimulator/MyApp.app",
  package: "com.example.myapp",
  simulator: "iPhone 17",
  timeout: 60_000,
});
```

### Key Points

- **macOS runner** is required for iOS simulators. The workflow pins `macos-26`, whose Xcode has the
  `iPhone 17` simulator the config names; if you change the runner image, check the simulator names
  it has (`xcrun simctl list devices available`) and update `simulator` to match. `ARCHS=arm64`
  assumes an Apple-silicon runner, as `macos-26` is; drop it on an Intel one.
- **Time.** A stock Expo app took about 25 minutes end to end on `macos-26`: around 10 for the
  build, and around 10 for Tapsmith's first-run setup (booting the simulator, then installing and
  starting its XCUITest agent). A larger app's build takes longer; raise `timeout-minutes` to suit.
- **Release build and a fixed output path.** Without `-derivedDataPath`, `xcodebuild` puts the
  `.app` under `~/Library/Developer/Xcode/DerivedData/<name>-<hash>/`, a path the config cannot name.
  `-workspace` (not `-project`) is needed because React Native projects build their dependencies
  through CocoaPods.
- **Native project.** `expo prebuild --no-install` generates `ios/` without installing pods, so the
  `Install CocoaPods` step does that for both project kinds.
- **Release build caveats.** As on Android, `__DEV__` is false: keep the
  [reset hooks](warm-reset.md#release-builds-for-e2e) and WebView debugging on in the test build as
  [the Android notes](#key-points) describe, with `EXPO_PUBLIC_TAPSMITH_HOOKS: "1"` on this build step
  in an Expo project.
- Tapsmith boots and manages simulators automatically -- no manual `xcrun simctl` setup needed. Tapsmith's own CI checks this weekly and on changes to its simulator-provisioning code: it starts with no simulator booted and verifies that Tapsmith booted the configured one.
- With `workers` above 1, Tapsmith boots a simulator for each extra worker (another simulator of the same name and OS, or a clone of the configured one). The standard 3-core GitHub-hosted macOS runner cannot run two simulators at usable speed (app installs and XCUITest launches time out), so keep `workers: 1` there or use a larger runner. Tapsmith's CI does not cover multiple simulators on hosted runners for this reason.

### Native iOS project

In an Xcode project, with the `.xcodeproj` and Tapsmith's `package.json` both at the root of the
repository, there is no `ios/` folder, no CocoaPods and no Metro. Replace the
`Generate the native project (Expo)`, `Install CocoaPods` and `Build the app for the simulator`
steps with this one, which builds the project itself (a Debug build runs on its own here):

```yaml
      - name: Build the app for the simulator
        run: |
          xcodebuild build \
            -project MyApp.xcodeproj \
            -scheme MyApp \
            -configuration Debug \
            -sdk iphonesimulator \
            -destination 'generic/platform=iOS Simulator' \
            -derivedDataPath build \
            ARCHS=arm64 \
            -quiet
```

and point `app` at the build:

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  platform: "ios",
  app: "./build/Build/Products/Debug-iphonesimulator/MyApp.app",
  package: "com.example.myapp", // PRODUCT_BUNDLE_IDENTIFIER
  simulator: "iPhone 17",
  timeout: 60_000,
});
```

If the project has an `.xcworkspace` (CocoaPods, or Swift packages added through a workspace), build
it with `-workspace MyApp.xcworkspace`, after `pod install` when it uses CocoaPods. With XcodeGen and
no committed `.xcodeproj`, generate it first in a step that runs `brew install xcodegen` and then
`xcodegen generate`.

### Flutter app on iOS

In a Flutter project, with `pubspec.yaml` and Tapsmith's `package.json` both at the root of the
repository, install Flutter and build the app for the simulator with it. Replace the
`Generate the native project (Expo)`, `Install CocoaPods` and `Build the app for the simulator`
steps with these two (`flutter build` runs `pod install` itself when the app has plugins):

```yaml
      - name: Set up Flutter
        uses: subosito/flutter-action@v2
        with:
          channel: stable
          cache: true

      # A Flutter debug build holds the app's Dart code and runs on its own.
      - name: Build the app for the simulator
        run: flutter build ios --simulator --debug
```

and point `app` at the build:

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  platform: "ios",
  app: "./build/ios/iphonesimulator/Runner.app",
  package: "com.example.myApp", // PRODUCT_BUNDLE_IDENTIFIER in ios/Runner.xcodeproj
  simulator: "iPhone 17",
  timeout: 60_000,
});
```

On a GitHub-hosted runner, Tapsmith captures iOS traffic through the macOS system proxy
([iOS network capture on CI](#ios-network-capture-on-ci)), and Dart's own HTTP client, which
`package:http` and `dio` use, does not go through it: their requests work but are not captured,
so `device.route()` and `waitForResponse()` do not see them there. `cupertino_http` requests are
captured ([Flutter apps](network.md#flutter-apps)).

### iOS network capture on CI

iOS network capture (trace + `network.json` in the trace viewer) needs no setup step on a
GitHub-hosted runner. On a developer Mac, Tapsmith routes each simulator's traffic through a macOS
**Network Extension** redirector (bundled with [mitmproxy](https://mitmproxy.org)) that captures that
simulator's traffic only. When the redirector is unavailable and the `CI` environment variable is set,
as it is on GitHub Actions, Tapsmith falls back to the macOS system proxy instead. That fallback is
host-wide: the trace can also hold the runner's own traffic, the trace records
`"networkCaptureRoute": "ios-system-proxy"`, and the trace viewer flags it. Tapsmith's own iOS CI
runs this way. See [When the Network Extension is unavailable](./ios-network-capture.md#when-the-network-extension-is-unavailable)
for the details.

The fallback is not device-isolated, so a [multi-device group](./ios-network-capture.md#multi-device-groups)
refuses it. For per-device capture, use a self-hosted runner with the redirector set up once:
`brew install mitmproxy` (Tapsmith extracts the redirector from mitmproxy's cask), then approve its
System Extension by hand in System Settings, as the
[first-run setup](./ios-network-capture.md#first-run-setup) describes. Don't add an
interactive `mitmproxy` command to a workflow: with no terminal it waits forever and the job hangs
until it times out.

If your tests do not need network capture, disable it in your tapsmith config
(`trace: { network: false }`).

See [iOS network capture](./ios-network-capture.md) for the full first-run walkthrough and troubleshooting.

## General CI Tips

### Emulator Startup

Android emulators can take 1-3 minutes to boot in CI. Make sure your CI timeout accounts for this. The `android-emulator-runner` action waits for the emulator to finish booting before running your script.

If you are managing the emulator yourself:

```bash
# Create an AVD — use a google_apis image, NOT google_apis_playstore:
# Google Play images don't support `adb root`, which Tapsmith needs to install
# its CA cert and redirect traffic, so HTTPS traffic won't appear in traces.
# (`npx tapsmith create-avd` wraps these two steps.)
avdmanager create avd -n test -k "system-images;android-33;google_apis;x86_64" --force

# Start the emulator in the background
emulator -avd test -no-window -gpu swiftshader_indirect -no-snapshot -noaudio -no-boot-anim &

# Wait for the device to boot completely
adb wait-for-device
adb shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'

# Run tests
npx tapsmith test
```

See [Android emulator image requirements](network.md#android-emulator-image-requirements) for details on why the system image type matters for network capture.

### ADB Setup

Most CI images with Android tooling already have ADB on the PATH. If yours does not:

```bash
export ANDROID_HOME=$HOME/android-sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

Verify ADB is working before running tests:

```bash
adb devices
# Should list your emulator, e.g.:
# emulator-5554   device
```

### Timeouts

CI emulators are slower than local machines. Increase the default timeout in your CI config:

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./android/app/build/outputs/apk/release/app-release.apk",
  timeout: 60_000, // 60 seconds for CI
  retries: 2, // Retry flaky tests
});
```

Or use a separate config for CI by checking an environment variable:

```typescript
import { defineConfig } from "tapsmith";

const isCI = process.env.CI === "true";

export default defineConfig({
  apk: "./android/app/build/outputs/apk/release/app-release.apk",
  timeout: isCI ? 60_000 : 30_000,
  retries: isCI ? 2 : 0,
  screenshot: isCI ? "always" : "only-on-failure",
});
```

### Screenshot Artifacts

Set the `screenshot` option to `"always"` in CI to capture screenshots for every test. This makes debugging failures much easier when you cannot see the emulator screen.

Screenshots are saved to `<outputDir>/screenshots/` (by default `tapsmith-results/screenshots/`). Upload this directory as a CI artifact so you can download and inspect screenshots after a run.

Each screenshot file is named with the test name and a timestamp:

```
tapsmith-results/screenshots/
  user_can_log_in-1710345600000.png
  shows_error_on_invalid_credentials-1710345601234.png
```

### Trace Artifacts

Enable trace recording in CI to get full step-by-step debugging for failures. The recommended mode is `retain-on-failure`, which records every test but only keeps the trace archive when a test fails:

```bash
npx tapsmith test --trace retain-on-failure
```

Upload traces as CI artifacts alongside screenshots:

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

After downloading the artifact, open the trace locally:

```bash
npx tapsmith show-trace tapsmith-results/traces/trace-login_test.zip
```

Or drop the `.zip` file onto [trace.tapsmith.dev](https://trace.tapsmith.dev) to view it in the browser without installing anything.

Network capture works in CI as well -- HTTP/HTTPS requests made by the app are recorded in the trace and visible in the Network tab of the trace viewer. **Android** runs need no extra setup, and neither do **iOS** runs on GitHub-hosted runners, where capture goes through the host-wide macOS system proxy — see [iOS network capture on CI](#ios-network-capture-on-ci) above.

### Caching

Cache the Android SDK and emulator system images to speed up CI runs:

```yaml
- name: Cache Android SDK
  uses: actions/cache@v4
  with:
    path: |
      ~/.android/avd
      ~/android-sdk
    key: android-sdk-${{ runner.os }}-api33
```

### Parallel Workers

Tapsmith can run multiple workers in parallel as long as each worker has its own
device or emulator instance. The recommended emulator-managed setup is:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./android/app/build/outputs/apk/release/app-release.apk",
  package: "com.example.myapp",
  workers: 4,
  launchEmulators: true,
  avd: "Pixel_9_API_35",
  timeout: 60_000,
});
```

With that config, `npx tapsmith test` will try to launch repeated instances of the
same AVD for all workers.

### CI Sharding

If your CI environment cannot support multiple emulator instances on one host,
split the suite across multiple jobs instead. Use `--shard=x/y` to
deterministically assign test files to each job:

```yaml
strategy:
  matrix:
    shard: [1, 2, 3]

steps:
  # ... setup steps ...
  - name: Run tests (shard ${{ matrix.shard }}/3)
    run: npx tapsmith test --shard=${{ matrix.shard }}/3

  - name: Upload blob report
    if: always()
    uses: actions/upload-artifact@v4
    with:
      name: blob-report-${{ matrix.shard }}
      path: blob-report/
```

When `--shard` is used, Tapsmith automatically adds the `blob` reporter so results
can be merged after all shards complete.

### Merging Sharded Reports

After all shard jobs finish, download the blob artifacts and merge them into a
single HTML report:

```yaml
merge-reports:
  needs: test
  runs-on: ubuntu-latest
  if: always()
  steps:
    - uses: actions/checkout@v4

    - name: Download blob reports
      uses: actions/download-artifact@v4
      with:
        pattern: blob-report-*
        path: all-blob-reports
        merge-multiple: true

    - name: Merge reports
      run: npx tapsmith merge-reports all-blob-reports

    # always(): with a shard missing, merge-reports exits 1 but still
    # writes the report for the shards that finished.
    - name: Upload HTML report
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: tapsmith-report
        path: tapsmith-report/
```
