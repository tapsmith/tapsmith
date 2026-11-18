// Device readiness: the top-rail chip shows whether the app has already been
// prepared for the next run, is being prepared, or has gone stale — and the
// chip's menu drives that by hand. Single-device sessions get the chip too:
// every session runs through a worker now.

import { test, expect } from "../fixtures.js"
import { idleSeed, singleFileTree, GESTURES_FILE } from "../messages/scenarios.js"
import type { ServerMessage, WorkerReadiness } from "../../protocol.js"

const T0 = 1_700_000_000_000

const ONE_WORKER: ServerMessage = {
  type: "workers-info",
  workers: [{ workerId: 0, deviceSerial: "emulator-5554", displayName: "Pixel_7", platform: "android" }],
}

function status(readiness: WorkerReadiness, extra: { status?: "idle" | "running" | "initializing" | "error"; speculation?: "on" | "off" } = {}): ServerMessage {
  return {
    type: "worker-status",
    workerId: 0,
    deviceSerial: "emulator-5554",
    status: extra.status ?? "idle",
    passed: 0,
    failed: 0,
    skipped: 0,
    readiness,
    speculation: extra.speculation ?? "on",
  }
}

const CLEAR = { mode: "clear" as const, scope: "file" as const }

test.describe("Device readiness", () => {
  test("a single device shows as a worker chip with its readiness", async ({ ui, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), ONE_WORKER, status({ state: "ready", policy: CLEAR, preparedAt: T0, durationMs: 9_800, forFile: GESTURES_FILE })])
    await ui.open()

    await expect(runControls.workerChips).toHaveCount(1)
    await expect(runControls.workerChip("Pixel_7")).toHaveAttribute("data-readiness", "ready")
    await expect(runControls.readinessWords).toHaveText("ready")
    // The tooltip is where the detail lives: what it was prepared for and how long it took.
    await expect(runControls.workerChip("Pixel_7")).toHaveAttribute("title", /Prepared for: clear \(gestures\.test\.ts\)/)
    await expect(runControls.workerChip("Pixel_7")).toHaveAttribute("title", /took 9\.8s/)
  })

  test("walks through preparing → ready → stale", async ({ ui, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), ONE_WORKER])
    await ui.open()

    ui.send(status({ state: "preparing", policy: CLEAR, startedAt: T0, detail: "Clearing app data (com.example.app)" }))
    await expect(runControls.workerChip("Pixel_7")).toHaveAttribute("data-readiness", "preparing")
    await expect(runControls.readinessWords).toHaveText("preparing…")
    await expect(runControls.workerChip("Pixel_7")).toHaveAttribute("title", /Preparing: Clearing app data/)

    ui.send(status({ state: "ready", policy: CLEAR, preparedAt: T0 + 9_800, durationMs: 9_800 }))
    await expect(runControls.workerChip("Pixel_7")).toHaveAttribute("data-readiness", "ready")

    ui.send(status({ state: "stale", reason: "mcp-tool", since: T0 + 20_000 }))
    await expect(runControls.workerChip("Pixel_7")).toHaveAttribute("data-readiness", "stale")
    await expect(runControls.workerChip("Pixel_7")).toHaveAttribute("title", /Stale: an MCP agent interacted with the device/)
  })

  test("a failed run holds the device and says why", async ({ ui, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), ONE_WORKER])
    await ui.open()

    ui.send(status({ state: "stale", reason: "run-failed", since: T0 + 20_000 }))
    await expect(runControls.workerChip("Pixel_7")).toHaveAttribute("data-readiness", "stale")
    await expect(runControls.workerChip("Pixel_7")).toHaveAttribute("title", /Stale: tests failed — the app is held for inspection/)
  })

  test("running wins over readiness in the chip", async ({ ui, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), ONE_WORKER])
    await ui.open()
    ui.send(status({ state: "running", file: GESTURES_FILE }, { status: "running" }))
    await expect(runControls.readinessWords).toHaveText("running")
  })

  test("the chip menu prepares now and toggles preparation between runs", async ({ ui, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), ONE_WORKER, status({ state: "unprepared", reason: "no-candidate" })])
    await ui.open()

    await runControls.workerChip("Pixel_7").click({ button: "right" })
    const menu = runControls.workerMenu(0)
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("menuitemcheckbox", { name: /Prepare device between runs/ })).toHaveAttribute("aria-checked", "true")

    await menu.getByRole("menuitem", { name: /Prepare device now/ }).click()
    const prepare = await ui.waitForMessage("prepare-now")
    expect(prepare.workerId).toBe(0)

    await runControls.workerChip("Pixel_7").click({ button: "right" })
    await runControls.workerMenu(0).getByRole("menuitemcheckbox", { name: /Prepare device between runs/ }).click()
    const prefs = await ui.waitForMessage("set-preferences")
    expect(prefs.preferences).toEqual({ prepareBetweenRuns: false })
  })

  test("a preparing worker offers to cancel; idle offers recycle and respawn", async ({ ui, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), ONE_WORKER, status({ state: "preparing", policy: CLEAR, startedAt: T0 })])
    await ui.open()

    await runControls.workerChip("Pixel_7").click({ button: "right" })
    await runControls.workerMenu(0).getByRole("menuitem", { name: /Cancel preparation/ }).click()
    const cancel = await ui.waitForMessage("cancel-prepare")
    expect(cancel.workerId).toBe(0)

    ui.send(status({ state: "unprepared", reason: "cancelled" }))
    await runControls.workerChip("Pixel_7").click({ button: "right" })
    const menu = runControls.workerMenu(0)
    await expect(menu.getByRole("menuitem", { name: /Recycle worker/ })).toBeVisible()
    await expect(menu.getByRole("menuitem", { name: /Respawn worker 0/ })).toBeVisible()
    await menu.getByRole("menuitem", { name: /Recycle worker/ }).click()
    await ui.waitForMessage("recycle-worker")
  })

  test("the Actions panel says the device is being prepared while a run is pending", async ({ ui, explorer, actions, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), ONE_WORKER, status({ state: "preparing", policy: CLEAR, startedAt: T0, detail: "Clearing app data (com.example.app)" })])
    await ui.open()
    void runControls

    // Click run on a test: it is pending until the server confirms the run.
    await explorer.expandAllButton.click()
    await explorer.runButtonFor("smoke").click()
    await ui.waitForMessage("run-test")
    await expect(actions.preflightMessage).toHaveText("Preparing device (Clearing app data (com.example.app))…")

    ui.send(status({ state: "ready", policy: CLEAR, preparedAt: T0 + 1_000, durationMs: 1_000 }))
    await expect(actions.preflightMessage).toHaveText("Device ready — starting…")
  })

  test("a default session sends no preference on connect; a changed one is pushed on reconnect", async ({ ui, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), ONE_WORKER])
    await ui.open()
    await expect(runControls.workerChips).toHaveCount(1)
    expect(ui.messagesOfType("set-preferences")).toEqual([])

    await runControls.workerChip("Pixel_7").click({ button: "right" })
    await runControls.workerMenu(0).getByRole("menuitemcheckbox", { name: /Prepare device between runs/ }).click()
    await ui.waitForMessage("set-preferences")
    ui.clearReceived()

    ui.drop()
    await expect.poll(() => ui.connections, { timeout: 5000 }).toBe(2)
    const replayed = await ui.waitForMessage("set-preferences")
    expect(replayed.preferences.prepareBetweenRuns).toBe(false)
  })

  test("selecting a node tells the server what is likely to run next", async ({ app, explorer }) => {
    const ui = app
    await explorer.expandAllButton.click()
    await explorer.node("smoke").click()
    const msg = await ui.waitForMessage("select-node")
    expect(msg.filePath).toBe(GESTURES_FILE)
  })

  // A finished run reports its results in the tree and the status counts, not in a
  // banner. The legacy timing fields an older server sent must not bring back the
  // removed "First action after …" notice.
  for (const status of ["passed", "failed"] as const) {
    test(`a ${status} run ends without a notification banner`, async ({ app, explorer, runControls }) => {
      const ui = app
      ui.send({ type: "run-start", fileCount: 1 })
      await expect(explorer.runAllButton).toBeDisabled()
      ui.send({
        type: "run-end",
        status,
        duration: 4_200,
        passed: status === "passed" ? 1 : 0,
        failed: status === "failed" ? 1 : 0,
        skipped: 0,
        timeToFirstActionMs: 640,
        preflight: { origin: "prepared" },
      } as ServerMessage)
      await expect(explorer.runAllButton).toBeEnabled()
      await expect(runControls.notification).toHaveCount(0)
    })
  }
})
