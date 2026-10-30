# Parallel Execution and Sharding

This guide covers running Tapsmith tests in parallel across multiple devices and splitting test suites across CI machines with sharding.

## Parallel Execution

### Overview

By default, Tapsmith runs tests sequentially on a single device. To run tests in parallel, set the `workers` option in your config file or use the `--workers` / `-j` CLI flag:

```bash
npx tapsmith test --workers 4
npx tapsmith test -j 4
```

Or in your config:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  workers: 4,
});
```

Each worker gets its own device, daemon instance, and agent. Tapsmith distributes test files across workers using a work-stealing queue -- workers pull the next available file when they finish their current one, which provides natural load balancing without requiring upfront knowledge of test durations.

`workers` counts concurrent test files, not devices: a project whose tests drive two devices each (`use.devices`, see [Multi-device tests](./multi-device.md)) needs two devices per worker.

### Android Parallel Setup

The recommended approach for Android is to let Tapsmith launch emulator instances automatically. Set `launchEmulators: true` and specify the `avd` to use:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-debug.apk",
  package: "com.example.myapp",
  workers: 4,
  launchEmulators: true,
  avd: "Pixel_9_API_35",
});
```

With this configuration, Tapsmith launches repeated read-only instances of the specified AVD -- one per worker. The AVD must already exist on your system (`avdmanager list avd` to check). Read-only instances share the same base snapshot, so they boot quickly and do not interfere with each other.

The emulators boot side by side rather than one after another, up to one per two CPU cores at a time (at least one), since each boot keeps several cores busy. Each one is started once the one before it has started up, because two instances of one AVD started at the same moment can crash. If one fails to boot, the ones already booting carry on and the run uses the ones that came up. An AVD that failed is not launched again in that run. Each launch takes its own console port, so two Tapsmith runs on one machine (UI mode beside `tapsmith test`, for example) never launch onto the same port.

If you have devices or emulators already running and want Tapsmith to use them before launching new ones, set `deviceStrategy: "prefer-connected"`:

```typescript
export default defineConfig({
  apk: "./app-debug.apk",
  package: "com.example.myapp",
  workers: 4,
  launchEmulators: true,
  avd: "Pixel_9_API_35",
  deviceStrategy: "prefer-connected",
});
```

With `prefer-connected`, Tapsmith assigns already-running healthy devices first and only launches additional emulators to fill the remaining worker slots.

### iOS Parallel Setup

For iOS, Tapsmith clones simulators automatically when multiple workers are requested. Specify the base simulator name and Tapsmith handles the rest:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  platform: "ios",
  app: "./build/MyApp.app",
  package: "com.example.myapp",
  workers: 4,
  simulator: "iPhone 17",
});
```

Tapsmith creates clones of the specified simulator device type for each worker beyond the first. These clones are managed automatically -- they are created at the start of the run and cleaned up afterward.

Workers use only simulators that match `simulator` (by name or UDID) and Tapsmith's own clones of it. A booted simulator with any other name is left alone, even when it runs the same iOS version.

No additional setup is required beyond having Xcode installed with the target simulator runtime available.

### Worker Output

When running with multiple workers, console reporters prefix each line of output with the worker index so you can tell which worker produced which result:

```
  [worker 0] PASS  login flow > successful login (2104ms)
  [worker 1] PASS  settings > can toggle notifications (1842ms)
  [worker 0] PASS  login flow > invalid credentials (1531ms)
  [worker 2] FAIL  profile > can update avatar (30012ms)
  [worker 1] PASS  settings > can change language (2210ms)
```

Each `TestResult` object includes a `workerIndex` field, which is available to custom reporters and in the JSON/JUnit output. This is useful for correlating failures with specific devices when debugging.

### Test Independence

Tests running in parallel **must be independent of each other**. Each worker runs in its own process with its own device, app instance, and agent -- there is no shared state between workers at the Tapsmith level.

Guidelines for writing parallel-safe tests:

- **No shared mutable state.** Do not rely on one test setting up data that another test reads. Each test should create whatever it needs.
- **Use unique test data.** If tests create accounts, use unique emails or usernames per test to avoid collisions on shared backends.
- **Avoid assumptions about execution order.** Test files are distributed dynamically across workers. A file that ran first in sequential mode may run last in parallel mode.
- **Be careful with backend state.** Each worker has its own isolated app, but if your tests modify shared server-side data (database records, feature flags, etc.), tests can interfere with each other. Use test-scoped data or per-test API keys where possible.

## Projects (Multi-Device Targeting)

### Overview

Tapsmith supports Playwright-style project configuration for targeting multiple devices or platforms in a single test run. Each project defines its own device settings via a `use` block, and Tapsmith provisions separate devices for each project.

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  package: "com.example.app",
  timeout: 30_000,

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
      },
    },
  ],
});
```

