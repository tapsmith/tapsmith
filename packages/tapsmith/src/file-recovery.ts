import { collectResults, markFileRetryFlakes, takeDeferredNotRunResults, type SuiteResult, type TestResult } from './runner.js';
import { isRecoverableInfrastructureError } from './worker-protocol.js';

// ─── Sequential file recovery ───

/** One file's run with session recovery, for {@link runFileWithSessionRecovery}. */
export interface FileRecoveryRun {
  /** The file's name, for the recovery notice. */
  fileName: string
  /**
   * Run the file once. `finalFileAttempt` is the runner option of that name:
   * true on the retry, after which nothing re-runs the file.
   */
  runAttempt: (finalFileAttempt: boolean) => Promise<SuiteResult>
  /** Recover every device session before the retry. */
  recover: () => Promise<void>
  /** Where the results the runner held back go when an attempt it reported on is used after all. */
  onTestEnd: (result: TestResult) => void
  /** The recovery notice. */
  log: (message: string) => void
}

/**
 * Run a test file, and once more after recovering the session when it hits an
 * infrastructure error (agent disconnection, gRPC unavailability, …) — the
 * sequential CLI's recovery, as worker-runner.ts's for parallel workers.
 *
 * Every test of the file is in the suite returned: the retry is the runner's
 * last attempt, so it reports the tests an abort leaves unrun; when the first
 * attempt's results are kept instead, the ones it held back are added to them.
 */
export async function runFileWithSessionRecovery(run: FileRecoveryRun): Promise<SuiteResult> {
  let firstAttemptSuite: SuiteResult | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const suite = await run.runAttempt(attempt === 2);
      const fileResults = collectResults(suite);
      const infraFailure = fileResults.find(
        (r) => r.status === 'failed' && r.error && isRecoverableInfrastructureError(r.error),
      );
      if (!infraFailure) {
        // If this is a retry that produced fewer results than the first
        // attempt (e.g. crashed before running any tests), prefer the
        // first attempt's results so the original failure is visible.
        if (attempt === 2 && firstAttemptSuite) {
          const firstResults = collectResults(firstAttemptSuite);
          if (fileResults.length < firstResults.length) {
            return withDeferredNotRun(firstAttemptSuite, run);
          }
          // Tests that failed on the discarded first attempt must surface as
          // flaky, not as clean passes — the summary would otherwise hide
          // that the file was re-run at all.
          markFileRetryFlakes(firstAttemptSuite, suite);
        }
        return suite;
      }
      if (attempt === 2) {
        return suite;
      }
      firstAttemptSuite = suite;
      run.log(`Recovering session after infrastructure error in ${run.fileName}: ${infraFailure.error?.message ?? 'unknown'}`);
      await run.recover();
    } catch (err) {
      if (!isRecoverableInfrastructureError(err) || attempt === 2) {
        // If the retry itself crashed, return the first attempt's results
        // (which contain the original failure) so it's counted in the summary.
        if (firstAttemptSuite) return withDeferredNotRun(firstAttemptSuite, run);
        throw err;
      }
      run.log(`Recovering session after infrastructure error in ${run.fileName}: ${err instanceof Error ? err.message : err}`);
      await run.recover();
    }
  }
  // Unreachable — loop always returns or throws
  throw new Error(`Exhausted recovery attempts for ${run.fileName}`);
}

/** The first attempt's suite with the not-run results it held back, now reported. */
function withDeferredNotRun(suite: SuiteResult, run: FileRecoveryRun): SuiteResult {
  const notRun = takeDeferredNotRunResults(suite);
  for (const result of notRun) {
    suite.tests.push(result);
    run.onTestEnd(result);
  }
  return suite;
}
