# Configuration

Tapsmith is configured through a `tapsmith.config.ts` file in your project root. All options have sensible defaults, so a minimal config is just a few lines.

## Basic Setup

Create `tapsmith.config.ts` in your project root:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
});
```

Tapsmith also supports `tapsmith.config.js` and `tapsmith.config.mjs` if you prefer plain JavaScript.

For clean emulators or CI devices, `apk` is the important setting because it lets
Tapsmith install the app under test itself. `activity` is optional and mainly
useful as a stability hint when you want Tapsmith to launch a specific activity.
For emulator-managed runs, the recommended path is `launchEmulators + avd`.

## All Options

| Option | Type | Default | Description |
|---|---|---|---|
| `platform` | `"android" \| "ios"` | auto-detected | Target platform. Auto-detected from `apk` (Android) or `app` (iOS). |
| `apk` | `string` | `undefined` | Path to the APK under test (Android). |
| `app` | `string` | `undefined` | Path to the .app bundle under test (iOS). For simulators, build a simulator-slice `.app`. For physical devices, the `.app` must be code-signed with a profile matching the device — see [iOS physical devices](./ios-physical-devices.md). |
| `package` | `string` | `undefined` | Package name (Android) or bundle identifier (iOS) of the app under test. When set, Tapsmith launches the app before tests. |
| `activity` | `string` | `undefined` | Optional activity name to launch (Android only). Usually not needed; Tapsmith will try the default launcher activity automatically. |
| `timeout` | `number` | `30000` | Default timeout in milliseconds for actions and assertions. Each test body also gets a safety timeout of 3× this value; that budget counts only time spent in test code — time inside slow device operations (app launches, deep links, state saves), which carry their own bounded deadlines and may run long while Tapsmith recovers a struggling device, is excluded, backstopped by a hard wall-clock cap of 5× the test timeout. |
| `typingDelay` | `number` | `0` | Delay in milliseconds between keystrokes when typing text. Helps prevent dropped characters on slow CI simulators/emulators. Can be overridden per-call via `type("text", { delay: 50 })`. |
| `retries` | `number` | `0` | Number of times to retry a failed test. |
| `screenshot` | `ScreenshotMode` | `"only-on-failure"` | When to capture screenshots: `"always"`, `"only-on-failure"`, or `"never"`. |
| `testMatch` | `string[]` | `["**/*.test.ts", "**/*.spec.ts"]` | Glob patterns for discovering test files. |
| `daemonAddress` | `string` | `"localhost:50051"` | Address of the Tapsmith daemon (host:port). If another live Tapsmith session already answers on that port, this session starts its own daemon on a free port instead of taking it over. |
| `daemonBin` | `string` | `undefined` | Path to the `tapsmith-core` binary. If unset, Tapsmith auto-resolves it from several common locations (including npm packages and monorepo build outputs) before falling back to `PATH`. |
| `device` | `string` | `undefined` | Explicit single-device override. Useful for debugging or forcing one specific physical device/emulator/simulator. |
| `devices` | `number \| { name: string; device?: string }[]` | `undefined` | Drive several devices from one test — `devices: 2`, or named members optionally pinned to a serial (at most 10). Project-level only. Tests receive them as the `devices` fixture. See [Multi-device tests](./multi-device.md). |
| `deviceStrategy` | `"prefer-connected" \| "avd-only"` | contextual | Optional override for device selection (Android). Defaults to `"avd-only"` when `avd` is set, otherwise `"prefer-connected"`. |
| `rootDir` | `string` | the directory the config is loaded from | Root for test discovery, and the base for relative paths elsewhere in the config (`app`, `apk`, agent artifacts). A relative `rootDir` resolves against the directory the config is loaded from — the working directory for `tapsmith test`, including `tapsmith test -c ../other/tapsmith.config.mjs`, and the config file's own directory for an MCP server that found a config elsewhere. Unset, it *is* that directory. |
| `outputDir` | `string` | `"tapsmith-results"` | Directory for screenshots and other artifacts. |
| `agentApk` | `string` | auto-resolved | Path to the Tapsmith agent APK (Android). When installed via npm, the APK from `@tapsmith/agent-android` is used automatically. Only set this to override with a custom build. |
| `agentTestApk` | `string` | auto-resolved | Path to the Tapsmith agent test APK (Android). When installed via npm, the APK from `@tapsmith/agent-android` is used automatically. Only set this to override with a custom build. |
| `iosXctestrun` | `string` | `undefined` | Path to the iOS agent `.xctestrun` file. **Simulator and device builds are NOT interchangeable** — build one with `xcodebuild -destination 'platform=iOS Simulator,…'` for simulators, or `tapsmith build-ios-agent` for physical devices. Use one project per target with its own `iosXctestrun`. |
| `simulator` | `string` | `undefined` | iOS simulator name or UDID. Run `xcrun simctl list devices` to see available simulators. For physical iOS devices, use `device` with the UDID instead — see [iOS physical devices](./ios-physical-devices.md). |
| `reporter` | `ReporterConfig` | `list` | Reporter output configuration. Defaults to `list` everywhere, including CI. |
| `workers` | `number` | `1` | Number of parallel workers. Each worker needs its own device/emulator/simulator. |
| `shard` | `{ current: number; total: number }` | `undefined` | Shard specification for splitting a run across multiple machines. Usually set via `--shard=x/y`. |
| `launchEmulators` | `boolean` | `false` | Automatically launch Android emulators to fill the requested worker count. |
| `avd` | `string` | `undefined` | AVD name to use for `launchEmulators` (Android). When set, Tapsmith launches repeated instances of this AVD. |
| `trace` | `TraceMode \| Partial<TraceConfig>` | `"off"` | Trace recording mode. See [TraceMode](#tracemode) below. |
| `video` | `VideoMode \| Partial<VideoConfig>` | `"off"` | Continuous video recording of the device screen. See [VideoMode](#videomode) below. |
| `grep` | `RegExp \| RegExp[]` | `undefined` | Run only tests whose fullName (`describe > test`) matches at least one of these regular expressions. Mirrors Playwright's `grep` and the `--grep` / `-g` CLI flag. |
| `grepInvert` | `RegExp \| RegExp[]` | `undefined` | Skip tests whose fullName matches any of these regular expressions. Mirrors Playwright's `grepInvert` and the `--grep-invert` CLI flag. |
| `baseURL` | `string` | `undefined` | Base URL for the `request` fixture. Relative paths in `request.get("/path")` are resolved against this. |
| `extraHTTPHeaders` | `Record<string, string>` | `undefined` | Default headers sent with every `request` fixture call (e.g., `Authorization`). Per-request headers override these when names collide. |
| `doubleTapInterval` | `number` | `100` | Default interval in milliseconds between the two taps in `doubleTap()`. Can be overridden per-call via `doubleTap({ intervalMs: 150 })`. |
| `appReset` | `'auto' \| 'clear' \| 'restart' \| 'warm' \| 'none'` | `'auto'` | How the app is reset to a known state before tests (see [Test isolation](writing-tests.md#test-isolation)). `auto` = `warm` when the app's in-app reset hooks are detected ([`@tapsmith/react-native`](warm-reset.md)) or `resetAppDeepLink` is set, otherwise `clear`. Overridable per project and per `test.use()` scope. |
| `appResetScope` | `'auto' \| 'file' \| 'test'` | `'auto'` | Reset once per test file, or before every test. `auto` = `file` — one reset at file/scope entry. Set `'test'` on scopes that need a reset before every test (still warm when the app mounts `@tapsmith/react-native`). |
| `appResetColdEvery` | `number` | `10` | With `appReset: 'warm'`, deliver every Nth reset cold (terminate + relaunch) so long all-warm iOS simulator sessions can't drift from a fresh launch. `0` disables. |
| `ui.prepareBetweenRuns` | `boolean` | `true` | [UI mode](ui-mode.md): prepare the device (run the declared app reset) in the background between runs. Set `false` when resets have side effects the team must control (backend calls in `onReset`, rate limits) or on personal physical devices. A person's explicit toggle in the device chip menu still wins for them. |
| `ui.prepareDelayMs` | `number` | `0` | [UI mode](ui-mode.md): quiet time in milliseconds after a run before background preparation starts. |
| `telemetry` | `boolean` | `true` | Anonymous usage telemetry — one event per test-file run with the run mode, platform, pass/fail counts, and SDK/Node/OS versions, under a random per-machine id. Never test names, locators, app identifiers, or paths. Set `false` to opt out; `TAPSMITH_TELEMETRY=0` does the same per shell. See [Telemetry](telemetry.md). |
| `resetAppDeepLink` | `string` | `undefined` | Deep link the app handles by clearing its own state and navigating to the start screen. Setting it makes `appReset: 'auto'` resolve to `warm`. Do not expose this route in production builds. |
| `resetAppWaitMs` | `number` | `750` | Time in milliseconds to wait after navigating the `resetAppDeepLink` before continuing. Gives the app time to finish resetting. |
| `testIgnore` | `string[]` | `[]` | Glob patterns for excluding test files from discovery. Files matching any pattern are skipped even if they match `testMatch`. |

### `ScreenshotMode`

```typescript
type ScreenshotMode = "always" | "only-on-failure" | "never";
```

- `"always"` -- Capture a screenshot after every test, pass or fail.
- `"only-on-failure"` -- Capture a screenshot only when a test fails. This is the default.
- `"never"` -- Never capture screenshots.

### `ReporterConfig`

```typescript
type ReporterDescription = string | [string, Record<string, unknown>];
type ReporterConfig = ReporterDescription | ReporterDescription[];
```

Built-in reporter names are:

- `"list"`
- `"line"`
- `"dot"`
- `"json"`
- `"junit"`
- `"html"`
- `"github"`
- `"blob"`

Examples:

```typescript
reporter: "list"
reporter: ["json", { outputFile: "tapsmith-report.json" }]
reporter: [["html", { outputFolder: "tapsmith-report" }], "list"]
```

### `TraceMode`

```typescript
type TraceMode = "off" | "on" | "on-first-retry" | "on-all-retries" | "retain-on-failure" | "retain-on-first-failure" | "retain-on-failure-and-retries";
```

- `"off"` -- No tracing.
- `"on"` -- Record and keep traces for every test.
- `"on-first-retry"` -- Record traces only on the first retry of a failed test.
- `"on-all-retries"` -- Record traces on every retry.
- `"retain-on-failure"` -- Always record, but delete the trace zip if the test passes.
- `"retain-on-first-failure"` -- Always record, but only keep traces for the first failure (attempt 0).
- `"retain-on-failure-and-retries"` -- Always record, and keep the trace for any run that failed **or** that is a retry. For a flaky test (fails then passes on retry) this keeps both the failing first run and the passing retry, so you can compare them. Mirrors Playwright's mode of the same name.

The retry-only modes (`"on-first-retry"`, `"on-all-retries"`) require `retries >= 1` to ever produce a trace; the runner warns at startup if `retries` is 0.

### `TraceConfig`

For fine-grained control, pass an object instead of a mode string:

```typescript
interface TraceConfig {
  mode: TraceMode;               // Recording mode (default: "off")
  screenshots: boolean;          // Capture before/after screenshots (default: true)
  snapshots: boolean;            // Capture view hierarchy XML (default: true)
  sources: boolean;              // Include test source files (default: true)
  attachments: boolean;          // Include user attachments (default: true)
  network: boolean;              // Capture HTTP/HTTPS traffic via proxy (default: true)
  deviceLogs: boolean;           // Stream device logs — Android logcat / iOS
                                 // simulator syslog — into the trace (default: true)
  daemonLogs: boolean;           // Stream the tapsmith-core daemon's own logs
                                 // (gRPC, ADB/simctl, device events) into the
                                 // trace, shown under the `daemon` source
                                 // (default: false; --verbose for debug detail)
  networkHttpPorts?: number[];   // Android: additional cleartext HTTP/1.1 or HTTP/2 ports.
                                 // Defaults still include HTTP 80 and HTTPS 443.
                                 // Firebase emulators: [8080, 9099, 5001, 9199].
  networkHosts?: string[];       // Hostname allowlist (glob patterns). When set,
                                 // only entries whose host matches a pattern are
                                 // kept in the trace archive.
  networkIgnoreHosts?: string[]; // Hostname denylist (glob patterns). Entries
                                 // whose host matches a pattern are dropped.
                                 // Combines with `networkHosts`: entry is kept
                                 // iff it matches allow AND does NOT match deny.
  networkPassthroughHosts?: string[]; // Hosts (glob patterns, matched against the
                                 // TLS SNI) whose connections bypass MITM
                                 // interception entirely -- tunneled end-to-end,
                                 // no capture, no route matching. Use for
                                 // certificate-pinned or embedded-root clients.
                                 // HTTP/2 and gRPC are captured only when the
                                 // client trusts Tapsmith's MITM CA.
}
```

When `network` is enabled, the Rust daemon starts an HTTP proxy and configures the device to route traffic through it. HTTPS traffic is decrypted using an auto-generated CA certificate installed on the device.

### Scrubbing system noise from traces

On **Android emulators** the HTTP proxy is set globally (`settings put global http_proxy`), so every app and system process on the emulator routes through it — including Google Play Services, connectivity checks, push, ad attribution, etc. On **physical iOS** a system-wide Wi-Fi proxy has the same characteristic. (iOS simulators are the exception: the macOS Network Extension redirector filters per-PID.)

Two patterns, pick whichever fits:

**Allowlist** — only keep entries from your app's hosts:

```typescript
trace: {
  mode: "on",
  networkHosts: ["*.myapp.com", "api.partner.example"],
}
```

**Denylist** — keep everything except known-noisy hosts:

```typescript
trace: {
  mode: "on",
  networkIgnoreHosts: [
    // Android emulator system traffic
    "connectivitycheck.gstatic.com",
    "*.googleapis.com",
    "play.googleapis.com",
    "mtalk.google.com",
    "android.clients.google.com",
    "www.google.com",
    "clients*.google.com",
    // iOS background (physical devices only)
    "*.apple.com",
    "*.icloud.com",
    "captive.apple.com",
  ],
}
```

Both accept glob patterns (`*` matches any single segment, `**` or a leading `*.` matches any number). Matching is case-insensitive. When both are set, the entry is kept iff it matches the allowlist AND does NOT match the denylist — deny wins.

### Bypassing interception for pinned hosts

`networkHosts`/`networkIgnoreHosts` filter what is *kept in the trace* — the traffic is still intercepted. `networkPassthroughHosts` is different: matching connections are never decrypted at all. The proxy tunnels them end-to-end to the real server, so the app sees the genuine server certificate. Use it when the app pins certificates for a host (MITM would break those connections):

```typescript
trace: {
  mode: "on",
  networkPassthroughHosts: ["pinned-api.myapp.com"],
}
```

Tunneled connections appear in the trace as a single `CONNECT` entry marked `passthrough`, and `device.route()` cannot match them. Tapsmith can also tunnel a host dynamically when an HTTP/2-capable client rejects the generated MITM certificate, which is common for SDKs that use embedded root certificates. On iOS, `firestore.googleapis.com` is tunneled by default for that reason; on Android, where Firestore honours the platform trust store, it is captured. See [network.md](network.md#http2-grpc-and-passthrough-connections).

Example:

```typescript
trace: {
  mode: "retain-on-failure",
  screenshots: true,
  snapshots: true,
  sources: false,
  network: true,
  deviceLogs: true,
}
```

### `VideoMode`

```typescript
type VideoMode = "off" | "on" | "on-first-retry" | "on-all-retries" | "retain-on-failure" | "retain-on-first-failure" | "retain-on-failure-and-retries";
```

The mode set is identical to `TraceMode` and the semantics match exactly — `"on"` records every test, `"retain-on-failure"` records but discards passing-test videos, etc.

Note that `"retain-on-failure"` still pays the recording/encoding cost for every test and only discards the file afterwards. The retry-only modes (`"on-first-retry"`, `"on-all-retries"`) start no recorder at all on the first attempt, which avoids that cost entirely on healthy runs — but they require `retries >= 1` to ever produce a video (the runner warns at startup if `retries` is 0). This mirrors Playwright's `on-first-retry` caveat.

### `VideoConfig`

```typescript
interface VideoConfig {
  mode: VideoMode;             // Recording mode (default: "off")
  size?: { width: number; height: number }; // Output resolution. Honoured on
                               // Android only (passed as
                               // `screenrecord --size WxH`); iOS records at
                               // native resolution and emits a one-time
                               // warning when `size` is set.
}
```

Recordings land in `<outputDir>/videos/` as MP4 files and are surfaced as
`TestResult.videoPath`. The HTML reporter embeds them inline. Implementation:
Android uses `adb shell screenrecord` (3-min hard cap per recording, accepted
in v1); iOS Simulator uses `xcrun simctl io recordVideo`; iOS physical
devices use `ffmpeg -f avfoundation` and require `ffmpeg` on `PATH`. See the
full reference at [api-reference.md#video-recording](./api-reference.md#video-recording).

## Example Configurations

### Minimal (Android)

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-debug.apk",
});
```

