// Regression tests for run lifecycle handling.
//
// Every case here corresponds to a bug that shipped and was found by hand in a
// live session. They are pure client-side state bugs, reachable by replaying a
// message sequence — which is exactly what this suite exists to pin down.

import { test, expect } from "../fixtures.js"
import { GESTURES_FILE, singleFileTree } from "../messages/scenarios.js"
import { action, actionCompleted, actionStarted, group } from "../messages/trace.js"

const DOUBLE_TAP = "Gestures screen > double tap registers double tap gesture"
const TEST_NAME = "double tap registers double tap gesture"

test.describe("Run lifecycle", () => {
  test.describe("Isolation metadata", () => {
    // The Isolation row lives in the shared ActionsPanel, but UI mode
    // synthesises its metadata client-side — so the row rendered in the trace
    // viewer and never here until `test-start` began carrying the resolved
    // policy.
    test("shows the isolation a test ran under, resolved by the runner", async ({ app, explorer, actions }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({ type: "run-start", fileCount: 1 })
      ui.send({
        type: "test-start",
        fullName: DOUBLE_TAP,
        filePath: GESTURES_FILE,
        isolation: { appReset: "warm", appResetScope: "test" },
      })
      ui.send(...action({ testFullName: DOUBLE_TAP, actionIndex: 0, action: "tap", selector: "getByRole('button')" }))
      ui.send({ type: "test-status", fullName: DOUBLE_TAP, filePath: GESTURES_FILE, status: "passed", duration: 900 })

      await explorer.node(TEST_NAME).click()
      await actions.metadataTab.click()
      await expect(actions.isolation).toHaveText("warm · per test")
    })

    test("shows no Isolation row when the runner sent none", async ({ app, explorer, actions }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({ type: "run-start", fileCount: 1 })
      ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
      ui.send({ type: "test-status", fullName: DOUBLE_TAP, filePath: GESTURES_FILE, status: "passed", duration: 900 })

      await explorer.node(TEST_NAME).click()
      await actions.metadataTab.click()
      await expect(actions.metadataTab).toHaveClass(/active/)
      await expect(actions.isolation).toHaveCount(0)
    })
  })

  test.describe("#103 — a hard refresh must not start a run", () => {
    // Fixed in e9ce4ef. The bare-key shortcut handler ignored modifiers, so
    // Cmd+Shift+R matched `r` and fired run-all at the daemon on its way out;
    // the page came back to find tests already running. `resolveShortcut` is
    // unit-tested, but only a real key event proves the handler is wired to it.
    for (const chord of ["Meta+Shift+r", "Meta+r", "Control+r", "Alt+r"]) {
      test(`${chord} does not fire the run shortcut`, async ({ app, page }) => {
        const ui = app
        await page.locator("body").press(chord)
        await page.waitForTimeout(300)
        expect(ui.received).toEqual([])

        // The bare key does fire, so the silence above is the modifier guard
        // working rather than shortcuts being broken (or unrecorded) entirely.
        await page.locator("body").press("r")
        await ui.waitForMessage("run-all")
      })
    }

    test("Shift+Escape does not fire the stop shortcut", async ({ app, page }) => {
      const ui = app
      ui.send({ type: "run-start", fileCount: 1 })
      await page.locator("body").press("Shift+Escape")
      await page.waitForTimeout(300)
      expect(ui.received).toEqual([])

      // Bare Escape does stop, for the same reason.
      await page.locator("body").press("Escape")
      await ui.waitForMessage("stop-run")
    })

    test("sends no run command after a reload", async ({ app, explorer, page }) => {
      const ui = app
      ui.clearReceived()

      await page.reload()
      await expect(explorer.nodes.first()).toBeVisible()

      // Give the SPA room to misbehave before concluding it didn't.
      await page.waitForTimeout(500)
      expect(ui.received).toEqual([])
    })

    test("sends no run command after a reload mid-run", async ({ ui, explorer, page }) => {
      // Reconnecting into an in-progress run is the case that made the original
      // bug bite: the SPA rehydrates a running suite and must not add a second.
      ui.seed([
        { type: "test-tree", files: singleFileTree() },
        { type: "run-state", isRunning: true, startedAt: 1_700_000_000_000 },
      ])
      await ui.open()
      await expect(explorer.nodes.first()).toBeVisible()
      ui.clearReceived()

      await page.reload()
      await expect(explorer.nodes.first()).toBeVisible()
      await page.waitForTimeout(500)

      expect(ui.received).toEqual([])
    })
  })

  test.describe("#186 — afterAll attribution must not disturb a finished test", () => {
    // Fixed in e9639ce. The runner re-fires onTestStart for the last test that
    // ran so afterAll trace events have somewhere to go. The SPA used to treat
    // that as a real start: the finished test flipped back to 'running', then
    // run-end reset it to 'idle' — losing the red cross — and its accumulated
    // trace actions were wiped.
    test("keeps a failed test's status and trace through the re-tag", async ({
      app,
      explorer,
      actions,
    }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({ type: "run-start", fileCount: 1 })
      ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
      ui.send(
        ...action({ testFullName: DOUBLE_TAP, actionIndex: 0, action: "tap", selector: "getByRole('button')" }),
        ...action({ testFullName: DOUBLE_TAP, actionIndex: 1, action: "doubleTap", selector: "getByTestId('tap-area')" }),
      )
      ui.send({
        type: "test-status",
        fullName: DOUBLE_TAP,
        filePath: GESTURES_FILE,
        status: "failed",
        duration: 900,
        error: "expected 'Double tap' but got 'None'",
      })

      const node = explorer.node(TEST_NAME)
      await expect(node).toHaveAttribute("data-status", "failed")
      await node.click()
      await expect(actions.items).toHaveCount(2)

      // The afterAll re-tag.
      ui.send({
        type: "test-start",
        fullName: DOUBLE_TAP,
        filePath: GESTURES_FILE,
        attributionOnly: true,
      })

      await expect(node).toHaveAttribute("data-status", "failed")
      await expect(actions.items).toHaveCount(2)

      // The regression only became visible at run-end, which resets anything
      // still marked 'running'. If the re-tag flipped this test back to
      // running, its failure is erased here.
      ui.send({
        type: "run-end",
        status: "failed",
        duration: 1000,
        passed: 0,
        failed: 1,
        skipped: 0,
      })

      await expect(node).toHaveAttribute("data-status", "failed")
      await expect(actions.items).toHaveCount(2)
    })

    test("still appends afterAll actions to the finished test's trace", async ({
      app,
      explorer,
      actions,
    }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
      ui.send(...action({ testFullName: DOUBLE_TAP, actionIndex: 0, action: "tap" }))
      ui.send({
        type: "test-status",
        fullName: DOUBLE_TAP,
        filePath: GESTURES_FILE,
        status: "passed",
        duration: 300,
      })

      await explorer.clickNode(TEST_NAME)
      await expect(actions.items).toHaveCount(1)

      // The afterAll collector restarts actionIndex at 0; the re-tag exists so
      // those events are shifted past the test's own rather than colliding.
      ui.send({
        type: "test-start",
        fullName: DOUBLE_TAP,
        filePath: GESTURES_FILE,
        attributionOnly: true,
      })
      ui.send(...action({ testFullName: DOUBLE_TAP, actionIndex: 0, action: "clearAppData" }))

      await expect(actions.items).toHaveCount(2)
      await expect(actions.item("clearAppData")).toBeVisible()
    })

    test("a genuine re-start does clear the previous attempt's trace", async ({
      app,
      explorer,
      actions,
    }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
      ui.send(...action({ testFullName: DOUBLE_TAP, actionIndex: 0, action: "tap" }))
      ui.send({
        type: "test-status",
        fullName: DOUBLE_TAP,
        filePath: GESTURES_FILE,
        status: "failed",
        error: "flaked",
      })
      await explorer.clickNode(TEST_NAME)
      await expect(actions.items).toHaveCount(1)

      // Without attributionOnly this is a retry: status goes back to running
      // and the stale attempt's actions must not linger.
      ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })

      await expect(explorer.node(TEST_NAME)).toHaveAttribute("data-status", "running")
      await expect(actions.items).toHaveCount(0)
    })
  })

  // PILOT-729: a filtered Run all runs a selection; it must clear only the
  // selected tests' traces, as a scoped run does, not every trace in the tree.
  test.describe("a filtered Run all", () => {
    const LONG_PRESS = "Gestures screen > long press registers long press"

    test("clears only the selected tests' traces", async ({ app, explorer, actions }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({ type: "run-start", fileCount: 1 })
      for (const fullName of [DOUBLE_TAP, LONG_PRESS]) {
        ui.send({ type: "test-start", fullName, filePath: GESTURES_FILE })
        ui.send(...action({ testFullName: fullName, actionIndex: 0, action: "tap" }))
        ui.send({ type: "test-status", fullName, filePath: GESTURES_FILE, status: "passed", duration: 10 })
      }
      ui.send({ type: "run-end", status: "passed", duration: 20, passed: 2, failed: 0, skipped: 0 })
      await explorer.clickNode("long press registers long press")
      await expect(actions.items).toHaveCount(1)

      ui.send({ type: "run-start", fileCount: 1, selection: [{ filePath: GESTURES_FILE, tests: [DOUBLE_TAP] }] })

      // The other test keeps its result and its trace; the selected one's is cleared.
      await expect(explorer.node("long press registers long press")).toHaveAttribute("data-status", "passed")
      await expect(actions.items).toHaveCount(1)
      await explorer.clickNode(TEST_NAME)
      await expect(actions.items).toHaveCount(0)
    })
  })

  test.describe("in-flight actions", () => {
    // Neighbourhood of abbcf347 (#133): a started-but-not-completed action has
    // to render, or the panel looks empty while the device is busy.
    test("renders a started action before its completed event", async ({
      app,
      explorer,
      actions,
    }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
      await explorer.clickNode(TEST_NAME)

      ui.send(
        actionStarted({
          testFullName: DOUBLE_TAP,
          actionIndex: 0,
          action: "waitFor",
          selector: "getByText('Gesture Testing')",
        }),
      )

      await expect(actions.items).toHaveCount(1)
      await expect(actions.item("waitFor")).toBeVisible()
    })

    // The panel hides sections with nothing in them. The in-flight action is
    // rendered outside the completed-item walk, so the first action of a
    // group used to show headless until it completed and became a real row —
    // most visibly the first BEFORE EACH action right after an APP RESET row.
    test("shows the section header of a group whose first action is still in flight", async ({
      app,
      explorer,
      actions,
    }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
      await explorer.clickNode(TEST_NAME)

      ui.send(group({ testFullName: DOUBLE_TAP, type: "group-start", name: "App reset", actionIndex: 0 }))
      ui.send(...action({ testFullName: DOUBLE_TAP, actionIndex: 0, action: "appReset" }))
      ui.send(group({ testFullName: DOUBLE_TAP, type: "group-end", name: "App reset", actionIndex: 0 }))
      ui.send(group({ testFullName: DOUBLE_TAP, type: "group-start", name: "beforeEach Hooks", actionIndex: 1 }))
      ui.send(actionStarted({ testFullName: DOUBLE_TAP, actionIndex: 1, action: "openDeepLink" }))

      await expect(actions.inProgressItems).toHaveCount(1)
      await expect(actions.groups).toHaveText(["APP RESET", "BEFORE EACH"])

      // …and the header stays once the action completes.
      ui.send(actionCompleted({ testFullName: DOUBLE_TAP, actionIndex: 1, action: "openDeepLink" }))
      await expect(actions.inProgressItems).toHaveCount(0)
      await expect(actions.groups).toHaveText(["APP RESET", "BEFORE EACH"])
    })

    test("clears a lingering in-flight action at run-end", async ({ app, explorer, actions }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
      await explorer.clickNode(TEST_NAME)
      ui.send(actionStarted({ testFullName: DOUBLE_TAP, actionIndex: 0, action: "waitFor" }))
      // Asserted positively first, so the toHaveCount(0) below can't pass just
      // because the in-flight locator matches nothing.
      await expect(actions.inProgressItems).toHaveCount(1)

      // A run aborted mid-action must not leave a spinner behind.
      ui.send({
        type: "run-end",
        status: "stopped",
        duration: 500,
        passed: 0,
        failed: 0,
        skipped: 0,
        interrupted: 1,
      })

      await expect(actions.inProgressItems).toHaveCount(0)
    })
  })

  test.describe("filmstrip", () => {
    // UI mode synthesises trace metadata with no start time, so the filmstrip
    // anchors on the earliest streamed event. Pins that live labels read from
    // zero and stay in step with the trace viewer's anchoring rule.
    test("labels frames relative to the first streamed event", async ({ app, explorer, filmstrip }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
      await explorer.clickNode(TEST_NAME)
      ui.send(...action({ testFullName: DOUBLE_TAP, actionIndex: 0, action: "appReset" }))
      ui.send(...action({ testFullName: DOUBLE_TAP, actionIndex: 1, action: "tap" }))

      await expect(filmstrip.frames).toHaveCount(2)
      // Completed events land 100ms apart in the builder.
      await expect(filmstrip.labels).toHaveText(["0ms", "100ms"])
    })
  })

  test.describe("run-end housekeeping", () => {
    test("returns tests left running to idle", async ({ app, explorer }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({ type: "run-start", fileCount: 1 })
      ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
      await expect(explorer.node(TEST_NAME)).toHaveAttribute("data-status", "running")

      // Stopped before this test reported a result.
      ui.send({
        type: "run-end",
        status: "stopped",
        duration: 400,
        passed: 0,
        failed: 0,
        skipped: 0,
        interrupted: 1,
      })

      await expect(explorer.node(TEST_NAME)).toHaveAttribute("data-status", "idle")
    })

    test("announces a stopped run", async ({ app, runControls }) => {
      const ui = app
      ui.send({ type: "run-start", fileCount: 1 })
      ui.send({
        type: "run-end",
        status: "stopped",
        duration: 400,
        passed: 0,
        failed: 0,
        skipped: 0,
        interrupted: 2,
      })

      await expect(runControls.notification).toHaveText("Run stopped (2 tests interrupted)")
    })
  })

  test.describe("#147 — runs an agent started", () => {
    // Fixed in 06eace0. An MCP-initiated run is announced with run-state
    // rather than a click, and the UI has to reflect that a run is underway.
    test("reflects a run started outside the UI", async ({ app, explorer }) => {
      const ui = app
      await expect(explorer.runAllButton).toBeEnabled()

      ui.send({ type: "run-state", isRunning: true, startedAt: Date.now() })

      await expect(explorer.runAllButton).toBeDisabled()
      await expect(explorer.stopButton).toBeEnabled()
    })
  })

  test.describe("run-progress", () => {
    // PILOT-232. Between-file device work happens outside any traced action, so
    // without this the Actions panel just sits there looking frozen. It only
    // surfaces for the test being viewed while that test is pending or running.
    test("surfaces a long device action instead of the generic wait", async ({
      app,
      explorer,
      actions,
    }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({ type: "run-start", fileCount: 1 })
      ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
      await explorer.clickNode(TEST_NAME)

      // With no device action in flight, the panel shows the generic message.
      await expect(actions.preflightMessage).toHaveText("Waiting for first action…")

      ui.send({
        type: "run-progress",
        workerId: 0,
        message: "Clearing app data (dev.tapsmith.testapp)…",
      })

      await expect(actions.preflightMessage).toHaveText("Clearing app data (dev.tapsmith.testapp)…")
    })
  })
})
