import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"
import { androidWindows, hierarchyXml, readHooksMarker } from "../utils/hooks-marker.js"

// PILOT-756 / PILOT-830: a locator matches only the app's own elements — not
// the software keyboard's keys, not the iOS application element (whose label
// is the app's name), not Android's status and navigation bars, and not the
// @tapsmith/react-native hooks marker. Each test also checks, in the
// hierarchy dump, that the thing left out really is on screen, so a pass
// cannot come from it being absent.

describe("Locators match only the app's own elements", () => {
  test("the keyboard's Done key does not make the app's Done button ambiguous", async ({ device, platform, keyboardScreen }) => {
    await openScreen(device, "/keyboard")
    await expect(keyboardScreen.counts).toBeVisible()
    await keyboardScreen.openKeyboard("done")
    expect(await device.isKeyboardShown()).toBe(true)
    // The keyboard has a Done key of its own: iOS's return key is a "Done"
    // button inside the keyboard, Gboard's a key described "Done" in the
    // input method's window (which the dump marks as not the app's).
    const xml = await hierarchyXml(device)
    if (platform === "ios") {
      expect(xml).toMatch(/<XCUIElementType(Keyboard|\(19\))[\s>][\s\S]*label="done"/i)
    } else {
      const ime = androidWindows(xml).find((w) => /^<node tapsmith-non-app="true"[^>]*package="[^"]*inputmethod/.test(w))
      expect(ime, "the input method's window is in the dump, marked as not the app's").toBeDefined()
      expect(ime).toContain('content-desc="Done"')
    }

    await expect(keyboardScreen.doneText).toHaveCount(1)
    await expect(keyboardScreen.doneButton).toHaveCount(1)
    await expect(keyboardScreen.doneDescription).toHaveCount(1)
    await keyboardScreen.doneButton.tap()
    await expect(keyboardScreen.doneTaps).toHaveText("done=1")
  })

  test("the hooks marker matches no locator", async ({ device, homeScreen }) => {
    await openScreen(device, "/")
    await expect(homeScreen.header).toBeVisible()
    const marker = await readHooksMarker(device)
    expect(marker?.text).toMatch(/^tapsmith-hooks:1;epoch=\d+;nav=\d+;/)

    await expect(device.getByTestId("tapsmith-hooks")).toHaveCount(0)
    await expect(device.getByText("epoch=")).toHaveCount(0)
    await expect(device.getByText(/^tapsmith-hooks:/)).toHaveCount(0)
  })

  test("the app's name matches its title, not the application element", async ({ device, platform, homeScreen }) => {
    await openScreen(device, "/")
    await expect(homeScreen.header).toBeVisible()
    if (platform === "ios") {
      expect(await hierarchyXml(device)).toMatch(/<XCUIElementType(Application|\(2\))\s[^>]*label="Tapsmith Test App"/)
    }
    await expect(homeScreen.navigationTitle).toHaveCount(1)
  })

  test("the status bar matches no locator", async ({ device, platform, homeScreen }) => {
    test.skip(platform !== "android", "iOS's status bar is not in the app's accessibility tree")
    await openScreen(device, "/")
    await expect(homeScreen.header).toBeVisible()
    // The status bar's clock, e.g. "10:06" (the test app shows no times).
    const xml = await hierarchyXml(device)
    const clock = /text="(\d{1,2}:\d{2})"/.exec(xml)?.[1]
    expect(clock, "the status bar clock is in the hierarchy").toBeDefined()
    // The dump marks the status bar's window so the trace viewer leaves it out too.
    expect(xml).toMatch(/<node tapsmith-non-app="true"[^>]*package="com\.android\.systemui"/)
    await expect(device.getByText(clock!, { exact: true })).toHaveCount(0)
  })
})
