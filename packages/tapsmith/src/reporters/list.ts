/**
 * List reporter — detailed per-test output.
 *
 * Prints a line for each test with status, progress counter, name, and
 * duration. Shows error details inline. Default reporter for local runs.
 *
 * In-progress tests are shown as dimmed lines on TTY terminals and
 * cleared when the test completes, matching Playwright's list reporter.
 */

import type { TapsmithReporter, FullResult, RunStartInfo, TestStartInfo } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
import type { TestResult } from '../runner.js';
import {
  statusIcon,
  dim,
  bold,
  red,
  formatDuration,
  formatError,
  formatWarnings,
  formatSummaryLine,
  formatFlakySection,
  countFlaky,
  retrySuffix,
  workerTag,
  projectTag,
} from './base.js';

interface InProgressEntry {
  fullName: string
  filePath: string
  workerIndex?: number
  project?: string
}

type WriteMethod = typeof process.stdout.write;

export class ListReporter implements TapsmithReporter {
  private _testIndex = 0;
  private _multipleWorkers = false;
  private _showProjectTags = false;
  private _isTTY = process.stdout.isTTY ?? false;
  private _rootDir = '';
  private _inProgress: InProgressEntry[] = [];
  private _linesRendered = 0;
  // In single-worker mode the test runs in-process, so its stdout/stderr (e.g.
  // console.log) interleaves with our output between onTestStart and onTestEnd.
  // We intercept those writes to clear and redraw the live in-progress region
  // around them, keeping our cursor math correct. Mirrors LaunchProgress.
  private _originalStdoutWrite?: WriteMethod;
  private _originalStderrWrite?: WriteMethod;
  private _internalWriteDepth = 0;

  onRunStart(config: TapsmithConfig, fileCount: number, info?: RunStartInfo): void {
    this._testIndex = 0;
    this._multipleWorkers = config.workers > 1;
    this._showProjectTags = (config.projects?.length ?? 0) > 1;
    this._rootDir = config.rootDir;
    this._inProgress = [];
    this._linesRendered = 0;
    this._installWriteInterceptors();
    // A merge replays shards' results; it runs no tests and has no file count.
    if (!info?.merge) this._write(`\nRunning tests from ${fileCount} file(s)\n\n`);
  }

  onTestFileStart(_filePath: string): void {
    // File names are shown inline with each test row (Playwright-style).
  }

  onTestStart(fullName: string, filePath?: string, info?: TestStartInfo): void {
    if (this._isTTY) this._clearInProgress();
    this._inProgress.push({
      fullName,
      filePath: filePath ?? '',
      workerIndex: info?.workerIndex,
      project: info?.project,
    });
    if (this._isTTY) this._printInProgress();
  }