### Minimal (iOS)

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  app: "./build/MyApp.app",
});
```

### Custom Timeout

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-debug.apk",
  timeout: 15_000, // 15 seconds instead of 30
});
```

### Auto-Launch The App

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-release.apk",
  package: "com.example.myapp",
});
```

If your app has an unusual launcher setup, you can also provide `activity`, but
most apps do not need it:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-release.apk",
  package: "com.example.myapp",
  activity: ".MainActivity", // Optional
});
```

### CI Configuration (Android)

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
  timeout: 60_000, // Longer timeout for slower CI emulators
  retries: 2, // Retry failed tests up to 2 times
  screenshot: "always", // Capture screenshots for every test
  outputDir: "test-artifacts", // CI-friendly output directory
  reporter: ["junit", { outputFile: "tapsmith-junit.xml" }],
});
```

### CI Configuration (iOS)

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  app: "./build/MyApp.app",
  package: "com.example.myapp",
  simulator: "iPhone 17",
  timeout: 60_000,
  retries: 2,
  screenshot: "always",
  outputDir: "test-artifacts",
  reporter: ["junit", { outputFile: "tapsmith-junit.xml" }],
});
```

### Custom Test Patterns

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-debug.apk",
  testMatch: [
    "e2e/**/*.test.ts",
    "integration/**/*.spec.ts",
  ],
});
```

### Parallel Emulator Configuration

This is the recommended setup for parallel local or CI runs when you want Tapsmith
to manage emulator instances for you:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-release.apk",
  package: "com.example.myapp",
  workers: 4,
  launchEmulators: true,
  avd: "Pixel_9_API_35",
});
```

