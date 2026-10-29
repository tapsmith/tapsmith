<div align="center">

<a href="https://tapsmith.dev">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="website/public/logo-dark.png">
    <img src="website/public/logo.png" alt="Tapsmith" width="320">
  </picture>
</a>

### Mobile tests that feel like web tests.

Tapsmith is a test framework for native iOS and Android apps. It takes the parts of
[Playwright](https://playwright.dev) that engineers love (the locators, the auto-waiting,
the trace viewer) and rebuilds them for real devices, emulators and simulators.

[![npm](https://img.shields.io/npm/v/tapsmith?color=e8914b&label=npm)](https://www.npmjs.com/package/tapsmith)
[![CI](https://github.com/tapsmith/tapsmith/actions/workflows/ci.yml/badge.svg)](https://github.com/tapsmith/tapsmith/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**[Website](https://tapsmith.dev)** · **[Get started](docs/getting-started.md)** · **[API reference](docs/api-reference.md)** · **[Changelog](https://tapsmith.dev/changelog/)**

</div>

https://github.com/user-attachments/assets/53e3a414-a66e-4bbe-abed-ecfeba44b06e

---

```typescript
import { test, expect } from "tapsmith";

test("user can check out", async ({ device }) => {
  // Mock the payment API: no mock server, no special build of the app
  await device.route("**/api/payment", (route) =>
    route.fulfill({ json: { status: "success" } }),
  );

  await device.getByRole("button", { name: "Add to cart" }).tap();
  await device.getByText("Checkout").tap();

  await expect(device.getByText("Order confirmed")).toBeVisible();
});
```

If you know Playwright, you already know most of Tapsmith: `test`, `describe`, `expect`,
hooks, fixtures, `test.extend()`, projects, `--ui`, `--trace`. One test file runs on Android and
iOS alike.

## Why Tapsmith

|     |     |
| --- | --- |
| ⏳ **Auto-waiting, everywhere** | Every action waits for its element to be visible, enabled and stable, and every assertion retries until it passes. You never write a sleep. |
| 🎯 **Accessible locators** | `getByRole`, `getByText`, `getByLabel` and `getByPlaceholder`, with strings or `RegExp`, the same on both platforms. A bundled ESLint plugin steers you toward the robust ones. |
| 🌐 **Network mocking in one line** | `device.route()` mocks, modifies or aborts HTTP/HTTPS calls on a proxy Tapsmith starts for you the moment a test mocks, with no config. [Prerequisites](docs/network.md#prerequisites) |
| 🎞️ **Trace viewer** | Replay a failure instead of reconstructing it: every action with before and after screenshots, the view hierarchy, logs and network traffic. |
| 🧪 **UI and watch modes** | Pick locators on a live device, run tests one at a time and step through them, or re-run on save. |
| ⚡ **Fast, isolated tests** | The app is reset to a clean state for every test file. React Native apps can [reset in-process in under a second](docs/warm-reset.md), and `saveAppState` lets you log in once and reuse the session. |
| 📱 **Many devices at once** | Parallel workers across emulators and simulators that Tapsmith boots for you, CI sharding with merged reports, and [multi-device tests](docs/multi-device.md) where Alice messages Bob. |
| 🧩 **Hybrid apps** | Switch into a WebView and drive it with CSS selectors and web roles. |
| 🤖 **Built for AI agents** | A built-in [MCP server](docs/mcp-server.md), plus `--json` output for every setup command, so a coding agent can set up and run your suite on its own. |
| 📦 **One npm install** | The daemon, the device agents and the trace viewer all ship in the package. There's no Appium server to start and no drivers to keep in step with Xcode. |

<p align="center">
  <img src="docs/images/trace-viewer.png" alt="The Tapsmith trace viewer replaying a test step by step" width="860">
</p>

## Quick start

**1. Install.** Tapsmith needs **Node.js 22 or newer**.

```bash
npm install -D tapsmith    # or: yarn add -D tapsmith / pnpm add -D tapsmith
```

pnpm 11+ and Yarn Plug'n'Play each need one setting first: see [Package manager notes](docs/getting-started.md#package-manager-notes).

**2. Configure.** Tapsmith tests a build of your app: an `.apk` for Android, or a simulator `.app`
for iOS ([how to build one](docs/getting-started.md#build-the-app-under-test), including React
Native and Expo). The wizard finds your builds and devices and writes `tapsmith.config.ts`:

```bash
npx tapsmith init      # interactive setup
npx tapsmith doctor    # check the environment; every failing check suggests a fix
npx tapsmith verify    # prove the whole loop works with one real test
```

<details>
<summary>Or write the config by hand</summary>

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  // Tapsmith tests end in .tapsmith.ts, so your Jest or Vitest run leaves them alone
  testMatch: ["**/*.tapsmith.ts"],

  // Android (React Native or Expo: "./android/app/build/outputs/apk/release/app-release.apk")
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
  package: "com.example.myapp", // needed to launch and reset the app

  // Or iOS (`platform` and `simulator` are required for simulator runs)
  // platform: "ios",
  // app: "./build/Build/Products/Debug-iphonesimulator/MyApp.app",
  //   (React Native or Expo: "./ios/build/Build/Products/Release-iphonesimulator/MyApp.app")
  // package: "com.example.myapp",
  // simulator: "iPhone 17",
});
```

See [Configuration](docs/configuration.md) for every option, and [projects](docs/configuration.md#projects-with-per-device-targeting)
to run Android and iOS from one `tapsmith test`.

</details>

**3. Write a test** in `tests/login.tapsmith.ts`. Each file starts from a freshly reset app:

```typescript
import { test, describe, expect } from "tapsmith";

describe("Login", () => {
  test("valid credentials", async ({ device }) => {
    await device.getByRole("textfield", { name: "Email" }).type("user@example.com");
    await device.getByRole("textfield", { name: "Password" }).type("password123");
    await device.getByRole("button", { name: "Sign In" }).tap();

    await expect(device.getByText("Welcome back")).toBeVisible();
  });
});
```

**4. Run it.**

```bash
npx tapsmith test                              # run the suite
npx tapsmith test --workers 4                  # in parallel across 4 devices
npx tapsmith test --trace retain-on-failure    # keep a trace of every failure
npx tapsmith test --watch                      # re-run on save
npx tapsmith test --ui                         # interactive UI mode
```

<p align="center">
  <img src="docs/images/ui-mode.png" alt="Tapsmith UI mode with a live device mirror and the test list" width="860">
</p>

## Requirements

|             | Android                        | iOS                                          |
| ----------- | ------------------------------ | -------------------------------------------- |
| **Host**    | macOS or Linux, Node.js 22+    | macOS, Node.js 22+                           |
| **Tooling** | ADB on your `PATH`             | Xcode 15+                                    |
| **Devices** | Emulator or device, API 26+    | Simulator or [physical device](docs/ios-physical-devices.md), iOS 17+ |

## How it works

```
┌──────────────────┐      gRPC      ┌──────────────────┐   ADB / simctl    ┌─────────────────────────┐
│  TypeScript SDK  │ ◄────────────► │   Rust daemon    │ ◄───────────────► │  On-device agent        │
│  test runner,    │                │  (tapsmith-core) │                   │  Android: UIAutomator2  │
│  CLI, reporters  │                │                  │                   │  iOS: XCUITest          │
└──────────────────┘                └──────────────────┘                   └─────────────────────────┘
```

Your tests run in Node. They talk over gRPC to a small Rust daemon, which manages devices (ADB on
Android, simctl and devicectl on iOS) and forwards each command to an agent running on the device.
All three ship prebuilt in the npm package.

## Documentation

The full docs live at **[tapsmith.dev](https://tapsmith.dev)**. The same pages are in [`docs/`](docs/):

**Start here.** [Getting started](docs/getting-started.md) · [Writing tests](docs/writing-tests.md) · [Locators](docs/locators.md) · [Debugging](docs/debugging.md)

**Guides.** [Network interception](docs/network.md) · [Trace viewer](docs/trace-viewer.md) · [UI mode](docs/ui-mode.md) · [Watch mode](docs/watch-mode.md) · [WebViews](docs/webview.md) · [Parallel runs and sharding](docs/parallel-and-sharding.md) · [Multi-device tests](docs/multi-device.md) · [Warm app reset](docs/warm-reset.md) · [AI coding agents](docs/agents.md)

**Moving from another framework.** [Maestro](docs/migrating-from-maestro.md) · [Detox](docs/migrating-from-detox.md) · [Appium](docs/migrating-from-appium.md)

**CI and devices.** [CI setup](docs/ci-setup.md) · [iOS physical devices](docs/ios-physical-devices.md) · [iOS network capture](docs/ios-network-capture.md) · [Physical-device network capture](docs/ios-physical-device-network-tracing.md)

**Reference.** [API](docs/api-reference.md) · [CLI](docs/api-reference.md#cli) · [Configuration](docs/configuration.md) · [Environment variables](docs/environment-variables.md) · [MCP server](docs/mcp-server.md) · [Trace format](docs/trace-format.md) · [Telemetry](docs/telemetry.md)

## Contributing

Bug reports, docs fixes and code are all welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the
development setup and conventions.

Commits need a [Developer Certificate of Origin](DCO) sign-off (`git commit -s`). It certifies that
you have the right to submit the patch. It is not a CLA, and you keep your copyright.

## License

[Apache-2.0](LICENSE). Contributions are accepted under the same licence.
