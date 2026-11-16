import { describe, expect, test } from "../fixtures.js"

// getByRole matches the role itself, not whatever element type can carry it
// (PILOT-608). On iOS a heading used to be any static text, and a checkbox,
// radio button, alert or combobox any generic view. The toggles screen has
// four section headers (plus, on iOS, the navigation bar title, which has the
// header trait) among its plain texts, two RN checkboxes and three RN radio
// buttons.
describe("getByRole role matching", () => {
  // The last test changes the selected radio button.
  test.use({ appResetScope: "test", appResetRoute: "/toggles" })

  test.beforeEach(async ({ device, togglesScreen }) => {
    await expect(togglesScreen.switchesHeading).toBeVisible()
  })

  test("a heading is header text, not every text", async ({ device }) => {
    // Every heading is a header text; how many are in the tree depends on the
    // screen size (Android leaves out views scrolled off it).
    const headerTexts = ["Toggles", "Switches", "Checkboxes", "Radio Buttons", "Status"]
    const headings = await device.getByRole("heading").allTextContents()
    expect(headings).toContain("Switches")
    expect(headings).toContain("Checkboxes")
    for (const heading of headings) expect(headerTexts).toContain(heading)
    await expect(device.getByRole("heading", { name: "Radio Buttons" })).toHaveCount(1)
    await expect(device.getByRole("heading", { name: "Dark Mode" })).toHaveCount(0)
    await expect(device.getByRole("heading", { name: "Size: medium" })).toHaveCount(0)
  })

  test("a checkbox or radio button is one, not every generic view", async ({ device }) => {
    await expect(device.getByRole("checkbox")).toHaveCount(2)
    await expect(device.getByRole("radiobutton")).toHaveCount(3)
    await expect(device.getByRole("checkbox", { name: "Small" })).toHaveCount(0)
  })

  test("an unnamed alert or combobox query doesn't match generic views", async ({ device }) => {
    await expect(device.getByRole("alert")).toHaveCount(0)
    await expect(device.getByRole("combobox")).toHaveCount(0)
  })

  test("a role-only match acts on the element it matched", async ({ device, togglesScreen }) => {
    await device.getByRole("radiobutton").first().tap()
    await expect(togglesScreen.radioSmall).toBeChecked()
    await expect(togglesScreen.radioMedium).not.toBeChecked()
    await device.getByRole("checkbox").last().tap()
    await expect(device.getByRole("checkbox", { name: "Subscribe to newsletter" })).toBeChecked()
    await expect(togglesScreen.agreeCheckbox).not.toBeChecked()
  })
})
