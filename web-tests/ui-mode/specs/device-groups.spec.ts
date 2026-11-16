// Device groups (`use.devices`): one worker drives several devices, so the
// pane shows one tab per device — labelled by member name — the All view has
// a tile per device, and pick mode / gestures name the device they target.

import { test, expect } from "../fixtures.js"
import { screenFrame } from "../messages/frames.js"
import { action } from "../messages/trace.js"
import { GESTURES_FILE, idleSeed, singleFileTree } from "../messages/scenarios.js"
import { projectNode } from "../messages/tree.js"
import type { ServerMessage } from "../../protocol.js"

type WorkerInfoMessage = Extract<ServerMessage, { type: "workers-info" }>

const GROUP_WORKER_INFO: WorkerInfoMessage["workers"][number] = {
  workerId: 0,
  deviceSerial: "emulator-5554",
  displayName: "emulator-5554",
  platform: "android",
  devicePixelRatio: 2,
  devices: [
    { index: 0, name: "alice", deviceSerial: "emulator-5554", displayName: "emulator-5554", platform: "android", devicePixelRatio: 2 },
    { index: 1, name: "bob", deviceSerial: "emulator-5556", displayName: "emulator-5556", platform: "android", devicePixelRatio: 3 },
  ],
}

const GROUP_WORKER: ServerMessage = { type: "workers-info", workers: [GROUP_WORKER_INFO] }

const ALICE = "emulator-5554 · alice"
const BOB = "emulator-5554 · bob"

async function openWithGroup(ui: {
  seed: (m: ServerMessage[]) => void
  open: () => Promise<void>
}) {
  ui.seed([...idleSeed(singleFileTree()), GROUP_WORKER])
  await ui.open()
}