  onTestEnd(test: TestResult): void {
    const idx = this._inProgress.findIndex((e) => (
      e.fullName === test.fullName
      && e.filePath === (test.filePath ?? '')
      && (e.workerIndex == null || test.workerIndex == null || e.workerIndex === test.workerIndex)
      && (e.project == null || test.project == null || e.project === test.project)
    ));
    if (idx !== -1) this._inProgress.splice(idx, 1);
    if (this._isTTY) this._clearInProgress();

    if (test._willRetry) {
      const duration = dim(`(${formatDuration(test.durationMs)})`);
      const counter = dim(`[${this._testIndex + 1}]`);
      const worker = this._multipleWorkers ? workerTag(test.workerIndex) : '';
      const project = this._showProjectTags ? projectTag(test.project) : '';
      const file = this._fileSegment(test.filePath);
      this._write(`  ${red('✗')} ${counter} ${worker}${project}${file}${test.fullName}${retrySuffix(test.retry)} ${duration}\n`);
      for (const line of formatWarnings(test)) this._write(line + '\n');
      // The failing attempt's error and artifacts are worth seeing even
      // though a retry is coming — a flaky pass would otherwise hide what
      // actually failed, and this is where they chronologically belong.
      if (test.error) {
        this._write(formatError(test.error) + '\n');
      }
      if (test.screenshotPath) {
        this._write(`        ${dim(`Screenshot: ${test.screenshotPath}`)}\n`);
      }
      if (test.tracePath) {
        this._write(`        ${dim(`Trace: npx tapsmith show-trace ${test.tracePath}`)}\n`);
      }
      if (test.videoPath) {
        this._write(`        ${dim(`Video: ${test.videoPath}`)}\n`);
      }
      if (this._isTTY) this._printInProgress();
      return;
    }

    this._testIndex++;

    const icon = statusIcon(test.status);
    const duration = dim(`(${formatDuration(test.durationMs)})`);
    const counter = dim(`[${this._testIndex}]`);
    const worker = this._multipleWorkers ? workerTag(test.workerIndex) : '';
    const project = this._showProjectTags ? projectTag(test.project) : '';
    const file = this._fileSegment(test.filePath);
    this._write(`  ${icon} ${counter} ${worker}${project}${file}${test.fullName}${retrySuffix(test.retry)} ${duration}\n`);
    for (const line of formatWarnings(test)) this._write(line + '\n');

    if (test.error) {
      this._write(formatError(test.error) + '\n');
    }

    // A flaky pass links the failed attempt's artifacts on the result, but
    // those were already printed under the failing ✗ line above — printing
    // them again under a green ✓ reads as if the pass produced them. Only
    // artifacts belonging to the final attempt appear here (e.g. an
    // on-first-retry video recorded during the passing retry).
    const fromFailure = test.failedAttemptArtifacts;
    if (test.screenshotPath && !fromFailure?.screenshot) {
      this._write(`        ${dim(`Screenshot: ${test.screenshotPath}`)}\n`);
    }

    if (test.tracePath && !fromFailure?.trace) {
      this._write(`        ${dim(`Trace: npx tapsmith show-trace ${test.tracePath}`)}\n`);
    }

    if (test.videoPath && !fromFailure?.video) {
      this._write(`        ${dim(`Video: ${test.videoPath}`)}\n`);
    }

    if (this._isTTY) this._printInProgress();
  }

  onTestFileRetry(filePath: string, _discardedCount: number): void {
    if (this._isTTY) this._clearInProgress();
    this._inProgress = this._inProgress.filter((e) => e.filePath !== filePath);
    if (this._isTTY) this._printInProgress();
  }

  onTestFileEnd(): void {
    // No-op: global counters, no per-file reset.
  }

  onRunEnd(result: FullResult): void {
    if (this._isTTY) this._clearInProgress();
    this._restoreWriteInterceptors();

    const passed = result.tests.filter((t) => t.status === 'passed').length;
    const failed = result.tests.filter((t) => t.status === 'failed').length;
    const skipped = result.tests.filter((t) => t.status === 'skipped').length;
    const flaky = countFlaky(result.tests);

    this._write('\n');

    if (flaky > 0) {
      this._write(formatFlakySection(result.tests, {
        showWorkerTags: this._multipleWorkers,
        showProjectTags: this._showProjectTags,
      }));
    }

    if (failed > 0) {
      this._write(bold(red('Failures:\n\n')));
      for (const test of result.tests) {
        if (test.status === 'failed' && test.error) {
          const worker = this._multipleWorkers ? workerTag(test.workerIndex) : '';
          const project = this._showProjectTags ? projectTag(test.project) : '';
          this._write(`  ${red('✗')} ${worker}${project}${test.fullName}\n`);
          this._write(formatError(test.error) + '\n');
          if (test.screenshotPath) {
            this._write(`        ${dim(`Screenshot: ${test.screenshotPath}`)}\n`);
          }
          if (test.tracePath) {
            this._write(`        ${dim(`Trace: npx tapsmith show-trace ${test.tracePath}`)}\n`);
          }
          if (test.videoPath) {
            this._write(`        ${dim(`Video: ${test.videoPath}`)}\n`);
          }
          this._write('\n');
        }
      }
    }

    this._write(formatSummaryLine(passed, failed, skipped, result.duration, result.setupDuration, flaky) + '\n\n');
  }

