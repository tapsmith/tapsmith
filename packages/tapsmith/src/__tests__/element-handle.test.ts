import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ElementHandle, StrictModeViolationError, isStrictModeViolation } from '../element-handle.js';
import { TraceCollector, type TraceCapture } from '../trace/trace-collector.js';
import type { AnyTraceEvent, ActionTraceEvent } from '../trace/types.js';
import { isAbortError, TestAbortedError } from '../abort.js';
import { type Selector, _text, _textContains, _role, _className, _id, _testId, _contentDesc, _xpath, formatSelector, selectorToProto } from '../selectors.js';
import type {
  TapsmithGrpcClient,
  FindElementsResponse,
  ActionResponse,
  ElementInfo,
  ScreenshotResponse,
} from '../grpc-client.js';

// ─── Mock helpers ───

function makeElementInfo(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    elementId: 'el-1',
    className: 'android.widget.TextView',
    text: 'Hello',
    contentDescription: '',
    resourceId: '',
    enabled: true,
    visible: true,
    clickable: true,
    focusable: false,
    scrollable: false,
    hint: '',
    checked: false,
    selected: false,
    focused: false,
    role: '',
    viewportRatio: 1.0,
    ...overrides,
  };
}

function successResponse(): ActionResponse {
  return {
    requestId: '1',
    success: true,
    errorType: '',
    errorMessage: '',
    screenshot: Buffer.alloc(0),
  };
}

function failureResponse(msg = 'Action failed'): ActionResponse {
  return {
    requestId: '1',
    success: false,
    errorType: 'ERROR',
    errorMessage: msg,
    screenshot: Buffer.alloc(0),
  };
}

function makeFindElementsResponse(elements: ElementInfo[]): FindElementsResponse {
  return { requestId: '1', elements, errorMessage: '' };
}

function screenshotResponse(): ScreenshotResponse {
  return {
    requestId: '1',
    success: true,
    data: Buffer.from('PNG_DATA'),
    errorMessage: '',
  };
}

function makeMockClient(overrides: Partial<TapsmithGrpcClient> = {}): TapsmithGrpcClient {
  return {
    findElement: vi.fn(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo(),
      errorMessage: '',
    })),
    findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo()])),
    tap: vi.fn(async () => successResponse()),
    tapXY: vi.fn(async () => successResponse()),
    longPress: vi.fn(async () => successResponse()),
    longPressXY: vi.fn(async () => successResponse()),
    typeText: vi.fn(async () => successResponse()),
    clearAndType: vi.fn(async () => successResponse()),
    clearText: vi.fn(async () => successResponse()),
    scroll: vi.fn(async () => successResponse()),
    doubleTap: vi.fn(async () => successResponse()),
    dragAndDrop: vi.fn(async () => successResponse()),
    selectOption: vi.fn(async () => successResponse()),
    pinchZoom: vi.fn(async () => successResponse()),
    focus: vi.fn(async () => successResponse()),
    blur: vi.fn(async () => successResponse()),
    highlight: vi.fn(async () => successResponse()),
    takeElementScreenshot: vi.fn(async () => screenshotResponse()),
    takeScreenshot: vi.fn(async () => screenshotResponse()),
    waitForIdle: vi.fn(async () => successResponse()),
    ...overrides,
  } as unknown as TapsmithGrpcClient;
}

// ─── Constructor ───

describe('ElementHandle constructor', () => {
  it('stores client, selector, and timeout', () => {
    const client = makeMockClient();
    const sel = _text('Test');
    const handle = new ElementHandle(client, sel, 5000);
    expect(handle._client).toBe(client);
    expect(handle._selector).toBe(sel);
    expect(handle._timeoutMs).toBe(5000);
  });
});

// ─── getBy* scoping ───

describe('getBy* scoping', () => {
  it('creates a child handle with nested selector', () => {
    const client = makeMockClient();
    const parent = new ElementHandle(client, _role('list'), 5000);

    const child = parent.getByText('Item 1', { exact: true });
    expect(child._selector.kind.type).toBe('text');
    expect(child._selector.parent).toBeDefined();
    expect(child._selector.parent!.kind.type).toBe('role');
  });

  it('scoped selector serializes with parent', () => {
    const client = makeMockClient();
    const parent = new ElementHandle(
      client,
      _className('android.widget.ListView'),
      5000,
    );

    const child = parent.getByText('Row', { exact: true });
    expect(selectorToProto(child._selector)).toEqual({
      text: 'Row',
      parent: { className: 'android.widget.ListView' },
    });
  });

  it('substring getByText (default) builds a textContains child', () => {
    const client = makeMockClient();
    const parent = new ElementHandle(client, _role('list'), 5000);
    const child = parent.getByText('partial');
    expect(selectorToProto(child._selector)).toEqual({
      textContains: 'partial',
      parent: { role: { role: 'list', name: '' } },
    });
  });

  it('preserves client and timeout in child handle', () => {
    const client = makeMockClient();
    const parent = new ElementHandle(client, _role('container'), 7000);
    const child = parent.getByText('inner', { exact: true });
    expect(child._client).toBe(client);
    expect(child._timeoutMs).toBe(7000);
  });

  it('supports multi-level scoping', () => {
    const client = makeMockClient();
    const root = new ElementHandle(client, _role('page'), 5000);
    const mid = root.getByRole('section');
    const leaf = mid.getByText('Label', { exact: true });

    expect(leaf._selector.parent).toBeDefined();
    expect(leaf._selector.parent!.parent).toBeDefined();
    expect(leaf._selector.parent!.parent!.kind.type).toBe('role');
  });

  it('getByDescription, getByPlaceholder, getByTestId, locator scope correctly', () => {
    const client = makeMockClient();
    const parent = new ElementHandle(client, _role('list'), 5000);

    expect(parent.getByDescription('Close')._selector.kind).toEqual({
      type: 'contentDesc',
      value: 'Close',
    });
    expect(parent.getByPlaceholder('Search')._selector.kind).toEqual({
      type: 'hint',
      value: 'Search',
    });
    expect(parent.getByTestId('btn')._selector.kind).toEqual({
      type: 'testId',
      value: 'btn',
    });
    expect(parent.locator({ id: 'foo' })._selector.kind).toEqual({
      type: 'id',
      value: 'foo',
    });
    expect(parent.locator({ id: 'foo' })._selector.parent).toBeDefined();
  });

  describe('scoping off a modified handle (geometric containment)', () => {
    // Two stacked dialogs; one button geometrically inside each.
    const dialogs: ElementInfo[] = [
      makeElementInfo({ elementId: 'd1', text: 'Dialog A', bounds: { left: 0, top: 0, right: 200, bottom: 100 } }),
      makeElementInfo({ elementId: 'd2', text: 'Dialog B', bounds: { left: 0, top: 100, right: 200, bottom: 200 } }),
    ];
    const buttons: ElementInfo[] = [
      makeElementInfo({ elementId: 'b1', text: 'Submit', role: 'button', bounds: { left: 10, top: 10, right: 90, bottom: 40 } }),
      makeElementInfo({ elementId: 'b2', text: 'Submit', role: 'button', bounds: { left: 10, top: 110, right: 90, bottom: 140 } }),
    ];
    // Leaf text element, geometrically inside b1 (for the re-scoping test).
    const labels: ElementInfo[] = [
      makeElementInfo({ elementId: 't1', text: 'OK', bounds: { left: 20, top: 15, right: 80, bottom: 35 } }),
    ];

    function scopedClient(): TapsmithGrpcClient {
      const findElements = vi.fn(async (selector: Selector) => {
        const desc = formatSelector(selector);
        if (desc.includes('getByRole')) return makeFindElementsResponse(buttons);
        if (desc.includes('getByText')) return makeFindElementsResponse(labels);
        return makeFindElementsResponse(dialogs);
      });
      return makeMockClient({ findElements });
    }

    it('scopes a getBy* child to the .first() parent by containment', async () => {
      const device = scopedClient();
      const button = new ElementHandle(device, _testId('dialog'), 5000)
        .first()
        .getByRole('button', { name: 'Submit' });
      const el = await button.find();
      expect(el.elementId).toBe('b1');
    });

    it('scopes to the .last() parent', async () => {
      const device = scopedClient();
      const button = new ElementHandle(device, _testId('dialog'), 5000)
        .last()
        .getByRole('button', { name: 'Submit' });
      const el = await button.find();
      expect(el.elementId).toBe('b2');
    });

    it('unions children across all parents matched by a filter', async () => {
      const device = scopedClient();
      // Both dialogs contain "Dialog", so the scope spans both → both buttons.
      const count = await new ElementHandle(device, _testId('dialog'), 5000)
        .filter({ hasText: 'Dialog' })
        .getByRole('button')
        .count();
      expect(count).toBe(2);
    });

    it('a child of an all() row resolves the row LIVE by index, like nth(i): a layout shift after all() does not lose it (review follow-up)', async () => {
      // A snackbar pushes the whole list down 50px after all(); rows[0]
      // re-resolves index 0 live and finds its (shifted) button.
      let shifted = false;
      const shift = (el: ElementInfo, dy: number) =>
        makeElementInfo({ ...el, bounds: { ...el.bounds!, top: el.bounds!.top + dy, bottom: el.bounds!.bottom + dy } });
      const findElements = vi.fn(async (selector: Selector) => {
        const desc = formatSelector(selector);
        const src = desc.includes('getByRole') ? buttons : dialogs;
        return makeFindElementsResponse(shifted ? src.map((e) => shift(e, 50)) : src);
      });
      const client = makeMockClient({ findElements });
      const rows = await new ElementHandle(client, _testId('dialog'), 600).all();
      shifted = true;
      const el = await withFakeClock(5000, () => rows[0].getByRole('button', { name: 'Submit' }).find());
      expect(el.elementId).toBe('b1');
    });

    it('a child of an all() row with no identifying attributes resolves by live index too (review follow-up)', async () => {
      const anonymous = dialogs.map((d, i) => makeElementInfo({ ...d, elementId: `a${i}`, text: '' }));
      const findElements = vi.fn(async (selector: Selector) => {
        const desc = formatSelector(selector);
        if (desc.includes('getByRole')) return makeFindElementsResponse(buttons);
        return makeFindElementsResponse(anonymous);
      });
      const client = makeMockClient({ findElements });
      const rows = await new ElementHandle(client, _testId('dialog'), 600).all();
      expect((await rows[1].getByRole('button', { name: 'Submit' }).find()).elementId).toBe('b2');
    });

    it('a user stop while resolving an all() scope parent propagates instead of becoming an empty scope (review follow-up)', async () => {
      const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
      let listReads = 0;
      const findElements = vi.fn(async (selector: Selector) => {
        const desc = formatSelector(selector);
        if (desc.includes('getByRole')) return makeFindElementsResponse(buttons);
        if (++listReads > 1) throw abort;
        return makeFindElementsResponse(dialogs);
      });
      const client = makeMockClient({ findElements });
      const rows = await new ElementHandle(client, _testId('dialog'), 600).all();
      await expect(withFakeClock(5000, () => rows[0].getByRole('button').find())).rejects.toBe(abort);
    });

    it('honors the parent scope on the assertion path (not a global query)', async () => {
      const device = scopedClient();
      // Scoped to the first dialog → only b1 is in scope. Assertions resolve
      // through _resolveForAssertion, which must apply the scope rather than
      // querying buttons globally (which would yield b1 + b2).
      const scoped = new ElementHandle(device, _testId('dialog'), 5000)
        .first()
        .getByRole('button');
      const els = await scoped._resolveForAssertion(5000, false);
      expect(els.map((e) => e.elementId)).toEqual(['b1']);
    });

    it('supports re-scoping off an already-scoped handle', async () => {
      const device = scopedClient();
      // dialog.first() → scoped buttons; .first() of those → scope again.
      const handle = new ElementHandle(device, _testId('dialog'), 5000)
        .first()
        .getByRole('button')
        .first()
        .getByText('OK');
      const el = await handle.find();
      expect(el.elementId).toBe('t1');
    });

    it('returns 0 from count() (does not throw) when the scoped parent is absent', async () => {
      const device = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse([])),
      });
      const count = await new ElementHandle(device, _testId('dialog'), 5000)
        .first()
        .getByRole('button')
        .count();
      expect(count).toBe(0);
    });
  });
});

// ─── find() ───

describe('find()', () => {
  it('returns ElementInfo when found', async () => {
    const info = makeElementInfo({ text: 'Found it' });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([info])),
    });
    const handle = new ElementHandle(client, _text('Found it'), 5000);
    const result = await handle.find();
    expect(result.text).toBe('Found it');
  });

  it('throws when element is not found', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _text('Missing'), 300);
    await expect(withFakeClock(5000, () => handle.find())).rejects.toThrow(/was not found/);
  });

  it('throws with selector description in the error message', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _text('Gone'), 300);
    await expect(withFakeClock(5000, () => handle.find())).rejects.toThrow('getByText("Gone", { exact: true })');
  });

  it('polls findElements with a capped per-tick budget', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([makeElementInfo()]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 3000);
    await handle.find();
    expect(findElements).toHaveBeenCalledWith(handle._selector, 250);
  });

  it('throws StrictModeViolationError when multiple elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ text: 'Sign in to continue' }),
        makeElementInfo({ text: 'Sign in' }),
      ])),
    });
    const handle = new ElementHandle(client, _textContains('Sign in'), 5000);
    await expect(handle.find()).rejects.toThrow(/^strict mode violation/);
  });
});

// ─── exists() ───

describe('exists()', () => {
  it('returns true when the element is found — one read, no confirmation', async () => {
    const client = makeMockClient();
    const handle = new ElementHandle(client, _text('Present'), 5000);
    expect(await handle.exists()).toBe(true);
    // The docs promise a present element costs one hierarchy read.
    expect(client.findElements).toHaveBeenCalledTimes(1);
    expect(client.waitForIdle).not.toHaveBeenCalled();
  });

  it('returns false at once for an absent element — one read plus a confirming re-read, not a poll to the timeout (PILOT-344)', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    // A long timeout: the old implementation handed it to the agent's waiting
    // findElement RPC, so an absent element cost the whole action timeout.
    const handle = new ElementHandle(client, _text('Absent'), 20_000);
    const start = Date.now();
    expect(await handle.exists()).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
    // Same shape as isVisible(): the first empty read is confirmed once after
    // a bounded idle wait (a lagging accessibility tree, PILOT-283), and the
    // second empty read is the answer.
    expect(findElements).toHaveBeenCalledTimes(2);
    expect(client.waitForIdle).toHaveBeenCalledTimes(1);
    expect(client.waitForIdle).toHaveBeenCalledWith(1500);
    // The agent-side waiting RPC is never used: it would wait for the element.
    expect(client.findElement).not.toHaveBeenCalled();
  });

  it('is exempt from strict mode: an ambiguous selector answers true instead of throwing', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () =>
        makeFindElementsResponse([makeElementInfo({ elementId: 'a' }), makeElementInfo({ elementId: 'b' })])),
    });
    const handle = new ElementHandle(client, _text('Dup'), 5000);
    expect(await handle.exists()).toBe(true);
  });

  it('answers presence, not visibility: an attached but invisible element exists', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ visible: false })])),
    });
    const handle = new ElementHandle(client, _text('Offscreen'), 5000);
    expect(await handle.exists()).toBe(true);
  });

  it('confirms a first empty read, so a lagging accessibility tree does not read as absence', async () => {
    let calls = 0;
    const findElements = vi.fn(async () =>
      ++calls === 1 ? makeFindElementsResponse([]) : makeFindElementsResponse([makeElementInfo()]));
    const client = makeMockClient({ findElements });
    expect(await new ElementHandle(client, _text('Heading'), 5000).exists()).toBe(true);
    expect(calls).toBe(2);
    expect(client.waitForIdle).toHaveBeenCalledTimes(1);
  });

  it('does not report a momentary agent fault as absence — retries and answers once it clears', async () => {
    // The daemon maps ANY agent failure to an errorMessage; an infra blip
    // must not read as "doesn't exist".
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'Unknown error' }
        : makeFindElementsResponse([makeElementInfo()]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Present'), 5000);
    expect(await withFakeClock(5000, () => handle.exists())).toBe(true);
    expect(calls).toBe(2);
  });

  it('treats a stale snapshot as an unreliable tick, not a confirmed miss', async () => {
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' }
        : makeFindElementsResponse([makeElementInfo()]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 5000);
    expect(await withFakeClock(5000, () => handle.exists())).toBe(true);
    expect(calls).toBe(2);
  });

  it('surfaces a persistent agent fault instead of returning false', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async (): Promise<FindElementsResponse> => ({
        requestId: '1',
        elements: [],
        errorMessage: 'UiAutomation not connected',
      })),
    });
    const handle = new ElementHandle(client, _text('X'), 600);
    await expect(withFakeClock(5000, () => handle.exists()))
      .rejects.toThrow(/findElements failed: UiAutomation not connected/);
  });

  it('re-probes a persistent fault only for the short window, not the handle timeout', async () => {
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => ({
      requestId: '1', elements: [], errorMessage: 'UiAutomation not connected',
    }));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 30_000);
    let elapsed = -1;
    await expect(withFakeClock(60_000, async () => {
      const start = Date.now();
      try {
        return await handle.exists();
      } finally {
        elapsed = Date.now() - start;
      }
    })).rejects.toThrow(/findElements failed/);
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(5000);
  });

  it('propagates a transport failure at once, without the fault retry window', async () => {
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      throw new Error('14 UNAVAILABLE: No connection established');
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 30_000);
    await expect(withFakeClock(60_000, () => handle.exists())).rejects.toThrow(/UNAVAILABLE/);
    expect(findElements).toHaveBeenCalledTimes(1);
  });

  it('an agent command timeout is re-probed until the handle deadline, not for the short fault window (slow agent)', async () => {
    // A CPU-starved CI emulator's hierarchy dump outruns the daemon's read
    // budget on every read for a while; the agent is alive, just slow. The
    // probe must ride it out like tap() does, not throw after 2 s.
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      calls++;
      return calls <= 12
        ? { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5250ms' }
        : makeFindElementsResponse([makeElementInfo()]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Slow'), 30_000);
    let elapsed = -1;
    expect(await withFakeClock(60_000, async () => {
      const start = Date.now();
      try {
        return await handle.exists();
      } finally {
        elapsed = Date.now() - start;
      }
    })).toBe(true);
    expect(calls).toBe(13);
    expect(elapsed).toBe(3000); // 12 retry gaps of 250ms — well past the 2s fault window
  });

  it('a persistent agent command timeout surfaces unchanged at the handle deadline, so session recovery still matches', async () => {
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => ({
      requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5250ms',
    }));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Slow'), 5000);
    let elapsed = -1;
    await expect(withFakeClock(20_000, async () => {
      const start = Date.now();
      try {
        return await handle.exists();
      } finally {
        elapsed = Date.now() - start;
      }
    })).rejects.toThrow(/findElements failed: Agent command timed out/);
    expect(elapsed).toBeGreaterThanOrEqual(4500);
    expect(elapsed).toBeLessThanOrEqual(5000);
  });

  it('an agent command timeout during the miss confirmation keeps re-probing rather than throwing or guessing', async () => {
    // Read 1 is empty, the confirming re-reads time out for a while, then a
    // read completes empty: the answer is false, not a thrown timeout after
    // the 2 s confirmation window.
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      calls++;
      if (calls === 1 || calls > 12) return makeFindElementsResponse([]);
      return { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5250ms' };
    });
    const client = makeMockClient({ findElements });
    expect(await withFakeClock(60_000, () => new ElementHandle(client, _text('Absent'), 30_000).exists())).toBe(false);
    expect(calls).toBe(13);
    // isVisible() shares the ladder.
    calls = 0;
    expect(await withFakeClock(60_000, () => new ElementHandle(client, _text('Absent'), 30_000).isVisible())).toBe(false);
    expect(calls).toBe(13);
  });

  describe('on a modified handle', () => {
    it('returns false for an absent element on .first()', async () => {
      const findElements = vi.fn(async () => makeFindElementsResponse([]));
      const client = makeMockClient({ findElements });
      const handle = new ElementHandle(client, _text('Absent'), 20_000).first();
      const start = Date.now();
      expect(await handle.exists()).toBe(false);
      expect(Date.now() - start).toBeLessThan(1000);
      expect(findElements).toHaveBeenCalledTimes(2); // one read + the confirming read
    });

    it('returns false when nth() is out of range', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ elementId: 'only' })])),
      });
      expect(await new ElementHandle(client, _text('X'), 20_000).nth(3).exists()).toBe(false);
    });

    it('returns false when a filter excludes every candidate', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () =>
          makeFindElementsResponse([makeElementInfo({ elementId: 'a', text: 'Other' })])),
      });
      const handle = new ElementHandle(client, _text('X'), 20_000).filter({ hasText: 'Wanted' });
      expect(await handle.exists()).toBe(false);
    });

    it('returns true when a filter keeps several candidates (no strict throw)', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () =>
          makeFindElementsResponse([
            makeElementInfo({ elementId: 'a', text: 'Wanted 1' }),
            makeElementInfo({ elementId: 'b', text: 'Wanted 2' }),
          ])),
      });
      const handle = new ElementHandle(client, _text('X'), 5000).filter({ hasText: 'Wanted' });
      expect(await handle.exists()).toBe(true);
    });

    it('propagates a user abort instead of answering false', async () => {
      // The old path did `try { resolve } catch { return false }`, swallowing
      // the stop signal (PILOT-222) as "doesn't exist".
      const findElements = vi.fn(async (): Promise<FindElementsResponse> => { throw new TestAbortedError(); });
      const client = makeMockClient({ findElements });
      const handle = new ElementHandle(client, _text('X'), 5000).first();
      const err = await handle.exists().catch((e: unknown) => e);
      expect(isAbortError(err)).toBe(true);
    });

    it('propagates a persistent agent fault instead of answering false', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async (): Promise<FindElementsResponse> => ({
          requestId: '1', elements: [], errorMessage: 'UiAutomation not connected',
        })),
      });
      const handle = new ElementHandle(client, _text('X'), 600).first();
      await expect(withFakeClock(5000, () => handle.exists()))
        .rejects.toThrow(/findElements failed: UiAutomation not connected/);
    });

    it('retries a transient fault within the bounded window and answers once it clears', async () => {
      let calls = 0;
      const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
        calls++;
        return calls < 2
          ? { requestId: '1', elements: [], errorMessage: 'Unknown error' }
          : makeFindElementsResponse([makeElementInfo({ text: 'Wanted' })]);
      });
      const client = makeMockClient({ findElements });
      const handle = new ElementHandle(client, _text('X'), 5000).filter({ hasText: 'Wanted' });
      expect(await withFakeClock(5000, () => handle.exists())).toBe(true);
      expect(calls).toBe(2);
    });

    it('a handle from all() is a live nth(i) locator: exists() re-queries by index and reports the row gone once the list shrank (PILOT-346)', async () => {
      let live = [makeElementInfo({ elementId: 'a' }), makeElementInfo({ elementId: 'b' })];
      const findElements = vi.fn(async () => makeFindElementsResponse(live));
      const client = makeMockClient({ findElements });
      const rows = await new ElementHandle(client, _role('listitem'), 5000).all();
      expect(await rows[1].exists()).toBe(true);
      expect(findElements).toHaveBeenCalledTimes(2); // all() + the live read
      live = live.slice(0, 1);
      expect(await withFakeClock(5000, () => rows[1].exists())).toBe(false);
    });

    it('answers false, not a throw, for a scoped child whose parent is absent', async () => {
      // _scopeToParent promises an empty scope (not the parent's "not found")
      // so count()/exists() on a scoped handle report 0/false like Playwright.
      const buttons = [makeElementInfo({ elementId: 'b1', role: 'button', bounds: { left: 10, top: 10, right: 90, bottom: 40 } })];
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(formatSelector(selector).includes('getByRole') ? buttons : []));
      const client = makeMockClient({ findElements });
      const child = new ElementHandle(client, _testId('dialog'), 20_000).first().getByRole('button');
      expect(await child.exists()).toBe(false);
    });

    it('answers true for a scoped child geometrically inside its parent', async () => {
      const dialogs = [makeElementInfo({ elementId: 'd1', bounds: { left: 0, top: 0, right: 200, bottom: 100 } })];
      const buttons = [makeElementInfo({ elementId: 'b1', role: 'button', bounds: { left: 10, top: 10, right: 90, bottom: 40 } })];
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(formatSelector(selector).includes('getByRole') ? buttons : dialogs));
      const client = makeMockClient({ findElements });
      const child = new ElementHandle(client, _testId('dialog'), 5000).first().getByRole('button');
      expect(await child.exists()).toBe(true);
    });

    it('and(): true when the operands intersect, false when they do not', async () => {
      const shared = makeElementInfo({ elementId: 'a', text: 'A' });
      let roleMatches: ElementInfo[] = [shared];
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(formatSelector(selector).includes('getByRole') ? roleMatches : [shared]));
      const client = makeMockClient({ findElements });
      const both = new ElementHandle(client, _text('A'), 20_000).and(new ElementHandle(client, _role('button'), 20_000));
      expect(await both.exists()).toBe(true);
      roleMatches = [];
      expect(await both.exists()).toBe(false);
    });

    it('or(): true when either operand matches', async () => {
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(
          formatSelector(selector).includes('getByRole') ? [makeElementInfo({ elementId: 'b' })] : []));
      const client = makeMockClient({ findElements });
      const either = new ElementHandle(client, _text('A'), 5000).or(new ElementHandle(client, _role('button'), 5000));
      expect(await either.exists()).toBe(true);
    });
  });

  it('timeout 0 is the single-shot opt-out: one read with a 0 deadline, no confirmation', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    expect(await new ElementHandle(client, _text('Absent'), 0).exists()).toBe(false);
    expect(findElements).toHaveBeenCalledTimes(1);
    expect(findElements).toHaveBeenCalledWith(expect.anything(), 0);
    expect(client.waitForIdle).not.toHaveBeenCalled();
  });

  it('a stale snapshot whose platform text mentions "not found" is still an unreliable tick, not a miss (review follow-up)', async () => {
    // The Android agent interpolates the raw StaleObjectException message into
    // its stale response; the not-found guard must not read that as absence.
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): element not found in tree' }
        : makeFindElementsResponse([makeElementInfo()]);
    });
    const client = makeMockClient({ findElements });
    expect(await withFakeClock(5000, () => new ElementHandle(client, _text('X'), 5000).exists())).toBe(true);
    expect(calls).toBe(2);
  });

  it('throws a descriptive error pointing at the waiting presence forms when the hierarchy never settles (review follow-up)', async () => {
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => ({
      requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null',
    }));
    const client = makeMockClient({ findElements });
    const err = await withFakeClock(10_000, () => new ElementHandle(client, _text('Spinner'), 5000).exists()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Could not read the state of .*Spinner/);
    expect(err.message).toMatch(/toExist\(\)/);
    expect(err.message).toMatch(/waitFor\(\{ state: 'attached' \}\)/);
    expect(err.message).not.toMatch(/toBeVisible/);
  });
});

// ─── Action methods ───

