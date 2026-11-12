// The live picker and the Locator tab's live checks leave a device alone while
// a test runs on it (PILOT-1179). Picking never taps, but it polls the
// hierarchy every second and asks the device about locators: on the agent the
// test is driving, that competes with the test. They follow the mirror lock,
// and the lock follows the mirrored device, not the worker selected elsewhere.

import { test, expect } from "../fixtures.js"
import { screenFrame } from "../messages/frames.js"
import { GESTURES_FILE, idleSeed, singleFileTree } from "../messages/scenarios.js"
import { actionCompleted, actionStarted } from "../messages/trace.js"
import { solidPng } from "../../png.js"
import { LocatorPane } from "../../panes/locator.pane.js"
import { ScreenshotPane } from "../../panes/screenshot.pane.js"
import type { ServerMessage } from "../../protocol.js"

const HIERARCHY = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][2000,2000]">
    <node class="android.widget.Button" text="Save" clickable="true" bounds="[0,0][2000,2000]" />
  </node>
</hierarchy>`

const TRACE_HIERARCHY = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][360,800]">
    <node class="android.widget.Button" text="Tap area" clickable="true" bounds="[20,120][340,320]" />
  </node>
</hierarchy>`

const RUN_STARTED: ServerMessage = { type: "run-state", isRunning: true }
const RUN_ENDED: ServerMessage = { type: "run-state", isRunning: false }

/** Longer than the one-second hierarchy poll, so a poll that should not happen would. */
const QUIET_MS = 1500

