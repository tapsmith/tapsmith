import { defineConfig } from "tapsmith"
import { ciProjects } from "./ci-projects.mjs"

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
  // Record every attempt, keep failures and retries: a flaky test keeps its
  // failing first attempt next to the passing retry, so the flake itself is
  // in the report, not only the attempt that recovered from it.
  trace: { mode: "retain-on-failure-and-retries", daemonLogs: true },
  // on-first-retry: no encoder runs on healthy tests (PILOT-240); a failed
  // test's retry is recorded, so flake investigations still get a video.
  video: "on-first-retry",
  avd: "Tapsmith_Phone_API_36",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk:
    "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
  // authentication → default → authenticated; see ci-projects.mjs for how the
  // auth setup is skipped when the workflow restored a cached auth archive.
  projects: ciProjects({ testIgnore: ["**/*.ios.test.ts"] }),
})
