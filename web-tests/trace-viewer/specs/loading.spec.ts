// Loading a trace archive: the viewer's entry point, and how it behaves when the
// archive is missing, malformed or unreachable.

import { test, expect } from "../fixtures.js"
import { actionEvent } from "../trace-builder.js"

test.describe("Loading a trace", () => {
  test("renders the test summary from metadata", async ({ viewer, filmstrip }) => {
    await viewer.open({
      metadata: {
        testName: "Gestures screen > double tap registers double tap gesture",
        testFile: "/repo/e2e/tests/gestures.test.ts",
        testDuration: 1200,
      },
      events: [actionEvent({ actionIndex: 0, action: "tap" })],
    })

    await expect(filmstrip.summary).toContainText("double tap registers double tap gesture")
    await expect(filmstrip.summary).toContainText("gestures.test.ts")
    await expect(filmstrip.summary).toContainText("1200ms")
  })

  test("names the project in the breadcrumb when one is set", async ({ viewer, filmstrip }) => {
    await viewer.open({
      metadata: { project: "ios" },
      events: [actionEvent({ actionIndex: 0, action: "tap" })],
    })
    await expect(filmstrip.summary).toContainText("ios")
  })

  test("reports the device", async ({ viewer, filmstrip }) => {
    await viewer.open({
      metadata: { device: { serial: "emulator-5554", model: "Pixel 8", isEmulator: true } },
      events: [actionEvent({ actionIndex: 0, action: "tap" })],
    })
    await expect(filmstrip.summary).toContainText("Pixel 8")
  })

  test("shows the isolation the test ran under in the Metadata tab", async ({ viewer, actions }) => {
    await viewer.open({
      metadata: { appReset: "warm", appResetScope: "test" },
      events: [actionEvent({ actionIndex: 0, action: "tap" })],
    })
    await actions.metadataTab.click()
    await expect(actions.isolation).toHaveText("warm · per test")
  })

  test("shows how network traffic was captured in the Metadata tab", async ({ viewer, actions }) => {
    await viewer.open({
      metadata: {
        device: { serial: "8C2F-SIM", platform: "ios", isEmulator: true, networkCaptureRoute: "ios-system-proxy" },
      },
      events: [actionEvent({ actionIndex: 0, action: "tap" })],
    })
    await actions.metadataTab.click()
    await expect(actions.networkRoute).toHaveText("macOS system proxy (host-wide)")
  })

  test("renders one filmstrip frame per traced event", async ({ viewer, filmstrip }) => {
    await viewer.open({
      events: [
        actionEvent({ actionIndex: 0, action: "tap" }),
        actionEvent({ actionIndex: 1, action: "doubleTap" }),
        actionEvent({ actionIndex: 2, action: "swipe" }),
      ],
    })
    await expect(filmstrip.frames).toHaveCount(3)
  })

  test("shows the drop zone with no trace parameter", async ({ viewer, page }) => {
    await viewer.openEmpty()
    // Asserted on the drop zone itself, not on body text: the error state also
    // offers "Choose a trace file", so a loose /drop|choose/ match passed there
    // too — the two states were indistinguishable.
    await expect(page.getByTestId("trace-drop-zone")).toBeVisible()
    await expect(page.getByTestId("load-error")).toHaveCount(0)
  })

  test("surfaces a failed fetch rather than hanging", async ({ viewer, page }) => {
    await viewer.openWithFetchFailure(500)

    await expect(page.getByTestId("load-error")).toBeVisible()
    // The status has to reach the message, or the viewer reports a failure
    // without saying what failed.
    await expect(page.getByTestId("load-error-detail")).toContainText("500")
    await expect(page.getByTestId("trace-drop-zone")).toHaveCount(0)
  })

  test("surfaces an archive with no metadata.json", async ({ viewer, page }) => {
    await viewer.open({ omitMetadata: true })

    await expect(page.getByTestId("load-error")).toBeVisible()
    await expect(page.getByTestId("load-error-detail")).toContainText("metadata.json")
  })

  test("loads an archive with no events at all", async ({ viewer, actions, filmstrip }) => {
    // A test that failed before its first action still produces an archive.
    await viewer.open({
      metadata: { testName: "Gestures screen > smoke", testStatus: "failed", error: "boom" },
      events: [],
    })

    // Asserted positively first: an empty action list on its own also describes
    // a viewer that failed to load at all.
    await expect(filmstrip.summary).toContainText("Gestures screen > smoke")
    await expect(actions.items).toHaveCount(0)
  })
})
