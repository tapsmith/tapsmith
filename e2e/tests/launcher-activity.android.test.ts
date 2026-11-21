import { test, expect, describe, Device } from "tapsmith"
import { HomeScreen } from "../screens/home.screen"

// The test app has a second MAIN/LAUNCHER entry, the alias LeakCanary adds to
// debug builds (test-app/plugins/with-leakcanary-launcher.js), which opens the
// native settings screen. `resolve-activity` answers the system chooser for
// such an app and `monkey -c LAUNCHER` may start either entry, so every launch
// path must start the app's own MainActivity by itself (PILOT-1402).
async function expectOwnLauncherActivity(device: Device) {
  await expect(new HomeScreen(device).header).toBeVisible()
  expect(await device.currentActivity()).toMatch(/\.MainActivity$/)
}

describe("An app with a second, LeakCanary-style launcher activity (PILOT-1402)", () => {
  test.use({ appResetScope: "test" })

  test("the file's launch starts the app's own activity", async ({ device }) => {
    await expectOwnLauncherActivity(device)
  })

  test("a per-test reset starts it again", async ({ device }) => {
    await expectOwnLauncherActivity(device)
  })

  test("restartApp() starts it", async ({ device }) => {
    await device.restartApp()
    await expectOwnLauncherActivity(device)
  })

  test("launchApp() without an activity starts it", async ({ device }) => {
    await device.terminateApp()
    await device.launchApp("dev.tapsmith.testapp")
    await expectOwnLauncherActivity(device)
  })
})
