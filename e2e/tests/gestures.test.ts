import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

describe("Gestures screen", () => {
  test.beforeEach(async ({ device, gesturesScreen }) => {
    await openScreen(device, "/gestures")
    await expect(gesturesScreen.heading).toBeVisible()
  })

  test("shows heading and initial state", async ({ gesturesScreen }) => {
    await expect(gesturesScreen.heading).toBeVisible()
    await expect(gesturesScreen.lastGesture).toHaveText("Last gesture: None")
    await expect(gesturesScreen.tapCount).toHaveText("Tap count: 0")
  })

  // ─── Tap ───

  test("tap registers single tap", async ({ gesturesScreen }) => {
    await gesturesScreen.tapArea.tap()
    await expect(gesturesScreen.tapCount).toContainText("1")
  })

  // ─── Double Tap ───

  test("double tap registers double tap gesture", async ({ gesturesScreen }) => {
    await gesturesScreen.tapArea.doubleTap()
    await expect(gesturesScreen.lastGesture).toContainText("Double tap")
  })

  // Positional handles address the element by id, a separate route (PILOT-795).
  test("double tap through .first() registers double tap gesture", async ({ gesturesScreen }) => {
    await gesturesScreen.firstTapArea.doubleTap()
    await expect(gesturesScreen.lastGesture).toContainText("Double tap")
  })

  // ─── Long Press ───

  test("long press changes state", async ({ gesturesScreen }) => {
    await gesturesScreen.longPressArea.longPress()
    await expect(gesturesScreen.lastGesture).toHaveText("Last gesture: Long press")
  })

  test("long press with custom duration", async ({ gesturesScreen }) => {
    await gesturesScreen.longPressArea.tap()
    await gesturesScreen.longPressArea.longPress(2000)
    await expect(gesturesScreen.lastGesture).toHaveText("Last gesture: Long press")
  })

  // ─── Drag ───

  test("drag area is visible", async ({ gesturesScreen }) => {
    await expect(gesturesScreen.draggable).toBeVisible()
    await expect(gesturesScreen.dropZone).toBeVisible()
  })

  test("can drag element to drop zone", async ({ gesturesScreen }) => {
    await gesturesScreen.draggable.dragTo(gesturesScreen.dropZone)
    await expect(gesturesScreen.lastGesture).toHaveText("Last gesture: Drag")
  })

  // ─── Pinch ───

  test("pinch area is visible", async ({ gesturesScreen }) => {
    await expect(gesturesScreen.pinchArea).toBeVisible()
  })

  test("pinchIn gesture on pinch area", async ({ gesturesScreen }) => {
    await gesturesScreen.pinchArea.pinchIn({ scale: 0.5 })
  })

  test("pinchOut gesture on pinch area", async ({ gesturesScreen }) => {
    await gesturesScreen.pinchArea.pinchOut({ scale: 2.0 })
  })

  // ─── Swipe ───

  test("swipe area is visible", async ({ gesturesScreen }) => {
    await expect(gesturesScreen.swipeArea).toBeVisible()
  })

  // ─── Element Info ───

  test("draggable has correct bounding box", async ({ gesturesScreen }) => {
    const box = await gesturesScreen.draggable.boundingBox()
    expect(box).toBeDefined()
    expect(box!.width).toBeGreaterThan(0)
    expect(box!.height).toBeGreaterThan(0)
  })

  test("tap area isVisible returns true", async ({ gesturesScreen }) => {
    // isVisible() does not wait (PILOT-287) and beforeEach only waits for the
    // heading — settle the element first, then check the probe agrees.
    await expect(gesturesScreen.tapArea).toBeVisible()
    const visible = await gesturesScreen.tapArea.isVisible()
    expect(visible).toBe(true)
  })

  test("tap area isEnabled returns true", async ({ gesturesScreen }) => {
    const enabled = await gesturesScreen.tapArea.isEnabled()
    expect(enabled).toBe(true)
  })

  // PILOT-287: the visibility probes must not wait for the element. An absent
  // element answers at once instead of spending the action timeout and
  // throwing. The value assertions catch a regression to the pre-fix throw;
  // the wall-clock bound catches a regression to a silent poll-to-deadline
  // (which would still return the right values, one timeout per call later).
  // Such a regression always costs at least the configured default timeout
  // (10s local iOS, 15s Android, 30s iOS CI), so each call is bounded by
  // that rather than a constant that a slow shard could legitimately reach: an
  // absent answer is two reads (each bounded by the daemon's ~5s read window)
  // plus a ≤1.5s idle wait confirming the miss. Bound each call on its own so
  // two slow reads cannot add up to a false failure.
  test("isVisible/isHidden answer for an absent element without waiting", async ({ device }) => {
    const absent = device.getByText("Definitely not on this screen", { exact: true })
    const pollToDeadlineMs = device._getDefaultTimeout()
    let start = Date.now()
    expect(await absent.isVisible()).toBe(false)
    expect(Date.now() - start).toBeLessThan(pollToDeadlineMs)
    start = Date.now()
    expect(await absent.isHidden()).toBe(true)
    expect(Date.now() - start).toBeLessThan(pollToDeadlineMs)
  })

  // PILOT-344: exists() is the third non-waiting presence probe. Before the
  // fix it handed the action timeout to the agent's waiting findElement RPC,
  // so an absent element cost the whole timeout before `false` came back.
  // Same bound as above, for the same reason.
  test("exists answers for an absent element without waiting", async ({ device, gesturesScreen }) => {
    const pollToDeadlineMs = device._getDefaultTimeout()
    const start = Date.now()
    expect(await device.getByText("Definitely not on this screen", { exact: true }).exists()).toBe(false)
    expect(Date.now() - start).toBeLessThan(pollToDeadlineMs)
    // And a present element still answers true from the same probe — settled
    // first, as the isVisible test above does, since beforeEach only waits
    // for the heading.
    await expect(gesturesScreen.tapArea).toBeVisible()
    expect(await gesturesScreen.tapArea.exists()).toBe(true)
  })
})
