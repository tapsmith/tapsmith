// PILOT-936. UI mode serves the page before its test workers are up. A page
// opened then never heard about the workers, and a Run clicked then failed on
// the server while the tree's pending pulse spun for good with Stop disabled.
// The server now tells the page how startup is going, holds such a run until
// the workers are ready (`run-state` with `waitingForWorkers`), and ends it
// with `run-end` (stopped) or a bare `run-state` when it never starts.

import { test, expect } from "../fixtures.js"
import { idleSeed, singleFileTree } from "../messages/scenarios.js"
import type { ServerMessage } from "../../protocol.js"

const WAITING = "Waiting for the test workers to start — the run begins as soon as they are ready."

const WORKERS: ServerMessage = {
  type: "workers-info",
  workers: [
    { workerId: 0, deviceSerial: "emulator-5554", displayName: "Pixel_7", platform: "android" },
    { workerId: 1, deviceSerial: "SIM-UDID-1", displayName: "iPhone 16", platform: "ios" },
  ],
}

test.describe("Worker startup", () => {
  test("shows the workers starting, then the devices once they are up", async ({ ui, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), { type: "workers-starting", ready: 0, total: 2 }])
    await ui.open()

    await expect(runControls.workersStarting).toHaveText("Starting workers… 0/2")
    await expect(runControls.workerChips).toHaveCount(0)

    ui.send({ type: "workers-starting", ready: 1, total: 2 })
    await expect(runControls.workersStarting).toHaveText("Starting workers… 1/2")

    // Startup ends: the page learns of every device without a reload.
    ui.send(WORKERS)
    await expect(runControls.workersStarting).toHaveCount(0)
    await expect(runControls.workerChips).toHaveCount(2)
    await expect(runControls.workerChip("iPhone 16")).toBeVisible()
  })

  test("a page reconnecting to a new session drops the old session's devices while it starts", async ({ ui, runControls }) => {
    // A tab left open on a pinned --ui-port reconnects to the next session
    // while its workers start; the old chips would claim devices are ready.
    ui.seed([...idleSeed(singleFileTree()), WORKERS])
    await ui.open()
    await expect(runControls.workerChips).toHaveCount(2)

    ui.send({ type: "workers-starting", ready: 0, total: 2 })
    await expect(runControls.workerChips).toHaveCount(0)
    await expect(runControls.workersStarting).toHaveText("Starting workers… 0/2")
  })

  test("a single device says it is starting, with no count", async ({ ui, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), { type: "workers-starting", ready: 0, total: 1 }])
    await ui.open()
    await expect(runControls.workersStarting).toHaveText("Starting worker…")
  })

  test("a run requested while they start waits visibly, then runs", async ({ ui, explorer, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), { type: "workers-starting", ready: 0, total: 2 }])
    await ui.open()
    await explorer.expandAll()

    await explorer.runNode("gestures.test.ts")
    await ui.waitForMessage("run-file")
    ui.send({ type: "run-state", isRunning: true, startedAt: Date.now(), waitingForWorkers: true })

    await expect(runControls.notification).toHaveText(WAITING)
    await expect(explorer.stopButton).toBeEnabled()
    await expect(explorer.runAllButton).toBeDisabled()
    await expect(explorer.pendingNodes.first()).toBeVisible()

    // Workers up: no longer waiting, still running until the run reports.
    ui.send(WORKERS, { type: "run-state", isRunning: true, startedAt: Date.now() })
    await expect(runControls.notification).toHaveCount(0)
    await expect(explorer.stopButton).toBeEnabled()

    ui.send({ type: "run-start", fileCount: 1 })
    ui.send({ type: "run-end", status: "passed", duration: 10, passed: 0, failed: 0, skipped: 0 })
    await expect(explorer.runAllButton).toBeEnabled()
    await expect(explorer.pendingNodes).toHaveCount(0)
  })

  test("Stop ends a waiting run and clears its pending state", async ({ ui, explorer, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), { type: "workers-starting", ready: 0, total: 2 }])
    await ui.open()
    await explorer.expandAll()

    await explorer.runNode("gestures.test.ts")
    ui.send({ type: "run-state", isRunning: true, startedAt: Date.now(), waitingForWorkers: true })
    await expect(explorer.pendingNodes.first()).toBeVisible()

    await explorer.stopButton.click()
    await ui.waitForMessage("stop-run")
    ui.send({ type: "run-end", status: "stopped", duration: 0, passed: 0, failed: 0, skipped: 0 })

    await expect(runControls.notification).toHaveText("Run stopped")
    await expect(explorer.pendingNodes).toHaveCount(0)
    await expect(explorer.runAllButton).toBeEnabled()
  })

  test("a run that never starts shows why and resets", async ({ ui, explorer, runControls }) => {
    ui.seed([...idleSeed(singleFileTree()), { type: "workers-starting", ready: 0, total: 1 }])
    await ui.open()
    await explorer.expandAll()

    await explorer.runNode("gestures.test.ts")
    ui.send({ type: "run-state", isRunning: true, startedAt: Date.now(), waitingForWorkers: true })
    await expect(runControls.notification).toHaveText(WAITING)

    // No worker came up: the server says so and the run is over.
    const message = "No test worker could be started — the terminal says why. Fix that, then restart UI mode."
    ui.send(
      { type: "workers-info", workers: [] },
      { type: "error", message },
      { type: "run-state", isRunning: true, startedAt: Date.now() },
      { type: "run-state", isRunning: false },
    )

    await expect(runControls.notification).toHaveText(message)
    await expect(runControls.errorBanner).toBeVisible()
    await expect(runControls.workersStarting).toHaveCount(0)
    await expect(explorer.pendingNodes).toHaveCount(0)
    await expect(explorer.runAllButton).toBeEnabled()
  })

  test("a page opened while a run waits shows it waiting", async ({ ui, explorer, runControls }) => {
    ui.seed([
      ...idleSeed(singleFileTree()),
      { type: "run-state", isRunning: true, startedAt: Date.now(), waitingForWorkers: true },
      { type: "workers-starting", ready: 1, total: 2 },
    ])
    await ui.open()

    await expect(runControls.notification).toHaveText(WAITING)
    await expect(explorer.stopButton).toBeEnabled()
  })
})
