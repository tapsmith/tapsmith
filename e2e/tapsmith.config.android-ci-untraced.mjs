import { defineConfig } from "tapsmith"

// On-demand network capture from an un-rooted adbd (PILOT-831). No `trace`, so
// the session records no network and the tests' first route() starts the proxy
// on demand (PILOT-775). Run by e2e-android.yml shard 1 right after
// `adb unroot`: the CA install roots the emulator, which restarts adbd, so it
// must happen when the device is selected — before the agent starts — and not
// mid-test, where it used to end the agent ("Failed to connect to agent
// socket"). No retries: a session recovered from that failure would otherwise
// pass on its retry.
export default defineConfig({
  apk: "./fixtures/app-release.apk",
  activity: "dev.tapsmith.testapp.MainActivity",
  package: "dev.tapsmith.testapp",
  timeout: 15_000,
  retries: 0,
  reporter: [["list"], ["github"]],
  screenshot: "only-on-failure",
  workers: 1,
  avd: "Tapsmith_Phone_API_36",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk:
    "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
  testMatch: ["**/network-mocking.test.ts"],
})
