// The Locator tab's Live source asks the device (PILOT-848): a pick on the
// mirror asks the server which locators find the element, and a typed locator
// is evaluated by the server on the device. Replies are broadcast with the
// request id they answer, so a slow, stale one must never overwrite a newer.

import { test, expect } from "../fixtures.js"
import { screenFrame } from "../messages/frames.js"
import { GESTURES_FILE, idleSeed, singleFileTree } from "../messages/scenarios.js"
import { action, actionCompleted, actionStarted } from "../messages/trace.js"
import { solidPng } from "../../png.js"
import { LocatorPane } from "../../panes/locator.pane.js"
import { ScreenshotPane } from "../../panes/screenshot.pane.js"

const HIERARCHY = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][2000,2000]">
    <node class="android.widget.Button" text="Save" clickable="true" bounds="[0,0][2000,2000]" />
  </node>
</hierarchy>`

// A recorded screen for trace picks: a button filling the middle.
const TRACE_HIERARCHY = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][360,800]">
    <node class="android.widget.Button" text="Tap area" clickable="true" bounds="[20,120][340,320]" />
  </node>
</hierarchy>`

// Web content before and after the WebView DOM overlay arrives.
const WEB_NO_OVERLAY = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.webkit.WebView" bounds="[0,0][2000,2000]" />
</hierarchy>`
const WEB_WITH_OVERLAY = WEB_NO_OVERLAY.replace("</hierarchy>",
  '  <node webview="true" webview-tag="button" text="Go" bounds="[0,0][2000,2000]" />\n</hierarchy>')

test.describe("Live locators come from the device", () => {
  test("a pick asks the device for its locators, and the first one it confirms fills the locator", async ({ app, device, page }) => {
    const ui = app
    const locator = new LocatorPane(page)
    ui.sendFrame(screenFrame(240, 500))
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 7, workerId: 0, deviceIndex: 0 })

    await device.tapMirrorAt(0.5, 0.5)
    const ask = await ui.waitForMessage("suggest-locators")
    expect(ask.revision).toBe(7)
    expect(ask.path.length).toBeGreaterThan(0)
    await expect(locator.suggestionsPending).toBeVisible()

    ui.send({
      type: "locator-suggestions",
      requestId: ask.requestId,
      suggestions: [{ code: 'device.getByRole("button", { name: "Save" })', label: "Role + name" }],
    })
    await expect(locator.optionCodes).toHaveText(['device.getByRole("button", { name: "Save" })'])
    await expect(locator.input).toHaveValue('device.getByRole("button", { name: "Save" })')
    await expect(locator.sourceNote).toContainText("Matched by the device")
  })

  test("a typed locator is evaluated on the device, and only the latest answer counts", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    ui.sendFrame(screenFrame(240, 500))
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 1, workerId: 0, deviceIndex: 0 })
    await device.tapMirrorAt(0.5, 0.5)
    await ui.waitForMessage("suggest-locators")
    await detailTabs.select("Locator")

    ui.clearReceived()
    await locator.type('device.getByText("Sa")')
    const first = await ui.waitForMessage("evaluate-locator")
    await locator.type('device.getByText("Save")')
    let second = await ui.waitForMessage("evaluate-locator")
    for (let i = 0; i < 10 && second.locator !== 'device.getByText("Save")'; i++) {
      ui.clearReceived()
      second = await ui.waitForMessage("evaluate-locator")
    }
    expect(second.locator).toBe('device.getByText("Save")')
    expect(second.requestId).toBeGreaterThan(first.requestId)
    // The server queues each tab's latest request on its own.
    expect(typeof second.clientId).toBe("string")
    expect(second.clientId).toBe(first.clientId)

    // The older request's answer arrives after the newer one's: ignored.
    ui.send({ type: "locator-evaluation", requestId: second.requestId, count: 2, total: 2, positional: false, bounds: [] })
    await expect(locator.matchCount).toHaveText("2 matches")
    ui.send({ type: "locator-evaluation", requestId: first.requestId, count: 9, positional: false, bounds: [] })
    await page.waitForTimeout(300)
    await expect(locator.matchCount).toHaveText("2 matches")
    await expect(locator.strictWarning).toBeVisible()
  })

  test("the device's reason replaces the count when there is no answer", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    ui.sendFrame(screenFrame(240, 500))
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 1, workerId: 0, deviceIndex: 0 })
    await device.tapMirrorAt(0.5, 0.5)
    await ui.waitForMessage("suggest-locators")
    await detailTabs.select("Locator")

    ui.clearReceived()
    await locator.type('device.getByText("x").tap()')
    const ask = await ui.waitForMessage("evaluate-locator")
    ui.send({ type: "locator-evaluation", requestId: ask.requestId, bounds: [], error: 'Invalid locator: "device.getByText("x").tap()": `.tap()` is an action' })
    await expect(locator.error).toContainText("`.tap()` is an action")
    await expect(locator.matchCount).toHaveText("")
  })

  /** Live-pick an element so the Locator tab is bound to the device. */
  async function livePick(ui: Parameters<Parameters<typeof test>[2]>[0]["app"], device: Parameters<Parameters<typeof test>[2]>[0]["device"]) {
    ui.sendFrame(screenFrame(240, 500))
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 1, workerId: 0, deviceIndex: 0 })
    await device.tapMirrorAt(0.5, 0.5)
    return ui.waitForMessage("suggest-locators")
  }

  test("an answer to a locator that was already edited is never shown, even before the new question goes out", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    await livePick(ui, device)
    await detailTabs.select("Locator")
    ui.clearReceived()
    await locator.type('device.getByText("Sa")')
    const old = await ui.waitForMessage("evaluate-locator")
    // Edit, and let the old answer land inside the debounce, before the new
    // evaluate-locator is sent.
    await locator.type('device.getByText("Save")')
    ui.send({ type: "locator-evaluation", requestId: old.requestId, count: 9, positional: false, bounds: [] })
    await expect(locator.matchCount).toHaveText("Checking…")
  })

  test("typing while a pick's locators are on their way keeps what was typed", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    const ask = await livePick(ui, device)
    await detailTabs.select("Locator")
    await locator.type('device.getByTestId("mine")')
    ui.send({
      type: "locator-suggestions",
      requestId: ask.requestId,
      suggestions: [{ code: 'device.getByText("Save")', label: "Text" }],
    })
    await expect(locator.optionCodes).toHaveText(['device.getByText("Save")'])
    await expect(locator.input).toHaveValue('device.getByTestId("mine")')
  })

  test("a screen refresh does not re-ask while the last question is unanswered", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    await livePick(ui, device)
    await detailTabs.select("Locator")
    ui.clearReceived()
    await locator.type('device.getByText("Save")')
    const first = await ui.waitForMessage("evaluate-locator")
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 2, workerId: 0, deviceIndex: 0 })
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 3, workerId: 0, deviceIndex: 0 })
    await page.waitForTimeout(500)
    expect(ui.messagesOfType("evaluate-locator").map((m) => m.requestId)).toEqual([first.requestId])
    // Answered: the next refresh asks again.
    ui.send({ type: "locator-evaluation", requestId: first.requestId, count: 1, total: 1, positional: false, bounds: [] })
    await expect(locator.matchCount).toHaveText("1 match")
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 4, workerId: 0, deviceIndex: 0 })
    await expect.poll(() => ui.messagesOfType("evaluate-locator").length).toBe(2)
  })

  test("switching to the Trace source stops a pending pick from filling the locator", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    const ask = await livePick(ui, device)
    await detailTabs.select("Locator")
    await locator.sourceToggle.getByRole("button", { name: "Trace" }).click()
    ui.send({
      type: "locator-suggestions",
      requestId: ask.requestId,
      suggestions: [{ code: 'device.getByText("Save")', label: "Text" }],
    })
    await page.waitForTimeout(300)
    await expect(locator.input).toHaveValue("")
  })

  test("a disconnect before the device answers a pick says so, and never fills the locator", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    const ask = await livePick(ui, device)
    await detailTabs.select("Locator")
    ui.drop()
    await expect(locator.suggestionsNote).toContainText("Disconnected before the device answered")
    // The lost pick's answer, should it still arrive on the new connection, is ignored.
    await expect.poll(() => ui.connections, { timeout: 5000 }).toBe(2)
    ui.send({
      type: "locator-suggestions",
      requestId: ask.requestId,
      suggestions: [{ code: 'device.getByText("Save")', label: "Text" }],
    })
    await page.waitForTimeout(300)
    await expect(locator.input).toHaveValue("")
  })

  test("a click waiting for the WebView overlay is dropped on switching to the Trace source", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    ui.sendFrame(screenFrame(240, 500))
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
    ui.send({ type: "hierarchy-update", xml: WEB_NO_OVERLAY, revision: 1, workerId: 0, deviceIndex: 0 })
    ui.clearReceived()
    // On web content with no overlay yet: the click waits for it.
    await device.tapMirrorAt(0.5, 0.5)
    await detailTabs.select("Locator")
    await locator.sourceToggle.getByRole("button", { name: "Trace" }).click()
    await locator.type('device.getByText("mine")')
    // The overlay lands: the dropped click must not resolve now.
    ui.send({ type: "hierarchy-update", xml: WEB_WITH_OVERLAY, revision: 2, workerId: 0, deviceIndex: 0 })
    await page.waitForTimeout(500)
    expect(ui.messagesOfType("suggest-locators")).toEqual([])
    await expect(locator.input).toHaveValue('device.getByText("mine")')
  })

  test("typing drops a click still waiting for the WebView overlay", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    ui.sendFrame(screenFrame(240, 500))
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
    ui.send({ type: "hierarchy-update", xml: WEB_NO_OVERLAY, revision: 1, workerId: 0, deviceIndex: 0 })
    ui.clearReceived()
    await device.tapMirrorAt(0.5, 0.5)
    await detailTabs.select("Locator")
    await locator.type('device.getByText("mine")')
    ui.send({ type: "hierarchy-update", xml: WEB_WITH_OVERLAY, revision: 2, workerId: 0, deviceIndex: 0 })
    await page.waitForTimeout(500)
    expect(ui.messagesOfType("suggest-locators")).toEqual([])
    await expect(locator.input).toHaveValue('device.getByText("mine")')
  })

  test("a pick on the mirror binds the Locator tab to the device, even after a switch to Trace", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    ui.sendFrame(screenFrame(240, 500))
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 1, workerId: 0, deviceIndex: 0 })
    await detailTabs.select("Locator")
    // The picker stays armed while the source goes to Trace.
    await locator.sourceToggle.getByRole("button", { name: "Trace" }).click()
    await device.tapMirrorAt(0.5, 0.5)
    const ask = await ui.waitForMessage("suggest-locators")
    ui.send({
      type: "locator-suggestions",
      requestId: ask.requestId,
      suggestions: [{ code: 'device.getByText("Save")', label: "Text" }],
    })
    await expect(locator.input).toHaveValue('device.getByText("Save")')
    await expect(locator.sourceNote).toContainText("Matched by the device")
  })

  test("hovering an action on the way past keeps a pick waiting for the device", async ({ app, device, page, detailTabs, explorer, actions }) => {
    const ui = app
    const locator = new LocatorPane(page)
    const DOUBLE_TAP = "Gestures screen > double tap registers double tap gesture"
    await explorer.expandAll()
    ui.send({ type: "run-start", fileCount: 1 })
    ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
    ui.send(
      ...action({ testFullName: DOUBLE_TAP, actionIndex: 0, action: "tap", selector: "getByRole('button')" }),
      ...action({ testFullName: DOUBLE_TAP, actionIndex: 1, action: "doubleTap", selector: "getByTestId('tap-area')" }),
    )
    ui.send({ type: "test-status", fullName: DOUBLE_TAP, filePath: GESTURES_FILE, status: "passed", duration: 900 })
    ui.send({ type: "run-end", status: "passed", duration: 900, passed: 1, failed: 0, skipped: 0 })
    await explorer.node("double tap registers double tap gesture").click()
    await expect(actions.items).toHaveCount(2)

    const ask = await livePick(ui, device)
    await detailTabs.select("Locator")
    await actions.items.nth(0).hover()
    await actions.items.nth(1).hover()
    await locator.input.hover()
    ui.send({
      type: "locator-suggestions",
      requestId: ask.requestId,
      suggestions: [{ code: 'device.getByText("Save")', label: "Text" }],
    })
    await expect(locator.input).toHaveValue('device.getByText("Save")')
  })

  test("choosing the action already pinned re-binds the tab to the trace and drops a pick waiting for the device", async ({ app, device, page, detailTabs, explorer, actions }) => {
    const ui = app
    const locator = new LocatorPane(page)
    const DOUBLE_TAP = "Gestures screen > double tap registers double tap gesture"
    await explorer.expandAll()
    ui.send({ type: "run-start", fileCount: 1 })
    ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
    ui.send(
      ...action({ testFullName: DOUBLE_TAP, actionIndex: 0, action: "tap", selector: "getByRole('button')" }),
      ...action({ testFullName: DOUBLE_TAP, actionIndex: 1, action: "doubleTap", selector: "getByTestId('tap-area')" }),
    )
    ui.send({ type: "test-status", fullName: DOUBLE_TAP, filePath: GESTURES_FILE, status: "passed", duration: 900 })
    ui.send({ type: "run-end", status: "passed", duration: 900, passed: 1, failed: 0, skipped: 0 })
    await explorer.node("double tap registers double tap gesture").click()
    await expect(actions.items).toHaveCount(2)
    await actions.items.nth(1).click()

    const ask = await livePick(ui, device)
    await detailTabs.select("Locator")
    await actions.items.nth(1).click()
    ui.send({
      type: "locator-suggestions",
      requestId: ask.requestId,
      suggestions: [{ code: 'device.getByText("Save")', label: "Text" }],
    })
    await page.waitForTimeout(300)
    await expect(locator.input).toHaveValue("")
    await expect(locator.sourceNote).toContainText("recorded hierarchy")
  })

  test("a first pick's late answer never replaces a second pick's", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    const first = await livePick(ui, device)
    await detailTabs.select("Locator")
    ui.clearReceived()
    await device.enablePickMode()
    await device.tapMirrorAt(0.5, 0.5)
    const second = await ui.waitForMessage("suggest-locators")
    expect(second.requestId).not.toBe(first.requestId)
    ui.send({ type: "locator-suggestions", requestId: second.requestId, suggestions: [{ code: 'device.getByText("Save")', label: "Text" }] })
    await expect(locator.input).toHaveValue('device.getByText("Save")')
    ui.send({ type: "locator-suggestions", requestId: first.requestId, suggestions: [{ code: 'device.getByRole("button")', label: "Role" }] })
    await page.waitForTimeout(300)
    await expect(locator.optionCodes).toHaveText(['device.getByText("Save")'])
    await expect(locator.input).toHaveValue('device.getByText("Save")')
  })

  test("a node picked on the trace shows no device answers on the Live source, only a hint to pick on the mirror", async ({ app, device, page, detailTabs, explorer, actions }) => {
    // Live suggestions belong to the element picked on the device; a trace
    // pick's TypeScript-ranked suggestions must never pass for them.
    const ui = app
    const locator = new LocatorPane(page)
    const DOUBLE_TAP = "Gestures screen > double tap registers double tap gesture"
    const screen = { width: 360, height: 800 }
    const traced = { testFullName: DOUBLE_TAP, actionIndex: 0, action: "tap", selector: "getByText('Save')" }
    const png = solidPng(screen.width, screen.height, [30, 30, 40]).toString("base64")
    const withTree = (m: ReturnType<typeof actionCompleted>) => ({
      ...m,
      event: { ...m.event, hasScreenshotAfter: true, hasHierarchyAfter: true },
      screenshotAfter: png,
      hierarchyAfter: TRACE_HIERARCHY,
    })
    await explorer.expandAll()
    ui.send({ type: "run-start", fileCount: 1 })
    ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
    ui.send(actionStarted(traced), withTree(actionCompleted(traced)))
    ui.send({ type: "test-status", fullName: DOUBLE_TAP, filePath: GESTURES_FILE, status: "passed", duration: 900 })
    ui.send({ type: "run-end", status: "passed", duration: 900, passed: 1, failed: 0, skipped: 0 })
    await explorer.node("double tap registers double tap gesture").click()
    await actions.items.nth(0).click()
    await detailTabs.select("Locator")

    await page.getByRole("button", { name: "Pick", exact: true }).click()
    const image = new ScreenshotPane(page).image
    const box = (await image.boundingBox())!
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * (220 / screen.height))
    await expect(locator.input).toHaveValue(/Tap area/)
    await expect(locator.options.first()).toBeVisible()

    ui.sendFrame(screenFrame(240, 500))
    await locator.sourceToggle.getByRole("button", { name: "Live" }).click()
    await expect(locator.livePickHint).toBeVisible()
    await expect(locator.options).toHaveCount(0)
  })

  test("a device's refusal is asked again on the next screen refresh", async ({ app, device, page, detailTabs }) => {
    // "Reading the screen…" (no capture yet) and "No WebView on screen."
    // are answers too: the next capture must re-ask, or the tab sticks.
    const ui = app
    const locator = new LocatorPane(page)
    await livePick(ui, device)
    await detailTabs.select("Locator")
    ui.clearReceived()
    await locator.type('webview.getByText("Go")')
    const first = await ui.waitForMessage("evaluate-locator")
    ui.send({ type: "locator-evaluation", requestId: first.requestId, bounds: [], error: "Reading the screen…" })
    await expect(locator.error).toContainText("Reading the screen")
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 2, workerId: 0, deviceIndex: 0 })
    await expect.poll(() => ui.messagesOfType("evaluate-locator").length).toBe(2)
  })

  test("a pick on an Android mirror maps the pointer in pixels, whatever an iOS worker's ratio is", async ({ ui, device }) => {
    // Mixed session: the iPhone reports a ratio of 3 (also as the session's
    // device-info); the Android worker reports none, as its frames and
    // hierarchy share pixels. Its pick must not use the iPhone's 3.
    ui.seed([
      ...idleSeed(singleFileTree()),
      {
        type: "workers-info",
        workers: [
          { workerId: 0, deviceSerial: "emulator-5560", displayName: "Pixel_A", platform: "android" },
          { workerId: 1, deviceSerial: "SIM-1", displayName: "iPhone_B", platform: "ios", devicePixelRatio: 3 },
        ],
      },
      { type: "device-info", serial: "iPhone_B", isEmulator: true, platform: "ios", devicePixelRatio: 3 },
    ])
    await ui.open()
    await device.selectWorkerView("Pixel_A")
    ui.sendFrame({ ...screenFrame(240, 500), workerId: 0 })
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
    ui.send({
      type: "hierarchy-update",
      workerId: 0,
      deviceIndex: 0,
      revision: 1,
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][240,500]">
    <node class="android.widget.Button" text="Top" bounds="[0,0][100,150]" />
    <node class="android.widget.Button" text="Bottom" bounds="[100,200][240,500]" />
  </node>
</hierarchy>`,
    })
    ui.clearReceived()
    // (180, 350) in pixels: inside Bottom. Read at a ratio of 3 it would be
    // (60, 117), inside Top.
    await device.tapMirrorAt(0.75, 0.7)
    const ask = await ui.waitForMessage("suggest-locators")
    expect(ask.workerId).toBe(0)
    expect(ask.path).toEqual([0, 0, 1]) // hierarchy > FrameLayout > Bottom (Top would be [0, 0, 0])
  })

  test("hovering an unnamed row outlines the element a click there picks, not the row", async ({ app, device, page }) => {
    // A click on an unnamed container picks the named element inside it, so
    // the hover must show that element, or the pick looks like it shrank.
    const ui = app
    ui.sendFrame(screenFrame(240, 500))
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
    ui.send({
      type: "hierarchy-update", workerId: 0, deviceIndex: 0, revision: 1,
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.view.ViewGroup" bounds="[0,0][240,100]">
    <node class="android.widget.TextView" text="Notifications" bounds="[10,10][60,40]" />
  </node>
</hierarchy>`,
    })
    const canvas = (await device.canvas.boundingBox())!
    // (150, 50) in pixels: inside the row, away from its text.
    await page.mouse.move(canvas.x + canvas.width * (150 / 240), canvas.y + canvas.height * (50 / 500))
    await expect(device.pickHover).toBeVisible()
    const hover = (await device.pickHover.boundingBox())!
    expect(hover.width).toBeCloseTo(canvas.width * (50 / 240), 0)
    expect(hover.height).toBeCloseTo(canvas.height * (30 / 500), 0)
  })
})
