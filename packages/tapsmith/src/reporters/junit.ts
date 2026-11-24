/**
 * JUnit XML reporter — CI/CD integration.
 *
 * Generates JUnit-style XML that CI systems (Jenkins, GitHub Actions,
 * GitLab CI, CircleCI, etc.) can ingest for test result display. The shape
 * follows Playwright's JUnit reporter: one `<testsuite>` per test file (and
 * project), named after the file relative to `rootDir`, with that path as
 * every test case's `classname`, the project as the suite's `hostname`, and
 * attachments listed as `[[ATTACHMENT|path]]` in `<system-out>`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { recordOutputFile } from '../output-ledger.js';
import type { TapsmithReporter, FullResult } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
import type { SuiteResult, TestResult } from '../runner.js';
import { formatError } from './base.js';

/** The suite name used when no test in a file suite says which file it is. */
const FALLBACK_SUITE_NAME = 'Tapsmith';

export class JUnitReporter implements TapsmithReporter {
  private _outputFile: string;
  private _includeProjectInTestName: boolean | undefined;
  private _config?: TapsmithConfig;
  private _startTime = new Date();

  constructor(options: Record<string, unknown> = {}) {
    this._outputFile = (options.outputFile as string) ?? 'tapsmith-results/results.xml';
    const include = options.includeProjectInTestName;
    this._includeProjectInTestName = typeof include === 'boolean' ? include : undefined;
  }

  onRunStart(config: TapsmithConfig, _fileCount: number): void {
    this._config = config;
    this._startTime = new Date();
  }

  async onRunEnd(result: FullResult): Promise<void> {
    const rootDir = this._config?.rootDir ?? process.cwd();
    const outputPath = path.resolve(rootDir, this._outputFile);
    const timestamp = this._startTime.toISOString();

    // With several projects the same test runs once per project; its name
    // carries the project so CI dashboards keyed on classname + name keep the
    // copies apart. The configured projects decide, so a `--project` run or a
    // shard names a test as the full run does; the results decide for a merge
    // whose config lists none. An explicit option wins either way.
    const projects = new Set(result.tests.map((t) => t.project).filter((p) => p !== undefined));
    const prefixProject = this._includeProjectInTestName ?? ((this._config?.projects?.length ?? 0) > 1 || projects.size > 1);

    const suites: string[] = [];
    let total = 0;
    let totalFailures = 0;
    let totalSkipped = 0;
    for (const { tests, name } of fileGroups(result)) {
      if (tests.length === 0) continue;
      const file = suiteFileName(tests, name, rootDir);
      const project = tests.find((t) => t.project !== undefined)?.project;
      const failures = tests.filter((t) => t.status === 'failed').length;
      const skipped = tests.filter((t) => t.status === 'skipped').length;
      const duration = tests.reduce((ms, t) => ms + t.durationMs, 0);
      total += tests.length;
      totalFailures += failures;
      totalSkipped += skipped;

      const lines: string[] = [];
      lines.push(
        `  <testsuite name="${attr(file)}" timestamp="${timestamp}" hostname="${attr(project ?? '')}" `
        + `tests="${tests.length}" failures="${failures}" skipped="${skipped}" `
        + `time="${seconds(duration)}" errors="0">`,
      );
      for (const test of tests) {
        lines.push(...testCase(test, file, prefixProject, outputPath));
      }
      lines.push('  </testsuite>');
      suites.push(lines.join('\n'));
    }

    const lines: string[] = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push(
      `<testsuites name="Tapsmith" tests="${total}" failures="${totalFailures}" skipped="${totalSkipped}" `
      + `errors="0" time="${seconds(result.duration)}" timestamp="${timestamp}">`,
    );
    lines.push(...suites);
    lines.push('</testsuites>');
    lines.push('');

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, lines.join('\n'));
    recordOutputFile(this._config, outputPath);
    process.stderr.write(`JUnit report written to ${outputPath}\n`);
  }
}

