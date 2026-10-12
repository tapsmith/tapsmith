import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-664: React Native's menu, menuitem, timer (and menubar, radiogroup,
// scrollbar, spinbutton, summary, tablist) have no native widget. Android
// reports them from the role description RN publishes on a generic View, but
// getByRole rejected the names, so the roles the snapshot showed could not be
// used. iOS's new architecture publishes nothing for them: a named query finds
// the generic view by its label, as for alert and combobox (PILOT-608).
//
// The roles screen's elements come from RolesScreen. Two tests keep a raw
// getByRole inline because the role name itself is what they test: a loop over
// every description-only role, and the "radio" alias.
describe("getByRole for React Native's generic-view roles", () => {
  test.use({ appResetScope: "test" })

  test.beforeEach(async ({ device, rolesScreen }) => {
    await openScreen(device, "/roles")
    await expect(rolesScreen.status).toHaveText("Last action: none, bold off")
  })

  test("a named menuitem query finds the item and acts on it", async ({ rolesScreen }) => {
    await rolesScreen.menuItem("Paste").tap()
    await expect(rolesScreen.status).toHaveText("Last action: Paste, bold off")
    await expect(rolesScreen.elapsedTimer).toBeVisible()
    // iOS: RN's summary role sets the summary-element trait, which marks no
    // other role, so a named query still finds it.
    await expect(rolesScreen.orderSummary).toBeVisible()
    await expect(rolesScreen.quantitySpinButton).toBeVisible()
  })

  test("role-only queries find every menu item on Android and none on iOS", async ({ platform, rolesScreen }) => {
    // Android reads RN's role description; iOS has nothing to read.
    await expect(rolesScreen.menuItems).toHaveCount(platform === "android" ? 2 : 0)
    if (platform === "android") {
      await expect(rolesScreen.menuItems.first()).toHaveRole("menuitem")
      await rolesScreen.menuItems.last().tap()
      await expect(rolesScreen.status).toHaveText("Last action: Paste, bold off")
    }
  })

  test("every description-only role, containers included, is in the tree on Android", async ({ device, platform, rolesScreen }) => {
    test.skip(platform !== "android", "iOS publishes nothing for these roles; a named query finds them there")
    for (const role of ["menu", "menubar", "tablist", "radiogroup", "spinbutton", "scrollbar", "summary", "timer"]) {
      await expect(device.getByRole(role)).toHaveCount(1)
    }
    await expect(rolesScreen.quantitySpinButton).toHaveRole("spinbutton")
  })

  test("an RN togglebutton is a button", async ({ rolesScreen }) => {
    await rolesScreen.boldToggle.tap()
    await expect(rolesScreen.status).toHaveText("Last action: none, bold on")
  })

  test("getByRole('radio') is radiobutton", async ({ device, togglesScreen }) => {
    await openScreen(device, "/toggles")
    await expect(togglesScreen.switchesHeading).toBeVisible()
    await expect(device.getByRole("radio")).toHaveCount(3)
  })
})