With this setup, Tapsmith will try to launch repeated read-only instances of the
same AVD for all workers.

If you want the opposite behavior, set `deviceStrategy: "prefer-connected"` to
let Tapsmith reuse unrelated healthy connected devices first even when `avd` is
configured.

### Explicit Device Override

If you need to reproduce an issue on one known device, set `device` or use the
`--device` CLI flag:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-debug.apk",
  device: "emulator-5554",
});
```

The CLI flag takes precedence over the config file:

```bash
# Overrides the device from config
npx tapsmith test --device R5CR10XXXXX
```

A pinned device hosts one worker, so `device` (or `--device`) caps its run to
a single worker in every mode, and `--device` with a `--workers N` the run
cannot use (any N > 1 when every project runs on that device's platform) is
refused. In a config spanning Android and iOS, the pin applies only to the
projects of its own platform. For multi-worker runs, use `launchEmulators + avd` instead of `device`.

### Custom Daemon Address

If you are running the Tapsmith daemon on a different host or port:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-debug.apk",
  daemonAddress: "192.168.1.100:50051",
});
```

### Custom Agent APK Paths

If you build the Tapsmith agent artifacts outside the default location, point Tapsmith
at them explicitly:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-debug.apk",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk: "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
});
```

### Projects with Per-Device Targeting

Mirroring Playwright's `projects` concept, you can define named groups of test
files that each target their own device. This is the canonical way to run the
same suite against Android and iOS in a single `tapsmith test` invocation.

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  // Top-level fields are inherited by every project as defaults.
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
        iosXctestrun: "./ios-agent/TapsmithAgent.xctestrun",
      },
    },
  ],
});
```

