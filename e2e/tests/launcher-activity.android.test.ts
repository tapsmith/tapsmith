import { test, expect, describe, Device } from "tapsmith"
import { HomeScreen } from "../screens/home.screen"

// The test app has a second MAIN/LAUNCHER entry, the alias LeakCanary adds to
// debug builds (test-app/plugins/with-leakcanary-launcher.js), which opens the
// native settings screen. `resolve-activity` answers the system chooser for
// such an app and `monkey -c LAUNCHER` may start either entry, so every launch
// path must start the app's own MainActivity (PILOT-1402). The configs that
// run this file set no `activity`, so this is the daemon's launcher
// resolution.
async function expectOwnLauncherActivity(device: Device) {
  await expect(new HomeScreen(device).header).toBeVisible()
  expect(await device.currentActivity()).toMatch(/\.MainActivity$/)
}

describe("An app with a second, LeakCanary-style launcher activity (PILOT-1402)", () => {
  test("the file's launch starts the app's own activity", async ({ device }) => {
    await expectOwnLauncherActivity(device)
  })

  // restartApp() force-stops and starts the launcher activity with the
  // launcher intent.
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

// A hooks build resets warm, by deep link, which never asks which launcher
// activity to start. Restart and clear resets relaunch the app from a clean
// task with its launcher activity, as failure recovery does.
for (const appReset of ["restart", "clear"] as const) {
  describe(`An app with a second launcher activity, after an appReset: "${appReset}" reset (PILOT-1402)`, () => {
    test.use({ appReset, appResetScope: "test" })

    test("the first test's reset starts the app's own activity", async ({ device }) => {
      await expectOwnLauncherActivity(device)
    })

    test("the next test's reset starts it again", async ({ device }) => {
      await expectOwnLauncherActivity(device)
    })
  })
}
