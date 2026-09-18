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

- **Playwright-style locators** -- `getByText()`, `getByRole()`, `getByContentDesc()`, and more
- **Auto-waiting assertions** -- `toBeVisible()`, `toBeChecked()`, `toHaveText()` poll until the condition is met
- **Android and iOS** -- same API, same test files, both platforms
- **Parallel execution** -- multi-device test runs with automatic emulator/simulator provisioning
- **Trace viewer** -- timeline of screenshots, actions, and logs for debugging failures
- **Network capture** -- record and assert on HTTP/HTTPS traffic
- **CI-ready** -- run headless on GitHub Actions, CircleCI, or any CI with device access

## Quick Start

```bash
npm install tapsmith
npx tapsmith init
npx tapsmith test
```

The `init` wizard detects your environment, walks through platform configuration, and generates your config file and an example test.

## Documentation

- [Getting Started](https://tapsmith.dev/getting-started/)
- [Locators Guide](https://tapsmith.dev/guides/locators/)
- [API Reference](https://tapsmith.dev/reference/api/locators/)
- [Configuration](https://tapsmith.dev/reference/configuration/)
- [CI Setup](https://tapsmith.dev/platform/ci-setup/)

## License

Apache-2.0
