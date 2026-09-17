// The device activity feed: background preparation, recycles and mirror bursts
// alongside MCP tool calls, in one time-ordered list. Started/ended pairs share
// an id and must collapse into one row.

import { test, expect } from "../fixtures.js"
import type { ServerMessage } from "../../protocol.js"

const T0 = 1_700_000_000_000

function prepare(status: "started" | "completed" | "error" | "cancelled", extra: { detail?: string; durationMs?: number } = {}): ServerMessage {
  return {
    type: "device-activity",
    id: "prepare-0-1",
    workerId: 0,
    kind: "prepare",
    status,
    label: status === "started" ? "Prepare device (clear)" : "Prepared device (clear)",
    detail: extra.detail,
    policy: { mode: "clear", scope: "file" },
    timestamp: T0,
    durationMs: extra.durationMs,
  }
}

test.describe("Device activity feed", () => {
  test("a background preparation appears while running and merges when it completes", async ({ app, mcp }) => {
    const ui = app
    await mcp.open()

    ui.send(prepare("started", { detail: "Clearing app data (com.example.app)" }))
    await expect(mcp.activityOfKind("prepare")).toHaveCount(1)
    await expect(mcp.activityOfKind("prepare")).toContainText("running…")
    await expect(mcp.activityOfKind("prepare")).toContainText("Clearing app data")

    ui.send(prepare("completed", { detail: "clear: 9800ms", durationMs: 9_800 }))
    await expect(mcp.activityOfKind("prepare")).toHaveCount(1)
    await expect(mcp.activityOfKind("prepare")).toHaveAttribute("data-status", "completed")
    await expect(mcp.activityOfKind("prepare")).toContainText("9.8s")
  })

  test("a cancelled preparation is kept, marked cancelled", async ({ app, mcp }) => {
    const ui = app
    await mcp.open()
    ui.send(prepare("started"))
    ui.send(prepare("cancelled", { detail: "cancelled" }))
    await expect(mcp.activityOfKind("prepare")).toHaveAttribute("data-status", "cancelled")
  })

  test("interleaves MCP calls and device activity by time, and Clear empties both", async ({ app, mcp }) => {
    const ui = app
    await mcp.open()
    ui.send({ type: "mcp-tool-call", id: "c1", tool: "tapsmith_tap", args: { locator: "Login" }, status: "completed", durationMs: 120, timestamp: T0 + 5_000 })
    ui.send({ type: "device-activity", id: "mirror-0-1", workerId: 0, kind: "mirror", status: "completed", label: "Mirror: 2 taps", timestamp: T0 + 1_000, durationMs: 300 })
    ui.send(prepare("completed", { durationMs: 9_800 }))

    const rows = mcp.feed.locator("[data-testid='mcp-entry'], [data-testid='activity-entry']")
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText("Prepared device")
    await expect(rows.nth(1)).toContainText("Mirror: 2 taps")
    await expect(rows.nth(2)).toContainText("tap")

    await mcp.clear()
    await expect(rows).toHaveCount(0)
    await expect(mcp.emptyState).toBeVisible()
  })

  test("the source filter shows one stream at a time and never hides rows silently", async ({ app, mcp }) => {
    const ui = app
    await mcp.open()
    ui.send({ type: "mcp-tool-call", id: "c1", tool: "tapsmith_tap", args: { locator: "Login" }, status: "completed", durationMs: 120, timestamp: T0 + 5_000 })
    ui.send(prepare("completed", { durationMs: 9_800 }))
    const rows = mcp.feed.locator("[data-testid='mcp-entry'], [data-testid='activity-entry']")
    await expect(rows).toHaveCount(2)
    await expect(mcp.hiddenCount).toHaveCount(0)

    await mcp.filterButton("MCP").click()
    await expect(mcp.entries).toHaveCount(1)
    await expect(mcp.activityEntries).toHaveCount(0)
    await expect(mcp.hiddenCount).toHaveText("1 hidden")

    await mcp.filterButton("Device").click()
    await expect(mcp.entries).toHaveCount(0)
    await expect(mcp.activityEntries).toHaveCount(1)

    await mcp.clear()
    await expect(rows).toHaveCount(0)

    // Still filtered to Device when an agent-only call arrives: the view is
    // empty, but says why instead of looking like data loss.
    ui.send({ type: "mcp-tool-call", id: "c2", tool: "tapsmith_tap", args: {}, status: "completed", durationMs: 50, timestamp: T0 + 9_000 })
    await expect(mcp.emptyState).toContainText("1 entry is hidden by the filter")
  })

  test("the feed survives a reconnect when the server replays it", async ({ ui, mcp }) => {
    ui.seed([{ type: "test-tree", files: [] }, { type: "run-state", isRunning: false }, prepare("completed", { durationMs: 1_000 })])
    await ui.open()
    await mcp.open()
    await expect(mcp.activityOfKind("prepare")).toHaveCount(1)
  })

  // The in-progress summary reads the tool's own argument key, so renaming that
  // key without updating the panel renders a blank row (it did, for `locator`).
  test("an in-progress tap names the locator it is acting on", async ({ app, mcp }) => {
    const ui = app
    await mcp.open()

    ui.send({ type: "mcp-tool-call", id: "c1", tool: "tapsmith_tap", args: { locator: 'device.getByText("Login")' }, status: "started", timestamp: T0 })
    await expect(mcp.entries).toHaveCount(1)
    await expect(mcp.entries).toContainText("running…")
    await expect(mcp.entries).toContainText('device.getByText("Login")')
  })
})
