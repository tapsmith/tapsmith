import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ElementInfo, EvaluateSelectorsResponse, TapsmithGrpcClient } from '../grpc-client.js';
import type { Selector } from '../selectors.js';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { Device } from '../device.js';
import type { WebViewHandle } from '../webview-handle.js';
import { beginTestRun, closeMcpWebViews, endTestRun } from '../mcp/sdk-device.js';
import { evaluateLiveLocator, LatestOnlyRunner, LiveHierarchyCache, suggestLiveLocators } from '../ui-mode/live-locators.js';

// PILOT-848: UI mode's live Locator tab and picker get their answers from the
// device — the SDK builder plus the agent's matching — never from the
// TypeScript matcher, which only the offline trace playground still uses.

type Bounds = { left: number; top: number; right: number; bottom: number };
const B = (left: number, top: number, right: number, bottom: number): Bounds => ({ left, top, right, bottom });

function el(overrides: Partial<ElementInfo>): ElementInfo {
  return {
    elementId: 'e', className: 'android.widget.TextView', text: '', contentDescription: '', resourceId: '',
    enabled: true, visible: true, clickable: false, focusable: false, scrollable: false, hint: '',
    checked: false, selected: false, focused: false, role: '', viewportRatio: 1,
    ...overrides,
  };
}

/** A daemon client whose agent answers finds and batch checks from `rule`. */
function fakeClient(rule: (sel: Selector) => ElementInfo[]): TapsmithGrpcClient {
  return {
    listDevices: vi.fn(async () => ({ requestId: '1', unusable: [], devices: [{ serial: 'emu', model: '', state: 'device', isEmulator: true, platform: 'android', osVersion: '' }] })),
    getCurrentPackage: vi.fn(async () => ({ requestId: '1', packageName: 'com.example' })),
    findElements: vi.fn(async (sel: Selector) => ({ requestId: '1', elements: rule(sel), errorMessage: '' })),
    evaluateSelectors: vi.fn(async (sels: Selector[]): Promise<EvaluateSelectorsResponse> => ({
      requestId: '1', errorMessage: '', results: sels.map((s) => ({ elements: rule(s), errorMessage: '' })),
    })),
  } as unknown as TapsmithGrpcClient;
}

function node(attrs: Record<string, string>): HierarchyNode {
  return { tagName: 'node', attributes: new Map(Object.entries(attrs)), children: [], depth: 0 };
}

type DomEl = { tag: string; id: string; testId: string; bounds?: Bounds };
const domEl = (o: Partial<DomEl>): DomEl => ({ tag: 'div', id: '', testId: '', ...o });

/** A WebView page whose locators match `matches[\`${method}:${firstArg}\`]` (none by default). */
function fakePage(viewport?: Bounds): { page: WebViewHandle; matches: Record<string, DomEl[]> } {
  const matches: Record<string, DomEl[]> = {};
  const handle: Record<string, unknown> = { _setTimeoutMs: vi.fn() };
  const loc = (key: string) => ({
    _nthIndex: undefined,
    _handle: handle,
    count: vi.fn(async () => (matches[key] ?? []).length),
    _key: key,
  });
  handle._liveMatches = vi.fn(async (l: { _key: string }, _timeoutMs: number, max = 200) => {
    const all = matches[l._key] ?? [];
    return { count: all.length, total: all.length, matches: all.slice(0, max), viewport };
  });
  for (const method of ['getByText', 'getByRole', 'getByTestId', 'getByPlaceholder', 'getByLabel', 'locator']) {
    handle[method] = vi.fn((arg: string) => loc(`${method}:${arg}`));
  }
  return { page: handle as unknown as WebViewHandle, matches };
}

const submit = node({ webview: 'true', 'webview-tag': 'button', text: 'Submit', bounds: '[0,0][100,50]' });

afterEach(async () => {
  await closeMcpWebViews();
  vi.restoreAllMocks();
});

