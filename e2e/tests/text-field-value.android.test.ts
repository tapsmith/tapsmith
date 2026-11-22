import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// A text field's typed value is not getByText text, as an <input>'s value is
// not in Playwright (PILOT-1404). The list screen's search field filters the
// rows by what is typed into it, as a search screen does: the text typed must
// find the result row, not the field it was typed into.
//
// Android only: the iOS agent still reads a text field's value as its text
// (TextContent.valueTextTypes).
describe("getByText skips a text field's typed value", () => {
  // The app is not reset between these tests: each starts from an empty field.
  test.beforeEach(async ({ device, listScreen }) => {
    await openScreen(device, "/list")
    await listScreen.searchField.clear()
    await expect(listScreen.itemCount).toHaveText("30 items")
  })

  test("an exact getByText finds the result typed into the search field, not the field", async ({ listScreen }) => {
    await listScreen.searchField.type("Item 7")
    await expect(listScreen.itemCount).toHaveText("1 items")
    const result = listScreen.itemByText("Item 7")
    await expect(result).toHaveCount(1)
    await expect(result).toHaveRole("text")
    await result.tap()
    await expect(listScreen.selectedCount).toHaveText("1 selected")
  })

  test("by substring and RegExp too", async ({ device, listScreen }) => {
    await listScreen.searchField.type("Item 7")
    await expect(listScreen.itemCount).toHaveText("1 items")
    await expect(device.getByText("item 7")).toHaveCount(1)
    await expect(device.getByText(/^Item 7$/)).toHaveCount(1)
    await expect(device.getByText(/^Item 7$/)).toHaveRole("text")
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

  test("an empty field's placeholder is still its text", async ({ device, listScreen }) => {
    await expect(listScreen.searchField).toBeEmpty()
    await expect(device.getByText("Search items...", { exact: true })).toHaveCount(1)
  })
})
