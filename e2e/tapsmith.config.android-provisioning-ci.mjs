import { defineConfig } from "tapsmith"

// ─── Provisioning lane, Android, CI (PILOT-483) ───
//
// The emulator-managed setup docs/ci-setup.md documents ("Parallel Workers"):
// `avd` + `launchEmulators: true` and more than one worker, on a runner where
// NO emulator is running beforehand — so Tapsmith has to launch every device
// itself (provisionEmulators: -read-only instances of one AVD, port picking,
// the CI boot wait, health and stability probes). The sharded suites pre-boot
// their emulator in the workflow and only ever exercise adoption.
//
// Run by .github/workflows/e2e-provisioning.yml, which checks the host before
// and after (verify-provisioning.mjs) so a pre-booted or untracked emulator
// fails the job even when every test passes. A few small files are enough:
// this lane tests the launch path, not the app.
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
  trace: { mode: "on-all-retries", daemonLogs: true },
  video: "on-first-retry",
  workers: 2,
  launchEmulators: true,
  avd: process.env.TAPSMITH_AVD || "Tapsmith_Phone_API_36",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk:
    "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
  testMatch: ["**/home.test.ts", "**/toggles.test.ts", "**/list.test.ts"],
})
