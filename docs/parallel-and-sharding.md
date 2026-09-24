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
  app: "./build/MyApp.app",
  package: "com.example.myapp",
  workers: 4,
  simulator: "iPhone 17",
});
```

Tapsmith creates clones of the specified simulator device type for each worker beyond the first. These clones are managed automatically -- they are created at the start of the run and cleaned up afterward.

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

Here is a complete workflow that shards tests across 4 CI jobs, then merges the results:

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

      - name: Set up JDK
        uses: actions/setup-java@v4
        with:
          distribution: "temurin"
          java-version: "17"

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

      - name: Upload HTML report
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
blob, a missing or duplicated shard, or blobs from different shard splits. Each shard's
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
