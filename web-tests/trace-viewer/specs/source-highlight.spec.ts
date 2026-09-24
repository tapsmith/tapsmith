// Which source line the Source tab highlights for the selected action.
//
// This is the tab's whole job: point at the line of test code that produced the
// action you are looking at. An off-by-one, or a highlight that fails to move
// when you pick a different action, sends you to the wrong line — and looks
// entirely plausible while doing it.

import { test, expect } from "../fixtures.js"
import { actionEvent, assertionEvent } from "../trace-builder.js"

const FILE = "e2e/tests/gestures.test.ts"

// Numbered for reference: the line each event points at is the one asserted.
//  1 import { describe, expect, test } from "../fixtures.js"
//  2
//  3 describe("Gestures screen", () => {
//  4   test("double tap registers double tap gesture", async ({ gesturesScreen }) => {
//  5     await gesturesScreen.tapArea.doubleTap()
//  6     await expect(gesturesScreen.lastGesture).toContainText("Double tap")
//  7   })
//  8 })
const SOURCE = [
  'import { describe, expect, test } from "../fixtures.js"',
  "",
  'describe("Gestures screen", () => {',
  '  test("double tap registers double tap gesture", async ({ gesturesScreen }) => {',
  "    await gesturesScreen.tapArea.doubleTap()",
  '    await expect(gesturesScreen.lastGesture).toContainText("Double tap")',
  "  })",
  "})",
].join("\n")

const HELPER = "e2e/screens/gestures.screen.ts"
const HELPER_SOURCE = [
  'import { Device } from "tapsmith"',
  "",
  "export class GesturesScreen {",
  "  constructor(private device: Device) {}",
  '  get tapArea() { return this.device.getByRole("button", { name: "Tap area" }) }',
  "}",
].join("\n")

