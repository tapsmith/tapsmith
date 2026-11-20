import { describe, expect, openScreen, test } from "./fixtures.js"

// A UIKit settings row's switch is found by its row's title, as an androidx
// SwitchPreference's switch is on Android. UIKit labels the switch with the
// row's texts joined by ", " ("Wi-Fi, Join known networks"), so getByRole's
// substring name already found it; getByLabel compares the whole label, and
// now also accepts the row's title. The subtitle alone is no label.

async function dump(device: unknown): Promise<string> {
  // Internal gRPC client: the hierarchy dump itself is what is under test.
  const client = (device as { _client: { getUiHierarchy(): Promise<{ hierarchyXml: string }> } })._client
  return (await client.getUiHierarchy()).hierarchyXml
}

describe("UIKit: settings rows", () => {
  test.beforeEach(async ({ device, uikitSettings }) => {
    await openScreen(device, "uikitsettings")
    await expect(uikitSettings.status).toBeVisible()
  })

  test("getByRole finds each row's switch by its title", async ({ uikitSettings: s }) => {
    await expect(s.switches).toHaveCount(6)
    for (const title of ["Airplane Mode", "Wi-Fi", "Sync Photos", "Cellular Data", "Personal Hotspot"]) {
      await expect(s.switch(title)).toHaveCount(1)
    }
    // An exact name is one part of the ", "-joined label: the title.
    await expect(s.switch("Wi-Fi", { exact: true })).toHaveCount(1)
    await expect(s.switch("Wi-Fi")).toBeChecked()
    await expect(s.switch("Personal Hotspot")).not.toBeChecked()
  })

  test("getByLabel finds a row's switch by its title, not its subtitle", async ({ uikitSettings: s }) => {
    for (const title of ["Airplane Mode", "Wi-Fi", "Sync Photos", "Cellular Data", "Personal Hotspot"]) {
      await expect(s.labelled(title)).toHaveCount(1)
    }
    await expect(s.labelled("Join known networks")).toHaveCount(0)
    // The whole label still labels it.
    await expect(s.labelled("Wi-Fi, Join known networks")).toHaveCount(1)
  })

  test("a switch with a label of its own keeps it", async ({ uikitSettings: s }) => {
    await expect(s.labelled("Bluetooth radio")).toHaveCount(1)
    await expect(s.labelled("Bluetooth")).toHaveCount(0)
  })

  test("the switch found by its row's title toggles that row", async ({ uikitSettings: s }) => {
    await s.labelled("Wi-Fi").tap()
    await expect(s.status).toHaveText("Wi-Fi: off")
    await expect(s.labelled("Wi-Fi")).not.toBeChecked()

    await s.labelled("Personal Hotspot").setChecked(true)
    await expect(s.status).toHaveText("Personal Hotspot: on")
    await expect(s.switch("Personal Hotspot")).toBeChecked()
    // Only that row's switch changed.
    await expect(s.switch("Cellular Data")).toBeChecked()
  })

  test("the hierarchy dump carries the row's title on its switch", async ({ device, uikitSettings: s }) => {
    await expect(s.switch("Wi-Fi")).toBeVisible()
    const xml = await dump(device)
    const tag = xml.match(/<XCUIElementTypeSwitch\b[^>]*label="Wi-Fi, Join known networks"[^>]*>/)?.[0]
    expect(tag).toContain('tapsmith-label="Wi-Fi"')
    expect(xml.match(/<XCUIElementTypeSwitch\b[^>]*label="Bluetooth radio"[^>]*>/)?.[0]).not.toContain("tapsmith-label")
  })
})
