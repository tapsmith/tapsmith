/**
 * How long the SDK's host-side retry loops wait between reads (PILOT-972).
 *
 * The loops used to sleep a flat 250 ms between reads. The first read
 * usually misses right after a navigation, and the next one would mostly
 * have succeeded far sooner, so a flat sleep made most actions and
 * assertions wait for nothing. These are Playwright's schedules: re-read
 * quickly at first, then back off so a long wait does not keep a slow
 * device busy reading.
 *
 * @module
 */

// ─── Schedules ───

/**
 * Delays between the reads of every locator auto-wait loop: action
 * auto-wait, `waitFor`, the presence probes' re-reads, `count()`/`all()`
 * reads, `setChecked`'s verification and the WebView locator loops. The
 * last delay repeats. Playwright's action retry schedule (`_retryAction`).
 * @internal
 */
export const ACTION_RETRY_DELAYS_MS: readonly number[] = Object.freeze([0, 20, 100, 100, 500]);

/**
 * Delays between the reads of the assertion poller after its first,
 * immediate read, and the default `expect.poll()` intervals. The last delay
 * repeats. Playwright's `expect` schedule.
 * @internal
 */
export const EXPECT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([100, 250, 500, 1000]);

// ─── Helpers ───

/**
 * A fresh walk through `schedule`: each call returns the next delay (the
 * last one repeats). With a `deadline` (epoch ms) the delay is capped at what
 * is left of it, floored at 0 — the schedule still advances, so a capped
 * delay is not retried at the same step. Every loop takes its own instance,
 * so each call of an API starts at the quick end of the ramp.
 * @internal
 */
export function backoff(schedule: readonly number[]): (deadline?: number) => number {
  if (schedule.length === 0) throw new Error('A retry schedule needs at least one delay');
  let retry = 0;
  return (deadline?: number) => {
    const delay = schedule[Math.min(retry, schedule.length - 1)];
    retry++;
    return deadline === undefined ? delay : Math.min(delay, Math.max(0, deadline - Date.now()));
  };
}

/**
 * How many reads a loop following `schedule` fits into `durationMs`, taking
 * each read as instant: the trace's `attempts` estimate for an assertion,
 * whose poller does not report its own count. Always at least 1.
 * @internal
 */
export function estimateAttempts(durationMs: number, schedule: readonly number[]): number {
  if (schedule.length === 0) return 1;
  let attempts = 1;
  let elapsed = 0;
  for (let retry = 0; ; retry++) {
    elapsed += schedule[Math.min(retry, schedule.length - 1)];
    if (elapsed > durationMs) return attempts;
    attempts++;
    // A schedule that repeats 0 would never pass the duration.
    if (retry >= schedule.length - 1 && schedule[schedule.length - 1] === 0) return attempts;
  }
}
