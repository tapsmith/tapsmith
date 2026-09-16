# Tapsmith

**Playwright-level reliability for mobile app testing.**

Tapsmith is a mobile app testing framework that brings the developer experience of [Playwright](https://playwright.dev) to Android and iOS. Write tests in TypeScript, run them against real devices or emulators/simulators, and get deterministic results with auto-waiting, trace recording, and network interception.

```typescript
import { test, expect } from "tapsmith";

test("user can log in", async ({ device }) => {
  await device.getByRole("textfield", { name: "Email" }).type("user@example.com");
  await device.getByRole("textfield", { name: "Password" }).type("password123");
  await device.getByRole("button", { name: "Sign In" }).tap();

  await expect(device.getByText("Welcome back")).toBeVisible();
});
```

## Key Features

- **Auto-waiting** -- every action waits for the element to be visible, enabled, and stable. No manual sleeps.
- **Accessible locators** -- find elements by role, text, label, placeholder, and description. An ESLint plugin steers you toward best practices.
- **Trace viewer** -- step-by-step replay of every action with before/after screenshots, view hierarchy, console output, and network requests.
- **Network interception** -- Playwright-style `device.route()` to mock, modify, or abort HTTP/HTTPS requests that trust Tapsmith's MITM CA, with passthrough markers for configured hosts and detected h2/gRPC cert rejects.
- **Video recording** -- continuous MP4 capture of the device screen, retained on failure or always.
- **Parallel execution** -- run tests across multiple devices with work-stealing distribution. Tapsmith auto-provisions emulators and simulators.
- **WebView testing** -- test hybrid apps by switching between native and WebView contexts with CSS selector-based interaction.
- **MCP server** -- built-in MCP integration lets AI coding agents run tests, interact with devices, and inspect results.
- **Cross-platform** -- Android (API 26+) and iOS (17+) from a single test suite. Use projects to target both platforms in one `tapsmith test` invocation.
- **Familiar API** -- if you know Playwright, you already know Tapsmith. `test`, `describe`, `expect`, `beforeEach`, `test.extend()`, and hooks work the way you expect.

## Architecture

```
┌──────────────────┐      gRPC      ┌──────────────────┐  ADB/simctl/socket ┌─────────────────────────┐
│  TypeScript SDK  │ ◄────────────► │  Rust Daemon     │ ◄────────────────► │  On-Device Agent        │
│  (test runner,   │                │  (tapsmith-core) │                    │  Android: UIAutomator2  │
│   CLI)           │                │                  │                    │  iOS: XCUITest          │
└──────────────────┘                └──────────────────┘                    └─────────────────────────┘
```

The TypeScript SDK communicates with a Rust daemon over gRPC. The daemon manages device connections (ADB for Android, simctl/devicectl for iOS) and routes commands to a lightweight on-device agent.

## Quick Start

### 1. Install

```bash
npm install tapsmith
```

### 2. Set up

The interactive wizard detects your environment and generates a config file:

```bash
npx tapsmith init
```

Or create `tapsmith.config.ts` manually:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  // Android
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
  package: "com.example.myapp",

  // Or iOS
  // app: "./build/MyApp.app",
  // package: "com.example.myapp",
});
```

Verify your setup:

```bash
npx tapsmith doctor
```

### 3. Write a test

Create `tests/login.test.ts`:

```typescript
import { test, describe, expect, beforeEach } from "tapsmith";

describe("Login", () => {
  beforeEach(async ({ device }) => {
    await device.restartApp("com.example.myapp");
  });

  test("valid credentials", async ({ device }) => {
    await device.getByRole("textfield", { name: "Email" }).type("user@example.com");
    await device.getByRole("textfield", { name: "Password" }).type("password123");
    await device.getByRole("button", { name: "Sign In" }).tap();
    await expect(device.getByText("Welcome back")).toBeVisible();
  });

  test("invalid credentials shows error", async ({ device }) => {
    await device.getByRole("textfield", { name: "Email" }).type("bad@example.com");
    await device.getByRole("textfield", { name: "Password" }).type("wrong");
    await device.getByRole("button", { name: "Sign In" }).tap();
    await expect(device.getByText("Invalid credentials")).toBeVisible();
  });
});
```

### 4. Run

```bash
npx tapsmith test
```

Run in parallel across 4 devices:

```bash
npx tapsmith test --workers 4
```

Record traces for failed tests:

```bash
npx tapsmith test --trace retain-on-failure
```

Watch mode for fast iteration:

```bash
npx tapsmith test --watch
```

Interactive UI mode with MCP integration:

```bash
npx tapsmith test --ui
```

## Requirements

### Android

- Node.js 22+
- ADB installed and on PATH
- Android device or emulator (API 26+)

### iOS

- Node.js 22+
- macOS with Xcode 15+
- iOS Simulator (iOS 17+) or physical device

## Documentation

### Getting started
- [Getting Started](docs/getting-started.md) -- installation, first test, running tests
- [Writing Tests](docs/writing-tests.md) -- best practices, screen objects, test isolation, authentication patterns

### Guides
- [Locators Guide](docs/locators.md) -- choosing the right locators, cross-platform considerations
- [Network Interception](docs/network.md) -- mocking, modifying, and capturing HTTP traffic
- [WebView Testing](docs/webview.md) -- testing hybrid apps with WebView contexts
- [Trace Viewer](docs/trace-viewer.md) -- recording and inspecting step-by-step traces
- [UI Mode](docs/ui-mode.md) -- interactive test authoring and debugging with `--ui`
- [Watch Mode](docs/watch-mode.md) -- fast iteration with `--watch`
- [Parallel Execution and Sharding](docs/parallel-and-sharding.md) -- multi-device parallelism and CI sharding
- [Debugging](docs/debugging.md) -- diagnosing failures, common errors, flaky test mitigation

### Reference
- [API Reference](docs/api-reference.md) -- complete reference for all public APIs
- [Configuration](docs/configuration.md) -- all config options with examples
- [CLI Reference](docs/api-reference.md#cli) -- all commands and flags
- [Environment Variables](docs/environment-variables.md) -- daemon, debugging, and CI variables
- [Telemetry](docs/telemetry.md) -- what the anonymous usage data is, what it never includes, and how to opt out
- [MCP Server](docs/mcp-server.md) -- AI agent integration via MCP

### Platform-specific
- [CI Setup](docs/ci-setup.md) -- GitHub Actions workflows for Android and iOS
- [iOS Physical Devices](docs/ios-physical-devices.md) -- testing on real iPhones/iPads
- [iOS Network Capture](docs/ios-network-capture.md) -- HTTPS capture setup for simulators
- [iOS Physical Device Network Capture](docs/ios-physical-device-network-tracing.md) -- HTTPS capture on real devices

## Contributing

Bug reports, documentation fixes and code are all welcome -- see
[CONTRIBUTING.md](CONTRIBUTING.md) for development setup and conventions.

Commits need a [Developer Certificate of Origin](DCO) sign-off (`git commit -s`). It
certifies you have the right to submit the patch; it is not a CLA, and you keep your
copyright.

## License

Apache-2.0

Contributions are accepted under the same licence.