describe('evaluateLiveLocator', () => {
  const rows = [
    el({ elementId: 'a', text: 'Milk 2L', role: 'listitem', bounds: B(0, 0, 400, 50) }),
    el({ elementId: 'b', text: 'Bread', role: 'listitem', bounds: B(0, 50, 400, 100) }),
  ];
  const client = () => fakeClient(() => rows);

  it('counts what the device matches and where, as a test resolves the locator', async () => {
    const r = await evaluateLiveLocator(client(), 'emu', 'device.getByRole("listitem").filter({ hasText: "Milk" })');
    expect(r).toMatchObject({ count: 1, total: 1, positional: false, bounds: [B(0, 0, 400, 50)] });
    expect(r.error).toBeUndefined();
  });

  it('reports the matches before a position picked one', async () => {
    const r = await evaluateLiveLocator(client(), 'emu', 'device.getByRole("listitem").nth(1)');
    expect(r).toMatchObject({ count: 1, total: 2, positional: true, bounds: [B(0, 50, 400, 100)] });
  });

  it('says why a string is not a locator, and never runs it', async () => {
    const c = client();
    const r = await evaluateLiveLocator(c, 'emu', 'device.constructor.constructor("return process")()');
    expect(r.count).toBeUndefined();
    expect(r.error).toMatch(/constructor/);
    expect(c.findElements).not.toHaveBeenCalled();
  });

  it('reports a device failure instead of a count', async () => {
    const c = { ...fakeClient(() => []), findElements: vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'agent not responding' })) } as unknown as TapsmithGrpcClient;
    const r = await evaluateLiveLocator(c, 'emu', 'device.getByText("x")');
    expect(r.error).toMatch(/agent not responding/);
  });

  it('counts a webview locator in the page, and where its matches are on screen', async () => {
    const { page, matches } = fakePage(B(0, 0, 1000, 1000));
    matches['getByText:Go'] = [domEl({ bounds: B(0, 100, 50, 120) }), domEl({ bounds: B(0, 200, 50, 220) }), domEl({})];
    vi.spyOn(Device.prototype, 'webview').mockResolvedValue(page);
    const r = await evaluateLiveLocator(client(), 'emu', 'webview.getByText("Go")');
    expect(r).toMatchObject({ count: 3, total: 3, webview: true, bounds: [B(0, 100, 50, 120), B(0, 200, 50, 220)] });
  });
});

