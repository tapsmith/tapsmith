import { defineConfig } from "tapsmith"

// ─── Provisioning lane, iOS, CI (PILOT-483) ───
//
// The setup docs/ci-setup.md documents for iOS: `simulator: "<name>"` and no
// `xcrun simctl` step — "Tapsmith boots and manages simulators
// automatically". The sharded suites boot their simulator in the workflow and
// only ever exercise reuse of an already-booted one; here nothing is booted
// beforehand, so Tapsmith has to find, boot and install onto it itself.
//
// One worker: a second simulator (the clone path) cannot run at usable speed
// on the standard 3-core macOS runner — see the Multi-device job in
// e2e-ios.yml. The prebuilt agent (iosXctestrun) is a CI shortcut; building
// it is covered elsewhere.
//
// Run by .github/workflows/e2e-provisioning.yml, which checks the host before
// and after (verify-provisioning.mjs) so a pre-booted simulator or a leftover
// clone fails the job even when every test passes.
export default defineConfig({
  platform: "ios",
  app: "./fixtures/TapsmithTestApp.app",
  package: "dev.tapsmith.testapp",
  timeout: 30_000,
  typingDelay: 10,
  retries: 2,
  reporter: [["list"], ["github"], ["html", { open: "never" }]],
  screenshot: "only-on-failure",
  trace: { mode: "on-all-retries", daemonLogs: true, network: false },
  video: "on-first-retry",
  workers: 1,
  simulator: process.env.TAPSMITH_IOS_SIMULATOR || "iPhone 16",
  iosXctestrun: process.env.TAPSMITH_IOS_XCTESTRUN || undefined,
  testMatch: ["**/home.test.ts", "**/toggles.test.ts", "**/list.test.ts"],
})
