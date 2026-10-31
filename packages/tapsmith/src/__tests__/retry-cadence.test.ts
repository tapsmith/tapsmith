/**
 * The cadence of every locator retry loop (PILOT-972): Playwright's backoff,
 * not a flat 250 ms sleep. Each test records when the mock agent is read
 * (reads are instant under fake timers, so the gaps are the loop's sleeps).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ElementHandle } from '../element-handle.js';
import { expect as tapsmithExpect } from '../expect.js';
import { WebViewHandle, type WebViewLocatorProbe } from '../webview-handle.js';
import { _text } from '../selectors.js';
import type { TapsmithGrpcClient, ElementInfo, FindElementsResponse, ActionResponse } from '../grpc-client.js';

const ACTION_GAPS = [0, 20, 100, 100, 500, 500, 500];
const EXPECT_GAPS = [100, 250, 500, 1000, 1000];

function el(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    elementId: 'el-1', className: 'android.widget.CheckBox', text: 'X', contentDescription: '',
    resourceId: '', enabled: true, visible: true, clickable: true, focusable: false, scrollable: false,
    hint: '', checked: false, selected: false, focused: false, role: '', viewportRatio: 1.0,
    ...overrides,
  };
}

const ok = (): ActionResponse => ({ requestId: '1', success: true, errorType: '', errorMessage: '', screenshot: Buffer.alloc(0) });

/** A client whose findElements answers with `answer(readIndex)` and records each read's time. */
function recordingClient(answer: (i: number) => FindElementsResponse) {
  const reads: number[] = [];
  const findElements = vi.fn(async (): Promise<FindElementsResponse> => {
    reads.push(Date.now());
    return answer(reads.length - 1);
  });
  const client = {
    findElements,
    findElement: vi.fn(async () => ({ requestId: '1', found: false, errorMessage: '' })),
    tap: vi.fn(async () => ok()),
    waitForIdle: vi.fn(async () => ok()),
    takeScreenshot: vi.fn(async () => ({ requestId: '1', success: true, data: Buffer.alloc(0), errorMessage: '' })),
  } as unknown as TapsmithGrpcClient;
  return { client, reads, findElements };
}

const none = (): FindElementsResponse => ({ requestId: '1', elements: [], errorMessage: '' });
const stale = (): FindElementsResponse => ({
  requestId: '1', elements: [], errorMessage: 'findElements failed: node is stale (UI changed) mid-read',
});

function gaps(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - times[i]);
}

