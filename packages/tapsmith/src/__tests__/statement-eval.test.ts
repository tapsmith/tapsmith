import { describe, it, expect } from 'vitest';
import { Device } from '../device.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import { buildStatement, parseStatements, StatementError } from '../mcp/statement-eval.js';

// PILOT-1240: tapsmith_run_code's statements are parsed against a fixed
// grammar, never evaluated. Checking them makes no SDK call that touches the
// device, so a client that throws on any use proves nothing ran.
const client = new Proxy({}, { get: () => { throw new Error('the device was used while checking'); } }) as unknown as TapsmithGrpcClient;
const device = new Device(client);

const parse = (code: string) => parseStatements(code);

function refusal(code: string): StatementError {
  try {
    parse(code);
  } catch (err) {
    if (err instanceof StatementError) return err;
    throw err;
  }
  throw new Error(`expected ${JSON.stringify(code)} to be refused`);
}

describe('parseStatements — accepted forms', () => {
  it.each([
    'await device.getByLabel("Full name").type("Grace Hopper");',
    'await device.getByRole("button", { name: "Save" }).tap({ timeout: 2000 });',
    'await device.getByText("Row 40").scrollIntoView();',
    'await device.getByText("Row 40").scrollIntoView({ direction: "down", maxScrolls: 20 });',
    'await device.getByText("Item").longPress();',
    'await device.getByText("Item").longPress(1500);',
    'await device.getByText("Item").longPress(1500, { timeout: 3000 });',
    'await device.getByText("Item").longPress({ duration: 1500, timeout: 3000 });',
    'await device.getByText("Item").doubleTap({ intervalMs: 50 });',
    'await device.getByText("Card").dragTo(device.getByText("Done"));',
    'await device.getByRole("switch", { name: "Wi-Fi" }).setChecked(true);',
    'await device.getByRole("combobox").selectOption("Blue");',
    'await device.getByRole("combobox").selectOption({ index: 2 });',
    'await device.getByRole("list").getByText("Milk").first().clear();',
    'await device.getByRole("list").scroll("down", { distance: 0.5 });',
    'await device.getByText("Spinner").waitFor({ state: "hidden" });',
    'await expect(device.getByRole("button", { name: "Save" })).toBeEnabled();',
    'await expect(device.getByText("Saved")).not.toBeVisible({ timeout: 1000 });',
    'await expect(device.getByRole("listitem")).toHaveCount(3);',
    'await expect(device.getByRole("listitem")).toHaveText(["A", /B/]);',
    'await expect(device.getByText("Total")).toHaveAttribute("enabled", false);',
    'await expect(page.getByText("Total")).toContainText(/\\d+/);',
    'await device.openDeepLink("myapp://settings");',
    'await device.tapXY(100, 200.5);',
    'await device.longPressXY(100, 200, { duration: 800 });',
    'await device.dragXY({ x: 10, y: 20 }, { x: 10, y: 400 });',
    'await device.swipe("up");',
    'await device.pressKey("back");',
    'await device.hideKeyboard();',
    'await device.setOrientation("landscape");',
    'await device.launchApp("com.example", { clearData: true });',
    'await webview.getByText("Submit").click();',
    'await webview.locator("#email").fill("a@b.c");',
    'await expect(webview.getByText("Done")).toBeVisible();',
  ])('%s', (code) => {
    expect(parse(code)).toHaveLength(1);
  });

  it('splits statements on semicolons and newlines, skipping comments and blank lines', () => {
    const statements = parse([
      '// fill the form',
      'await device.getByLabel("Full name").type("Grace Hopper"); await device.swipe("up")',
      '',
      'await expect(device.getByRole("button", { name: "Save" })).toBeEnabled()',
      '/* scroll */ await device.getByText("Row 40").scrollIntoView();;',
    ].join('\n'));
    expect(statements.map((s) => [s.kind, s.line, s.column])).toEqual([
      ['action', 2, 1],
      ['device', 2, 60],
      ['assertion', 4, 1],
      ['action', 5, 14],
    ]);
  });

  it('writes each statement as a test with the device fixture does', () => {
    const [a, b] = parse('await this.page.getByText("Go").tap()\nawait expect(getByText("Done").and(page.getByRole("button"))).toBeVisible()');
    expect(a.written).toBe('await device.getByText("Go").tap();');
    expect(b.written).toBe('await expect(device.getByText("Done").and(device.getByRole("button"))).toBeVisible();');
    if (a.kind !== 'action') throw new Error('expected an action');
    expect(a.receiverWritten).toBe('device.getByText("Go")');
    expect(a.reportsElement).toBe(true);
  });

  it('marks which actions report the element they resolve, and which use a WebView', () => {
    const [scroll, click] = parse('await device.getByText("x").scrollIntoView(); await webview.getByText("y").click();');
    expect(scroll.kind === 'action' && scroll.reportsElement).toBe(false);
    expect(scroll.usesWebview).toBe(false);
    expect(click.kind === 'action' && click.reportsElement).toBe(false);
    expect(click.usesWebview).toBe(true);
  });

  it('builds a checked statement on the SDK objects without touching the device', async () => {
    const [stmt] = parse('await device.getByText("Card").dragTo(device.getByText("Done"), { timeout: 1000 });');
    const built = await buildStatement(stmt, { device, webview: () => Promise.reject(new Error('no webview')) });
    expect(built.kind).toBe('action');
    expect(built.args).toHaveLength(2);
    expect((built.args[1] as { timeout: number }).timeout).toBe(1000);
  });
});

