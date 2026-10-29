import { describe, expect, test } from "../fixtures.js"

/**
 * Regression: the agent must resolve and act on visible elements even when the
 * screen never goes idle.
 *
 * The Animating screen runs a continuous JS-driven animation plus an
 * indeterminate spinner, so the accessibility-event stream never quiets.
 * Before the WaitEngine fix, the Android agent gated element resolution on
 * UiAutomator global idle, so every query blocked for its full timeout and the
 * daemon's per-command deadline fired ("Agent command timed out after 5.5s")
 * even though the targets below are fully visible. These assertions should now
 * complete promptly.
 */
describe("Animating screen (never-idle)", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///animating")
  })

  test("resolves visible elements while the screen never settles", async ({ animatingScreen }) => {
    await expect(animatingScreen.heading).toBeVisible()
    await expect(animatingScreen.status).toBeVisible()
    await expect(animatingScreen.stopButton).toBeVisible()
  })

  // ARIA and both platforms call an indeterminate indicator a progressbar
  // (PILOT-797); a role-only match binds the indicator itself.
  test("an ActivityIndicator is a progressbar", async ({ animatingScreen }) => {
    await expect(animatingScreen.progress).toHaveRole("progressbar")
    const png = await animatingScreen.progress.screenshot()
    expect(png.length).toBeGreaterThan(0)
  })

  test("taps a stable button on a perpetually-animated screen", async ({ animatingScreen }) => {
    await animatingScreen.stopButton.tap()
    await expect(animatingScreen.stoppedStatus).toBeVisible()
  })
})