Each project provisions its own device, daemon, and agent. There are two ways
to control parallelism:

**Global budget** (Playwright-style): the top-level `workers` field is split
across projects proportionally to file count, with at least 1 per project.

```typescript
export default defineConfig({
  workers: 4,
  projects: [
    { name: "Pixel 6", use: { /* ... */ } },
    { name: "iPhone 16", use: { /* ... */ } },
  ],
});
```

**Explicit per-project workers** (recommended for multi-device configs):
each project sets its own `workers` count. These are **additive** — they do
not consume from the global budget — so you can mix explicit and unset
projects in the same config.

```typescript
export default defineConfig({
  projects: [
    { name: "Pixel 6",   workers: 2, use: { /* ... */ } },
    { name: "iPhone 16", workers: 1, use: { /* ... */ } },
  ],
});
```

With `tapsmith test`, the Android project runs on 2 devices and the iOS project
runs on 1 — concurrently. The total worker count (3) is computed automatically.

If the total comes out to 1 (e.g. global `workers: 1` and no per-project
overrides), Tapsmith runs the projects sequentially, tearing down and
re-provisioning the device between each — useful when you only have one
machine and want to exercise both platforms in CI.

The same configuration also works with `--ui` and `--watch`. UI mode shows
each project's tests grouped under its name, and routes file execution to
the matching device. Watch mode re-runs only the affected project's files
on its own device when you edit a test.

