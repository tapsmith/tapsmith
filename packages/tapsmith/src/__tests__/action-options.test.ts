import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ElementHandle } from '../element-handle.js';
import { WebViewHandle } from '../webview-handle.js';
import { checkOptions, checkTimeout } from '../action-options.js';
import { TraceCollector, type TraceCapture } from '../trace/trace-collector.js';
import type { ActionTraceEvent } from '../trace/types.js';
import { _text, _role } from '../selectors.js';
import type { TapsmithGrpcClient, FindElementsResponse, ActionResponse, ElementInfo } from '../grpc-client.js';

// Per-call action options (PILOT-840): `tap({ timeout })` and friends, and
// the runtime checks that make a wrong option fail instead of being ignored.

// ─── Mock helpers ───

function el(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    elementId: 'el-1', className: 'android.widget.Button', text: 'Go', contentDescription: '',
    resourceId: '', enabled: true, visible: true, clickable: true, focusable: false, scrollable: false,
    hint: '', checked: false, selected: false, focused: false, role: 'button', viewportRatio: 1,
    bounds: { left: 0, top: 0, right: 100, bottom: 50 },
    ...overrides,
  };
}

const ok = (): ActionResponse => ({ requestId: '1', success: true, errorType: '', errorMessage: '', screenshot: Buffer.alloc(0) });
const found = (elements: ElementInfo[]): FindElementsResponse => ({ requestId: '1', elements, errorMessage: '' });

function client(overrides: Partial<TapsmithGrpcClient> = {}): TapsmithGrpcClient {
  const action = () => vi.fn(async () => ok());
  return {
    findElement: vi.fn(async () => ({ requestId: '1', found: true, element: el(), errorMessage: '' })),
    findElements: vi.fn(async () => found([el()])),
    tap: action(), longPress: action(), typeText: action(), clearAndType: action(), clearText: action(),
    scroll: action(), doubleTap: action(), dragAndDrop: action(), selectOption: action(), pinchZoom: action(),
    focus: action(), blur: action(), highlight: action(),
    takeElementScreenshot: vi.fn(async () => ({ requestId: '1', success: true, data: Buffer.from('PNG'), errorMessage: '' })),
    waitForIdle: vi.fn(async () => ok()),
    ...overrides,
  } as unknown as TapsmithGrpcClient;
}

/** A client whose element never appears. */
const emptyClient = () => client({ findElements: vi.fn(async () => found([])) });

const DEVICE_TIMEOUT = 30_000;

/** Every method that takes a per-call timeout, called with `options`. */
const TIMED_CALLS: [string, (h: ElementHandle, options: { timeout?: number }) => Promise<unknown>][] = [
  ['tap', (h, o) => h.tap(o)],
  ['doubleTap', (h, o) => h.doubleTap(o)],
  ['longPress', (h, o) => h.longPress(o)],
  ['type', (h, o) => h.type('abc', o)],
  ['clearAndType', (h, o) => h.clearAndType('abc', o)],
  ['clear', (h, o) => h.clear(o)],
  ['scroll', (h, o) => h.scroll('down', o)],
  ['dragTo', (h, o) => h.dragTo(h, o)],
  ['setChecked', (h, o) => h.setChecked(true, o)],
  ['selectOption', (h, o) => h.selectOption('One', o)],
  ['screenshot', (h, o) => h.screenshot(o)],
  ['pinchIn', (h, o) => h.pinchIn(o)],
  ['pinchOut', (h, o) => h.pinchOut(o)],
  ['focus', (h, o) => h.focus(o)],
  ['blur', (h, o) => h.blur(o)],
  ['boundingBox', (h, o) => h.boundingBox(o)],
  ['find', (h, o) => h.find(o)],
  ['getText', (h, o) => h.getText(o)],
  ['inputValue', (h, o) => h.inputValue(o)],
  ['isEnabled', (h, o) => h.isEnabled(o)],
  ['isChecked', (h, o) => h.isChecked(o)],
  ['isEditable', (h, o) => h.isEditable(o)],
];

