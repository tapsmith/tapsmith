// The action list must stay put under the pointer while tests run.
//
// The list used to scroll the *hovered* row into view, and UI mode cleared the
// hover on every streamed row of a test the user had clicked. Together, hovering
// or scrolling the list mid-run jumped it: each new action snapped the
// selection to the newest row and scrolled there, which slid another row under
// the still pointer, which hovered and scrolled again. Leaving the list (or
// crossing a group header) snapped it back to the pinned row too.

import { test, expect } from "../fixtures.js"
import { GESTURES_FILE, HOME_FILE, idleSeed, twoProjectTree } from "../messages/scenarios.js"
import { action, actionStarted, group } from "../messages/trace.js"
import type { Page } from "@playwright/test"
import type { UiHarness } from "../fixtures.js"

const DOUBLE_TAP = "Gestures screen > double tap registers double tap gesture"
const DOUBLE_TAP_NAME = "double tap registers double tap gesture"
const LONG_PRESS = "Gestures screen > long press registers long press"

function sendActions(ui: UiHarness, testFullName: string, from: number, to: number, projectName?: string) {
  for (let i = from; i < to; i++) {
    ui.send(...action({ testFullName, actionIndex: i, action: "tap", selector: `getByText("row ${i}")`, projectName }))
  }
}

/**
 * Scroll the list to the top once the auto-follow to the newest row has
 * finished — setting scrollTop mid smooth-scroll is overridden by it.
 */
async function scrollToTop(list: ReturnType<Page["getByTestId"]>) {
  await expect(list.getByTestId("action-item").last()).toBeInViewport()
  await expect(async () => {
    await list.evaluate((el) => { el.scrollTop = 0 })
    await new Promise((r) => setTimeout(r, 100))
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0)
  }).toPass()
}

/** Rest the pointer on a row near the top of the list. */
async function hoverNearTop(page: Page, list: ReturnType<Page["getByTestId"]>) {
  const box = await list.boundingBox()
  if (!box) throw new Error("action list has no box")
  await page.mouse.move(box.x + 40, box.y + 80)
}