test.describe("The live picker while a test runs", () => {
  test("is disabled and says why while a test runs, and comes back when it ends", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(240, 500))
    await expect(device.pickToggle).toBeEnabled()

    ui.send(RUN_STARTED)
    await expect(device.lockToggle).toHaveAccessibleName(/^Interaction locked/)
    await expect(device.pickToggle).toBeDisabled()
    await expect(device.pickToggle).toHaveAccessibleDescription(/Locked while a test runs on this device/)

    ui.send(RUN_ENDED)
    await expect(device.pickToggle).toBeEnabled()
    await expect(device.pickToggle).toHaveAccessibleDescription("Pick an element to get a locator")
  })

  test("a run that starts with the picker armed cancels the pick and stops polling", async ({ app, device, page }) => {
    const ui = app
    ui.sendFrame(screenFrame(240, 500))
    await device.enablePickMode()
    await expect(device.pickToggle).toHaveAccessibleName(/^Picking element/)
    await ui.waitForMessage("request-hierarchy")

    ui.send(RUN_STARTED)
    await expect(device.pickToggle).toHaveAccessibleName(/^Pick an element/)
    await expect(device.pickToggle).toBeDisabled()
    ui.clearReceived()
    await page.waitForTimeout(QUIET_MS)
    expect(ui.messagesOfType("request-hierarchy")).toEqual([])
  })

  test("a pick still being checked when the run starts is dropped, says so, and the server is told", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    ui.sendFrame(screenFrame(240, 500))
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 1, workerId: 0, deviceIndex: 0 })
    await device.tapMirrorAt(0.5, 0.5)
    const ask = await ui.waitForMessage("suggest-locators")
    await detailTabs.select("Locator")
    await expect(locator.suggestionsPending).toBeVisible()

    ui.send(RUN_STARTED)
    await expect(locator.suggestionsNote).toContainText("A test started on this device")
    await expect(locator.suggestionsPending).toHaveCount(0)
    const cancel = await ui.waitForMessage("cancel-live-locators")
    expect(cancel.clientId).toBe(ask.clientId)
    expect(cancel.workerId).toBe(0)
    expect(cancel.deviceIndex).toBe(0)

    // Its answer, should it still arrive, never fills the locator.
    ui.send({
      type: "locator-suggestions",
      requestId: ask.requestId,
      suggestions: [{ code: 'device.getByText("Save")', label: "Text" }],
    })
    await page.waitForTimeout(300)
    await expect(locator.input).toHaveValue("")
  })

  test("an evaluation still out when the run starts is cancelled; a tab with nothing out sends nothing", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    ui.sendFrame(screenFrame(240, 500))
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 1, workerId: 0, deviceIndex: 0 })
    await device.tapMirrorAt(0.5, 0.5)
    const pick = await ui.waitForMessage("suggest-locators")
    ui.send({ type: "locator-suggestions", requestId: pick.requestId, suggestions: [] })
    await detailTabs.select("Locator")
    await locator.type('device.getByText("Save")')
    const ask = await ui.waitForMessage("evaluate-locator")

    ui.send(RUN_STARTED)
    const cancel = await ui.waitForMessage("cancel-live-locators")
    expect(cancel.clientId).toBe(ask.clientId)
    // The late answer is not shown as the paused tab's count.
    ui.send({ type: "locator-evaluation", requestId: ask.requestId, count: 3, total: 3, positional: false, bounds: [] })
    await page.waitForTimeout(300)
    await expect(locator.matchCount).toHaveText("")

    // The next run, with nothing out, cancels nothing.
    ui.clearReceived()
    ui.send(RUN_ENDED)
    const resumed = await ui.waitForMessage("evaluate-locator")
    ui.send({ type: "locator-evaluation", requestId: resumed.requestId, count: 1, total: 1, positional: false, bounds: [] })
    await expect(locator.matchCount).toHaveText("1 match")
    ui.clearReceived()
    ui.send(RUN_STARTED)
    await expect(locator.sourceNote).toContainText("Paused while a test runs on this device")
    await page.waitForTimeout(300)
    expect(ui.messagesOfType("cancel-live-locators")).toEqual([])
  })

  test("the Locator tab's live checks pause during a run and resume after it", async ({ app, device, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    ui.sendFrame(screenFrame(240, 500))
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 1, workerId: 0, deviceIndex: 0 })
    await device.tapMirrorAt(0.5, 0.5)
    await ui.waitForMessage("suggest-locators")
    await detailTabs.select("Locator")
    await locator.type('device.getByText("Save")')
    const ask = await ui.waitForMessage("evaluate-locator")
    ui.send({ type: "locator-evaluation", requestId: ask.requestId, count: 1, total: 1, positional: false, bounds: [] })
    await expect(locator.matchCount).toHaveText("1 match")

    ui.send(RUN_STARTED)
    await expect(locator.sourceNote).toContainText("Paused while a test runs on this device")
    await expect(locator.matchCount).toHaveText("")
    ui.clearReceived()
    // A refresh already on its way is not followed up either.
    ui.send({ type: "hierarchy-update", xml: HIERARCHY, revision: 2, workerId: 0, deviceIndex: 0 })
    await locator.type('device.getByText("Sav")')
    await page.waitForTimeout(QUIET_MS)
    expect(ui.messagesOfType("request-hierarchy")).toEqual([])
    expect(ui.messagesOfType("evaluate-locator")).toEqual([])
    expect(ui.messagesOfType("suggest-locators")).toEqual([])

    ui.send(RUN_ENDED)
    await expect(locator.sourceNote).toContainText("Matched by the device")
    const resumed = await ui.waitForMessage("evaluate-locator")
    expect(resumed.locator).toBe('device.getByText("Sav")')
    await ui.waitForMessage("request-hierarchy")
  })

  test("switching the Locator tab to Live during a run asks the device nothing", async ({ app, page, detailTabs }) => {
    const ui = app
    const locator = new LocatorPane(page)
    ui.sendFrame(screenFrame(240, 500))
    ui.send(RUN_STARTED)
    await detailTabs.select("Locator")
    await locator.type('device.getByText("Save")')
    ui.clearReceived()
    await locator.sourceToggle.getByRole("button", { name: "Live" }).click()
    await expect(locator.sourceNote).toContainText("Paused while a test runs on this device")
    await page.waitForTimeout(QUIET_MS)
    expect(ui.messagesOfType("request-hierarchy")).toEqual([])
    expect(ui.messagesOfType("evaluate-locator")).toEqual([])
  })

  test("unlocking during a run opts back in to picking", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(240, 500))
    ui.send(RUN_STARTED)
    await expect(device.pickToggle).toBeDisabled()

    await device.lockToggle.click()
    await expect(device.lockToggle).toHaveAccessibleName(/^Interaction unlocked/)
    await expect(device.pickToggle).toBeEnabled()
    ui.clearReceived()
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
  })

  test("picking from the trace's screenshot stays available during a run, and asks the device nothing", async ({ app, device, page, detailTabs, explorer, actions }) => {
    const ui = app
    const locator = new LocatorPane(page)
    const DOUBLE_TAP = "Gestures screen > double tap registers double tap gesture"
    const screen = { width: 360, height: 800 }
    const traced = { testFullName: DOUBLE_TAP, actionIndex: 0, action: "tap", selector: "getByText('Save')" }
    const withTree = (m: ReturnType<typeof actionCompleted>) => ({
      ...m,
      event: { ...m.event, hasScreenshotAfter: true, hasHierarchyAfter: true },
      screenshotAfter: solidPng(screen.width, screen.height, [30, 30, 40]).toString("base64"),
      hierarchyAfter: TRACE_HIERARCHY,
    })
    ui.sendFrame(screenFrame(240, 500))
    await explorer.expandAll()
    ui.send({ type: "run-start", fileCount: 1 }, RUN_STARTED)
    ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
    ui.send(actionStarted(traced), withTree(actionCompleted(traced)))
    await expect(device.pickToggle).toBeDisabled()
    await explorer.node("double tap registers double tap gesture").click()
    await actions.items.nth(0).click()
    await detailTabs.select("Locator")
    ui.clearReceived()

    await page.getByRole("button", { name: "Pick", exact: true }).click()
    const box = (await new ScreenshotPane(page).image.boundingBox())!
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * (220 / screen.height))
    await expect(locator.input).toHaveValue(/Tap area/)
    await page.waitForTimeout(QUIET_MS)
    expect(ui.messagesOfType("request-hierarchy")).toEqual([])
    expect(ui.messagesOfType("suggest-locators")).toEqual([])
    expect(ui.messagesOfType("evaluate-locator")).toEqual([])
  })

  test("an explicit lock with no test running leaves picking available", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(240, 500))
    await device.lockToggle.click()
    await expect(device.lockToggle).toHaveAccessibleName(/^Interaction locked/)
    // Picking is read-only; the lock is about taps.
    await expect(device.pickToggle).toBeEnabled()
  })
})

