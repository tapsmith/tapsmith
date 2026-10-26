import { defineConfig } from "tapsmith"

// ─── Native SwiftUI app, iOS simulator ───
//
// Runs e2e/native-ios/ against native-ios-test-app/ (plain SwiftUI, no React
// Native, no in-app hooks — so every reset is a cold clear). Build the app
// first with `native-ios-test-app/build.sh`.
//
// The tests are named `*.native.ts`, not `*.test.ts`: every other config globs
// `**/*.test.ts`, and these target a different app.
export default defineConfig({
  platform: "ios",
  app: "../native-ios-test-app/build/Build/Products/Release-iphonesimulator/TapsmithNativeTestApp.app",
  package: "dev.tapsmith.nativetestapp",
  timeout: 10_000,
  retries: 0,
  screenshot: "only-on-failure",
  workers: 1,
  trace: { mode: "retain-on-failure", daemonLogs: true },
  simulator: process.env.TAPSMITH_IOS_SIMULATOR || "iPhone 17 Pro",
  testMatch: ["native-ios/**/*.native.ts"],
})
