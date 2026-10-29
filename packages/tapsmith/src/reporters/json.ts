/**
 * JSON reporter — structured JSON output.
 *
 * Writes a JSON file with all test run information including config,
 * suites, tests (with status, duration, errors), and summary statistics.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TapsmithReporter, FullResult } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
import type { SuiteResult } from '../runner.js';

interface JsonTestEntry {
  name: string
  fullName: string
  status: 'passed' | 'failed' | 'skipped'
  duration: number
  error?: { message: string; stack?: string }
  firstAttemptError?: { message: string; stack?: string }
  screenshotPath?: string
  videoPath?: string
  workerIndex?: number
  project?: string
  retry?: number
  warnings?: string[]
  /** The entry stands for a whole file that failed to load (PILOT-545). */
  fileLevelFailure?: boolean
}

interface JsonSuiteEntry {
  name: string
  duration: number
  tests: JsonTestEntry[]
  suites: JsonSuiteEntry[]
}

interface JsonReport {
  config: {
    rootDir: string
    timeout: number
    retries: number
  }
  stats: {
    total: number
    passed: number
    failed: number
    skipped: number
    duration: number
    setupDuration?: number
    startTime: string
  }
  suites: JsonSuiteEntry[]
}

export class JsonReporter implements TapsmithReporter {
  private _outputFile: string;
  private _config?: TapsmithConfig;
  private _startTime = new Date();

  constructor(options: Record<string, unknown> = {}) {
    this._outputFile = process.env.TAPSMITH_JSON_OUTPUT_FILE ?? (options.outputFile as string) ?? 'tapsmith-results/results.json';
  }

  onRunStart(config: TapsmithConfig, _fileCount: number): void {
    this._config = config;
    this._startTime = new Date();
  }

  async onRunEnd(result: FullResult): Promise<void> {
    const report: JsonReport = {
      config: {
        rootDir: this._config?.rootDir ?? process.cwd(),
        timeout: this._config?.timeout ?? 30_000,
        retries: this._config?.retries ?? 0,
      },
      stats: {
        total: result.tests.length,
        passed: result.tests.filter((t) => t.status === 'passed').length,
        failed: result.tests.filter((t) => t.status === 'failed').length,
        skipped: result.tests.filter((t) => t.status === 'skipped').length,
        duration: result.duration,
        setupDuration: result.setupDuration,
        startTime: this._startTime.toISOString(),
      },
      suites: result.suites.map((s) => serializeSuite(s)),
    };

    const outputPath = path.resolve(this._config?.rootDir ?? process.cwd(), this._outputFile);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  }
}

function serializeSuite(suite: SuiteResult): JsonSuiteEntry {
  return {
    name: suite.name,
    duration: suite.durationMs,
    tests: suite.tests.map((t) => ({
      name: t.name,
      fullName: t.fullName,
      status: t.status,
      duration: t.durationMs,
      error: t.error ? { message: t.error.message, stack: t.error.stack } : undefined,
      firstAttemptError: t.firstAttemptError
        ? { message: t.firstAttemptError.message, stack: t.firstAttemptError.stack }
        : undefined,
      screenshotPath: t.screenshotPath,
      videoPath: t.videoPath,
      workerIndex: t.workerIndex,
      project: t.project,
      retry: t.retry,
      warnings: t.warnings,
      ...(t.fileLevelFailure ? { fileLevelFailure: true } : {}),
    })),
    suites: suite.suites.map((s) => serializeSuite(s)),
  };
}
