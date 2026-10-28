import { describe, it, expect, afterEach, vi } from 'vitest';

import { runBounded, isRunnerTimeoutError } from '../run-bounded.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runBounded', () => {
  // A timer can fire a millisecond or so before `Date.now()` says its delay
  // has passed (libuv's loop clock and the wall clock round differently). The
  // budget check then sees "just under" the budget; re-arming it for a whole
  // further budget let a run that overran by less than that finish and pass.
  it('times out a run that overruns its budget even when the first check fires a little early', async () => {
    const realNow = Date.now.bind(Date);
    let calls = 0;
    // The first reading (the run's start) is 5 ms ahead, as if the check's
    // timer fired 5 ms early relative to the wall clock.
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (calls++ === 0 ? 5 : 0));

    const timeoutMs = 100;
    const run = runBounded(() => sleep(timeoutMs * 2), {
      subject: 'Test',
      timeoutMs,
      token: { closed: false },
      closeOnSettle: true,
      traceCollector: null,
    });

    const err = await run.then(() => undefined, (e: unknown) => e);
    expect(isRunnerTimeoutError(err)).toBe(true);
  });
});
