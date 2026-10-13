import { describe, it, expect, vi } from 'vitest';
import { ElementHandle } from '../element-handle.js';
import { _text, _role } from '../selectors.js';
import type { TapsmithGrpcClient, ElementInfo, ActionResponse } from '../grpc-client.js';

// PILOT-716: tap-family actions scroll an element the platform reports in the
// tree but entirely off-screen (iOS) towards the middle of the screen before
// acting, as Playwright's actionability checks do; what cannot be reached ends
// in one scrollIntoView() hint on both platforms.

const SCREEN_W = 390;
const SCREEN_H = 800;
const ROW_H = 50;
const ROW_W = 390;
const HIERARCHY = `<?xml version="1.0"?><hierarchy><node bounds="[0,0][${SCREEN_W},${SCREEN_H}]"><node bounds="[0,0][1,1]"/></node></hierarchy>`;

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
 * A row on a 390×800pt screen. A vertical swipe moves the content by
 * `travel × distance × screen height` (travel > 1 simulates a fling past the
 * target); horizontal swipes do not move it. `minTop`
 * / `maxTop` clamp the row's travel (the ends of the list).
 */
function simulatedScreen(opts: {
  top: number;
  left?: number;
  travel?: number;
  moves?: boolean;
  minTop?: number;
  maxTop?: number;
  checked?: boolean;
  elementIdAfterScroll?: string;
  goneAfterSwipe?: boolean;
  /** Reads after the first swipe that come back as an agent fault. */
  faultReadsAfterSwipe?: number;
  /** The read right after each of the first N swipes comes back as a stale snapshot. */
  staleAfterSwipes?: number;
  /** Reads after the first swipe that see the row disabled. */
  disabledReadsAfterSwipe?: number;
  /** Bounds the row reports on successive reads before the first swipe (animating in). */
  animation?: number[];
  /** The first N hierarchy reads fail (Infinity: all of them). */
  hierarchyFailures?: number;
  /** The row's height (default ROW_H). */
  rowH?: number;
  /** Reads after each swipe during which the list keeps drifting (momentum), 30pt per read. */
  momentumReads?: number;
}) {
  const state = {
    top: opts.top, left: opts.left ?? 0, swiped: false, checked: opts.checked ?? false,
    faults: opts.faultReadsAfterSwipe ?? 0, disabled: opts.disabledReadsAfterSwipe ?? 0,
    animation: [...(opts.animation ?? [])],
    momentum: 0, momentumDir: 0, overpull: 0, tappedWhileMoving: false,
    staleSwipes: opts.staleAfterSwipes ?? 0, staleNext: false,
    hierarchyFailures: opts.hierarchyFailures ?? 0,
  };
  const row = (): ElementInfo => {
    const bounds = { left: state.left, top: state.top, right: state.left + ROW_W, bottom: state.top + (opts.rowH ?? ROW_H) };
    const onScreen = bounds.bottom > 0 && bounds.top < SCREEN_H && bounds.right > 0 && bounds.left < SCREEN_W;
    let enabled = true;
    if (state.swiped && state.disabled > 0) {
      state.disabled--;
      enabled = false;
    }
    return info({
      elementId: state.swiped && opts.elementIdAfterScroll ? opts.elementIdAfterScroll : 'el-1',
      bounds, visible: onScreen, viewportRatio: onScreen ? 1 : 0, checked: state.checked, enabled,
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
    const travel = opts.travel ?? 1;
    const d = o?.distance ?? 0.6;
    if (direction === 'up' || direction === 'down') {
      const sign = direction === 'up' ? -1 : 1;
      const wanted = state.top + sign * travel * d * SCREEN_H;
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
  const getUiHierarchy = vi.fn(async () => {
    if (state.hierarchyFailures > 0) {
      state.hierarchyFailures--;
      throw new Error('hierarchy dump failed');
    }
    return { requestId: '1', hierarchyXml: HIERARCHY, errorMessage: '' };
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

/** The error `fn` rejects with, under a fake clock advanced by `advanceMs`. */
async function rejectionOf(advanceMs: number, fn: () => Promise<unknown>): Promise<Error> {
  try {
    await withFakeClock(advanceMs, fn);
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

/** Fully inside the band clear of headers and tab bars (20%–85% of the screen height). */
const inSafeRegion = (top: number) => top >= 0.2 * SCREEN_H && top + ROW_H <= 0.85 * SCREEN_H;

describe('tap() scrolls an off-screen element into view (PILOT-716)', () => {
  it('scrolls a row below the screen up into the safe region, then taps it', async () => {
    const { client, swipe, tap, state } = simulatedScreen({ top: 1500 });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());

    expect(swipe.mock.calls.every(([dir]) => dir === 'up')).toBe(true);
    expect(swipe.mock.calls[0]).toEqual(['up', { speed: 1000, distance: 0.5 }]);
    expect(inSafeRegion(state.top)).toBe(true);
    expect(tap).toHaveBeenCalledTimes(1);
    expect(swipe.mock.invocationCallOrder.at(-1)!).toBeLessThan(tap.mock.invocationCallOrder[0]);
  });

  it('scrolls a row the list was scrolled past back down — not stopping at the first sliver under the header (review R1-F1)', async () => {
    // The ticket's repro: "Item 1" after scrolling the list down. Half-screen
    // steps put it at top 100 — on screen, but where a header sits.
    const { client, swipe, tap, state } = simulatedScreen({ top: -700 });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());

    expect(swipe.mock.calls.map(([dir]) => dir)).toEqual(['down', 'down', 'down']);
    expect(inSafeRegion(state.top)).toBe(true);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('stops at the end of the list without dragging it past its end again (review R2-F1)', async () => {
    // The first row of a list sits under the header (top 120, outside the
    // safe region) and goes no lower: another "down" drag would pull the list
    // past its top — a pull-to-refresh, or a sheet dismissed.
    const { client, tap, state } = simulatedScreen({ top: -700, maxTop: 120 });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(state.top).toBe(120);
    // The nudge out of the top band pulls the list only a little past its top
    // (review R6-F1: aiming at the middle pulled ~250pt past it).
    expect(state.overpull).toBeLessThanOrEqual(0.15 * SCREEN_H);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('settles the list before tapping when the read right after a swipe was inconclusive (review R2-F3)', async () => {
    const sim = simulatedScreen({ top: 1000, faultReadsAfterSwipe: 1, momentumReads: 3 });
    await withFakeClock(30_000, () => new ElementHandle(sim.client, _text('Item 1'), 30_000).tap());
    expect(sim.tap).toHaveBeenCalledTimes(1);
    expect(sim.state.tappedWhileMoving).toBe(false);
  });

  it('corrects a fling past the safe region from the other side', async () => {
    // Each drag travels 2.5× its distance: the first carries the row from
    // below the screen past the safe region to the top band.
    const { client, swipe, tap, state } = simulatedScreen({ top: 850, travel: 2.5 });
    await withFakeClock(60_000, () => new ElementHandle(client, _text('Item 1'), 60_000).tap());

    const dirs = swipe.mock.calls.map(([dir]) => dir);
    expect(dirs.slice(0, 2)).toEqual(['up', 'down']);
    expect((swipe.mock.calls[1][1] as { distance: number }).distance).toBeLessThan(0.5);
    expect(inSafeRegion(state.top)).toBe(true);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('never swipes at an element off to the side; it waits, then fails with a left/right hint (review R1-F4, R2-F6)', async () => {
    for (const [left, hint] of [[500, 'left'], [-600, 'right']] as const) {
      const { client, swipe, tap } = simulatedScreen({ top: 300, left });
      const err = await rejectionOf(10_000, () => new ElementHandle(client, _text('Item 1'), 3000).tap());
      expect(swipe).not.toHaveBeenCalled();
      expect(tap).not.toHaveBeenCalled();
      expect(err.message).toMatch(/is off-screen and tap\(\) could not scroll it into view: it is off-screen to the (left|right), and tap\(\) scrolls only vertically/);
      expect(err.message).toContain(`Scroll it into view first (scroll() on the carousel or list that holds it, or await locator.scrollIntoView({ direction: "${hint}" }) if nothing at the middle of the screen reacts to a sideways swipe), then tap() it.`);
    }
  });

  it('scrolls a carousel cell below the screen level with it, then reports it off to the side — no jiggling (review R4-F3)', async () => {
    const { client, swipe, tap } = simulatedScreen({ top: 1500, left: 500 });
    const err = await rejectionOf(20_000, () => new ElementHandle(client, _text('Item 1'), 8000).tap());
    expect(swipe.mock.calls.every(([dir]) => dir === 'up')).toBe(true);
    expect(swipe.mock.calls.length).toBeLessThanOrEqual(3);
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/it is off-screen to the right/);
    expect(err.message).toContain('or await locator.scrollIntoView({ direction: "left" }) if nothing at the middle of the screen reacts');
  });

  it('brings an element taller than half the screen across the middle, not just a strip at the edge (review R4-F1)', async () => {
    const { client, tap, state } = simulatedScreen({ top: 1500, rowH: 480 });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Hero'), 30_000).tap());
    expect(state.top).toBeLessThanOrEqual(SCREEN_H / 2);
    expect(state.top + 480).toBeGreaterThanOrEqual(SCREEN_H / 2);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('never swipes blind when the screen size cannot be read; reports it at the deadline (review R5-F2)', async () => {
    const { client, swipe, tap } = simulatedScreen({ top: 1500, hierarchyFailures: Infinity });
    const err = await rejectionOf(20_000, () => new ElementHandle(client, _text('Item 1'), 3000).tap());
    expect(swipe).not.toHaveBeenCalled();
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/could not scroll it into view: the screen size could not be read to steer the scroll/);
  });

  it('retries a failed screen-size read on the next attempt, and reads it only once per action once it succeeds (review R5-F2)', async () => {
    const { client, swipe, tap, getUiHierarchy, state } = simulatedScreen({ top: 1500, hierarchyFailures: 1 });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(getUiHierarchy).toHaveBeenCalledTimes(2);
    expect(swipe).toHaveBeenCalled();
    expect(inSafeRegion(state.top)).toBe(true);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('does not swipe for an on-screen element', async () => {
    const { client, swipe, tap, getUiHierarchy } = simulatedScreen({ top: 300 });
    await new ElementHandle(client, _text('Item 1'), 5000).tap();
    expect(swipe).not.toHaveBeenCalled();
    expect(getUiHierarchy).not.toHaveBeenCalled();
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('does not swipe at an element still moving in by itself, and taps it once it arrives (review R1-F2)', async () => {
    const { client, swipe, tap } = simulatedScreen({ top: 1400, animation: [1400, 1100, 800, 500] });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(swipe).not.toHaveBeenCalled();
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('does not swipe for an element that is invisible for another reason (zero-size frame, no bounds)', async () => {
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

  it('after a swipe that did not move the row, stops swiping but keeps waiting, and reports why at the deadline (review R1-F3)', async () => {
    const { client, swipe, tap } = simulatedScreen({ top: -500, moves: false });
    const err = await rejectionOf(30_000, () => new ElementHandle(client, _text('Item 1'), 5000).tap());

    expect(swipe).toHaveBeenCalledTimes(1);
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/is off-screen and tap\(\) could not scroll it into view: a "down" screen swipe did not move it/);
  });

  it('a row that comes on screen by itself after a failed scroll is still tapped (review R1-F3)', async () => {
    const sim = simulatedScreen({ top: -500, moves: false });
    const handle = new ElementHandle(sim.client, _text('Item 1'), 10_000);
    await withFakeClock(10_000, async () => {
      const done = handle.tap();
      // Let the failed scroll happen, then the row slides in by itself.
      setTimeout(() => { sim.state.top = 300; }, 4000);
      await done;
    });
    expect(sim.swipe).toHaveBeenCalledTimes(1);
    expect(sim.tap).toHaveBeenCalledTimes(1);
  });

  it('reaches a row far down the list — no fixed swipe cap below the deadline (review R1-F7)', async () => {
    const { client, swipe, tap, state } = simulatedScreen({ top: 5000 });
    await withFakeClock(60_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(swipe.mock.calls.length).toBeGreaterThan(8);
    expect(inSafeRegion(state.top)).toBe(true);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it("stops at the action's deadline", async () => {
    const { client, swipe, tap } = simulatedScreen({ top: 50_000, travel: 0.05 });
    const err = await rejectionOf(20_000, () => new ElementHandle(client, _text('Item 1'), 3000).tap());
    expect(swipe.mock.calls.length).toBeGreaterThan(0);
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/the action timed out after \d+ scroll\(s\)/);
  });

  it('a fault right after a swipe is retried by the wait like any other read (review R1-F9)', async () => {
    const { client, tap } = simulatedScreen({ top: 1500, faultReadsAfterSwipe: 4 });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('a scroll cut short by stale reads after its swipes resumes — it does not use up the attempts (review R3-F3)', async () => {
    // Five screens away: every one of the first 5 swipes is followed by a
    // stale snapshot, which ends that scroll early.
    const { client, swipe, tap, state } = simulatedScreen({ top: 4500, staleAfterSwipes: 5 });
    await withFakeClock(60_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(swipe.mock.calls.length).toBeGreaterThan(5);
    expect(inSafeRegion(state.top)).toBe(true);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('waits for an element that turns disabled during the scroll to be enabled again (review R1-F6)', async () => {
    const sim = simulatedScreen({ top: 1500, disabledReadsAfterSwipe: 40 });
    await withFakeClock(60_000, () => new ElementHandle(sim.client, _text('Item 1'), 30_000).tap());
    expect(sim.state.disabled).toBe(0);
    expect(sim.tap).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting when the row leaves the tree while scrolling, then reports it not found', async () => {
    const { client, tap } = simulatedScreen({ top: 1500, goneAfterSwipe: true });
    const err = await rejectionOf(30_000, () => new ElementHandle(client, _text('Item 1'), 5000).tap());
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/was not found after waiting 5000ms\. If it is off-screen in a scrollable list/);
  });

  it('a modified handle taps the element id of a fresh, on-screen read', async () => {
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

  it('setChecked() still confirms a toggle made right at its deadline after a long scroll (review R4-F4)', async () => {
    // The scroll ends past the 2 s timeout; the tap gets the action floor,
    // and so must the read that confirms it.
    const sim = simulatedScreen({ top: 1500, checked: false });
    await withFakeClock(30_000, () => new ElementHandle(sim.client, _text('Item 1'), 2000).setChecked(true));
    expect(sim.tap).toHaveBeenCalledTimes(1);
    expect(sim.state.checked).toBe(true);
  });
});

describe('not-found hint for tap-family actions (PILOT-716)', () => {
  it('tap() suggests scrollIntoView() when the element never appears (Android hides off-screen rows)', async () => {
    const client = {
      findElements: vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: '' })),
    } as unknown as TapsmithGrpcClient;
    const err = await rejectionOf(5000, () => new ElementHandle(client, _text('Item 1'), 2000).tap());
    expect(err.message).toMatch(/^Element .* was not found after waiting 2000ms\. If it is off-screen in a scrollable list, scroll to it first with scrollIntoView\(\) before tap\(\)/);
  });

  it('names the action that failed', async () => {
    const client = {
      findElements: vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: '' })),
    } as unknown as TapsmithGrpcClient;
    const err = await rejectionOf(5000, () => new ElementHandle(client, _text('Item 1'), 2000).longPress());
    expect(err.message).toContain('before longPress()');
  });

  it('tells the user which way to scroll for a row above the screen (review R4-F8)', async () => {
    const client = {
      findElements: vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: '' })),
    } as unknown as TapsmithGrpcClient;
    const err = await rejectionOf(5000, () => new ElementHandle(client, _text('Item 1'), 2000).tap());
    expect(err.message).toContain('scrollIntoView({ direction: "down" }) for a row above the screen');
  });
});