describe('tap()', () => {
  it('waits for enabled then delegates to client.tap with remaining timeout', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ tap });
    const sel = _text('Button');
    const handle = new ElementHandle(client, sel, 4000);
    await handle.tap();
    // findElements is called once by _waitForEnabled to check enabled state
    // (and that the match is unique — strict mode, PILOT-226)
    expect(client.findElements).toHaveBeenCalled();
    expect(tap).toHaveBeenCalledWith(sel, expect.any(Number));
    // Remaining timeout should be close to 4000 (minus the findElement round-trip)
    const remaining = (tap.mock.calls[0] as unknown as [unknown, number])[1];
    expect(remaining).toBeLessThanOrEqual(4000);
    expect(remaining).toBeGreaterThan(3000);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      tap: vi.fn(async () => failureResponse('Tap target not found')),
    });
    const handle = new ElementHandle(client, _text('Missing'), 5000);
    await expect(handle.tap()).rejects.toThrow('Tap target not found');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      tap: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.tap()).rejects.toThrow('Tap failed');
  });

  it('waits for a disabled element to become enabled before tapping', async () => {
    let callCount = 0;
    const findElements = vi.fn(async () => {
      callCount++;
      return makeFindElementsResponse([makeElementInfo({ enabled: callCount >= 3 })]);
    });
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Submit'), 5000);
    await handle.tap();
    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(tap).toHaveBeenCalled();
  });

  it('throws "disabled" when element is found but stays disabled', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([makeElementInfo({ enabled: false })]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Submit'), 500);
    await expect(handle.tap()).rejects.toThrow(/is disabled/);
  });

  it('reports "not found", not "disabled", when the element was disabled for a tick and then vanished (review follow-up)', async () => {
    // A Save button renders disabled once, then the step unmounts it. The
    // deadline message must describe the last thing seen, not the first.
    let calls = 0;
    const findElements = vi.fn(async () =>
      ++calls === 1 ? makeFindElementsResponse([makeElementInfo({ enabled: false })]) : makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const err = await withFakeClock(5000, () => new ElementHandle(client, _text('Save'), 2000).tap()).catch((e) => e);
    expect(err.message).toMatch(/was not found after waiting 2000ms$/);
    expect(err.message).not.toMatch(/disabled/);
  });

  it('still reports "disabled" when the element is absent for a tick and then present but disabled (review follow-up)', async () => {
    let calls = 0;
    const findElements = vi.fn(async () =>
      ++calls === 1 ? makeFindElementsResponse([]) : makeFindElementsResponse([makeElementInfo({ enabled: false })]));
    const client = makeMockClient({ findElements });
    await expect(withFakeClock(5000, () => new ElementHandle(client, _text('Save'), 2000).tap()))
      .rejects.toThrow(/is disabled after waiting 2000ms/);
  });

  it('throws "not found" when element never appears', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Ghost'), 500);
    await expect(handle.tap()).rejects.toThrow(/was not found/);
  });

  it('throws StrictModeViolationError listing all matches when the selector is ambiguous', async () => {
    const elements = [
      makeElementInfo({ text: 'Sign in to continue to DreamSpinner', role: 'text', bounds: { left: 44, top: 210, right: 436, bottom: 260 } }),
      makeElementInfo({ text: 'Sign in', role: 'button', bounds: { left: 44, top: 640, right: 436, bottom: 712 } }),
    ];
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(elements)),
      tap,
    });
    const handle = new ElementHandle(client, _textContains('Sign in'), 5000);
    const err = await handle.tap().then(
      () => { throw new Error('expected tap to reject'); },
      (e: unknown) => e,
    );
    expect(isStrictModeViolation(err)).toBe(true);
    expect(err).toBeInstanceOf(StrictModeViolationError);
    expect((err as StrictModeViolationError).elements).toHaveLength(2);
    expect((err as Error).message).toBe(
      'strict mode violation: getByText("Sign in") resolved to 2 elements:\n' +
      '    1) text "Sign in to continue to DreamSpinner" [44,210][436,260] aka device.getByText("Sign in to continue to DreamSpinner", { exact: true })\n' +
      '    2) button "Sign in" [44,640][436,712] aka device.getByRole("button", { name: "Sign in" })\n' +
      'Hint: use { exact: true }, getByRole(role, { name }), getByTestId(), or .first()/.nth()/.last() to target a single element.',
    );
    // Strict violations must throw immediately — no polling out the timeout
    expect(client.findElements).toHaveBeenCalledTimes(1);
    expect(tap).not.toHaveBeenCalled();
  });

  it('.first() disambiguates an ambiguous selector', async () => {
    const elements = [
      makeElementInfo({ text: 'Sign in to continue', resourceId: 'subtitle' }),
      makeElementInfo({ text: 'Sign in', resourceId: 'button' }),
    ];
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(elements)),
      tap,
    });
    const handle = new ElementHandle(client, _textContains('Sign in'), 5000);
    await handle.first().tap();
    expect(tap).toHaveBeenCalled();
  });

  it('with timeout 0 skips the enabled wait and still invokes tap', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([makeElementInfo({ enabled: true })]));
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Now'), 0);
    await handle.tap();
    expect(findElements).not.toHaveBeenCalled();
    expect(tap).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('propagates non-"not found" errors from findElements instead of masking them as timeout', async () => {
    // Regression: the old catch-all swallowed gRPC failures and surfaced
    // them as "Element X was not found after waiting Nms", obscuring the
    // real cause (e.g. daemon crashed, network down). Only no-match errors
    // should keep the poll loop alive; everything else must propagate.
    const findElements = vi.fn(async () => {
      throw new Error('14 UNAVAILABLE: No connection established');
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Anything'), 5000);
    await expect(handle.tap()).rejects.toThrow(/UNAVAILABLE/);
  });

  it('floors the action budget when the element becomes enabled near the deadline', async () => {
    // Use fake timers so the test doesn't burn ~2s of real wall time. The
    // mock's setTimeout and _waitForEnabled's Date.now()/setTimeout both run
    // against the faked clock.
    vi.useFakeTimers();
    try {
      const findElements = vi.fn(async () => {
        // Burn almost the whole 2000ms budget before reporting enabled.
        await new Promise((r) => setTimeout(r, 1900));
        return makeFindElementsResponse([makeElementInfo({ enabled: true })]);
      });
      const tap = vi.fn(async () => successResponse());
      const client = makeMockClient({ findElements, tap });
      const handle = new ElementHandle(client, _text('Late'), 2000);

      const tapPromise = handle.tap();
      // Drain microtasks + advance the fake clock past the simulated 1900ms
      // findElement delay so _waitForEnabled observes the enabled element
      // with ~100ms remaining.
      await vi.advanceTimersByTimeAsync(2000);
      await tapPromise;

      // Action budget must be >= 1000ms so client.tap has time to execute,
      // even though only ~100ms of the shared deadline remains.
      const actionBudget = (tap.mock.calls[0] as unknown as [unknown, number])[1];
      expect(actionBudget).toBeGreaterThanOrEqual(1000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('longPress()', () => {
  it('waits for enabled then delegates to client.longPress', async () => {
    const longPress = vi.fn(async () => successResponse());
    const client = makeMockClient({ longPress });
    const sel = _text('Item');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.longPress(1000);
    expect(longPress).toHaveBeenCalledWith(sel, 1000, expect.any(Number));
    const remaining = (longPress.mock.calls[0] as unknown as [unknown, unknown, number])[2];
    expect(remaining).toBeLessThanOrEqual(5000);
    expect(remaining).toBeGreaterThan(4000);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      longPress: vi.fn(async () => failureResponse('Long press failed')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.longPress()).rejects.toThrow('Long press failed');
  });
});

describe('type()', () => {
  it('delegates to client.typeText', async () => {
    const typeText = vi.fn(async () => successResponse());
    const client = makeMockClient({ typeText });
    const sel = _text('Input');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.type('hello');
    expect(typeText).toHaveBeenCalledWith(sel, 'hello', expect.any(Number), 0);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      typeText: vi.fn(async () => failureResponse('Type failed')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.type('abc')).rejects.toThrow('Type failed');
  });
});

describe('clearAndType()', () => {
  it('delegates to client.clearAndType', async () => {
    const clearAndType = vi.fn(async () => successResponse());
    const client = makeMockClient({ clearAndType });
    const sel = _text('Field');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.clearAndType('new value');
    expect(clearAndType).toHaveBeenCalledWith(sel, 'new value', expect.any(Number), 0);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      clearAndType: vi.fn(async () => failureResponse()),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.clearAndType('x')).rejects.toThrow('Action failed');
  });
});

describe('clear()', () => {
  it('delegates to client.clearText', async () => {
    const clearText = vi.fn(async () => successResponse());
    const client = makeMockClient({ clearText });
    const sel = _text('Field');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.clear();
    expect(clearText).toHaveBeenCalledWith(sel, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      clearText: vi.fn(async () => failureResponse('Cannot clear')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.clear()).rejects.toThrow('Cannot clear');
  });
});

describe('scroll()', () => {
  it('delegates to client.scroll', async () => {
    const scroll = vi.fn(async () => successResponse());
    const client = makeMockClient({ scroll });
    const sel = _text('List');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.scroll('down', { distance: 500 });
    // timeoutMs is the resolution-remaining budget (deadline - now), which is
    // 5000 only if <1ms elapsed during the async find — assert the type, not an
    // exact value, matching the sibling action tests above.
    expect(scroll).toHaveBeenCalledWith(sel, 'down', {
      distance: 500,
      timeoutMs: expect.any(Number),
    });
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      scroll: vi.fn(async () => failureResponse('Scroll failed')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.scroll('up')).rejects.toThrow('Scroll failed');
  });
});

// ─── Info accessors ───

describe('getText()', () => {
  it('returns text from found element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ text: 'Content here' })])),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    const result = await handle.getText();
    expect(result).toBe('Content here');
  });
});

// ─── Visibility probes: non-waiting (PILOT-287) ───
// isVisible/isHidden resolve the CURRENT state once and answer for an absent
// element (false / true) — they never wait for the element and never throw
// "not found". Waiting belongs to expect(...).toBeVisible() / waitFor(). The
// other state readers (isEnabled/isChecked/isEditable) keep Playwright's
// find-then-read contract and DO wait, then throw when absent.

/**
 * Run a poll loop against a faked clock so the unit suite does not sleep for
 * real: `fn` is started, the clock is advanced `advanceMs` (firing every
 * `sleep()` timer in order and flushing microtasks between them), then the
 * outcome is returned or rethrown. `Date.now()` inside `fn` is faked too, so
 * elapsed-time assertions are exact rather than wall-clock dependent. The
 * rejection is captured up front so an early failure is never left unhandled
 * while the clock is still advancing.
 */
async function withFakeClock<T>(advanceMs: number, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const outcome = fn().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(advanceMs);
    const result = await outcome;
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    vi.useRealTimers();
  }
}

describe('isVisible()', () => {
  it('returns visibility from found element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ visible: false })])),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    expect(await handle.isVisible()).toBe(false);
  });

  it('returns true for a visible element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ visible: true })])),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    expect(await handle.isVisible()).toBe(true);
  });

  it('returns false immediately when the element is absent — no auto-wait, no throw', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    // A long timeout: the old find()-based implementation would poll for all
    // of it and then throw "was not found after waiting".
    const handle = new ElementHandle(client, _text('Absent'), 20_000);
    const start = Date.now();
    expect(await handle.isVisible()).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
    // Two reads, not a poll: the first empty read is confirmed once (after a
    // bounded idle wait, so a lagging accessibility tree can catch up), and
    // the second empty read is the answer — not a "not yet".
    expect(findElements).toHaveBeenCalledTimes(2);
    expect(client.waitForIdle).toHaveBeenCalledTimes(1);
    expect(client.waitForIdle).toHaveBeenCalledWith(1500);
  });

  it('confirms a first empty read, so a lagging accessibility tree does not read as absence (review follow-up)', async () => {
    // PILOT-283: right after navigation the tree can briefly describe the
    // previous screen with no error. `if (await btn.isHidden()) return` on one
    // such read would skip a visible button.
    let calls = 0;
    const findElements = vi.fn(async () =>
      ++calls === 1 ? makeFindElementsResponse([]) : makeFindElementsResponse([makeElementInfo({ visible: true })]));
    const waitForIdle = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, waitForIdle });
    expect(await new ElementHandle(client, _text('Enable notifications'), 5000).isVisible()).toBe(true);
    expect(calls).toBe(2);
    expect(waitForIdle).toHaveBeenCalledTimes(1);
  });

  it('confirms the miss at most once, and the idle wait is best effort and capped by the handle timeout (review follow-up)', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const waitForIdle = vi.fn(async () => { throw new Error('waitForIdle unsupported'); });
    const client = makeMockClient({ findElements, waitForIdle });
    expect(await new ElementHandle(client, _text('Absent'), 800).isVisible()).toBe(false);
    expect(findElements).toHaveBeenCalledTimes(2);
    expect(waitForIdle).toHaveBeenCalledWith(800);
  });

  it('a stale confirming re-read does not turn an absent answer into a stall or a throw (review follow-up)', async () => {
    // Spinner screen, element genuinely absent: read 1 is empty, the idle wait
    // never settles, and every re-read is stale. The first answer must stand
    // after a short confirmation window — not a 30s churn ending in a throw.
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      calls++;
      if (calls === 1) return makeFindElementsResponse([]);
      return { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' };
    });
    const waitForIdle = vi.fn(() => new Promise<ReturnType<typeof successResponse>>((resolve) => {
      setTimeout(() => resolve(successResponse()), 1500);
    }));
    const client = makeMockClient({ findElements, waitForIdle });
    const start = Date.now();
    expect(await withFakeClock(60_000, () => new ElementHandle(client, _text('Dismiss'), 30_000).isVisible())).toBe(false);
    // 1.5s idle wait + a ≤2s confirmation window of 250ms re-reads.
    expect(Date.now() - start).toBeLessThan(4000);
    expect(calls).toBeLessThan(12);
    expect(waitForIdle).toHaveBeenCalledTimes(1);
  });

  it('an empty read closes an open fault window, so a blip after the miss confirmation gets its full grace (review follow-up)', async () => {
    // Fault at t=0 (window to t=2000), empty read at t=250, idle wait until
    // ~t=1850, second blip, then the confirming empty read. The second blip
    // must be retried — not thrown because the FIRST blip's window is nearly up.
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      calls++;
      if (calls === 1 || calls === 3) return { requestId: '1', elements: [], errorMessage: 'UiAutomation not connected' };
      return makeFindElementsResponse([]);
    });
    const waitForIdle = vi.fn(() => new Promise<ReturnType<typeof successResponse>>((resolve) => {
      setTimeout(() => resolve(successResponse()), 1600);
    }));
    const client = makeMockClient({ findElements, waitForIdle });
    expect(await withFakeClock(60_000, () => new ElementHandle(client, _text('Dismiss'), 30_000).isVisible())).toBe(false);
    expect(calls).toBe(4);
  });

  it('returns false for an absent element on a modified handle (.first())', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Absent'), 20_000).first();
    expect(await handle.isVisible()).toBe(false);
    expect(findElements).toHaveBeenCalledTimes(2); // one read + the confirming read
  });

  it('returns false when nth() is out of range', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ elementId: 'only' })])),
    });
    const handle = new ElementHandle(client, _text('X'), 20_000).nth(3);
    expect(await handle.isVisible()).toBe(false);
  });

  it('returns false for an absent element on a filtered handle', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () =>
        makeFindElementsResponse([makeElementInfo({ elementId: 'a', text: 'Other', visible: true })])),
    });
    const handle = new ElementHandle(client, _text('X'), 20_000).filter({ hasText: 'Wanted' });
    expect(await handle.isVisible()).toBe(false);
  });

  it('still enforces strict mode: an ambiguous selector throws rather than reporting the first match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () =>
        makeFindElementsResponse([
          makeElementInfo({ elementId: 'a', visible: true }),
          makeElementInfo({ elementId: 'b', visible: false }),
        ])),
    });
    const handle = new ElementHandle(client, _text('Dup'), 5000);
    const err = await handle.isVisible().catch((e) => e);
    expect(err).toBeInstanceOf(StrictModeViolationError);
  });

  it('does not report a momentary agent fault as absence — retries and reads the state once it clears', async () => {
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'Unknown error' }
        : makeFindElementsResponse([makeElementInfo({ visible: true })]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 5000);
    expect(await withFakeClock(5000, () => handle.isVisible())).toBe(true);
    expect(calls).toBe(2);
  });

  it('treats a stale snapshot as an unreliable tick, not a confirmed miss', async () => {
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' }
        : makeFindElementsResponse([makeElementInfo({ visible: true })]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 5000);
    expect(await withFakeClock(5000, () => handle.isVisible())).toBe(true);
    expect(calls).toBe(2);
  });

  it('surfaces a persistent agent fault instead of returning false', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async (): Promise<FindElementsResponse> => ({
        requestId: '1',
        elements: [],
        errorMessage: 'UiAutomation not connected',
      })),
    });
    const handle = new ElementHandle(client, _text('X'), 600);
    await expect(withFakeClock(5000, () => handle.isVisible()))
      .rejects.toThrow(/findElements failed: UiAutomation not connected/);
  });

  it('re-probes a fast-failing agent fault only for the short window, not the handle timeout (review follow-up)', async () => {
    // A 30s handle timeout must not turn a persistently faulting agent into a
    // 30s stall — the probe promises not to wait for the element. It re-probes
    // briefly (window measured from the first failure; each mock call answers
    // instantly, so elapsed time is the sum of the retry gaps), then surfaces
    // the real error. The read's own deadline is deliberately the handle
    // timeout so a slow-but-healthy dump completes — see the next test.
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => ({
      requestId: '1', elements: [], errorMessage: 'UiAutomation not connected',
    }));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 30_000);
    let elapsed = -1;
    await expect(withFakeClock(60_000, async () => {
      const start = Date.now();
      try {
        return await handle.isVisible();
      } finally {
        elapsed = Date.now() - start;
      }
    })).rejects.toThrow(/findElements failed/);
    // Re-reads are issued while a poll gap still fits in the 2s window
    // (fast-failing reads at 250ms steps → the last is issued at 2000ms).
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(5000);
  });

  it('caps the retry window at a shorter handle timeout (review follow-up)', async () => {
    // A caller who set 300ms must not wait ~2s for a fault to surface.
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => ({
      requestId: '1', elements: [], errorMessage: 'UiAutomation not connected',
    }));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 300);
    let elapsed = -1;
    await expect(withFakeClock(5000, async () => {
      const start = Date.now();
      try {
        return await handle.isVisible();
      } finally {
        elapsed = Date.now() - start;
      }
    })).rejects.toThrow(/findElements failed/);
    expect(elapsed).toBeLessThan(1000);
    expect(findElements.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('re-probes an agent command timeout until the handle deadline (slow agent), each read still tick-bounded, then surfaces it unchanged', async () => {
    // Every read carries one poll interval of budget (the daemon's headroom
    // bounds the dump), so a timeout never means "the agent had the whole
    // handle timeout". But the agent IS alive — a starved emulator's dump is
    // just slow — so, like the action ladders, the probe rides it out to the
    // handle deadline instead of throwing after the 2s fault window, and a
    // persistent one is then thrown unchanged so session recovery fires.
    const budgets: number[] = [];
    const findElements = vi.fn(async (_sel: unknown, budget?: number): Promise<FindElementsResponse> => {
      budgets.push(budget!);
      return { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5250ms' };
    });
    const client = makeMockClient({ findElements });
    let elapsed = -1;
    await expect(withFakeClock(60_000, async () => {
      const start = Date.now();
      try {
        return await new ElementHandle(client, _text('X'), 30_000).isVisible();
      } finally {
        elapsed = Date.now() - start;
      }
    })).rejects.toThrow(/Agent command timed out/);
    expect(findElements.mock.calls.length).toBeGreaterThan(100);
    for (const b of budgets) expect(b).toBeLessThanOrEqual(250);
    expect(budgets.slice(0, -1).every((b) => b === 250)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(29_500);
    expect(elapsed).toBeLessThanOrEqual(30_000);
  });

  it('re-probes stale snapshots until the handle timeout and reads the element once a tick lands (review follow-up)', async () => {
    // Stale = the screen is busy (animating spinner). That is normal, so —
    // like find()/waitFor — keep re-probing for the handle timeout, not the
    // short fault window; the element IS there and gets read between frames.
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> =>
      ++calls < 12
        ? { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' }
        : makeFindElementsResponse([makeElementInfo({ visible: true })]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Spinner'), 10_000);
    let elapsed = -1;
    expect(await withFakeClock(10_000, async () => {
      const start = Date.now();
      const result = await handle.isVisible();
      elapsed = Date.now() - start;
      return result;
    })).toBe(true);
    expect(calls).toBe(12);
    // 11 retry gaps of 250ms: well past the 2s fault window, well short of the timeout.
    expect(elapsed).toBe(2750);
  });

  it('throws a descriptive error — never a silent answer — when the hierarchy never settles (review follow-up)', async () => {
    // A silent "hidden" would take the ready branch on exactly the screen that
    // produces stale snapshots. Fail loudly, with what happened and guidance,
    // and without the raw agent string as the headline.
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => ({
      requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null',
    }));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Spinner'), 5000);
    const err = await withFakeClock(10_000, () => handle.isHidden()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Could not read the state of .*Spinner/);
    // Reports what happened (reads + elapsed), not a budget: reads every
    // 250ms from 0 to 5000ms; after the read at 5000ms no poll gap fits.
    expect(err.message).toMatch(/kept changing \(stale snapshot\) across 21 reads over 5000ms/);
    expect(err.message).toMatch(/not\.toBeVisible\(\) or waitFor\(\)/);
    expect(findElements).toHaveBeenCalledTimes(21);
  });

  it('gives a short handle timeout its second tick, like find() (review follow-up)', async () => {
    // timeout: 400 — one stale read at 0ms must not hard-fail the probe; the
    // find()-backed path on main got a second tick at 250ms and usually
    // answered. Every read carries min(250ms, time left) — a 1ms floor is
    // fine, the daemon's headroom bounds the dump — so no minimum budget
    // gate can eat the retry.
    const budgets: number[] = [];
    let calls = 0;
    const findElements = vi.fn(async (_sel: unknown, budget?: number): Promise<FindElementsResponse> => {
      budgets.push(budget!);
      return ++calls === 1
        ? { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' }
        : makeFindElementsResponse([makeElementInfo({ visible: true })]);
    });
    const client = makeMockClient({ findElements });
    expect(await withFakeClock(5000, () => new ElementHandle(client, _text('X'), 400).isVisible())).toBe(true);
    expect(budgets).toEqual([250, 150]);
  });

  it('a momentary agent command timeout between a stale tick and a good read is ridden out (review follow-up)', async () => {
    // "Agent command timed out" is in the worker's recoverable-infrastructure
    // patterns: thrown from a probe, it tears down and recovers the session.
    // A single one is a blip like any other fault and is retried.
    const budgets: number[] = [];
    let calls = 0;
    const findElements = vi.fn(async (_sel: unknown, budget?: number): Promise<FindElementsResponse> => {
      budgets.push(budget!);
      calls++;
      if (calls === 1) return { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' };
      if (calls === 2) return { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 1000ms' };
      return makeFindElementsResponse([makeElementInfo({ visible: true })]);
    });
    const client = makeMockClient({ findElements });
    expect(await withFakeClock(60_000, () => new ElementHandle(client, _text('X'), 30_000).isVisible())).toBe(true);
    expect(calls).toBe(3);
    expect(budgets).toEqual([250, 250, 250]);
  });

  it('a stale read followed by persistent agent command timeouts surfaces the timeout at the handle deadline, not a stall error (review follow-up)', async () => {
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => ({
      requestId: '1', elements: [],
      errorMessage: ++calls === 1 ? 'Element is stale (UI changed): null' : 'Agent command timed out after 1000ms',
    }));
    const client = makeMockClient({ findElements });
    let elapsed = -1;
    await expect(withFakeClock(60_000, async () => {
      const start = Date.now();
      try {
        return await new ElementHandle(client, _text('X'), 30_000).isVisible();
      } finally {
        elapsed = Date.now() - start;
      }
    })).rejects.toThrow(/Agent command timed out/);
    // A slow agent gets the handle deadline (like an action), then the real
    // error — not "Could not read the state" — so session recovery matches.
    expect(elapsed).toBeGreaterThanOrEqual(29_500);
    expect(elapsed).toBeLessThanOrEqual(30_000);
  });

  it('a fault that is slow to fail is not re-read once the fault window has less than a poll gap left (review follow-up)', async () => {
    // Every read takes 1.5s to fail (a socket that is slow to refuse). The
    // window, not the handle timeout, decides whether another read is issued.
    const budgets: number[] = [];
    const findElements = vi.fn(async (_sel: unknown, budget?: number): Promise<FindElementsResponse> => {
      budgets.push(budget!);
      await new Promise((r) => setTimeout(r, 1500));
      return { requestId: '1', elements: [], errorMessage: 'Not connected to agent' };
    });
    const client = makeMockClient({ findElements });
    let elapsed = -1;
    await expect(withFakeClock(60_000, async () => {
      const start = Date.now();
      try {
        return await new ElementHandle(client, _text('X'), 30_000).isVisible();
      } finally {
        elapsed = Date.now() - start;
      }
    })).rejects.toThrow(/Not connected to agent/);
    // Fault at 1500ms opens a window to 3500ms; reads at 1750 (fails 3250) and
    // 3500 (fails 5000; 250ms was left when it was issued); then thrown.
    expect(budgets).toEqual([250, 250, 250]);
    expect(elapsed).toBe(5000);
  });

  it('bounds the reads a filter({ has }) chain issues by the same budget (review follow-up)', async () => {
    // The re-timed clone carries the budget into every read the chain issues
    // in sequence — here the parent query and the `has` child query — so an
    // operand's or the handle's own long timeout never leaks into a re-read.
    const reads: Array<{ sel: string; budget: number }> = [];
    let calls = 0;
    const findElements = vi.fn(async (sel: unknown, budget?: number): Promise<FindElementsResponse> => {
      reads.push({ sel: JSON.stringify(sel), budget: budget! });
      calls++;
      // Parent reads succeed; the child read is stale so the probe re-reads.
      if (calls % 2 === 1) return makeFindElementsResponse([makeElementInfo({ elementId: 'card', visible: true })]);
      return { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' };
    });
    const client = makeMockClient({ findElements });
    const child = new ElementHandle(client, _text('Sale'), 30_000);
    const handle = new ElementHandle(client, _role('listitem'), 3000).filter({ has: child });
    await expect(withFakeClock(10_000, () => handle.isVisible())).rejects.toThrow(/Could not read the state of/);
    // Each tick issues parent then child; both carry that tick's budget.
    expect(reads.length % 2).toBe(0);
    for (let i = 0; i < reads.length; i += 2) {
      expect(reads[i + 1].budget).toBe(reads[i].budget);
      expect(reads[i].budget).toBeLessThanOrEqual(250);
      expect(reads[i].budget).toBeGreaterThanOrEqual(1);
    }
    expect(reads[0].budget).toBe(250);
  });

  it('explains a single stale read that left no room for another as the read using the budget — not as a too-short timeout (review follow-up)', async () => {
    // A 5000ms handle whose one read took 4900ms: the message must not say
    // "timeout is 5000ms, so it was not retried" (reads as "raise it").
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      await new Promise((r) => setTimeout(r, 4900));
      return { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' };
    });
    const client = makeMockClient({ findElements });
    const err = await withFakeClock(10_000, () => new ElementHandle(client, _text('X'), 5000).isVisible()).catch((e) => e);
    expect(err.message).toMatch(
      /a single read returned a stale snapshot .*; it took 4900ms, and the 100ms left of the 5000ms timeout is not enough for another read \(a re-read needs at least 250ms\)/,
    );
    expect(err.message).not.toMatch(/so it was not retried/);
    expect(findElements).toHaveBeenCalledTimes(1);
  });

  it('applies the read budget on modified handles too, so .first()/.nth()/.filter() probes cannot overrun the timeout (review follow-up)', async () => {
    // _resolveOne() → _resolveAll() reads with the handle's OWN timeout; on a
    // wedged agent that is timeout + headroom per read. The probe re-times the
    // tree per read, as _resolveForWaitTick does.
    const budgets: number[] = [];
    const findElements = vi.fn(async (_sel: unknown, budget?: number): Promise<FindElementsResponse> => {
      budgets.push(budget!);
      return { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' };
    });
    const client = makeMockClient({ findElements });
    const base = new ElementHandle(client, _text('X'), 3000);
    for (const handle of [base.first(), base.nth(2), base.filter({ hasText: 'Y' })]) {
      budgets.length = 0;
      await expect(withFakeClock(5000, () => handle.isVisible())).rejects.toThrow(/Could not read the state of/);
      // One poll interval per read (the last gets what is left: 1ms floor).
      expect(budgets.length).toBe(13);
      for (const b of budgets.slice(0, -1)) expect(b).toBe(250);
      expect(budgets.at(-1)!).toBeGreaterThanOrEqual(1);
    }
  });

  it('surfaces a fault that persists, after the short fault window — even if stale ticks preceded it (review follow-up)', async () => {
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => ({
      requestId: '1', elements: [],
      errorMessage: ++calls <= 2 ? 'Element is stale (UI changed): null' : 'UiAutomation not connected',
    }));
    const client = makeMockClient({ findElements });
    let elapsed = -1;
    await expect(withFakeClock(60_000, async () => {
      const start = Date.now();
      try {
        return await new ElementHandle(client, _text('X'), 30_000).isVisible();
      } finally {
        elapsed = Date.now() - start;
      }
    })).rejects.toThrow(/findElements failed: UiAutomation not connected/);
    // Stale ticks (0.5s) + fault window (2s): nowhere near the 30s timeout.
    expect(elapsed).toBeLessThan(5000);
  });

  it('gives every momentary fault the same short grace, not just the first one (review follow-up)', async () => {
    // Fault, then stale churn past the first fault window, then ONE more blip,
    // then the element. The second blip must be retried (its window re-opens),
    // not thrown at once because the first window elapsed long ago.
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      calls++;
      if (calls === 1 || calls === 12) return { requestId: '1', elements: [], errorMessage: 'UiAutomation not connected' };
      if (calls < 12) return { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' };
      return makeFindElementsResponse([makeElementInfo({ visible: true })]);
    });
    const client = makeMockClient({ findElements });
    expect(await withFakeClock(60_000, () => new ElementHandle(client, _text('X'), 30_000).isVisible())).toBe(true);
    expect(calls).toBe(13);
  });

  it('issues every read with one poll interval of budget, so the call cannot overrun the handle timeout (review follow-up)', async () => {
    // The daemon's headroom bounds the dump, not this budget; a small budget
    // keeps a wedged agent from holding the call for timeout + headroom.
    const budgets: number[] = [];
    const findElements = vi.fn(async (_sel: unknown, budget?: number): Promise<FindElementsResponse> => {
      budgets.push(budget!);
      return { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' };
    });
    const client = makeMockClient({ findElements });
    await expect(withFakeClock(5000, () => new ElementHandle(client, _text('X'), 3000).isVisible()))
      .rejects.toThrow(/kept changing/);
    expect(budgets.length).toBe(13);
    for (const b of budgets) expect(b).toBeLessThanOrEqual(250);
  });

  it('a later stale tick clears a momentary fault, so stale churn reports churn — not the recovered fault (review follow-up)', async () => {
    // Convention shared with _strictResolve/_waitForEnabled/waitFor: a
    // definitive agent answer drops the remembered fault. Otherwise a
    // long-gone "Not connected to agent" blip could trigger session-level
    // recovery for a device that was merely animating.
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => ({
      requestId: '1', elements: [],
      errorMessage: ++calls === 1 ? 'Not connected to agent' : 'Element is stale (UI changed): null',
    }));
    const client = makeMockClient({ findElements });
    const err = await withFakeClock(10_000, () => new ElementHandle(client, _text('X'), 5000).isVisible()).catch((e) => e);
    expect(err.message).toMatch(/Could not read the state of/);
    expect(err.message).not.toMatch(/Not connected to agent/);
    // The diagnostic counts stale reads as stale reads, and says a fault occurred.
    expect(err.message).toMatch(/across 20 reads over 5000ms \(plus 1 momentary agent fault that cleared\)/);
    expect(calls).toBe(21);
  });

  it('a handle from all() is a live nth(i) locator, so a check and the tap it guards describe the same element — whatever is at that index NOW (PILOT-346)', async () => {
    // The PILOT-346 scenario: rows = [A, B, C]; tapping rows[0] removes A and
    // the list shifts up. `if (await rows[1].isVisible()) await rows[1].tap()`
    // must check and tap the SAME element — the one now at index 1 (C) —
    // never check C and tap the captured B.
    let live = [
      makeElementInfo({ elementId: 'a', text: 'A', bounds: { left: 0, top: 0, right: 10, bottom: 10 } }),
      makeElementInfo({ elementId: 'b', text: 'B', bounds: { left: 0, top: 10, right: 10, bottom: 20 } }),
      makeElementInfo({ elementId: 'c', text: 'C', bounds: { left: 0, top: 20, right: 10, bottom: 30 } }),
    ];
    const tap = vi.fn(async (_sel: unknown, _t: unknown, id?: string) => {
      live = live.filter((e) => e.elementId !== id); // the tapped row is removed
      return successResponse();
    });
    const client = makeMockClient({ findElements: vi.fn(async () => makeFindElementsResponse(live)), tap });
    const rows = await new ElementHandle(client, _role('listitem'), 5000).all();
    expect(rows).toHaveLength(3);
    await rows[0].tap();
    expect(tap).toHaveBeenLastCalledWith(undefined, expect.any(Number), 'a');
    // Every reader and the action agree on the element now at index 1.
    expect(await rows[1].isVisible()).toBe(true);
    expect(await rows[1].isHidden()).toBe(false);
    expect((await rows[1].find()).text).toBe('C');
    expect(await rows[1].getText()).toBe('C');
    expect((await rows[1].boundingBox())?.y).toBe(20);
    await rows[1].tap();
    expect(tap).toHaveBeenLastCalledWith(undefined, expect.any(Number), 'c');
    // Nothing is at the captured last index any more.
    expect(await rows[2].count()).toBe(0);
    expect(await withFakeClock(5000, () => rows[2].exists())).toBe(false);
    expect(await withFakeClock(5000, () => rows[2].isVisible())).toBe(false);
  });

  it('filter() on a handle from all() narrows THAT row, like Playwright: row i if it matches, nothing otherwise (PILOT-346)', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ elementId: 'a', text: 'Apple' }),
        makeElementInfo({ elementId: 'b', text: 'Banana — sold out' }),
      ])),
    });
    const rows = await new ElementHandle(client, _role('listitem'), 5000).all();
    expect(await rows[1].filter({ hasText: 'sold out' }).count()).toBe(1);
    expect((await rows[1].filter({ hasText: 'sold out' }).find()).elementId).toBe('b');
    // Row 0 does not match: the filter yields nothing. It never re-indexes
    // over the filtered set (that would be `list.filter(…).nth(0)`).
    expect(await rows[0].filter({ hasText: 'sold out' }).count()).toBe(0);
    expect(await rows[0].filter({ hasNotText: 'sold out' }).count()).toBe(1);
  });

  it('and()/or() on a handle from all() take THAT row as the left operand (PILOT-346)', async () => {
    const rowsInfo = [
      makeElementInfo({ elementId: 'a', text: 'A', bounds: { left: 0, top: 0, right: 10, bottom: 10 } }),
      makeElementInfo({ elementId: 'b', text: 'B', bounds: { left: 0, top: 10, right: 10, bottom: 20 } }),
    ];
    const client = makeMockClient({
      // getByRole("button") matches only B (identity = bounds + text; ids churn per read).
      findElements: vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(formatSelector(selector).includes('button') ? [{ ...rowsInfo[1], elementId: 'b2' }] : rowsInfo)),
    });
    const rows = await new ElementHandle(client, _role('listitem'), 5000).all();
    const button = new ElementHandle(client, _role('button'), 5000);
    expect(await rows[0].and(button).count()).toBe(0); // row 0 is not a button
    expect(await rows[1].and(button).count()).toBe(1); // row 1 is
    expect(await rows[0].or(button).count()).toBe(2); // A, plus the button
    expect(await rows[1].or(button).count()).toBe(1); // B, de-duplicated
  });

  it('an all() handle is accepted as the OTHER operand too, and names that row (PILOT-346)', async () => {
    const rowsInfo = [
      makeElementInfo({ elementId: 'a', text: 'A', bounds: { left: 0, top: 0, right: 10, bottom: 10 } }),
      makeElementInfo({ elementId: 'b', text: 'B', bounds: { left: 0, top: 10, right: 10, bottom: 20 } }),
    ];
    const client = makeMockClient({
      findElements: vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(formatSelector(selector).includes('button') ? [{ ...rowsInfo[1], elementId: 'b2' }] : rowsInfo)),
    });
    const list = new ElementHandle(client, _role('listitem'), 5000);
    const rows = await list.all();
    const button = new ElementHandle(client, _role('button'), 5000);
    expect(await button.and(rows[1]).count()).toBe(1);
    expect(await button.and(rows[0]).count()).toBe(0);
    expect(await button.or(rows[0]).count()).toBe(2);
    // As a `has` operand it is a plain locator like any other (its modifiers
    // are PILOT-361's concern) — no longer refused.
    expect(() => list.filter({ has: rows[0] })).not.toThrow();
  });

  it('works with timeout: 0 — one read on the daemon default deadline, no artificial 1ms budget (review follow-up)', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Absent'), 0);
    expect(await handle.isVisible()).toBe(false);
    expect(findElements).toHaveBeenCalledTimes(1);
    // 0 is passed through: the daemon treats it as "use the default deadline".
    expect(findElements).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('timeout: 0 is single-shot — an unreliable tick is not retried (review follow-up)', async () => {
    const stale = vi.fn(async (): Promise<FindElementsResponse> => ({
      requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null',
    }));
    await expect(new ElementHandle(makeMockClient({ findElements: stale }), _text('X'), 0).isVisible())
      .rejects.toThrow(/a single read returned a stale snapshot .*; timeout is 0 \(single-shot\), so it was not retried/);
    expect(stale).toHaveBeenCalledTimes(1);

    const fault = vi.fn(async (): Promise<FindElementsResponse> => ({
      requestId: '1', elements: [], errorMessage: 'UiAutomation not connected',
    }));
    await expect(new ElementHandle(makeMockClient({ findElements: fault }), _text('X'), 0).isVisible())
      .rejects.toThrow(/findElements failed/);
    expect(fault).toHaveBeenCalledTimes(1);
  });
});

