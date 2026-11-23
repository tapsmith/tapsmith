/**
 * The network-capture failures already reported to the user this session:
 * the ones this process printed, and the ones an earlier run printed. Watch
 * and MCP runs fork a fresh child per run, so a per-process record alone
 * printed the daemon's whole failure message again on every re-run; the
 * parent hands each child the record and folds back what the child printed,
 * like `installed-builds.ts`. A failure seen in an earlier run is reported in
 * one line instead.
 *
 * Its own module, free of imports, so a parent can carry it without loading
 * the runner.
 */
const printedHere = new Set<string>();
const printedEarlier = new Set<string>();

/** Every capture failure reported this session, for a child the parent forks or for the parent. */
export function knownCaptureFailures(): string[] {
  return [...new Set([...printedEarlier, ...printedHere])];
}

/** Take the failures a parent or a child reported. */
export function rememberCaptureFailures(messages: readonly string[] | undefined): void {
  for (const message of messages ?? []) printedEarlier.add(message);
}

/**
 * How to report this capture failure: `full` the first time this session,
 * `repeat` (one line) the first time in this process when an earlier run
 * already printed it, and `undefined` once this process has reported it.
 */
export function captureFailureNotice(message: string): 'full' | 'repeat' | undefined {
  if (printedHere.has(message)) return undefined;
  printedHere.add(message);
  return printedEarlier.has(message) ? 'repeat' : 'full';
}

/** @internal — For tests: forget everything. */
export function _resetCaptureFailures(): void {
  printedHere.clear();
  printedEarlier.clear();
}
