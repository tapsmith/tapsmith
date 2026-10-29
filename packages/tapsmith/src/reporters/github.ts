/**
 * GitHub Actions reporter — workflow annotations.
 *
 * Outputs GitHub Actions workflow commands to create annotations on
 * failed tests. Test failures appear as annotations on the PR/commit.
 * Auto-activates when GITHUB_ACTIONS env var is detected.
 *
 * Annotations are emitted once at run end, when results are final (past
 * any file-level infrastructure retries). GitHub collects `::error::`
 * commands from anywhere in the log, and emitting them mid-run made them
 * interleave confusingly with the console reporter's stream at file
 * boundaries — long after the ✗ line they belonged to.
 */

import type { TapsmithReporter, FullResult } from '../reporter.js';
import type { TestResult } from '../runner.js';
import { countFlaky } from './base.js';

export class GitHubActionsReporter implements TapsmithReporter {
  async onRunEnd(result: FullResult): Promise<void> {
    const passed = result.tests.filter((t) => t.status === 'passed').length;
    const failed = result.tests.filter((t) => t.status === 'failed').length;
    const skipped = result.tests.filter((t) => t.status === 'skipped').length;
    const flakyTests = result.tests.filter(
      (t) => t.status === 'passed' && t.retry != null && t.retry > 0,
    );
    const flaky = countFlaky(result.tests);

    // Failures annotate as errors; flaky tests as warnings carrying the
    // first failed attempt's error so the flake is diagnosable from the
    // PR checks UI without opening the log.
    for (const test of result.tests) {
      if (test.status === 'failed' && test.error) {
        emitAnnotation('error', test, test.error);
      }
    }
    for (const test of flakyTests) {
      if (test.firstAttemptError) {
        emitAnnotation('warning', test, test.firstAttemptError, 'flaky: ');
      }
    }
    for (const test of result.tests) {
      for (const warning of test.warnings ?? []) {
        // No stack: the location would be this reporter's own frame.
        emitAnnotation('warning', test, Object.assign(new Error(warning), { stack: undefined }), 'warning: ');
      }
    }

    // Write a summary using GitHub Actions job summary
    if (process.env.GITHUB_STEP_SUMMARY) {
      const summaryLines: string[] = [];
      summaryLines.push('## Tapsmith Test Results');
      summaryLines.push('');
      summaryLines.push(`| Status | Count |`);
      summaryLines.push(`| --- | --- |`);
      summaryLines.push(`| Passed | ${passed} |`);
      if (flaky > 0) summaryLines.push(`| Flaky | ${flaky} |`);
      summaryLines.push(`| Failed | ${failed} |`);
      summaryLines.push(`| Skipped | ${skipped} |`);
      summaryLines.push(`| Duration | ${(result.duration / 1000).toFixed(2)}s |`);

      if (failed > 0) {
        summaryLines.push('');
        summaryLines.push('### Failures');
        summaryLines.push('');
        for (const test of result.tests) {
          if (test.status === 'failed' && test.error) {
            const workerInfo = test.workerIndex != null ? ` (worker ${test.workerIndex})` : '';
            summaryLines.push(`- **${test.fullName}${workerInfo}**: ${test.error.message}`);
          }
        }
      }

      if (flakyTests.length > 0) {
        summaryLines.push('');
        summaryLines.push('### Flaky (passed on retry)');
        summaryLines.push('');
        for (const test of flakyTests) {
          const workerInfo = test.workerIndex != null ? ` (worker ${test.workerIndex})` : '';
          const cause = test.firstAttemptError ? `: ${test.firstAttemptError.message}` : '';
          summaryLines.push(`- **${test.fullName}${workerInfo}**${cause}`);
        }
      }

      try {
        const nodeFs = await import('node:fs');
        nodeFs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLines.join('\n') + '\n');
      } catch {
        // Best-effort summary writing
      }
    }
  }
}

function emitAnnotation(
  level: 'error' | 'warning',
  test: TestResult,
  error: Error,
  titlePrefix = '',
): void {
  // Extract file/line from stack trace if possible
  const location = extractLocation(error);
  const locationPart = location ? ` file=${location.file},line=${location.line}` : '';

  // Escape the message for GitHub Actions
  const message = escapeGitHub(error.message);

  const workerSuffix = test.workerIndex != null ? ` (worker ${test.workerIndex})` : '';
  process.stdout.write(
    `::${level}${locationPart} title=${escapeGitHub(titlePrefix + test.fullName + workerSuffix)}::${message}\n`,
  );
}

function extractLocation(error: Error): { file: string; line: number } | null {
  if (!error.stack) return null;

  // Look for stack frames like "at ... (file:line:col)" or "at file:line:col"
  const lines = error.stack.split('\n');
  for (const line of lines) {
    // Match: "at Something (/path/to/file.ts:42:10)"
    const match = line.match(/\(([^)]+):(\d+):\d+\)/) ?? line.match(/at\s+([^:]+):(\d+):\d+/);
    if (match) {
      const file = match[1];
      const lineNum = parseInt(match[2], 10);
      // Only use test file paths: skip node internals, installed tapsmith
      // (node_modules) and the monorepo SDK source (/packages/tapsmith/) —
      // otherwise assertion failures annotate expect.ts instead of the test.
      if (
        !file.includes('node_modules') &&
        !file.startsWith('node:') &&
        !file.includes('/packages/tapsmith/')
      ) {
        return { file, line: lineNum };
      }
    }
  }

  return null;
}

function escapeGitHub(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
