import path from "node:path"
import { describe, test, expect, type Device } from "tapsmith"

const PKG = "dev.tapsmith.testapp"
const SECRET = "secret-123"

// ─── iOS simulator keychain capture in app state (PILOT-220) ───
// saveAppState captures the simulator's device-level keychain (where
// keychain-backed SDKs like expo-secure-store and Firebase Auth persist
// data) alongside the app data container, and restoreAppState swaps it
// back. Without this, restored "authenticated" states silently lose
// keychain-backed credentials.

async function openKeychainScreen(device: Device) {
  await device.openDeepLink("tapsmithtest:///keychain")
  await expect(device.getByText("Keychain", { exact: true }).first()).toBeVisible()
}

async function loadStoredValue(device: Device) {
  await device.getByTestId("keychain-load-button").tap()
  await expect(device.getByTestId("keychain-status")).toHaveText("Loaded")
}

describe("keychain app state", () => {
  test.use({ timeout: 180_000 })

  test("saveAppState/restoreAppState round-trips keychain items", async ({
    device,
    projectName,
  }) => {
    const suffix = projectName ? `-${projectName.replace(/[^a-zA-Z0-9]/g, "-")}` : ""
    const statePath = path.join(
      process.cwd(),
      "tapsmith-results",
      `keychain-state${suffix}.tar.gz`,
    )

    // Store a secret in the keychain and verify it reads back
    await openKeychainScreen(device)
    await device.getByTestId("keychain-input").clearAndType(SECRET)
    await device.hideKeyboard()
    await device.getByTestId("keychain-save-button").tap()
    await loadStoredValue(device)
    await expect(device.getByTestId("keychain-value")).toHaveText(SECRET)

    // Save app state (includes the simulator keychain)
    await device.saveAppState(PKG, statePath)

    // Delete the keychain item and prove it's really gone
    await device.launchApp(PKG)
    await openKeychainScreen(device)
    await device.getByTestId("keychain-delete-button").tap()
    await loadStoredValue(device)
    await expect(device.getByTestId("keychain-value")).toHaveText("(empty)")

    // Restore: the keychain item must come back
    await device.restoreAppState(PKG, statePath)
    await device.launchApp(PKG)
    await openKeychainScreen(device)
    await loadStoredValue(device)
    await expect(device.getByTestId("keychain-value")).toHaveText(SECRET)
  })

  test("restoreAppState of a state saved with an empty keychain wipes keychain items", async ({
    device,
    projectName,
  }) => {
    const suffix = projectName ? `-${projectName.replace(/[^a-zA-Z0-9]/g, "-")}` : ""
    const statePath = path.join(
      process.cwd(),
      "tapsmith-results",
      `empty-keychain-state${suffix}.tar.gz`,
    )

    // Save a state with nothing in the keychain (PILOT-1069: restoring it
    // clears the keychain instead of swapping files and restarting securityd)
    await device.clearAppData(PKG)
    await device.saveAppState(PKG, statePath)

    await device.launchApp(PKG)
    await openKeychainScreen(device)
    await device.getByTestId("keychain-input").clearAndType(SECRET)
    await device.hideKeyboard()
    await device.getByTestId("keychain-save-button").tap()
    await loadStoredValue(device)
    await expect(device.getByTestId("keychain-value")).toHaveText(SECRET)

    await device.restoreAppState(PKG, statePath)
    await device.launchApp(PKG)
    await openKeychainScreen(device)
    await loadStoredValue(device)
    await expect(device.getByTestId("keychain-value")).toHaveText("(empty)")
  })

  test("clearAppData wipes keychain items", async ({ device }) => {
    await openKeychainScreen(device)
    await device.getByTestId("keychain-input").clearAndType(SECRET)
    await device.hideKeyboard()
    await device.getByTestId("keychain-save-button").tap()
    await loadStoredValue(device)
    await expect(device.getByTestId("keychain-value")).toHaveText(SECRET)

    await device.clearAppData(PKG)
    await device.launchApp(PKG)
    await openKeychainScreen(device)
    await loadStoredValue(device)
    await expect(device.getByTestId("keychain-value")).toHaveText("(empty)")
  })
})
