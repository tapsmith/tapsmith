import { test, expect } from "../fixtures.js"
import { GESTURES_FILE, HOME_FILE, idleSeed, twoFileTree, twoProjectTree } from "../messages/scenarios.js"

test.describe("Run controls", () => {
  test.describe("commands the SPA sends", () => {
    test("run-all from the toolbar", async ({ app, explorer }) => {
      const ui = app
      await explorer.runAllButton.click()
      await ui.waitForMessage("run-all")
    })

    test("run-test carries the test's fullName and filePath", async ({ app, explorer }) => {
      const ui = app
      await explorer.expandAll()
      await explorer.runNode("double tap registers double tap gesture")

      const msg = await ui.waitForMessage("run-test")
      expect(msg.fullName).toBe("Gestures screen > double tap registers double tap gesture")
      expect(msg.filePath).toBe(GESTURES_FILE)
    })

    test("run-file carries the file path", async ({ ui, explorer }) => {
      ui.seed(idleSeed(twoFileTree()))
      await ui.open()

      await explorer.runNode("home.test.ts")
      const msg = await ui.waitForMessage("run-file")
      expect(msg.filePath).toBe(HOME_FILE)
    })

    test("run-project carries the project name", async ({ ui, explorer }) => {
      ui.seed(idleSeed(twoProjectTree()))
      await ui.open()

      await explorer.runNode("[ios]")
      const msg = await ui.waitForMessage("run-project")
      expect(msg.projectName).toBe("ios")
    })

    test("run-test in a multi-project tree names the owning project", async ({ ui, explorer }) => {
      ui.seed(idleSeed(twoProjectTree()))
      await ui.open()
      await explorer.expandAll()

      // Both projects contain this test; the one under [ios] must route there.
      const iosTest = explorer
        .node("double tap registers double tap gesture")
        .last()
      await iosTest.hover()
      await iosTest.getByRole("button", { name: /^Run / }).click()

      const msg = await ui.waitForMessage("run-test")
      expect(msg.projectName).toBe("ios")
    })

    test("toggle-watch for the whole tree", async ({ app, explorer }) => {
      const ui = app
      await explorer.watchAllButton.click()
      const msg = await ui.waitForMessage("toggle-watch")
      expect(msg.filePath).toBe("all")
    })

    test("toggle-watch for one test passes it as a filter", async ({ app, explorer }) => {
      const ui = app
      await explorer.expandAll()
      await explorer.toggleWatchOn("long press registers long press")

      const msg = await ui.waitForMessage("toggle-watch")
      expect(msg.filePath).toBe(GESTURES_FILE)
      expect(msg.testFilter).toBe("Gestures screen > long press registers long press")
    })

    test("stop-run while a run is in flight", async ({ app, explorer }) => {
      const ui = app
      ui.send({ type: "run-start", fileCount: 1 })

      await expect(explorer.stopButton).toBeEnabled()
      await explorer.stopButton.click()
      await ui.waitForMessage("stop-run")
    })
  })

  // Playwright's UI mode runs only the tests visible in a filtered tree; so
  // does ours (PILOT-729). Before, Run all ignored the filter and started the
  // whole suite on every device.
  test.describe("Run all with a filter applied", () => {
    test("runs only the tests the name filter leaves visible", async ({ ui, explorer }) => {
      ui.seed(idleSeed(twoFileTree()))
      await ui.open()

      await explorer.filterByName("long press")
      await expect(explorer.runAllButton).toHaveCount(0)
      await explorer.runVisibleButton.click()

      const msg = await ui.waitForMessage("run-all")
      expect(msg.selection).toEqual([
        { filePath: GESTURES_FILE, tests: ["Gestures screen > long press registers long press"] },
      ])
    })

    test("runs the visible test under each project, named by its project", async ({ ui, explorer }) => {
      ui.seed(idleSeed(twoProjectTree()))
      await ui.open()

      await explorer.filterByName("swipe registers")
      await explorer.runVisibleButton.click()

      const msg = await ui.waitForMessage("run-all")
      expect(msg.selection).toEqual([
        { filePath: GESTURES_FILE, projectName: "android", tests: ["Gestures screen > swipe registers swipe"] },
        { filePath: GESTURES_FILE, projectName: "ios", tests: ["Gestures screen > swipe registers swipe"] },
      ])
    })

    test("runs only the failures the Fail filter shows", async ({ ui, explorer }) => {
      ui.seed(idleSeed(twoFileTree()))
      await ui.open()
      ui.send(
        { type: "test-status", fullName: "Gestures screen > swipe registers swipe", filePath: GESTURES_FILE, status: "failed", error: "boom" },
        { type: "test-status", fullName: "Home screen > displays navigation cards", filePath: HOME_FILE, status: "failed", error: "boom" },
        { type: "test-status", fullName: "smoke", filePath: GESTURES_FILE, status: "passed" },
      )
      await expect(explorer.statusFilterCount("Fail")).toHaveText("2")

      await explorer.filterByStatus("Fail")
      await explorer.runVisibleButton.click()

      const msg = await ui.waitForMessage("run-all")
      expect(msg.selection).toEqual([
        { filePath: GESTURES_FILE, tests: ["Gestures screen > swipe registers swipe"] },
        { filePath: HOME_FILE, tests: ["Home screen > displays navigation cards"] },
      ])
    })

    test("r runs the visible tests too", async ({ ui, explorer, runControls }) => {
      ui.seed(idleSeed(twoFileTree()))
      await ui.open()
      await explorer.filterByName("can scroll")
      // Shortcuts are plain text while focus is in the filter box.
      await explorer.searchInput.blur()

      await runControls.pressShortcut("r")
      const msg = await ui.waitForMessage("run-all")
      expect(msg.selection).toEqual([
        { filePath: HOME_FILE, tests: ["Home screen > can scroll to see more cards"] },
      ])
    })

    test("is disabled when the filter leaves nothing visible", async ({ app, explorer }) => {
      await explorer.filterByName("no test is called this")
      await expect(explorer.emptyState).toBeVisible()
      await expect(explorer.runVisibleButton).toBeDisabled()
    })

    test("runs the whole suite again once the filter is cleared", async ({ app, explorer }) => {
      const ui = app
      await explorer.filterByName("long press")
      await explorer.clearNameFilter()

      await explorer.runAllButton.click()
      const msg = await ui.waitForMessage("run-all")
      expect(msg.selection).toBeUndefined()
    })
  })

  test.describe("keyboard shortcuts", () => {
    test("r runs everything", async ({ app, runControls }) => {
      const ui = app
      await runControls.pressShortcut("r")
      await ui.waitForMessage("run-all")
    })

    test("w toggles watch", async ({ app, runControls }) => {
      const ui = app
      await runControls.pressShortcut("w")
      const msg = await ui.waitForMessage("toggle-watch")
      expect(msg.filePath).toBe("all")
    })

    test("Escape stops a running suite", async ({ app, runControls }) => {
      const ui = app
      ui.send({ type: "run-start", fileCount: 1 })
      await runControls.pressShortcut("Escape")
      await ui.waitForMessage("stop-run")
    })

    test("f re-runs failures once something has failed", async ({ app, runControls, explorer }) => {
      const ui = app
      ui.send({
        type: "test-status",
        fullName: "Gestures screen > double tap registers double tap gesture",
        filePath: GESTURES_FILE,
        status: "failed",
        error: "boom",
      })
      await expect(explorer.statusFilterCount("Fail")).toHaveText("1")

      await runControls.pressShortcut("f")
      await ui.waitForMessage("run-failed")
    })

    test("typing in the filter box does not trigger a run", async ({ app, explorer, page }) => {
      const ui = app
      // "r" and "w" are run-all and toggle-watch as bare keys. While focus is
      // in the search input they must be plain text — otherwise filtering for
      // "swipe" would kick off a run mid-word.
      await explorer.searchInput.click()
      await explorer.searchInput.pressSequentially("swipe")

      await expect(explorer.searchInput).toHaveValue("swipe")
      // Settle before concluding nothing was sent, as the #103 specs do.
      await page.waitForTimeout(300)
      expect(ui.received).toEqual([])
    })
  })

  test.describe("counts and timing", () => {
    test("summarises results in the top rail", async ({ app, runControls }) => {
      const ui = app
      ui.send(
        {
          type: "test-status",
          fullName: "Gestures screen > double tap registers double tap gesture",
          filePath: GESTURES_FILE,
          status: "passed",
        },
        {
          type: "test-status",
          fullName: "Gestures screen > long press registers long press",
          filePath: GESTURES_FILE,
          status: "failed",
          error: "boom",
        },
        {
          type: "test-status",
          fullName: "Gestures screen > swipe registers swipe",
          filePath: GESTURES_FILE,
          status: "skipped",
        },
      )

      await expect(runControls.passedCount).toHaveText("1 passed")
      await expect(runControls.failedCount).toHaveText("1 failed")
      await expect(runControls.skippedCount).toHaveText("1 skipped")
    })

    test("shows an elapsed timer only while running", async ({ app, runControls }) => {
      const ui = app
      await expect(runControls.elapsed).toHaveCount(0)

      ui.send({ type: "run-start", fileCount: 1 })
      await expect(runControls.elapsed).toBeVisible()

      ui.send({
        type: "run-end",
        status: "passed",
        duration: 1500,
        passed: 1,
        failed: 0,
        skipped: 0,
      })
      await expect(runControls.elapsed).toHaveCount(0)
    })

    test("offers Rerun Failed only once a test has failed", async ({ app, runControls }) => {
      const ui = app
      await expect(runControls.rerunFailedButton).toHaveCount(0)

      ui.send({
        type: "test-status",
        fullName: "Gestures screen > double tap registers double tap gesture",
        filePath: GESTURES_FILE,
        status: "failed",
        error: "boom",
      })

      await expect(runControls.rerunFailedButton).toBeVisible()
      await runControls.rerunFailed()
      await ui.waitForMessage("run-failed")
    })
  })

  test.describe("run gating", () => {
    test("disables run buttons while a run is in flight", async ({ app, explorer }) => {
      const ui = app
      ui.send({ type: "run-start", fileCount: 1 })

      await expect(explorer.runAllButton).toBeDisabled()

      ui.send({
        type: "run-end",
        status: "passed",
        duration: 100,
        passed: 1,
        failed: 0,
        skipped: 0,
      })
      await expect(explorer.runAllButton).toBeEnabled()
    })

    test("disables the stop button when nothing is running", async ({ app, explorer }) => {
      void app
      await expect(explorer.stopButton).toBeDisabled()
    })
  })
})
