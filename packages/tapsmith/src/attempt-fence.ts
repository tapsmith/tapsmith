// ─── Test-attempt fence ───
//
// A test body that hits the runner's safety timeout cannot be cancelled —
// `Promise.race` only abandons the promise, the async function keeps
// executing. Left unfenced, that "zombie" body keeps driving the shared
// device while the next attempt (or the next test) is already running:
// its taps land mid-retry, its trace events pollute the new attempt's
// collector, and state-mutating calls (saveAppState) race the retry's
// setup. Seen in the wild: a timed-out auth setup saved app state while
// its retry was mid `launchApp({ clearData: true })`.
//
// The fence gives each attempt an AsyncLocalStorage token. The runner
// closes the token as soon as the attempt settles; any device RPC issued
// from that attempt's async context afterwards rejects immediately with
// TestEndedError, and trace writes from it are dropped. Runner code and
// later attempts run outside the token (or under a fresh one) and are
// unaffected. Each hook call runs under a token of its own, closed only if
// the hook times out (PILOT-583).

import { AsyncLocalStorage } from 'node:async_hooks';

/** @internal Brand key for cross-instance type checks (CJS/ESM dual-package). */
export const TEST_ENDED_ERROR_BRAND = Symbol.for('tapsmith.TestEndedError');

/** @internal Mutable token identifying one test attempt's async context. */
export interface AttemptToken {
  closed: boolean;
}

const attemptStorage = new AsyncLocalStorage<AttemptToken>();

/**
 * Thrown when a device command is issued from a test attempt that has
 * already ended (typically a body that kept running after its timeout).
 * Distinguishable from ordinary failures so retry/recovery logic never
 * treats a fenced call as an infrastructure error.
 */
export class TestEndedError extends Error {
  /** @internal */
  readonly [TEST_ENDED_ERROR_BRAND] = true;

  constructor(what = 'device command') {
    super(
      `Test attempt has already ended — ${what} rejected. ` +
      'The test body kept running after the attempt settled (typically a ' +
      'timeout, or a promise the test never awaited); this late call was ' +
      'fenced so it cannot interfere with the retry or the next test.',
    );
    this.name = 'TestEndedError';
  }
}

/** Returns true if `err` is a {@link TestEndedError} (brand-based, safe across CJS/ESM copies). */
export function isTestEndedError(err: unknown): err is TestEndedError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[TEST_ENDED_ERROR_BRAND] === true
  );
}

/**
 * @internal Run a test body inside an attempt context. Everything the body
 * awaits (and every continuation it leaks past its own settlement) inherits
 * the token via AsyncLocalStorage.
 */
export function runInAttemptContext<T>(token: AttemptToken, fn: () => Promise<T>): Promise<T> {
  return attemptStorage.run(token, fn);
}

/**
 * @internal Run `fn` outside any attempt context: for long-lived resources a
 * test body happens to create (the network route stream, PILOT-775), whose
 * callbacks would otherwise run as that attempt — closed once it ends, so
 * fenced — in every later test.
 */
export function runOutsideAttempt<T>(fn: () => T): T {
  return attemptStorage.exit(fn);
}

/**
 * @internal The attempt token of the calling async context, if any. Node runs
 * `unhandledRejection` listeners in the context of the promise that rejected,
 * so this tells which attempt left a rejection behind (PILOT-543).
 */
export function currentAttemptToken(): AttemptToken | undefined {
  return attemptStorage.getStore();
}

/**
 * @internal True when the calling async context belongs to a test attempt
 * whose token has been closed. Code outside any attempt context (runner,
 * hooks, reporters) always reads false.
 */
export function isCurrentAttemptClosed(): boolean {
  return attemptStorage.getStore()?.closed === true;
}

/**
 * @internal Build the fence rejection for a call from a closed attempt.
 * The rejection is pre-marked as handled: a zombie's fire-and-forget call
 * has no awaiter, and its rejection must not trip the process-wide
 * unhandledRejection fatal-teardown handlers.
 */
export function fencedRejection<T>(what: string): Promise<T> {
  const rejection = Promise.reject<T>(new TestEndedError(what));
  rejection.catch(() => {});
  return rejection;
}