Top-level fields (`package`, `timeout`, etc.) are inherited by every project as defaults. The `use` block in each project overrides these defaults with device-specific settings.

A single project must not mix Android fields (`avd`, `apk`) with iOS fields (`simulator`, `app`). Tapsmith validates this at startup and reports an error if it finds a conflict.

### Per-Project Workers

Each project can set its own `workers` count. Per-project worker counts are **additive** -- they do not consume from a shared global budget:

```typescript
export default defineConfig({
  projects: [
    {
      name: "android",
      workers: 2,
      use: {
        platform: "android",
        avd: "Pixel_6_API_34",
        apk: "./android.apk",
        launchEmulators: true,
      },
    },
    {
      name: "ios",
      workers: 1,
      use: {
        platform: "ios",
        simulator: "iPhone 16",
        app: "./ios/MyApp.app",
      },
    },
  ],
});
```

This runs the Android project on 2 devices and the iOS project on 1 device, concurrently. Total parallelism is 3 workers.

When per-project `workers` are not set, the global `workers` budget is split proportionally across projects based on their test file count, with at least 1 worker per project.

If the total worker count comes out to 1 (for example, `workers: 1` globally with no per-project overrides), Tapsmith runs projects sequentially, tearing down and re-provisioning the device between each. This is useful on machines that can only support one emulator or simulator at a time.

### Cross-Platform Testing

The most common use of projects is running the same test suite against both Android and iOS:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  projects: [
    {
      name: "android",
      use: {
        platform: "android",
        avd: "Pixel_6_API_34",
        apk: "./android.apk",
        launchEmulators: true,
      },
      workers: 2,
    },
    {
      name: "ios",
      use: {
        platform: "ios",
        simulator: "iPhone 16",
        app: "./ios/MyApp.app",
      },
      workers: 1,
    },
  ],
});
```

A single `npx tapsmith test` invocation runs both platforms. Test files are shared across projects by default (controlled by `testMatch`), or you can use per-project `testMatch` to run different files on each platform.

If one platform's device can't start (no device found, or its workers fail at startup), `tapsmith test` still runs the other platform. Each test file of the broken platform's projects is reported as one failed result, giving the reason (for example `Device target "android Pixel_6" could not start: …`), and the run exits non-zero. UI and watch mode start on the platforms that can, and report the broken platform's tests as failed with the same reason. Running those tests again tries that platform's device again. If no platform can start, the run fails to start and lists each platform's reason.

Projects also work with `--ui` and `--watch` modes. UI mode groups tests by project name, and watch mode re-runs only the affected project when you edit a test file.

### Setup Projects

Use the `dependencies` field to run setup tasks before the main test suite. This is useful for authentication flows -- run login once, save the app state, and reuse it across all test workers:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  projects: [
    {
      name: "setup",
      testMatch: ["**/auth.setup.ts"],
    },
    {
      name: "tests",
      dependencies: ["setup"],
      use: {
        appState: "./auth-state.tar.gz",
      },
    },
  ],
});
```

The `setup` project runs first. When it completes, the `tests` project starts with the saved `appState` pre-loaded. This avoids repeating login flows in every test and reduces overall suite time.

## CI Sharding

### Splitting Across Machines

When your test suite is too large for a single CI machine, use sharding to split it across multiple jobs. The `--shard=x/y` flag deterministically partitions test files:

```bash
# Machine 1: runs roughly the first quarter of test files
npx tapsmith test --shard=1/4

# Machine 2: second quarter
npx tapsmith test --shard=2/4

# Machine 3: third quarter
npx tapsmith test --shard=3/4

# Machine 4: last quarter
npx tapsmith test --shard=4/4
```

