import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"
import { hierarchyXml, readHooksMarker } from "../utils/hooks-marker.js"

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
    if (platform === "ios") {
      // The keyboard's return key is a "Done" button inside the keyboard.
      expect(await hierarchyXml(device)).toMatch(/<XCUIElementType(Keyboard|\(19\))\b[\s\S]*label="Done"/)
    }

    await expect(keyboardScreen.doneText).toHaveCount(1)
    await expect(keyboardScreen.doneButton).toHaveCount(1)
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
      expect(await hierarchyXml(device)).toMatch(/<XCUIElementType(Application|\(2\))\b[^>]*label="Tapsmith Test App"/)
    }
    await expect(homeScreen.navigationTitle).toHaveCount(1)
  })

  test("the status bar matches no locator", async ({ device, platform, homeScreen }) => {
    test.skip(platform !== "android", "iOS's status bar is not in the app's accessibility tree")
    await openScreen(device, "/")
    await expect(homeScreen.header).toBeVisible()
    // The status bar's clock, e.g. "10:06" (the test app shows no times).
    const clock = /text="(\d{1,2}:\d{2})"/.exec(await hierarchyXml(device))?.[1]
    expect(clock, "the status bar clock is in the hierarchy").toBeDefined()
    await expect(device.getByText(clock!, { exact: true })).toHaveCount(0)
  })
})
