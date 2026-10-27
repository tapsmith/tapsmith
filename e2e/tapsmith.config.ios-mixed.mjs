/**
 * Mixed iOS config: simulator + physical device in a single `tapsmith test` run.
 *
 * Runs the full suite twice in parallel — once on an iOS simulator, once on
 * a USB-attached physical iPhone — so you can exercise the simulator/device
 * parity of the framework in one invocation.
 *
 * Usage:
 *   tapsmith test -c tapsmith.config.ios-mixed.mjs
 *   tapsmith test -c tapsmith.config.ios-mixed.mjs --ui
 *
 * Requires:
 *   1. Simulator side: a simulator build of test-app at
 *      test-app/build/Build/Products/Release-iphonesimulator/TapsmithTestApp.app
 *      and a built simulator agent xctestrun (auto-detected via
 *      findLatestXctestrun()).
 *   2. Device side: `tapsmith ios build-agent` run once to produce the signed
 *      xctestrun under ios-agent/.build-device/ (auto-resolved), plus a
 *      device build of the test-app at
 *      test-app/ios/build/Build/Products/Release-iphoneos/TapsmithTestApp.app
 *      (build via `cd test-app && npx expo run:ios --configuration Release --device <udid>`).
 *   3. Network capture on the physical device: `tapsmith ios network configure
 *      <udid>` once (see docs/ios-physical-devices.md).
 *
 * Set TAPSMITH_IOS_SIMULATOR / TAPSMITH_IOS_XCTESTRUN / TAPSMITH_IOS_DEVICE to pin
 * specific targets; all are otherwise auto-resolved.
 */
import "dotenv/config"
import { defineConfig } from "tapsmith"
import { RESET_APP_DEEP_LINK } from "./reset-app-deep-link.mjs"

const SIM_USE = {
  platform: "ios",
  app: "../test-app/build/Build/Products/Release-iphonesimulator/TapsmithTestApp.app",
  simulator: process.env.TAPSMITH_IOS_SIMULATOR || "iPhone 17",
}

// Physical device: both `device` (UDID) and `iosXctestrun` are intentionally
// omitted so Tapsmith auto-resolves them — the single paired USB device and the
// newest iphoneos xctestrun under ios-agent/.build-device/ respectively.
// Override with TAPSMITH_IOS_DEVICE if multiple devices are connected.
const DEVICE_USE = {
  platform: "ios",
  app: "../test-app/ios/build/Build/Products/Release-iphoneos/TapsmithTestApp.app",
  ...(process.env.TAPSMITH_IOS_DEVICE ? { device: process.env.TAPSMITH_IOS_DEVICE } : {}),
}

export default defineConfig({
  package: "dev.tapsmith.testapp",
  // Deliberately keeps the explicit reset route: this config exercises the
  // legacy `resetAppDeepLink` path (the other configs rely on the in-app hooks
  // from @tapsmith/react-native being detected automatically).
  resetAppDeepLink: RESET_APP_DEEP_LINK,
  timeout: 15_000,
  retries: 0,
  screenshot: "only-on-failure",
  trace: {
    mode: "retain-on-failure",
    daemonLogs: true,
    // Physical iOS captures Wi-Fi traffic system-wide; scope to the hosts
    // the test app actually calls so traces aren't dominated by iOS
    // background services. Honoured on the simulator side too (harmless —
    // the sim's Network Extension redirector already filters per-PID).
    networkHosts: ["jsonplaceholder.typicode.com"],
  },
  projects: [
    // ─── Simulator ───
    {
      name: "ios-sim:auth-setup",
      testMatch: ["**/auth.setup.ts"],
      use: { ...SIM_USE, timeout: 30_000 },
    },
    {
      name: "ios-sim",
      workers: 2,
      testMatch: ["**/*.test.ts"],
      testIgnore: ["**/multi-device/**", "**/macos/**", 
        "**/app-state.test.ts",
        "**/auth-gate.test.ts",
        "**/*.android.test.ts",
      ],
      use: SIM_USE,
    },
    {
      name: "ios-sim:authenticated",
      dependencies: ["ios-sim:auth-setup"],
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
      use: { ...SIM_USE, appState: "./tapsmith-results/auth-state-ios-sim-auth-setup.tar.gz" },
    },

    // ─── Physical device ───
    //
    // workers: 1 — a single physical iPhone can only run one XCUITest
    // session at a time, unlike simulators which can be cloned.
    {
      name: "ios-device:auth-setup",
      testMatch: ["**/auth.setup.ts"],
      use: { ...DEVICE_USE, timeout: 30_000 },
    },
    {
      name: "ios-device",
      workers: 1,
      testMatch: ["**/*.test.ts"],
      testIgnore: ["**/multi-device/**", "**/macos/**", 
        "**/app-state.test.ts",
        "**/auth-gate.test.ts",
        "**/*.android.test.ts",
      ],
      use: DEVICE_USE,
    },
    {
      name: "ios-device:authenticated",
      dependencies: ["ios-device:auth-setup"],
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
      use: { ...DEVICE_USE, appState: "./tapsmith-results/auth-state-ios-device-auth-setup.tar.gz" },
    },
  ],
})
