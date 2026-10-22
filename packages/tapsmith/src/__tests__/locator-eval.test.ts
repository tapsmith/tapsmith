import { describe, it, expect, vi } from 'vitest';
import { Device } from '../device.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import type { WebViewHandle } from '../webview-handle.js';
import { evaluateLocator, nativeSelectorOf } from '../mcp/locator-eval.js';
import { selectorToProto } from '../selectors.js';

// PILOT-848: MCP locator strings are built by the SDK's own locator builder
// (device.getBy*, ElementHandle chains, WebView locators), so they can't drift
// from what a test does. The string comes from an AI agent: it is parsed, never
// executed, and only locator-builder calls with literal arguments are allowed.

// Building a locator never touches the client; any call would be a bug here.
const client = new Proxy({}, { get: () => { throw new Error('a locator was resolved while being built'); } }) as unknown as TapsmithGrpcClient;
const device = new Device(client);
const describe_ = (h: unknown) => (h as { _describe(): string })._describe();
const native = async (source: string) => {
  const r = await evaluateLocator(source, { device, webview: () => Promise.reject(new Error('no webview')) });
  if (r.kind !== 'native') throw new Error(`expected a native locator, got ${r.kind}`);
  return describe_(r.handle);
};

describe('evaluateLocator — the SDK builds the locator', () => {
  it.each([
    ['device.getByText("Sign in")', device.getByText('Sign in')],
    ['device.getByText("Sign in", { exact: true })', device.getByText('Sign in', { exact: true })],
    ["device.getByText('it\\'s \"quoted\"\\n')", device.getByText('it\'s "quoted"\n')],
    ['device.getByText(/^Item \\d+$/i)', device.getByText(/^Item \d+$/i)],
    ['device.getByRole("button", { name: "Save", exact: true, disabled: false })', device.getByRole('button', { name: 'Save', exact: true, disabled: false })],
    ['device.getByRole("tab", { name: /set+ings/ })', device.getByRole('tab', { name: /set+ings/ })],
    ['device.getByDescription("Close")', device.getByDescription('Close')],
    ['device.getByPlaceholder(`Email`)', device.getByPlaceholder('Email')],
    ['device.getByTestId("email-input")', device.getByTestId('email-input')],
    ['device.getByLabel(/name/)', device.getByLabel(/name/)],
    ['device.locator({ className: "android.widget.Switch" })', device.locator({ className: 'android.widget.Switch' })],
    ['device.getByText("Item").nth(-2)', device.getByText('Item').nth(-2)],
    ['device.getByText("Item").first().last()', device.getByText('Item').first().last()],
  ])('%s', async (source, expected) => {
    expect(await native(source)).toBe(describe_(expected));
  });

  it('builds chains the regex parser refused: scoped getters, filter, and, or', async () => {
    expect(await native('device.getByRole("list").getByText("Row 2")'))
      .toBe(describe_(device.getByRole('list').getByText('Row 2')));
    expect(await native('device.getByRole("listitem").filter({ hasText: "Milk", has: device.getByRole("checkbox", { checked: true }) })'))
      .toBe(describe_(device.getByRole('listitem').filter({ hasText: 'Milk', has: device.getByRole('checkbox', { checked: true }) })));
    expect(await native('device.getByRole("button").and(device.getByText("Save")).or(device.getByTestId("save"))'))
      .toBe(describe_(device.getByRole('button').and(device.getByText('Save')).or(device.getByTestId('save'))));
    expect(await native('device.getByRole("listitem").filter({ hasNotText: /sold out/i }).nth(1)'))
      .toBe(describe_(device.getByRole('listitem').filter({ hasNotText: /sold out/i }).nth(1)));
  });

  it('accepts surrounding whitespace, line breaks and a trailing semicolon', async () => {
    expect(await native('  device\n  .getByRole("list")\n  .getByText("x");  ')).toBe(describe_(device.getByRole('list').getByText('x')));
  });

  it('keeps the SDK\'s own validation (unknown role, bad index)', async () => {
    await expect(native('device.getByRole("dialog")')).rejects.toThrow(/Unknown role "dialog"/);
    await expect(native('device.getByText("x").nth(1.5)')).rejects.toThrow(/integer/);
  });

  it('reads the receivers the docs, the trace and screen objects write (PILOT-717)', async () => {
    for (const bare of ['getByText("Explore")', 'getByRole("button", { name: "Explore" })', 'locator({ id: "explore" })', 'getByText("x").nth(-1)']) {
      const expected = await native(`device.${bare}`);
      for (const receiver of ['', 'page.', 'this.device.', 'this.page.']) {
        expect(await native(`${receiver}${bare}`), `${receiver}${bare}`).toBe(expected);
      }
    }
    const getByText = vi.fn(() => 'wv');
    const r = await evaluateLocator('this.webview.getByText("Go")', { device, webview: async () => ({ getByText }) as unknown as WebViewHandle });
    expect(r).toEqual({ kind: 'webview', locator: 'wv' });
  });

  it('keeps getByRole\'s role checks: unknown roles fail fast, case and aliases are accepted (PILOT-556)', async () => {
    await expect(native('device.getByRole("lst")')).rejects.toThrow(/^Unknown role "lst"\. Supported: /);
    await expect(native('device.getByRole("textbox", { name: /mail/i })')).rejects.toThrow('Did you mean "textfield"?');
    expect(await native('device.getByRole("Button", { name: "OK" })')).toBe(describe_(device.getByRole('Button' as 'button', { name: 'OK' })));
    expect(await native('device.getByRole("header")')).toBe(describe_(device.getByRole('header' as 'heading')));
  });

  it('keeps every getByRole state, false included (PILOT-655)', async () => {
    const source = 'device.getByRole("button", { name: "Magical", exact: true, selected: true, checked: false, disabled: false, expanded: true })';
    expect(selectorToProto(nativeSelectorOf(source, device)!)).toEqual({
      role: { role: 'button', name: 'Magical', exact: true, selected: true, checked: false, disabled: false, expanded: true },
    });
  });

  it('refuses a RegExp flag the agents cannot honour, with the SDK\'s message (PILOT-520)', async () => {
    await expect(native('device.getByText(/x/y)')).rejects.toThrow(/does not support the RegExp flag "y"/);
  });

  it('resolves webview locators through the WebView handle, connecting only when used', async () => {
    const getByText = vi.fn(() => 'wv-locator');
    const webview = vi.fn(async () => ({ getByText }) as unknown as WebViewHandle);
    const r = await evaluateLocator('webview.getByText("Submit", { exact: true })', { device, webview });
    expect(r).toEqual({ kind: 'webview', locator: 'wv-locator' });
    expect(getByText).toHaveBeenCalledWith('Submit', { exact: true });
    await evaluateLocator('device.getByText("x")', { device, webview });
    expect(webview).toHaveBeenCalledTimes(1);
  });
});

