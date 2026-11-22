import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// A text field's typed value is not getByText text, as an <input>'s value is
// not in Playwright (PILOT-1404 on Android, PILOT-1417 on iOS). The list
// screen's search field filters the rows by what is typed into it, as a search
// screen does: the text typed must find the result row, not the field it was
// typed into.
describe("getByText skips a text field's typed value", () => {
  // The app is not reset between these tests: each starts from an empty field.
  test.beforeEach(async ({ device, listScreen }) => {
    await openScreen(device, "/list")
    await listScreen.searchField.clear()
    await expect(listScreen.itemCount).toHaveText("30 items")
  })

  // The row: Android's text, iOS's React Native touchable, which merges its text into its label.
  const rowRole = (platform: string) => (platform === "ios" ? "button" : "text")

  test("an exact getByText finds the result typed into the search field, not the field", async ({ device, listScreen, platform }) => {
    await listScreen.searchField.type("Item 7")
    await expect(listScreen.itemCount).toHaveText("1 items")
    const result = listScreen.itemByText("Item 7")
    await expect(result).toHaveCount(1)
    await expect(result).toHaveRole(rowRole(platform))
    // On iOS a row tap while the keyboard is still up after type() only puts
    // the keyboard away on this screen, whatever locator finds the row.
    if (platform === "ios") await device.hideKeyboard()
    await result.tap()
    await expect(listScreen.selectedCount).toHaveText("1 selected")
  })

  test("by substring and RegExp too", async ({ device, listScreen, platform }) => {
    await listScreen.searchField.type("Item 7")
    await expect(listScreen.itemCount).toHaveText("1 items")
    await expect(device.getByText("item 7")).toHaveCount(1)
    await expect(device.getByText(/^Item 7$/)).toHaveCount(1)
    await expect(device.getByText(/^Item 7$/)).toHaveRole(rowRole(platform))
  })

  test("a value no result shows yet matches nothing, instead of the field", async ({ device, listScreen }) => {
    await listScreen.searchField.type("Item 31")
    await expect(listScreen.itemCount).toHaveText("0 items")
    await expect(device.getByText("Item 31", { exact: true })).toHaveCount(0)
    await expect(device.getByText("Item 31", { exact: true })).toBeHidden()
  })

  test("filter({ hasText }) doesn't read the field's value", async ({ listScreen }) => {
    await listScreen.searchField.type("Item 7")
    await expect(listScreen.searchField.filter({ hasText: "Item 7" })).toHaveCount(0)
    await expect(listScreen.searchField.filter({ hasText: /Item/ })).toHaveCount(0)
    await expect(listScreen.searchField.filter({ hasNotText: "Item 7" })).toHaveCount(1)
  })

  test("an empty field's placeholder is still its text", async ({ device, listScreen, platform }) => {
    // An empty React Native field reports no value on iOS, so its placeholder
    // is no getByText text there; getByPlaceholder() finds it on both.
    test.skip(platform === "ios", "iOS reports an empty React Native field's value as empty, not its placeholder")
    await expect(listScreen.searchField).toBeEmpty()
    await expect(device.getByText("Search items...", { exact: true })).toHaveCount(1)
  })
})
