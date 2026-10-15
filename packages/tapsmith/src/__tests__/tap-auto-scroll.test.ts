import { describe, it, expect, vi } from 'vitest';
import { ElementHandle } from '../element-handle.js';
import { _text, _role } from '../selectors.js';
import type { TapsmithGrpcClient, ElementInfo, ActionResponse } from '../grpc-client.js';

// PILOT-716: a tap-family action scrolls an element that is in the tree but
// entirely above or below the screen (iOS reports such nodes) into view, when
// it sits in a single vertically scrolling list that covers the middle of the
// screen. Every other off-screen case fails at once with one message that
// names the element and points at scrollIntoView(); on Android, where
// off-screen rows are not in the tree, the not-found error carries the hint.

const SCREEN_W = 390;
const SCREEN_H = 800;
const ROW_H = 50;
const ROW_W = 390;

function ok(): ActionResponse {
  return { requestId: '1', success: true, errorType: '', errorMessage: '', screenshot: Buffer.alloc(0) };
}

function info(overrides: Partial<ElementInfo>): ElementInfo {
  return {
    elementId: 'el-1', className: 'XCUIElementTypeButton', text: 'Item 1', contentDescription: '',
    resourceId: '', enabled: true, visible: true, clickable: true, focusable: true, scrollable: false,
    hint: '', checked: false, selected: false, focused: false, role: 'button', viewportRatio: 1,
    ...overrides,
  };
}

/**
 * A row in a vertical list on a 390×800pt screen. A vertical swipe moves the
 * content by `travel × distance × screen height`; horizontal swipes do not move
 * it. `minTop` / `maxTop` clamp the row's travel (the ends of the list). The
 * hierarchy dump holds the app frame and a scroll view (the list, `listTop` to
 * `listBottom`) around the row and a sibling row (`siblings`).
 */
