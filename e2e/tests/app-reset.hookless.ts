import { test, describe, expect } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"
import { readHooksMarker } from "../utils/hooks-marker.js"

/**
 * The reset ladder against a build WITHOUT the in-app hooks — the
 * out-of-the-box path every app is on before it integrates
 * `@tapsmith/react-native`. Detection must come up empty, warm requests must
 * fall back honestly, and plain deep links must settle through the
 * resumed-activity heuristic (there is no nav counter to acknowledge them).
 *
 * Deliberately NOT named `*.test.ts`: every regular config globs that, and
 * these assertions are wrong for a hooked build. Only
 * `tapsmith.config.android-ci-hookless.mjs` matches this file, run by
 * `.github/workflows/e2e-android-hookless.yml` against an APK built without
 * `EXPO_PUBLIC_TAPSMITH_HOOKS`.
 */
describe("App reset (no in-app hooks)", () => {
  // These tests exercise resets explicitly; the declared reset would only
  // slow them down (every reset here is a cold relaunch).
  test.use({ appReset: "none" })

  test("the app renders no hooks marker", async ({ device }) => {
    await openScreen(device, "/")
    await expect(device.getByText("Test Screens", { exact: true })).toBeVisible()
    // No locator matches a marker even when there is one (PILOT-830), so
    // look for it in the hierarchy, where Tapsmith itself looks.
    expect(await readHooksMarker(device)).toBeUndefined()
  })

  test("a warm request reports no hooks and falls back to a cold relaunch", async ({ device }) => {
    const result = await device.resetApp({ target: "/" })
    expect(result.hooksDetected).toBe(false)
    expect(result.fellBack).toBe(true)
    expect(["restart", "clear"]).toContain(result.modeUsed)
    expect(result.coldLaunch).toBe(true)
    // The exact phrasing is the daemon's to choose; the fallback must carry a
    // human-readable reason.
    expect(result.reason).toBeTruthy()
    await expect(device.getByText("Test Screens", { exact: true })).toBeVisible()
  })

  test("warm without fallback fails instead of pretending", async ({ device }) => {
    let error: unknown
    try {
      await device.resetApp({ mode: "warm", fallback: false })
    } catch (e) {
      error = e
    }
    expect(error).toBeTruthy()
  })

  test("a same-route deep link settles without a nav ack", async ({ device }) => {
    // Two links to the same screen: the second is unverifiable by any
    // screen-change heuristic, so this exercises the bounded settle path
    // (resumed-activity check) rather than the marker acknowledgement.
    await openScreen(device, "/gestures")
    await expect(device.getByText("Gestures", { exact: true }).first()).toBeVisible()
    await openScreen(device, "/gestures")
    await expect(device.getByText("Gestures", { exact: true }).first()).toBeVisible()
  })
})