Inside a project, the `use` field accepts the same device-shaping fields
as the top-level config (`platform`, `avd`, `simulator`, `app`, `apk`,
`package`, `iosXctestrun`, `launchEmulators`, etc.) plus the existing
`timeout`, `screenshot`, `retries`, `trace`, `video`, `appReset`,
`appResetScope`, and `appState` overrides.

> **Note:** A single project must not mix Android (`avd`/`apk`) and iOS
> (`simulator`/`app`) fields. Tapsmith validates this at startup.

### Multi-Device Tests (Device Groups)

A project can declare that every one of its tests drives several devices at
once — the mobile analogue of Playwright's multi-context tests:

```typescript
export default defineConfig({
  package: "com.example.chat",
  projects: [
    {
      name: "chat",
      testMatch: ["**/multi-user/**"],
      use: {
        platform: "android",
        avd: "Pixel_9_API_35",
        devices: [{ name: "alice" }, { name: "bob" }],
      },
    },
  ],
});
```

Tests receive the group as the `devices` fixture (`device` is `devices[0]`).
Each member gets its own daemon, agent, app install and app reset; a member
can be pinned with `device: "<serial>"`. See [Multi-device tests](./multi-device.md).

### Sharded Runs

Use sharding when you want to split a suite across multiple CI jobs:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-debug.apk",
  shard: { current: 1, total: 4 },
});
```

In practice, most users set this via the CLI instead:

```bash
npx tapsmith test --shard=1/4
```

### Warm App Reset

The fastest reset is one the app performs itself. React Native / Expo apps get it by mounting `@tapsmith/react-native` once — Tapsmith detects the hooks automatically and `appReset: 'auto'` becomes `warm · per file` — the same isolation as before, at a fraction of the cost (a warm reset takes ~1 s where clear + relaunch takes 5-10 s). Scopes that need per-test isolation opt in with `appResetScope: 'test'`; see the [Warm app reset guide](warm-reset.md).

Apps without the module can expose a deep link that resets state (much faster than a full clear + relaunch). `appReset: 'auto'` then resolves to `warm · per file`:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-debug.apk",
  package: "com.example.myapp",
  resetAppDeepLink: "myapp://reset",
  resetAppWaitMs: 1000, // Wait 1s after the deep link for the reset to complete
});
```

