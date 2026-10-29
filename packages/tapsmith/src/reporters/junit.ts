/**
 * JUnit XML reporter — CI/CD integration.
 *
 * Generates JUnit-style XML that CI systems (Jenkins, GitHub Actions,
 * GitLab CI, CircleCI, etc.) can ingest for test result display.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TapsmithReporter, FullResult } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';

export class JUnitReporter implements TapsmithReporter {
  private _outputFile: string;
  private _config?: TapsmithConfig;
  private _startTime = new Date();

  constructor(options: Record<string, unknown> = {}) {
    this._outputFile = (options.outputFile as string) ?? 'tapsmith-results/results.xml';
  }

  onRunStart(config: TapsmithConfig, _fileCount: number): void {
    this._config = config;
    this._startTime = new Date();
  }

  async onRunEnd(result: FullResult): Promise<void> {
    const failed = result.tests.filter((t) => t.status === 'failed').length;
    const skipped = result.tests.filter((t) => t.status === 'skipped').length;
    const durationSec = (result.duration / 1000).toFixed(3);

    const lines: string[] = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push(
      `<testsuites name="Tapsmith" tests="${result.tests.length}" ` +
      `failures="${failed}" skipped="${skipped}" ` +
      `time="${durationSec}" timestamp="${this._startTime.toISOString()}">`
    );

    // Group tests by file (using the suite name from the top-level suites)
    // Each top-level suite becomes a <testsuite>
    if (result.suites.length > 0) {
      for (const suite of result.suites) {
        const suiteTests = flattenTests(suite);
        const suiteFailed = suiteTests.filter((t) => t.status === 'failed').length;
        const suiteSkipped = suiteTests.filter((t) => t.status === 'skipped').length;
        const suiteDuration = (suite.durationMs / 1000).toFixed(3);

        lines.push(
          `  <testsuite name="${escapeXml(suite.name)}" tests="${suiteTests.length}" ` +
          `failures="${suiteFailed}" skipped="${suiteSkipped}" time="${suiteDuration}">`
        );

        for (const test of suiteTests) {
          const testDuration = (test.durationMs / 1000).toFixed(3);
          lines.push(
            `    <testcase name="${escapeXml(test.fullName)}" ` +
            `classname="${escapeXml(suite.name)}" time="${testDuration}">`
          );

          if (test.status === 'skipped') {
            lines.push('      <skipped/>');
          } else if (test.status === 'failed' && test.error) {
            const message = escapeXml(test.error.message);
            const stack = test.error.stack ? escapeXml(test.error.stack) : '';
            lines.push(`      <failure message="${message}">${stack}</failure>`);
          }

          const props: string[] = [];
          if (test.project) {
            props.push(`<property name="project" value="${escapeXml(test.project)}"/>`);
          }
          if (test.workerIndex != null) {
            props.push(`<property name="workerIndex" value="${test.workerIndex}"/>`);
          }
          if (test.retry != null) {
            props.push(`<property name="retry" value="${test.retry}"/>`);
          }
          if (props.length > 0) {
            lines.push(`      <properties>${props.join('')}</properties>`);
          }

          if (test.screenshotPath) {
            lines.push(
              `      <system-out>Screenshot: ${escapeXml(test.screenshotPath)}</system-out>`
            );
          }

          lines.push('    </testcase>');
        }

        lines.push('  </testsuite>');
      }
    } else {
      // Fallback: all tests in a single suite
      lines.push(
        `  <testsuite name="Tapsmith" tests="${result.tests.length}" ` +
        `failures="${failed}" skipped="${skipped}" time="${durationSec}">`
      );
      for (const test of result.tests) {
        const testDuration = (test.durationMs / 1000).toFixed(3);
        lines.push(
          `    <testcase name="${escapeXml(test.fullName)}" ` +
          `classname="Tapsmith" time="${testDuration}">`
        );
        if (test.status === 'skipped') {
          lines.push('      <skipped/>');
        } else if (test.status === 'failed' && test.error) {
          const message = escapeXml(test.error.message);
          const stack = test.error.stack ? escapeXml(test.error.stack) : '';
          lines.push(`      <failure message="${message}">${stack}</failure>`);
        }
        lines.push('    </testcase>');
      }
      lines.push('  </testsuite>');
    }

    lines.push('</testsuites>');
    lines.push('');

    const outputPath = path.resolve(this._config?.rootDir ?? process.cwd(), this._outputFile);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, lines.join('\n'));
  }
}

import type { SuiteResult, TestResult } from '../runner.js';

function flattenTests(suite: SuiteResult): TestResult[] {
  const results: TestResult[] = [...suite.tests];
  for (const child of suite.suites) {
    results.push(...flattenTests(child));
  }
  return results;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
