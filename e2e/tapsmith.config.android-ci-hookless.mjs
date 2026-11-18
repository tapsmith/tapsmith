import { defineConfig } from "tapsmith"

// The hook-less path in CI: the same test app built WITHOUT
// EXPO_PUBLIC_TAPSMITH_HOOKS — what every app is before it integrates
// @tapsmith/react-native. `appReset: 'auto'` must resolve to clear · file,
// plain deep links must settle through the resumed-activity heuristic (no nav
// counter to acknowledge them), and warm requests must fall back honestly.
//
// Run by .github/workflows/e2e-android-hookless.yml (weekly + on changes to
// the reset-path sources). Three files, chosen for what they exercise:
//   - app-reset.hookless.ts   detection comes up empty, honest fallbacks
//   - gestures.test.ts        openScreen-per-test → heuristic link settling
//   - toggles.test.ts         appResetScope 'test' → repeated cold clears +
//                             clean-task relaunch under load
export default defineConfig({
  apk: "./fixtures/app-release.apk",
  activity: "dev.tapsmith.testapp.MainActivity",
  package: "dev.tapsmith.testapp",
  timeout: 15_000,
  // Two retries (Playwright's CI convention): emulator-load one-offs can
  // outlast a single retry on oversubscribed runners.
  retries: 2,
  reporter: [["list"], ["github"], ["html", { open: "never" }]],
  screenshot: "only-on-failure",
  workers: 1,
  trace: { mode: "retain-on-failure-and-retries", daemonLogs: true },
  video: "on-first-retry",
  avd: "Tapsmith_Phone_API_36",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk:
    "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
  projects: [
    {
      name: "hookless",
      testMatch: [
        "**/app-reset.hookless.ts",
        "**/gestures.test.ts",
        "**/toggles.test.ts",
      ],
    },
  ],
})
