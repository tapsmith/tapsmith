/**
 * Dot reporter — minimal CI output.
 *
 * Outputs a single character per test: · passed, F failed, ○ skipped,
 * × retried, ± flaky (passed on retry). Auto-selected in CI.
 */

import type { TapsmithReporter, FullResult } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
import type { TestResult } from '../runner.js';
import {
  green,
  red,
  yellow,
  bold,
  formatError,
  formatSummaryLine,
  formatFlakySection,
  countFlaky,
  workerTag,
  projectTag,
} from './base.js';

const DOTS_PER_LINE = 80;

export class DotReporter implements TapsmithReporter {
  private _column = 0;
  private _showProjectTags = false;

  onRunStart(config: TapsmithConfig, _fileCount: number): void {
    this._column = 0;
    this._showProjectTags = config.workers > 1 && (config.projects?.length ?? 0) > 1;
    process.stdout.write('\n');
  }

  onTestEnd(test: TestResult): void {
    let char: string;
    if (test._willRetry) {
      // Intermediate failure that will be retried
      char = yellow('×');
    } else if (test.status === 'passed' && test.retry != null && test.retry > 0) {
      // Flaky: passed on retry
      char = yellow('±');
    } else {
      switch (test.status) {
        case 'passed':
          char = green('·');
          break;
        case 'failed':
          char = red('F');
          break;
        case 'skipped':
          char = yellow('○');
          break;
      }
    }

    process.stdout.write(char);
    this._column++;

    if (this._column >= DOTS_PER_LINE) {
      process.stdout.write('\n');
      this._column = 0;
    }
  }

  onRunEnd(result: FullResult): void {
    const failedTests = result.tests.filter((t) => t.status === 'failed');
    const passed = result.tests.filter((t) => t.status === 'passed').length;
    const failed = failedTests.length;
    const skipped = result.tests.filter((t) => t.status === 'skipped').length;
    const flaky = countFlaky(result.tests);

    // End the dot line
    if (this._column > 0) {
      process.stdout.write('\n');
    }

    process.stdout.write('\n');

    // Print failure details
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
        showWorkerTags: true,
        showProjectTags: this._showProjectTags,
      }) + '\n');
    }

    process.stdout.write(formatSummaryLine(passed, failed, skipped, result.duration, result.setupDuration, flaky) + '\n\n');
  }
}
