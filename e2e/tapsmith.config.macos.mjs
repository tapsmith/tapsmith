import { defineConfig } from "tapsmith"

// ─── macOS (experimental) ───
//
// Runs e2e/macos against the SwiftUI app in test-app-macos, on this Mac.
// macOS runs through sequential `tapsmith test` only. The app's data is
// cleared between tests, and restored to what it was once the run ends.
//
// Usage (from e2e/):
//   ../test-app-macos/build.sh
//   npx tapsmith test -c tapsmith.config.macos.mjs
//
// Leave the Mac alone while it runs: the tests drive its screen and keyboard.

export default defineConfig({
  platform: "macos",
  app: "../test-app-macos/build/Build/Products/Debug/TapsmithMacTestApp.app",
  package: "dev.tapsmith.mactestapp",
  workers: 1,
  timeout: 15_000,
  testMatch: ["macos/**/*.test.ts"],
  // Network capture isn't supported on macOS yet, and every trace mode
  // captures the network unless told not to.
  trace: { mode: "retain-on-failure", network: false },
})
