// The element box UI mode draws over a step's screenshot (PILOT-920).
//
// A step the recorder found no element for used to borrow the most recent box
// in the test, so a failed `toBeVisible` on a misspelt text outlined the
// element the passing step before it had checked: the user was pointed at the
// wrong element for the failure. `show-trace` of the same run draws nothing.

import { test, expect } from "../fixtures.js"
import { GESTURES_FILE } from "../messages/scenarios.js"
import { actionCompleted, actionStarted, assertionCompleted, assertionStarted } from "../messages/trace.js"
import { ScreenshotPane } from "../../panes/screenshot.pane.js"
import { solidPng } from "../../png.js"

const DOUBLE_TAP = "Gestures screen > double tap registers double tap gesture"
const TEST_NAME = "double tap registers double tap gesture"
const WELCOME = 'getByText("Welcome to Expo")'
const TYPO = 'getByText("Try editting")'
const WELCOME_BOX = { left: 40, top: 100, right: 320, bottom: 160 }

test.describe("Step element box", () => {
  test.beforeEach(async ({ app, explorer }) => {
    await explorer.expandAll()
    app.send({ type: "run-start", fileCount: 1 })
    app.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
  })

  const shot = () => solidPng(360, 800, [30, 30, 40]).toString("base64")

  test("a failed assertion on another element shows no box", async ({ app, explorer, actions, page }) => {
    const screenshot = new ScreenshotPane(page)
    const passing = { testFullName: DOUBLE_TAP, actionIndex: 0, assertion: "toBeVisible", selector: WELCOME, bounds: WELCOME_BOX, screenshotBefore: shot() }
    const failing = { testFullName: DOUBLE_TAP, actionIndex: 1, assertion: "toBeVisible", selector: TYPO, passed: false, error: "Expected element to be visible", screenshotBefore: shot() }
    app.send(assertionStarted(passing), assertionCompleted(passing))
    app.send(assertionStarted(failing), assertionCompleted(failing))
    app.send({ type: "test-status", fullName: DOUBLE_TAP, filePath: GESTURES_FILE, status: "failed", duration: 900 })
    app.send({ type: "run-end", status: "failed", duration: 900, passed: 0, failed: 1, skipped: 0 })
    await explorer.node(TEST_NAME).click()

    // The passing step shows its own box, so the absence below is the rule
    // working rather than the overlay never rendering.
    await actions.items.nth(0).click()
    await expect(screenshot.image).toBeVisible()
    await expect(screenshot.elementBox).toBeVisible()

    await actions.items.nth(1).click()
    await expect(screenshot.image).toBeVisible()
    await expect(screenshot.elementBox).toHaveCount(0)
  })

  test("an assertion still waiting on another element shows no box", async ({ app, explorer, actions, page }) => {
    const screenshot = new ScreenshotPane(page)
    const passing = { testFullName: DOUBLE_TAP, actionIndex: 0, assertion: "toBeVisible", selector: WELCOME, bounds: WELCOME_BOX, screenshotBefore: shot() }
    const waiting = { testFullName: DOUBLE_TAP, actionIndex: 1, assertion: "toBeVisible", selector: TYPO, screenshotBefore: shot() }
    app.send(assertionStarted(passing), assertionCompleted(passing))
    app.send(assertionStarted(waiting))
    await explorer.node(TEST_NAME).click()

    await actions.items.nth(0).click()
    await expect(screenshot.elementBox).toBeVisible()

    await actions.items.nth(1).click()
    await expect(screenshot.image).toBeVisible()
    await expect(screenshot.elementBox).toHaveCount(0)
  })

  test("a value assertion keeps the box of the element the step before read", async ({ app, explorer, actions, page }) => {
    // const text = await getByText("Welcome to Expo").textContent(); expect(text).toBe(…)
    const screenshot = new ScreenshotPane(page)
    const read = { testFullName: DOUBLE_TAP, actionIndex: 0, action: "textContent", selector: WELCOME, bounds: WELCOME_BOX, screenshotBefore: shot() }
    app.send(actionStarted(read), actionCompleted(read))
    app.send(assertionCompleted({ testFullName: DOUBLE_TAP, actionIndex: 1, assertion: "toBe" }))
    app.send(assertionCompleted({ testFullName: DOUBLE_TAP, actionIndex: 2, assertion: "toContain", passed: false, error: "Expected \"Welcome\" to contain \"Bye\"" }))
    app.send({ type: "test-status", fullName: DOUBLE_TAP, filePath: GESTURES_FILE, status: "failed", duration: 900 })
    app.send({ type: "run-end", status: "failed", duration: 900, passed: 0, failed: 1, skipped: 0 })
    await explorer.node(TEST_NAME).click()

    await actions.items.nth(1).click()
    await expect(screenshot.image).toBeVisible()
    await expect(screenshot.elementBox).toBeVisible()

    // A failed one does not: nothing it checked is on screen to point at.
    await actions.items.nth(2).click()
    await expect(screenshot.image).toBeVisible()
    await expect(screenshot.elementBox).toHaveCount(0)
  })
})