function simulatedScreen(opts: {
  top: number;
  left?: number;
  travel?: number;
  moves?: boolean;
  minTop?: number;
  maxTop?: number;
  rowH?: number;
  checked?: boolean;
  listTop?: number;
  listBottom?: number;
  /** Sibling cells around the row: stacked (a list), side by side (a carousel), or a grid row-mate first then a row below. */
  siblings?: 'stacked' | 'side' | 'grid' | 'none';
  /** The list sits inside another scroll view. */
  nested?: boolean;
  /** The row is in no scroll view at all. */
  noList?: boolean;
  /** The dump's row node does not match the row's frame. */
  unmatched?: boolean;
  /** The agent reports the row not visible even where it is on screen (a stale screen size). */
  agentSaysHidden?: boolean;
  hierarchyFails?: boolean;
  /** The hierarchy read answers with an agent error. */
  hierarchyError?: string;
  elementIdAfterScroll?: string;
  goneAfterSwipe?: boolean;
  /** Reads after the first swipe that come back as an agent fault. */
  faultReadsAfterSwipe?: number;
  /** The read right after each of the first N swipes comes back as a stale snapshot. */
  staleAfterSwipes?: number;
  /** Reads after the first swipe that see the row disabled. */
  disabledReadsAfterSwipe?: number;
  /** Reads after each swipe during which the list keeps drifting (momentum), 30pt per read. */
  momentumReads?: number;
  /** Positions the row reports on successive reads before the first swipe (animating in). */
  animation?: number[];
}) {
  const rowH = opts.rowH ?? ROW_H;
  const state = {
    top: opts.top, left: opts.left ?? 0, swiped: false, checked: opts.checked ?? false,
    faults: opts.faultReadsAfterSwipe ?? 0, disabled: opts.disabledReadsAfterSwipe ?? 0,
    staleSwipes: opts.staleAfterSwipes ?? 0, staleNext: false,
    animation: [...(opts.animation ?? [])],
    momentum: 0, momentumDir: 0, overpull: 0, tappedWhileMoving: false,
  };
  const row = (): ElementInfo => {
    const bounds = { left: state.left, top: state.top, right: state.left + ROW_W, bottom: state.top + rowH };
    const onScreen = bounds.bottom > 0 && bounds.top < SCREEN_H && bounds.right > 0 && bounds.left < SCREEN_W;
    let enabled = true;
    if (state.swiped && state.disabled > 0) {
      state.disabled--;
      enabled = false;
    }
    return info({
      elementId: state.swiped && opts.elementIdAfterScroll ? opts.elementIdAfterScroll : 'el-1',
      bounds, visible: onScreen && !opts.agentSaysHidden, viewportRatio: onScreen ? 1 : 0,
      checked: state.checked, enabled,
    });
  };
  const findElements = vi.fn(async () => {
    if (!state.swiped && state.animation.length > 0) state.top = state.animation.shift()!;
    if (state.staleNext) {
      state.staleNext = false;
      return { requestId: '1', elements: [], errorMessage: 'Element snapshot is stale (UI changed)' };
    }
    if (state.swiped && state.faults > 0) {
      state.faults--;
      return { requestId: '1', elements: [], errorMessage: 'Agent command timed out after 5000ms' };
    }
    if (state.momentum > 0) {
      state.momentum--;
      state.top += state.momentumDir * 30;
    }
    return { requestId: '1', elements: opts.goneAfterSwipe && state.swiped ? [] : [row()], errorMessage: '' };
  });
  const swipe = vi.fn(async (direction: string, o?: { distance?: number; speed?: number }) => {
    state.swiped = true;
    if (state.staleSwipes > 0) {
      state.staleSwipes--;
      state.staleNext = true;
    }
    if (opts.moves === false) return ok();
    if (direction === 'up' || direction === 'down') {
      const sign = direction === 'up' ? -1 : 1;
      const wanted = state.top + sign * (opts.travel ?? 1) * (o?.distance ?? 0.6) * SCREEN_H;
      let top = wanted;
      if (opts.minTop !== undefined) top = Math.max(opts.minTop, top);
      if (opts.maxTop !== undefined) top = Math.min(opts.maxTop, top);
      // How far a drag pulled the list past its end (the part it could not scroll).
      state.overpull = Math.max(state.overpull, Math.abs(wanted - top));
      state.top = top;
      state.momentum = opts.momentumReads ?? 0;
      state.momentumDir = sign;
    }
    return ok();
  });
  const tap = vi.fn(async () => {
    if (state.momentum > 0) state.tappedWhileMoving = true;
    state.checked = !state.checked;
    return ok();
  });
  const getUiHierarchy = vi.fn(async (_deadlineMs?: number) => {
    if (opts.hierarchyFails) throw new Error('Agent command timed out after 5000ms');
    if (opts.hierarchyError) return { requestId: '1', hierarchyXml: '', errorMessage: opts.hierarchyError };
    const r = row().bounds!;
    const shift = opts.unmatched ? 37 : 0;
    const node = (t: number, l: number) =>
      `<XCUIElementTypeButton type="XCUIElementTypeButton" bounds="[${Math.round(l)},${Math.round(t)}][${Math.round(l + ROW_W)},${Math.round(t + rowH)}]"/>`;
    const rowNode = node(r.top + shift, r.left);
    const sibling = opts.siblings === 'none' ? ''
      : opts.siblings === 'side' ? node(r.top, r.left + ROW_W + 10)
        : opts.siblings === 'grid' ? node(r.top, r.left + ROW_W + 10) + node(r.top + rowH + 10, r.left)
          : node(r.top + rowH + 10, r.left);
    const listTop = opts.listTop ?? 0;
    const listBottom = opts.listBottom ?? SCREEN_H;
    let content = opts.noList
      ? `<XCUIElementTypeOther type="XCUIElementTypeOther" bounds="[0,0][${SCREEN_W},${SCREEN_H}]">${rowNode}${sibling}</XCUIElementTypeOther>`
      : `<XCUIElementTypeScrollView type="XCUIElementTypeScrollView" bounds="[0,${listTop}][${SCREEN_W},${listBottom}]">${sibling}${rowNode}</XCUIElementTypeScrollView>`;
    if (opts.nested) content = `<XCUIElementTypeScrollView type="XCUIElementTypeScrollView" bounds="[0,0][${SCREEN_W},${SCREEN_H}]">${content}</XCUIElementTypeScrollView>`;
    return {
      requestId: '1',
      hierarchyXml: `<?xml version="1.0"?><hierarchy><XCUIElementTypeApplication type="XCUIElementTypeApplication" bounds="[0,0][${SCREEN_W},${SCREEN_H}]">${content}</XCUIElementTypeApplication></hierarchy>`,
      errorMessage: '',
    };
  });
  const client = {
    findElements, swipe, tap, getUiHierarchy,
    doubleTap: vi.fn(async () => ok()),
    longPress: vi.fn(async () => ok()),
    waitForIdle: vi.fn(async () => ok()),
  } as unknown as TapsmithGrpcClient;
  return { client, swipe, tap, findElements, getUiHierarchy, state };
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

/** The error `fn` rejects with, and how long (fake time) it took. */
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

/** Fully inside the list's safe band (15%–85% of the list's visible height). */
const inSafeRegion = (top: number, listTop = 0, listBottom = SCREEN_H, rowH = ROW_H) =>
  top >= listTop + 0.15 * (listBottom - listTop) && top + rowH <= listTop + 0.85 * (listBottom - listTop);

describe('tap() scrolls an off-screen row into view (PILOT-716)', () => {
  it('scrolls a row below the screen up into the safe region, then taps it', async () => {
    const { client, swipe, tap, state } = simulatedScreen({ top: 1500 });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(swipe.mock.calls.every(([dir]) => dir === 'up')).toBe(true);
    expect(swipe.mock.calls[0]).toEqual(['up', { speed: 1000, distance: 0.5 }]);
    expect(inSafeRegion(state.top)).toBe(true);
    expect(tap).toHaveBeenCalledTimes(1);
    expect(swipe.mock.invocationCallOrder.at(-1)!).toBeLessThan(tap.mock.invocationCallOrder[0]);
  });

  it('scrolls a row the list was scrolled past back down into the list, not behind the header above it', async () => {
    // The ticket's repro, with the device's layout: the list starts at 300
    // under a header and search box; iOS calls a row there "visible" even
    // where the list clips it, so the target band is the list's.
    const { client, swipe, tap, state } = simulatedScreen({ top: -400, listTop: 300 });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(swipe.mock.calls.every(([dir]) => dir === 'down')).toBe(true);
    expect(inSafeRegion(state.top, 300)).toBe(true);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('stops at the end of the list, pulling it only a little past its end', async () => {
    // Row 1 rests no lower than 320 (just under the list's top): short steps
    // keep the pull past the end to a nudge (a rubber band, not a refresh).
    const { client, tap, state } = simulatedScreen({ top: -400, listTop: 300, maxTop: 320 });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(state.top).toBe(320);
    expect(state.overpull).toBeLessThanOrEqual(0.1 * 500 + 1);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('brings an element taller than half the list across its middle, in short steps', async () => {
    const { client, tap, state } = simulatedScreen({ top: -450, rowH: 400, maxTop: 0 });
    await withFakeClock(60_000, () => new ElementHandle(client, _text('Hero'), 30_000).tap());
    expect(state.top).toBe(0);
    expect(state.overpull).toBeLessThanOrEqual(0.1 * SCREEN_H + 1);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('reaches a row far down the list', async () => {
    const { client, swipe, tap, state } = simulatedScreen({ top: 5000 });
    await withFakeClock(60_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(swipe.mock.calls.length).toBeGreaterThan(8);
    expect(inSafeRegion(state.top)).toBe(true);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('takes a grid for a vertical list even when the row-mate beside the element comes first (review R13-F2)', async () => {
    const { client, swipe, tap, state } = simulatedScreen({ top: 1500, siblings: 'grid' });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(swipe).toHaveBeenCalled();
    expect(inSafeRegion(state.top)).toBe(true);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('stops swiping once the element rests in the safe region, even if the agent still calls it hidden (review R13-F3)', async () => {
    const { client, swipe, tap } = simulatedScreen({ top: 1500, agentSaysHidden: true });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(swipe.mock.calls.every(([dir]) => dir === 'up')).toBe(true);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('does not swipe (or read the hierarchy) for an on-screen element', async () => {
    const { client, swipe, tap, getUiHierarchy } = simulatedScreen({ top: 300 });
    await new ElementHandle(client, _text('Item 1'), 5000).tap();
    expect(swipe).not.toHaveBeenCalled();
    expect(getUiHierarchy).not.toHaveBeenCalled();
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('taps an element the agent calls hidden but the hierarchy puts on screen, without swiping', async () => {
    const { client, swipe, tap } = simulatedScreen({ top: 300, agentSaysHidden: true });
    await withFakeClock(10_000, () => new ElementHandle(client, _text('Item 1'), 5000).tap());
    expect(swipe).not.toHaveBeenCalled();
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('does not swipe at an element still moving in by itself, and taps it once it arrives', async () => {
    const { client, swipe, tap } = simulatedScreen({ top: 1400, animation: [1400, 1100, 800, 500] });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(swipe).not.toHaveBeenCalled();
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('does not swipe for an element invisible for another reason (zero-size frame, no bounds)', async () => {
    for (const el of [
      info({ visible: false, viewportRatio: 0, bounds: { left: 10, top: 300, right: 10, bottom: 340 } }),
      info({ visible: false, viewportRatio: 0, bounds: undefined }),
    ]) {
      const swipe = vi.fn(async () => ok());
      const tap = vi.fn(async () => ok());
      const client = {
        findElements: vi.fn(async () => ({ requestId: '1', elements: [el], errorMessage: '' })),
        swipe, tap,
      } as unknown as TapsmithGrpcClient;
      await new ElementHandle(client, _text('Item 1'), 5000).tap();
      expect(swipe).not.toHaveBeenCalled();
      expect(tap).toHaveBeenCalledTimes(1);
    }
  });

  it('re-reads after a swipe through stale snapshots and agent blips', async () => {
    for (const opts of [{ staleAfterSwipes: 3 }, { faultReadsAfterSwipe: 2 }]) {
      const { client, tap, state } = simulatedScreen({ top: 1500, ...opts });
      await withFakeClock(60_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
      expect(inSafeRegion(state.top)).toBe(true);
      expect(tap).toHaveBeenCalledTimes(1);
    }
  });

  it('settles the list before tapping', async () => {
    const sim = simulatedScreen({ top: 1000, momentumReads: 3 });
    await withFakeClock(30_000, () => new ElementHandle(sim.client, _text('Item 1'), 30_000).tap());
    expect(sim.tap).toHaveBeenCalledTimes(1);
    expect(sim.state.tappedWhileMoving).toBe(false);
  });

  it('waits for an element that turns disabled during the scroll to be enabled again', async () => {
    const sim = simulatedScreen({ top: 1500, disabledReadsAfterSwipe: 40 });
    await withFakeClock(60_000, () => new ElementHandle(sim.client, _text('Item 1'), 30_000).tap());
    expect(sim.state.disabled).toBe(0);
    expect(sim.tap).toHaveBeenCalledTimes(1);
  });

  it('a modified handle taps the element id of the settled, in-view read', async () => {
    const { client, tap } = simulatedScreen({ top: 1500, elementIdAfterScroll: 'el-fresh' });
    await withFakeClock(30_000, () => new ElementHandle(client, _role('button'), 30_000).first().tap());
    expect(tap).toHaveBeenCalledWith(undefined, expect.any(Number), 'el-fresh');
  });

  it('doubleTap() and longPress() scroll too', async () => {
    for (const act of ['doubleTap', 'longPress'] as const) {
      const { client, swipe } = simulatedScreen({ top: 1500 });
      await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000)[act]());
      expect(swipe).toHaveBeenCalled();
      expect((client as unknown as Record<string, ReturnType<typeof vi.fn>>)[act]).toHaveBeenCalledTimes(1);
    }
  });

  it('setChecked() scrolls a switch that needs toggling, but not one already in the requested state', async () => {
    const needs = simulatedScreen({ top: 1500, checked: false });
    await withFakeClock(30_000, () => new ElementHandle(needs.client, _text('Item 1'), 30_000).setChecked(true));
    expect(needs.swipe).toHaveBeenCalled();
    expect(needs.tap).toHaveBeenCalledTimes(1);

    const already = simulatedScreen({ top: 1500, checked: true });
    await withFakeClock(30_000, () => new ElementHandle(already.client, _text('Item 1'), 30_000).setChecked(true));
    expect(already.swipe).not.toHaveBeenCalled();
    expect(already.tap).not.toHaveBeenCalled();
  });

  it('setChecked() still confirms a toggle made right at its deadline after a scroll', async () => {
    const sim = simulatedScreen({ top: 1500, checked: false });
    await withFakeClock(30_000, () => new ElementHandle(sim.client, _text('Item 1'), 2000).setChecked(true));
    expect(sim.tap).toHaveBeenCalledTimes(1);
    expect(sim.state.checked).toBe(true);
  });
});

describe('tap() fails fast, without guessing, outside the simple case (PILOT-716)', () => {
  const NAMED = /^Element getBy\w+\(.*\) is off-screen and tap\(\) could not scroll it into view: /;

  it.each([
    ['off to the right', { top: 300, left: 500 }, /it is off-screen to the right, and tap\(\) scrolls only vertically/, 'left'],
    ['off to the left', { top: 300, left: -600 }, /it is off-screen to the left/, 'right'],
  ] as const)('an element %s: no swipe, a scroll()/sideways hint', async (_name, opts, why, direction) => {
    const { client, swipe, tap } = simulatedScreen(opts);
    const err = await rejectionOf(60_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(swipe).not.toHaveBeenCalled();
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(NAMED);
    expect(err.message).toMatch(why);
    expect(err.message).toContain(`scroll() on the carousel or list that holds it, or await locator.scrollIntoView({ direction: "${direction}" })`);
    expect(err.elapsedMs).toBeLessThan(5000);
  });

  it.each([
    ['in nested scroll views', { nested: true }, /it is inside nested scroll views/],
    ['in no scrollable list', { noList: true }, /it is not inside a scrollable list/],
    ['in a horizontal list (a carousel)', { siblings: 'side' as const }, /the list that holds it does not scroll vertically/],
    ['in a list that does not cover the middle of the screen', { listTop: 500 }, /its list does not cover the middle of the screen/],
    ['not found in the hierarchy', { unmatched: true }, /it could not be found in the UI hierarchy/],
  ])('an element below the screen %s: no swipe, a scrollIntoView() hint', async (_name, opts, why) => {
    const { client, swipe, tap } = simulatedScreen({ top: 1500, ...opts });
    const err = await rejectionOf(60_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(swipe).not.toHaveBeenCalled();
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(NAMED);
    expect(err.message).toMatch(why);
    expect(err.message).toContain('Scroll it into view first (await locator.scrollIntoView({ direction: "up" })), then tap() it.');
    expect(err.elapsedMs).toBeLessThan(5000);
  });

  it('a failed hierarchy read propagates as itself, so session recovery can see the infra error (review R13-F1)', async () => {
    for (const [opts, message] of [
      [{ hierarchyFails: true }, /^Agent command timed out after 5000ms$/],
      [{ hierarchyError: 'agent not connected' }, /^getUiHierarchy failed: agent not connected$/],
    ] as const) {
      const { client, swipe, tap } = simulatedScreen({ top: 1500, ...opts });
      const err = await rejectionOf(60_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
      expect(err.message).toMatch(message);
      expect(swipe).not.toHaveBeenCalled();
      expect(tap).not.toHaveBeenCalled();
    }
  });

  it('reads the hierarchy with its full budget, never a sliver of the action deadline (review R14-F1)', async () => {
    // Settles off-screen only near the end of a 2 s timeout.
    const animation = Array.from({ length: 6 }, (_, i) => 3000 - i * 10);
    const { client, getUiHierarchy } = simulatedScreen({ top: 3000, animation });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 2000).tap()).catch(() => undefined);
    for (const [budget] of getUiHierarchy.mock.calls as unknown as [number][]) expect(budget).toBe(5000);
  });

  it('an element never at rest by the timeout is reported as such (review R13-F4)', async () => {
    const animation = Array.from({ length: 40 }, (_, i) => 3000 - i * 10);
    const { client, swipe } = simulatedScreen({ top: 3000, animation });
    const err = await rejectionOf(5000, () => new ElementHandle(client, _text('Item 1'), 1000).tap());
    expect(swipe).not.toHaveBeenCalled();
    expect(err.message).toMatch(/it was still out of view at the timeout, before two reads could confirm it was at rest/);
  });

  it('a swipe that does not move the element: one swipe, then a hint naming the way scrollIntoView() must go', async () => {
    const { client, swipe, tap } = simulatedScreen({ top: -500, moves: false });
    const err = await rejectionOf(60_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(swipe).toHaveBeenCalledTimes(1);
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/a "down" screen swipe did not move it/);
    expect(err.message).toContain('scrollIntoView({ direction: "down" })');
    expect(err.elapsedMs).toBeLessThan(5000);
  });

  it('a row that leaves the tree while scrolling (a virtualized list)', async () => {
    const { client, tap } = simulatedScreen({ top: 1500, goneAfterSwipe: true });
    const err = await rejectionOf(60_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/it left the accessibility tree while scrolling/);
  });

  it('gives up at the swipe cap when the row keeps moving but never arrives', async () => {
    const { client, swipe, tap } = simulatedScreen({ top: 50_000, travel: 0.05 });
    const err = await rejectionOf(120_000, () => new ElementHandle(client, _text('Item 1'), 60_000).tap());
    expect(swipe).toHaveBeenCalledTimes(25);
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/it was still not in view after 25 swipes/);
  });

  it("stops at the action's deadline", async () => {
    const { client, swipe, tap } = simulatedScreen({ top: 50_000, travel: 0.05 });
    const err = await rejectionOf(20_000, () => new ElementHandle(client, _text('Item 1'), 3000).tap());
    expect(swipe.mock.calls.length).toBeGreaterThan(0);
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/the action timed out after \d+ swipe\(s\)/);
  });
});

describe('not-found hint for tap-family actions (PILOT-716)', () => {
  const absent = () => ({
    findElements: vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: '' })),
  } as unknown as TapsmithGrpcClient);

  it('tap() suggests scrollIntoView() when the element never appears (Android hides off-screen rows)', async () => {
    const err = await rejectionOf(5000, () => new ElementHandle(absent(), _text('Item 1'), 2000).tap());
    expect(err.message).toMatch(/^Element .* was not found after waiting 2000ms\. If it is off-screen in a scrollable list, scroll to it first with scrollIntoView\(\) before tap\(\)/);
    expect(err.message).toContain('scrollIntoView({ direction: "down" }) for a row above the screen');
  });

  it('names the action that failed', async () => {
    const err = await rejectionOf(5000, () => new ElementHandle(absent(), _text('Item 1'), 2000).longPress());
    expect(err.message).toContain('before longPress()');
  });
});