describe('isHidden()', () => {
  it('is the opposite of isVisible for a found element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ visible: false })])),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    expect(await handle.isHidden()).toBe(true);
    expect(await handle.isVisible()).toBe(false);
  });

  it('returns false for a visible element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ visible: true })])),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    expect(await handle.isHidden()).toBe(false);
  });

  it('returns true immediately when the element is absent — no auto-wait, no throw', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Absent'), 20_000);
    const start = Date.now();
    expect(await handle.isHidden()).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(findElements).toHaveBeenCalledTimes(2); // one read + the confirming read
  });

  it('returns true for an absent element on a modified handle (.first())', async () => {
    const client = makeMockClient({ findElements: vi.fn(async () => makeFindElementsResponse([])) });
    expect(await new ElementHandle(client, _text('Absent'), 20_000).first().isHidden()).toBe(true);
  });

  it('still enforces strict mode on an ambiguous selector', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () =>
        makeFindElementsResponse([
          makeElementInfo({ elementId: 'a', visible: false }),
          makeElementInfo({ elementId: 'b', visible: false }),
        ])),
    });
    const err = await new ElementHandle(client, _text('Dup'), 5000).isHidden().catch((e) => e);
    expect(err).toBeInstanceOf(StrictModeViolationError);
  });

  it('does not report a momentary agent fault as hidden — retries and reads the state once it clears', async () => {
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'Unknown error' }
        : makeFindElementsResponse([makeElementInfo({ visible: true })]);
    });
    const client = makeMockClient({ findElements });
    expect(await withFakeClock(5000, () => new ElementHandle(client, _text('X'), 5000).isHidden())).toBe(false);
    expect(calls).toBe(2);
  });

  it('surfaces a persistent agent fault instead of returning true', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async (): Promise<FindElementsResponse> => ({
        requestId: '1', elements: [], errorMessage: 'UiAutomation not connected',
      })),
    });
    await expect(withFakeClock(5000, () => new ElementHandle(client, _text('X'), 600).isHidden()))
      .rejects.toThrow(/findElements failed: UiAutomation not connected/);
  });
});

describe('isEnabled()', () => {
  it('returns enabled state from found element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ enabled: false })])),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    expect(await handle.isEnabled()).toBe(false);
  });

  it('waits for the element and throws when it never appears (Playwright contract, unlike isVisible)', async () => {
    // A negative answer must describe a real element: absence is an error, not
    // "not enabled", or a broken screen would read as a disabled control.
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Absent'), 600);
    await expect(withFakeClock(5000, () => handle.isEnabled())).rejects.toThrow(/was not found after waiting 600ms/);
    expect(findElements.mock.calls.length).toBeGreaterThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// New Locator API tests (PILOT-13 through PILOT-17)
// ═══════════════════════════════════════════════════════════════════════

const threeItems: ElementInfo[] = [
  makeElementInfo({ elementId: 'el-1', text: 'Apple', resourceId: 'item_1', bounds: { left: 0, top: 0, right: 100, bottom: 50 } }),
  makeElementInfo({ elementId: 'el-2', text: 'Banana', resourceId: 'item_2', bounds: { left: 0, top: 50, right: 100, bottom: 100 } }),
  makeElementInfo({ elementId: 'el-3', text: 'Cherry', resourceId: 'item_3', bounds: { left: 0, top: 100, right: 100, bottom: 150 } }),
];

// ─── count() (PILOT-14) ───

describe('count()', () => {
  it('returns the number of matching elements', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    expect(await handle.count()).toBe(3);
  });

  it('returns 0 when no elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    expect(await handle.count()).toBe(0);
  });

  it('passes timeout to findElements', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _role('listitem'), 7000);
    await handle.count();
    expect(findElements).toHaveBeenCalledWith(handle._selector, 7000);
  });

  it('refuses a non-integer nth() index up front', () => {
    const handle = new ElementHandle(makeMockClient(), _role('listitem'), 5000);
    expect(() => handle.nth(1.5)).toThrow(/nth\(\) requires an integer index, got 1.5/);
    expect(() => handle.nth(NaN)).toThrow(/requires an integer index/);
    expect(() => handle.nth(1)).not.toThrow();
    expect(() => handle.nth(-1)).not.toThrow();
  });

  it('honours the positional index, like exists() and toHaveCount() (Playwright: first().count() is 1)', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    expect(await handle.first().count()).toBe(1);
    expect(await handle.nth(2).count()).toBe(1);
    expect(await handle.last().count()).toBe(1);
    expect(await handle.nth(3).count()).toBe(0);
  });

  it('on a handle from all() answers live by index — 1 while the row exists, 0 once the list has shrunk', async () => {
    let live = threeItems;
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(live)),
    });
    const rows = await new ElementHandle(client, _role('listitem'), 5000).all();
    expect(rows).toHaveLength(3);
    expect(await rows[2].count()).toBe(1);
    live = threeItems.slice(0, 2);
    expect(await rows[2].count()).toBe(0);
    expect(await rows[0].count()).toBe(1);
  });
});

// ─── all() (PILOT-13) ───

describe('all()', () => {
  it('returns an array of ElementHandles for each match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const items = await handle.all();
    expect(items).toHaveLength(3);
    items.forEach((item) => {
      expect(item).toBeInstanceOf(ElementHandle);
      expect(item._client).toBe(client);
      expect(item._timeoutMs).toBe(5000);
    });
  });

  it('returns empty array when no elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const items = await handle.all();
    expect(items).toEqual([]);
  });

  it('honours the positional index, like count() (Playwright: first().all() has one handle)', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const first = await handle.first().all();
    expect(first).toHaveLength(1);
    expect(await first[0].getText()).toBe('Apple');
    // The one handle is the live positional locator itself: all() on it
    // yields one handle for the same element (as WebViewLocator does).
    const again = await first[0].all();
    expect(again).toHaveLength(1);
    expect(await again[0].getText()).toBe('Apple');
    const last = await handle.last().all();
    expect(last).toHaveLength(1);
    expect(await last[0].getText()).toBe('Cherry');
    expect(await handle.nth(5).all()).toEqual([]);
  });

  it('a handle from last()/nth(k).all() is the live positional locator — it names whatever is last/kth NOW (PILOT-346)', async () => {
    let live = threeItems;
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(live)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const [last] = await handle.last().all();
    const [second] = await handle.nth(1).all();
    expect(await last.getText()).toBe('Cherry');
    expect(await second.getText()).toBe('Banana');
    live = threeItems.slice(0, 2); // Cherry gone
    expect(await last.getText()).toBe('Banana'); // last() is live
    expect(await second.getText()).toBe('Banana');
    expect(await last.count()).toBe(1);
    expect(await last.exists()).toBe(true);
    live = threeItems.slice(0, 1); // Banana gone too
    expect(await second.count()).toBe(0);
    expect(await withFakeClock(5000, () => second.exists())).toBe(false);
  });

  it('indexes the collapsed match set, so rows[i] and nth(i) agree on platforms that report an element twice (iOS)', async () => {
    // iOS renders a React Native <Text testID> as a parent StaticText plus an
    // inner child with identical text and bounds; the collapser keeps the first.
    const dup = (id: string, text: string, top: number) =>
      makeElementInfo({ elementId: id, text, bounds: { left: 0, top, right: 100, bottom: top + 20 } });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        dup('a', 'Apple', 0), dup('a-inner', 'Apple', 0), dup('b', 'Banana', 20), dup('b-inner', 'Banana', 20),
      ])),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const rows = await handle.all();
    expect(rows).toHaveLength(2);
    expect(await handle.count()).toBe(2);
    expect((await rows[1].find()).elementId).toBe('b');
    expect((await handle.nth(1).find()).elementId).toBe('b');
  });

  it('returned handles resolve to the correct element via nth index', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse(threeItems));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const items = await handle.all();

    // Each handle's find() should resolve to the correct element by index
    const second = await items[1].find();
    expect(second.text).toBe('Banana');
  });

  it('positional narrowing on a handle from all() composes instead of re-indexing the original set, like WebViewLocator (PILOT-346)', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const items = await handle.all();

    // rows[i] is one element: first()/last()/nth(0)/nth(-1) of it are itself …
    expect(await items[2].first().getText()).toBe('Cherry');
    expect(await items[2].last().getText()).toBe('Cherry');
    expect(await items[0].nth(0).getText()).toBe('Apple');
    expect(await items[0].nth(-1).getText()).toBe('Apple');
    // … and there is no second element in it.
    expect(await items[1].nth(1).count()).toBe(0);
    expect(await items[1].nth(-2).count()).toBe(0);
    expect(await items[1].nth(1).first().count()).toBe(0);
    expect(await items[1].nth(1).all()).toEqual([]);
  });
});

// ─── first(), last(), nth() (PILOT-15) ───

describe('first()', () => {
  it('returns a new ElementHandle (lazy — does not resolve)', () => {
    const client = makeMockClient();
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const first = handle.first();
    expect(first).toBeInstanceOf(ElementHandle);
    expect(first).not.toBe(handle);
    expect(first._selector).toBe(handle._selector);
    // findElements should not have been called yet
    expect(client.findElements).not.toHaveBeenCalled();
  });

  it('find() resolves to the first matching element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const result = await handle.first().find();
    expect(result.text).toBe('Apple');
  });

  it('exists() returns true when at least one element matches', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    expect(await handle.first().exists()).toBe(true);
  });

  it('exists() returns false when no elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    expect(await handle.first().exists()).toBe(false);
  });
});

describe('last()', () => {
  it('find() resolves to the last matching element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const result = await handle.last().find();
    expect(result.text).toBe('Cherry');
  });

  it('throws when no elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    // find() now waits on modified handles too (review follow-up). With no
    // match at all the error carries no positional detail: `nth(-1)` is an
    // index the user never wrote and "found 0" adds nothing to "not found".
    const handle = new ElementHandle(client, _role('listitem'), 300);
    const err = await withFakeClock(5000, () => handle.last().find()).catch((e) => e);
    expect(err.message).toMatch(/was not found after waiting 300ms$/);
  });
});

describe('nth()', () => {
  it('find() resolves to the element at the given index', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const result = await handle.nth(1).find();
    expect(result.text).toBe('Banana');
  });

  it('supports negative indices (counting from end)', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const result = await handle.nth(-2).find();
    expect(result.text).toBe('Banana');
  });

  it('throws when index is out of bounds', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 300);
    await expect(withFakeClock(5000, () => handle.nth(5).find()))
      .rejects.toThrow(/nth\(5\): expected at least 6 element\(s\), but found 3/);
  });

  it('throws when negative index is out of bounds', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 300);
    await expect(withFakeClock(5000, () => handle.nth(-4).find())).rejects.toThrow(/nth\(-4\)/);
  });

  it('keeps the last confirmed element count through stale ticks, and refreshes it on the next counted tick (review follow-up)', async () => {
    // Tick 1: three items (nth(5) misses "found 3"); tick 2 stale (carries no
    // count — must not discard the diagnostic); tick 3: two items. The
    // deadline error quotes the most recent COUNTED tick.
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
      calls++;
      if (calls === 1) return makeFindElementsResponse(threeItems);
      if (calls === 2) return { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' };
      return makeFindElementsResponse(threeItems.slice(0, 2));
    });
    const client = makeMockClient({ findElements });
    const err = await withFakeClock(5000, () => new ElementHandle(client, _role('listitem'), 600).nth(5).find()).catch((e) => e);
    expect(err.message).toMatch(/was not found after waiting 600ms \(nth\(5\): expected at least 6 element\(s\), but found 2\)/);

    // Stale for the rest of the wait: the tick-1 count is the best information there is.
    calls = 0;
    const staleAfterFirst = vi.fn(async (): Promise<FindElementsResponse> =>
      ++calls === 1
        ? makeFindElementsResponse(threeItems)
        : { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' });
    const err2 = await withFakeClock(5000, () =>
      new ElementHandle(makeMockClient({ findElements: staleAfterFirst }), _role('listitem'), 600).nth(5).find()).catch((e) => e);
    expect(err2.message).toMatch(/was not found after waiting 600ms \(nth\(5\): .*found 3\)/);
  });

  it('timeout: 0 keeps the positional diagnostic on the single-shot error (review follow-up)', async () => {
    const client = makeMockClient({ findElements: vi.fn(async () => makeFindElementsResponse(threeItems)) });
    await expect(new ElementHandle(client, _role('listitem'), 0).nth(5).find())
      .rejects.toThrow(/^Element not found: .*\(nth\(5\): expected at least 6 element\(s\), but found 3\)/);
  });

  it('nth(5).tap() on an EMPTY list keeps the positional detail — nothing else in the error names the index (review follow-up)', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
      tap: vi.fn(async () => successResponse()),
    });
    const err = await withFakeClock(5000, () => new ElementHandle(client, _role('listitem'), 600).nth(5).tap()).catch((e) => e);
    expect(err.message).toMatch(/was not found after waiting 600ms \(nth\(5\): expected at least 6 element\(s\), but found 0\)$/);
  });

  it('first().tap() with nothing matching carries no positional detail — the index was never the user\'s (review follow-up)', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
      tap: vi.fn(async () => successResponse()),
    });
    const err = await withFakeClock(5000, () => new ElementHandle(client, _role('button'), 600).first().tap()).catch((e) => e);
    expect(err.message).toMatch(/was not found after waiting 600ms$/);
  });

  it('tap() on an out-of-range nth handle names the index and the count in the deadline error, like find() (review follow-up)', async () => {
    // _waitForEnabled (tap/longPress/doubleTap/setChecked) used to lose the
    // positional diagnostic that _strictResolve (type/find) keeps, so
    // nth(5).tap() read as a plain "not found" while nth(5).type() explained.
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      tap: vi.fn(async () => successResponse()),
    });
    const handle = new ElementHandle(client, _role('listitem'), 600);
    await expect(withFakeClock(5000, () => handle.nth(5).tap()))
      .rejects.toThrow(/was not found after waiting 600ms \(nth\(5\): expected at least 6 element\(s\), but found 3\)/);
  });

  it('tap() keeps the last confirmed positional count through stale ticks, like find() (review follow-up)', async () => {
    let calls = 0;
    const findElements = vi.fn(async (): Promise<FindElementsResponse> =>
      ++calls === 1
        ? makeFindElementsResponse(threeItems)
        : { requestId: '1', elements: [], errorMessage: 'Element is stale (UI changed): null' });
    const client = makeMockClient({ findElements, tap: vi.fn(async () => successResponse()) });
    const err = await withFakeClock(5000, () => new ElementHandle(client, _role('listitem'), 600).nth(5).tap()).catch((e) => e);
    expect(err.message).toMatch(/was not found after waiting 600ms \(nth\(5\): .*found 3\)/);
  });

  it('bounds each poll tick of find()/tap() on a modified handle so the wait cannot overrun its deadline (review follow-up)', async () => {
    // _strictResolve/_waitForEnabled read modified handles through
    // _resolveOne(), which used the handle's OWN timeout per read (and an
    // and/or operand's own, often 30s, one): a tick issued late in the wait
    // could run a whole extra timeout (+ headroom per read of the chain on a
    // wedged agent). Each tick now carries the same 250ms budget as an
    // unmodified read; the daemon's headroom bounds the dump.
    const budgets: number[] = [];
    const findElements = vi.fn(async (_sel: unknown, budget?: number): Promise<FindElementsResponse> => {
      budgets.push(budget!);
      return makeFindElementsResponse([]);
    });
    const client = makeMockClient({ findElements, tap: vi.fn(async () => successResponse()) });
    const operand = new ElementHandle(client, _role('button'), 30_000);
    const handle = new ElementHandle(client, _text('X'), 2000);
    for (const run of [
      () => handle.first().find(),
      () => handle.nth(1).tap(),
      () => handle.and(operand).find(),
      () => handle.or(operand).tap(),
    ]) {
      budgets.length = 0;
      let elapsed = -1;
      await expect(withFakeClock(10_000, async () => {
        const start = Date.now();
        try {
          return await run();
        } finally {
          elapsed = Date.now() - start;
        }
      })).rejects.toThrow(/was not found after waiting 2000ms/);
      expect(budgets.length).toBeGreaterThan(1);
      for (const b of budgets) expect(b).toBeLessThanOrEqual(250);
      expect(elapsed).toBeLessThanOrEqual(2250);
    }
  });

  it('tap() on nth handle uses resolved element selector', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      tap,
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    await handle.nth(1).tap();
    // Banana is elementId 'el-2'; a positional handle dispatches by the exact
    // resolved element's cached id (selector arg undefined), so the agent acts
    // on that element rather than re-finding by selector.
    expect(tap).toHaveBeenCalledWith(undefined, expect.any(Number), 'el-2');
  });

  it('longPress() on nth handle targets the resolved element by id', async () => {
    const longPress = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      longPress,
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    await handle.nth(2).longPress(500);
    expect(longPress).toHaveBeenCalledWith(undefined, 500, expect.any(Number), 'el-3');
  });

  it('type() on nth handle targets the resolved element by id', async () => {
    const typeText = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      typeText,
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    await handle.nth(0).type('hello');
    expect(typeText).toHaveBeenCalledWith(undefined, 'hello', expect.any(Number), expect.any(Number), 'el-1');
  });
});