test.describe("Action list scrolling", () => {
  test.beforeEach(async ({ app, explorer }) => {
    await explorer.expandAll()
    app.send({ type: "run-start", fileCount: 1 })
  })

  test("streaming rows of the viewed test do not scroll the list from under the pointer", async ({
    app, explorer, actions, page,
  }) => {
    app.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
    await explorer.node(DOUBLE_TAP_NAME).click()
    sendActions(app, DOUBLE_TAP, 0, 40)
    await expect(actions.items).toHaveCount(40)

    await scrollToTop(actions.list)
    await hoverNearTop(page, actions.list)
    const hovered = await actions.selectedItem.textContent()

    sendActions(app, DOUBLE_TAP, 40, 44)
    app.send(actionStarted({ testFullName: DOUBLE_TAP, actionIndex: 44, action: "tap", selector: "x" }))
    await expect(actions.items).toHaveCount(45)
    // Long enough for a smooth scroll to have moved the list, had one started.
    await page.waitForTimeout(500)

    expect(await actions.list.evaluate((el) => el.scrollTop)).toBe(0)
    await expect(actions.selectedItem).toHaveText(hovered!)
  })

  test("streaming rows do not scroll the list from under a pointer resting on a group header", async ({
    app, explorer, actions, page,
  }) => {
    app.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
    await explorer.node(DOUBLE_TAP_NAME).click()
    app.send(group({ testFullName: DOUBLE_TAP, type: "group-start", name: "Test", actionIndex: 0 }))
    sendActions(app, DOUBLE_TAP, 0, 40)
    await expect(actions.items).toHaveCount(40)

    await scrollToTop(actions.list)
    await actions.groups.first().hover()

    sendActions(app, DOUBLE_TAP, 40, 44)
    app.send(actionStarted({ testFullName: DOUBLE_TAP, actionIndex: 44, action: "tap", selector: "x" }))
    await expect(actions.items).toHaveCount(45)
    await page.waitForTimeout(500)

    expect(await actions.list.evaluate((el) => el.scrollTop)).toBe(0)
  })

  test("leaving the list does not snap it back to the pinned row", async ({
    app, explorer, actions, page,
  }) => {
    app.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
    app.send(group({ testFullName: DOUBLE_TAP, type: "group-start", name: "Test", actionIndex: 0 }))
    sendActions(app, DOUBLE_TAP, 0, 40)
    app.send(group({ testFullName: DOUBLE_TAP, type: "group-end", name: "Test", actionIndex: 40 }))
    app.send({ type: "test-status", fullName: DOUBLE_TAP, filePath: GESTURES_FILE, status: "passed", duration: 900 })
    await explorer.node(DOUBLE_TAP_NAME).click()
    await expect(actions.items).toHaveCount(40)

    await scrollToTop(actions.list)
    await hoverNearTop(page, actions.list)
    // Another test streaming meanwhile must not disturb the viewed one either.
    app.send({ type: "test-start", fullName: LONG_PRESS, filePath: GESTURES_FILE })
    sendActions(app, LONG_PRESS, 0, 5)
    // Onto the group header (no row hovered), then off the list entirely.
    await actions.groups.first().hover()
    await page.mouse.move(1, 1)
    await page.waitForTimeout(500)

    expect(await actions.list.evaluate((el) => el.scrollTop)).toBe(0)
  })

  test("still follows the newest row when the pointer is elsewhere", async ({
    app, explorer, actions, page,
  }) => {
    app.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
    await explorer.node(DOUBLE_TAP_NAME).click()
    await page.mouse.move(1, 1)
    sendActions(app, DOUBLE_TAP, 0, 40)
    // Live, the next step's start lands in its own render after the last
    // completion; sent in one burst, the two would batch into one.
    await expect(actions.items).toHaveCount(40)
    app.send(actionStarted({ testFullName: DOUBLE_TAP, actionIndex: 40, action: "tap", selector: "x" }))

    await expect(actions.inProgressItems).toBeInViewport()
  })

  test.describe("a run of another file", () => {
    // Run-start pins the viewed test to its first row; the run end must catch
    // it back up to its last action, as viewing a finished test always shows.
    test.beforeEach(async ({ app, explorer, actions }) => {
      app.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
      sendActions(app, DOUBLE_TAP, 0, 10)
      app.send({ type: "test-status", fullName: DOUBLE_TAP, filePath: GESTURES_FILE, status: "passed", duration: 900 })
      app.send({ type: "run-end", status: "passed", duration: 900, passed: 1, failed: 0, skipped: 0 })
      await explorer.node(DOUBLE_TAP_NAME).click()
      await expect(actions.selectedItem).toContainText("row 9")

      app.send({ type: "run-start", fileCount: 1, filePath: HOME_FILE })
      await expect(actions.selectedItem).toContainText("row 0")
    })

    test("leaves the viewed test on its last action when it ends", async ({ app, actions }) => {
      app.send({ type: "run-end", status: "passed", duration: 900, passed: 1, failed: 0, skipped: 0 })
      await expect(actions.selectedItem).toContainText("row 9")
    })

    test("keeps an action the user picked during the run", async ({ app, actions, page }) => {
      await actions.item("row 4").click()
      await page.mouse.move(1, 1)
      await expect(actions.selectedItem).toContainText("row 4")
      app.send({ type: "run-end", status: "passed", duration: 900, passed: 1, failed: 0, skipped: 0 })
      await page.waitForTimeout(300)
      await expect(actions.selectedItem).toContainText("row 4")
    })
  })

  test("holds an action picked in a running test until its newest row is picked", async ({
    app, explorer, actions, page,
  }) => {
    app.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
    await explorer.node(DOUBLE_TAP_NAME).click()
    sendActions(app, DOUBLE_TAP, 0, 10)
    await expect(actions.selectedItem).toContainText("row 9")

    await actions.item("row 4").click()
    await page.mouse.move(1, 1)
    sendActions(app, DOUBLE_TAP, 10, 12)
    app.send(actionStarted({ testFullName: DOUBLE_TAP, actionIndex: 12, action: "tap", selector: "x" }))
    await expect(actions.inProgressItems).toHaveCount(1)
    await page.waitForTimeout(300)
    await expect(actions.selectedItem).toContainText("row 4")

    // Picking the newest row resumes following.
    await actions.inProgressItems.click()
    await page.mouse.move(1, 1)
    sendActions(app, DOUBLE_TAP, 12, 14)
    await expect(actions.selectedItem).toContainText("row 13")
  })
})

test.describe("Action list scrolling across projects", () => {
  test("switching to the same test in another project scrolls to its pinned row", async ({
    ui, explorer, actions,
  }) => {
    ui.seed(idleSeed(twoProjectTree()))
    await ui.open()
    await explorer.expandAll()
    ui.send({ type: "run-start", fileCount: 2 })
    for (const projectName of ["android", "ios"]) {
      ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE, projectName })
      sendActions(ui, DOUBLE_TAP, 0, 40, projectName)
      ui.send({ type: "test-status", fullName: DOUBLE_TAP, filePath: GESTURES_FILE, status: "passed", duration: 900, projectName })
    }
    ui.send({ type: "run-end", status: "passed", duration: 900, passed: 2, failed: 0, skipped: 0 })

    const copies = explorer.node(DOUBLE_TAP_NAME)
    await expect(copies).toHaveCount(2)
    await copies.first().click()
    await expect(actions.items).toHaveCount(40)
    await scrollToTop(actions.list)

    await copies.last().click()
    await expect(actions.selectedItem).toContainText("row 39")
    await expect(actions.selectedItem).toBeInViewport()
  })
})
