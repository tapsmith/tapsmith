import { describe, expect, openScreen, test } from "./fixtures.js"

// PILOT-1207: iOS 27 adds a Toolbar node the size of the window to every app
// window, empty or holding a bottom toolbar's items. It is not drawn over the
// screen, so it must not make every element "covered by toolbar". The items
// in it still take touches.
describe("Native: bottom toolbar", () => {
  test.beforeEach(async ({ device, toolbar }) => {
    await openScreen(device, "toolbar")
    await expect(toolbar.lastAction("None")).toBeVisible()
  })

  for (const name of ["Archive", "Compose"]) {
    test(`tapping the toolbar's ${name} item`, async ({ toolbar }) => {
      await toolbar.button(name).tap()
      await expect(toolbar.lastAction(name)).toBeVisible()
    })
  }

  test("tapping a row above the toolbar", async ({ toolbar }) => {
    await toolbar.button("Row 3").tap()
    await expect(toolbar.lastAction("Row 3")).toBeVisible()
  })
})