// ─── Positional actions on elements sharing an a11y property ───
//
// A positional handle resolves to a SPECIFIC element, then dispatches the
// action by that element's agent-cached id — so the action lands on it even
// when its only identifying property (resourceId → contentDescription → text)
// is shared by an EARLIER match (which a bare selector would hit first). This
// holds for gesture AND non-gesture actions alike.
describe('positional actions on shared-property matches', () => {
  // Two delete buttons, each contentDesc "bin", no testID — the reported case.
  const twoBins = [
    makeElementInfo({ elementId: 'bin-0', contentDescription: 'bin', text: '' }),
    makeElementInfo({ elementId: 'bin-1', contentDescription: 'bin', text: '' }),
  ];

  it('last().tap() targets the second bin by its cached id, not the first match', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(twoBins)),
      tap,
    });
    const handle = new ElementHandle(client, _contentDesc('bin'), 5000);
    await handle.last().tap();
    // Dispatched by elementId 'bin-1' with no selector — NOT contentDesc("bin")
    // (which the agent would act on by first match = the first bin).
    expect(tap).toHaveBeenCalledWith(undefined, expect.any(Number), 'bin-1');
  });

  it('first().tap() targets the first bin by its cached id', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(twoBins)),
      tap,
    });
    const handle = new ElementHandle(client, _contentDesc('bin'), 5000);
    await handle.first().tap();
    expect(tap).toHaveBeenCalledWith(undefined, expect.any(Number), 'bin-0');
  });

  it('last().longPress() targets the second bin by id', async () => {
    const longPress = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(twoBins)),
      longPress,
    });
    const handle = new ElementHandle(client, _contentDesc('bin'), 5000);
    await handle.last().longPress(400);
    expect(longPress).toHaveBeenCalledWith(undefined, 400, expect.any(Number), 'bin-1');
  });

  it('resolves the match set once (auto-wait reused, no redundant query) on a positional tap', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse(twoBins));
    const client = makeMockClient({ findElements, tap: vi.fn(async () => successResponse()) });
    const handle = new ElementHandle(client, _contentDesc('bin'), 5000);
    await handle.last().tap();
    // The auto-wait resolves the element (with its id); addressing by id needs
    // no further query (one findElements, not two).
    expect(findElements).toHaveBeenCalledTimes(1);
  });

  it('type() on a shared-property positional handle now targets the resolved element by id', async () => {
    const typeText = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(twoBins)),
      typeText,
    });
    const handle = new ElementHandle(client, _contentDesc('bin'), 5000);
    // Non-gesture actions work too now (no error): dispatched by id 'bin-1'.
    await handle.last().type('x');
    expect(typeText).toHaveBeenCalledWith(undefined, 'x', expect.any(Number), expect.any(Number), 'bin-1');
  });

  it('re-resolves to a fresh id and retries when the cached id goes stale', async () => {
    let tapCalls = 0;
    const tap = vi.fn(async () => {
      tapCalls += 1;
      // First dispatch: the cached id was invalidated (e.g. by an intervening
      // snapshot) between resolve and act. Second dispatch (fresh id): success.
      return tapCalls === 1
        ? failureResponse("Element 'bin-1' not found. It may have gone stale.")
        : successResponse();
    });
    const findElements = vi.fn(async () => makeFindElementsResponse(twoBins));
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _contentDesc('bin'), 5000);
    await handle.last().tap();
    expect(tap).toHaveBeenCalledTimes(2);
    // The retry re-runs .last() against a fresh resolve → still id 'bin-1'.
    expect(tap).toHaveBeenNthCalledWith(2, undefined, expect.any(Number), 'bin-1');
  });

  it('retries on the Android StaleObjectException wording too', async () => {
    let tapCalls = 0;
    const tap = vi.fn(async () => {
      tapCalls += 1;
      // Android wraps a live StaleObjectException as "Element is stale
      // (UI changed): …" — distinct from the "gone stale" cache-miss message.
      return tapCalls === 1
        ? failureResponse('Element is stale (UI changed): StaleObjectException')
        : successResponse();
    });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(twoBins)),
      tap,
    });
    const handle = new ElementHandle(client, _contentDesc('bin'), 5000);
    await handle.last().tap();
    expect(tap).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a normal action failure', async () => {
    const tap = vi.fn(async () => failureResponse('Tap target not found'));
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(twoBins)),
      tap,
    });
    const handle = new ElementHandle(client, _contentDesc('bin'), 5000);
    await expect(handle.last().tap()).rejects.toThrow('Tap target not found');
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('a stale retry on a handle from all() re-resolves live by index for a fresh id', async () => {
    let tapCalls = 0;
    const tap = vi.fn(async () =>
      (tapCalls += 1) === 1 ? failureResponse('Element is stale (UI changed)') : successResponse(),
    );
    // Every read mints fresh ids, as the agents do. Read 1 is all()'s, read 2
    // the tap's own enabled-wait (a live locator never reuses all()'s read),
    // read 3 the re-resolve after the stale dispatch.
    let findCalls = 0;
    const findElements = vi.fn(async () => {
      findCalls += 1;
      return makeFindElementsResponse([
        makeElementInfo({ elementId: `r${findCalls}-0`, contentDescription: 'bin' }),
        makeElementInfo({ elementId: `r${findCalls}-1`, contentDescription: 'bin' }),
      ]);
    });
    const client = makeMockClient({ findElements, tap });
    const items = await new ElementHandle(client, _contentDesc('bin'), 5000).all();
    await items[1].tap();
    expect(findCalls).toBe(3);
    expect(tap).toHaveBeenNthCalledWith(1, undefined, expect.any(Number), 'r2-1');
    expect(tap).toHaveBeenNthCalledWith(2, undefined, expect.any(Number), 'r3-1');
  });

  it('a device read that fails inside the enabled-wait of an all() handle surfaces the agent error, not "is disabled" (review follow-up)', async () => {
    let findCalls = 0;
    const findElements = vi.fn(async () => {
      findCalls += 1;
      if (findCalls > 1) throw new Error('findElements failed: UiAutomation not connected');
      return makeFindElementsResponse([makeElementInfo({ elementId: 'e0', enabled: false }), makeElementInfo({ elementId: 'e1', enabled: false })]);
    });
    const client = makeMockClient({ findElements, tap: vi.fn(async () => successResponse()) });
    const items = await new ElementHandle(client, _role('listitem'), 1000).all();
    await expect(withFakeClock(5000, () => items[1].tap())).rejects.toThrow(/UiAutomation not connected/);
  });

  it('after the list shrank, an action on an all() handle reports the row gone in the element\'s terms, and a reader WAITS with device reads and fails descriptively (review follow-up)', async () => {
    let tapCalls = 0;
    const tap = vi.fn(async () =>
      (tapCalls += 1) === 1 ? failureResponse('Element is stale (UI changed)') : successResponse(),
    );
    let findCalls = 0;
    const findElements = vi.fn(async () => {
      findCalls += 1;
      // Reads 1-2 (all(), the tap's enabled-wait) see 3 rows; the list then
      // shrinks to 1 before the stale retry's re-resolve.
      const n = findCalls <= 2 ? 3 : 1;
      return makeFindElementsResponse(Array.from({ length: n }, (_, i) => makeElementInfo({ elementId: `r${findCalls}-${i}`, text: `row ${i}` })));
    });
    const client = makeMockClient({ findElements, tap });
    const items = await new ElementHandle(client, _role('listitem'), 1000).all();
    // The stale retry re-resolves against a 1-row list; rows[2] can no longer
    // be satisfied. The tap reports that in the element's terms, not as a raw
    // internal nth() error.
    await expect(items[2].tap()).rejects.toThrow(/Element getByRole\("listitem"\) changed while being acted on and could not be found again: nth\(2\)/);
    const before = findCalls;
    const err = await withFakeClock(5000, () => items[2].find()).catch((e) => e);
    expect(err.message).toMatch(/was not found after waiting 1000ms \(nth\(2\): expected at least 3 element\(s\), but found 1\)$/);
    // Each tick read the device.
    expect(findCalls).toBeGreaterThan(before + 1);
  });

  it('a stale retry re-resolves live, and so does every later reader on the handle (PILOT-346)', async () => {
    let tapCalls = 0;
    const tap = vi.fn(async () =>
      (tapCalls += 1) === 1 ? failureResponse('Element is stale (UI changed)') : successResponse(),
    );
    let findCalls = 0;
    const findElements = vi.fn(async () => {
      findCalls += 1;
      // Reads 1-2: all() and the tap's enabled-wait (the first dispatch uses
      // read 2's id, which goes stale); read 3 onwards: fresh ids.
      const tag = findCalls <= 2 ? 'stale' : 'fresh';
      return makeFindElementsResponse([
        makeElementInfo({ elementId: `${tag}-0`, text: `${tag} zero` }),
        makeElementInfo({ elementId: `${tag}-1`, text: `${tag} one` }),
      ]);
    });
    const client = makeMockClient({ findElements, tap });
    const items = await new ElementHandle(client, _role('listitem'), 5000).all();
    await items[1].tap();
    expect(findCalls).toBe(3);
    expect(tap).toHaveBeenNthCalledWith(1, undefined, expect.any(Number), 'stale-1');
    expect(tap).toHaveBeenNthCalledWith(2, undefined, expect.any(Number), 'fresh-1');
    // A reader is one more live read — nothing is cached on the handle.
    expect((await items[1].find()).elementId).toBe('fresh-1');
    expect(findCalls).toBe(4);
    // A plain nth(1) locator: narrowing it further composes (see all()).
    expect((await items[1].first().find()).elementId).toBe('fresh-1');
  });
});

// ─── allTextContents() (PILOT-346) ───

describe('allTextContents()', () => {
  it('returns every match\'s text in order from ONE hierarchy read', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse(threeItems));
    const handle = new ElementHandle(makeMockClient({ findElements }), _role('listitem'), 5000);
    expect(await handle.allTextContents()).toEqual(['Apple', 'Banana', 'Cherry']);
    expect(findElements).toHaveBeenCalledTimes(1);
  });

  it('is [] for no match — no wait, no throw — and is exempt from strict mode', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const handle = new ElementHandle(makeMockClient({ findElements }), _role('listitem'), 5000);
    expect(await handle.allTextContents()).toEqual([]);
    expect(findElements).toHaveBeenCalledTimes(1);
  });

  it('honours every modifier, like count(): filters, the positional index and what is chained after it', async () => {
    const client = makeMockClient({ findElements: vi.fn(async () => makeFindElementsResponse(threeItems)) });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    expect(await handle.filter({ hasNotText: 'Banana' }).allTextContents()).toEqual(['Apple', 'Cherry']);
    expect(await handle.last().allTextContents()).toEqual(['Cherry']);
    expect(await handle.nth(1).filter({ hasText: 'Banana' }).allTextContents()).toEqual(['Banana']);
    expect(await handle.nth(1).filter({ hasText: 'Apple' }).allTextContents()).toEqual([]);
    expect(await handle.first().nth(1).allTextContents()).toEqual([]);
  });

  it('collapses accessibility-tree duplicates like count() and all() do', async () => {
    const dup = (id: string, text: string, top: number) =>
      makeElementInfo({ elementId: id, text, bounds: { left: 0, top, right: 100, bottom: top + 20 } });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([dup('a', 'Apple', 0), dup('a2', 'Apple', 0), dup('b', 'Banana', 20)])),
    });
    expect(await new ElementHandle(client, _role('listitem'), 5000).allTextContents()).toEqual(['Apple', 'Banana']);
  });

  it('surfaces a daemon-level failure instead of reporting an empty list', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'UiAutomation not connected' })),
    });
    await expect(new ElementHandle(client, _role('listitem'), 5000).allTextContents())
      .rejects.toThrow('findElements failed: UiAutomation not connected');
  });
});

// ─── Positional composition (PILOT-346) ───

describe('modifiers after a positional index compose in call order (Playwright)', () => {
  const list = () => new ElementHandle(makeMockClient({
    findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
  }), _role('listitem'), 5000);

  it('nth(i).filter(…) keeps row i if it matches — not the i-th matching row', async () => {
    expect(await list().nth(1).filter({ hasText: 'Banana' }).count()).toBe(1);
    expect((await list().nth(1).filter({ hasText: 'Banana' }).find()).text).toBe('Banana');
    expect(await list().nth(1).filter({ hasText: 'Apple' }).count()).toBe(0);
    expect(await list().nth(1).filter({ hasNotText: 'Apple' }).count()).toBe(1);
    // The other order is unchanged: filter first, then index the filtered set.
    expect((await list().filter({ hasText: /^[BC]/ }).nth(0).find()).text).toBe('Banana');
  });

  it('first().nth(1) matches nothing; first().first() is first(); last().nth(-1) is last()', async () => {
    expect(await list().first().nth(1).count()).toBe(0);
    expect((await list().first().first().find()).text).toBe('Apple');
    expect((await list().last().nth(-1).find()).text).toBe('Cherry');
    expect((await list().nth(1).last().find()).text).toBe('Banana');
    expect(await list().last().nth(-2).count()).toBe(0);
  });

  it('several steps compose left to right, and all() on the result yields it or nothing', async () => {
    const h = list().nth(1).filter({ hasText: 'Banana' }).first().filter({ hasNotText: 'Zzz' });
    expect(await h.count()).toBe(1);
    expect((await h.find()).text).toBe('Banana');
    const one = await h.all();
    expect(one).toHaveLength(1);
    expect(await one[0].getText()).toBe('Banana');
    expect(await list().nth(1).filter({ hasText: 'Zzz' }).all()).toEqual([]);
  });

  it('filter({ has }) after a positional index applies to that row', async () => {
    const button = makeElementInfo({ elementId: 'btn', role: 'button', bounds: { left: 10, top: 60, right: 50, bottom: 90 } }); // inside Banana
    const client = makeMockClient({
      findElements: vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(formatSelector(selector).includes('button') ? [button] : threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const has = new ElementHandle(client, _role('button'), 5000);
    expect(await handle.nth(1).filter({ has }).count()).toBe(1);
    expect(await handle.nth(0).filter({ has }).count()).toBe(0);
    expect(await handle.nth(0).filter({ hasNot: has }).count()).toBe(1);
  });

  it('a composed handle acts on its element by id, and a miss is reported in its terms', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements: vi.fn(async () => makeFindElementsResponse(threeItems)), tap });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    await handle.nth(1).filter({ hasText: 'Banana' }).tap();
    expect(tap).toHaveBeenCalledWith(undefined, expect.any(Number), 'el-2');
    // Single-shot miss names the composed chain, not the bare selector.
    await expect(new ElementHandle(client, _role('listitem'), 0).nth(1).filter({ hasText: 'Zzz' }).find())
      .rejects.toThrow('Element not found: getByRole("listitem").nth(1).filter(…×1)');
    await expect(new ElementHandle(client, _role('listitem'), 0).first().nth(1).find())
      .rejects.toThrow('Element not found: getByRole("listitem").first().nth(1)');
  });

  it('the composed positional step applies to an and()/or() operand and a scope parent too', async () => {
    const button = makeElementInfo({ elementId: 'btn', role: 'button', bounds: { left: 10, top: 60, right: 50, bottom: 90 } }); // inside Banana
    const client = makeMockClient({
      findElements: vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(formatSelector(selector).includes('button') ? [button] : threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const other = new ElementHandle(client, _role('listitem'), 5000);
    // nth(1).filter(Zzz) is empty → the intersection is empty; the union is the other operand alone.
    expect(await handle.nth(1).filter({ hasText: 'Zzz' }).and(other).count()).toBe(0);
    expect(await other.and(handle.nth(1).filter({ hasText: 'Zzz' })).count()).toBe(0);
    expect(await handle.nth(1).filter({ hasText: 'Zzz' }).or(other.first()).count()).toBe(1);
    // Scope parent: `nth(1).filter(Banana).getByRole('button')` finds the button inside Banana …
    expect(await handle.nth(1).filter({ hasText: 'Banana' }).getByRole('button').count()).toBe(1);
    // … and an empty composed parent has no children in scope.
    expect(await handle.nth(1).filter({ hasText: 'Zzz' }).getByRole('button').count()).toBe(0);
  });
});

// ─── filter() (PILOT-16) ───

describe('filter()', () => {
  it('returns a new lazy ElementHandle', () => {
    const client = makeMockClient();
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const filtered = handle.filter({ hasText: 'Apple' });
    expect(filtered).toBeInstanceOf(ElementHandle);
    expect(filtered).not.toBe(handle);
    expect(client.findElements).not.toHaveBeenCalled();
  });

  describe('hasText', () => {
    it('filters by substring match', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const count = await handle.filter({ hasText: 'an' }).count();
      expect(count).toBe(1); // Only "Banana" contains "an"
    });

    it('filters by RegExp', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const count = await handle.filter({ hasText: /^[AB]/ }).count();
      expect(count).toBe(2); // Apple and Banana
    });

    it('find() returns the first matching element', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const result = await handle.filter({ hasText: 'Cherry' }).find();
      expect(result.text).toBe('Cherry');
    });
  });

  describe('hasNotText', () => {
    it('excludes elements matching the text', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const count = await handle.filter({ hasNotText: 'Apple' }).count();
      expect(count).toBe(2); // Banana and Cherry
    });

    it('excludes elements matching a RegExp', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const items = await handle.filter({ hasNotText: /rry$/ }).all();
      expect(items).toHaveLength(2); // Apple and Banana
    });
  });

  describe('has (child selector)', () => {
    it('keeps elements that contain a descendant matching the selector', async () => {
      const parentElements: ElementInfo[] = [
        makeElementInfo({ elementId: 'p1', text: 'Card 1', bounds: { left: 0, top: 0, right: 200, bottom: 100 } }),
        makeElementInfo({ elementId: 'p2', text: 'Card 2', bounds: { left: 0, top: 100, right: 200, bottom: 200 } }),
      ];
      const childElements: ElementInfo[] = [
        makeElementInfo({ elementId: 'c1', text: 'Premium', bounds: { left: 10, top: 10, right: 90, bottom: 40 } }),
      ];

      const findElements = vi.fn(async (selector: Selector) => {
        const proto = selectorToProto(selector);
        // Child selector is _text('Premium').within(_role('listitem')), so it has a parent
        if (proto.parent) return makeFindElementsResponse(childElements);
        return makeFindElementsResponse(parentElements);
      });
      const client = makeMockClient({ findElements });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const premium = new ElementHandle(client, _text('Premium'), 5000);
      const count = await handle.filter({ has: premium }).count();
      // Only Card 1 contains the "Premium" child (bounds overlap)
      expect(count).toBe(1);
    });
  });

  describe('hasNot (child selector)', () => {
    it('excludes elements that contain a descendant matching the selector', async () => {
      const parentElements: ElementInfo[] = [
        makeElementInfo({ elementId: 'p1', text: 'Card 1', bounds: { left: 0, top: 0, right: 200, bottom: 100 } }),
        makeElementInfo({ elementId: 'p2', text: 'Card 2', bounds: { left: 0, top: 100, right: 200, bottom: 200 } }),
      ];
      const childElements: ElementInfo[] = [
        makeElementInfo({ elementId: 'c1', text: 'Disabled', bounds: { left: 10, top: 110, right: 90, bottom: 140 } }),
      ];

      const findElements = vi.fn(async (selector: Selector) => {
        const proto = selectorToProto(selector);
        // Child selector is _text('Disabled').within(_role('listitem')), so it has a parent
        if (proto.parent) return makeFindElementsResponse(childElements);
        return makeFindElementsResponse(parentElements);
      });
      const client = makeMockClient({ findElements });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const disabled = new ElementHandle(client, _text('Disabled'), 5000);
      const count = await handle.filter({ hasNot: disabled }).count();
      // Card 2 contains the "Disabled" child, so only Card 1 remains
      expect(count).toBe(1);
    });
  });

  describe('combined filters', () => {
    it('applies hasText and hasNotText together', async () => {
      const items: ElementInfo[] = [
        makeElementInfo({ elementId: 'e1', text: 'Apple Pie' }),
        makeElementInfo({ elementId: 'e2', text: 'Apple Sauce' }),
        makeElementInfo({ elementId: 'e3', text: 'Banana Split' }),
      ];
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(items)),
      });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const result = await handle
        .filter({ hasText: 'Apple' })
        .filter({ hasNotText: 'Pie' })
        .count();
      expect(result).toBe(1); // Only "Apple Sauce"
    });
  });

  it('filter() composes with nth()', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    // Filter to items not containing "Apple", then pick the last
    const result = await handle.filter({ hasNotText: 'Apple' }).last().find();
    expect(result.text).toBe('Cherry');
  });
});

// ─── and() (PILOT-17) ───

