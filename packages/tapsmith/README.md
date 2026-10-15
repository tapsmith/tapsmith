# Tapsmith

Mobile app testing framework with a Playwright-inspired API for Android and iOS.

```typescript
import { test, expect } from "tapsmith";

test("app launches and shows welcome screen", async ({ device }) => {
  await expect(device.getByText("Welcome")).toBeVisible();
});

test("can navigate to settings", async ({ device }) => {
  await device.getByRole("button", { name: "Settings" }).tap();
  await expect(device.getByText("Settings")).toBeVisible();
});
```

## Features

- **Playwright-style locators** -- `getByRole()`, `getByText()`, `getByLabel()`, `getByDescription()`, and more
- **Auto-waiting assertions** -- `toBeVisible()`, `toBeChecked()`, `toHaveText()` poll until the condition is met
- **Android and iOS** -- same API, same test files, both platforms
- **Parallel execution** -- multi-device test runs with automatic emulator/simulator provisioning
- **Trace viewer** -- timeline of screenshots, actions, and logs for debugging failures
- **Network capture** -- record and assert on HTTP/HTTPS traffic
- **CI-ready** -- run headless on GitHub Actions, CircleCI, or any CI with device access

## Quick Start

Tapsmith requires **Node.js 22 or newer** — check with `node --version` first. On older Node, npm can install an old Tapsmith release whose commands don't match these docs, or none at all.

```bash
npm install -D tapsmith    # or: yarn add -D tapsmith / pnpm add -D tapsmith
npx tapsmith init
npx tapsmith test
```

The `init` wizard detects your environment, walks through platform configuration, and generates your config file and an example test.

With Yarn, run the CLI as `yarn tapsmith`; with pnpm, `pnpm exec tapsmith`. pnpm 11+ and Yarn Plug'n'Play each need one setting first: see [Installation](https://tapsmith.dev/getting-started/#installation).

## Documentation

- [Getting Started](https://tapsmith.dev/getting-started/)
- [Locators Guide](https://tapsmith.dev/guides/locators/)
- [API Reference](https://tapsmith.dev/reference/api/locators/)
- [Configuration](https://tapsmith.dev/reference/configuration/)
- [CI Setup](https://tapsmith.dev/platform/ci-setup/)

## License

Apache-2.0
