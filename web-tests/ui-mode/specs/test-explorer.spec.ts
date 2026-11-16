import { test, expect } from "../fixtures.js"
import {
  GESTURES_FILE,
  idleSeed,
  nestedSuiteTree,
  singleFileTree,
  twoFileTree,
  twoProjectTree,
} from "../messages/scenarios.js"
import { projectNode } from "../messages/tree.js"

test.describe("Test explorer", () => {
  test("renders the tree from a test-tree message", async ({ app, explorer }) => {
    void app
    await expect(explorer.node("gestures.test.ts")).toBeVisible()
    // Files start collapsed, so the suite inside is not rendered yet.
    await expect(explorer.node("Gestures screen")).toHaveCount(0)
  })

  test("expands a file to reveal its suites and tests", async ({ app, explorer }) => {
    void app
    await explorer.clickNode("gestures.test.ts")
    await expect(explorer.node("Gestures screen")).toBeVisible()
    await expect(explorer.node("smoke")).toBeVisible()

    await explorer.clickNode("Gestures screen")
    await expect(explorer.node("double tap registers double tap gesture")).toBeVisible()
  })

  test("reports expansion state through aria-expanded", async ({ app, explorer }) => {
    void app
    const file = explorer.node("gestures.test.ts")
    await expect(file).toHaveAttribute("aria-expanded", "false")
    await file.click()
    await expect(file).toHaveAttribute("aria-expanded", "true")
    await file.click()
    await expect(file).toHaveAttribute("aria-expanded", "false")
  })

  test("expand all and collapse all reach the whole tree", async ({ ui, explorer }) => {
    ui.seed(idleSeed(twoFileTree()))
    await ui.open()

    await explorer.expandAll()
    await expect(explorer.node("double tap registers double tap gesture")).toBeVisible()
    await expect(explorer.node("displays navigation cards")).toBeVisible()

    await explorer.collapseAll()
    await expect(explorer.nodesOfType("test")).toHaveCount(0)
    await expect(explorer.nodesOfType("file")).toHaveCount(2)
  })

  test("marks the clicked node as selected", async ({ app, explorer }) => {
    void app
    const file = explorer.node("gestures.test.ts")
    await expect(file).toHaveAttribute("aria-selected", "false")
    await file.click()
    await expect(file).toHaveAttribute("aria-selected", "true")
  })

  test("nests a describe inside its parent describe", async ({ ui, explorer }) => {
    ui.seed(idleSeed(nestedSuiteTree()))
    await ui.open()
    await explorer.expandAll()

    // A two-segment chain is two nodes, not one flattened "Home screen > when
    // empty" — that is how the runner reports it, and the SPA keys expansion
    // and status off each node's own id.
    await expect(explorer.node("Home screen")).toHaveAttribute("aria-level", "2")
    await expect(explorer.node("when empty")).toHaveAttribute("aria-level", "3")
    await expect(explorer.node("shows the count")).toHaveAttribute("aria-level", "4")
    await expect(explorer.nodesOfType("suite")).toHaveCount(2)
  })

  test("collapsing an outer describe hides the inner one", async ({ ui, explorer }) => {
    ui.seed(idleSeed(nestedSuiteTree()))
    await ui.open()
    await explorer.expandAll()
    await expect(explorer.node("when empty")).toBeVisible()

    await explorer.clickNode("Home screen")
    await expect(explorer.node("when empty")).toHaveCount(0)
  })

  test("shows an empty state when there are no tests", async ({ ui, explorer }) => {
    ui.seed(idleSeed([]))
    await ui.open()
    await expect(explorer.emptyState).toHaveText("No tests found")
  })

  test.describe("name filter", () => {
    test("narrows the tree to matching tests", async ({ app, explorer }) => {
      void app
      await explorer.expandAll()
      await explorer.filterByName("long press")

      await expect(explorer.node("long press registers long press")).toBeVisible()
      await expect(explorer.node("double tap registers double tap gesture")).toHaveCount(0)
    })

    test("restores the full tree when cleared", async ({ app, explorer }) => {
      void app
      await explorer.expandAll()
      await explorer.filterByName("long press")
      await expect(explorer.node("double tap registers double tap gesture")).toHaveCount(0)

      await explorer.clearNameFilter()
      await expect(explorer.node("double tap registers double tap gesture")).toBeVisible()
    })
  })

  test.describe("status", () => {
    test("reflects a test-status message on the matching node", async ({ app, explorer }) => {
      const ui = app
      await explorer.expandAll()

      const node = explorer.node("double tap registers double tap gesture")
      await expect(node).toHaveAttribute("data-status", "idle")

      ui.send({
        type: "test-status",
        fullName: "Gestures screen > double tap registers double tap gesture",
        filePath: GESTURES_FILE,
        status: "passed",
        duration: 1234,
      })

      await expect(node).toHaveAttribute("data-status", "passed")
      await expect(explorer.durationFor("double tap registers double tap gesture")).toHaveText("1.2s")
    })

    test("filters to failures only", async ({ app, explorer }) => {
      const ui = app
      await explorer.expandAll()

      ui.send(
        {
          type: "test-status",
          fullName: "Gestures screen > double tap registers double tap gesture",
          filePath: GESTURES_FILE,
          status: "failed",
          error: "expected true to be false",
        },
        {
          type: "test-status",
          fullName: "Gestures screen > long press registers long press",
          filePath: GESTURES_FILE,
          status: "passed",
        },
      )

      await expect(explorer.node("double tap registers double tap gesture")).toHaveAttribute(
        "data-status",
        "failed",
      )

      await explorer.filterByStatus("Fail")
      await expect(explorer.node("double tap registers double tap gesture")).toBeVisible()
      await expect(explorer.node("long press registers long press")).toHaveCount(0)
    })

    test("counts each status in the filter badges", async ({ app, explorer }) => {
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
        },
        {
          type: "test-status",
          fullName: "Gestures screen > swipe registers swipe",
          filePath: GESTURES_FILE,
          status: "skipped",
        },
      )

      await expect(explorer.statusFilterCount("Pass")).toHaveText("1")
      await expect(explorer.statusFilterCount("Fail")).toHaveText("1")
      await expect(explorer.statusFilterCount("Skip")).toHaveText("1")
    })

    // PILOT-1178. Rows used to flash red on any running → failed change, and a
    // parent row is recomputed from all its children: running a passing test
    // beside an earlier failure took the file and describe rows from running to
    // failed, so they flashed as if the test just run had failed. The flash is
    // gone; the status icon carries the result.
    test("no row flashes when a passing test runs beside an earlier failure", async ({ app, explorer, page }) => {
      const ui = app
      await explorer.expandAll()

      ui.send({
        type: "test-status",
        fullName: "Gestures screen > double tap registers double tap gesture",
        filePath: GESTURES_FILE,
        status: "failed",
        error: "expected true to be false",
      })
      await expect(explorer.node("gestures.test.ts")).toHaveAttribute("data-status", "failed")

      const recorded = () =>
        page.evaluate(() => (window as unknown as { __animations: { name: string; onRow: boolean }[] }).__animations)

      // Record every CSS animation that starts from here on. `animationstart`
      // bubbles, so one capture listener sees rows and their descendants alike.
      await page.evaluate(() => {
        const w = window as unknown as { __animations: { name: string; onRow: boolean }[] }
        w.__animations = []
        document.addEventListener(
          "animationstart",
          (e) => {
            const target = e.target as Element
            w.__animations.push({ name: e.animationName, onRow: target.getAttribute("role") === "treeitem" })
          },
          true,
        )
      })

      const fullName = "Gestures screen > long press registers long press"
      // The message sequence the UI server sends for a single-test run.
      ui.send({ type: "run-start", fileCount: 1, filePath: GESTURES_FILE, testFilter: fullName })
      ui.send({ type: "file-status", filePath: GESTURES_FILE, status: "running" })
      ui.send({ type: "test-start", fullName, filePath: GESTURES_FILE })
      await expect(explorer.node("long press registers long press")).toHaveAttribute("data-status", "running")
      await expect(explorer.node("gestures.test.ts")).toHaveAttribute("data-status", "running")
      // Control: the running spinner's `spin` reaches the recorder, so an empty
      // list below means no row animated, not that nothing was recorded.
      await expect.poll(async () => (await recorded()).map((a) => a.name)).toContain("spin")

      ui.send({ type: "test-status", fullName, filePath: GESTURES_FILE, status: "passed", duration: 10 })
      ui.send({ type: "file-status", filePath: GESTURES_FILE, status: "done" })
      ui.send({ type: "run-end", status: "passed", duration: 10, passed: 1, failed: 0, skipped: 0 })

      await expect(explorer.node("long press registers long press")).toHaveAttribute("data-status", "passed")
      // The earlier failure still decides the parents' status...
      await expect(explorer.node("gestures.test.ts")).toHaveAttribute("data-status", "failed")
      await expect(explorer.node("Gestures screen")).toHaveAttribute("data-status", "failed")

      // ...but no row animated on the way there.
      // `animationstart` is dispatched on the frame after the class change, so
      // let two frames pass before reading what the recorder saw.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
      const rowAnimations = (await recorded()).filter((a) => a.onRow)
      expect(rowAnimations).toEqual([])
    })
  })

  test.describe("projects", () => {
    test("groups files under project nodes", async ({ ui, explorer }) => {
      ui.seed(idleSeed(twoProjectTree()))
      await ui.open()

      await expect(explorer.nodesOfType("project")).toHaveCount(2)
      await expect(explorer.node("[android]")).toBeVisible()
      await expect(explorer.node("[ios]")).toBeVisible()
    })

    test("keeps per-project status independent for a shared file", async ({ ui, explorer }) => {
      ui.seed(idleSeed(twoProjectTree()))
      await ui.open()
      await explorer.expandAll()

      // The same test exists under both projects; a scoped status must only
      // touch the project it names.
      ui.send({
        type: "test-status",
        fullName: "Gestures screen > double tap registers double tap gesture",
        filePath: GESTURES_FILE,
        status: "passed",
        projectName: "android",
      })

      // Exactly one leaf test goes green — the android copy. The ios copy of
      // the same file must stay idle.
      await expect(explorer.nodesOfTypeWithStatus("test", "passed")).toHaveCount(1)
    })
  })

  test("persists the selected test across a reload", async ({ app, explorer, page }) => {
    void app
    await explorer.clickNode("gestures.test.ts")
    await expect(explorer.node("gestures.test.ts")).toHaveAttribute("aria-selected", "true")

    await page.reload()
    await expect(explorer.node("gestures.test.ts")).toHaveAttribute("aria-selected", "true")
  })

  test("shows project dependencies on the project node", async ({ ui, explorer }) => {
    ui.seed(idleSeed(twoProjectTree()))
    await ui.open()
    await expect(explorer.dependenciesFor("[ios]")).toContainText("android")
  })

  test("keeps a single-file tree stable when re-seeded", async ({ app, explorer }) => {
    const ui = app
    ui.send({ type: "test-tree", files: singleFileTree() })
    await expect(explorer.nodesOfType("file")).toHaveCount(1)
  })

  test("shows no reset-policy chip on any row, even where use declares one", async ({ ui, explorer }) => {
    // A declared reset policy is configuration, not run state: the tree does
    // not badge it on any row (the trace's Metadata tab shows the isolation a
    // test actually ran under). The devices badge, which reads the same
    // `use`, still shows where it is declared.
    const files = singleFileTree()
    const file = files[0]
    file.use = { appReset: "clear" }
    const suite = file.children!.find((n) => n.type === "suite")!
    suite.use = { appReset: "restart", appResetScope: "test" }
    suite.children![0].use = { appReset: "restart", appResetScope: "test", appState: "./tapsmith-results/auth.tar.gz" }
    suite.children!.find((n) => n.name === "swipe registers swipe")!.use = { appResetScope: "file" }
    ui.seed(idleSeed([projectNode("pair", files, { use: { devices: 2, deviceNames: ["alice", "bob"], appReset: "warm", appState: "" } })]))
    await ui.open()
    await explorer.expandAllButton.click()

    await expect(explorer.devicesFor("[pair]")).toHaveText(/alice · bob/)
    for (const name of ["[pair]", "gestures.test.ts", "Gestures screen", "double tap registers double tap gesture", "swipe registers swipe"]) {
      await expect(explorer.node(name)).toBeVisible()
      await expect(explorer.node(name)).not.toContainText(/clear|restart|warm|state|per test|per file/)
    }
  })
})