describe('and()', () => {
  it('returns elements matching both selectors (intersection)', async () => {
    const buttonsEls: ElementInfo[] = [
      makeElementInfo({ elementId: 'e1', text: 'Submit', resourceId: 'btn1' }),
      makeElementInfo({ elementId: 'e2', text: 'Cancel', resourceId: 'btn2' }),
    ];
    const submitEls: ElementInfo[] = [
      makeElementInfo({ elementId: 'e1', text: 'Submit', resourceId: 'btn1' }),
    ];

    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'Submit') return makeFindElementsResponse(submitEls);
      return makeFindElementsResponse(buttonsEls);
    });
    const client = makeMockClient({ findElements });

    const buttons = new ElementHandle(client, _role('button'), 5000);
    const submit = new ElementHandle(client, _text('Submit'), 5000);
    const result = await buttons.and(submit).count();
    expect(result).toBe(1);
  });

  it('returns empty when no elements match both', async () => {
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text) {
        return makeFindElementsResponse([
          makeElementInfo({ elementId: 'e3', text: 'Other' }),
        ]);
      }
      return makeFindElementsResponse([
        makeElementInfo({ elementId: 'e1', text: 'Submit' }),
      ]);
    });
    const client = makeMockClient({ findElements });

    const buttons = new ElementHandle(client, _role('button'), 5000);
    const other = new ElementHandle(client, _text('Other'), 5000);
    expect(await buttons.and(other).count()).toBe(0);
  });

  it('and() with tap() resolves and taps the matching element', async () => {
    const tap = vi.fn(async () => successResponse());
    const intersectEl = makeElementInfo({ elementId: 'e1', text: 'Submit', resourceId: 'btn-submit' });
    const findElements = vi.fn(async () => makeFindElementsResponse([intersectEl]));
    const client = makeMockClient({ findElements, tap });

    const buttons = new ElementHandle(client, _role('button'), 5000);
    const submit = new ElementHandle(client, _text('Submit'), 5000);
    await buttons.and(submit).tap();

    // and() is a modified handle → dispatches by the resolved element's id.
    expect(tap).toHaveBeenCalledWith(undefined, expect.any(Number), 'e1');
  });

  // PILOT-349: both agents mint a fresh elementId on every findElements, so
  // the two operand reads never share an id. The mock below behaves like a
  // real agent — same elements, new ids each read — which is what the
  // id-reusing mocks above never exercised.
  describe('on a device that mints a fresh elementId per read (PILOT-349)', () => {
    const ROW = { left: 0, top: 100, right: 400, bottom: 160 };
    const OTHER_ROW = { left: 0, top: 160, right: 400, bottom: 220 };
    let nextId = 0;
    const churn = (els: ElementInfo[]) => els.map((e) => ({ ...e, elementId: `id-${++nextId}` }));

    it('intersects operands by stable identity (bounds + text), not by id', async () => {
      const buttons = [
        makeElementInfo({ text: 'Item 5', role: 'button', bounds: ROW }),
        makeElementInfo({ text: 'Item 6', role: 'button', bounds: OTHER_ROW }),
      ];
      const item5 = [makeElementInfo({ text: 'Item 5', role: 'button', bounds: ROW })];
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(churn(selectorToProto(selector).text === 'Item 5' ? item5 : buttons)));
      const client = makeMockClient({ findElements });

      const handle = new ElementHandle(client, _role('button'), 5000).and(new ElementHandle(client, _text('Item 5'), 5000));
      const els = await handle._resolveAll();
      expect(els.map((e) => e.text)).toEqual(['Item 5']);
      // The left operand's entry (and therefore its id) is the one kept, so
      // the action that follows addresses the element the left read saw.
      expect(els[0].elementId).toMatch(/^id-/);
      expect(els[0].role).toBe('button');
    });

    it('does not conflate same-text elements at different bounds', async () => {
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(churn(
          selectorToProto(selector).text === 'Save'
            ? [makeElementInfo({ text: 'Save', bounds: OTHER_ROW })]
            : [makeElementInfo({ text: 'Save', role: 'button', bounds: ROW })])));
      const client = makeMockClient({ findElements });
      const handle = new ElementHandle(client, _role('button'), 5000).and(new ElementHandle(client, _text('Save'), 5000));
      expect(await handle._resolveAll()).toEqual([]);
    });

    it('never matches zero-size (clipped) elements across reads — Android reports every clipped element at 0,0,0,0', async () => {
      // Two rows' icon-only buttons scrolled out of view: same empty text,
      // same degenerate rect. Keyed by position they would be one element
      // and the intersection would name both; keyed by id they match nothing.
      const ZERO = { left: 0, top: 0, right: 0, bottom: 0 };
      const findElements = vi.fn(async () =>
        makeFindElementsResponse(churn([
          makeElementInfo({ text: '', role: 'button', contentDescription: 'Delete', bounds: ZERO, visible: false }),
          makeElementInfo({ text: '', role: 'button', contentDescription: 'Share', bounds: ZERO, visible: false }),
        ])));
      const client = makeMockClient({ findElements });
      const handle = new ElementHandle(client, _role('button'), 5000).and(new ElementHandle(client, _contentDesc('Delete'), 5000));
      expect(await handle._resolveAll()).toEqual([]);
    });

    it('honours a positional index on either operand (PILOT-347)', async () => {
      const rows = [
        makeElementInfo({ text: 'Item 1', role: 'button', bounds: ROW }),
        makeElementInfo({ text: 'Item 2', role: 'button', bounds: OTHER_ROW }),
        makeElementInfo({ text: 'Item 3', role: 'button', bounds: { left: 0, top: 220, right: 400, bottom: 280 } }),
      ];
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(churn(formatSelector(selector).includes('getByRole') ? rows : rows.slice(1))));
      const client = makeMockClient({ findElements });
      const buttons = new ElementHandle(client, _role('button'), 5000);
      const items = new ElementHandle(client, _text('Item'), 5000); // matches Items 2 and 3
      // Left index: the FIRST button is Item 1, which the right does not have.
      expect(await buttons.first().and(items)._resolveAll()).toEqual([]);
      // Left index naming a shared row intersects to exactly that row.
      expect((await buttons.nth(1).and(items)._resolveAll()).map((e) => e.text)).toEqual(['Item 2']);
      // Right index: only the LAST item (Item 3) is on the right side.
      expect((await buttons.and(items.last())._resolveAll()).map((e) => e.text)).toEqual(['Item 3']);
      // Without an index the whole sets intersect.
      expect((await buttons.and(items)._resolveAll()).map((e) => e.text)).toEqual(['Item 2', 'Item 3']);
    });

    it('applies an operand index and the combined handle\'s own index each exactly once', async () => {
      const rows = [
        makeElementInfo({ text: 'Item 1', role: 'button', bounds: ROW }),
        makeElementInfo({ text: 'Item 2', role: 'button', bounds: OTHER_ROW }),
        makeElementInfo({ text: 'Item 3', role: 'button', bounds: { left: 0, top: 220, right: 400, bottom: 280 } }),
      ];
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(churn(formatSelector(selector).includes('getByRole') ? rows : rows.slice(1))));
      const client = makeMockClient({ findElements });
      const buttons = new ElementHandle(client, _role('button'), 5000);
      const items = new ElementHandle(client, _text('Item'), 5000);
      // Outer index over the intersection [Item 2, Item 3].
      expect((await buttons.and(items).first().find()).text).toBe('Item 2');
      expect((await buttons.and(items).last().find()).text).toBe('Item 3');
      expect((await buttons.and(items).nth(1).find()).text).toBe('Item 3');
      // Inner index narrows the operand first; the outer index then applies
      // to the one-element result, not to the raw operand again.
      expect((await buttons.nth(1).and(items).first().find()).text).toBe('Item 2');
      expect(await buttons.nth(1).and(items).nth(1).count()).toBe(0);
    });

    it('an out-of-range or negative operand index narrows that operand to nothing / the counted-from-end match', async () => {
      const rows = [
        makeElementInfo({ text: 'Item 1', role: 'button', bounds: ROW }),
        makeElementInfo({ text: 'Item 2', role: 'button', bounds: OTHER_ROW }),
        makeElementInfo({ text: 'Item 3', role: 'button', bounds: { left: 0, top: 220, right: 400, bottom: 280 } }),
      ];
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(churn(formatSelector(selector).includes('getByRole') ? rows : rows.slice(1))));
      const client = makeMockClient({ findElements });
      const buttons = new ElementHandle(client, _role('button'), 5000);
      const items = new ElementHandle(client, _text('Item'), 5000);
      // Out of range on either side: that operand is empty, so the
      // intersection is empty — a count/exists answer, never a throw.
      expect(await buttons.nth(7).and(items).count()).toBe(0);
      expect(await buttons.and(items.nth(7)).count()).toBe(0);
      expect(await buttons.nth(-9).and(items).exists()).toBe(false);
      // A negative index counts from the end of the OPERAND's matches.
      expect((await buttons.nth(-2).and(items)._resolveAll()).map((e) => e.text)).toEqual(['Item 2']);
    });

    it('a nested combinator keeps its own positional index when it becomes an operand', async () => {
      const rows = [
        makeElementInfo({ text: 'Item 1', role: 'button', bounds: ROW }),
        makeElementInfo({ text: 'Item 2', role: 'button', bounds: OTHER_ROW }),
        makeElementInfo({ text: 'Item 3', role: 'button', bounds: { left: 0, top: 220, right: 400, bottom: 280 } }),
      ];
      const findElements = vi.fn(async (selector: Selector) => {
        const f = formatSelector(selector);
        if (f.includes('getByRole')) return makeFindElementsResponse(churn(rows));
        if (f.includes('"Item 3"')) return makeFindElementsResponse(churn([rows[2]]));
        return makeFindElementsResponse(churn(rows.slice(1)));
      });
      const client = makeMockClient({ findElements });
      const buttons = new ElementHandle(client, _role('button'), 5000);
      const items = new ElementHandle(client, _text('Item'), 5000);
      const item3 = new ElementHandle(client, _text('Item 3'), 5000);
      // (buttons ∪ items).first() is Item 1, which items does not match.
      expect(await buttons.or(items).first().and(items).count()).toBe(0);
      // (buttons.first() ∪ item3) = [Item 1, Item 3]; ∩ items keeps Item 3.
      expect((await buttons.first().or(item3).and(items)._resolveAll()).map((e) => e.text)).toEqual(['Item 3']);
      // (buttons ∩ items).last() is Item 3; ∪ item3 de-duplicates to one.
      expect(await buttons.and(items).last().or(item3).count()).toBe(1);
    });

    it('a getBy* scoped under a combinator resolves the operand index before scoping by containment', async () => {
      const rows = [
        makeElementInfo({ text: 'Item 1', role: 'button', bounds: ROW }),
        makeElementInfo({ text: 'Item 2', role: 'button', bounds: OTHER_ROW }),
      ];
      const labels = [
        makeElementInfo({ text: 'Label', bounds: { left: 10, top: 110, right: 100, bottom: 150 } }),
        makeElementInfo({ text: 'Label', bounds: { left: 10, top: 170, right: 100, bottom: 210 } }),
      ];
      const findElements = vi.fn(async (selector: Selector) => {
        const f = formatSelector(selector);
        if (f.includes('"Label"')) return makeFindElementsResponse(churn(labels));
        if (f.includes('getByRole')) return makeFindElementsResponse(churn(rows));
        return makeFindElementsResponse(churn(rows.slice(1))); // items: Item 2 only
      });
      const client = makeMockClient({ findElements });
      const buttons = new ElementHandle(client, _role('button'), 5000);
      const items = new ElementHandle(client, _text('Item'), 5000);
      // buttons.nth(1) ∩ items is Item 2: only the label inside THAT row is in scope.
      const inScope = await buttons.nth(1).and(items).getByText('Label')._resolveAll();
      expect(inScope.map((e) => e.bounds!.top)).toEqual([170]);
      // An empty intersection scopes to nothing rather than to every row.
      expect(await buttons.first().and(items).getByText('Label').count()).toBe(0);
    });

    it('refuses an xpath operand on either side (its text and bounds come from a different agent read)', () => {
      const client = makeMockClient();
      const byXpath = new ElementHandle(client, _xpath('//android.widget.Button'), 5000);
      const buttons = new ElementHandle(client, _role('button'), 5000);
      expect(() => byXpath.and(buttons)).toThrow(/and\(\) cannot combine an xpath locator/);
      expect(() => buttons.and(byXpath)).toThrow(/and\(\) cannot combine an xpath locator/);
      expect(() => byXpath.or(buttons)).toThrow(/or\(\) cannot combine an xpath locator/);
      expect(() => buttons.or(byXpath)).toThrow(/or\(\) cannot combine an xpath locator/);
      // The xpath may be hiding up the chain: a getBy* scoped off it (nested
      // selector parent), a modified xpath parent (scopeParent), or an inner
      // and()/or() built on one.
      expect(() => byXpath.getByText('Y').and(buttons)).toThrow(/and\(\) cannot combine an xpath locator/);
      expect(() => byXpath.first().getByText('Y').or(buttons)).toThrow(/or\(\) cannot combine an xpath locator/);
      const labels = new ElementHandle(client, _text('Y'), 5000);
      // (the inner or() is built first, so it is the one that refuses)
      expect(() => buttons.and(labels.or(byXpath.getByText('Z')))).toThrow(/or\(\) cannot combine an xpath locator/);
    });

    it('never lets two id-less, bounds-less elements share a key (a proto default no agent emits)', async () => {
      const nameless = () => makeElementInfo({ elementId: '', text: 'A' });
      const findElements = vi.fn(async () => makeFindElementsResponse([nameless(), nameless()]));
      const client = makeMockClient({ findElements });
      const a = new ElementHandle(client, _role('button'), 5000);
      const b = new ElementHandle(client, _text('A'), 5000);
      expect(await a.and(b)._resolveAll()).toEqual([]);
      expect(await a.or(b)._resolveAll()).toHaveLength(4);
    });

    it('an element without bounds only matches itself (by id)', async () => {
      // No bounds → no stable identity. Mocks that reuse ids still intersect
      // (the behaviour every other test here relies on); churned ids do not.
      const stable = [makeElementInfo({ elementId: 'fixed', text: 'A' })];
      let client = makeMockClient({ findElements: vi.fn(async () => makeFindElementsResponse(stable)) });
      let handle = new ElementHandle(client, _role('button'), 5000).and(new ElementHandle(client, _text('A'), 5000));
      expect(await handle._resolveAll()).toHaveLength(1);

      client = makeMockClient({ findElements: vi.fn(async () => makeFindElementsResponse(churn(stable))) });
      handle = new ElementHandle(client, _role('button'), 5000).and(new ElementHandle(client, _text('A'), 5000));
      expect(await handle._resolveAll()).toEqual([]);
    });

    it('a clipped or() duplicate fails fast with a strict violation (documented limitation, PILOT-360 tracks the design)', async () => {
      // Both operands read one off-screen element; ids differ per read and a
      // zero-size rect has no cross-read identity, so the union holds two
      // entries and strict mode refuses the ambiguity immediately.
      const ZERO = { left: 0, top: 0, right: 0, bottom: 0 };
      const findElements = vi.fn(async () =>
        makeFindElementsResponse(churn([makeElementInfo({ text: 'Item 25', visible: false, bounds: ZERO })])));
      const client = makeMockClient({ findElements });
      const union = new ElementHandle(client, _text('Item 25'), 5000).or(new ElementHandle(client, _contentDesc('Item 25'), 5000));
      await expect(union.find()).rejects.toThrow(/resolved to 2 elements/);
      await expect(union.tap()).rejects.toThrow(/resolved to 2 elements/);
    });

    it('carries the config-derived typing delay onto the combined handle', async () => {
      const typeText = vi.fn(async () => successResponse());
      const findElements = vi.fn(async () =>
        makeFindElementsResponse(churn([makeElementInfo({ text: 'Item 5', role: 'button', bounds: ROW })])));
      const client = makeMockClient({ findElements, typeText });
      const field = new ElementHandle(client, _role('button'), 5000, { typingDelay: 50 });
      const visible = new ElementHandle(client, _text('Item 5'), 5000);
      await field.and(visible).type('hello');
      // typeText(selector, text, timeoutMs, typingDelayMs, elementId)
      expect(typeText).toHaveBeenCalledWith(undefined, 'hello', expect.any(Number), 50, expect.any(String));
      typeText.mockClear();
      await field.or(visible).type('hi');
      expect(typeText).toHaveBeenCalledWith(undefined, 'hi', expect.any(Number), 50, expect.any(String));
    });

    it('carries the config-derived double-tap interval onto the combined handle', async () => {
      const doubleTap = vi.fn(async () => successResponse());
      const findElements = vi.fn(async () =>
        makeFindElementsResponse(churn([makeElementInfo({ text: 'Item 5', role: 'button', bounds: ROW })])));
      const client = makeMockClient({ findElements, doubleTap });
      const a = new ElementHandle(client, _role('button'), 5000, { doubleTapInterval: 75 });
      const b = new ElementHandle(client, _text('Item 5'), 5000);
      await a.and(b).doubleTap();
      // doubleTap(selector, timeoutMs, intervalMs, elementId)
      expect(doubleTap).toHaveBeenCalledWith(undefined, expect.any(Number), 75, expect.any(String));
      doubleTap.mockClear();
      await a.or(b).doubleTap();
      expect(doubleTap).toHaveBeenCalledWith(undefined, expect.any(Number), 75, expect.any(String));
    });

    it('count(), find() and tap() all see the intersection', async () => {
      const tap = vi.fn(async () => successResponse());
      const findElements = vi.fn(async () =>
        makeFindElementsResponse(churn([makeElementInfo({ text: 'Item 5', role: 'button', bounds: ROW })])));
      const client = makeMockClient({ findElements, tap });
      const handle = new ElementHandle(client, _role('button'), 5000).and(new ElementHandle(client, _text('Item 5'), 5000));
      expect(await handle.count()).toBe(1);
      expect((await handle.find()).text).toBe('Item 5');
      await handle.tap();
      expect(tap).toHaveBeenCalledWith(undefined, expect.any(Number), expect.stringMatching(/^id-/));
    });
  });
});

// ─── or() (PILOT-17) ───

describe('or()', () => {
  it('returns elements matching either selector (union, deduped)', async () => {
    const okEls: ElementInfo[] = [
      makeElementInfo({ elementId: 'e1', text: 'OK' }),
    ];
    const confirmEls: ElementInfo[] = [
      makeElementInfo({ elementId: 'e2', text: 'Confirm' }),
    ];

    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'OK') return makeFindElementsResponse(okEls);
      return makeFindElementsResponse(confirmEls);
    });
    const client = makeMockClient({ findElements });

    const ok = new ElementHandle(client, _text('OK'), 5000);
    const confirm = new ElementHandle(client, _text('Confirm'), 5000);
    expect(await ok.or(confirm).count()).toBe(2);
  });

  it('deduplicates elements present in both selectors', async () => {
    const sharedEl = makeElementInfo({ elementId: 'e1', text: 'Submit' });
    const findElements = vi.fn(async () => makeFindElementsResponse([sharedEl]));
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _role('button'), 5000);
    const b = new ElementHandle(client, _text('Submit'), 5000);
    expect(await a.or(b).count()).toBe(1);
  });

  it('or() with tap() uses the first available element', async () => {
    const tap = vi.fn(async () => successResponse());
    const okEl = makeElementInfo({ elementId: 'e1', text: 'OK', resourceId: '' });
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'OK') return makeFindElementsResponse([okEl]);
      return makeFindElementsResponse([]); // "Confirm" not present
    });
    const client = makeMockClient({ findElements, tap });

    const ok = new ElementHandle(client, _text('OK'), 5000);
    const confirm = new ElementHandle(client, _text('Confirm'), 5000);
    await ok.or(confirm).tap();

    // or() is a modified handle → dispatches by the resolved element's id.
    expect(tap).toHaveBeenCalledWith(undefined, expect.any(Number), 'e1');
  });

  it('or() throws when neither selector matches', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });

    // find() waits on modified handles too (review follow-up on PILOT-287):
    // short timeout, and the deadline error names the or() handle.
    const a = new ElementHandle(client, _text('OK'), 300);
    const b = new ElementHandle(client, _text('Confirm'), 300);
    await expect(withFakeClock(5000, () => a.or(b).find())).rejects.toThrow(/was not found after waiting 300ms/);
  });

  // PILOT-349: see the matching and() block — real agents mint a fresh id per
  // read, so an element both operands match used to appear twice.
  describe('on a device that mints a fresh elementId per read (PILOT-349)', () => {
    const ROW = { left: 0, top: 100, right: 400, bottom: 160 };
    const OTHER_ROW = { left: 0, top: 160, right: 400, bottom: 220 };
    let nextId = 0;
    const churn = (els: ElementInfo[]) => els.map((e) => ({ ...e, elementId: `id-${++nextId}` }));

    it('de-duplicates an element both operands match, keeping the left read first', async () => {
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(churn(
          selectorToProto(selector).text === 'Item 5'
            ? [makeElementInfo({ text: 'Item 5', bounds: ROW })]
            : [makeElementInfo({ text: 'Item 5', role: 'button', bounds: ROW }), makeElementInfo({ text: 'Item 6', role: 'button', bounds: OTHER_ROW })])));
      const client = makeMockClient({ findElements });

      // Same element via two selectors → one match, not a strict-mode violation.
      const same = new ElementHandle(client, _text('Item 5'), 5000).or(new ElementHandle(client, _text('Item 5'), 5000));
      expect(await same.count()).toBe(1);
      expect((await same.find()).text).toBe('Item 5');

      // Overlapping unions keep the left operand's entry, then the right's extras.
      const union = new ElementHandle(client, _role('button'), 5000).or(new ElementHandle(client, _text('Item 5'), 5000));
      const els = await union._resolveAll();
      expect(els.map((e) => e.text)).toEqual(['Item 5', 'Item 6']);
      expect(els[0].role).toBe('button');
    });

    it('keeps distinct same-text elements at different bounds apart', async () => {
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(churn(
          selectorToProto(selector).text === 'Save'
            ? [makeElementInfo({ text: 'Save', bounds: OTHER_ROW })]
            : [makeElementInfo({ text: 'Save', role: 'button', bounds: ROW })])));
      const client = makeMockClient({ findElements });
      const handle = new ElementHandle(client, _role('button'), 5000).or(new ElementHandle(client, _text('Save'), 5000));
      expect(await handle.count()).toBe(2);
    });

    it('never merges zero-size (clipped) elements — a union is never smaller than one operand alone', async () => {
      // Two clipped icon buttons and a clipped link: zero-size bounds,
      // identical (empty) text. None of them has a cross-read identity, so
      // all three survive; only the shared 'Help' row (real bounds, matched by
      // both operands) is merged.
      const ZERO = { left: 0, top: 0, right: 0, bottom: 0 };
      const help = makeElementInfo({ text: 'Help', role: 'button', bounds: ROW });
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(churn(
          formatSelector(selector).includes('link')
            ? [makeElementInfo({ text: '', role: 'link', bounds: ZERO }), help]
            : [makeElementInfo({ text: '', role: 'button', bounds: ZERO }), makeElementInfo({ text: '', role: 'button', bounds: ZERO }), help])));
      const client = makeMockClient({ findElements });
      const buttons = new ElementHandle(client, _role('button'), 5000);
      const links = new ElementHandle(client, _role('link'), 5000);
      expect(await buttons.count()).toBe(3);
      const els = await buttons.or(links)._resolveAll();
      // Screen order: the positioned 'Help' row first, then the geometry-less
      // clipped entries in operand order (left's two buttons, right's link).
      expect(els.map((e) => [e.role, e.text])).toEqual([['button', 'Help'], ['button', ''], ['button', ''], ['link', '']]);
    });

    it('honours a positional index on either operand (PILOT-347)', async () => {
      const rows = [
        makeElementInfo({ text: 'Item 1', role: 'button', bounds: ROW }),
        makeElementInfo({ text: 'Item 2', role: 'button', bounds: OTHER_ROW }),
      ];
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(churn(formatSelector(selector).includes('getByRole') ? rows : [makeElementInfo({ text: 'Help', bounds: { left: 0, top: 300, right: 400, bottom: 340 } })])));
      const client = makeMockClient({ findElements });
      const buttons = new ElementHandle(client, _role('button'), 5000);
      const help = new ElementHandle(client, _text('Help'), 5000);
      expect((await buttons.first().or(help)._resolveAll()).map((e) => e.text)).toEqual(['Item 1', 'Help']);
      // Screen order, not operand order: Item 2 (top 160) is above Help (300).
      expect((await help.or(buttons.last())._resolveAll()).map((e) => e.text)).toEqual(['Item 2', 'Help']);
      // The union's own index composes with an operand index, each applied
      // exactly once, over the union's SCREEN order — first() on a union is
      // the topmost match regardless of which operand contributed it.
      expect((await buttons.first().or(help).last().find()).text).toBe('Help');
      expect((await help.or(buttons.first()).first().find()).text).toBe('Item 1');
    });

    it('an out-of-range operand index leaves the union to the other operand', async () => {
      const rows = [
        makeElementInfo({ text: 'Item 1', role: 'button', bounds: ROW }),
        makeElementInfo({ text: 'Item 2', role: 'button', bounds: OTHER_ROW }),
      ];
      const findElements = vi.fn(async (selector: Selector) =>
        makeFindElementsResponse(churn(formatSelector(selector).includes('getByRole') ? rows : [makeElementInfo({ text: 'Help', bounds: { left: 0, top: 300, right: 400, bottom: 340 } })])));
      const client = makeMockClient({ findElements });
      const buttons = new ElementHandle(client, _role('button'), 5000);
      const help = new ElementHandle(client, _text('Help'), 5000);
      expect((await buttons.nth(7).or(help)._resolveAll()).map((e) => e.text)).toEqual(['Help']);
      expect((await help.or(buttons.nth(-9))._resolveAll()).map((e) => e.text)).toEqual(['Help']);
      // Both operands empty: an empty union, reported — not thrown — by count().
      expect(await buttons.nth(7).or(help.nth(3)).count()).toBe(0);
    });
  });
});

// ─── Chaining multiple and()/or() ───

describe('chaining and()', () => {
  it('a.and(b).and(c) matches elements in all three', async () => {
    const shared = makeElementInfo({ elementId: 'e1', text: 'Submit' });
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'B') {
        return makeFindElementsResponse([
          shared,
          makeElementInfo({ elementId: 'e2', text: 'Other' }),
        ]);
      }
      if (proto.text === 'C') {
        return makeFindElementsResponse([shared]);
      }
      // A
      return makeFindElementsResponse([
        shared,
        makeElementInfo({ elementId: 'e3', text: 'Extra' }),
      ]);
    });
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _text('A'), 5000);
    const b = new ElementHandle(client, _text('B'), 5000);
    const c = new ElementHandle(client, _text('C'), 5000);
    const count = await a.and(b).and(c).count();
    expect(count).toBe(1);
    const result = await a.and(b).and(c).first().find();
    expect(result.text).toBe('Submit');
  });
});

describe('chaining or()', () => {
  it('a.or(b).or(c) matches elements in any of the three', async () => {
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'A') return makeFindElementsResponse([makeElementInfo({ elementId: 'e1', text: 'A' })]);
      if (proto.text === 'B') return makeFindElementsResponse([makeElementInfo({ elementId: 'e2', text: 'B' })]);
      if (proto.text === 'C') return makeFindElementsResponse([makeElementInfo({ elementId: 'e3', text: 'C' })]);
      return makeFindElementsResponse([]);
    });
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _text('A'), 5000);
    const b = new ElementHandle(client, _text('B'), 5000);
    const c = new ElementHandle(client, _text('C'), 5000);
    const count = await a.or(b).or(c).count();
    expect(count).toBe(3);
  });
});

// ─── Composition / integration ───

describe('method composition', () => {
  it('filter().first() works correctly', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const result = await handle.filter({ hasNotText: 'Apple' }).first().find();
    expect(result.text).toBe('Banana');
  });

  it('or().nth() works correctly', async () => {
    const aEls = [makeElementInfo({ elementId: 'e1', text: 'A' })];
    const bEls = [makeElementInfo({ elementId: 'e2', text: 'B' })];
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'A') return makeFindElementsResponse(aEls);
      return makeFindElementsResponse(bEls);
    });
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _text('A'), 5000);
    const b = new ElementHandle(client, _text('B'), 5000);
    const result = await a.or(b).nth(1).find();
    expect(result.text).toBe('B');
  });

  it('all() handles resolve correctly for iteration with assertions', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const items = await handle.all();

    // Simulate the Playwright-style pattern: iterate and check visibility
    for (const item of items) {
      const info = await item.find();
      expect(info.visible).toBe(true);
    }
  });

  it('action methods on unmodified handle pass the direct selector to the agent', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ tap });
    const sel = _text('Button');
    const handle = new ElementHandle(client, sel, 5000);

    await handle.tap();

    // findElements runs once for the strict-mode uniqueness check
    // (PILOT-226), but the action itself still receives the raw selector —
    // the agent re-resolves it on-device.
    expect(client.findElements).toHaveBeenCalled();
    // tap forwards the remaining budget from _waitForEnabled(), which is
    // `deadline - Date.now()` — on a slow tick CI run that can be 4999ms
    // rather than exactly 5000. Assert the call shape, not the exact value.
    expect(tap).toHaveBeenCalledWith(sel, expect.any(Number));
  });

  it('modified handle dispatches by element id (no derived selector)', async () => {
    const tap = vi.fn(async () => successResponse());
    const elWithDesc = makeElementInfo({
      elementId: 'e1',
      text: '',
      resourceId: '',
      contentDescription: 'Close button',
    });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([elWithDesc])),
      tap,
    });
    const handle = new ElementHandle(client, _role('button'), 5000);
    await handle.first().tap();

    expect(tap).toHaveBeenCalledWith(undefined, expect.any(Number), 'e1');
  });

  it('filter().and() applies filter before intersection, not after', async () => {
    // a has elements e1 ("Apple"), e2 ("Banana"), e3 ("Cherry")
    // b has elements e2 ("Banana")
    // a.filter({ hasText: "an" }).and(b) should:
    //   1. Filter a → [e2 "Banana"] (only one contains "an")
    //   2. Intersect with b → [e2 "Banana"]
    // NOT: intersect first → [e2], then filter → [e2] (same result here but different semantics)
    const aEls = [
      makeElementInfo({ elementId: 'e1', text: 'Apple' }),
      makeElementInfo({ elementId: 'e2', text: 'Banana' }),
      makeElementInfo({ elementId: 'e3', text: 'Cherry' }),
    ];
    const bEls = [
      makeElementInfo({ elementId: 'e2', text: 'Banana' }),
      makeElementInfo({ elementId: 'e3', text: 'Cherry' }),
    ];
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'B') return makeFindElementsResponse(bEls);
      return makeFindElementsResponse(aEls);
    });
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _text('A'), 5000);
    const b = new ElementHandle(client, _text('B'), 5000);

    // Without the fix, filter would be applied after and(), giving wrong results
    const count = await a.filter({ hasText: 'an' }).and(b).count();
    expect(count).toBe(1);
    const result = await a.filter({ hasText: 'an' }).and(b).first().find();
    expect(result.text).toBe('Banana');
  });

  it('acts on an element with no addressable property via its cached id', async () => {
    // Element-id addressing means even a property-less element (no resourceId,
    // contentDescription, or text) is actionable — the agent has it cached.
    const tap = vi.fn(async () => successResponse());
    const bareEl = makeElementInfo({
      elementId: 'e1',
      text: '',
      resourceId: '',
      contentDescription: '',
    });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([bareEl])),
      tap,
    });
    const handle = new ElementHandle(client, _role('button'), 5000);
    await handle.first().tap();
    expect(tap).toHaveBeenCalledWith(undefined, expect.any(Number), 'e1');
  });

  it('doubleTap() on nth handle targets the resolved element by id', async () => {
    const doubleTap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      doubleTap,
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    await handle.nth(1).doubleTap();
    expect(doubleTap).toHaveBeenCalledWith(undefined, expect.any(Number), expect.any(Number), 'el-2');
  });

  it('a.and(b).filter(F) applies filter after intersection', async () => {
    // a has e1 ("Apple"), e2 ("Banana"), e3 ("Cherry")
    // b has e1 ("Apple"), e2 ("Banana")
    // a.and(b) = [e1, e2], then .filter({ hasText: "an" }) = [e2 "Banana"]
    // This is DIFFERENT from a.filter(F).and(b) which is:
    //   a.filter(F) = [e2], then AND b = [e2]
    const aEls = [
      makeElementInfo({ elementId: 'e1', text: 'Apple' }),
      makeElementInfo({ elementId: 'e2', text: 'Banana' }),
      makeElementInfo({ elementId: 'e3', text: 'Cherry' }),
    ];
    const bEls = [
      makeElementInfo({ elementId: 'e1', text: 'Apple' }),
      makeElementInfo({ elementId: 'e2', text: 'Banana' }),
    ];
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'B') return makeFindElementsResponse(bEls);
      return makeFindElementsResponse(aEls);
    });
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _text('A'), 5000);
    const b = new ElementHandle(client, _text('B'), 5000);

    // a.and(b).filter(F): intersection first, then filter
    const result = await a.and(b).filter({ hasText: 'an' }).count();
    expect(result).toBe(1);
    const el = await a.and(b).filter({ hasText: 'an' }).first().find();
    expect(el.text).toBe('Banana');

    // Verify it's different from a.filter(F).and(b) when results would differ:
    // a.filter({ hasNotText: 'Apple' }) = [e2 Banana, e3 Cherry]
    // then .and(b) = intersection with [e1, e2] = [e2 Banana]
    const altResult = await a.filter({ hasNotText: 'Apple' }).and(b).count();
    expect(altResult).toBe(1); // Only Banana in both
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Element Actions tests (PILOT-2: PILOT-18 through PILOT-28)
// ═══════════════════════════════════════════════════════════════════════

