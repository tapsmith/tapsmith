import { describe, it, expect, vi } from 'vitest';
import { ElementHandle } from '../element-handle.js';
import { _text, _role } from '../selectors.js';
import type { TapsmithGrpcClient, ElementInfo, ActionResponse } from '../grpc-client.js';

// PILOT-716: tap-family actions do not scroll (unlike a Playwright click, by
// design, for cross-platform consistency). An element found but entirely
// off-screen (iOS) is waited on for the action's timeout and then reported as
// off-screen; one never found (Android lists on-screen rows only) fails as not
// found. Both point at scrollIntoView().

function ok(): ActionResponse {
  return { requestId: '1', success: true, errorType: '', errorMessage: '', screenshot: Buffer.alloc(0) };
}

function row(overrides: Partial<ElementInfo>): ElementInfo {
  return {
    elementId: 'el-1', className: 'XCUIElementTypeButton', text: 'Item 1', contentDescription: '',
    resourceId: '', enabled: true, visible: true, clickable: true, focusable: true, scrollable: false,
    hint: '', checked: false, selected: false, focused: false, role: 'button', viewportRatio: 1,
    ...overrides,
  };
}

const below = { left: 0, top: 1500, right: 390, bottom: 1550 };
const above = { left: 0, top: -400, right: 390, bottom: -350 };
const leftOf = { left: -600, top: 300, right: -210, bottom: 350 };
const rightOf = { left: 800, top: 300, right: 1190, bottom: 350 };
const onScreen = { left: 0, top: 300, right: 390, bottom: 350 };

/** A client whose reads return `reads()`; no swipe or scroll RPC exists, so any attempt would throw. */
function client(reads: () => ElementInfo[]) {
  const findElements = vi.fn(async () => ({ requestId: '1', elements: reads(), errorMessage: '' }));
  const tap = vi.fn(async () => ok());
  const doubleTap = vi.fn(async () => ok());
  const longPress = vi.fn(async () => ok());
  return { findElements, tap, doubleTap, longPress, c: { findElements, tap, doubleTap, longPress } as unknown as TapsmithGrpcClient };
}

async function rejectionOf(advanceMs: number, fn: () => Promise<unknown>): Promise<Error & { elapsedMs: number }> {
  vi.useFakeTimers();
  try {
    const start = Date.now();
    let elapsedMs = -1;
    const outcome = fn().then(
      () => ({ ok: true as const }),
      (error: unknown) => {
        elapsedMs = Date.now() - start;
        return { ok: false as const, error };
      },
    );
    await vi.advanceTimersByTimeAsync(advanceMs);
    const result = await outcome;
    if (result.ok) throw new Error('expected a rejection');
    return Object.assign(result.error as Error, { elapsedMs });
  } finally {
    vi.useRealTimers();
  }
}

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