// ─── The per-call timeout ───

describe('per-call { timeout } (PILOT-840)', () => {
  it.each(TIMED_CALLS)('%s({ timeout }) gives up on a missing element at that timeout, not the device timeout', async (_name, call) => {
    const handle = new ElementHandle(emptyClient(), _text('Ghost'), DEVICE_TIMEOUT);
    const start = Date.now();
    const err = await call(handle, { timeout: 300 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/300ms/);
    expect((err as Error).message).not.toMatch(/30000ms/);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('tap({ timeout }) gives the agent what is left of that timeout, not of the device timeout', async () => {
    const c = client();
    await new ElementHandle(c, _text('Go'), DEVICE_TIMEOUT).tap({ timeout: 4_000 });
    const budget = (vi.mocked(c.tap).mock.calls[0] as unknown[])[1] as number;
    expect(budget).toBeLessThanOrEqual(4_000);
    expect(budget).toBeGreaterThan(3_000);
  });

  it('a timeout longer than the device timeout is honoured too', async () => {
    const c = client();
    await new ElementHandle(c, _text('Go'), 2_000).tap({ timeout: 60_000 });
    const budget = (vi.mocked(c.tap).mock.calls[0] as unknown[])[1] as number;
    expect(budget).toBeGreaterThan(50_000);
  });

  it('leaves the locator itself unchanged: the next call without options gets the device timeout again', async () => {
    const c = client();
    const handle = new ElementHandle(c, _text('Go'), 8_000);
    await handle.tap({ timeout: 1_000 });
    await handle.tap();
    const budgets = vi.mocked(c.tap).mock.calls.map((args) => (args as unknown[])[1] as number);
    expect(budgets[0]).toBeLessThanOrEqual(1_000);
    expect(budgets[1]).toBeGreaterThan(7_000);
    expect(handle._timeoutMs).toBe(8_000);
  });

  it('bounds the operands of and()/or() and a scope parent by the same timeout', async () => {
    const base = new ElementHandle(emptyClient(), _role('button'), DEVICE_TIMEOUT);
    const other = new ElementHandle(emptyClient(), _text('Go'), DEVICE_TIMEOUT);
    for (const handle of [base.and(other), base.or(other), base.getByText('Go')]) {
      const start = Date.now();
      await expect(handle.tap({ timeout: 300 })).rejects.toThrow(/300ms/);
      expect(Date.now() - start).toBeLessThan(5_000);
    }
  });

  it('dragTo({ timeout }) bounds the wait for the target as well as the source', async () => {
    let calls = 0;
    // The source is there; the target never is.
    const c = client({ findElements: vi.fn(async () => (calls++ === 0 ? found([el()]) : found([]))) });
    const source = new ElementHandle(c, _text('Card'), DEVICE_TIMEOUT);
    const target = new ElementHandle(c, _text('Bin'), DEVICE_TIMEOUT);
    const start = Date.now();
    await expect(source.dragTo(target, { timeout: 300 })).rejects.toThrow(/Bin/);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('dragTo({ timeout }) shares one budget between both waits and the drag, so the whole call ends within it', async () => {
    const start = Date.now();
    // The source is there at once; the drop zone appears 1.5 s into a 2 s timeout.
    const findElements = vi.fn(async (sel: unknown) =>
      JSON.stringify(sel).includes('Bin') && Date.now() - start < 1_500 ? found([]) : found([el()]));
    const c = client({ findElements: findElements as unknown as TapsmithGrpcClient['findElements'] });
    const source = new ElementHandle(c, _text('Card'), DEVICE_TIMEOUT);
    await source.dragTo(new ElementHandle(c, _text('Bin'), DEVICE_TIMEOUT), { timeout: 2_000 });
    const budget = (vi.mocked(c.dragAndDrop).mock.calls[0] as unknown[])[2] as number;
    // What is left of the 2 s (floored at the 1 s every action's drag or tap
    // gets), not a fresh 2 s after the target wait, and never a useless few ms.
    expect(budget).toBeLessThanOrEqual(1_000);
    expect(budget).toBeGreaterThanOrEqual(900);
  });

  it('keeps the other options when a timeout is given', async () => {
    const c = client();
    const handle = new ElementHandle(c, _text('Field'), DEVICE_TIMEOUT);
    await handle.type('hi', { delay: 40, timeout: 5_000 });
    await handle.clearAndType('yo', { delay: 30, timeout: 5_000 });
    await handle.doubleTap({ intervalMs: 150, timeout: 5_000 });
    await handle.pinchIn({ scale: 0.25, timeout: 5_000 });
    await handle.scroll('up', { distance: 0.3, timeout: 5_000 });
    expect(vi.mocked(c.typeText).mock.calls[0]).toEqual([expect.anything(), 'hi', expect.any(Number), 40]);
    expect(vi.mocked(c.clearAndType).mock.calls[0]).toEqual([expect.anything(), 'yo', expect.any(Number), 30]);
    expect((vi.mocked(c.doubleTap).mock.calls[0] as unknown[])[2]).toBe(150);
    expect((vi.mocked(c.pinchZoom).mock.calls[0] as unknown[])[1]).toBe(0.25);
    expect((vi.mocked(c.scroll).mock.calls[0] as unknown[])[2]).toMatchObject({ distance: 0.3 });
  });

  it('longPress takes its duration as a number (as before) or as { duration }, with or without a timeout', async () => {
    const c = client();
    const handle = new ElementHandle(c, _text('Item'), DEVICE_TIMEOUT);
    await handle.longPress(1500);
    await handle.longPress({ duration: 1200, timeout: 5_000 });
    await handle.longPress();
    const durations = vi.mocked(c.longPress).mock.calls.map((args) => (args as unknown[])[1]);
    expect(durations).toEqual([1500, 1200, undefined]);
    expect((vi.mocked(c.longPress).mock.calls[1] as unknown[])[2]).toBeLessThanOrEqual(5_000);
  });

  it('setChecked({ timeout }) waits for the state change only until that timeout', async () => {
    // The tap lands but the switch never turns on.
    const c = client({ findElements: vi.fn(async () => found([el({ checked: false })])) });
    const start = Date.now();
    await expect(new ElementHandle(c, _role('switch'), DEVICE_TIMEOUT).setChecked(true, { timeout: 600 }))
      .rejects.toThrow(/did not change/);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('isVisible()/isHidden() accept a timeout and still answer at once for a missing element', async () => {
    const handle = new ElementHandle(emptyClient(), _text('Ghost'), DEVICE_TIMEOUT);
    expect(await handle.isVisible({ timeout: 1_000 })).toBe(false);
    expect(await handle.isHidden({ timeout: 1_000 })).toBe(true);
  });

  it('records one action row in the trace, under the action name', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-action-options-'));
    try {
      const collector = new TraceCollector({
        mode: 'on', screenshots: false, snapshots: false, sources: false,
        attachments: true, network: false, deviceLogs: false, daemonLogs: false,
      }, tempDir);
      const traceCapture: TraceCapture = { collector, takeScreenshot: async () => undefined, captureHierarchy: async () => undefined };
      const handle = new ElementHandle(client(), _text('Go'), DEVICE_TIMEOUT, { traceCapture });
      await handle.tap({ timeout: 5_000 });
      const actions = collector.events.filter((e): e is ActionTraceEvent => e.type === 'action');
      expect(actions.map((a) => [a.action, a.success])).toEqual([['tap', true]]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Wrong options fail loudly ───

describe('wrong options throw at the call instead of being ignored (PILOT-840)', () => {
  const bad: [string, unknown, RegExp][] = [
    ['a number', 5000, /tap\(\): expected an options object such as \{ timeout: 5000 \}, but got 5000 \(a number\)\. tap\(\) accepts: timeout\./],
    ['a string', '5000', /but got "5000" \(a string\)/],
    ['null', null, /but got null/],
    ['an array', [5000], /but got an array/],
    ['a misspelt key', { timout: 5000 }, /tap\(\): unknown option "timout"\. tap\(\) accepts: timeout\./],
    ['a Playwright-only option', { force: true }, /tap\(\): option "force" is a Playwright option Tapsmith does not support\. tap\(\) accepts: timeout\./],
    ['a negative timeout', { timeout: -1 }, /tap\(\): timeout must be a positive number of milliseconds, but got -1 \(a number\)\./],
    ['a zero timeout', { timeout: 0 }, /but got 0 \(a number\)\. In Playwright 0 means no limit/],
    ['a NaN timeout', { timeout: NaN }, /but got NaN/],
    ['an infinite timeout', { timeout: Infinity }, /but got Infinity/],
    ['a string timeout', { timeout: '5000' }, /but got "5000" \(a string\)/],
  ];

  it.each(bad)('tap() given %s throws a TypeError before touching the device', async (_what, options, message) => {
    const c = client();
    const err = await new ElementHandle(c, _text('Go'), DEVICE_TIMEOUT)
      .tap(options as { timeout?: number }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(message);
    expect(c.findElements).not.toHaveBeenCalled();
    expect(c.tap).not.toHaveBeenCalled();
  });

  it.each(TIMED_CALLS)('%s() checks its options too', async (name, call) => {
    const err = await call(new ElementHandle(client(), _text('Go'), DEVICE_TIMEOUT), { timout: 1 } as { timeout?: number })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toContain(`${name}(): unknown option "timout"`);
  });

  it('names every option the method accepts', async () => {
    const handle = new ElementHandle(client(), _text('Go'), DEVICE_TIMEOUT);
    await expect(handle.type('x', { dealy: 5 } as { delay?: number })).rejects.toThrow('type() accepts: delay, timeout.');
    await expect(handle.longPress({ durationMs: 5 } as { duration?: number })).rejects.toThrow('longPress() accepts: duration, timeout.');
    await expect(handle.highlight({ duration: 5 } as { durationMs?: number })).rejects.toThrow('highlight() accepts: durationMs.');
    await expect(handle.scrollIntoView({ timeout: 5 } as { speed?: number }))
      .rejects.toThrow('scrollIntoView() accepts: direction, maxScrolls, speed.');
  });

  it.each([
    [{ label: 'Two' }, /Playwright's \{ value \} and \{ label \} forms are not supported/],
    [{ value: 'two' }, /Playwright's \{ value \} and \{ label \} forms are not supported/],
    [{ index: 2, timeout: 3000 }, /A timeout goes in the second argument: selectOption\(option, \{ timeout \}\)/],
    [{ index: -1 }, /but got \{"index":-1\}/],
    [{ index: 1.5 }, /non-negative integer index/],
    [5, /but got 5 \(a number\)/],
    [null, /but got null/],
  ])('selectOption(%j) throws instead of selecting the first option', async (option, message) => {
    const c = client();
    const err = await new ElementHandle(c, _role('combobox'), DEVICE_TIMEOUT)
      .selectOption(option as unknown as string).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(message);
    expect(c.selectOption).not.toHaveBeenCalled();
  });

  it('selectOption() still takes the option text or { index }', async () => {
    const c = client();
    const picker = new ElementHandle(c, _role('combobox'), DEVICE_TIMEOUT);
    await picker.selectOption('Two');
    await picker.selectOption({ index: 0 });
    await picker.selectOption({ index: 3 }, { timeout: 5_000 });
    expect(vi.mocked(c.selectOption).mock.calls.map((a) => (a as unknown[])[1])).toEqual(['Two', { index: 0 }, { index: 3 }]);
  });

  it('accepts keys set to undefined, as a spread of optional fields produces', async () => {
    const c = client();
    const handle = new ElementHandle(c, _text('Go'), DEVICE_TIMEOUT);
    await handle.tap({ timeout: undefined, force: undefined } as { timeout?: number });
    expect(c.tap).toHaveBeenCalledTimes(1);
  });

  it('waitFor() checks its options, keeps timeout 0 as one check, and refuses an unknown state', async () => {
    const handle = new ElementHandle(client(), _text('Go'), DEVICE_TIMEOUT);
    await expect(handle.waitFor({ timeout: 0 })).resolves.toBeUndefined();
    await expect(handle.waitFor({ timout: 5 } as { timeout?: number })).rejects.toThrow('waitFor(): unknown option "timout"');
    await expect(handle.waitFor({ timeout: -5 })).rejects.toThrow(/waitFor\(\): timeout must be a positive number/);
    await expect(handle.waitFor({ state: 'visibile' } as unknown as { state: 'visible' }))
      .rejects.toThrow(`waitFor(): unknown state "visibile". Use one of: 'visible', 'hidden', 'attached', 'detached'.`);
  });
});

describe('checkOptions / checkTimeout', () => {
  it('pass undefined through', () => {
    expect(checkOptions<{ timeout?: number }>('x()', undefined, ['timeout'])).toBeUndefined();
    expect(checkTimeout('x()', undefined)).toBeUndefined();
  });

  it('say when a method takes no options at all', () => {
    expect(() => checkOptions<Record<string, unknown>>('x()', { a: 1 }, [])).toThrow('x(): unknown option "a". x() takes no options.');
  });

  it('describe a function argument without printing its source', () => {
    expect(() => checkOptions<Record<string, unknown>>('x()', (() => 1) as unknown as Record<string, unknown>, ['timeout'])).toThrow(/but got a function\./);
  });
});

// ─── WebView locators and selectors ───

describe('WebView { timeout } (PILOT-840)', () => {
  /** A WebView whose DOM never has a match, on a long WebView timeout. */
  function emptyWebView() {
    const handle = new WebViewHandle({} as TapsmithGrpcClient, 0, DEVICE_TIMEOUT);
    vi.spyOn(handle, '_probeLocator').mockImplementation(async () => ({
      count: 0, anyVisible: false, targetVisible: false, sample: [],
    }));
    // Every evaluate answers "no match" (the string forms' querySelector check).
    vi.spyOn(handle, '_evaluate').mockImplementation(async () => false);
    return handle;
  }

  const LOCATOR_CALLS: [string, (h: WebViewHandle, o: { timeout?: number }) => Promise<unknown>][] = [
    ['locator.click', (h, o) => h.locator('#go').click(o)],
    ['locator.fill', (h, o) => h.locator('#go').fill('x', o)],
    ['locator.textContent', (h, o) => h.locator('#go').textContent(o)],
    ['locator.innerHTML', (h, o) => h.locator('#go').innerHTML(o)],
    ['locator.inputValue', (h, o) => h.locator('#go').inputValue(o)],
    ['locator.getAttribute', (h, o) => h.locator('#go').getAttribute('href', o)],
    ['click', (h, o) => h.click('#go', o)],
    ['fill', (h, o) => h.fill('#go', 'x', o)],
    ['textContent', (h, o) => h.textContent('#go', o)],
    ['innerHTML', (h, o) => h.innerHTML('#go', o)],
    ['inputValue', (h, o) => h.inputValue('#go', o)],
    ['getAttribute', (h, o) => h.getAttribute('#go', 'href', o)],
  ];

  it.each(LOCATOR_CALLS)('webview %s({ timeout }) gives up at that timeout', async (_name, call) => {
    const start = Date.now();
    // The string forms report what was left of the timeout when their wait began.
    await expect(call(emptyWebView(), { timeout: 300 })).rejects.toThrow(/in WebView \(([12]\d\d|300)ms\)/);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it.each(LOCATOR_CALLS)('webview %s() refuses an unknown option', async (_name, call) => {
    const err = await call(emptyWebView(), { timout: 300 } as { timeout?: number }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/unknown option "timout"\. .* accepts: timeout\./);
  });
});