Tapsmith navigates the deep link instead of clearing app data and relaunching. The deep link handler should clear app state and land on whatever screen your tests expect to start from. Keep this handler out of production builds, for example behind a test-only build flavor or equivalent guard. The reset appears in the trace as a `resetApp` step in the **APP RESET** section preceding **BEFORE ALL** (or **BEFORE EACH** with `appResetScope: 'test'`); if the deep link fails, Tapsmith falls back to a full clear and records why.

The reset is delivered to the running app (warm). On iOS simulators the daemon bounds the warm window: every `appResetColdEvery` resets (default 10), on a retry attempt, or after two warm resets in a row fail to verify, the next reset cold-relaunches the app with the URL instead — and the trace says so (`cold relaunch: warm-window bound reached (10 resets)`). Deep links opened *inside* a test with `device.openDeepLink()` are always delivered warm when possible.

### API Request Fixture

Configure defaults for the `request` fixture used in tests:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  apk: "./app-debug.apk",
  baseURL: "https://api.example.com",
  extraHTTPHeaders: {
    Authorization: "Bearer my-ci-token",
    "X-Test-Run": "true",
  },
});
```

With `baseURL` set, relative paths in `request.get("/users")` resolve to `https://api.example.com/users`. Per-request headers override `extraHTTPHeaders` when names collide.

## Config File Resolution

Tapsmith searches for configuration files in this order:

1. `tapsmith.config.ts`
2. `tapsmith.config.js`
3. `tapsmith.config.mjs`

If no config file is found, Tapsmith uses the default values for all options.

For `.ts` config files, Tapsmith relies on `tsx` or `ts-node` being available in your environment. If you installed Tapsmith via npm, this should work out of the box.
