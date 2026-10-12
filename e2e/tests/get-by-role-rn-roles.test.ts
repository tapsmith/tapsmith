import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-664: React Native's menu, menuitem, timer (and menubar, radiogroup,
// scrollbar, spinbutton, summary, tablist) have no native widget. Android
// reports them from the role description RN publishes on a generic View, but
// getByRole rejected the names, so the roles the snapshot showed could not be
// used. iOS's new architecture publishes nothing for them: a named query finds
// the generic view by its label, as for alert and combobox (PILOT-608).
describe("getByRole for React Native's generic-view roles", () => {
  test.use({ appResetScope: "test" })

  test.beforeEach(async ({ device }) => {
    await openScreen(device, "/roles")
    await expect(device.getByTestId("roles-status")).toHaveText("Last action: none, bold off")
  })

  test("a named menuitem query finds the item and acts on it", async ({ device }) => {
    await device.getByRole("menuitem", { name: "Paste" }).tap()
    await expect(device.getByTestId("roles-status")).toHaveText("Last action: Paste, bold off")
    await expect(device.getByRole("timer", { name: "Elapsed time" })).toBeVisible()
    // iOS: RN's summary role sets the summary-element trait, which marks no
    // other role, so a named query still finds it.
    await expect(device.getByRole("summary", { name: "Order summary" })).toBeVisible()
    await expect(device.getByRole("spinbutton", { name: "Quantity" })).toBeVisible()
  })

  test("role-only queries find every menu item on Android and none on iOS", async ({ device, platform }) => {
    // Android reads RN's role description; iOS has nothing to read.
    const expected = platform === "android" ? 2 : 0
    await expect(device.getByRole("menuitem")).toHaveCount(expected)
    if (platform === "android") {
      await expect(device.getByRole("menuitem").first()).toHaveRole("menuitem")
      await expect(device.getByRole("timer")).toHaveCount(1)
      await device.getByRole("menuitem").last().tap()
      await expect(device.getByTestId("roles-status")).toHaveText("Last action: Paste, bold off")
    }
  })

  test("the other description-only roles, containers included, are in the tree on Android", async ({ device, platform }) => {
    test.skip(platform !== "android", "iOS publishes nothing for these roles; a named query finds them there")
    for (const role of ["menubar", "tablist", "radiogroup", "spinbutton", "scrollbar", "summary"]) {
      await expect(device.getByRole(role)).toHaveCount(1)
    }
    await expect(device.getByRole("spinbutton", { name: "Quantity" })).toHaveRole("spinbutton")
  })

  test("an RN togglebutton is a button", async ({ device }) => {
    const bold = device.getByRole("button", { name: "Bold" })
    await bold.tap()
    await expect(device.getByTestId("roles-status")).toHaveText("Last action: none, bold on")
  })

  test("getByRole('radio') is radiobutton", async ({ device }) => {
    await openScreen(device, "/toggles")
    await expect(device.getByRole("radio")).toHaveCount(3)
  })
})