describe('evaluateLocator — refuses anything that is not a locator', () => {
  const refuse = (source: string) => evaluateLocator(source, { device, webview: () => Promise.reject(new Error('no webview')) });

  it.each([
    // Code execution attempts: none may run, all name what was refused.
    ['device.constructor.constructor("return process")()', /constructor/],
    ['device.getByText("x").constructor', /constructor/],
    ['device["getByText"]("x")', /computed/],
    ['process.exit(1)', /must start with `device\.` or `webview\.`/],
    ['require("child_process")', /must start with `device\.` or `webview\.`/],
    ['(() => device.getByText("x"))()', /must start with `device\.` or `webview\.`/],
    ['device.getByText(`${process.env.HOME}`)', /template/],
    ['device.getByText("x", { exact: true, ...{} })', /spread/],
    ['device.getByText("x", { ["exact"]: true })', /computed/],
    ['device.getByText("x", { __proto__: { exact: true } })', /__proto__/],
    ['device.getByText(String(1))', /argument/],
    ['device.getByText("a"); process.exit(1)', /one locator expression/],
    ['device.getByText("x") || process.exit(1)', /must start with `device\.` or `webview\.`/],
    ['device.getByText(x = "a")', /argument/],
    // Not locator-building calls.
    ['await device.getByText("x").tap()', /drop `\.tap\(\)`|await/],
    ['device.getByText("x").tap()', /`\.tap\(\)`/],
    ['device.waitForIdle()', /`\.waitForIdle\(\)`/],
    // Options and arguments the SDK types don't have (PILOT-655 rule: never ignore part of a locator).
    ['device.getByRole("heading", { name: "A", level: 2 })', /unsupported option "level"/],
    ['device.getByText("x", { exact: "yes" })', /`exact` must be a boolean/],
    ['device.getByRole("button", { name: "A", name: "B" })', /option "name" is given twice/],
    ['getByAltText("Logo")', /must start with `device\.` or `webview\.`/],
    ['list.getByText("x")', /must start with `device\.` or `webview\.`/],
    ['device.getByText()', /expects/],
    ['device.getByText("a", { exact: true }, 3)', /expects/],
    ['device.getByRole("listitem").filter({ has: webview.getByText("x") })', /native locator/],
    ['webview.getByText("x").filter({ hasText: "y" })', /`\.filter\(\)`/],
    ['device.getByText("x"', /Invalid locator syntax/],
    ['', /empty/],
  ])('%s', async (source, message) => {
    await expect(refuse(source)).rejects.toThrow(message);
  });

  it('never evaluates a refused string', async () => {
    const before = (globalThis as { __pilot848?: number }).__pilot848;
    await expect(refuse('device.getByText((globalThis.__pilot848 = 1))')).rejects.toThrow();
    expect((globalThis as { __pilot848?: number }).__pilot848).toBe(before);
  });
});