// ─── doubleTap() (PILOT-18) ───

describe('doubleTap()', () => {
  it('delegates to client.doubleTap with selector and timeout', async () => {
    const doubleTap = vi.fn(async () => successResponse());
    const client = makeMockClient({ doubleTap });
    const sel = _text('Button');
    const handle = new ElementHandle(client, sel, 4000);
    await handle.doubleTap();
    expect(doubleTap).toHaveBeenCalledWith(sel, expect.any(Number), 0);
  });

  it('passes intervalMs to client.doubleTap when specified', async () => {
    const doubleTap = vi.fn(async () => successResponse());
    const client = makeMockClient({ doubleTap });
    const sel = _text('Button');
    const handle = new ElementHandle(client, sel, 4000);
    await handle.doubleTap({ intervalMs: 100 });
    expect(doubleTap).toHaveBeenCalledWith(sel, expect.any(Number), 100);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      doubleTap: vi.fn(async () => failureResponse('Double tap target not found')),
    });
    const handle = new ElementHandle(client, _text('Missing'), 5000);
    await expect(handle.doubleTap()).rejects.toThrow('Double tap target not found');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      doubleTap: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.doubleTap()).rejects.toThrow('Double tap failed');
  });

  it('unmodified handle passes the direct selector to the agent', async () => {
    const doubleTap = vi.fn(async () => successResponse());
    const client = makeMockClient({ doubleTap });
    const sel = _text('Button');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.doubleTap();
    // findElements runs once for the strict-mode uniqueness check (PILOT-226)
    expect(client.findElements).toHaveBeenCalled();
    expect(doubleTap).toHaveBeenCalledWith(sel, expect.any(Number), 0);
  });
});

// ─── dragTo() (PILOT-19) ───

describe('dragTo()', () => {
  it('delegates to client.dragAndDrop with source and target selectors', async () => {
    const dragAndDrop = vi.fn(async () => successResponse());
    const client = makeMockClient({ dragAndDrop });
    const sourceSel = _text('Item 1');
    const targetSel = _text('Drop Zone');
    const source = new ElementHandle(client, sourceSel, 5000);
    const target = new ElementHandle(client, targetSel, 5000);
    await source.dragTo(target);
    // Unmodified handles → both ends dispatched by selector (no element ids).
    expect(dragAndDrop).toHaveBeenCalledWith(sourceSel, targetSel, expect.any(Number), {
      sourceElementId: undefined,
      targetElementId: undefined,
    });
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      dragAndDrop: vi.fn(async () => failureResponse('Drag failed')),
    });
    const source = new ElementHandle(client, _text('Item'), 5000);
    const target = new ElementHandle(client, _text('Zone'), 5000);
    await expect(source.dragTo(target)).rejects.toThrow('Drag failed');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      dragAndDrop: vi.fn(async () => failureResponse('')),
    });
    const source = new ElementHandle(client, _text('Item'), 5000);
    const target = new ElementHandle(client, _text('Zone'), 5000);
    await expect(source.dragTo(target)).rejects.toThrow('Drag and drop failed');
  });

  it('targets each end by its resolved element id for modified handles', async () => {
    const dragAndDrop = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      dragAndDrop,
    });
    const source = new ElementHandle(client, _role('listitem'), 5000);
    const target = new ElementHandle(client, _role('listitem'), 5000);
    await source.first().dragTo(target.last());
    // first() → el-1, last() → el-3; both ends addressed by id, no selectors.
    expect(dragAndDrop).toHaveBeenCalledWith(undefined, undefined, expect.any(Number), {
      sourceElementId: 'el-1',
      targetElementId: 'el-3',
    });
  });
});

// ─── setChecked() (PILOT-20) ───

describe('setChecked()', () => {
  it('taps when current state differs from desired state and verifies', async () => {
    const tap = vi.fn(async () => successResponse());
    let callCount = 0;
    const client = makeMockClient({
      findElements: vi.fn(async () => {
        callCount++;
        // First call: unchecked, second call (verification): checked
        const checked = callCount > 1;
        return makeFindElementsResponse([makeElementInfo({ checked, text: 'Switch', resourceId: 'sw1' })]);
      }),
      tap,
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    await handle.setChecked(true);
    expect(tap).toHaveBeenCalled();
  });

  it('setChecked() on a handle from all() confirms the change from a fresh read — one tap, no blind re-tap (review follow-up)', async () => {
    // The confirmation must read the device (a handle from all() is a live
    // nth(i) locator, never a capture) or it would double-toggle.
    const device = { checked: [false, false] };
    const tap = vi.fn(async (_sel: unknown, _t: unknown, id?: string) => {
      const i = Number(id!.slice(1));
      device.checked[i] = !device.checked[i];
      return successResponse();
    });
    const findElements = vi.fn(async () =>
      makeFindElementsResponse(device.checked.map((c, i) => makeElementInfo({ elementId: `s${i}`, role: 'switch', checked: c }))));
    const client = makeMockClient({ findElements, tap });
    const rows = await new ElementHandle(client, _role('switch'), 5000).all();
    await withFakeClock(10_000, () => rows[1].setChecked(true));
    expect(tap).toHaveBeenCalledTimes(1);
    expect(device.checked).toEqual([false, true]);
  });

  it('on a stale retry, skips the tap if the re-resolved element is already in the desired state', async () => {
    // First resolve: unchecked (so it decides to tap). The tap fails stale.
    // The re-resolve sees it already checked (the change that staled it set it)
    // → must NOT tap again (a second tap would uncheck it).
    let findCount = 0;
    const findElements = vi.fn(async () => {
      findCount += 1;
      return makeFindElementsResponse([
        makeElementInfo({ elementId: 'sw', checked: findCount > 1, text: 'Switch', resourceId: 'sw1' }),
      ]);
    });
    let tapCount = 0;
    const tap = vi.fn(async () => {
      tapCount += 1;
      return tapCount === 1
        ? failureResponse("Element 'sw' not found. It may have gone stale.")
        : successResponse();
    });
    const client = makeMockClient({ findElements, tap });
    // Modified handle → dispatches by element id (the path the stale retry guards).
    const handle = new ElementHandle(client, _text('Switch'), 5000).first();
    await handle.setChecked(true);
    // Only the first (stale) tap happened; the retry was skipped because the
    // re-resolved switch was already checked.
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('on a stale retry, taps the fresh element when still not in the desired state', async () => {
    let findCount = 0;
    const findElements = vi.fn(async () => {
      findCount += 1;
      // Stays unchecked until after the retry tap (call 3 = post-tap verify).
      return makeFindElementsResponse([
        makeElementInfo({ elementId: 'sw', checked: findCount >= 3, text: 'Switch', resourceId: 'sw1' }),
      ]);
    });
    let tapCount = 0;
    const tap = vi.fn(async () => {
      tapCount += 1;
      return tapCount === 1
        ? failureResponse("Element 'sw' not found. It may have gone stale.")
        : successResponse();
    });
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Switch'), 5000).first();
    await handle.setChecked(true);
    // Stale first tap → re-resolve still unchecked → retry tap (dispatched by id).
    expect(tap).toHaveBeenCalledTimes(2);
    expect(tap).toHaveBeenNthCalledWith(2, undefined, expect.any(Number), 'sw');
  });

  it('does not tap when current state matches desired state', async () => {
    const tap = vi.fn(async () => successResponse());
    const el = makeElementInfo({ checked: true, text: 'Switch', resourceId: 'sw1' });
    const findResult = { requestId: '1', found: true, element: el, errorMessage: '' };
    const client = makeMockClient({
      findElement: vi.fn(async () => findResult),
      findElements: vi.fn(async () => makeFindElementsResponse([el])),
      tap,
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    await handle.setChecked(true);
    expect(tap).not.toHaveBeenCalled();
  });

  it('taps to uncheck when element is checked and desired is false', async () => {
    const tap = vi.fn(async () => successResponse());
    let callCount = 0;
    const makEl = () => { callCount++; return makeElementInfo({ checked: callCount <= 1, text: 'Switch', resourceId: 'sw1' }); };
    const client = makeMockClient({
      findElement: vi.fn(async () => ({ requestId: '1', found: true, element: makEl(), errorMessage: '' })),
      findElements: vi.fn(async () => makeFindElementsResponse([makEl()])),
      tap,
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    await handle.setChecked(false);
    expect(tap).toHaveBeenCalled();
  });

  it('throws when tap fails', async () => {
    const el = makeElementInfo({ checked: false, text: 'Switch', resourceId: 'sw1' });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([el])),
      tap: vi.fn(async () => failureResponse('Tap failed')),
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    await expect(handle.setChecked(true)).rejects.toThrow('Tap failed');
  });

  it('throws when state does not change after tap', async () => {
    const tap = vi.fn(async () => successResponse());
    // Always returns unchecked — simulates a non-responsive checkbox
    const el = makeElementInfo({ checked: false, text: 'Switch', resourceId: 'sw1' });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([el])),
      tap,
    });
    // Use a short timeout so the retry loop exhausts quickly in the test
    const handle = new ElementHandle(client, _text('Switch'), 1500);
    await expect(handle.setChecked(true)).rejects.toThrow('did not change after tap');
    // With retry, tap should have been called more than once
    expect(tap.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 10000);

  it('works on modified handles', async () => {
    const tap = vi.fn(async () => successResponse());
    let callCount = 0;
    const client = makeMockClient({
      findElements: vi.fn(async () => {
        callCount++;
        const items = [
          makeElementInfo({ elementId: 'e1', text: 'Switch 1', resourceId: 'sw1', checked: true }),
          makeElementInfo({
            elementId: 'e2',
            text: 'Switch 2',
            resourceId: 'sw2',
            // First call: unchecked, second call (verification): checked
            checked: callCount > 1,
          }),
        ];
        return makeFindElementsResponse(items);
      }),
      tap,
    });
    const handle = new ElementHandle(client, _role('switch'), 5000);
    await handle.nth(1).setChecked(true);
    // Dispatched by the resolved switch's cached id 'e2'.
    expect(tap).toHaveBeenCalledWith(undefined, expect.any(Number), 'e2');
  });
});

// ─── selectOption() (PILOT-21) ───

describe('selectOption()', () => {
  it('delegates to client.selectOption with string option', async () => {
    const selectOption = vi.fn(async () => successResponse());
    const client = makeMockClient({ selectOption });
    const sel = _text('Dropdown');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.selectOption('Option 2');
    expect(selectOption).toHaveBeenCalledWith(sel, 'Option 2', expect.any(Number));
  });

  it('delegates to client.selectOption with index option', async () => {
    const selectOption = vi.fn(async () => successResponse());
    const client = makeMockClient({ selectOption });
    const sel = _text('Dropdown');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.selectOption({ index: 1 });
    expect(selectOption).toHaveBeenCalledWith(sel, { index: 1 }, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      selectOption: vi.fn(async () => failureResponse('Option not found')),
    });
    const handle = new ElementHandle(client, _text('Dropdown'), 5000);
    await expect(handle.selectOption('Missing')).rejects.toThrow('Option not found');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      selectOption: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.selectOption('A')).rejects.toThrow('Select option failed');
  });
});

// ─── screenshot() (PILOT-22) ───

describe('screenshot()', () => {
  it('delegates to client.takeElementScreenshot and returns Buffer', async () => {
    const takeElementScreenshot = vi.fn(async () => screenshotResponse());
    const client = makeMockClient({ takeElementScreenshot });
    const sel = _text('Image');
    const handle = new ElementHandle(client, sel, 5000);
    const result = await handle.screenshot();
    expect(takeElementScreenshot).toHaveBeenCalledWith(sel, expect.any(Number));
    expect(result).toEqual(Buffer.from('PNG_DATA'));
  });

  it('targets the resolved element by id for modified handles', async () => {
    const takeElementScreenshot = vi.fn(async () => screenshotResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      takeElementScreenshot,
    });
    const handle = new ElementHandle(client, _role('image'), 5000);
    await handle.first().screenshot();
    expect(takeElementScreenshot).toHaveBeenCalledWith(undefined, expect.any(Number), 'el-1');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      takeElementScreenshot: vi.fn(async () => ({
        requestId: '1',
        success: false,
        data: Buffer.alloc(0),
        errorMessage: 'Screenshot capture failed',
      })),
    });
    const handle = new ElementHandle(client, _text('Image'), 5000);
    await expect(handle.screenshot()).rejects.toThrow('Screenshot capture failed');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      takeElementScreenshot: vi.fn(async () => ({
        requestId: '1',
        success: false,
        data: Buffer.alloc(0),
        errorMessage: '',
      })),
    });
    const handle = new ElementHandle(client, _text('Image'), 5000);
    await expect(handle.screenshot()).rejects.toThrow('Element screenshot failed');
  });
});

// ─── boundingBox() (PILOT-23) ───

describe('boundingBox()', () => {
  it('returns bounding box from element bounds', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ bounds: { left: 10, top: 20, right: 110, bottom: 70 } }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Header'), 5000);
    const box = await handle.boundingBox();
    expect(box).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('returns null when element has no bounds', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ bounds: undefined }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Header'), 5000);
    const box = await handle.boundingBox();
    expect(box).toBeNull();
  });

  it('works on modified handles', async () => {
    const items = [
      makeElementInfo({ elementId: 'e1', text: 'A', resourceId: 'a', bounds: { left: 0, top: 0, right: 50, bottom: 50 } }),
      makeElementInfo({ elementId: 'e2', text: 'B', resourceId: 'b', bounds: { left: 50, top: 0, right: 150, bottom: 80 } }),
    ];
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(items)),
    });
    const handle = new ElementHandle(client, _role('button'), 5000);
    const box = await handle.last().boundingBox();
    expect(box).toEqual({ x: 50, y: 0, width: 100, height: 80 });
  });

  it('waits for a late element on a modified handle instead of failing on the first empty read (review follow-up)', async () => {
    let calls = 0;
    const findElements = vi.fn(async () =>
      ++calls < 3
        ? makeFindElementsResponse([])
        : makeFindElementsResponse([makeElementInfo({ elementId: 'e1', bounds: { left: 0, top: 0, right: 50, bottom: 50 } })]));
    const client = makeMockClient({ findElements });
    const box = await withFakeClock(5000, () => new ElementHandle(client, _role('button'), 5000).first().boundingBox());
    expect(box).toEqual({ x: 0, y: 0, width: 50, height: 50 });
    expect(calls).toBe(3);
  });

  it('reports a timed-out wait on a modified handle, not a single-read positional miss (review follow-up)', async () => {
    const client = makeMockClient({ findElements: vi.fn(async () => makeFindElementsResponse([])) });
    await expect(withFakeClock(5000, () => new ElementHandle(client, _role('button'), 1000).first().boundingBox()))
      .rejects.toThrow(/was not found after waiting 1000ms$/);
  });
});

// ─── pinchIn() / pinchOut() (PILOT-24) ───

describe('pinchIn()', () => {
  it('delegates to client.pinchZoom with default scale 0.5', async () => {
    const pinchZoom = vi.fn(async () => successResponse());
    const client = makeMockClient({ pinchZoom });
    const sel = _text('Map');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.pinchIn();
    expect(pinchZoom).toHaveBeenCalledWith(sel, 0.5, expect.any(Number));
  });

  it('accepts custom scale', async () => {
    const pinchZoom = vi.fn(async () => successResponse());
    const client = makeMockClient({ pinchZoom });
    const sel = _text('Map');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.pinchIn({ scale: 0.3 });
    expect(pinchZoom).toHaveBeenCalledWith(sel, 0.3, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      pinchZoom: vi.fn(async () => failureResponse('Pinch failed')),
    });
    const handle = new ElementHandle(client, _text('Map'), 5000);
    await expect(handle.pinchIn()).rejects.toThrow('Pinch failed');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      pinchZoom: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.pinchIn()).rejects.toThrow('Pinch in failed');
  });
});

describe('pinchOut()', () => {
  it('delegates to client.pinchZoom with default scale 2.0', async () => {
    const pinchZoom = vi.fn(async () => successResponse());
    const client = makeMockClient({ pinchZoom });
    const sel = _text('Map');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.pinchOut();
    expect(pinchZoom).toHaveBeenCalledWith(sel, 2.0, expect.any(Number));
  });

  it('accepts custom scale', async () => {
    const pinchZoom = vi.fn(async () => successResponse());
    const client = makeMockClient({ pinchZoom });
    const sel = _text('Map');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.pinchOut({ scale: 3.0 });
    expect(pinchZoom).toHaveBeenCalledWith(sel, 3.0, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      pinchZoom: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.pinchOut()).rejects.toThrow('Pinch out failed');
  });
});

// ─── focus() / blur() (PILOT-25) ───

describe('focus()', () => {
  it('delegates to client.focus with selector and timeout', async () => {
    const focus = vi.fn(async () => successResponse());
    const client = makeMockClient({ focus });
    const sel = _text('Email');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.focus();
    expect(focus).toHaveBeenCalledWith(sel, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      focus: vi.fn(async () => failureResponse('Cannot focus')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.focus()).rejects.toThrow('Cannot focus');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      focus: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.focus()).rejects.toThrow('Focus failed');
  });

  it('unmodified handle passes the direct selector to the agent', async () => {
    const focus = vi.fn(async () => successResponse());
    const client = makeMockClient({ focus });
    const sel = _text('Input');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.focus();
    // findElements runs once for the strict-mode uniqueness check (PILOT-226)
    expect(client.findElements).toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith(sel, expect.any(Number));
  });
});

describe('blur()', () => {
  it('delegates to client.blur with selector and timeout', async () => {
    const blur = vi.fn(async () => successResponse());
    const client = makeMockClient({ blur });
    const sel = _text('Email');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.blur();
    expect(blur).toHaveBeenCalledWith(sel, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      blur: vi.fn(async () => failureResponse('Cannot blur')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.blur()).rejects.toThrow('Cannot blur');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      blur: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.blur()).rejects.toThrow('Blur failed');
  });
});

// ─── isChecked() (PILOT-26) ───

describe('isChecked()', () => {
  it('returns true when element is checked', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ checked: true })])),
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    expect(await handle.isChecked()).toBe(true);
  });

  it('returns false when element is not checked', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ checked: false })])),
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    expect(await handle.isChecked()).toBe(false);
  });

  it('waits for the element and throws when it never appears (Playwright contract, unlike isVisible)', async () => {
    const client = makeMockClient({ findElements: vi.fn(async () => makeFindElementsResponse([])) });
    const handle = new ElementHandle(client, _text('Switch'), 600);
    await expect(withFakeClock(5000, () => handle.isChecked())).rejects.toThrow(/was not found after waiting 600ms/);
  });
});

// ─── inputValue() (PILOT-27) ───

describe('inputValue()', () => {
  it('returns the text value of the element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ text: 'user@example.com' })])),
    });
    const handle = new ElementHandle(client, _text('Email'), 5000);
    expect(await handle.inputValue()).toBe('user@example.com');
  });

  it('returns empty string when field is empty', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ text: '' })])),
    });
    const handle = new ElementHandle(client, _text('Email'), 5000);
    expect(await handle.inputValue()).toBe('');
  });
});

// ─── highlight() (PILOT-28) ───

describe('highlight()', () => {
  it('delegates to client.highlight with selector and timeout', async () => {
    const highlight = vi.fn(async () => successResponse());
    const client = makeMockClient({ highlight });
    const sel = _text('Submit');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.highlight();
    expect(highlight).toHaveBeenCalledWith(sel, undefined, expect.any(Number));
  });

  it('passes durationMs option', async () => {
    const highlight = vi.fn(async () => successResponse());
    const client = makeMockClient({ highlight });
    const sel = _text('Submit');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.highlight({ durationMs: 2000 });
    expect(highlight).toHaveBeenCalledWith(sel, 2000, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      highlight: vi.fn(async () => failureResponse('Highlight failed')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.highlight()).rejects.toThrow('Highlight failed');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      highlight: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.highlight()).rejects.toThrow('Highlight failed');
  });
});

// ─── waitFor ───

describe('waitFor', () => {
  it('resolves immediately when element is already visible (default state)', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ visible: true }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor();
  });

  it('resolves immediately for state "attached" when element exists', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ visible: false }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor({ state: 'attached' });
  });

  it('resolves immediately for state "hidden" when element does not exist', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor({ state: 'hidden' });
  });

  it('resolves for state "hidden" when element exists but is not visible', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ visible: false }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor({ state: 'hidden' });
  });

  it('resolves immediately for state "detached" when element does not exist', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor({ state: 'detached' });
  });

  it('polls until element becomes visible', async () => {
    let callCount = 0;
    const client = makeMockClient({
      findElements: vi.fn(async () => {
        callCount++;
        if (callCount < 3) return makeFindElementsResponse([]);
        return makeFindElementsResponse([makeElementInfo({ visible: true })]);
      }),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor({ state: 'visible' });
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('aborts the poll loop promptly when the client abort signal fires (PILOT-222)', async () => {
    const ac = new AbortController();
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
      _getAbortSignal: vi.fn(() => ac.signal),
    } as Partial<TapsmithGrpcClient>);
    // Long timeout: only the abort can end this wait inside vitest's budget.
    const handle = new ElementHandle(client, _text('Hello'), 60_000);
    const wait = handle.waitFor({ state: 'visible' });
    setTimeout(() => ac.abort(), 20);
    // Must surface the abort, NOT the "did not reach state" timeout error.
    await expect(wait).rejects.toSatisfy(isAbortError);
  });

  it('polls until element becomes detached', async () => {
    let callCount = 0;
    const client = makeMockClient({
      findElements: vi.fn(async () => {
        callCount++;
        if (callCount < 3) return makeFindElementsResponse([makeElementInfo()]);
        return makeFindElementsResponse([]);
      }),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor({ state: 'detached' });
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('throws after timeout when state is not reached', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 500);
    await expect(handle.waitFor({ state: 'visible', timeout: 500 }))
      .rejects.toThrow(/did not reach state "visible" after 500ms/);
  });

  it('respects custom timeout option', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ visible: false }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 30000);
    const start = Date.now();
    await expect(handle.waitFor({ state: 'visible', timeout: 300 }))
      .rejects.toThrow(/did not reach state "visible"/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  it('propagates infrastructure errors instead of polling', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => { throw new Error('gRPC unavailable'); }),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await expect(handle.waitFor()).rejects.toThrow('gRPC unavailable');
  });

  it('works with .first() modifier', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ elementId: 'a', visible: true }),
        makeElementInfo({ elementId: 'b', visible: true }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000).first();
    await handle.waitFor({ state: 'visible' });
  });

  it('respects nthIndex — only checks the targeted element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ elementId: 'a', visible: false }),
        makeElementInfo({ elementId: 'b', visible: true }),
      ])),
    });
    // .first() targets index 0 which is NOT visible
    const handle = new ElementHandle(client, _text('Hello'), 500).first();
    await expect(handle.waitFor({ state: 'visible', timeout: 500 }))
      .rejects.toThrow(/did not reach state "visible"/);
  });

  it('respects nthIndex for detached state with .last()', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ elementId: 'a' }),
        makeElementInfo({ elementId: 'b' }),
      ])),
    });
    // .last() targets index -1 which exists — so 'detached' should fail
    const handle = new ElementHandle(client, _text('Hello'), 500).last();
    await expect(handle.waitFor({ state: 'detached', timeout: 500 }))
      .rejects.toThrow(/did not reach state "detached"/);
  });
});

// ─── isEditable ───

describe('isEditable', () => {
  it('returns true for enabled textfield', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ role: 'textfield', enabled: true })])),
    });
    const handle = new ElementHandle(client, _text('Email'), 5000);
    expect(await handle.isEditable()).toBe(true);
  });

  it('returns false for disabled textfield', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ role: 'textfield', enabled: false })])),
    });
    const handle = new ElementHandle(client, _text('Email'), 5000);
    expect(await handle.isEditable()).toBe(false);
  });

  it('returns false for non-textfield element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ role: 'button', enabled: true })])),
    });
    const handle = new ElementHandle(client, _text('Submit'), 5000);
    expect(await handle.isEditable()).toBe(false);
  });

  it('waits for the element and throws when it never appears (Playwright contract, unlike isVisible)', async () => {
    const client = makeMockClient({ findElements: vi.fn(async () => makeFindElementsResponse([])) });
    const handle = new ElementHandle(client, _text('Email'), 600);
    await expect(withFakeClock(5000, () => handle.isEditable())).rejects.toThrow(/was not found after waiting 600ms/);
  });

  it('waits through a screen transition on a modified handle too (.first()) — review follow-up', async () => {
    // Modified handles used to route through the single-shot _resolveOne() and
    // fail instantly with "nth(0): expected at least 1 element(s)" mid-transition.
    let calls = 0;
    const findElements = vi.fn(async () =>
      ++calls < 3
        ? makeFindElementsResponse([])
        : makeFindElementsResponse([makeElementInfo({ role: 'textfield', enabled: true })]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _role('textfield'), 5000).first();
    expect(await handle.isEditable()).toBe(true);
    expect(calls).toBe(3);
  });

  it('throws the documented "not found after waiting" error on a modified handle when absent', async () => {
    const client = makeMockClient({ findElements: vi.fn(async () => makeFindElementsResponse([])) });
    const handle = new ElementHandle(client, _role('button'), 300).first();
    await expect(handle.isEnabled()).rejects.toThrow(/was not found after waiting 300ms/);
  });

  it('timeout: 0 on an unmodified handle is one real read, not a throw without querying (pre-existing gap)', async () => {
    // _strictResolve returns early at 0 (actions then hand the raw selector to
    // the agent); find() used to fall through to that and throw "Element not
    // found" with zero findElements calls.
    const present = vi.fn(async () => makeFindElementsResponse([makeElementInfo({ enabled: false })]));
    expect(await new ElementHandle(makeMockClient({ findElements: present }), _role('button'), 0).isEnabled()).toBe(false);
    expect(present).toHaveBeenCalledTimes(1);
    // 0 is passed through: the daemon treats it as "use the default deadline".
    expect(present).toHaveBeenCalledWith(expect.anything(), 0);

    const absent = vi.fn(async () => makeFindElementsResponse([]));
    await expect(new ElementHandle(makeMockClient({ findElements: absent }), _role('button'), 0).getText())
      .rejects.toThrow(/Element not found/);
    expect(absent).toHaveBeenCalledTimes(1);

    // Still strict at 0.
    const two = vi.fn(async () => makeFindElementsResponse([
      makeElementInfo({ elementId: 'a', bounds: { left: 0, top: 0, right: 10, bottom: 10 } }),
      makeElementInfo({ elementId: 'b', bounds: { left: 0, top: 20, right: 10, bottom: 30 } }),
    ]));
    const err = await new ElementHandle(makeMockClient({ findElements: two }), _role('button'), 0).find().catch((e) => e);
    expect(err).toBeInstanceOf(StrictModeViolationError);
  });

  it('keeps the timeout: 0 opt-out single-shot on a modified handle', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    // One error shape for a plain miss, whatever the handle shape (the
    // positional `nth(0): expected at least 1 …` is an implementation detail).
    await expect(new ElementHandle(client, _role('button'), 0).first().isEnabled()).rejects.toThrow(/^Element not found: /);
    expect(findElements).toHaveBeenCalledTimes(1);
  });

  it('waits through a screen transition before reading (regression guard for e2e is-editable)', async () => {
    // Right after a navigation tap the field may not be in the tree yet; the
    // reader must auto-wait rather than take a single-shot snapshot.
    let calls = 0;
    const findElements = vi.fn(async () =>
      ++calls < 3
        ? makeFindElementsResponse([])
        : makeFindElementsResponse([makeElementInfo({ role: 'textfield', enabled: true })]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Email'), 5000);
    expect(await handle.isEditable()).toBe(true);
    expect(calls).toBe(3);
  });
});

