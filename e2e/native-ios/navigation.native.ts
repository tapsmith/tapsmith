import { describe, expect, openScreen, test } from "./fixtures.js"

describe("Native: navigation", () => {
  test("home lists every screen as a NavigationLink", async ({ home }) => {
    await expect(home.title).toBeVisible()
    await expect(home.row("Toggles")).toBeVisible()
    await expect(home.row("Accessibility")).toBeVisible()
  })

  test("tapping a row pushes the screen and Back pops it", async ({ home, toggles }) => {
    await home.row("Toggles").tap()
    await expect(toggles.darkMode).toBeVisible()
    await home.backButton.tap()
    await expect(home.title).toBeVisible()
  })

  test("a deep link replaces the stack", async ({ device, dialogs, home }) => {
    await openScreen(device, "dialogs")
    await expect(dialogs.showAlert).toBeVisible()
    await openScreen(device, "")
    await expect(home.title).toBeVisible()
  })
})
