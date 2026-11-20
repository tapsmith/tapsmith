import { test, describe, expect } from "../fixtures.js"

/**
 * locator({ id }) on Android: a bare R.id name matches that id under any
 * package, so it survives a build's applicationIdSuffix; a package-qualified
 * id matches only itself. The test app's activity root is AppCompat's
 * `<package>:id/action_bar_root`.
 */
describe("Native resource ids (Android)", () => {
  test("a bare R.id name finds the view whatever its package", async ({ homeScreen: home }) => {
    await expect(home.header).toBeVisible()

    await expect(home.appRoot()).toBeVisible()
    await expect(home.appRoot()).toHaveCount(1)
  })

  test("a package-qualified id matches only its own package", async ({ homeScreen: home }) => {
    await expect(home.header).toBeVisible()

    await expect(home.appRoot("dev.tapsmith.testapp:id/action_bar_root")).toHaveCount(1)
    await expect(home.appRoot("com.other.app:id/action_bar_root")).toHaveCount(0)
  })
})