// ─── Same-target duplicate collapsing (PILOT-226) ───
// The iOS accessibility tree exposes some text elements twice: a parent
// StaticText carrying the attributes (testID, traits) and an inner child
// with identical label and pixel-identical bounds. That must not count as
// a strict-mode ambiguity.

describe('same-target duplicate collapsing', () => {
  const parent = makeElementInfo({
    elementId: 'p',
    text: '0',
    resourceId: 'counter-value',
    bounds: { left: 16, top: 674, right: 386, bottom: 751 },
  });
  const childDup = makeElementInfo({
    elementId: 'c',
    text: '0',
    resourceId: '',
    bounds: { left: 16, top: 674, right: 386, bottom: 751 },
  });

  it('tap() does not throw strict violation for an identical parent/child pair', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([parent, childDup])),
      tap,
    });
    const handle = new ElementHandle(client, _text('0'), 5000);
    await handle.tap();
    expect(tap).toHaveBeenCalled();
  });

  it('find() resolves to the attribute-carrying first occurrence', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([parent, childDup])),
    });
    const handle = new ElementHandle(client, _text('0'), 5000);
    const el = await handle.find();
    expect(el.resourceId).toBe('counter-value');
  });

  it('count() reports collapsed visual elements', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([parent, childDup])),
    });
    const handle = new ElementHandle(client, _text('0'), 5000);
    expect(await handle.count()).toBe(1);
  });

  it('still throws for distinct elements with the same text at different bounds', async () => {
    const other = makeElementInfo({
      elementId: 'q',
      text: '0',
      bounds: { left: 16, top: 100, right: 386, bottom: 150 },
    });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([other, parent, childDup])),
    });
    const handle = new ElementHandle(client, _text('0'), 5000);
    await expect(handle.tap()).rejects.toThrow(/^strict mode violation/);
  });

  it('does not collapse zero-area elements', async () => {
    const hiddenA = makeElementInfo({ elementId: 'a', text: 'x', bounds: { left: 0, top: 0, right: 0, bottom: 0 } });
    const hiddenB = makeElementInfo({ elementId: 'b', text: 'x', bounds: { left: 0, top: 0, right: 0, bottom: 0 } });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([hiddenA, hiddenB])),
    });
    const handle = new ElementHandle(client, _text('x'), 5000);
    expect(await handle.count()).toBe(2);
  });
});

describe('strict violation suggestion escaping', () => {
  it('escapes quotes/backslashes/newlines in suggested locators', async () => {
    const elements = [
      makeElementInfo({ text: 'Say "hi"\nnow', bounds: { left: 0, top: 0, right: 10, bottom: 10 } }),
      makeElementInfo({ text: 'Say "hi" later', bounds: { left: 0, top: 20, right: 10, bottom: 30 } }),
    ];
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(elements)),
    });
    const handle = new ElementHandle(client, _textContains('Say'), 5000);
    const err = await handle.tap().then(
      () => { throw new Error('expected tap to reject'); },
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain('device.getByText("Say \\"hi\\"\\nnow", { exact: true })');
    expect((err as Error).message).toContain('device.getByText("Say \\"hi\\" later", { exact: true })');
  });
});

describe('review follow-ups (PR #124)', () => {
  it('type() on a positional handle auto-waits for the element to appear', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return makeFindElementsResponse(calls >= 3 ? [makeElementInfo({ text: 'Email', resourceId: 'email' })] : []);
    });
    const typeText = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, typeText });
    const handle = new ElementHandle(client, _textContains('Email'), 5000);
    await handle.first().type('hi');
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(typeText).toHaveBeenCalled();
  });

  it('type() throws "not found" after the timeout when the element never appears', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _text('Ghost'), 400);
    await expect(handle.type('x')).rejects.toThrow(/was not found after waiting/);
  });

  it('actions surface a daemon errorMessage instead of reporting "not found"', async () => {
    // The error is retried within the budget (it may be a momentary agent
    // blip); when it persists, the deadline surfaces the real cause.
    const client = makeMockClient({
      findElements: vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'UiAutomation not connected' })),
    });
    const handle = new ElementHandle(client, _text('X'), 600);
    await expect(handle.tap()).rejects.toThrow(/findElements failed: UiAutomation not connected/);
  });

  it('count() surfaces a daemon errorMessage instead of returning 0', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'agent socket closed' })),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.count()).rejects.toThrow(/findElements failed: agent socket closed/);
  });
});

describe('transient stale snapshot handling (wait-for flake regression)', () => {
  // The Android agent stamps this onto a transient UIAutomator
  // StaleObjectException when the hierarchy changes mid-snapshot (e.g. a
  // React re-render right after a tap). PILOT-226's strict pre-action resolve
  // used to report it as a hard "findElements failed", failing the action
  // even with timeout budget left — the cause of the flaky wait-for tests.
  const STALE_MSG = 'Element is stale (UI changed): null';

  it('tap() retries through a transient stale snapshot and then succeeds', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      // First snapshot is stale (UI still re-rendering), the next settles.
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: STALE_MSG }
        : makeFindElementsResponse([makeElementInfo({ text: 'Show banner' })]);
    });
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Show banner'), 5000);

    await handle.tap();

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('a stale snapshot that never settles times out as "not found", not a hard failure', async () => {
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: STALE_MSG }));
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Show banner'), 400);

    await expect(handle.tap()).rejects.toThrow(/was not found after waiting/);
    // Polled across multiple ticks rather than failing fast on the first stale.
    expect(findElements.mock.calls.length).toBeGreaterThan(1);
    expect(tap).not.toHaveBeenCalled();
  });

  it('a persistent daemon error is retried within the budget and surfaces its real cause at the deadline', async () => {
    // A momentary agent internal error (e.g. an exception thrown while the
    // hierarchy is mid-re-render) recovers on the next tick, so actions
    // retry it instead of aborting. When it PERSISTS, the deadline surfaces
    // the real error — not a generic "not found".
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'UiAutomation not connected' }));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 600);

    await expect(handle.tap()).rejects.toThrow(/findElements failed: UiAutomation not connected/);
    expect(findElements.mock.calls.length).toBeGreaterThan(1);
  });

  it('tap() rides out a momentary agent internal error and then acts', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'Unknown error' }
        : makeFindElementsResponse([makeElementInfo({ visible: true })]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 5000);

    await handle.tap();

    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('waitFor() retries through a transient stale snapshot and then resolves', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: STALE_MSG }
        : makeFindElementsResponse([makeElementInfo({ visible: true })]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Banner'), 5000);

    await handle.waitFor({ state: 'visible' });

    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('waitFor() retries a persistent daemon error and surfaces its real cause at the deadline', async () => {
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'UiAutomation not connected' }));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 600);

    await expect(handle.waitFor({ state: 'visible' })).rejects.toThrow(/findElements failed: UiAutomation not connected/);
    expect(findElements.mock.calls.length).toBeGreaterThan(1);
  });

  it('waitFor() rides out a momentary agent internal error and then resolves', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'Unknown error' }
        : makeFindElementsResponse([makeElementInfo({ visible: true })]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Banner'), 5000);

    await handle.waitFor({ state: 'visible' });

    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('waitFor({ state: "detached" }) does not resolve off an agent internal error tick', async () => {
    // An error tick is not a confirmed empty set — 'detached' must not
    // falsely resolve on it (the agent may just have blipped mid-re-render
    // while the element is still attached).
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'Unknown error' }
        : makeFindElementsResponse([makeElementInfo({ visible: true })]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Banner'), 700);

    await expect(handle.waitFor({ state: 'detached' })).rejects.toThrow(/did not reach state "detached"/);
  });

  it('filter({ has }) surfaces a daemon error from child resolution instead of mis-filtering', async () => {
    // Parent resolves fine; the has-probe (child) resolution hits a daemon
    // error. Without surfacing it, childElements=[] would silently filter out
    // every parent and count() would return 0 instead of failing.
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.parent) return { requestId: '1', elements: [], errorMessage: 'UiAutomation not connected' };
      return makeFindElementsResponse([
        makeElementInfo({ elementId: 'p1', bounds: { left: 0, top: 0, right: 100, bottom: 100 } }),
      ]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const badge = new ElementHandle(client, _text('Badge'), 5000);

    await expect(handle.filter({ has: badge }).count()).rejects.toThrow(/findElements failed: UiAutomation not connected/);
  });

  it('waitFor({ state: "detached" }) does not resolve on a transient stale snapshot — retries first', async () => {
    // A stale tick is unreliable, not a confirmed absence: it must NOT
    // immediately satisfy 'detached' (which reads an empty result as the
    // target state). Without retrying, the first stale blip would resolve
    // prematurely on tick 1.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: STALE_MSG }
        : makeFindElementsResponse([]); // genuinely gone on the settled tick
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Banner'), 5000);

    await handle.waitFor({ state: 'detached' });

    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('transient agent-command timeout handling (slow-emulator flake regression)', () => {
  // The Rust daemon stamps this when the on-device agent is alive (socket
  // connected, command written) but too slow to answer a findElements within
  // the per-poll read window — e.g. an uninterruptible UIAutomator hierarchy
  // dump on a CPU-starved CI emulator. It used to abort the whole action on the
  // first slow tick; now action auto-wait loops retry it within their budget.
  const AGENT_TIMEOUT_MSG = 'Agent command timed out after 5.25s';

  it('tap() retries through a transient agent timeout and then succeeds', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      // First tick times out at the agent (slow dump); the next answers.
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: AGENT_TIMEOUT_MSG }
        : makeFindElementsResponse([makeElementInfo({ text: 'Settings' })]);
    });
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Settings'), 5000);

    await handle.tap();

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('a persistent agent timeout surfaces the infra error (not "not found") so session recovery fires', async () => {
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: AGENT_TIMEOUT_MSG }));
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Settings'), 400);

    // Must preserve the "Agent command timed out" wording (a
    // RECOVERABLE_INFRASTRUCTURE_PATTERN) rather than collapse to "not found".
    await expect(handle.tap()).rejects.toThrow(/Agent command timed out/);
    // Retried across ticks within the budget rather than aborting on tick 1.
    expect(findElements.mock.calls.length).toBeGreaterThan(1);
    expect(tap).not.toHaveBeenCalled();
  });

  it('waitFor() retries through a transient agent timeout and then resolves', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: AGENT_TIMEOUT_MSG }
        : makeFindElementsResponse([makeElementInfo({ visible: true })]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Banner'), 5000);

    await handle.waitFor({ state: 'visible' });

    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('waitFor() surfaces a persistent agent timeout as the infra error, not "did not reach state"', async () => {
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: AGENT_TIMEOUT_MSG }));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Banner'), 400);

    await expect(handle.waitFor({ state: 'visible' })).rejects.toThrow(/Agent command timed out/);
    expect(findElements.mock.calls.length).toBeGreaterThan(1);
  });

  it('scrollIntoView() retries through a transient agent timeout by re-probing — without a blind swipe', async () => {
    const bounds = { left: 0, top: 10, right: 100, bottom: 40 };
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      // First probe times out at the agent; the next tick answers with the
      // element visible on screen. A timed-out tick says nothing about where
      // the element is, so it must NOT trigger a swipe that could displace an
      // already-visible target (PILOT-283) — just re-probe.
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: AGENT_TIMEOUT_MSG }
        : makeFindElementsResponse([makeElementInfo({ visible: true, bounds })]);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Target'), 5000);

    await handle.scrollIntoView();

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(swipe).not.toHaveBeenCalled();
  });

  it('setChecked() surfaces a persistent agent timeout during confirmation as the infra error, not "did not change"', async () => {
    // Resolve + tap succeed; the post-tap confirmation poll then times out for
    // the whole budget. The action must surface the infra error (→ session
    // recovery), not the generic "did not change" synthetic failure.
    let calls = 0;
    const el = makeElementInfo({ checked: false, text: 'Switch', resourceId: 'sw1' });
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? makeFindElementsResponse([el]) // initial resolve → unchecked element
        : { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5.25s' };
    });
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Switch'), 800);

    await expect(handle.setChecked(true)).rejects.toThrow(/Agent command timed out/);
    expect(tap).toHaveBeenCalledTimes(1);
  }, 10000);

  it('scrollIntoView() does not swipe again when a stabilization poll times out on an already-visible target', async () => {
    const bounds = { left: 0, top: 10, right: 100, bottom: 40 };
    let findCalls = 0;
    const findElements = vi.fn(async () => {
      findCalls++;
      // Calls 1-2: not on screen (probe + first-swipe confirmation re-probe
      // both miss) → one swipe; call 3: target visible; call 4 onwards: the
      // post-scroll stabilization read times out at the agent. The daemon
      // surfaces this as errorMessage on the response, not a rejection.
      if (findCalls < 3) return makeFindElementsResponse([]);
      if (findCalls === 3) return makeFindElementsResponse([makeElementInfo({ visible: true, bounds })]);
      return { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5.5s' };
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Target'), 5000);

    await handle.scrollIntoView();

    // The target is already visible, so this must stop stabilizing and succeed
    // — NOT fall through to another swipe that could scroll it back off-screen
    // — and it breaks on the first errored read rather than re-probing all 10
    // ticks (which, with a real ~5s-per-probe timeout, wasted ~50s).
    expect(findElements).toHaveBeenCalledTimes(4);
    expect(swipe).toHaveBeenCalledTimes(1); // only the pre-visible swipe, no extra
  });

  it('scrollIntoView() surfaces a persistent agent timeout as the infra error, not "not visible after N scroll(s)"', async () => {
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5.25s' }));
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Target'), 5000);

    await expect(handle.scrollIntoView({ maxScrolls: 2 })).rejects.toThrow(/Agent command timed out/);
    // Retried by re-probing across the budget rather than aborting on tick 1;
    // timed-out ticks carry no position information, so no blind swipes.
    expect(findElements.mock.calls.length).toBeGreaterThan(1);
    expect(swipe).not.toHaveBeenCalled();
  }, 10000);

  it('a recovered agent reports a genuine "not found", not the earlier timeout', async () => {
    // Agent times out on the first tick, then recovers and answers cleanly
    // (empty) for the rest of the budget. The element genuinely never appears,
    // so the action must fail as "not found" — NOT resurface the stale timeout,
    // which would falsely trigger session recovery for a plain missing element.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5.25s' }
        : makeFindElementsResponse([]); // agent responsive, element absent
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Ghost'), 800);

    await expect(handle.tap()).rejects.toThrow(/was not found after waiting/);
    await expect(handle.tap()).rejects.not.toThrow(/Agent command timed out/);
  });

  it('waitFor() after a recovered agent reports "did not reach state", not the earlier timeout', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5.25s' }
        : makeFindElementsResponse([]); // responsive, never reaches 'visible'
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Banner'), 800);

    await expect(handle.waitFor({ state: 'visible' })).rejects.toThrow(/did not reach state/);
  });

  it('a persistent non-timeout daemon error surfaces its real cause at the deadline', async () => {
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'UiAutomation not connected' }));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 600);

    await expect(handle.tap()).rejects.toThrow(/findElements failed: UiAutomation not connected/);
    expect(findElements.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('scoped selector descriptions (review follow-up)', () => {
  it('renders chained getBy* syntax, not .locator(getBy*())', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const parent = new ElementHandle(client, _role('list'), 300);
    const child = parent.getByText('Row', { exact: true });
    await expect(withFakeClock(5000, () => child.find())).rejects.toThrow(
      'getByRole("list").getByText("Row", { exact: true })',
    );
  });
});

describe('scrollIntoView agent-fault policy (review follow-up, PILOT-345)', () => {
  it('re-probes through a momentary agent fault instead of failing the scroll — and does not swipe blind on it', async () => {
    // The other poll loops (actions, waitFor, the visibility probes) already
    // treated a `findElements failed: …` tick as a momentary fault to retry;
    // the scroll probe alone aborted on it. One primitive now classifies a
    // tick for all of them.
    const bounds = { left: 0, top: 10, right: 100, bottom: 40 };
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'node detached mid-read' }
        : makeFindElementsResponse([makeElementInfo({ visible: true, bounds })]);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Target'), 5000);

    await handle.scrollIntoView();

    expect(calls).toBe(2);
    expect(swipe).not.toHaveBeenCalled();
  });

  it('surfaces a persistent daemon errorMessage as the real cause instead of swiping to the max', async () => {
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'agent gone' }));
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Target'), 5000);
    // Unreliable ticks have their own bound (maxScrolls + 1); once it is spent
    // the remembered fault — not a generic "not visible after N scroll(s)" —
    // is thrown, and no tick without position information swiped.
    await expect(handle.scrollIntoView({ maxScrolls: 1 })).rejects.toThrow(/findElements failed: agent gone/);
    expect(findElements).toHaveBeenCalledTimes(2);
    expect(swipe).not.toHaveBeenCalled();
  });
});

describe('scrollIntoView no-op on already-visible targets (PILOT-283)', () => {
  const bounds = { left: 0, top: 372, right: 340, bottom: 502 };

  it('returns without swiping (or idle-waiting) when the target is visible on the first probe', async () => {
    const findElements = vi.fn(async () =>
      makeFindElementsResponse([makeElementInfo({ visible: true, bounds })]));
    const swipe = vi.fn(async () => successResponse());
    const waitForIdle = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe, waitForIdle });
    const handle = new ElementHandle(client, _text('Gesture Tester'), 5000);

    await handle.scrollIntoView();

    expect(findElements).toHaveBeenCalledTimes(1);
    expect(swipe).not.toHaveBeenCalled();
    expect(waitForIdle).not.toHaveBeenCalled();
  });

  it('confirms a first-tick miss (idle wait + re-probe) and skips the swipe when the target turns out visible', async () => {
    // Right after navigation the a11y tree can lag the rendered screen and
    // report a plainly-visible element as absent — without any error. The
    // old behavior swiped on that phantom miss, shifting the element under
    // the pinned app bar so the follow-up tap silently missed.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? makeFindElementsResponse([]) // lagging tree: valid response, element "absent"
        : makeFindElementsResponse([makeElementInfo({ visible: true, bounds })]);
    });
    const swipe = vi.fn(async () => successResponse());
    const waitForIdle = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe, waitForIdle });
    const handle = new ElementHandle(client, _text('Gesture Tester'), 5000);

    await handle.scrollIntoView();

    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(findElements).toHaveBeenCalledTimes(2);
    expect(swipe).not.toHaveBeenCalled();
  });

  it('still swipes when the confirmed first-tick miss persists (genuinely off-screen element)', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      // Probe + confirmation re-probe both miss → swipe; then visible.
      return calls < 3
        ? makeFindElementsResponse([])
        : makeFindElementsResponse([makeElementInfo({ visible: true, bounds })]);
    });
    const findElement = vi.fn(async () => ({
      requestId: '1', found: true, element: makeElementInfo({ visible: true, bounds }), errorMessage: '',
    }));
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, findElement, swipe });
    const handle = new ElementHandle(client, _text('Below The Fold'), 5000);

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
  });

  it('a failing idle wait does not block the scroll (best effort)', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 3
        ? makeFindElementsResponse([])
        : makeFindElementsResponse([makeElementInfo({ visible: true, bounds })]);
    });
    const findElement = vi.fn(async () => ({
      requestId: '1', found: true, element: makeElementInfo({ visible: true, bounds }), errorMessage: '',
    }));
    const swipe = vi.fn(async () => successResponse());
    const waitForIdle = vi.fn(async () => { throw new Error('waitForIdle unsupported'); });
    const client = makeMockClient({ findElements, findElement, swipe, waitForIdle });
    const handle = new ElementHandle(client, _text('Below The Fold'), 5000);

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
  });

  it('confirms the first affirmative miss even when an earlier tick was unreliable (review follow-up)', async () => {
    // Tick 0 is a transient agent timeout (no swipe, re-probe); tick 1 is the
    // FIRST affirmative miss. The idle-wait confirmation must still run — it
    // guards the first swipe, not literally iteration 0 — and here the
    // confirmation probe finds the target visible, so no swipe happens.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5.25s' };
      }
      if (calls === 2) return makeFindElementsResponse([]); // first affirmative miss
      return makeFindElementsResponse([makeElementInfo({ visible: true, bounds })]); // confirmation probe
    });
    const swipe = vi.fn(async () => successResponse());
    const waitForIdle = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe, waitForIdle });
    const handle = new ElementHandle(client, _text('Gesture Tester'), 5000);

    await handle.scrollIntoView();

    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(findElements).toHaveBeenCalledTimes(3);
    expect(swipe).not.toHaveBeenCalled();
  });

  it('does not swipe on a stale-snapshot tick (no position information)', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: 'snapshot is stale (UI changed) mid-query' }
        : makeFindElementsResponse([makeElementInfo({ visible: true, bounds })]);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Gesture Tester'), 5000);

    await handle.scrollIntoView();

    expect(swipe).not.toHaveBeenCalled();
  });

  it('unreliable ticks do not consume the swipe budget (review follow-up)', async () => {
    // maxScrolls: 1 with an unreliable first tick. If unreliable ticks ate
    // the budget, the single allowed swipe would never happen and the scroll
    // would fail; instead the miss that follows still gets its swipe.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5.25s' };
      }
      // calls 2-3: affirmative miss (probe + first-swipe confirmation probe)
      if (calls <= 3) return makeFindElementsResponse([]);
      return makeFindElementsResponse([makeElementInfo({ visible: true, bounds })]);
    });
    const findElement = vi.fn(async () => ({
      requestId: '1', found: true, element: makeElementInfo({ visible: true, bounds }), errorMessage: '',
    }));
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, findElement, swipe });
    const handle = new ElementHandle(client, _text('Below The Fold'), 5000);

    await handle.scrollIntoView({ maxScrolls: 1 });

    expect(swipe).toHaveBeenCalledTimes(1);
  });

  it('runs the pre-swipe miss confirmation at most once (review follow-up)', async () => {
    // miss → confirmation (unreliable) → miss again: the second miss must not
    // re-trigger the idle wait — one confirmation attempt per scrollIntoView.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      if (calls === 1) return makeFindElementsResponse([]); // first miss
      if (calls === 2) {
        // confirmation probe hits a transient timeout
        return { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5.25s' };
      }
      if (calls === 3) return makeFindElementsResponse([]); // miss again → swipe, no re-confirm
      return makeFindElementsResponse([makeElementInfo({ visible: true, bounds })]);
    });
    const findElement = vi.fn(async () => ({
      requestId: '1', found: true, element: makeElementInfo({ visible: true, bounds }), errorMessage: '',
    }));
    const swipe = vi.fn(async () => successResponse());
    const waitForIdle = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, findElement, swipe, waitForIdle });
    const handle = new ElementHandle(client, _text('Below The Fold'), 5000);

    await handle.scrollIntoView();

    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(swipe).toHaveBeenCalledTimes(1);
  });

  it('propagates a user stop from the idle wait instead of swallowing it (review follow-up)', async () => {
    // The confirmation idle wait is best-effort for infra errors, but a user
    // stop (PILOT-222) must abort scrollIntoView immediately — no further
    // probes or swipes.
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const swipe = vi.fn(async () => successResponse());
    const waitForIdle = vi.fn(async () => { throw new TestAbortedError(); });
    const client = makeMockClient({ findElements, swipe, waitForIdle });
    const handle = new ElementHandle(client, _text('Below The Fold'), 5000);

    await expect(handle.scrollIntoView()).rejects.toSatisfy(isAbortError);
    expect(findElements).toHaveBeenCalledTimes(1); // no post-abort confirmation probe
    expect(swipe).not.toHaveBeenCalled();
  });

  it('reports the number of swipes actually performed when giving up (review follow-up)', async () => {
    // Every tick is a stale snapshot: no swipe is ever performed, so the
    // error must say "0 scroll(s)", not claim the full maxScrolls budget ran.
    const findElements = vi.fn(async () => ({
      requestId: '1', elements: [], errorMessage: 'snapshot is stale (UI changed) mid-query',
    }));
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Ghost'), 5000);

    await expect(handle.scrollIntoView({ maxScrolls: 2 })).rejects.toThrow(/not visible after 0 scroll\(s\)/);
    expect(swipe).not.toHaveBeenCalled();
  });
});

