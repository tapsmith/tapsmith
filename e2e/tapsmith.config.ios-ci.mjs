import { defineConfig } from "tapsmith"
import { ciProjects } from "./ci-projects.mjs"

export default defineConfig({
  platform: "ios",
  app: "./fixtures/TapsmithTestApp.app",
  package: "dev.tapsmith.testapp",
  timeout: 30_000,
  // Speeds UIKit animations up on the simulator, and exercises Tapsmith's
  // setting and restore on every run (reduced-motion.ios.test.ts checks it).
  reducedMotion: "reduce",
  typingDelay: 10,
  // Two retries (Playwright's CI convention): runner-scoped outages
  // (compositor stalls, input-injection drops) can outlast a single retry
  // even after the framework's own recovery escalations.
  retries: 2,
  reporter: [["list"], ["github"], ["html", { open: "never" }]],
  screenshot: "only-on-failure",
  trace: {
    mode: "retain-on-failure",
    daemonLogs: true,
    networkHosts: ["jsonplaceholder.typicode.com", "127.0.0.1"],
  },
  // on-first-retry: no encoder runs on healthy tests (PILOT-240); a failed
  // test's retry is recorded, so flake investigations still get a video.
  video: "on-first-retry",
  workers: 1,
  simulator: process.env.TAPSMITH_IOS_SIMULATOR || "iPhone 16",
  iosXctestrun: process.env.TAPSMITH_IOS_XCTESTRUN || undefined,
  // authentication → default → authenticated; see ci-projects.mjs for how the
  // auth setup is skipped when the workflow restored a cached auth archive.
  projects: ciProjects({ testIgnore: ["**/*.android.test.ts"] }),
})
