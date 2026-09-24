# CI Setup

This guide covers running Tapsmith tests in continuous integration environments.

## Overview

To run Tapsmith tests in CI, you need:

1. Node.js 22+ installed.
2. The Tapsmith daemon binary (installed automatically with `npm install tapsmith`).
3. **Android**: An Android emulator running in headless mode and ADB on the PATH.
4. **iOS**: A macOS runner with Xcode installed (simulators are managed by Tapsmith).

## GitHub Actions (Android)

Here is a complete GitHub Actions workflow that builds your app, starts an emulator, and runs Tapsmith tests.

```yaml
name: Mobile Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30

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

      - name: Build APK
        run: ./gradlew assembleDebug

      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm

      - name: Start emulator
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

### Key Points

- **KVM acceleration** is required for acceptable emulator performance on Linux CI runners. The `Enable KVM` step configures this.
- The `android-emulator-runner` action handles downloading the system image, creating the AVD, and starting the emulator. Your test command runs in the `script` parameter after the emulator boots.
- The `if: always()` on the upload step ensures screenshots are uploaded even when tests fail.

## GitHub Actions (iOS)

iOS tests require a macOS runner with Xcode installed. Tapsmith manages simulator lifecycle automatically.

```yaml
name: iOS Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: macos-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      # Required for iOS network capture — see "iOS network capture on CI" below.
      - name: Install mitmproxy (for iOS network capture redirector)
        if: ${{ true }} # omit this step if you disable network capture in the trace config
        run: |
          brew install mitmproxy
          sudo mitmproxy --mode local:Safari <<< 'q' || true
          # The redirector System Extension needs pre-approval on self-hosted runners;
          # GitHub-hosted macOS runners accept new SEs automatically on first launch.

      - name: Build app for simulator
        run: |
          xcodebuild build-for-testing \
            -project MyApp.xcodeproj \
            -scheme MyApp \
            -destination 'platform=iOS Simulator,name=iPhone 17'

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

### Key Points

- **macOS runner** is required for iOS simulators. GitHub provides `macos-latest` with Xcode pre-installed.
- Tapsmith boots and manages simulators automatically -- no manual `xcrun simctl` setup needed.
- Build your app for the iOS Simulator target (not a physical device) using `build-for-testing` or your existing build pipeline.

### iOS network capture on CI

iOS network capture (trace + `network.json` in the trace viewer) routes simulator traffic through Tapsmith's MITM proxy via a macOS **Network Extension** redirector that is bundled with [mitmproxy](https://mitmproxy.org). You need two one-time prerequisites on the CI runner for this to work:

1. **`brew install mitmproxy`** — Tapsmith discovers the redirector at `/Applications/Mitmproxy Redirector.app` (mitmproxy's installer unpacks it there) or via `$TAPSMITH_REDIRECTOR_APP`. Alternatively, it will extract the redirector from mitmproxy's brew cask tarball into `~/.tapsmith/redirector/` on first use.
2. **System Extension approval** — the redirector's Network Extension must be approved on first launch. On **GitHub-hosted macOS runners**, SEs are accepted automatically on first launch, so no action is needed. On **self-hosted runners**, run `sudo systemextensionsctl developer on` once to bypass interactive approval, or pre-approve the extension manually.

If your tests do not need network capture, disable it in your tapsmith config (`trace: { network: false }`) and skip the mitmproxy install step above.

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
  apk: "./app-debug.apk",
  timeout: 60_000, // 60 seconds for CI
  retries: 2, // Retry flaky tests
});
```

Or use a separate config for CI by checking an environment variable:

```typescript
import { defineConfig } from "tapsmith";

const isCI = process.env.CI === "true";

export default defineConfig({
  apk: "./app-debug.apk",
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

Network capture works in CI as well -- HTTP/HTTPS requests made by the app are recorded in the trace and visible in the Network tab of the trace viewer. **Android** runs need no extra setup; **iOS** runs need `brew install mitmproxy` and (on self-hosted runners) a pre-approved System Extension — see [iOS network capture on CI](#ios-network-capture-on-ci) above.

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
  apk: "./app-debug.apk",
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
