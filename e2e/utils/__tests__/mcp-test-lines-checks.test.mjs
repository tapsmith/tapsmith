import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { replaySpec, runCodeResultOf, testLineOf } from "../mcp-test-lines-checks.mjs"

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

describe("runCodeResultOf", () => {
  const err = (text) => ({ result: { isError: true, content: [{ type: "text", text }] } })

  it("reads the lines of passing statements", () => {
    const got = runCodeResultOf(
      ok(
        'Statement 1 of 2 (line 1): OK\nTest line: await device.getByText("A").tap();\n' +
          'Statement 2 of 2 (line 2): OK\nTest line: await expect(device.getByText("B")).toBeVisible();',
      ),
    )
    assert.deepEqual(got, {
      total: 2,
      lines: ['await device.getByText("A").tap();', 'await expect(device.getByText("B")).toBeVisible();'],
      failed: null,
      notRun: null,
      isError: false,
    })
  })

  it("reads a failure, its multi-line error, and what did not run", () => {
    const got = runCodeResultOf(
      err(
        "Statement 1 of 3 (line 1): OK\nTest line: await device.swipe(\"up\");\n" +
          "Statement 2 of 3 (line 2) failed: Expected element x to be hidden, but it was visible\nmore detail\n" +
          "Not run: statement 3 (line 3).",
      ),
    )
    assert.equal(got.total, 3)
    assert.deepEqual(got.lines, ['await device.swipe("up");'])
    assert.deepEqual(got.failed, { index: 2, message: "Expected element x to be hidden, but it was visible\nmore detail" })
    assert.equal(got.notRun, "statement 3 (line 3).")
    assert.equal(got.isError, true)
  })

  it("reports a refusal, an unverified line and no response as problems", () => {
    assert.match(runCodeResultOf(err("Invalid statement at line 1, column 1: nope. Nothing was run.")).problem, /not a run_code result/)
    assert.match(
      runCodeResultOf(ok("Statement 1 of 1 (line 1): OK\nTest line: none, the locator could not be verified (x).")).problem,
      /without a verified test line/,
    )
    assert.match(runCodeResultOf(undefined).problem, /no response/)
  })
})