describe('suggestLiveLocators', () => {
  const saveBounds = B(0, 0, 100, 50);
  const save = node({ class: 'android.widget.Button', text: 'Save', clickable: 'true', bounds: '[0,0][100,50]' });

  it('offers only the locators the device resolves to exactly the picked element', async () => {
    const isText = (s: Selector) => (s.kind.type === 'text' || s.kind.type === 'textContains') && s.kind.value === 'Save';
    const c = fakeClient((s) => (isText(s) ? [el({ className: 'android.widget.Button', text: 'Save', bounds: saveBounds })] : []));
    const { suggestions, note } = await suggestLiveLocators(c, 'emu', save, { ios: false });
    expect(suggestions.map((s) => s.code)).toEqual(['device.getByText("Save")']);
    expect(note).toBeUndefined();
  });

  it('says so when the element was gone by the time the device checked', async () => {
    const c = fakeClient(() => []);
    const { suggestions, note } = await suggestLiveLocators(c, 'emu', save, { ios: false });
    expect(suggestions).toEqual([]);
    expect(note).toMatch(/no longer on screen/);
  });

  it('checks a WebView element\'s candidates in the page, keeping those that find only it', async () => {
    const { page, matches } = fakePage();
    matches['getByText:Submit'] = [domEl({ tag: 'button' })];
    matches['getByRole:button'] = [domEl({ tag: 'button' }), domEl({ tag: 'button' })];
    vi.spyOn(Device.prototype, 'webview').mockResolvedValue(page);
    const { suggestions } = await suggestLiveLocators(fakeClient(() => []), 'emu', submit, { ios: false });
    expect(suggestions.map((s) => s.code)).toEqual(['webview.getByText("Submit")']);
  });

  it('rejects a WebView candidate whose one match in the page is another element', async () => {
    const { page, matches } = fakePage();
    // An <a> without href is no link to the page; its one link is elsewhere.
    matches['getByRole:link'] = [domEl({ tag: 'a', id: 'home' })];
    matches['locator:a'] = [domEl({ tag: 'a', id: 'home' })];
    matches['getByText:Docs'] = [domEl({ tag: 'a', id: 'docs' })];
    vi.spyOn(Device.prototype, 'webview').mockResolvedValue(page);
    const anchor = node({ webview: 'true', 'webview-tag': 'a', 'webview-id': 'docs', text: 'Docs', bounds: '[0,0][100,50]' });
    const { suggestions } = await suggestLiveLocators(fakeClient(() => []), 'emu', anchor, { ios: false });
    expect(suggestions.map((s) => s.code)).toEqual(['webview.getByText("Docs")']);
  });

  it('highlights only the part of each WebView match that shows inside the WebView', async () => {
    const { page, matches } = fakePage(B(0, 200, 1000, 1800));
    matches['getByRole:listitem'] = [
      domEl({ bounds: B(0, 100, 1000, 300) }), // half under the native header
      domEl({ bounds: B(0, 1900, 1000, 2000) }), // scrolled out below
      domEl({ bounds: B(0, 200, 0, 200) }), // display:none — no size
      domEl({ bounds: B(0, 400, 1000, 500) }),
    ];
    vi.spyOn(Device.prototype, 'webview').mockResolvedValue(page);
    const r = await evaluateLiveLocator(fakeClient(() => []), 'emu', 'webview.getByRole("listitem")');
    expect(r.count).toBe(4);
    expect(r.bounds).toEqual([B(0, 200, 1000, 300), B(0, 400, 1000, 500)]);
  });

  it('picks a repeated WebView element by its position when no locator finds only it', async () => {
    const { page, matches } = fakePage();
    const row = (top: number) => domEl({ tag: 'button', bounds: B(0, top, 100, top + 50) });
    matches['getByText:Delete'] = [row(0), row(100), row(200)];
    matches['locator:button'] = [row(0), row(100), row(200), row(300)];
    vi.spyOn(Device.prototype, 'webview').mockResolvedValue(page);
    const second = node({ webview: 'true', 'webview-tag': 'button', text: 'Delete', bounds: '[0,100][100,150]' });
    const { suggestions, note } = await suggestLiveLocators(fakeClient(() => []), 'emu', second, { ios: false });
    expect(suggestions.map((s) => s.code)).toEqual(['webview.getByText("Delete").nth(1)', 'webview.locator("button").nth(1)']);
    expect(note).toBeUndefined();
  });

  it('rejects a WebView candidate whose one match has the same tag but sits elsewhere', async () => {
    const { page, matches } = fakePage();
    matches['getByText:Total'] = [domEl({ tag: 'div', bounds: B(0, 400, 100, 450) })];
    matches['locator:div.sum'] = [domEl({ tag: 'div', bounds: B(1, 0, 101, 50) })];
    vi.spyOn(Device.prototype, 'webview').mockResolvedValue(page);
    const total = node({ webview: 'true', 'webview-tag': 'div', 'webview-class': 'sum', text: 'Total', bounds: '[0,0][100,50]' });
    const { suggestions } = await suggestLiveLocators(fakeClient(() => []), 'emu', total, { ios: false });
    expect(suggestions.map((s) => s.code)).toEqual(['webview.locator("div.sum")']);
  });
});

