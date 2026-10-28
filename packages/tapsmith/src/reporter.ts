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

/** The whole run's outcome, passed to `onRunEnd()`. */
export interface FullResult {
  /** `'failed'` if any test failed, `'passed'` otherwise. */
  status: 'passed' | 'failed'
  /** Total wall-clock time including setup and tests. */
  duration: number
  /** Time spent on device provisioning, APK install, agent startup, etc. */
  setupDuration?: number
  /** Every test's result, flat. */
  tests: TestResult[]
  /** The results grouped by describe block. */
  suites: SuiteResult[]
}

/** Extra context for `onRunStart()`. */
export interface RunStartInfo {
  /**
   * True when `tapsmith merge-reports` is replaying shards' blob reports: no
   * tests run, and `fileCount` is 0 because the merge runs no files.
   */
  merge?: boolean
}

export interface TestStartInfo {
  workerIndex?: number
  project?: string
}

/**
 * A custom reporter: implement the callbacks you need. Each is optional and
 * is called as the run progresses; a callback that throws is logged and
 * does not stop the run.
 */
export interface TapsmithReporter {
  /** Called once before any test runs, with the resolved config and the number of test files. */
  onRunStart?(config: TapsmithConfig, fileCount: number, info?: RunStartInfo): void
  /** Called when a test file starts running. */
  onTestFileStart?(filePath: string): void
  /** Called when a test starts, with its full title (describe titles joined with " > "). */
  onTestStart?(fullName: string, filePath?: string, info?: TestStartInfo): void
  /** Called when a test ends, with its result. */
  onTestEnd?(test: TestResult): void
  /** Called when a test file finishes, with its tests' results. */
  onTestFileEnd?(filePath: string, results: TestResult[]): void
  /**
   * Called when a file is run again from the start after an infrastructure
   * error; the `discardedCount` results already reported for it are replaced.
   */
  onTestFileRetry?(filePath: string, discardedCount: number): void
  /** Called once after the last test; the run waits for a returned promise. */
  onRunEnd?(result: FullResult): Promise<void> | void
  /** Called for an error that is not a test's own failure. */
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

  onRunStart(config: TapsmithConfig, fileCount: number, info?: RunStartInfo): void {
    for (const r of this._reporters) {
      try {
        r.onRunStart?.(config, fileCount, info);
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

/** Reporters that end a run with a summary line in the terminal. */
const SUMMARY_REPORTERS = new Set(['list', 'line', 'dot']);

/**
 * Whether the configured reporters print a run summary in the terminal —
 * so watch mode, which prints its key list after each run, need not print a
 * second one (PILOT-569).
 */
export function printsRunSummary(config: ReporterConfig | undefined): boolean {
  return normalizeReporterConfig(config).some((desc) => SUMMARY_REPORTERS.has(typeof desc === 'string' ? desc : desc[0]));
}

function isSingleTuple(config: ReporterConfig): boolean {
  return (
    Array.isArray(config) &&
    config.length === 2 &&
    typeof config[0] === 'string' &&
    // `['html', CI ? { open: 'never' } : undefined]`: options left to the reporter's defaults.
    (config[1] === undefined || (typeof config[1] === 'object' && config[1] !== null && !Array.isArray(config[1])))
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