/** Run `fn` to completion under fake timers, advancing `advanceMs`; settle (resolve or reject) either way. */
async function runFaked(advanceMs: number, fn: () => Promise<unknown>): Promise<void> {
  vi.useFakeTimers();
  const done = fn().then(() => undefined, () => undefined);
  await vi.advanceTimersByTimeAsync(advanceMs);
  await done;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('action auto-wait backs off like Playwright (PILOT-972)', () => {
  it('tap() re-reads a missing element at 0, 20, 100, 100, then every 500 ms', async () => {
    const { client, reads } = recordingClient(none);
    await runFaked(3000, () => new ElementHandle(client, _text('X'), 2500).tap());
    expect(gaps(reads).slice(0, ACTION_GAPS.length)).toEqual(ACTION_GAPS);
  });

  it('tap() acts on the second read straight away when the first one misses', async () => {
    const { client, reads } = recordingClient((i) => (i === 0 ? none() : { requestId: '1', elements: [el()], errorMessage: '' }));
    vi.useFakeTimers();
    const start = Date.now();
    const done = new ElementHandle(client, _text('X'), 5000).tap();
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(reads[1] - start).toBe(0);
    expect(client.tap).toHaveBeenCalledTimes(1);
  });

  it('never sleeps past the deadline', async () => {
    const { client, reads } = recordingClient(none);
    let failedAt = -1;
    vi.useFakeTimers();
    const start = Date.now();
    const done = new ElementHandle(client, _text('X'), 300).tap().catch(() => { failedAt = Date.now(); });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    // reads at 0, 0, 20, 120, 220, then the 500 ms step is capped to the 80 ms left.
    expect(reads.map((t) => t - start)).toEqual([0, 0, 20, 120, 220, 300]);
    expect(failedAt - start).toBe(300);
  });

  it('waitFor() follows the same schedule', async () => {
    const { client, reads } = recordingClient(none);
    await runFaked(3000, () => new ElementHandle(client, _text('X'), 2500).waitFor({ state: 'visible' }));
    expect(gaps(reads).slice(0, ACTION_GAPS.length)).toEqual(ACTION_GAPS);
  });

  it('each call starts at the quick end of the ramp', async () => {
    const { client, reads } = recordingClient(none);
    const handle = new ElementHandle(client, _text('X'), 1000);
    await runFaked(1500, () => handle.waitFor({ state: 'visible' }));
    const first = reads.length;
    await runFaked(1500, () => handle.waitFor({ state: 'visible' }));
    expect(gaps(reads.slice(first)).slice(0, 3)).toEqual([0, 20, 100]);
  });

  it('count() re-reads a stale snapshot on the same schedule', async () => {
    const { client, reads } = recordingClient(stale);
    await runFaked(3000, () => new ElementHandle(client, _text('X'), 2500).count());
    expect(gaps(reads).slice(0, ACTION_GAPS.length)).toEqual(ACTION_GAPS);
  });

  it('isVisible() re-probes a stale snapshot on the same schedule', async () => {
    const { client, reads } = recordingClient(stale);
    await runFaked(3000, () => new ElementHandle(client, _text('X'), 2500).isVisible());
    expect(gaps(reads).slice(0, 5)).toEqual(ACTION_GAPS.slice(0, 5));
  });

  it("setChecked() checks the switch's new state on the same schedule after its tap", async () => {
    // The switch is found unchecked and never changes, so the verification
    // loop runs until its 2 s deadline.
    const { client, reads } = recordingClient(() => ({ requestId: '1', elements: [el()], errorMessage: '' }));
    let tappedAt = -1;
    let readsBeforeTap = -1;
    (client.tap as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      tappedAt = Date.now();
      readsBeforeTap = reads.length;
      return ok();
    });
    await runFaked(4000, () => new ElementHandle(client, _text('X'), 2000).setChecked(true));
    expect(readsBeforeTap).toBeGreaterThan(0);
    const after = reads.slice(readsBeforeTap);
    expect(gaps([tappedAt, ...after]).slice(0, 5)).toEqual([0, 20, 100, 100, 500]);
  });
});

describe('assertions back off like Playwright (PILOT-972)', () => {
  it('expect(locator).toBeVisible() re-reads at 100, 250, 500, then every 1000 ms', async () => {
    const { client, reads } = recordingClient(none);
    await runFaked(6000, () => tapsmithExpect(new ElementHandle(client, _text('X'), 5000)).toBeVisible({ timeout: 5000 }));
    expect(gaps(reads).slice(0, EXPECT_GAPS.length)).toEqual(EXPECT_GAPS);
  });

  it('expect.poll() defaults to the same intervals', async () => {
    const calls: number[] = [];
    // expect.poll()'s matchers are typed as the generic (sync) ones but return a promise.
    await runFaked(6000, async () => {
      await (tapsmithExpect.poll(() => { calls.push(Date.now()); return 0; }, { timeout: 5000 }).toBe(1) as unknown as Promise<void>);
    });
    expect(gaps(calls).slice(0, EXPECT_GAPS.length)).toEqual(EXPECT_GAPS);
  });
});

describe('WebView locator loops back off like Playwright (PILOT-972)', () => {
  const emptyProbe: WebViewLocatorProbe = { count: 0, anyVisible: false, targetVisible: false, sample: [] };

  it('a locator action re-reads a missing element on the action schedule', async () => {
    const handle = new WebViewHandle({} as TapsmithGrpcClient, 0, 2500);
    const reads: number[] = [];
    vi.spyOn(handle, '_probeLocator').mockImplementation(async () => { reads.push(Date.now()); return emptyProbe; });
    await runFaked(3000, () => handle._resolveLocatorStrict(handle.locator('#missing')));
    expect(gaps(reads).slice(0, ACTION_GAPS.length)).toEqual(ACTION_GAPS);
  });

  it('a CSS selector wait re-reads on the action schedule', async () => {
    const handle = new WebViewHandle({} as TapsmithGrpcClient, 0, 2500);
    const reads: number[] = [];
    vi.spyOn(handle, '_evaluate').mockImplementation(async () => { reads.push(Date.now()); return false; });
    await runFaked(3000, () => handle._waitForSelector('#missing'));
    expect(gaps(reads).slice(0, ACTION_GAPS.length)).toEqual(ACTION_GAPS);
  });
});
