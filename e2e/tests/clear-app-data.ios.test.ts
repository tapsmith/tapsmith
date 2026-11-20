import path from "node:path"
import { describe, expect } from "tapsmith"
import { test } from "../fixtures.js"

const PKG = "dev.tapsmith.testapp"

// ─── iOS simulator: a clear leaves the app as a fresh install would ───
// UserDefaults are served by the simulator's cfprefsd, which caches them
// and writes them to disk seconds late, so deleting the plists alone did
// not clear them: an app relaunched straight after a clear read the old
// values. Privacy permissions live outside the container and survived too.

describe("clearAppData on an iOS simulator", () => {
  test.use({ timeout: 180_000 })

  test("clears UserDefaults the app has just written", async ({ device, preferencesScreen }) => {
    await preferencesScreen.open()
    await preferencesScreen.save("pref-123")
    await preferencesScreen.load()
    await expect(preferencesScreen.value).toHaveText("pref-123")

    await device.clearAppData(PKG)
    await device.launchApp(PKG)
    await preferencesScreen.open()
    await preferencesScreen.load()
    await expect(preferencesScreen.value).toHaveText("(empty)")
  })

  test("resets the app's privacy permissions", async ({ device, permissionsScreen }) => {
    await device.grantPermission(PKG, "camera")
    await device.launchApp(PKG)
    await permissionsScreen.open()
    await permissionsScreen.checkCameraButton.tap()
    await expect(permissionsScreen.cameraStatus).toHaveText("granted")

    await device.clearAppData(PKG)
    await device.launchApp(PKG)
    await permissionsScreen.open()
    await permissionsScreen.checkCameraButton.tap()
    await expect(permissionsScreen.cameraStatus).toHaveText("undetermined")
  })

  test("saveAppState/restoreAppState round-trip UserDefaults written just before the save", async ({
    device,
    preferencesScreen,
    projectName,
  }) => {
    const suffix = projectName ? `-${projectName.replace(/[^a-zA-Z0-9]/g, "-")}` : ""
    const statePath = path.join(process.cwd(), "tapsmith-results", `preferences-state${suffix}.tar.gz`)

    await preferencesScreen.open()
    // cfprefsd writes a domain's first plist at once but defers later
    // changes, so the value to save is the second write, saved at once.
    await preferencesScreen.save("first-value")
    await preferencesScreen.save("saved-value")
    await device.saveAppState(PKG, statePath)

    await device.launchApp(PKG)
    await preferencesScreen.open()
    await preferencesScreen.save("later-value")

    await device.restoreAppState(PKG, statePath)
    await device.launchApp(PKG)
    await preferencesScreen.open()
    await preferencesScreen.load()
    await expect(preferencesScreen.value).toHaveText("saved-value")
  })
})
