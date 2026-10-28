import { describe, it, expect, afterEach, vi } from 'vitest';

import { runBounded, isRunnerTimeoutError } from '../run-bounded.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runBounded', () => {
  // A timer can fire a millisecond or so before `Date.now()` says its delay
  // has passed (libuv's loop clock and the wall clock round differently). The
  // budget check then sees "just under" the budget; re-arming it for a whole
  // further budget let a run that overran by less than that finish and pass.
  it('times out a run that overruns its budget even when the first check fires a little early', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fakeNow = Date.now.bind(Date);
    let calls = 0;
    // The first reading (the run's start) is 5 ms ahead, as if the check's
    // timer fired 5 ms early relative to the wall clock.
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow() + (calls++ === 0 ? 5 : 0));

    const timeoutMs = 100;
    let settled: unknown = 'pending';
    // A run that never settles: the only timer is runBounded's own check.
    void runBounded(() => new Promise<never>(() => {}), {
      subject: 'Test',
      timeoutMs,
      token: { closed: false },
      closeOnSettle: true,
      traceCollector: null,
    }).then(() => { settled = 'resolved'; }, (e: unknown) => { settled = e; });

    // The first check, at 100 ms, counts 95 ms. The rest of the budget is
    // 5 ms, so the run times out well before 150 ms; re-arming a whole budget
    // would not check again until 200 ms.
    await vi.advanceTimersByTimeAsync(150);
    expect(isRunnerTimeoutError(settled)).toBe(true);
  });
});
