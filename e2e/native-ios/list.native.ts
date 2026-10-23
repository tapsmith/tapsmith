import { describe, expect, openScreen, test } from "./fixtures.js"

describe("Native: List", () => {
  test.beforeEach(async ({ device, list }) => {
    await openScreen(device, "list")
    await expect(list.item(1)).toBeVisible()
  })

  test("List is a list of cells", async ({ list }) => {
    await expect(list.list).toBeVisible()
    expect(await list.cells.count()).toBeGreaterThan(5)
  })

  test("typing into the .searchable field filters the list", async ({ list }) => {
    await list.search.type("Item 42")
    await expect(list.item(42)).toBeVisible()
    await expect(list.item(1)).toBeHidden()
  })

  test("tapping a row pushes its detail", async ({ list }) => {
    await list.item(3).tap()
    await expect(list.detail(3)).toBeVisible()
  })

  test("scrollIntoView reaches a row the lazy List hasn't rendered", async ({ list }) => {
    await list.item(80).scrollIntoView({ maxScrolls: 30 })
    await expect(list.item(80)).toBeVisible()
    await list.item(80).tap()
    await expect(list.detail(80)).toBeVisible()
  })

  test("a full swipe left deletes a row", async ({ device, list }) => {
    const box = await list.item(2).boundingBox()
    if (!box) throw new Error("Item 2 has no bounds")
    const y = box.y + box.height / 2
    await device.dragXY({ x: box.x + box.width - 20, y }, { x: box.x + 20, y })
    await expect(list.item(2)).toBeHidden()
    await expect(list.item(3)).toBeVisible()
  })
})
