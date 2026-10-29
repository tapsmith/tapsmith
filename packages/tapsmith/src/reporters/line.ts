/**
 * Line reporter — concise single-line output.
 *
 * Overwrites the current line with the most recently completed test.
 * Prints full failure details when they occur. More compact than list
 * reporter — good for large test suites.
 */

import type { TapsmithReporter, FullResult, RunStartInfo } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
import type { TestResult } from '../runner.js';
import {
  statusIcon,
  dim,
  bold,
  red,
  formatDuration,
  formatError,
  formatSummaryLine,
  formatFlakySection,
  countFlaky,
  retrySuffix,
  workerTag,
  projectTag,
} from './base.js';

export class LineReporter implements TapsmithReporter {
  private _completed = 0;
  private _isTTY = process.stdout.isTTY ?? false;
  private _parallel = false;
  private _showProjectTags = false;

  onRunStart(config: TapsmithConfig, fileCount: number, info?: RunStartInfo): void {
    this._completed = 0;
    this._parallel = config.workers > 1;
    this._showProjectTags = config.workers > 1 && (config.projects?.length ?? 0) > 1;
    // A merge replays shards' results; it runs no tests and has no file count.
    if (!info?.merge) process.stdout.write(`\nRunning tests from ${fileCount} file(s)\n\n`);
  }

  onTestEnd(test: TestResult): void {
    if (test._willRetry) return;
    this._completed++;

    if (test.status === 'failed') {
      // Print failures immediately so they're not lost
      if (this._isTTY) {
        // Clear current line first
        process.stdout.write('\x1b[2K\r');
      }
      const project = this._showProjectTags ? projectTag(test.project) : '';
      process.stdout.write(`  ${statusIcon('failed')} ${workerTag(test.workerIndex)}${project}${test.fullName}${retrySuffix(test.retry)} ${dim(`(${formatDuration(test.durationMs)})`)}\n`);
      if (test.error) {
        process.stdout.write(formatError(test.error) + '\n');
      }
      return;
    }

    if (this._isTTY) {
      // Overwrite the current line with latest passed/skipped test
      const icon = statusIcon(test.status);
      const duration = dim(`(${formatDuration(test.durationMs)})`);
      const worker = workerTag(test.workerIndex);
      const project = this._showProjectTags ? projectTag(test.project) : '';
      const line = `  ${icon} [${this._completed}] ${worker}${project}${test.fullName}${retrySuffix(test.retry)} ${duration}`;
      // Truncate to terminal width
      const maxWidth = process.stdout.columns ?? 80;
      const truncated = line.length > maxWidth ? line.slice(0, maxWidth - 1) + '…' : line;
      process.stdout.write(`\x1b[2K\r${truncated}`);
    }
  }

  onTestFileRetry(_filePath: string, discardedCount: number): void {
    if (this._parallel) return;
    this._completed = Math.max(0, this._completed - discardedCount);
  }

  onRunEnd(result: FullResult): void {
    const passed = result.tests.filter((t) => t.status === 'passed').length;
    const failed = result.tests.filter((t) => t.status === 'failed').length;
    const skipped = result.tests.filter((t) => t.status === 'skipped').length;
    const flaky = countFlaky(result.tests);

    // Clear the progress line
    if (this._isTTY) {
      process.stdout.write('\x1b[2K\r');
    }

    process.stdout.write('\n');

    // Re-print failure summary
    const failedTests = result.tests.filter((t) => t.status === 'failed');
    if (failedTests.length > 0) {
      process.stdout.write(bold(red('Failures:\n\n')));
      for (const test of failedTests) {
        const project = this._showProjectTags ? projectTag(test.project) : '';
        process.stdout.write(`  ${red('✗')} ${workerTag(test.workerIndex)}${project}${test.fullName}\n`);
        if (test.error) {
          process.stdout.write(formatError(test.error) + '\n\n');
        }
      }
    }

    if (flaky > 0) {
      process.stdout.write(formatFlakySection(result.tests, {
        showWorkerTags: this._parallel,
        showProjectTags: this._showProjectTags,
      }) + '\n');
    }

    process.stdout.write(formatSummaryLine(passed, failed, skipped, result.duration, result.setupDuration, flaky) + '\n\n');
  }
}