Sharding is file-based and deterministic -- the same `--shard` value always selects the same set of files, regardless of worker count or execution order. This means re-running a failed shard reproduces the exact same file set.

### GitHub Actions Matrix

Here is a complete workflow that shards tests across 4 CI jobs, then merges the results. A `build` job
builds the app once, as the [Android CI workflow](ci-setup.md#github-actions-android) does, and each
shard downloads it to the same path, so `tapsmith.config.ts` keeps the `apk` path shown there:

```yaml
name: Mobile Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  # Build the APK once and share it with every shard.
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 45

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

      # Release, because a debug APK needs the Metro dev server.
      - name: Build the release APK
        working-directory: android
        run: ./gradlew assembleRelease -PreactNativeArchitectures=x86_64

      - uses: actions/upload-artifact@v4
        with:
          name: app-apk
          path: android/app/build/outputs/apk/release/app-release.apk
          retention-days: 1

  test:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Download the APK
        uses: actions/download-artifact@v4
        with:
          name: app-apk
          path: android/app/build/outputs/apk/release/

      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm

      - name: Start emulator and run tests
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 36
          arch: x86_64
          emulator-options: -no-window -gpu swiftshader_indirect -no-snapshot -noaudio -no-boot-anim
          script: npx tapsmith test --shard=${{ matrix.shard }}/4

      - name: Upload blob report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: blob-report-${{ matrix.shard }}
          path: blob-report/

      - name: Upload test artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: tapsmith-results-${{ matrix.shard }}
          path: tapsmith-results/
          retention-days: 14

  merge-reports:
    needs: test
    runs-on: ubuntu-latest
    if: always()
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

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

Set `fail-fast: false` so that a failure in one shard does not cancel the other shards. This ensures you get complete results even when some tests fail.

### Merging Reports

When `--shard` is used, Tapsmith automatically adds the `blob` reporter alongside your configured reporters. Each shard writes its results to a `blob-report/` directory.

After all shards complete, collect the blob reports and merge them into a single report:

```bash
# Merge blob reports from all shards
npx tapsmith merge-reports ./all-blob-reports

# Open the merged HTML report
npx tapsmith show-report
```

The `merge-reports` command reads all blob files from the specified directory and produces a unified HTML report in `tapsmith-report/`. This report contains results from every shard, ordered and grouped as if the suite had run on a single machine.

`merge-reports` refuses a merge it can't trust, with exit status 1: an empty directory, a corrupt
blob, a duplicated shard, or blobs from different runs. If a shard is missing, it still reports
the shards that finished, then names the missing one and exits 1. Each shard's
`blob-report/` is emptied at the start of its run, so re-running a shard locally replaces its blob
instead of adding a second one. A merge whose tests failed still exits 0, as in Playwright, and
its last line gives the merged status. See [`tapsmith merge-reports`](api-reference.md#tapsmith-merge-reports-dir).

### Combining Workers and Sharding

Each shard can still use multiple workers internally. The total parallelism is **shards x workers**:

```bash
# 4 CI machines, each running 2 workers = 8 devices total
npx tapsmith test --shard=1/4 --workers 2
```

This is useful when your CI machines have enough resources to run multiple emulators but you still want to split the suite across machines for faster wall-clock time.

For the config file equivalent:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-debug.apk",
  package: "com.example.myapp",
  workers: 2,
  launchEmulators: true,
  avd: "Pixel_9_API_35",
  // shard is typically set via CLI, not config
});
```

Then run with `--shard=x/y` from each CI job.

## Best Practices

### Choosing Worker Count

Each device consumes significant system resources. Recommended starting points:

| Platform | RAM per device | CPU recommendation | Suggested workers |
|---|---|---|---|
| Android emulator | ~2 GB | 2 cores per emulator | 2--4 on a 16 GB machine |
| iOS simulator | ~1 GB | 1--2 cores per simulator | 2--4 on a 16 GB machine |

Start with 2 workers and increase gradually while monitoring system load. Too many workers on an under-resourced machine leads to slower tests (due to CPU/memory contention) and flaky timeouts. On CI, check what your runner provides -- GitHub-hosted `ubuntu-latest` runners have 4 vCPUs and 16 GB RAM, which can comfortably support 2 Android emulators.

For CI, consider increasing the default timeout to account for the overhead of multiple emulators competing for resources:

```typescript
const isCI = process.env.CI === "true"

export default defineConfig({
  workers: isCI ? 2 : 4,
  timeout: isCI ? 60_000 : 30_000,
});
```

### Device Isolation

Each worker gets its own device with its own app installation. App data is fully isolated -- actions in one worker do not affect another worker's app state.

However, device isolation does not extend to your backend. If multiple workers modify the same server-side resources (user accounts, database rows, shared queues), tests can interfere with each other. Strategies to handle this:

- **Test-scoped data.** Generate unique usernames, email addresses, or IDs per test.
- **Per-worker backend environments.** If your backend supports it, point each worker at a separate test tenant or namespace.
- **Idempotent tests.** Design tests so they succeed regardless of pre-existing state.

### Several sessions on one machine

Two Tapsmith sessions driving one device break each other: each restarts the other's agent and app, and the
failures read as flaky tests ("hierarchy contains no elements", "Failed to connect to agent socket"). So every
session records the devices it drives, and no other session takes them while it runs. A *session* is one
`tapsmith test` (sequential, `--workers N`, `--watch` or `--ui`) or one `tapsmith mcp-server`. Its workers,
watch re-runs, UI workers and an MCP server's `tapsmith_run_tests` runs are all part of it, and share its
devices.

- **Auto-picked devices** skip a device another session holds. Booted simulators and connected emulators that
  are in use are passed over; when more devices are needed, provisioning boots, launches or clones others as it
  would if the held ones were not there. Tapsmith's
  reusable simulator clones are never reused or deleted while another session is using them.
- **Pinned devices** (`--device`, `device` in the config or a project, a `use.devices` member) that another
  session holds are refused, and the error names that session's command, process id and directory:

  ```
  Device emulator-5554 is in use by another Tapsmith session: `tapsmith test --ui` (pid 4242) in /work/app, since 10:41:03.
  ```

- **Daemons** another session is driving a device through are never adopted or repointed, including the one on
  the default `localhost:50051` that a headless MCP server or a `tapsmith test` would otherwise connect to. A
  session uses only the daemon it started: if another session's daemon takes the port first, the session starts
  its own on a free port, and it never stops a daemon it did not start, even one that is slow to answer.
- **`tapsmith list-devices`** shows which session holds each device (`inUseBy` in `--json`).

A session's claims end when it exits, and a claim stands only while a process of that session that claimed it
still runs: a session that crashed or was killed holds nothing, and its devices are free for the next run at
once, with nothing to clean up. If a process outlives its session (a worker left running), the refusal names it. The claims live in `~/.tapsmith/claims/`, one file per device.
They coordinate Tapsmith sessions only: an emulator you are using by hand, or a device another tool drives, is
not protected by them.

### Reporter Considerations

When running in parallel or with sharding, keep these reporter behaviors in mind:

- **Worker index.** Every `TestResult` includes `workerIndex`, available in JSON, JUnit, and custom reporters. Use it to correlate failures with specific devices.
- **Blob reporter.** Automatically added when `--shard` is used. Writes machine-readable results to `blob-report/` for later merging.
- **HTML reporter.** Works well with both parallel and sharded runs. After merging, the HTML report shows all results in a single view.
- **Console reporters.** In parallel mode, output is prefixed with `[worker N]` to distinguish which worker produced each result.

For CI pipelines with sharding, a typical reporter setup is:

```typescript
export default defineConfig({
  reporter: [
    ["html", { outputFolder: "tapsmith-report" }],
    ["junit", { outputFile: "tapsmith-results/junit.xml" }],
  ],
});
```

The `blob` reporter is added automatically when `--shard` is used, so you do not need to configure it manually.

## Reference

- [Configuration](configuration.md) -- full list of config options including `workers`, `shard`, `launchEmulators`, `avd`, and `simulator`.
- [CI Setup](ci-setup.md) -- complete CI workflow examples for Android and iOS.
- [API Reference](api-reference.md) -- `TestResult` fields, reporter APIs, and device methods.
