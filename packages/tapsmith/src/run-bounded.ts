// ─── Bounded runs: the test timeout for test bodies and hooks ───
//
// The runner bounds a test body with the test timeout, and (PILOT-583) each
// beforeAll / beforeEach / afterEach / afterAll hook with a budget of its own
// of the same length. Both go through `runBounded`, so a hook times out
// exactly as a test body does:
//
// - Time spent inside progress-tracked device actions does not count: those
//   actions carry their own bounded deadlines (agent budgets, gRPC deadlines,
//   daemon-side recovery caps up to ~7 minutes for a deep link that rides out
//   a simulator reboot), so a CoreSimulator stall that stretches one of them
//   must not consume the whole budget while the framework is actively — and
//   successfully — recovering. The wall clock still caps the run
//   (WALL_CAP_MULTIPLIER × the timeout), so a loop of bounded actions cannot
//   run unbounded.
// - The run cannot be cancelled (`Promise.race` only abandons it), so it runs
//   inside an attempt-fence context: once it is abandoned the token is closed
//   and any device RPC the "zombie" still issues rejects at once instead of
//   racing whatever runs next on the shared device.
// - Optionally raced against the run's abort signal, so a user stop
//   interrupts even pure-JS waits that never touch the device.

import { onActionProgress } from './action-progress.js';
import { TestAbortedError } from './abort.js';
import { runInAttemptContext, type AttemptToken } from './attempt-fence.js';
import type { TraceCollector } from './trace/trace-collector.js';
import type { SourceLocation } from './trace/types.js';

const WALL_CAP_MULTIPLIER = 5;

const RUNNER_TIMEOUT_BRAND = Symbol.for('tapsmith.RunnerTimeoutError');

/** True for the error {@link runBounded} rejects with when the budget runs out. */
export function isRunnerTimeoutError(err: unknown): err is Error {
  return err instanceof Error && (err as unknown as Record<symbol, unknown>)[RUNNER_TIMEOUT_BRAND] === true;
}

export interface BoundedRunOptions {
  /** What ran out of time, as the message's subject: `Test`, `"beforeEach" hook at a.test.ts:12`. */
  subject: string;
  timeoutMs: number;
  /** Fence token for the run's async context. */
  token: AttemptToken;
  /**
   * Close the token once the run settles in any way (a test body: nothing it
   * left behind may drive the device after the attempt). Without it the token
   * is closed only when the run is abandoned (timeout or stop) — a hook that
   * finished may have started work the test awaits.
   */
  closeOnSettle: boolean;
  /** Read at timeout for the in-flight traced operation's user-code frames. */
  traceCollector: TraceCollector | null;
  /** Frames for the timeout error when no traced operation is in flight. */
  fallbackStack?: SourceLocation[];
  /**
   * Raced as well: a stop rejects with TestAbortedError. Omitted for
   * afterEach / afterAll hooks, which must still run after a stop.
   */
  abortSignal?: AbortSignal;
}

/** Run `fn` under the test-timeout machinery described above. */
export async function runBounded<T>(fn: () => Promise<T>, o: BoundedRunOptions): Promise<T> {
  const { subject, timeoutMs, token, abortSignal } = o;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let abandoned = false;
  // Subscribe BEFORE creating the run's promise: it executes synchronously
  // up to its first await, so a device action as the first statement emits
  // its start event during creation.
  const excluded = { totalMs: 0, depth: 0, inFlightSince: 0 };
  const unsubscribeProgress = onActionProgress((ev) => {
    if (ev.kind === 'start') {
      if (excluded.depth++ === 0) excluded.inFlightSince = Date.now();
    } else if (ev.kind === 'end' && excluded.depth > 0) {
      if (--excluded.depth === 0) excluded.totalMs += Date.now() - excluded.inFlightSince;
    }
  });
  const start = Date.now();
  const runPromise = runInAttemptContext(token, fn);
  // The race may abandon the run; its eventual rejection (fenced device
  // calls) must not surface as an unhandled rejection.
  runPromise.catch(() => {});
  try {
    return await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        // A timeout Error's own stack is just this timer callback plus node
        // timer internals — useless to the user. Re-point it at the operation
        // that was in flight when time ran out (its user-code frames were
        // registered via setPendingOperation), or else at the fallback (a
        // hook's registration line), so reporters render a snippet of user
        // code, not framework code. Read here, before the caller's
        // failPendingOperation clears the registration.
        const timeoutError = (message: string): Error => {
          abandoned = true;
          const err = new Error(message);
          (err as unknown as Record<symbol, unknown>)[RUNNER_TIMEOUT_BRAND] = true;
          const pending = o.traceCollector?.pendingOperationStack;
          const frames = pending && pending.length > 0 ? pending : o.fallbackStack;
          if (frames && frames.length > 0) {
            err.stack = `Error: ${message}\n`
              + frames.map((f) => `    at ${f.file}:${f.line}:${f.column ?? 1}`).join('\n');
          }
          return err;
        };
        const check = (): void => {
          const wallMs = Date.now() - start;
          const inFlightMs = excluded.depth > 0 ? Date.now() - excluded.inFlightSince : 0;
          const countedMs = wallMs - excluded.totalMs - inFlightMs;
          if (countedMs >= timeoutMs) {
            reject(timeoutError(
              `${subject} timed out after ${timeoutMs}ms`
              + (wallMs - countedMs > 1_000
                ? ` (${Math.round(wallMs / 1000)}s wall clock; ${Math.round((wallMs - countedMs) / 1000)}s inside device actions excluded)`
                : ''),
            ));
            return;
          }
          if (wallMs >= timeoutMs * WALL_CAP_MULTIPLIER) {
            reject(timeoutError(
              `${subject} timed out after ${Math.round(wallMs / 1000)}s wall clock `
              + `(cap: ${WALL_CAP_MULTIPLIER}× the ${timeoutMs}ms test timeout; `
              + `${Math.round((wallMs - countedMs) / 1000)}s inside device actions)`,
            ));
            return;
          }
          // Re-arm for what is left of the budget, not a whole budget: a
          // timer may fire a millisecond before Date.now() says its delay has
          // passed, and a full re-arm then let a run overrun by up to the
          // whole budget again and finish as if it had been in time.
          const remainingMs = Math.min(timeoutMs - countedMs, timeoutMs * WALL_CAP_MULTIPLIER - wallMs);
          timer = setTimeout(check, Math.max(1, Math.min(1_000, remainingMs)));
        };
        timer = setTimeout(check, Math.min(1_000, timeoutMs));
      }),
      ...(abortSignal ? [new Promise<never>((_, reject) => {
        // An already-aborted signal never fires 'abort' for new listeners —
        // reject straight away in that case.
        if (abortSignal.aborted) {
          abandoned = true;
          reject(new TestAbortedError());
          return;
        }
        onAbort = () => {
          abandoned = true;
          reject(new TestAbortedError());
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
      })] : []),
    ]);
  } finally {
    if (o.closeOnSettle || abandoned) token.closed = true;
    // Cleared here (not via runPromise.finally) so a stop settling the race
    // doesn't leave a long-lived timer behind.
    if (timer) clearTimeout(timer);
    unsubscribeProgress();
    if (onAbort) abortSignal?.removeEventListener('abort', onAbort);
  }
}