describe("scrollIntoView honours the handle's modifiers (PILOT-345)", () => {
  const rowBounds = (top: number) => ({ left: 0, top, right: 400, bottom: top + 60 });
  const row = (id: string, text: string, visible: boolean, top: number) =>
    makeElementInfo({ elementId: id, text, visible, bounds: rowBounds(top) });

  it('filter({ hasText }) scrolls until THAT row is visible instead of judging the raw selector (ambiguous here)', async () => {
    // getByRole("listitem") alone matches every rendered row. Before the fix
    // the probe read that raw selector: two visible rows → a strict-mode
    // violation from scrollIntoView (or, with one raw match, "already
    // visible" and no swipe — the next test). The filter is applied first now.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      // Probe + first-swipe confirmation see only Apple and Banana; after the
      // swipe Zebra has scrolled on screen.
      const rows = [row('r1', 'Apple', true, 100), row('r2', 'Banana', true, 200)];
      if (calls >= 3) rows.push(row('r9', 'Zebra', true, 300));
      return makeFindElementsResponse(rows);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _role('listitem'), 5000).filter({ hasText: 'Zebra' });

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
  });

  it("swipes when the raw selector's only match is visible but the filter excludes it (the PILOT-345 scenario)", async () => {
    // The unfiltered probe saw Apple visible, concluded the target was already
    // on screen and never swiped; the follow-up tap then failed "not found"
    // with nothing in the error pointing at the scroll.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      const rows = [row('r1', 'Apple', true, 100)];
      if (calls >= 3) rows.push(row('r9', 'Zebra', true, 300));
      return makeFindElementsResponse(rows);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _role('listitem'), 5000).filter({ hasText: 'Zebra' });

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
  });

  it('a positional modifier after a filter (.filter().first()) indexes the FILTERED set', async () => {
    // Before the fix nth() was the one modifier the probe honoured — applied
    // to the raw matches, where index 0 was Apple (visible) → no swipe. It
    // must pick the first *Zebra* row.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      const rows = [row('r1', 'Apple', true, 100), row('r2', 'Banana', true, 200)];
      if (calls >= 3) rows.push(row('r9', 'Zebra 1', true, 300), row('r10', 'Zebra 2', true, 360));
      return makeFindElementsResponse(rows);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _role('listitem'), 5000).filter({ hasText: 'Zebra' }).first();

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
  });

  it('and() intersects the operands before judging visibility', async () => {
    // Two buttons on the left; the right operand narrows to the off-screen
    // one. Before the fix the raw left selector (two matches) was a strict
    // violation. Both operands are read on every probe tick.
    let calls = 0;
    const findElements = vi.fn(async (selector: Selector) => {
      calls++;
      const proto = selectorToProto(selector);
      const scrolled = calls > 4; // ticks 1-2 (probe, confirmation) miss; tick 3 sees it
      const ok = row('e2', 'OK', scrolled, scrolled ? 500 : 2000);
      if (proto.text === 'OK') return makeFindElementsResponse([ok]);
      return makeFindElementsResponse([row('e1', 'Cancel', true, 100), ok]);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const buttons = new ElementHandle(client, _role('button'), 5000);
    const okText = new ElementHandle(client, _text('OK'), 5000);

    await buttons.and(okText).scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
  });

  it('or() unites the operands before judging visibility — the right operand alone can satisfy the scroll', async () => {
    // The or-handle carries the LEFT operand's selector. Before the fix the
    // probe read that raw selector, so an element only the right operand
    // matches never counted: the scroll swiped to exhaustion and failed.
    let rightReads = 0;
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'Zèbre') {
        rightReads++;
        // Ticks 1-2 (probe, confirmation) miss; from tick 3 (post-swipe) the
        // right operand's element is on screen.
        return makeFindElementsResponse(rightReads >= 3 ? [row('z', 'Zèbre', true, 300)] : []);
      }
      return makeFindElementsResponse([]); // the left operand never matches
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const left = new ElementHandle(client, _text('Zebra'), 5000);
    const right = new ElementHandle(client, _text('Zèbre'), 5000);

    await left.or(right).scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
  });

  it('an or() union that reads one clipped element twice fails fast with a strict violation (documented limitation)', async () => {
    // Both operands match the same off-screen row. Clipped, it is reported at
    // 0,0,0,0 by both reads with no geometry to merge by, so the union holds
    // two entries. Strict mode refuses the ambiguity immediately — the
    // documented remedy is to scroll through one operand or a single selector.
    const ZERO = { left: 0, top: 0, right: 0, bottom: 0 };
    const findElements = vi.fn(async () =>
      makeFindElementsResponse([
        makeElementInfo({ elementId: `id-${Math.random()}`, text: 'Item 25', visible: false, bounds: ZERO }),
      ]));
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const byText = new ElementHandle(client, _text('Item 25'), 5000);
    const byDesc = new ElementHandle(client, _contentDesc('Item 25'), 5000);

    await expect(byText.or(byDesc).scrollIntoView()).rejects.toThrow(/resolved to 2 elements/);
    expect(swipe).not.toHaveBeenCalled();
  });

  it('a strict violation with a VISIBLE candidate still fails scrollIntoView immediately (real ambiguity)', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([
      row('a', 'Delete', true, 100),
      row('b', 'Delete', true, 200),
    ]));
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    await expect(new ElementHandle(client, _text('Delete'), 5000).scrollIntoView()).rejects.toThrow(/resolved to 2 elements/);
    expect(swipe).not.toHaveBeenCalled();
  });

  it('an ambiguous locator fails fast even when every match is off-screen — no scroll budget is spent', async () => {
    const ZERO = { left: 0, top: 0, right: 0, bottom: 0 };
    const findElements = vi.fn(async () => makeFindElementsResponse([
      makeElementInfo({ elementId: `a-${Math.random()}`, text: 'Delete row 1', visible: false, bounds: ZERO }),
      makeElementInfo({ elementId: `b-${Math.random()}`, text: 'Delete row 2', visible: false, bounds: ZERO }),
    ]));
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    await expect(
      new ElementHandle(client, _textContains('Delete'), 5000).scrollIntoView({ maxScrolls: 1 }),
    ).rejects.toThrow(/resolved to 2 elements/);
    expect(swipe).not.toHaveBeenCalled();
  });

  it('a scoped child (parent.first().getByText) is judged within its parent, not against a same-text element elsewhere', async () => {
    // Two lists on screen. The target text exists, visible, in the SECOND
    // list; the first list's copy is off-screen until one swipe. Before the
    // fix the probe read the raw child selector, saw the other list's copy
    // visible and never swiped.
    const lists = [
      makeElementInfo({ elementId: 'list1', bounds: { left: 0, top: 500, right: 400, bottom: 1200 } }),
      makeElementInfo({ elementId: 'list2', bounds: { left: 0, top: 1300, right: 400, bottom: 2000 } }),
    ];
    let childReads = 0;
    const findElements = vi.fn(async (selector: Selector) => {
      const desc = formatSelector(selector);
      if (desc.includes('getByText')) {
        childReads++;
        const children = [row('z-other', 'Zebra', true, 1500)]; // inside list2, visible
        if (childReads >= 3) children.push(row('z-in', 'Zebra', true, 700)); // inside list1, after the swipe
        return makeFindElementsResponse(children);
      }
      return makeFindElementsResponse(lists);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const child = new ElementHandle(client, _testId('list'), 5000).first().getByText('Zebra');

    await child.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
  });

  it('probes with the poll-tick budget, not the handle timeout', async () => {
    // A filtered handle with a 30s timeout re-times the whole chain to one
    // poll interval per read, so a wedged agent cannot hold a probe for the
    // timeout plus headroom — the same rule the waiting loops and isVisible()
    // follow.
    const findElements = vi.fn(async () => makeFindElementsResponse([row('r9', 'Zebra', true, 300)]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _role('listitem'), 30_000).filter({ hasText: 'Zebra' });

    await handle.scrollIntoView();

    expect(findElements).toHaveBeenCalledTimes(1);
    expect(findElements).toHaveBeenCalledWith(handle._selector, 250);
  });

  it('the post-swipe stabilization reads the modified handle too — never the raw selector', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      const rows = [row('r1', 'Apple', true, 100)];
      if (calls >= 3) rows.push(row('r9', 'Zebra', true, 300));
      return makeFindElementsResponse(rows);
    });
    const findElement = vi.fn(async () => ({
      requestId: '1', found: true, element: makeElementInfo({ visible: true }), errorMessage: '',
    }));
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, findElement, swipe });
    const handle = new ElementHandle(client, _role('listitem'), 5000).filter({ hasText: 'Zebra' });

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
    expect(findElement).not.toHaveBeenCalled();
    // probe, confirmation, post-swipe probe, then two stabilization reads that
    // both match the probe's position → settled
    expect(findElements).toHaveBeenCalledTimes(5);
  });

  it('a stale snapshot on a modified handle is an unreliable tick — re-probed, never swiped on', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      if (calls === 1) return { requestId: '1', elements: [], errorMessage: 'snapshot is stale (UI changed) mid-query' };
      return makeFindElementsResponse([row('r9', 'Zebra', true, 300)]);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _role('listitem'), 5000).filter({ hasText: 'Zebra' });

    await handle.scrollIntoView();

    expect(calls).toBe(2);
    expect(swipe).not.toHaveBeenCalled();
  });

  it('a handle from all() reads live before every probe, so a row that was off-screen at all() still scrolls into view (review follow-up)', async () => {
    // rows[i] is a live nth(i) locator: a scroll exists to watch the screen
    // change, and every probe reads the device rather than what all() saw.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      // Call 1: all()'s read, Zebra rendered off-screen. Calls 2-3: the
      // probe's and the confirmation's reads, unchanged → swipe. From call 4
      // (post-swipe probe, then stabilization) Zebra is on screen.
      const onScreen = calls >= 4;
      return makeFindElementsResponse([
        row('r0', 'Apple', true, 100),
        row('r1', 'Banana', true, 200),
        row('r2', 'Zebra', onScreen, onScreen ? 300 : 2000),
      ]);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const rows = await new ElementHandle(client, _role('listitem'), 5000).all();

    await rows[2].scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
    expect(findElements.mock.calls.length).toBeGreaterThanOrEqual(4);
    // A reader after the scroll addresses the row where it is NOW.
    expect((await rows[2].boundingBox())?.y).toBe(300);
  });

  it('a handle from all() whose row has scrolled away since all() swipes instead of reporting it visible (review follow-up)', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      // Visible at all() (call 1); gone off-screen by the time of the scroll
      // (calls 2-3); back after one swipe (call 4 onwards).
      const onScreen = calls === 1 || calls >= 4;
      return makeFindElementsResponse([
        row('r0', 'Apple', true, 100),
        row('r2', 'Zebra', onScreen, onScreen ? 300 : -500),
      ]);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const rows = await new ElementHandle(client, _role('listitem'), 5000).all();

    await rows[1].scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
  });

  it('an ambiguous stabilization read is waited out — it neither fails a scroll whose target is already visible nor swipes again (review follow-up)', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      if (calls < 3) return makeFindElementsResponse([]); // probe + confirmation miss → swipe
      if (calls === 3) return makeFindElementsResponse([row('r9', 'Zebra', true, 300)]); // visible
      // Every stabilization tick: a second same-text row is passing through.
      return makeFindElementsResponse([row('r9', 'Zebra', true, 300), row('r10', 'Zebra', true, 900)]);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Zebra'), 5000);

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
    // 3 pre-visible reads + all 10 stabilization ticks (never a clean reading).
    expect(findElements).toHaveBeenCalledTimes(13);
  });

  it('a one-tick miss during post-swipe stabilization is waited out, not taken as "settled" (review follow-up)', async () => {
    // The old stabilization read let the agent wait 500ms for the element; the
    // single-shot read must not turn a cell flickering out of the tree
    // mid-deceleration into an early return that hands a moving list to the
    // next tap.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      if (calls < 3) return makeFindElementsResponse([]); // probe + confirmation miss → swipe
      if (calls === 4) return makeFindElementsResponse([]); // stabilization tick 1: flicker
      return makeFindElementsResponse([row('r9', 'Zebra', true, 300)]); // visible, then stable
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Zebra'), 5000);

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
    // probe, confirmation, post-swipe probe, flicker tick, then a tick that
    // re-establishes the position and two more that hold it → settled.
    expect(findElements).toHaveBeenCalledTimes(7);
  });

  it('one matching position read is not "settled" — the position must hold for two consecutive ticks (review follow-up)', async () => {
    // A stalled frame or a velocity null mid-deceleration can make two raw
    // reads 100ms apart agree; the replaced Android read settled agent-side
    // before answering, so a lone match must not end stabilization.
    let calls = 0;
    const tops = [300, 300, 220, 160, 160, 160]; // stall, then motion resumes, then still
    const findElements = vi.fn(async () => {
      calls++;
      if (calls < 3) return makeFindElementsResponse([]); // probe + confirmation miss → swipe
      return makeFindElementsResponse([row('r9', 'Zebra', true, tops[Math.min(calls - 3, tops.length - 1)])]);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Zebra'), 5000);

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
    // post-swipe probe (300), tick 300 (1 stable), 220 (reset), 160, 160 (1), 160 (2) → settled
    expect(findElements).toHaveBeenCalledTimes(8);
  });

  it('an unreadable tick restarts the settle count — two matching reads around a gap are not stillness (review follow-up)', async () => {
    let calls = 0;
    // post-swipe probe 300; then 300 (1 stable), miss (restart), 300 (1), 300 (2) → settled
    const reads: Array<number | null> = [300, 300, null, 300, 300];
    const findElements = vi.fn(async () => {
      calls++;
      if (calls < 3) return makeFindElementsResponse([]); // probe + confirmation miss → swipe
      const r = reads[Math.min(calls - 3, reads.length - 1)];
      return makeFindElementsResponse(r === null ? [] : [row('r9', 'Zebra', true, r)]);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Zebra'), 5000);

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
    // 2 misses + probe + 5 stabilization reads: 300 (1), gap, 300 (re-established), 300 (1), 300 (2)
    expect(findElements).toHaveBeenCalledTimes(8);
  });

  it('an ambiguous stabilization tick restarts the settle count like any other unreadable tick (review follow-up)', async () => {
    let calls = 0;
    // post-swipe probe 300; then 300 (1), two matches (restart), 300 (1), 300 (2) → settled
    const reads: Array<number | 'ambiguous'> = [300, 300, 'ambiguous', 300, 300];
    const findElements = vi.fn(async () => {
      calls++;
      if (calls < 3) return makeFindElementsResponse([]); // probe + confirmation miss → swipe
      const r = reads[Math.min(calls - 3, reads.length - 1)];
      return makeFindElementsResponse(
        r === 'ambiguous'
          ? [row('r9', 'Zebra', true, 300), row('r10', 'Zebra', true, 900)]
          : [row('r9', 'Zebra', true, r)],
      );
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Zebra'), 5000);

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
    // 2 misses + probe + 5 stabilization reads: 300 (1), ambiguous, 300 (re-established), 300 (1), 300 (2)
    expect(findElements).toHaveBeenCalledTimes(8);
  });

  it('bounds missing for one tick after the probe saw them are a gap, not "no position to settle" (review follow-up)', async () => {
    let calls = 0;
    // post-swipe probe 300; then no bounds (restart), 300 (1), 300 (2) → settled
    const reads: Array<number | null> = [300, null, 300, 300];
    const findElements = vi.fn(async () => {
      calls++;
      if (calls < 3) return makeFindElementsResponse([]); // probe + confirmation miss → swipe
      const r = reads[Math.min(calls - 3, reads.length - 1)];
      return makeFindElementsResponse([
        r === null
          ? makeElementInfo({ elementId: 'r9', text: 'Zebra', visible: true, bounds: undefined })
          : row('r9', 'Zebra', true, r),
      ]);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Zebra'), 5000);

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
    // 2 misses + probe + 4 stabilization reads: no bounds, 300 (re-established), 300 (1), 300 (2)
    expect(findElements).toHaveBeenCalledTimes(7);
  });

  it('DOCUMENTED CONTRACT: rows[i].scrollIntoView() on a list whose window shifts stops on whatever is at index i, because rows[i] IS .nth(i) (PILOT-346)', async () => {
    // A virtualised list renders a moving window. all() saw [A, B, C]; after
    // one swipe the rendered window is [B, C, D]. rows[2] is the live nth(2)
    // locator, so it now denotes D — the api-reference all() section says so
    // and tells users to name the row instead. Pinned so the behaviour is
    // explicit, not because it is desirable.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      const before = [row('a', 'A', true, 100), row('b', 'B', true, 200), row('c', 'C', false, 900)];
      const after = [row('b', 'B', true, 100), row('c', 'C', true, 200), row('d', 'D', true, 300)];
      return makeFindElementsResponse(calls >= 4 ? after : before);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const rows = await new ElementHandle(client, _role('listitem'), 5000).all();

    await rows[2].scrollIntoView(); // C is captured off-screen → one swipe

    expect(swipe).toHaveBeenCalledTimes(1);
    // Index 2 of the scrolled window is D: the scroll stopped on it and the
    // handle describes it.
    expect((await rows[2].find()).elementId).toBe('d');
    expect((await rows[2].boundingBox())?.y).toBe(300);
  });

  it('an element without bounds ends stabilization after one read — there is no position to settle (review follow-up)', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      if (calls < 3) return makeFindElementsResponse([]); // probe + confirmation miss → swipe
      return makeFindElementsResponse([makeElementInfo({ elementId: 'nb', text: 'Zebra', visible: true, bounds: undefined })]);
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Zebra'), 5000);

    await handle.scrollIntoView();

    expect(swipe).toHaveBeenCalledTimes(1);
    expect(findElements).toHaveBeenCalledTimes(4); // probe, confirmation, post-swipe probe, one stabilization read
  });

  it('a user stop raised by the all() re-capture inside the scroll probe propagates (review follow-up)', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      if (calls === 1) return makeFindElementsResponse([row('r0', 'Apple', true, 100), row('r2', 'Zebra', false, 2000)]);
      throw new TestAbortedError(); // the first re-capture: the user stopped the run
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const rows = await new ElementHandle(client, _role('listitem'), 5000).all();

    await expect(rows[1].scrollIntoView()).rejects.toSatisfy(isAbortError);
    expect(swipe).not.toHaveBeenCalled();
    expect(findElements).toHaveBeenCalledTimes(2);
  });

  it('scrollIntoView() on an all() row that is already visible re-reads once and does not swipe (review follow-up)', async () => {
    // The zero-swipe path still refreshes the capture: the handle then
    // describes the row as it is now, not as it was captured.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      // Captured at y=300 (call 1); a banner has since nudged the list to y=340.
      return makeFindElementsResponse([row('r0', 'Apple', true, 100), row('r2', 'Zebra', true, calls === 1 ? 300 : 340)]);
    });
    const swipe = vi.fn(async () => successResponse());
    const waitForIdle = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe, waitForIdle });
    const rows = await new ElementHandle(client, _role('listitem'), 5000).all();

    await rows[1].scrollIntoView();

    expect(swipe).not.toHaveBeenCalled();
    expect(waitForIdle).not.toHaveBeenCalled();
    expect(findElements).toHaveBeenCalledTimes(2); // the capture, then one live probe
    expect((await rows[1].boundingBox())?.y).toBe(340);
  });

  it('a user stop during post-swipe stabilization propagates instead of being waited out (review follow-up)', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      if (calls < 3) return makeFindElementsResponse([]); // probe + confirmation miss → swipe
      if (calls === 3) return makeFindElementsResponse([row('r9', 'Zebra', true, 300)]); // visible
      throw new TestAbortedError(); // stabilization tick: the user stopped the run
    });
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Zebra'), 5000);

    await expect(handle.scrollIntoView()).rejects.toSatisfy(isAbortError);
    expect(swipe).toHaveBeenCalledTimes(1);
    expect(findElements).toHaveBeenCalledTimes(4); // nothing after the abort
  });

  it('an all() handle whose one refresh timed out still reports "not found" once the agent recovers (review follow-up)', async () => {
    // tap() on a captured-but-disabled row: the first re-capture times out at
    // the agent, every later one answers cleanly with a shorter list. The
    // deadline error must be the genuine positional miss — not the long-cleared
    // timeout, which would also trip session-level recovery.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return makeFindElementsResponse([
          row('r0', 'A', true, 100), row('r1', 'B', true, 200), row('r2', 'C', true, 300),
          row('r3', 'D', true, 400), { ...row('r4', 'E', true, 500), enabled: false },
        ]);
      }
      if (calls === 2) return { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5.25s' };
      return makeFindElementsResponse([row('r0', 'A', true, 100), row('r1', 'B', true, 200), row('r2', 'C', true, 300)]);
    });
    const client = makeMockClient({ findElements });
    const rows = await new ElementHandle(client, _role('listitem'), 800).all();

    await expect(rows[4].tap()).rejects.toThrow(/was not found after waiting 800ms \(nth\(4\): expected at least 5 element\(s\), but found 3\)/);
  });

  it('an ambiguous filtered handle is still a strict-mode violation', async () => {
    const findElements = vi.fn(async () =>
      makeFindElementsResponse([row('r9', 'Zebra 1', true, 300), row('r10', 'Zebra 2', true, 360)]));
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _role('listitem'), 5000).filter({ hasText: 'Zebra' });

    await expect(handle.scrollIntoView()).rejects.toBeInstanceOf(StrictModeViolationError);
    expect(swipe).not.toHaveBeenCalled();
  });
});

// ─── Action trace lifecycle (PILOT-244) ───

describe('action trace lifecycle (PILOT-244)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  interface TraceHarness {
    collector: TraceCollector;
    traceCapture: TraceCapture;
    lifecycle: { event: AnyTraceEvent; lifecycle?: 'started' | 'completed' }[];
  }

  function makeTraceHarness(): TraceHarness {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-eh-trace-'));
    tempDirs.push(tempDir);
    const collector = new TraceCollector({
      mode: 'on', screenshots: false, snapshots: false, sources: false,
      attachments: true, network: false, deviceLogs: false, daemonLogs: false,
    }, tempDir);
    const lifecycle: TraceHarness['lifecycle'] = [];
    collector.setEventCallback((event, _screenshots, life) => {
      lifecycle.push({ event, lifecycle: life });
    });
    const traceCapture: TraceCapture = {
      collector,
      takeScreenshot: async () => undefined,
      captureHierarchy: async () => undefined,
    };
    return { collector, traceCapture, lifecycle };
  }

  const actionEvents = (h: TraceHarness): ActionTraceEvent[] =>
    h.collector.events.filter((e): e is ActionTraceEvent => e.type === 'action');

  it('records a visibility probe under its own name with the resolved state, not as a failed find (PILOT-287)', async () => {
    const h = makeTraceHarness();
    const client = makeMockClient({ findElements: vi.fn(async () => makeFindElementsResponse([])) });
    const handle = new ElementHandle(client, _text('Absent'), 20_000, { traceCapture: h.traceCapture });

    expect(await handle.isVisible()).toBe(false);

    const actions = actionEvents(h);
    expect(actions.map((a) => [a.action, a.success, a.log])).toEqual([['isVisible', true, ['Visible: false']]]);
    expect(h.lifecycle.filter((e) => e.lifecycle === 'started').map((e) => (e.event as ActionTraceEvent).action))
      .toEqual(['isVisible']);
  });

  it('emits a started lifecycle event before the auto-wait resolves (live in-flight)', async () => {
    const h = makeTraceHarness();
    // findElements stays pending until released, so the action is mid auto-wait.
    let releaseFind!: (v: FindElementsResponse) => void;
    const findElements = vi.fn(
      () => new Promise<FindElementsResponse>((res) => { releaseFind = res; }),
    );
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Later'), 5000, { traceCapture: h.traceCapture });

    const tapPromise = handle.tap();
    await Promise.resolve(); // let the up-front _emitActionStarted flush

    const started = h.lifecycle.filter((e) => e.lifecycle === 'started');
    expect(started).toHaveLength(1);
    expect((started[0].event as ActionTraceEvent).category).toBe('tap');
    // Still in-flight: no completed event while the auto-wait is pending.
    expect(h.lifecycle.some((e) => e.lifecycle === 'completed')).toBe(false);

    releaseFind(makeFindElementsResponse([makeElementInfo()]));
    await tapPromise;
    expect(actionEvents(h).map((e) => e.action)).toEqual(['tap']);
  });

  it('records a failed action event when element resolution times out', async () => {
    const h = makeTraceHarness();
    const findElements = vi.fn(async () => makeFindElementsResponse([])); // never found
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Missing'), 300, { traceCapture: h.traceCapture });

    await expect(handle.tap()).rejects.toThrow(/was not found after waiting/);
    expect(tap).not.toHaveBeenCalled();

    const events = actionEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe('tap');
    expect(events[0].success).toBe(false);
    expect(events[0].error).toMatch(/was not found after waiting/);
    // The matching started fired too, so the live in-flight slot is cleared.
    expect(h.lifecycle.filter((e) => e.lifecycle === 'started')).toHaveLength(1);
    expect(h.lifecycle.filter((e) => e.lifecycle === 'completed')).toHaveLength(1);
  });

  it('attributes trailing time to the failed action, not the previous (beforeAll) action', async () => {
    const h = makeTraceHarness();
    // Simulate a prior completed action — e.g. a beforeAll route() registration.
    h.collector.addActionEvent({
      category: 'other', action: 'route',
      duration: 5, success: true,
      hasScreenshotBefore: false, hasScreenshotAfter: false,
      hasHierarchyBefore: false, hasHierarchyAfter: false,
    });
    const routeEvent = actionEvents(h).find((e) => e.action === 'route')!;
    const routeWallBefore = routeEvent.wallDuration;

    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Missing'), 200, { traceCapture: h.traceCapture });
    await expect(handle.tap()).rejects.toThrow(/was not found after waiting/);

    // Test ends ~30s after the failed tap — this is what finalizeTimeline allocates.
    h.collector.finalizeTimeline(Date.now() + 30_000);

    const tapEvent = actionEvents(h).find((e) => e.action === 'tap')!;
    expect(tapEvent.trailingTime ?? 0).toBeGreaterThan(0);
    // The beforeAll route must NOT have absorbed the trailing time.
    expect(routeEvent.trailingTime ?? 0).toBe(0);
    expect(routeEvent.wallDuration).toBe(routeWallBefore);
  });

  it('traces previously-untraced actions (focus) with started + completed on success', async () => {
    const h = makeTraceHarness();
    const focus = vi.fn(async () => successResponse());
    const client = makeMockClient({ focus });
    const handle = new ElementHandle(client, _text('Field'), 5000, { traceCapture: h.traceCapture });

    await handle.focus();

    const events = actionEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('focus');
    expect(events[0].success).toBe(true);
    expect(h.lifecycle.filter((e) => e.lifecycle === 'started').length).toBeGreaterThanOrEqual(1);
  });

  it('dragTo attributes a target-not-found to the dragTo action', async () => {
    const h = makeTraceHarness();
    const findElements = vi.fn(async (sel: Selector) => {
      const value = (sel.kind as { value?: string }).value;
      return makeFindElementsResponse(value === 'Target' ? [] : [makeElementInfo()]);
    });
    const client = makeMockClient({ findElements });
    const source = new ElementHandle(client, _text('Source'), 300, { traceCapture: h.traceCapture });
    const target = new ElementHandle(client, _text('Target'), 300, { traceCapture: h.traceCapture });

    await expect(source.dragTo(target)).rejects.toThrow(/was not found after waiting/);

    const events = actionEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('dragTo');
    expect(events[0].success).toBe(false);
  });

  it('setChecked: already-in-desired-state emits one success event without tapping', async () => {
    const h = makeTraceHarness();
    const tap = vi.fn(async () => successResponse());
    const el = makeElementInfo({ checked: true, text: 'Switch' });
    const client = makeMockClient({
      findElement: vi.fn(async () => ({ requestId: '1', found: true, element: el, errorMessage: '' })),
      findElements: vi.fn(async () => makeFindElementsResponse([el])),
      tap,
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000, { traceCapture: h.traceCapture });

    await handle.setChecked(true);

    expect(tap).not.toHaveBeenCalled();
    const events = actionEvents(h).filter((e) => e.action === 'setChecked');
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(true);
  });

  it('setChecked: state never changes → single failed event after tapping', async () => {
    const h = makeTraceHarness();
    const tap = vi.fn(async () => successResponse());
    const el = makeElementInfo({ checked: false, text: 'Switch' });
    const client = makeMockClient({
      findElement: vi.fn(async () => ({ requestId: '1', found: true, element: el, errorMessage: '' })),
      findElements: vi.fn(async () => makeFindElementsResponse([el])),
      tap,
    });
    const handle = new ElementHandle(client, _text('Switch'), 600, { traceCapture: h.traceCapture });

    await expect(handle.setChecked(true)).rejects.toThrow(/did not change after tap/);

    expect(tap).toHaveBeenCalledTimes(1);
    const events = actionEvents(h).filter((e) => e.action === 'setChecked');
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(false);
  }, 10000);

  it('still records the failed action when the before-capture throws', async () => {
    const h = makeTraceHarness();
    // Simulate an unresponsive device: the failure-path capture rejects. The
    // failed action must still be recorded (the capture is guarded separately).
    vi.spyOn(h.collector, 'captureBeforeAction').mockRejectedValue(new Error('capture boom'));
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Missing'), 200, { traceCapture: h.traceCapture });

    await expect(handle.tap()).rejects.toThrow(/was not found after waiting/);

    const events = actionEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('tap');
    expect(events[0].success).toBe(false);
    expect(events[0].hasScreenshotBefore).toBe(false);
  });

  it('adds no trace overhead and still throws when no trace capture is attached', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Missing'), 200); // no traceCapture
    await expect(handle.tap()).rejects.toThrow(/was not found after waiting/);
  });
});
