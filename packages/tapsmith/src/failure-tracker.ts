/**
 * `maxFailures` / `--max-failures` / `-x`: counts a run's failed tests and
 * says when it has had enough of them.
 *
 * A reporter, so it sees the results of every way a `tapsmith test` run
 * executes (sequential, parallel workers, several device targets) in one
 * place. The run path asks `reached` between tests and files; nothing is
 * interrupted, so hooks still clean up on the device.
 */

import type { TapsmithReporter } from './reporter.js';
import type { TestResult } from './runner.js';
import { isRecoverableInfrastructureError } from './worker-protocol.js';

export class FailureTracker implements TapsmithReporter {
  private readonly _failed = new Set<string>();
  private readonly _onReached: Array<() => void> = [];
  private _reached = false;

  /** @param maxFailures positive: 0 (no limit) needs no tracker. */
  constructor(readonly maxFailures: number) {}

  /** The run has failed enough tests to stop. Never goes back to false. */
  get reached(): boolean {
    return this._reached;
  }

  /** Call `listener` once the limit is reached. Returns an unsubscribe. */
  onReached(listener: () => void): () => void {
    this._onReached.push(listener);
    return () => {
      const i = this._onReached.indexOf(listener);
      if (i >= 0) this._onReached.splice(i, 1);
    };
  }

  onTestEnd(result: TestResult): void {
    if (result.status !== 'failed' || result._willRetry) return;
    // The file may run again and replace this result: it counts when the
    // file ends, if it still stands.
    if (result.error && isRecoverableInfrastructureError(result.error)) return;
    this._count(result);
  }

  /** The file's results as the run keeps them. */
  onTestFileEnd(_filePath: string, results: TestResult[]): void {
    for (const result of results) {
      if (result.status === 'failed') this._count(result);
      // Failed on an attempt of the file that was discarded.
      else this._failed.delete(testKey(result));
    }
  }

  private _count(result: TestResult): void {
    this._failed.add(testKey(result));
    if (this._reached || this._failed.size < this.maxFailures) return;
    this._reached = true;
    for (const listener of [...this._onReached]) listener();
  }
}

function testKey(result: TestResult): string {
  return JSON.stringify([result.project, result.filePath, result.fullName]);
}

/** What a run that stopped early says, in Playwright's words. */
export function stoppedEarlyMessage(maxFailures: number): string {
  return `Testing stopped early after ${maxFailures} maximum allowed failures.`;
}
