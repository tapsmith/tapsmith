import { defineConfig } from "tapsmith"

// ─── Multi-device (device group) config, Android, CI ───
//
// The CI counterpart of tapsmith.config.android-multi.mjs: same `pair`
// project, but the app comes from e2e/fixtures/ (where the workflow stages the
// built APK) rather than the repo's build output, and the retry / reporter
// settings match the sharded CI configs. Run by the `Multi-device` job of
// .github/workflows/e2e-android.yml.

export default defineConfig({
  apk: "./fixtures/app-release.apk",
  activity: "dev.tapsmith.testapp.MainActivity",
  package: "dev.tapsmith.testapp",
  timeout: 15_000,
  // The workflow already turns the emulator's animations off; this exercises
  // Tapsmith's own setting and restore on every run (PILOT-971).
  reducedMotion: "reduce",
  // Two retries (Playwright's CI convention): emulator-load one-offs can
  // outlast a single retry on oversubscribed runners.
  retries: 2,
  reporter: [["list"], ["github"], ["html", { open: "never" }]],
  screenshot: "only-on-failure",
  workers: 1,
  trace: { mode: "on-all-retries", daemonLogs: true },
  video: "on-first-retry",
  avd: "Tapsmith_Phone_API_36",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk:
    "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
  projects: [
    {
      name: "pair",
      testMatch: ["**/multi-device/**/*.test.ts"],
      // The workflow boots only the primary (pinned with --device); Tapsmith
      // launches bob from `avd` itself, the path this job checks.
      use: { devices: [{ name: "alice" }, { name: "bob" }] },
    },
  ],
})
