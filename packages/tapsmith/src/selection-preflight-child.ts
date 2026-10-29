/**
 * Child process for `tapsmith test`'s checks before any device work: the
 * selection check (PILOT-553) and load failures (PILOT-784).
 *
 * Imports each test file to read its test names — no test body runs — and
 * sends them back over IPC, or the error the file failed to load with. Out of the CLI's process so a test file's
 * top-level code never runs twice there (once here, once for the real run),
 * and so a shared helper's module cache, and whatever it registered while
 * loading, is not left behind for the run.
 */

import { loadErrorForReport } from './load-failure.js';
import { discoverTestFile, type DiscoveredSuite } from './runner.js';
import type { PreflightRequest, PreflightResponse } from './selection-preflight.js';

function testNames(suite: DiscoveredSuite): string[] {
  return [...suite.tests.map((t) => t.fullName), ...suite.suites.flatMap(testNames)];
}

const hello: PreflightResponse = { type: 'pid', pid: process.pid };
process.send?.(hello);

process.once('message', async (msg: PreflightRequest) => {
  const results: Extract<PreflightResponse, { type: 'names' }>['results'] = [];
  for (const file of msg.files) {
    try {
      results.push({ file, names: testNames(await discoverTestFile(file)) });
    } catch (err) {
      // Prepared here, where the loader's error still has its class (a
      // SyntaxError's location is found from it), and once: the parent only
      // rebuilds it.
      const error = loadErrorForReport(err, file);
      results.push({ file, error: { name: error.name, message: error.message, stack: error.stack } });
    }
  }
  const response: PreflightResponse = { type: 'names', results };
  process.send?.(response, () => process.exit(0));
});