test.describe("Source tab highlight", () => {
  test("highlights the line the action came from", async ({ viewer, detailTabs, actions }) => {
    await viewer.open({
      events: [
        actionEvent({
          actionIndex: 0,
          action: "doubleTap",
          sourceLocation: { file: FILE, line: 5 },
        }),
      ],
      sources: { [FILE]: SOURCE },
    })
    await actions.items.first().click()
    await detailTabs.select("Source")

    await expect(detailTabs.highlightedSourceLine).toHaveAttribute("data-line", "5")
    // The line number alone could be an off-by-one that still lands on a real
    // line, so assert the code on it.
    await expect(detailTabs.highlightedSourceLine).toContainText("doubleTap()")
  })

  test("highlights exactly one line", async ({ viewer, detailTabs, actions }) => {
    await viewer.open({
      events: [
        actionEvent({
          actionIndex: 0,
          action: "doubleTap",
          sourceLocation: { file: FILE, line: 5 },
        }),
      ],
      sources: { [FILE]: SOURCE },
    })
    await actions.items.first().click()
    await detailTabs.select("Source")

    await expect(detailTabs.sourceLines).toHaveCount(8)
    await expect(detailTabs.highlightedSourceLine).toHaveCount(1)
  })

  test("moves the highlight when a different action is selected", async ({
    viewer,
    detailTabs,
    actions,
  }) => {
    await viewer.open({
      events: [
        actionEvent({
          actionIndex: 0,
          action: "doubleTap",
          sourceLocation: { file: FILE, line: 5 },
        }),
        assertionEvent({
          actionIndex: 1,
          assertion: "toContainText",
          sourceLocation: { file: FILE, line: 6 },
        }),
      ],
      sources: { [FILE]: SOURCE },
    })
    await detailTabs.select("Source")

    await actions.items.nth(0).click()
    await expect(detailTabs.highlightedSourceLine).toHaveAttribute("data-line", "5")

    await actions.items.nth(1).click()
    await expect(detailTabs.highlightedSourceLine).toHaveAttribute("data-line", "6")
    await expect(detailTabs.highlightedSourceLine).toContainText("toContainText")
    // The old line must let go, or two lines claim to be current.
    await expect(detailTabs.highlightedSourceLine).toHaveCount(1)
    await expect(detailTabs.sourceLine(5)).not.toHaveAttribute("aria-current", "true")
  })

  test("highlights the line an assertion came from", async ({ viewer, detailTabs, actions }) => {
    await viewer.open({
      events: [
        assertionEvent({
          actionIndex: 0,
          assertion: "toContainText",
          passed: false,
          error: "Timed out",
          sourceLocation: { file: FILE, line: 6 },
        }),
      ],
      sources: { [FILE]: SOURCE },
    })
    await actions.items.first().click()
    await detailTabs.select("Source")

    await expect(detailTabs.highlightedSourceLine).toHaveAttribute("data-line", "6")
    await expect(detailTabs.highlightedSourceLine).toContainText("lastGesture")
  })

  test("highlights the first line and the last line correctly", async ({
    viewer,
    detailTabs,
    actions,
  }) => {
    // Boundaries are where an off-by-one hides: line 1 with a 0-based index
    // would highlight nothing, and the last line would run off the end.
    await viewer.open({
      events: [
        actionEvent({ actionIndex: 0, action: "import", sourceLocation: { file: FILE, line: 1 } }),
        actionEvent({ actionIndex: 1, action: "close", sourceLocation: { file: FILE, line: 8 } }),
      ],
      sources: { [FILE]: SOURCE },
    })
    await detailTabs.select("Source")

    await actions.items.nth(0).click()
    await expect(detailTabs.highlightedSourceLine).toHaveAttribute("data-line", "1")
    await expect(detailTabs.highlightedSourceLine).toContainText("import")

    await actions.items.nth(1).click()
    await expect(detailTabs.highlightedSourceLine).toHaveAttribute("data-line", "8")
  })

  test.describe("multi-frame stacks", () => {
    // An action taken inside a screen object has the helper on top and the test
    // underneath; the tab opens on the top frame and follows the one you pick.
    const STACKED = {
      events: [
        actionEvent({
          actionIndex: 0,
          action: "doubleTap",
          stack: [
            { file: HELPER, line: 5 },
            { file: FILE, line: 5 },
          ],
        }),
      ],
      sources: { [FILE]: SOURCE, [HELPER]: HELPER_SOURCE },
    }

    test("opens on the innermost frame", async ({ viewer, detailTabs, actions }) => {
      await viewer.open(STACKED)
      await actions.items.first().click()
      await detailTabs.select("Source")

      await expect(detailTabs.sourceFilename).toHaveText(HELPER)
      await expect(detailTabs.highlightedSourceLine).toHaveAttribute("data-line", "5")
      await expect(detailTabs.highlightedSourceLine).toContainText("getByRole")
    })

    test("follows the frame you select", async ({ viewer, detailTabs, actions }) => {
      await viewer.open(STACKED)
      await actions.items.first().click()
      await detailTabs.select("Source")

      await detailTabs.stackFrame("gestures.test.ts", 5).click()

      // Same line number in a different file — so this only passes if the file
      // changed with it.
      await expect(detailTabs.sourceFilename).toHaveText(FILE)
      await expect(detailTabs.highlightedSourceLine).toHaveAttribute("data-line", "5")
      await expect(detailTabs.highlightedSourceLine).toContainText("tapArea.doubleTap()")
    })
  })

  test("says so when the frame's file was not captured", async ({
    viewer,
    detailTabs,
    actions,
  }) => {
    await viewer.open({
      events: [
        actionEvent({
          actionIndex: 0,
          action: "doubleTap",
          sourceLocation: { file: HELPER, line: 5 },
        }),
      ],
      sources: { [FILE]: SOURCE },
    })
    await actions.items.first().click()
    await detailTabs.select("Source")

    // Naming the file it wanted beats a bare "no source".
    await expect(detailTabs.noContent).toContainText("gestures.screen.ts")
    await expect(detailTabs.highlightedSourceLine).toHaveCount(0)
  })
})
