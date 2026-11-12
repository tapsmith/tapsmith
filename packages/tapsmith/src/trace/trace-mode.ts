/**
 * Trace mode decision logic.
 *
 * Pure functions that determine whether to record/retain a trace for a given
 * test based on the configured trace mode, retry count, and test result.
 */

import type { TraceMode } from './types.js';
import type { VideoMode } from '../video/types.js';

/**
 * Whether tracing should be active (recording) for this test attempt.
 *
 * @param mode - The configured trace mode.
 * @param attempt - Current attempt number (0 = first run, 1 = first retry, etc.).
 */
export function shouldRecord(mode: TraceMode, attempt: number): boolean {
  switch (mode) {
    case 'off':
      return false;
    case 'on':
    case 'retain-on-failure':
    case 'retain-on-first-failure':
    case 'retain-on-failure-and-retries':
      return true;
    case 'on-first-retry':
      return attempt === 1;
    case 'on-all-retries':
      return attempt > 0;
    default:
      return false;
  }
}

/**
 * Whether this mode records exclusively on retry attempts. Such modes can
 * never produce an artifact when `retries` is 0 — callers should warn at
 * run start rather than silently recording nothing.
 */
export function recordsOnlyOnRetry(mode: TraceMode): boolean {
  return mode === 'on-first-retry' || mode === 'on-all-retries';
}

/**
 * Whether to keep the trace file after the test completes.
 *
 * @param mode - The configured trace mode.
 * @param passed - Whether the test passed.
 * @param attempt - Current attempt number.
 */
export function shouldRetain(
  mode: TraceMode,
  passed: boolean,
  attempt: number,
): boolean {
  switch (mode) {
    case 'off':
      return false;
    case 'on':
    case 'on-first-retry':
    case 'on-all-retries':
      // These modes always keep traces when recording is active
      return true;
    case 'retain-on-failure':
      return !passed;
    case 'retain-on-first-failure':
      return !passed && attempt === 0;
    case 'retain-on-failure-and-retries':
      // Keep the trace for any run that failed OR that is a retry (attempt > 0).
      // For a flaky test (fail then pass on retry) this retains both the
      // failing first run and the passing retry, so they can be compared.
      return !passed || attempt > 0;
    default:
      return false;
  }
}

/**
 * The trace mode UI mode records under: UI mode never retries a failed test
 * (PILOT-1175), so a retry-only mode would record nothing, and the live view
 * is built from the trace; it records every test as `on` instead.
 */
export function uiModeTraceMode(mode: TraceMode): TraceMode {
  return recordsOnlyOnRetry(mode) ? 'on' : mode;
}

/**
 * The startup warning for a retry-only trace or video mode that will record
 * nothing in this run, or `undefined` (PILOT-240). UI mode never retries a
 * failed test and records a retry-only trace mode as `on` (PILOT-1175), so
 * there a trace mode never warns and a retry-only video mode always does.
 *
 * @param scope - Appended after the retry count, e.g. ` in project "android"`.
 */
export function retryOnlyModeWarning(
  artifact: 'trace' | 'video',
  mode: TraceMode | VideoMode,
  retries: number,
  uiMode: boolean,
  scope: string,
): string | undefined {
  if (!recordsOnlyOnRetry(mode)) return undefined;
  if (uiMode) {
    if (artifact === 'trace') return undefined;
    return `Warning: ${artifact} mode '${mode}' only records retry attempts, and UI mode never retries a failed test — no ${artifact} will be recorded in UI mode.`;
  }
  if (retries > 0) return undefined;
  return `Warning: ${artifact} mode '${mode}' only records retry attempts, but retries is 0${scope} — no ${artifact} will ever be recorded. Set retries to 1 or more to get ${artifact}s.`;
}
