/**
 * E2E config targeting a physical iOS device.
 *
 * Device UDID and xctestrun path are both auto-resolved by Tapsmith:
 *   - `device` is omitted → Tapsmith picks the single paired USB iOS device.
 *     Set TAPSMITH_IOS_DEVICE when multiple are connected.
 *   - `iosXctestrun` is omitted → Tapsmith picks the newest iphoneos xctestrun
 *     under `ios-agent/.build-device/`. Run `tapsmith ios build-agent` once
 *     per Tapsmith upgrade to populate it.
 *
 * Requires:
 *   1. `tapsmith ios build-agent` run once to produce the signed xctestrun
 *      (see docs/ios-physical-devices.md).
 *   2. A device-signed build of the test-app accessible as
 *      test-app/ios/build/Build/Products/Release-iphoneos/TapsmithTestApp.app
 *      (build via `cd test-app && npx expo run:ios --configuration Release --device <udid>`).
 *
 * Mirrors the simulator config's three-project auth-setup flow.
 */
import "dotenv/config"
import { defineConfig } from "tapsmith"

export default defineConfig({
  platform: "ios",
  app: "../test-app/ios/build/Build/Products/Release-iphoneos/TapsmithTestApp.app",
  package: "dev.tapsmith.testapp",
  timeout: 15_000,
  retries: 0,
  screenshot: "only-on-failure",
  workers: 1,
  trace: {
    mode: "retain-on-failure",
    daemonLogs: true,
    // Physical iOS captures traffic system-wide (no per-app scoping without
    // MDM). Allowlist the hosts the test app actually calls so traces don't
    // fill up with iOS background services and unrelated apps.
    networkHosts: ["jsonplaceholder.typicode.com"],
  },
  projects: [
    {
      name: "authentication",
      testMatch: ["**/auth.setup.ts"],
    },
    {
      name: "default",
      testMatch: ["**/*.test.ts"],
      testIgnore: ["**/multi-device/**", "**/macos/**", "**/app-state.test.ts", "**/auth-gate.test.ts", "**/*.android.test.ts"],
    },
    {
      name: "authenticated",
      dependencies: ["authentication"],
      use: { appState: "./tapsmith-results/auth-state-authentication.tar.gz" },
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
    },
  ],
})
