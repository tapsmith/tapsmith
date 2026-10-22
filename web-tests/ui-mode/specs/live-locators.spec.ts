// The Locator tab's Live source asks the device (PILOT-848): a pick on the
// mirror asks the server which locators find the element, and a typed locator
// is evaluated by the server on the device. Replies are broadcast with the
// request id they answer, so a slow, stale one must never overwrite a newer.

import { test, expect } from "../fixtures.js"
import { screenFrame } from "../messages/frames.js"
import { LocatorPane } from "../../panes/locator.pane.js"

const HIERARCHY = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][2000,2000]">
    <node class="android.widget.Button" text="Save" clickable="true" bounds="[0,0][2000,2000]" />
  </node>
</hierarchy>`

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
    await expect(page.getByTestId("locator-suggestions-pending")).toBeVisible()

    ui.send({
      type: "locator-suggestions",
      requestId: ask.requestId,
      suggestions: [{ code: 'device.getByRole("button", { name: "Save" })', label: "Role + name" }],
    })
    await expect(locator.optionCodes).toHaveText(['device.getByRole("button", { name: "Save" })'])
    await expect(locator.input).toHaveValue('device.getByRole("button", { name: "Save" })')
    await expect(page.getByTestId("locator-source-note")).toContainText("Matched by the device")
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

    // The older request's answer arrives late: ignored.
    ui.send({ type: "locator-evaluation", requestId: first.requestId, count: 9, positional: false, bounds: [] })
    ui.send({ type: "locator-evaluation", requestId: second.requestId, count: 2, total: 2, positional: false, bounds: [] })
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
})
