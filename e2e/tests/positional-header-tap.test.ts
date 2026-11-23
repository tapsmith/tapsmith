import { describe, expect, test } from "../fixtures.js"
import { HeaderMenuScreen } from "../screens/header-menu.screen.js"
import { openScreen } from "../utils/app-reset.js"

// On iOS, XCTest's live button query lists a bottom tab bar's buttons before
// a header's, though the header comes first in the tree. A positional
// locator's tap went through that query, touched the first tab instead of the
// header's button, and reported success. Typing into a field reads it back
// through that live element, so the fields check that the agent acts on the
// right one, not only that a tap lands where it was found.
describe("a positional tap on a header button", () => {
  let screen: HeaderMenuScreen

  test.beforeEach(async ({ device }) => {
    screen = new HeaderMenuScreen(device)
    await openScreen(device, "/header-menu")
    await expect(screen.content).toHaveText("Home content")
  })

  test("first() taps the header's first button", async () => {
    const { menu, add } = await screen.taps()
    await screen.buttons.first().tap()
    await expect(screen.status).toHaveText(`Menu ${menu + 1}, add ${add}`)
  })

  test("nth() taps the header's second button", async () => {
    const { menu, add } = await screen.taps()
    await screen.buttons.nth(1).tap()
    await expect(screen.status).toHaveText(`Menu ${menu}, add ${add + 1}`)
  })

  test("all()[i] taps the header's buttons", async () => {
    const { menu, add } = await screen.taps()
    const buttons = await screen.buttons.all()
    await buttons[0].tap()
    await expect(screen.status).toHaveText(`Menu ${menu + 1}, add ${add}`)
    await buttons[1].tap()
    await expect(screen.status).toHaveText(`Menu ${menu + 1}, add ${add + 1}`)
  })

  test("first() and nth() type into the field each names", async ({ device }) => {
    await screen.textFields.first().clearAndType("abc")
    await expect(screen.fields).toHaveText(/^Search “abc”, note/)
    // The field below the tabs is under the keyboard.
    await device.hideKeyboard()
    await screen.textFields.nth(1).clearAndType("xyz")
    await expect(screen.fields).toHaveText("Search “abc”, note “xyz”")
  })
})
