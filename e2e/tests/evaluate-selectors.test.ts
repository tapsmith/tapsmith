import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-848: MCP's locator suggestions and match counts come from the agent's
// evaluateSelectors batch (UI mode's will too), so it must match exactly what a test's
// own find resolves: the same elements, in the same order (the order `.nth()`
// uses), for every kind of selector. The locators below are the subject under
// test, so they are written inline.

interface Bounds { left: number; top: number; right: number; bottom: number }
interface Element { elementId: string; text: string; className: string; bounds?: Bounds }
interface Client {
  evaluateSelectors(selectors: unknown[]): Promise<{
    results: { elements: Element[]; errorMessage: string }[]
    errorMessage: string
  }>
  findElements(selector: unknown, timeoutMs?: number): Promise<{ elements: Element[]; errorMessage: string }>
}

const summary = (elements: Element[]) =>
  elements.map((e) => ({ text: e.text, className: e.className, bounds: e.bounds }))

describe("evaluateSelectors", () => {
  test.beforeEach(async ({ device, togglesScreen }) => {
    await openScreen(device, "/toggles")
    await expect(togglesScreen.switchesHeading).toBeVisible()
  })

  test("each result is what a find of the same selector resolves", async ({ device }) => {
    const client = (device as unknown as { _client: Client })._client
    const locators = [
      device.getByRole("heading"),
      device.getByRole("heading", { name: "Radio Buttons" }),
      device.getByRole("checkbox"),
      device.getByRole("radiobutton"),
      device.getByRole("switch"),
      device.getByText("Switches", { exact: true }),
      device.getByText("o"),
      device.getByText(/^Radio/),
      device.getByText("No such text on this screen"),
    ]
    const selectors = locators.map((l) => (l as unknown as { _selector: unknown })._selector)

    const batch = await client.evaluateSelectors(selectors)
    expect(batch.errorMessage).toBe("")
    expect(batch.results).toHaveLength(selectors.length)

    for (const [i, selector] of selectors.entries()) {
      const found = await client.findElements(selector, 0)
      expect(found.errorMessage).toBe("")
      const result = batch.results[i]
      expect(result.errorMessage, `selector ${i}`).toBe("")
      expect(summary(result.elements), `selector ${i}`).toEqual(summary(found.elements))
      // Evaluating never caches a match, so it can't evict a running test's handles.
      for (const element of result.elements) expect(element.elementId).toBe("")
    }
    // The screen has something for most of them: the comparison isn't vacuous.
    expect(batch.results.filter((r) => r.elements.length > 0).length).toBeGreaterThanOrEqual(6)
  })

  test("a selector the agent rejects fails only its own entry", async ({ device }) => {
    const client = (device as unknown as { _client: Client })._client
    const heading = (device.getByRole("heading", { name: "Switches" }) as unknown as { _selector: unknown })._selector
    // A device pattern neither agent compiles (the SDK never sends one: it
    // validates RegExp locators first), built raw to reach the agent.
    const invalid = { kind: { type: "textRegex", value: { source: "(", flags: "", pattern: "(", ignoreCase: false } } }

    const batch = await client.evaluateSelectors([heading, invalid, heading])
    expect(batch.errorMessage).toBe("")
    // (iOS lists some elements twice, as a parent and an inner child with the
    // same label and bounds; the runtime collapses those after the find.)
    expect(batch.results[0].elements.length).toBeGreaterThan(0)
    expect(batch.results[1].errorMessage).not.toBe("")
    expect(batch.results[1].elements).toHaveLength(0)
    expect(summary(batch.results[2].elements)).toEqual(summary(batch.results[0].elements))
  })
})