test.describe("Device groups", () => {
  test("shows a tab per group member, named by the member", async ({ ui, device }) => {
    await openWithGroup(ui)

    await expect(device.workerTabs).toBeVisible()
    await expect(device.workerTabs.getByRole("tab")).toHaveCount(3)
    await expect(device.workerTab("All")).toBeVisible()
    await expect(device.workerTab(ALICE)).toBeVisible()
    await expect(device.workerTab(BOB)).toBeVisible()
    // The serial is still reachable from the tooltip.
    await expect(device.workerTab(BOB)).toHaveAttribute("title", /emulator-5556/)
  })

  test("the top rail shows a chip per group member, labelled like the tabs", async ({ ui, runControls }) => {
    await openWithGroup(ui)

    // One worker, two devices: the rail must name both, not collapse the group
    // into a single chip for the primary — bob's serial is otherwise unreachable
    // from the status surface.
    await expect(runControls.workerChips).toHaveCount(2)
    await expect(runControls.workerChip(ALICE)).toBeVisible()
    await expect(runControls.workerChip(BOB)).toBeVisible()
    await expect(runControls.workerChip(BOB)).toHaveAttribute("title", /emulator-5556/)
    await expect(runControls.workerChip(BOB)).toHaveAttribute("data-worker-id", "0")
  })

  test("the rail mixes single-device and group workers: one chip per device, labelled per worker", async ({ ui, runControls }) => {
    // A session whose projects bucket differently — a single-device project on
    // worker 0 and a `use.devices` project on worker 1 — has workers of
    // different sizes. Each contributes its own devices; the group's chips
    // carry the worker's name so two workers' members stay apart.
    const mixed: ServerMessage = {
      type: "workers-info",
      workers: [
        { workerId: 0, deviceSerial: "emulator-5560", displayName: "Pixel_8", platform: "android", devicePixelRatio: 2 },
        { ...GROUP_WORKER_INFO, workerId: 1 },
      ],
    }
    ui.seed([...idleSeed(singleFileTree()), mixed])
    await ui.open()

    await expect(runControls.workerChips).toHaveCount(3)
    await expect(runControls.workerChips.nth(0)).toHaveText(/^Pixel_8/)
    await expect(runControls.workerChips.nth(1)).toHaveText(new RegExp(`^${ALICE}`))
    await expect(runControls.workerChips.nth(2)).toHaveText(new RegExp(`^${BOB}`))
    await expect(runControls.workerChip("Pixel_8")).toHaveAttribute("data-worker-id", "0")
    await expect(runControls.workerChip(BOB)).toHaveAttribute("data-worker-id", "1")
  })

  test("a running file that drives only the primary leaves the other member's chip idle", async ({ ui, runControls }) => {
    // The worker holds the target's largest group; a single-device project's
    // file runs on alice alone. The server reports the run's device count on
    // the worker status, and the rail must not light bob up for it.
    await openWithGroup(ui)
    const status = (extra: Record<string, unknown>) => ui.send({
      type: "worker-status", workerId: 0, deviceSerial: "emulator-5554", passed: 0, failed: 0, skipped: 0, ...extra,
    } as never)

    status({ status: "running", currentFile: "home.test.ts", activeDeviceCount: 1 })
    await expect(runControls.workerChip(ALICE).getByTestId("worker-readiness")).toHaveText("running")
    await expect(runControls.workerChip(BOB).getByTestId("worker-readiness")).toHaveText("idle")
    await expect(runControls.workerChip(BOB)).toHaveAttribute("data-active", "false")
    await expect(runControls.workerChip(ALICE)).toHaveAttribute("data-active", "true")
    await expect(runControls.workerChip(BOB)).toHaveAttribute("title", /Not used by the running file: its project drives one device/)

    // A group file drives both.
    status({ status: "running", currentFile: "two-devices.test.ts", activeDeviceCount: 2 })
    await expect(runControls.workerChip(BOB).getByTestId("worker-readiness")).toHaveText("running")
    await expect(runControls.workerChip(BOB)).toHaveAttribute("data-active", "true")

    // Legacy servers send no count: the whole group counts as running.
    status({ status: "running", currentFile: "two-devices.test.ts" })
    await expect(runControls.workerChip(BOB).getByTestId("worker-readiness")).toHaveText("running")

    // Between runs the worker prepares for the next file. A single-device
    // file's preparation touches only the primary — bob was never used and
    // still holds its claim — so its chip must not say "preparing".
    status({ status: "idle", activeDeviceCount: 1, readiness: { state: "preparing", policy: { mode: "clear", scope: "file" }, startedAt: 1_700_000_000_000, detail: "Clearing app data" } })
    await expect(runControls.workerChip(ALICE).getByTestId("worker-readiness")).toHaveText("preparing…")
    await expect(runControls.workerChip(BOB).getByTestId("worker-readiness")).toHaveText("idle")
    await expect(runControls.workerChip(BOB)).toHaveAttribute("data-active", "false")
    await expect(runControls.workerChip(BOB)).toHaveAttribute("title", /Not part of this preparation: the next file's project drives one device/)
    // A preparation for a group file involves both.
    status({ status: "idle", activeDeviceCount: 2, readiness: { state: "preparing", policy: { mode: "clear", scope: "file" }, startedAt: 1_700_000_000_000 } })
    await expect(runControls.workerChip(BOB).getByTestId("worker-readiness")).toHaveText("preparing…")

    // Idle again: no member is singled out.
    status({ status: "idle", readiness: { state: "ready", policy: { mode: "clear", scope: "file" }, preparedAt: 1_700_000_000_000, durationMs: 9_800 } })
    await expect(runControls.workerChip(ALICE).getByTestId("worker-readiness")).toHaveText("ready")
    await expect(runControls.workerChip(BOB).getByTestId("worker-readiness")).toHaveText("ready")
    await expect(runControls.workerChip(BOB)).toHaveAttribute("data-active", "true")
  })

  test("a single-device project's test on a group worker shows one screenshot view, not a pane per member", async ({ ui, explorer, page }) => {
    await openWithGroup(ui)
    const soloTest = "Gestures screen > double tap registers double tap gesture"
    const pairTest = "Gestures screen > long press registers long press"

    ui.send({ type: "run-start", fileCount: 1 })
    // The server reports how many of the worker's devices this test's run drove.
    ui.send({ type: "test-start", fullName: soloTest, filePath: GESTURES_FILE, workerId: 0, deviceCount: 1 })
    ui.send(...action({ testFullName: soloTest, actionIndex: 0, action: "tap" }))
    ui.send({ type: "test-status", fullName: soloTest, filePath: GESTURES_FILE, status: "passed", duration: 300 })
    ui.send({ type: "test-start", fullName: pairTest, filePath: GESTURES_FILE, workerId: 0, deviceCount: 2 })
    ui.send(...action({ testFullName: pairTest, actionIndex: 0, action: "tap" }))
    ui.send({ type: "test-status", fullName: pairTest, filePath: GESTURES_FILE, status: "passed", duration: 300 })
    ui.send({ type: "run-end", status: "passed", duration: 600, passed: 2, failed: 0, skipped: 0 })

    await explorer.expandAll()
    await explorer.clickNode("double tap registers double tap gesture")
    await expect(page.getByTestId("screenshot-panes")).toHaveCount(0)
    await expect(page.getByTestId("screenshot-pane")).toHaveCount(0)

    await explorer.clickNode("long press registers long press")
    await expect(page.getByTestId("screenshot-panes")).toHaveCount(1)
    await expect(page.getByTestId("screenshot-pane")).toHaveCount(2)
  })

  test("selecting a member tells the server which device to mirror", async ({ ui, device }) => {
    await openWithGroup(ui)

    await device.selectWorkerView(BOB)
    const msg = await ui.waitForMessage("select-worker-view")
    expect(msg.mode).toBe(0)
    expect(msg.deviceIndex).toBe(1)
    await expect(device.workerTab(BOB)).toHaveAttribute("aria-selected", "true")
    await expect(device.workerTab(ALICE)).toHaveAttribute("aria-selected", "false")
  })

  test("the All view shows one mirror per member and routes frames by device", async ({ ui, device }) => {
    await openWithGroup(ui)
    await device.selectWorkerView("All")

    await expect(device.mirrorFor(ALICE)).toBeVisible()
    await expect(device.mirrorFor(BOB)).toBeVisible()

    // Same worker, different device index — different sizes so a frame that
    // ignored the index would be unmistakable.
    ui.sendFrame({ ...screenFrame(120, 260), workerId: 0, deviceIndex: 0 })
    ui.sendFrame({ ...screenFrame(200, 420), workerId: 0, deviceIndex: 1 })

    await expect(device.mirrorFor(ALICE)).toHaveAttribute("width", "120")
    await expect(device.mirrorFor(BOB)).toHaveAttribute("width", "200")
  })

  test("gestures and picks on a member's tab name that device", async ({ ui, device }) => {
    await openWithGroup(ui)
    await device.selectWorkerView(BOB)
    await expect(device.mirrorStatus).toHaveText("Starting mirror…")
    ui.sendFrame({ ...screenFrame(200, 420), workerId: 0, deviceIndex: 1 })
    await expect(device.canvas).toHaveAttribute("width", "200")

    await device.tapMirrorAt(0.5, 0.5)
    const tap = await ui.waitForMessage("mirror-tap")
    expect(tap.workerId).toBe(0)
    expect(tap.deviceIndex).toBe(1)

    await device.enablePickMode()
    const hierarchy = await ui.waitForMessage("request-hierarchy")
    expect(hierarchy.workerId).toBe(0)
    expect(hierarchy.deviceIndex).toBe(1)
  })

  test("a single-device worker keeps its plain label", async ({ ui, device }) => {
    // Contrast: without `devices`, or with one member, no member suffix.
    ui.seed([
      ...idleSeed(singleFileTree()),
      {
        type: "workers-info",
        workers: [
          { workerId: 0, deviceSerial: "emulator-5554", displayName: "emulator-5554", platform: "android" },
          { workerId: 1, deviceSerial: "emulator-5556", displayName: "emulator-5556", platform: "android" },
        ],
      },
    ])
    await ui.open()
    await expect(device.workerTab("emulator-5554")).toBeVisible()
    await expect(device.workerTabs.getByRole("tab", { name: /·/ })).toHaveCount(0)
  })
})

test.describe("Device group badge", () => {
  test("a project that declares use.devices names its members on the project row, once", async ({ ui, explorer }) => {
    // The declaration is the project's; every file, suite and test under it
    // inherits it silently — the rail and the viewer's panes already show the
    // group for each test, so the tree says it where it is declared and stops.
    ui.seed(idleSeed([projectNode("pair", singleFileTree(), { use: { devices: 2, deviceNames: ["alice", "bob"] } })]))
    await ui.open()
    await explorer.expandAllButton.click()

    await expect(explorer.devicesFor("[pair]")).toHaveText(/alice · bob/)
    await expect(explorer.devicesFor("[pair]")).toHaveAttribute("title", /Each test drives 2 devices: alice, bob \(use\.devices\)/)
    await expect(explorer.devicesFor("gestures.test.ts")).toHaveCount(0)
    await expect(explorer.devicesFor("Gestures screen")).toHaveCount(0)
    await expect(explorer.devicesFor("double tap registers double tap gesture")).toHaveCount(0)
    await expect(explorer.nodes.getByTestId("node-devices")).toHaveCount(1)
  })

  test("falls back to a count when a server sends no member names", async ({ ui, explorer }) => {
    ui.seed(idleSeed([projectNode("pair", singleFileTree(), { use: { devices: 2 } })]))
    await ui.open()
    await expect(explorer.devicesFor("[pair]")).toHaveText(/2 devices/)
  })
})