describe('live answers: notes, the picker\'s WebView, and request handling', () => {
  it('says why a native pick has no locator the device confirms', async () => {
    const save = node({ class: 'android.widget.Button', text: 'Save', clickable: 'true', bounds: '[0,0][100,50]' });
    // The device finds something at the pick's place, but never this element.
    const imposter = el({ className: 'android.widget.ImageView', text: '', bounds: B(0, 0, 100, 50) });
    const { suggestions, note } = await suggestLiveLocators(fakeClient(() => [imposter]), 'emu', save, { ios: false });
    expect(suggestions).toEqual([]);
    expect(note).toMatch(/finds only this element/);
  });

  it('says why a WebView pick has no locator that finds only it', async () => {
    const { page, matches } = fakePage();
    // Two Submit buttons, neither where the picked one was.
    matches['getByText:Submit'] = [domEl({ tag: 'button', bounds: B(0, 300, 100, 350) }), domEl({ tag: 'button', bounds: B(0, 400, 100, 450) })];
    vi.spyOn(Device.prototype, 'webview').mockResolvedValue(page);
    const { suggestions, note } = await suggestLiveLocators(fakeClient(() => []), 'emu', submit, { ios: false });
    expect(suggestions).toEqual([]);
    expect(note).toMatch(/finds only this element/);
  });

  it('uses the WebView connection UI mode already holds instead of opening another', async () => {
    const { page, matches } = fakePage();
    matches['getByText:Go'] = [domEl({})];
    const own = vi.spyOn(Device.prototype, 'webview');
    const held = vi.fn(async () => page);
    const r = await evaluateLiveLocator(fakeClient(() => []), 'emu', 'webview.getByText("Go")', held);
    expect(r).toMatchObject({ count: 1, webview: true });
    expect(held).toHaveBeenCalledTimes(1);
    expect(own).not.toHaveBeenCalled();
  });

  it('keeps off the held connection while a test run drives the page', async () => {
    const { page } = fakePage();
    const held = vi.fn(async () => page);
    beginTestRun();
    try {
      const r = await evaluateLiveLocator(fakeClient(() => []), 'emu', 'webview.getByText("Go")', held);
      expect(r.error).toMatch(/test run is in progress/);
      expect(held).not.toHaveBeenCalled();
    } finally {
      endTestRun();
    }
  });
});

describe('LiveHierarchyCache', () => {
  it('keeps the last few captures per device, by revision', () => {
    const cache = new LiveHierarchyCache(2);
    const r1 = cache.remember(0, 0, 'a');
    const r2 = cache.remember(0, 0, 'b');
    const r3 = cache.remember(0, 0, 'c');
    const other = cache.remember(0, 1, 'member');
    expect(cache.at(0, 0, r1)).toBeUndefined();
    expect(cache.at(0, 0, r2)).toBe('b');
    expect(cache.at(0, 0, r3)).toBe('c');
    expect(cache.at(0, 0, other)).toBeUndefined();
    expect(cache.at(0, 1, other)).toBe('member');
    expect(cache.latest(0, 0)).toBe('c');
    expect(cache.latest(9, 0)).toBeUndefined();
  });

  it('forgets a retired worker, whose id another device may reuse', () => {
    const cache = new LiveHierarchyCache();
    const r = cache.remember(3, 0, 'old device');
    const keep = cache.remember(4, 0, 'other worker');
    cache.forgetWorker(3);
    expect(cache.at(3, 0, r)).toBeUndefined();
    expect(cache.at(4, 0, keep)).toBe('other worker');
  });
});

describe('LatestOnlyRunner', () => {
  it('runs one job per key at a time, and only the newest of those that waited', async () => {
    const runner = new LatestOnlyRunner<string>();
    const started: string[] = [];
    const replies: string[] = [];
    let finishFirst!: () => void;
    runner.run('d', () => { started.push('1'); return new Promise<string>((r) => { finishFirst = () => r('one'); }); }, (v) => replies.push(`a:${v}`));
    runner.run('d', async () => { started.push('2'); return 'two'; }, (v) => replies.push(`b:${v}`));
    runner.run('d', async () => { started.push('3'); return 'three'; }, (v) => replies.push(`c:${v}`));
    runner.run('other', async () => { started.push('x'); return 'x'; }, (v) => replies.push(`x:${v}`));
    expect(started).toEqual(['1', 'x']);
    finishFirst();
    await vi.waitFor(() => expect(replies).toContain('c:three'));
    expect(started).toEqual(['1', 'x', '3']);
    expect(replies).toEqual(expect.arrayContaining(['a:one', 'c:three', 'x:x']));
    expect(replies).not.toContain('b:two');
  });
});
