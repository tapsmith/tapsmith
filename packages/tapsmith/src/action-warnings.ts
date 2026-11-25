// ─── Action warnings ───
//
// What an action's answer warned about: today, an iOS tap that may
// only have closed the keyboard (PILOT-1495). A warning is no failure and a
// passing test prints nothing about it; the runner adds the warnings of a
// failed attempt to its result, where they may explain the failure. They are
// kept per gRPC client, which each device has one of.

import * as path from 'node:path';
import { isCurrentAttemptClosed } from './attempt-fence.js';
import type { SourceLocation } from './trace/types.js';

const _pending = new WeakMap<object, string[]>();

/** @internal Keep `warning` for the result of the test that is running. */
export function noteActionWarning(client: object, warning: string): void {
  // The late action of an attempt that already ended is no part of this one.
  if (isCurrentAttemptClosed()) return;
  const list = _pending.get(client);
  if (!list) _pending.set(client, [warning]);
  else if (!list.includes(warning)) list.push(warning);
}

/** @internal The warnings noted on `client` since the last call. */
export function takeActionWarnings(client: object): string[] {
  const list = _pending.get(client) ?? [];
  _pending.delete(client);
  return list;
}

/** @internal The warnings noted on `client` since the last call, as lines of an MCP action tool's answer. */
export function takeWarningLines(client: object): string {
  return takeActionWarnings(client).map((w) => `\nWarning: ${w}`).join('');
}

/** @internal A warning as a test result shows it: which action it is about, and where. */
export function describeActionWarning(
  action: string,
  locator: string,
  warning: string,
  location: SourceLocation | undefined,
): string {
  const at = location ? ` (${path.relative(process.cwd(), location.file) || location.file}:${location.line})` : '';
  return `${action}() on ${locator}${at}: ${warning}`;
}
