/**
 * A row tap after type() into a field above a React Native list can be spent
 * on closing the keyboard, and the agent cannot tell (PILOT-1432). Such a tap
 * still passes, with a warning on its trace step (PILOT-1495).
 */
import type { Device } from "tapsmith"
import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

interface Step { type: string; action?: string; success?: boolean; warning?: string }

/**
 * The trace steps `action` recorded: in the trace the runner is recording (a
 * test cannot start another over it), or one of its own with `trace: "off"`.
 */
async function traced(device: Device, action: () => Promise<void>): Promise<Step[]> {
  const tracing = device.tracing as unknown as { _currentCollector: { events: readonly Step[] } | null }
  const own = !tracing._currentCollector
  if (own) await device.tracing.start({ screenshots: false, snapshots: false, sources: false })
  try {
    const { events } = tracing._currentCollector!
    const from = events.length
    await action()
    return events.slice(from).filter((e) => e.type === "action")
  } finally {
    if (own) await device.tracing.stop()
  }
}

const WARNING = /may only have closed the keyboard.*device\.hideKeyboard\(\)/

describe("a tap that may only have closed the keyboard", () => {
  test.beforeEach(async ({ device, listScreen }) => {
    await openScreen(device, "/list")
    await listScreen.searchField.clear()
    await expect(listScreen.itemCount).toHaveText("30 items")
    await listScreen.searchField.type("Item 7")
    await expect(listScreen.itemCount).toHaveText("1 items")
    expect(await device.isKeyboardShown()).toBe(true)
  })

  const gestures = {
    tap: (row: { tap(): Promise<void> }) => row.tap(),
    doubleTap: (row: { doubleTap(): Promise<void> }) => row.doubleTap(),
    longPress: (row: { longPress(): Promise<void> }) => row.longPress(),
  }
  for (const name of ["tap", "doubleTap", "longPress"] as const) {
    test(`${name}() warns and still passes`, async ({ device, listScreen }) => {
      const steps = await traced(device, () => gestures[name](listScreen.item(7)))
      expect(steps.map((s) => [s.action, s.success])).toEqual([[name, true]])
      expect(steps[0].warning).toMatch(WARNING)
      expect(await device.isKeyboardShown()).toBe(false)
    })
  }

  test("says nothing when the keyboard was closed before the tap", async ({ device, listScreen }) => {
    await device.hideKeyboard()
    const before = await listScreen.selectedCount.getText()
    const steps = await traced(device, () => listScreen.item(7).tap())
    expect(steps.map((s) => s.warning)).toEqual([undefined])
    await expect(listScreen.selectedCount).not.toHaveText(before)
  })

  test("says nothing for a tap that leaves the keyboard up", async ({ device, listScreen }) => {
    const steps = await traced(device, () => listScreen.searchField.tap())
    expect(steps.map((s) => s.warning)).toEqual([undefined])
    expect(await device.isKeyboardShown()).toBe(true)
  })
})