describe('tap() on an element found but off-screen (iOS) (PILOT-716)', () => {
  it('waits out the action timeout instead of refusing at once, then says it is off-screen and how to scroll to it', async () => {
    const m = client(() => [row({ visible: false, viewportRatio: 0, bounds: below })]);
    const err = await rejectionOf(30_000, () => new ElementHandle(m.c, _text('Item 1'), 5000).tap());
    expect(err.elapsedMs).toBeGreaterThanOrEqual(5000);
    expect(m.findElements.mock.calls.length).toBeGreaterThan(5);
    expect(m.tap).not.toHaveBeenCalled();
    expect(err.message).toBe(
      'Element getByText("Item 1", { exact: true }) is off-screen: it was found, but no part of it was on screen after waiting 5000ms. ' +
        'tap() does not scroll, so scroll it into view first with await locator.scrollIntoView() ' +
        '(or scroll("right") on the horizontal list that holds it, if it is off to the side), then tap() it.',
    );
  });

  it.each([
    ['above the screen', above, 'await locator.scrollIntoView({ direction: "down" })'],
    ['left of the screen', leftOf, 'scroll("left") on the horizontal list that holds it'],
    ['right of the screen (below and right look alike without the screen width)', rightOf,
      'await locator.scrollIntoView() (or scroll("right") on the horizontal list that holds it, if it is off to the side)'],
  ])('names the direction scrollIntoView() needs for an element %s', async (_where, bounds, how) => {
    const m = client(() => [row({ visible: false, viewportRatio: 0, bounds })]);
    const err = await rejectionOf(30_000, () => new ElementHandle(m.c, _text('Item 1'), 2000).tap());
    expect(err.message).toContain(`scroll it into view first with ${how}, then tap() it.`);
  });

  it('taps the element once it comes on screen within the timeout (scrolled by the test or animating in)', async () => {
    let reads = 0;
    const m = client(() => [reads++ < 4
      ? row({ visible: false, viewportRatio: 0, bounds: below })
      : row({ visible: true, bounds: onScreen })]);
    await withFakeClock(30_000, () => new ElementHandle(m.c, _text('Item 1'), 5000).tap());
    expect(m.tap).toHaveBeenCalledTimes(1);
  });

  it('names the action in the advice, for doubleTap() and longPress() too', async () => {
    for (const act of ['doubleTap', 'longPress'] as const) {
      const m = client(() => [row({ visible: false, viewportRatio: 0, bounds: below })]);
      const err = await rejectionOf(30_000, () => new ElementHandle(m.c, _text('Item 1'), 1000)[act]());
      expect(err.message).toContain(`${act}() does not scroll, so scroll it into view first with await locator.scrollIntoView() `);
      expect(err.message).toMatch(new RegExp(`then ${act}\\(\\) it\\.$`));
      expect(m[act]).not.toHaveBeenCalled();
    }
  });

  it('setChecked() waits for an off-screen switch it has to tap, but not for one already in the requested state', async () => {
    const needs = client(() => [row({ visible: false, viewportRatio: 0, bounds: below, checked: false })]);
    const err = await rejectionOf(30_000, () => new ElementHandle(needs.c, _text('Item 1'), 1000).setChecked(true));
    expect(err.message).toMatch(/is off-screen: .*setChecked\(\) does not scroll/);
    expect(needs.tap).not.toHaveBeenCalled();

    const already = client(() => [row({ visible: false, viewportRatio: 0, bounds: below, checked: true })]);
    await withFakeClock(30_000, () => new ElementHandle(already.c, _text('Item 1'), 1000).setChecked(true));
    expect(already.tap).not.toHaveBeenCalled();
  });

  it('waits the same for a modified handle (first()/nth()/filter()) resolving to an off-screen element', async () => {
    const m = client(() => [row({ visible: false, viewportRatio: 0, bounds: below })]);
    const err = await rejectionOf(30_000, () => new ElementHandle(m.c, _role('button'), 2000).first().tap());
    expect(err.message).toMatch(/is off-screen: it was found, but no part of it was on screen after waiting 2000ms/);
    expect(m.tap).not.toHaveBeenCalled();
  });

  it('reports an element seen off-screen and then gone as not found, not off-screen', async () => {
    let reads = 0;
    const m = client(() => (reads++ < 3 ? [row({ visible: false, viewportRatio: 0, bounds: below })] : []));
    const err = await rejectionOf(30_000, () => new ElementHandle(m.c, _text('Item 1'), 2000).tap());
    expect(err.message).toMatch(/was not found after waiting 2000ms\. It may be off-screen/);
  });

  it('reports an element both disabled and off-screen as disabled', async () => {
    const m = client(() => [row({ visible: false, viewportRatio: 0, bounds: below, enabled: false })]);
    const err = await rejectionOf(30_000, () => new ElementHandle(m.c, _text('Item 1'), 2000).tap());
    expect(err.message).toMatch(/is disabled after waiting 2000ms$/);
  });

  it('with timeout 0 (no auto-wait), hands an off-screen element straight to the action, as before', async () => {
    const m = client(() => [row({ visible: false, viewportRatio: 0, bounds: below })]);
    await new ElementHandle(m.c, _text('Item 1'), 0).tap();
    expect(m.tap).toHaveBeenCalledTimes(1);
  });

  it('reports an agent fault at the deadline rather than the off-screen element', async () => {
    let reads = 0;
    const m = client(() => [row({ visible: false, viewportRatio: 0, bounds: below })]);
    m.findElements.mockImplementation(async () => (reads++ < 2
      ? { requestId: '1', elements: [row({ visible: false, viewportRatio: 0, bounds: below })], errorMessage: '' }
      : { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5000ms' }));
    const err = await rejectionOf(30_000, () => new ElementHandle(m.c, _text('Item 1'), 2000).tap());
    expect(err.message).toMatch(/Agent command timed out/);
  });

  it('still hands an element invisible for another reason (zero-size frame, no bounds) to the action, as before', async () => {
    for (const el of [
      row({ visible: false, viewportRatio: 0, bounds: { left: 10, top: 300, right: 10, bottom: 340 } }),
      row({ visible: false, viewportRatio: 0, bounds: undefined }),
    ]) {
      const m = client(() => [el]);
      await new ElementHandle(m.c, _text('Item 1'), 5000).tap();
      expect(m.tap).toHaveBeenCalledTimes(1);
    }
  });
});

describe('tap() on an element the iOS agent refuses as not hittable (clipped by its list) (PILOT-716)', () => {
  const refusal = (): ActionResponse => ({
    requestId: '1', success: false, errorType: 'ACTION_FAILED',
    errorMessage: 'Element is not hittable (may be off-screen or hidden)', screenshot: Buffer.alloc(0),
  });

  it('retries the refusal until the timeout, then gives the same scrollIntoView() advice', async () => {
    const m = client(() => [row({ bounds: onScreen })]);
    m.tap.mockImplementation(async () => refusal());
    const err = await rejectionOf(30_000, () => new ElementHandle(m.c, _text('Item 1'), 3000).tap());
    expect(m.tap.mock.calls.length).toBeGreaterThan(3);
    expect(err.elapsedMs).toBeGreaterThanOrEqual(3000);
    expect(err.message).toBe(
      'Element getByText("Item 1", { exact: true }) is not hittable after waiting 3000ms: it may be off-screen, ' +
        'or clipped by its list (for example behind a header). tap() does not scroll, so scroll it into view first with ' +
        'await locator.scrollIntoView() (scrollIntoView({ direction: "down" }) for one above the screen), then tap() it.',
    );
  });

  it('taps once the element becomes hittable within the timeout', async () => {
    const m = client(() => [row({ bounds: onScreen })]);
    let calls = 0;
    m.tap.mockImplementation(async () => (++calls < 3 ? refusal() : ok()));
    await withFakeClock(30_000, () => new ElementHandle(m.c, _text('Item 1'), 3000).tap());
    expect(m.tap).toHaveBeenCalledTimes(3);
  });

  it('does not retry any other failure (a covered element is waited out by the agent itself)', async () => {
    const m = client(() => [row({ bounds: onScreen })]);
    m.tap.mockImplementation(async () => ({ ...refusal(), errorType: 'ELEMENT_COVERED', errorMessage: 'Element is covered by the keyboard' }));
    const err = await rejectionOf(30_000, () => new ElementHandle(m.c, _text('Item 1'), 3000).tap());
    expect(m.tap).toHaveBeenCalledTimes(1);
    expect(err.message).toBe('Element is covered by the keyboard');
  });
});

describe('tap() on an element never found (Android lists on-screen rows only) (PILOT-716)', () => {
  it('fails as not found with the same scrollIntoView() advice, hedged', async () => {
    const m = client(() => []);
    const err = await rejectionOf(30_000, () => new ElementHandle(m.c, _text('Item 1'), 2000).tap());
    expect(err.message).toBe(
      'Element getByText("Item 1", { exact: true }) was not found after waiting 2000ms. ' +
        'It may be off-screen in a scrollable list: tap() does not scroll, so scroll it into view first with ' +
        'await locator.scrollIntoView() (scrollIntoView({ direction: "down" }) for one above the screen), then tap() it.',
    );
  });

  it('names the action that failed', async () => {
    const m = client(() => []);
    const err = await rejectionOf(30_000, () => new ElementHandle(m.c, _text('Item 1'), 2000).longPress());
    expect(err.message).toContain('longPress() does not scroll');
  });
});
