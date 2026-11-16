import "dotenv/config"
import { defineConfig } from "tapsmith"

export default defineConfig({
  platform: "ios",
  app: "../test-app/build/Build/Products/Release-iphonesimulator/TapsmithTestApp.app",
  package: "dev.tapsmith.testapp",
  timeout: 10_000,
  // Speeds UIKit animations up on the simulator, and exercises Tapsmith's
  // setting and restore on every run (reduced-motion.ios.test.ts checks the setting).
  reducedMotion: "reduce",
  retries: 0,
  screenshot: "only-on-failure",
  workers: 2,
  trace: { mode: "retain-on-failure", daemonLogs: true },
  simulator: process.env.TAPSMITH_IOS_SIMULATOR || "iPhone 17",
  projects: [
    {
      name: "authentication",
      testMatch: ["**/auth.setup.ts"],
    },
    {
      name: "default",
      testMatch: ["**/*.test.ts"],
      testIgnore: ["**/multi-device/**", "**/app-state.test.ts", "**/auth-gate.test.ts", "**/*.android.test.ts"],
    },
    {
      name: "authenticated",
      dependencies: ["authentication"],
      use: { appState: "./tapsmith-results/auth-state-authentication.tar.gz" },
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
    },
  ],
})
