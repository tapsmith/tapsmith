import { describe, expect, openScreen, test } from "./fixtures.js"

describe("Native: TabView", () => {
  test.beforeEach(async ({ device, tabs }) => {
    await openScreen(device, "tabs")
    await expect(tabs.content("Feed")).toBeVisible()
  })

  test("tab items are tabs inside a tablist", async ({ tabs }) => {
    await expect(tabs.tabBar).toBeVisible()
    await expect(tabs.tab("Search")).toHaveRole("tab")
    await expect(tabs.tab("Feed", { selected: true })).toBeVisible()
  })

  test("tapping a tab switches content", async ({ tabs }) => {
    await tabs.tab("Profile").tap()
    await expect(tabs.content("Profile")).toBeVisible()
    await expect(tabs.content("Feed")).toBeHidden()
  })
})

describe("Native: gestures", () => {
  test.beforeEach(async ({ device, gestures }) => {
    await openScreen(device, "gestures")
    await expect(gestures.status("Waiting")).toBeVisible()
  })

  test("long press", async ({ gestures }) => {
    await gestures.longPressTarget.longPress(1200)
    await expect(gestures.status("Long pressed")).toBeVisible()
  })

  // BUG PILOT-795: doubleTap() never triggers onTapGesture(count: 2), at any intervalMs.
  test.skip("double tap", async ({ gestures }) => {
    await gestures.doubleTapTarget.doubleTap()
    await expect(gestures.status("Double tapped")).toBeVisible()
  })

  test("drag across a DragGesture area", async ({ device, gestures }) => {
    const box = await gestures.swipeArea.boundingBox()
    if (!box) throw new Error("swipe area has no bounds")
    const y = box.y + box.height / 2
    await device.dragXY({ x: box.x + box.width - 30, y }, { x: box.x + 30, y })
    await expect(gestures.status("Swiped left")).toBeVisible()
  })
})

describe("Native: slow load", () => {
  // Navigates by tapping, not deep link: the screen loads in 3s, and a
  // hookless deep link can take ~10s to settle.
  test("auto-waits through a ProgressView", async ({ device, home, slowLoad }) => {
    await openScreen(device, "")
    await home.row("Slow Load").tap()
    await expect(slowLoad.progress).toBeVisible()
    await expect(slowLoad.loaded).toBeVisible()
    await expect(slowLoad.progress).toBeHidden()
  })

  // PILOT-797: ARIA and Android call an indeterminate indicator a progressbar.
  test("an indeterminate ProgressView is a progressbar, and still a spinner", async ({ device, home, slowLoad }) => {
    await openScreen(device, "")
    await home.row("Slow Load").tap()
    await expect(slowLoad.progress).toHaveRole("progressbar")
    await expect(slowLoad.spinner).toBeVisible()
    // A role-only match binds the indicator itself, not a query for the
    // role's first element type: the element screenshot is the indicator's.
    const box = await slowLoad.anyProgress.first().boundingBox()
    const png = await slowLoad.anyProgress.first().screenshot()
    if (!box) throw new Error("progress indicator has no bounds")
    // PNG width over point width is the screen scale (2 or 3) only for the
    // element whose bounds these are.
    const scale = png.readUInt32BE(16) / box.width
    expect([2, 3].some((s) => Math.abs(scale - s) < 0.05)).toBe(true)
  })
})

describe("Native: accessibility modifiers", () => {
  test.beforeEach(async ({ device, a11y }) => {
    await openScreen(device, "accessibility")
    await expect(a11y.heading).toBeVisible()
  })

  test("isHeader trait is a heading", async ({ a11y }) => {
    await expect(a11y.heading).toHaveRole("heading")
  })

  test("labelled SF Symbol is an image", async ({ a11y }) => {
    await expect(a11y.star).toBeVisible()
  })

  test("icon-only button by label and by identifier", async ({ a11y }) => {
    await a11y.increment.tap()
    await expect(a11y.count(1)).toBeVisible()
    await a11y.incrementById.tap()
    await expect(a11y.count(2)).toBeVisible()
  })

  test("disabled button", async ({ a11y }) => {
    await expect(a11y.disabledAction).toBeDisabled()
  })

  test("Link is a link", async ({ a11y }) => {
    await expect(a11y.link).toBeVisible()
  })

  // BUG? PILOT-798: .accessibilityHidden(true) text is still in the tree as static
  // text. Unconfirmed whether XCUITest or Tapsmith keeps it.
  test.skip("accessibilityHidden text can't be found", async ({ a11y }) => {
    await expect(a11y.hidden).toBeHidden()
  })

  // XCUITest exposes no accessibility hint, so this can't pass on iOS; the
  // docs only say what Android maps it to (PILOT-799).
  test.skip("accessibilityHint is the accessible description", async ({ a11y }) => {
    await expect(a11y.hintTarget).toHaveAccessibleDescription("Shows extra details")
  })
})
