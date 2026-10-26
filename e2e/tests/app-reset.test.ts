import type { Device } from "tapsmith"
import { test, describe, expect } from "../fixtures.js"
import type { LoginScreen } from "../screens/login.screen"
import { readHooksMarker } from "../utils/hooks-marker.js"

/**
 * The reset ladder end to end against the test app, which mounts
 * `@tapsmith/react-native`: warm in-app resets are acknowledged, land on the
 * requested route, and fall back honestly when warm delivery is impossible.
 */
describe("App reset (declared isolation)", () => {
  // These tests exercise resets explicitly; a per-test reset in front of them
  // would only add noise to the timings they assert on.
  test.use({ appReset: "none" })

  test.beforeAll(async ({ device }) => {
    await device.resetApp({ target: "/" })
  })

  async function signIn(device: Device, loginScreen: LoginScreen) {
    await device.openDeepLink("tapsmithtest:///login")
    // Nothing resets the app between attempts here (`appReset: "none"`), so a
    // retry — or the next test — can reach the login route with the previous
    // attempt's session still active, where the form is replaced by "Login
    // successful!" and a Log out button. Sign out first so one failed attempt
    // cannot cascade through every retry in the file.
    const logOut = device.getByRole("button", { name: "Log out" })
    // exists() is non-waiting (PILOT-344): settle on the login route — in
    // either of its states — before branching on which one is showing.
    // expect.poll defaults to 5 s regardless of the config timeout; a cold CI
    // emulator can take longer than that to render the route.
    await expect
      .poll(async () => (await logOut.count()) + (await loginScreen.heading.count()), {
        timeout: device._getDefaultTimeout(),
      })
      .toBeGreaterThan(0)
    // The poll has just read which state is showing; branch on a single
    // count() read rather than exists(), which would confirm a miss with an
    // idle wait the settle already paid for.
    if ((await logOut.count()) > 0) {
      await logOut.tap()
      await expect(loginScreen.heading).toBeVisible()
    }
    await loginScreen.emailField.clearAndType("test@example.com")
    await loginScreen.passwordField.clearAndType("password123")
    await device.hideKeyboard()
    await loginScreen.signInButton.tap()
    await expect(device.getByText("Login successful!", { exact: true })).toBeVisible()
  }

  test("a warm reset is acknowledged by the in-app hooks and signs the user out", async ({ device, loginScreen }) => {
    await signIn(device, loginScreen)

    // No locator matches the marker (PILOT-830): read it from the hierarchy.
    const before = (await readHooksMarker(device))?.text
    const epochBefore = Number(/epoch=(\d+)/.exec(before ?? "")?.[1] ?? "-1")
    expect(epochBefore).toBeGreaterThanOrEqual(0)

    const result = await device.resetApp({ target: "/" })

    expect(result.hooksDetected).toBe(true)
    expect(result.modeUsed).toBe("warm")
    expect(result.fellBack).toBe(false)
    // Generous bound: a warm reset takes ~1s, a clear+relaunch 5-10s even on
    // cold software-GPU CI emulators — this only has to tell the two apart.
    expect(result.durationMs).toBeLessThan(15_000)
    // The daemon's warm-window valve (appResetColdEvery) may make this very
    // reset a cold delivery: the process is new, so its epoch restarts at 1
    // rather than continuing from the previous process's count. Which reset
    // in the run this is depends on the files that ran before it.
    if (result.coldLaunch) expect(result.epochAfter).toBeGreaterThanOrEqual(1)
    else expect(result.epochAfter).toBe(epochBefore + 1)
    // Cleared AsyncStorage + in-memory auth: the profile gate redirects to login.
    await device.openDeepLink("tapsmithtest:///profile")
    await expect(device.getByText("Sign In", { exact: true })).toBeVisible()
  })

  test("a warm reset lands on the requested route", async ({ device }) => {
    const result = await device.resetApp({ target: "/gestures" })
    expect(result.modeUsed).toBe("warm")
    await expect(device.getByText("Gestures", { exact: true }).first()).toBeVisible()
  })

  test("falls back to a restart when the app is not running", async ({ device }) => {
    await device.terminateApp()
    const result = await device.resetApp({ mode: "warm", fallback: true })
    expect(["restart", "clear"]).toContain(result.modeUsed)
    expect(result.fellBack).toBe(true)
    // The exact phrasing is the daemon's to choose; what matters is that the
    // fallback carries a human-readable reason at all.
    expect(result.reason).toBeTruthy()
    await expect(device.getByText("Test Screens", { exact: true })).toBeVisible()
  })

  test("a restart keeps persisted data; a clear wipes it", async ({ device, loginScreen }) => {
    await signIn(device, loginScreen)

    const restart = await device.resetApp({ mode: "restart", fallback: false })
    expect(restart.modeUsed).toBe("restart")
    expect(restart.coldLaunch).toBe(true)
    await device.openDeepLink("tapsmithtest:///profile")
    await expect(device.getByText("Authenticated", { exact: true })).toBeVisible()

    const clear = await device.resetApp({ mode: "clear", fallback: false })
    expect(clear.modeUsed).toBe("clear")
    await device.openDeepLink("tapsmithtest:///profile")
    await expect(device.getByText("Sign In", { exact: true })).toBeVisible()
  })

  test("a warm reset onto a marker-hiding route still confirms warm", async ({ device, loginScreen }) => {
    // A route that renders a full-screen accessibility-modal (here expo-router's
    // not-found screen for an unknown target) hides even the always-present
    // hooks marker from the hierarchy, so the epoch can't be read on that
    // screen. The reset still runs; the daemon recovers by re-confirming on the
    // readable root route. That recovery must come *instead of* the iOS
    // relaunch fallback, not after it: three terminate → relaunch cycles that
    // cannot read the epoch either used to put this reset at ~47s locally.
    await signIn(device, loginScreen)

    const startedAt = Date.now()
    const result = await device.resetApp({ target: "/no-such-route-xyz" })
    expect(result.modeUsed).toBe("warm")
    expect(result.fellBack).toBe(false)
    // Budget: the 11s warm window on the unreadable route, then the root
    // re-confirmation — itself up to a warm window plus one cold relaunch on a
    // slow CI simulator (observed 48s there, ~23s locally). The regression
    // this guards adds three more relaunch cycles on top (~35-45s), so the
    // bound only has to sit between the two.
    expect(Date.now() - startedAt).toBeLessThan(75_000)

    // The reset cleared state despite the unreadable target screen.
    await device.openDeepLink("tapsmithtest:///profile")
    await expect(device.getByText("Sign In", { exact: true })).toBeVisible()
  })
})