describe('parseStatements — refusals name the construct, its line and column', () => {
  it.each([
    ['const name = "x";', 1, 1, /variables are not supported/],
    ['const webview = await device.webview();', 1, 1, /needs no declaration here/],
    ['let a = 1', 1, 1, /variables are not supported/],
    ['function go() {}', 1, 1, /functions and classes are not supported/],
    ['if (true) await device.swipe("up");', 1, 1, /`if` statements are not supported/],
    ['for (;;) {}', 1, 1, /`for` statements are not supported/],
    ['x = 1;', 1, 1, /assignments are not supported/],
    ['device.getByText("Go").tap();', 1, 1, /write `await` before the call/],
    ['await 1;', 1, 7, /`await` takes one call/],
    ['await go();', 1, 7, /`go` is not something a statement can call/],
    ['await expect(device.getByText("x"));', 1, 7, /needs a matcher/],
    ['await device.getByText(name).tap();', 1, 24, /literal value .* not an expression or a variable/],
    ['await device.getByText("a" + "b").tap();', 1, 24, /literal value/],
    ['await device.getByText(`${x}`).tap();', 1, 27, /template literals with `\$\{…\}`/],
    ['await device.getByText("x").tap({ ...opts });', 1, 35, /spread/],
    ['await device.getByText("x").tap({ [k]: 1 });', 1, 36, /computed option names/],
    ['await device.getByText("x").tap({ timeout: () => 1 });', 1, 44, /literal value/],
    ['await device.getByText("x").tap({ force: true });', 1, 35, /unsupported option "force" for \.tap\(\)/],
    ['await device["getByText"]("x").tap();', 1, 14, /computed member access/],
    ['await screen.loginButton.tap();', 1, 7, /must start with `device\.` or `webview\.`/],
    ['await device.getByText("x").count();', 1, 29, /returns a value.*toHaveCount/],
    ['await device.getByText("x").isVisible();', 1, 29, /returns a value.*toBeVisible/],
    ['await device.getByText("x").first();', 1, 29, /a locator on its own does nothing/],
    ['await device.getByText("x");', 1, 14, /a locator on its own does nothing/],
    ['await device.getByText("x").evaluate("1");', 1, 29, /`\.evaluate\(\)` is not a action|is not an action run_code supports/],
    ['await device.installApk("/tmp/x.apk");', 1, 14, /`device\.installApk\(\)` is not supported here/],
    ['await device.webview();', 1, 14, /is not needed/],
    ['await webview.evaluate("1");', 1, 15, /is not an action/],
    ['await webview.getByText("x").tap();', 1, 30, /not a webview action run_code supports/],
    ['await expect(await device.getByText("x").count()).toBe(1);', 1, 14, /only assertions on a locator/],
    ['await expect(device.getByText("x")).toBe(1);', 1, 37, /`toBe\(\)` is not a locator matcher/],
    ['await expect(device.getByText("x")).not.not.toBeVisible();', 1, 41, /`\.not` can be written once/],
    ['await expect(device.getByText("x"), "msg").toBeVisible();', 1, 7, /takes one locator/],
    ['await expect(device.getByRole("listitem")).toHaveCount("3");', 1, 56, /must be an integer/],
    ['await device.tapXY(1);', 1, 7, /expects 2 argument\(s\), got 1/],
    ['await device.dragXY({ x: 1 }, { x: 1, y: 2 });', 1, 21, /needs "y" in this object/],
    ['await device.getByText("x")?.tap();', 1, 7, /optional/],
    ['await device.getByText("x").tap(), await device.swipe("up");', 1, 1, /not a statement that can run/],
  ])('%s', (code, line, column, message) => {
    const err = refusal(code);
    expect(err.message).toMatch(message);
    expect([err.line, err.column]).toEqual([line, column]);
    expect(err.message).toContain(`line ${line}, column ${column}`);
  });

  it('reports a refusal on a later line at that line, so nothing before it runs', () => {
    const err = refusal('await device.swipe("up");\nawait device.getByText("x").tap();\n  const y = 1;');
    expect([err.line, err.column]).toEqual([3, 3]);
  });

  it('reports a syntax error at its position', () => {
    const err = refusal('await device.swipe("up");\nawait device.getByText("x".tap();');
    expect(err.line).toBe(2);
    expect(err.message).toMatch(/^Invalid code at line 2, column \d+: it does not parse/);
  });

  it('refuses code with no statement', () => {
    expect(refusal('  // nothing\n;').message).toMatch(/no statement to run/);
  });

  it('keeps the locator rules: unknown getters and options are refused', () => {
    expect(refusal('await device.getByRole("button", { label: "x" }).tap();').message).toMatch(/unsupported option "label"/);
    expect(refusal('await device.getByFoo("x").tap();').message).toMatch(/not a locator method/);
  });
});
