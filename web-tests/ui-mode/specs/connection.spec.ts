// Connection handling: what the SPA shows when the socket drops, and that it
// rehydrates rather than starting from scratch when it comes back.
//
// `use-websocket.ts` reconnects on a 1s timer, and the real server re-pushes the
// tree and run state on every connect — `FakeUiServer.seed()` replays the same
// way, so these exercise the genuine rehydration path.

import { test, expect } from "../fixtures.js"
import { idleSeed, singleFileTree, twoFileTree } from "../messages/scenarios.js"

test.describe("Connection", () => {
  test("reports the connected device in the top rail", async ({ app, runControls }) => {
    void app
    await expect(runControls.connection).toHaveText("emulator-5554")
  })

  test("shows Disconnected when the socket drops", async ({ app, runControls }) => {
    const ui = app
    ui.drop()
    await expect(runControls.connection).toHaveText("Disconnected")
  })

  test("reconnects and comes back usable", async ({ app, explorer, runControls }) => {
    const ui = app
    expect(ui.connections).toBe(1)

    ui.drop()
    await expect(runControls.connection).toHaveText("Disconnected")

    await expect.poll(() => ui.connections, { timeout: 5000 }).toBe(2)
    await expect(runControls.connection).toHaveText("emulator-5554")
    await expect(explorer.node("gestures.test.ts")).toBeVisible()
  })

  test("takes the tree the server pushes on reconnect", async ({ ui, explorer }) => {
    // The seed changes between connections, so this can only pass if the replayed
    // push actually drove the update — a tree that merely survived the drop would
    // still show one file.
    ui.seed(idleSeed(singleFileTree()))
    await ui.open()
    await expect(explorer.nodesOfType("file")).toHaveCount(1)

    ui.seed(idleSeed(twoFileTree()))
    ui.drop()

    await expect.poll(() => ui.connections, { timeout: 5000 }).toBe(2)
    await expect(explorer.nodesOfType("file")).toHaveCount(2)
    await expect(explorer.node("home.test.ts")).toBeVisible()
  })

  test("keeps reported results across the drop", async ({ ui, explorer, runControls }) => {
    // Whether they survive or are re-pushed, a reconnect must not silently reset
    // finished tests to idle.
    const passed = singleFileTree()
    passed[0].children![1].children![0].status = "passed"
    ui.seed(idleSeed(passed))
    await ui.open()

    await explorer.expandAll()
    await expect(explorer.nodesOfTypeWithStatus("test", "passed")).toHaveCount(1)

    ui.drop()
    await expect(runControls.connection).toHaveText("Disconnected")
    await expect.poll(() => ui.connections, { timeout: 5000 }).toBe(2)

    await explorer.expandAll()
    await expect(explorer.nodesOfTypeWithStatus("test", "passed")).toHaveCount(1)
  })

  test("does not issue any command of its own on reconnect", async ({
    app,
    runControls,
    explorer,
    page,
  }) => {
    const ui = app
    ui.clearReceived()

    ui.drop()
    await expect.poll(() => ui.connections, { timeout: 5000 }).toBe(2)
    await expect(runControls.connection).toHaveText("emulator-5554")
    await page.waitForTimeout(300)

    expect(ui.received).toEqual([])

    // And recording is working, so the empty array above means silence rather
    // than a harness that stopped listening.
    await explorer.runAllButton.click()
    await ui.waitForMessage("run-all")
  })

  test("disables run controls while disconnected", async ({ app, explorer }) => {
    const ui = app
    ui.drop()
    await expect(explorer.runAllButton).toBeDisabled()
  })

  test("surfaces a server error message", async ({ app, runControls }) => {
    const ui = app
    ui.send({ type: "error", message: "Device disconnected: emulator-5554" })

    await expect(runControls.notification).toHaveText("Device disconnected: emulator-5554")
    // An error is assertive, unlike the polite notices — worth pinning too.
    await expect(runControls.errorBanner).toHaveCount(1)
  })

  // PILOT-1398: the app's source changed after the build the session tests.
  test("shows a server notice in the polite banner", async ({ app, runControls }) => {
    const ui = app
    const message = "src/app/todos.tsx changed after app-release.apk was built. Tapsmith tests the installed build, not your source: rebuild the app to test the change."
    ui.send({ type: "notice", message })

    await expect(runControls.notification).toHaveText(message)
    await expect(runControls.errorBanner).toHaveCount(0)
  })
})
