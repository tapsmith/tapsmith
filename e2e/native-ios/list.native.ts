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

  // The List runs under its see-through navigation bar and search field: a
  // scroll back up must start its drag on the rows, not on the bar.
  describe("scrolling both ways", () => {
    // Several scrolls of the 100-row List: more than the default 30 s.
    test.use({ timeout: 120_000 })

    test("scrollIntoView scrolls back up to a row, and finds both ends of the list", async ({ device, list }) => {
      await list.item(60).scrollIntoView({ maxScrolls: 30 })
      await expect(list.item(60)).toBeVisible()
      await list.item(2).scrollIntoView({ direction: "up", maxScrolls: 30 })
      await list.item(2).tap()
      await expect(list.detail(2)).toBeVisible()
      await device.getByRole("button", { name: "List" }).first().tap()

      const missing = device.getByText("Item 999", { exact: true })
      const atBottom = await missing.scrollIntoView({ direction: "down", maxScrolls: 30 }).then(() => null, (e: unknown) => e)
      expect((atBottom as Error).message).toMatch(/reached the end of the scrollable content/)
      await expect(list.item(100)).toBeVisible()
      const atTop = await missing.scrollIntoView({ direction: "up", maxScrolls: 30 }).then(() => null, (e: unknown) => e)
      expect((atTop as Error).message).toMatch(/reached the end of the scrollable content/)
      await expect(list.item(1)).toBeVisible()
    })
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
