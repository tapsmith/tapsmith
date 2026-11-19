import type { Device } from "tapsmith"
import { describe, expect, test } from "../fixtures.js"
import type { TurnedScreen } from "../screens/turned.screen.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-984: on a turned iOS screen the agent planned its gestures in the
// app's interface points and pressed them as if the screen were upright, so
// they landed somewhere else, or off the screen. The pad sits past the
// upright screen's width when turned, so a gesture that is not turned back
// misses it altogether. Each test runs in landscape; the runner turns the
// device back after it.

/** Turn to landscape, or skip when the app's UI does not turn with the device. */
async function turn(device: Device, turnedScreen: TurnedScreen) {
  const portrait = await turnedScreen.pad.boundingBox()
  await device.setOrientation("landscape")
  await expect(turnedScreen.pad).toBeVisible()
  const landscape = await turnedScreen.pad.boundingBox()
  // Some simulator runtimes turn the device but not the app: then there is
  // no turned screen to touch.
  test.skip(
    !portrait || !landscape || landscape.x <= portrait.x + 50,
    "the app's UI did not rotate on this device, so its gestures are not turned either",
  )
}

describe("Gestures on a turned screen", () => {
  test.beforeEach(async ({ device, turnedScreen }) => {
    await openScreen(device, "/turned")
    await expect(turnedScreen.padResult).toBeVisible()
    await turn(device, turnedScreen)
  })

  test("tap() lands on the element", async ({ turnedScreen }) => {
    const before = await turnedScreen.padCount()
    await turnedScreen.pad.tap()
    await expect(turnedScreen.padResult).toHaveText(`Pad ${before + 1}: tap`)
  })

  test("scroll() on an element swipes it the way asked", async ({ turnedScreen }) => {
    const before = await turnedScreen.padCount()
    // Scrolling down moves the finger up.
    await turnedScreen.pad.scroll("down")
    await expect(turnedScreen.padResult).toHaveText(`Pad ${before + 1}: swipe up`)
  })

  test("device.swipe() swipes the screen the way asked", async ({ device, turnedScreen }) => {
    const before = await turnedScreen.padCount()
    await device.swipe("left")
    await expect(turnedScreen.padResult).toHaveText(`Pad ${before + 1}: swipe left`)
  })

  // Straight after the turn, with no locator in between: nothing has read
  // the turned screen yet, so the swipe must not be planned on the screen as
  // it was before the turn. Without a trace, as a trace's capture after the
  // turn would read the screen.
  describe("with nothing reading the screen in between", () => {
    test.use({ trace: "off" })

    test("device.swipe() straight after turning back swipes the way asked", async ({ device, turnedScreen }) => {
      const before = await turnedScreen.padCount()
      await device.setOrientation("portrait")
      await device.swipe("left")
      await expect(turnedScreen.padResult).toHaveText(`Pad ${before + 1}: swipe left`)
    })
  })

  test("pinchOut() pinches the element open", async ({ turnedScreen }) => {
    const before = await turnedScreen.padCount()
    await turnedScreen.pad.pinchOut({ scale: 2 })
    await expect(turnedScreen.padResult).toHaveText(`Pad ${before + 1}: pinch out`)
  })

  test("selectOption() opens the dropdown and picks", async ({ turnedScreen }) => {
    await turnedScreen.sizeButton.selectOption("Large")
    await expect(turnedScreen.sizeChosen).toHaveText("Size: Large")
  })

  test("type() focuses the field and types into it", async ({ turnedScreen }) => {
    await turnedScreen.field.type("turned")
    await expect(turnedScreen.field).toHaveValue("turned")
  })

  // BACK taps the navigation bar's back button, which the agent finds in
  // the screen's tree and touches itself.
  test("pressBack() goes back", async ({ device, homeScreen, turnedScreen }) => {
    await device.pressBack()
    await expect(homeScreen.header).toBeVisible()
    await expect(turnedScreen.pad).toBeHidden()
  })
})
