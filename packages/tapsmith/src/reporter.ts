/**
 * Reporter API and plugin system.
 *
 * Reporters receive lifecycle events during a test run. Multiple reporters
 * can be active concurrently. Built-in reporters (list, line, dot, json,
 * junit, html, github, blob) implement this interface, and custom reporters
 * can be provided as objects or npm packages.
 *
 * @see PILOT-66
 */

import type { TapsmithConfig } from './config.js';
import type { TestResult, SuiteResult } from './runner.js';

// ─── Reporter types ───

export interface FullResult {
  status: 'passed' | 'failed'
  /** Total wall-clock time including setup and tests. */
  duration: number
  /** Time spent on device provisioning, APK install, agent startup, etc. */
  setupDuration?: number
  tests: TestResult[]
  suites: SuiteResult[]
}

export interface TestStartInfo {
  workerIndex?: number
  project?: string
}

export interface TapsmithReporter {
  onRunStart?(config: TapsmithConfig, fileCount: number): void
  onTestFileStart?(filePath: string): void
  onTestStart?(fullName: string, filePath?: string, info?: TestStartInfo): void
  onTestEnd?(test: TestResult): void
  onTestFileEnd?(filePath: string, results: TestResult[]): void
  onTestFileRetry?(filePath: string, discardedCount: number): void
  onRunEnd?(result: FullResult): Promise<void> | void
  onError?(error: Error): void
}

// ─── Reporter configuration ───

/** A reporter name with optional options, e.g. ['json', { outputFile: 'r.json' }] */
export type ReporterDescription = string | [string, Record<string, unknown>]

/** Config value for the `reporter` field. */
export type ReporterConfig = ReporterDescription | ReporterDescription[]

// ─── Reporter dispatcher ───

/**
 * Fans out reporter events to multiple reporters. Errors in individual
 * reporters are caught and logged to stderr so they don't break the run.
 */
export class ReporterDispatcher implements TapsmithReporter {
  private _reporters: TapsmithReporter[];

  constructor(reporters: TapsmithReporter[]) {
    this._reporters = reporters;
  }

  onRunStart(config: TapsmithConfig, fileCount: number): void {
    for (const r of this._reporters) {
      try {
        r.onRunStart?.(config, fileCount);
      } catch (err) {
        this._logError('onRunStart', err);
      }
    }
  }

  onTestFileStart(filePath: string): void {
    for (const r of this._reporters) {
      try {
        r.onTestFileStart?.(filePath);
      } catch (err) {
        this._logError('onTestFileStart', err);
      }
    }
  }

  onTestStart(fullName: string, filePath?: string, info?: TestStartInfo): void {
    for (const r of this._reporters) {
      try {
        r.onTestStart?.(fullName, filePath, info);
      } catch (err) {
        this._logError('onTestStart', err);
      }
    }
  }

  onTestEnd(test: TestResult): void {
    for (const r of this._reporters) {
      try {
        r.onTestEnd?.(test);
      } catch (err) {
        this._logError('onTestEnd', err);
      }
    }
  }

  onTestFileEnd(filePath: string, results: TestResult[]): void {
    for (const r of this._reporters) {
      try {
        r.onTestFileEnd?.(filePath, results);
      } catch (err) {
        this._logError('onTestFileEnd', err);
      }
    }
  }

  onTestFileRetry(filePath: string, discardedCount: number): void {
    for (const r of this._reporters) {
      try {
        r.onTestFileRetry?.(filePath, discardedCount);
      } catch (err) {
        this._logError('onTestFileRetry', err);
      }
    }
  }

  async onRunEnd(result: FullResult): Promise<void> {
    for (const r of this._reporters) {
      try {
        await r.onRunEnd?.(result);
      } catch (err) {
        this._logError('onRunEnd', err);
      }
    }
  }

  onError(error: Error): void {
    for (const r of this._reporters) {
      try {
        r.onError?.(error);
      } catch (err) {
        this._logError('onError', err);
      }
    }
  }

  private _logError(hook: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Reporter error in ${hook}: ${msg}\n`);
  }
}

// ─── Reporter factory ───

export async function createReporters(
  config: ReporterConfig | undefined,
): Promise<TapsmithReporter[]> {
  const descriptions = normalizeReporterConfig(config);
  const reporters: TapsmithReporter[] = [];

  for (const desc of descriptions) {
    const [name, options] = typeof desc === 'string' ? [desc, {}] : desc;
    reporters.push(await resolveReporter(name, options));
  }

  return reporters;
}

/** The `reporter` config as a list of descriptions, defaults applied. */
export function normalizeReporterConfig(config: ReporterConfig | undefined): ReporterDescription[] {
  if (!config) {
    // Default to `list` everywhere (including CI). The per-test list output is
    // more legible than `dot` when a CI log is the only artifact you have to
    // debug a failure; opt into `dot` explicitly via the `reporter` config.
    return ['list'];
  }

  if (typeof config === 'string') {
    return [config];
  }

  // Check if it's a single tuple like ['json', { outputFile: '...' }]
  if (isSingleTuple(config)) {
    return [config as [string, Record<string, unknown>]];
  }

  return config as ReporterDescription[];
}

function isSingleTuple(config: ReporterConfig): boolean {
  return (
    Array.isArray(config) &&
    config.length === 2 &&
    typeof config[0] === 'string' &&
    typeof config[1] === 'object' &&
    config[1] !== null &&
    !Array.isArray(config[1])
  );
}

async function resolveReporter(
  name: string,
  options: Record<string, unknown>,
): Promise<TapsmithReporter> {
  switch (name) {
    case 'list': {
      const { ListReporter } = await import('./reporters/list.js');
      return new ListReporter();
    }
    case 'line': {
      const { LineReporter } = await import('./reporters/line.js');
      return new LineReporter();
    }
    case 'dot': {
      const { DotReporter } = await import('./reporters/dot.js');
      return new DotReporter();
    }
    case 'json': {
      const { JsonReporter } = await import('./reporters/json.js');
      return new JsonReporter(options);
    }
    case 'junit': {
      const { JUnitReporter } = await import('./reporters/junit.js');
      return new JUnitReporter(options);
    }
    case 'html': {
      const { HtmlReporter } = await import('./reporters/html.js');
      return new HtmlReporter(options);
    }
    case 'github': {
      const { GitHubActionsReporter } = await import('./reporters/github.js');
      return new GitHubActionsReporter();
    }
    case 'blob': {
      const { BlobReporter } = await import('./reporters/blob.js');
      return new BlobReporter(options);
    }
    default: {
      // Try loading as a module path (custom reporter)
      try {
        const mod = await import(name);
        const ReporterClass = mod.default ?? mod;
        if (typeof ReporterClass === 'function') {
          return new ReporterClass(options);
        }
        // If it's already an object implementing the interface
        return ReporterClass as TapsmithReporter;
      } catch (err) {
        throw new Error(`Unknown reporter "${name}": ${err}`);
      }
    }
  }
}
