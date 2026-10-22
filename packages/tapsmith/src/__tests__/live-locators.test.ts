import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ElementInfo, EvaluateSelectorsResponse, TapsmithGrpcClient } from '../grpc-client.js';
import type { Selector } from '../selectors.js';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { Device } from '../device.js';
import type { WebViewHandle } from '../webview-handle.js';
import { closeMcpWebViews } from '../mcp/sdk-device.js';
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

  it('counts a webview locator in the page', async () => {
    const page = { getByText: vi.fn(() => ({ count: vi.fn(async () => 3), _nthIndex: undefined })), _setTimeoutMs: vi.fn() };
    vi.spyOn(Device.prototype, 'webview').mockResolvedValue(page as unknown as WebViewHandle);
    const r = await evaluateLiveLocator(client(), 'emu', 'webview.getByText("Go")');
    expect(r).toMatchObject({ count: 3, webview: true, bounds: [] });
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
    const counts: Record<string, number> = {};
    const page = {
      getByText: vi.fn((t: string) => ({ count: vi.fn(async () => counts[`text:${t}`] ?? 0), _nthIndex: undefined })),
      locator: vi.fn((css: string) => ({ count: vi.fn(async () => counts[`css:${css}`] ?? 0), _nthIndex: undefined })),
      getByRole: vi.fn(() => ({ count: vi.fn(async () => 2), _nthIndex: undefined })),
      getByTestId: vi.fn(() => ({ count: vi.fn(async () => 0), _nthIndex: undefined })),
      getByPlaceholder: vi.fn(() => ({ count: vi.fn(async () => 0), _nthIndex: undefined })),
      getByLabel: vi.fn(() => ({ count: vi.fn(async () => 0), _nthIndex: undefined })),
      _setTimeoutMs: vi.fn(),
    };
    counts['text:Submit'] = 1;
    vi.spyOn(Device.prototype, 'webview').mockResolvedValue(page as unknown as WebViewHandle);
    const button = node({ webview: 'true', tag: 'button', text: 'Submit', bounds: '[0,0][100,50]' });
    const { suggestions } = await suggestLiveLocators(fakeClient(() => []), 'emu', button, { ios: false });
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) expect(s.code).toMatch(/^webview\./);
    expect(suggestions.map((s) => s.code)).toContain('webview.getByText("Submit")');
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
    const page = {
      getByText: vi.fn(() => ({ count: vi.fn(async () => 2), _nthIndex: undefined })),
      locator: vi.fn(() => ({ count: vi.fn(async () => 2), _nthIndex: undefined })),
      getByRole: vi.fn(() => ({ count: vi.fn(async () => 2), _nthIndex: undefined })),
      getByTestId: vi.fn(() => ({ count: vi.fn(async () => 2), _nthIndex: undefined })),
      getByPlaceholder: vi.fn(() => ({ count: vi.fn(async () => 2), _nthIndex: undefined })),
      getByLabel: vi.fn(() => ({ count: vi.fn(async () => 2), _nthIndex: undefined })),
      _setTimeoutMs: vi.fn(),
    };
    vi.spyOn(Device.prototype, 'webview').mockResolvedValue(page as unknown as WebViewHandle);
    const button = node({ webview: 'true', tag: 'button', text: 'Submit', bounds: '[0,0][100,50]' });
    const { suggestions, note } = await suggestLiveLocators(fakeClient(() => []), 'emu', button, { ios: false });
    expect(suggestions).toEqual([]);
    expect(note).toMatch(/finds only this element/);
  });

  it('uses the WebView connection UI mode already holds instead of opening another', async () => {
    const page = { getByText: vi.fn(() => ({ count: vi.fn(async () => 1), _nthIndex: undefined })) };
    const own = vi.spyOn(Device.prototype, 'webview');
    const held = vi.fn(async () => page as unknown as WebViewHandle);
    const r = await evaluateLiveLocator(fakeClient(() => []), 'emu', 'webview.getByText("Go")', held);
    expect(r).toMatchObject({ count: 1, webview: true });
    expect(held).toHaveBeenCalledTimes(1);
    expect(own).not.toHaveBeenCalled();
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
