import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { replaySpec, testLineOf } from "../mcp-test-lines-checks.mjs"

const ok = (text) => ({ result: { content: [{ type: "text", text }] } })

describe("testLineOf", () => {
  it("reads a verified line", () => {
    assert.deepEqual(testLineOf(ok('OK\nTest line: await device.getByText("A").tap();')), {
      line: 'await device.getByText("A").tap();',
      positional: false,
      replaced: false,
    })
  })

  it("reads a line that replaced a positional locator", () => {
    const res = ok(
      'OK\nTest line: await device.getByRole("textfield", { name: "Password" }).tap();\n' +
        '(device.getByRole("textfield").nth(1) picks its element by position; the device agent matched this locator to that same element alone, so the line uses it instead.)',
    )
    assert.equal(testLineOf(res).replaced, true)
  })

  it("keeps a position-dependent line with its comment", () => {
    const got = testLineOf(
      ok('OK\nTest line (position-dependent): await device.getByText("Buy").first().tap(); // position-dependent: no locator matched this element alone\n(The line …)'),
    )
    assert.equal(got.positional, true)
    assert.match(got.line, /\/\/ position-dependent/)
  })

  it("reports an unverified line, a failed action, a missing line and no response", () => {
    assert.match(testLineOf(ok("OK\nTest line: none, the locator could not be verified (x).")).problem, /not verified/)
    assert.match(testLineOf({ result: { isError: true, content: [{ type: "text", text: "Error: boom" }] } }).problem, /boom/)
    assert.match(testLineOf(ok("OK")).problem, /no test line/)
    assert.match(testLineOf(undefined).problem, /no response/)
    assert.match(testLineOf({ error: { code: -1 } }).problem, /protocol error/)
  })
})

describe("replaySpec", () => {
  it("puts the lines and the final check in one test body", () => {
    const spec = replaySpec(['await device.swipe("up");'], "await expect(device.getByText(\"X\")).toBeVisible();")
    assert.match(spec, /import \{ expect, test \} from "tapsmith"/)
    assert.match(spec, /\n {2}await device\.swipe\("up"\);\n {2}await expect\(device\.getByText\("X"\)\)\.toBeVisible\(\);\n\}\)/)
  })
})
