import { describe, it, expect, vi } from 'vitest';
import { ElementHandle } from '../element-handle.js';
import { _text, _role } from '../selectors.js';
import type { TapsmithGrpcClient, ElementInfo, ActionResponse } from '../grpc-client.js';

// PILOT-716: tap-family actions scroll an element the platform reports in the
// tree but entirely off-screen (iOS) into view before acting, as Playwright's
// actionability checks do; what cannot be reached ends in one scrollIntoView()
// hint on both platforms.

const SCREEN_H = 800;
const ROW_H = 50;

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
 * A vertical list on an 800pt screen. `top` is the row's position; a swipe
 * moves the content by `travel × distance × screen height` (travel > 1
 * simulates a fling that overshoots). Returns the client and the swipe log.
 */
function simulatedList(opts: {
  top: number;
  travel?: number;
  moves?: boolean;
  checked?: boolean;
  elementIdAfterScroll?: string;
  goneAfterSwipe?: boolean;
  timeoutMs?: number;
}) {
  const state = { top: opts.top, swiped: false, checked: opts.checked ?? false };
  const row = (): ElementInfo => {
    const bounds = { left: 0, top: state.top, right: 390, bottom: state.top + ROW_H };
    const onScreen = bounds.bottom > 0 && bounds.top < SCREEN_H;
    return info({
      elementId: state.swiped && opts.elementIdAfterScroll ? opts.elementIdAfterScroll : 'el-1',
      bounds,
      visible: onScreen,
      viewportRatio: onScreen ? 1 : 0,
      checked: state.checked,
    });
  };
  const findElements = vi.fn(async () => ({
    requestId: '1',
    elements: opts.goneAfterSwipe && state.swiped ? [] : [row()],
    errorMessage: '',
  }));
  const swipe = vi.fn(async (direction: string, o?: { distance?: number; speed?: number }) => {
    state.swiped = true;
    if (opts.moves === false) return ok();
    const delta = (opts.travel ?? 1) * (o?.distance ?? 0.6) * SCREEN_H;
    state.top += direction === 'up' ? -delta : direction === 'down' ? delta : 0;
    return ok();
  });
  const tap = vi.fn(async () => {
    state.checked = !state.checked;
    return ok();
  });
  const client = {
    findElements,
    swipe,
    tap,
    doubleTap: vi.fn(async () => ok()),
    longPress: vi.fn(async () => ok()),
    waitForIdle: vi.fn(async () => ok()),
  } as unknown as TapsmithGrpcClient;
  return { client, swipe, tap, findElements, state, row };
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

describe('tap() scrolls an off-screen element into view (PILOT-716)', () => {
  it('scrolls a row below the screen up into view, then taps it', async () => {
    const { client, swipe, tap, state } = simulatedList({ top: 1500 });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());

    expect(swipe.mock.calls.every(([dir]) => dir === 'up')).toBe(true);
    expect(swipe).toHaveBeenCalledWith('up', { speed: 1000, distance: 0.5 });
    expect(state.top).toBeLessThan(SCREEN_H);
    expect(tap).toHaveBeenCalledTimes(1);
    expect(swipe.mock.invocationCallOrder.at(-1)!).toBeLessThan(tap.mock.invocationCallOrder[0]);
  });

  it('scrolls a row the list was scrolled past (above the screen) back down into view', async () => {
    // The ticket's repro: "Item 1" after scrolling the list down.
    const { client, swipe, tap, state } = simulatedList({ top: -700 });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());

    expect(swipe.mock.calls.map(([dir]) => dir)).toEqual(['down', 'down']);
    expect(state.top + ROW_H).toBeGreaterThan(0);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('reverses with half the distance when a swipe flings the row past the screen', async () => {
    // Each swipe travels 3× its nominal distance: 1.5 screens at 0.5.
    const { client, swipe, tap } = simulatedList({ top: 1000, travel: 3 });
    await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());

    const calls = swipe.mock.calls.map(([dir, o]) => [dir, o?.distance]);
    // 1000 → -200 (overshot above) → down 0.25×3×800=600 → 400: on screen.
    expect(calls).toEqual([['up', 0.5], ['down', 0.25]]);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('does not swipe for an on-screen element', async () => {
    const { client, swipe, tap } = simulatedList({ top: 300 });
    await new ElementHandle(client, _text('Item 1'), 5000).tap();
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

  it('fails after one swipe that did not move the row, with the scrollIntoView() hint and no tap', async () => {
    const { client, swipe, tap } = simulatedList({ top: -500, moves: false });
    const err = await rejectionOf(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());

    expect(swipe).toHaveBeenCalledTimes(1);
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/is off-screen and tap\(\) could not scroll it into view: a "down" screen swipe did not move it/);
    expect(err.message).toContain('scrollIntoView({ direction: "down" })');
  });

  it('gives up after the swipe cap when the row keeps moving but never arrives', async () => {
    // Each swipe moves it a little (travel 0.05 → 20pt), never far enough.
    const { client, swipe, tap } = simulatedList({ top: 5000, travel: 0.05 });
    const err = await rejectionOf(60_000, () => new ElementHandle(client, _text('Item 1'), 60_000).tap());

    expect(swipe).toHaveBeenCalledTimes(8);
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/still off-screen after 8 scroll\(s\)\. Scroll it into view first/);
  });

  it("stops at the action's deadline", async () => {
    const { client, swipe, tap } = simulatedList({ top: 5000, travel: 0.05 });
    const err = await rejectionOf(10_000, () => new ElementHandle(client, _text('Item 1'), 1500).tap());

    expect(swipe.mock.calls.length).toBeLessThan(8);
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/the action timed out after \d+ scroll\(s\)/);
  });

  it('fails clearly when the row leaves the tree while scrolling (virtualized list)', async () => {
    const { client, tap } = simulatedList({ top: 1500, goneAfterSwipe: true });
    const err = await rejectionOf(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000).tap());
    expect(tap).not.toHaveBeenCalled();
    expect(err.message).toMatch(/left the accessibility tree while scrolling/);
  });

  it('a modified handle taps the element id of the settled, on-screen read', async () => {
    const { client, tap } = simulatedList({ top: 1500, elementIdAfterScroll: 'el-fresh' });
    await withFakeClock(30_000, () => new ElementHandle(client, _role('button'), 30_000).first().tap());
    expect(tap).toHaveBeenCalledWith(undefined, expect.any(Number), 'el-fresh');
  });

  it('doubleTap() and longPress() scroll too', async () => {
    for (const act of ['doubleTap', 'longPress'] as const) {
      const { client, swipe } = simulatedList({ top: 1500 });
      await withFakeClock(30_000, () => new ElementHandle(client, _text('Item 1'), 30_000)[act]());
      expect(swipe).toHaveBeenCalled();
      expect((client as unknown as Record<string, ReturnType<typeof vi.fn>>)[act]).toHaveBeenCalledTimes(1);
    }
  });

  it('setChecked() scrolls a switch that needs toggling, but not one already in the requested state', async () => {
    const needs = simulatedList({ top: 1500, checked: false });
    await withFakeClock(30_000, () => new ElementHandle(needs.client, _text('Item 1'), 30_000).setChecked(true));
    expect(needs.swipe).toHaveBeenCalled();
    expect(needs.tap).toHaveBeenCalledTimes(1);

    const already = simulatedList({ top: 1500, checked: true });
    await withFakeClock(30_000, () => new ElementHandle(already.client, _text('Item 1'), 30_000).setChecked(true));
    expect(already.swipe).not.toHaveBeenCalled();
    expect(already.tap).not.toHaveBeenCalled();
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
});