  // ─── Private helpers ───

  private _relativeFile(filePath: string): string {
    if (!filePath) return '';
    const root = this._rootDir || process.cwd();
    const prefix = root.endsWith('/') ? root : root + '/';
    return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
  }

  private _fileSegment(filePath: string | undefined): string {
    if (!filePath) return '';
    return dim(`› ${this._relativeFile(filePath)} › `);
  }

  private _printInProgress(): void {
    if (this._inProgress.length === 0) return;
    const ttyWidth = process.stdout.columns || 0;
    const lines: string[] = [];
    for (let i = 0; i < this._inProgress.length; i++) {
      const { fullName, filePath, workerIndex, project: projectName } = this._inProgress[i];
      const worker = this._multipleWorkers && workerIndex != null ? `[worker ${workerIndex}] ` : '';
      const project = this._showProjectTags && projectName ? `[${projectName}] ` : '';
      const file = filePath ? `› ${this._relativeFile(filePath)} › ` : '';
      let line = `    [${this._testIndex + i + 1}] ${worker}${project}${file}${fullName}`;
      if (ttyWidth > 0 && line.length > ttyWidth)
        line = line.slice(0, ttyWidth - 1) + '…';
      lines.push(dim(line));
    }
    const output = lines.join('\n') + '\n';
    this._write(output);
    this._linesRendered = lines.length;
  }

  private _clearInProgress(): void {
    if (this._linesRendered === 0) return;
    // Combine the per-line "cursor up + erase line" escapes into one write to
    // avoid extra write calls and terminal flicker.
    this._write('\x1b[1A\x1b[2K'.repeat(this._linesRendered));
    this._linesRendered = 0;
  }

  // ─── Interleaved-output handling (single-worker, in-process tests) ───

  private _installWriteInterceptors(): void {
    if (!this._isTTY || this._originalStdoutWrite) return;
    this._originalStdoutWrite = process.stdout.write;
    this._originalStderrWrite = process.stderr.write;
    process.stdout.write = this._createExternalWriteInterceptor(
      process.stdout,
      this._originalStdoutWrite,
    );
    process.stderr.write = this._createExternalWriteInterceptor(
      process.stderr,
      this._originalStderrWrite,
    );
  }

  private _restoreWriteInterceptors(): void {
    if (this._originalStdoutWrite) {
      process.stdout.write = this._originalStdoutWrite;
      this._originalStdoutWrite = undefined;
    }
    if (this._originalStderrWrite) {
      process.stderr.write = this._originalStderrWrite;
      this._originalStderrWrite = undefined;
    }
  }

  private _createExternalWriteInterceptor(
    stream: NodeJS.WriteStream,
    originalWrite: WriteMethod,
  ): WriteMethod {
    const original = originalWrite.bind(stream) as WriteMethod;
    return ((...args: Parameters<WriteMethod>): ReturnType<WriteMethod> => {
      // Our own output (depth > 0) and the case where there is no live region
      // to protect pass straight through. Everything else is foreign output
      // (test console.log, hook stderr) that must not corrupt the live region:
      // erase it, emit the foreign chunk, then redraw it below.
      if (this._internalWriteDepth > 0 || this._linesRendered <= 0) {
        return original(...args);
      }
      this._clearInProgress();
      const result = original(...args);
      this._printInProgress();
      return result;
    }) as WriteMethod;
  }

  private _write(chunk: string): void {
    this._internalWriteDepth++;
    try {
      // Routes through the interceptor (if installed), which sees depth > 0 and
      // forwards to the original write. When not installed, writes directly.
      process.stdout.write(chunk);
    } finally {
      this._internalWriteDepth--;
    }
  }
}
