/**
 * Opt-in timing lines for performance investigation, the SDK's half of the
 * daemon's `timing.rs`: when `TAPSMITH_TIMING_LOG` names a file, each call
 * appends one `[TIMING] pid=<n> <fields>` line to it, in the same format, so
 * one log holds both sides of a session start (PILOT-1134). Unset, it does
 * nothing. Never throws: a timing line is never worth failing a run over.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ENV = 'TAPSMITH_TIMING_LOG';

/** Append `[TIMING] pid=<pid> <fields>` to the timing log, if one is set. */
export function timingLog(fields: string): void {
  const file = process.env[ENV];
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // One write per line: O_APPEND keeps concurrent writers' lines whole.
    fs.appendFileSync(file, `[TIMING] pid=${process.pid} ${fields}\n`);
  } catch {
    // Best-effort, like the daemon's.
  }
}