// ─── Test cases ───

function testCase(test: TestResult, file: string, prefixProject: boolean, outputPath: string): string[] {
  const name = (prefixProject && test.project ? `[${test.project}] ` : '') + test.fullName;
  const lines: string[] = [];
  lines.push(`    <testcase name="${attr(name)}" classname="${attr(file)}" time="${seconds(test.durationMs)}">`);

  const props: string[] = [];
  if (test.project) props.push(`<property name="project" value="${attr(test.project)}"/>`);
  if (test.workerIndex != null) props.push(`<property name="workerIndex" value="${test.workerIndex}"/>`);
  if (test.retry != null) props.push(`<property name="retry" value="${test.retry}"/>`);
  if (props.length > 0) lines.push(`      <properties>${props.join('')}</properties>`);

  if (test.status === 'skipped') {
    lines.push('      <skipped/>');
  } else if (test.status === 'failed') {
    const error = test.error ?? new Error('Test failed');
    const message = plain(error.message).split('\n').find((l) => l.trim() !== '') ?? '';
    lines.push(`      <failure message="${attr(message.trim())}" type="FAILURE">${cdata(plain(formatError(error, '', Infinity)))}</failure>`);
  }

  // Playwright's attachment format, which the Jenkins JUnit attachments
  // plugin (and others) pick up: paths relative to the report file.
  const out: string[] = [];
  const err: string[] = [];
  for (const attachment of [test.screenshotPath, test.tracePath, test.videoPath]) {
    if (!attachment) continue;
    const relative = toPosix(path.relative(path.dirname(outputPath), attachment));
    if (fs.existsSync(attachment)) out.push(`[[ATTACHMENT|${relative}]]`);
    else err.push(`Warning: attachment ${relative} is missing`);
  }
  if (out.length > 0) lines.push(`      <system-out>${cdata(`\n${out.join('\n')}\n`)}</system-out>`);
  if (err.length > 0) lines.push(`      <system-err>${cdata(`\n${err.join('\n')}\n`)}</system-err>`);

  lines.push('    </testcase>');
  return lines;
}

// ─── Helpers ───

/**
 * The file a root suite stands for, relative to rootDir with forward
 * slashes, as Playwright names its file suites. A suite whose
 * results record no file (a blob from an older version, watch mode's
 * stand-in results) falls back to its own name.
 */
function suiteFileName(tests: TestResult[], suiteName: string, rootDir: string): string {
  const filePath = tests.find((t) => t.filePath)?.filePath;
  if (filePath) return toPosix(path.relative(rootDir, filePath));
  return suiteName || FALLBACK_SUITE_NAME;
}

/**
 * The tests of each file suite: one root suite per file (and project) as the
 * runner reports them, or — for a result that carries only the flat test
 * list — the tests grouped by project and file in first-seen order.
 */
function fileGroups(result: FullResult): { name: string; tests: TestResult[] }[] {
  if (result.suites.length > 0) {
    return result.suites.map((suite) => ({ name: suite.name, tests: flattenTests(suite) }));
  }
  const groups = new Map<string, { name: string; tests: TestResult[] }>();
  for (const test of result.tests) {
    const key = JSON.stringify([test.project ?? null, test.filePath ?? null]);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { name: '', tests: [] });
    group.tests.push(test);
  }
  return [...groups.values()];
}

function flattenTests(suite: SuiteResult): TestResult[] {
  return [...suite.tests, ...suite.suites.flatMap(flattenTests)];
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

// Characters XML 1.0 cannot hold, plus the C1 controls it discourages (as
// Playwright's reporter strips them).
const DISALLOWED_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;

/** Terminal colours and other escapes removed, then anything XML cannot hold. */
function plain(s: string): string {
  return stripVTControlCharacters(s).replace(DISALLOWED_XML_CHARS, '');
}

function attr(s: string): string {
  return plain(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(s: string): string {
  return `<![CDATA[${plain(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}
