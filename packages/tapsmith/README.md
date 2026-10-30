<a href="https://tapsmith.dev"><img src="https://tapsmith.dev/promo-poster.jpg" alt="Tapsmith: the web testing experience, on mobile" width="720"></a>

# Tapsmith

**Mobile tests that feel like web tests.**

Tapsmith is a test framework for iOS and Android apps, whether they are built natively or
with React Native, Expo or Flutter. It takes the parts of
[Playwright](https://playwright.dev) that engineers love (the locators, the auto-waiting,
the trace viewer) and rebuilds them for real devices, emulators and simulators.

**[Website](https://tapsmith.dev)** · **[Get started](https://tapsmith.dev/getting-started/)** · **[API reference](https://tapsmith.dev/reference/api/locators/)** · **[Changelog](https://tapsmith.dev/changelog/)** · **[GitHub](https://github.com/tapsmith/tapsmith)**

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

## Features

- **Auto-waiting, everywhere.** Every action waits for its element to be visible, enabled and stable, and every assertion retries until it passes.
- **Accessible locators.** `getByRole`, `getByText`, `getByLabel` and `getByPlaceholder`, with strings or `RegExp`, the same on both platforms. A bundled ESLint plugin steers you toward the robust ones.
- **Network mocking in one line.** `device.route()` mocks, modifies or aborts HTTP/HTTPS calls on a proxy Tapsmith runs itself ([prerequisites](https://tapsmith.dev/guides/network/#prerequisites)).
- **Trace viewer.** Replay a failure step by step: screenshots, the view hierarchy, logs and network traffic.
- **UI and watch modes.** Pick locators on a live device, step through tests, or re-run on save.
- **Fast, isolated tests.** A clean app for every test file, [sub-second resets](https://tapsmith.dev/guides/warm-reset/) for React Native apps, and `saveAppState` to log in once.
- **Many devices at once.** Parallel workers on emulators and simulators Tapsmith boots for you, CI sharding with merged reports, and [multi-device tests](https://tapsmith.dev/guides/multi-device/).
- **Hybrid apps.** Switch into a WebView and drive it with CSS selectors and web roles.
- **Built for AI agents.** A built-in [MCP server](https://tapsmith.dev/guides/mcp-server/), and `--json` output for every setup command.
- **One npm install.** The daemon, the device agents and the trace viewer ship in the package. No server to start, no drivers to update.

<img src="https://tapsmith.dev/trace-viewer.png" alt="The Tapsmith trace viewer replaying a test step by step" width="860">

## Quick start

Tapsmith needs **Node.js 22 or newer**.

```bash
npm install -D tapsmith    # or: yarn add -D tapsmith / pnpm add -D tapsmith
npx tapsmith init          # finds your app build and devices, writes tapsmith.config.ts
npx tapsmith verify        # proves the whole loop works with one real test
npx tapsmith test
```

Tapsmith tests a build of your app: an `.apk` for Android, or a simulator `.app` for iOS
([how to build one](https://tapsmith.dev/getting-started/#build-the-app-under-test), including
React Native and Expo). If something is missing, `npx tapsmith doctor` checks your environment and
suggests a fix for each problem.

With Yarn, run the CLI as `yarn tapsmith`; with pnpm, `pnpm exec tapsmith`. pnpm 11+ and Yarn
Plug'n'Play each need one setting first: see [Package manager notes](https://tapsmith.dev/getting-started/#package-manager-notes).

## Requirements

|             | Android                        | iOS                                          |
| ----------- | ------------------------------ | -------------------------------------------- |
| **Host**    | macOS or Linux, Node.js 22+    | macOS, Node.js 22+                           |
| **Tooling** | ADB on your `PATH`             | Xcode 15+                                    |
| **Devices** | Emulator or device, API 26+    | Simulator or [physical device](https://tapsmith.dev/platform/ios-physical-devices/), iOS 17+ |

## Documentation

- **Start here:** [Getting started](https://tapsmith.dev/getting-started/) · [Writing tests](https://tapsmith.dev/writing-tests/) · [Locators](https://tapsmith.dev/guides/locators/) · [Debugging](https://tapsmith.dev/guides/debugging/)
- **Guides:** [Network](https://tapsmith.dev/guides/network/) · [Trace viewer](https://tapsmith.dev/guides/trace-viewer/) · [UI mode](https://tapsmith.dev/guides/ui-mode/) · [Parallel runs and sharding](https://tapsmith.dev/guides/parallel-and-sharding/) · [AI coding agents](https://tapsmith.dev/guides/agents/)
- **Migrating:** [From Maestro](https://tapsmith.dev/guides/migrating-from-maestro/) · [From Detox](https://tapsmith.dev/guides/migrating-from-detox/) · [From Appium](https://tapsmith.dev/guides/migrating-from-appium/)
- **Reference:** [API](https://tapsmith.dev/reference/api/locators/) · [CLI](https://tapsmith.dev/reference/api/cli/) · [Configuration](https://tapsmith.dev/reference/configuration/) · [CI setup](https://tapsmith.dev/platform/ci-setup/) · [Telemetry](https://tapsmith.dev/reference/telemetry/)

## License

Apache-2.0