// ─── Several workers ───

const WORKERS: ServerMessage = {
  type: "workers-info",
  workers: [
    { workerId: 0, deviceSerial: "emulator-5554", displayName: "emulator-5554", platform: "android" },
    { workerId: 1, deviceSerial: "emulator-5556", displayName: "emulator-5556", platform: "android" },
  ],
}

function workerStatus(workerId: number, status: "idle" | "running" | "done"): ServerMessage {
  return {
    type: "worker-status",
    workerId,
    deviceSerial: workerId === 0 ? "emulator-5554" : "emulator-5556",
    status,
    passed: 0,
    failed: 0,
    skipped: 0,
  }
}

test.describe("The lock and picker with several workers", () => {
  test("follow the mirrored device, not another worker's run", async ({ ui, device }) => {
    ui.seed([...idleSeed(singleFileTree()), WORKERS])
    await ui.open()
    await device.selectWorkerView("emulator-5554")
    await expect(device.mirrorStatus).toHaveText("Starting mirror…")
    ui.sendFrame({ ...screenFrame(120, 260), workerId: 0 })
    await expect(device.pickToggle).toBeEnabled()

    // The session is running, but on the other device.
    ui.send(RUN_STARTED, workerStatus(1, "running"))
    await expect(device.workerTab("emulator-5556")).toHaveAttribute("title", /running/)
    await expect(device.pickToggle).toBeEnabled()
    await expect(device.lockToggle).toHaveAccessibleName(/^Interaction unlocked/)

    ui.send(workerStatus(0, "running"))
    await expect(device.pickToggle).toBeDisabled()
    await expect(device.lockToggle).toHaveAccessibleName(/^Interaction locked/)

    ui.send(workerStatus(0, "done"))
    await expect(device.pickToggle).toBeEnabled()
    await expect(device.lockToggle).toHaveAccessibleName(/^Interaction unlocked/)
  })

  test("a mirror reopened on another device's tab follows that device, not worker 0", async ({ ui, device, page }) => {
    // The device view is remembered across reloads (per tab), while the selected worker
    // starts at 0: the mirror shows worker 1 but worker 0 is "selected".
    await page.addInitScript(() => sessionStorage.setItem("tapsmith-device-view", "1"))
    ui.seed([...idleSeed(singleFileTree()), WORKERS])
    await ui.open()
    await expect(device.workerTab("emulator-5556")).toHaveAttribute("aria-selected", "true")
    ui.sendFrame({ ...screenFrame(120, 260), workerId: 1 })
    ui.send(RUN_STARTED, workerStatus(0, "running"))
    await expect(device.workerTab("emulator-5554")).toHaveAttribute("title", /running/)
    await expect(device.lockToggle).toHaveAccessibleName(/^Interaction unlocked/)
    await expect(device.pickToggle).toBeEnabled()

    ui.send(workerStatus(1, "running"))
    await expect(device.lockToggle).toHaveAccessibleName(/^Interaction locked/)
    await expect(device.pickToggle).toBeDisabled()
  })

  test("in the All view, only the device running a test is locked", async ({ ui, device, page }) => {
    ui.seed([...idleSeed(singleFileTree()), WORKERS])
    await ui.open()
    await device.selectWorkerView("All")
    ui.sendFrame({ ...screenFrame(120, 260), workerId: 0 })
    ui.sendFrame({ ...screenFrame(120, 260), workerId: 1 })
    await expect(device.mirrorFor("emulator-5556")).toHaveAttribute("width", "120")

    ui.send(RUN_STARTED, workerStatus(1, "running"))
    await expect(device.lockToggle).toHaveAccessibleName(/^Interaction locked/)
    ui.clearReceived()

    await device.mirrorFor("emulator-5556").click()
    await device.mirrorFor("emulator-5554").click()
    const tap = await ui.waitForMessage("mirror-tap")
    expect(tap.workerId).toBe(0)
    await page.waitForTimeout(300)
    expect(ui.messagesOfType("mirror-tap").map((m) => m.workerId)).toEqual([0])
  })
})
